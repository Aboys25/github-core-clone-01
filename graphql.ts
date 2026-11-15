/**
 * graphql.ts — a hand-written GraphQL parser + schema-validated executor for the
 * v4 surface the suite exercises: viewer/repository/node/__type reads, issue and
 * pull-request connections with cursor pagination, and the five gh-shaped
 * mutations. Unknown fields are GraphQL errors on HTTP 200, never HTTP 400.
 * Operation batching (a JSON array body) returns an array of results in order.
 */

import { DomainError, createIssueRecord, createPullRecord, mergePullRecord, pullDiff, pullMergeable } from './store.ts';
import type { IssueRec, PullRec, RepoRec } from './store.ts';
import { globalId, isRecord, parseGlobalId } from './util.ts';
import type { ForgeContext } from './app-types.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis'; value: '...' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const ch = source[j];
        if (ch === '"') {
          closed = true;
          break;
        }
        if (ch === '\n') throw new GraphQLError('unterminated string');
        if (ch === '\\') {
          const esc = source[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (esc !== undefined && esc in map) {
            value += map[esc];
            j += 2;
          } else {
            throw new GraphQLError('bad string escape');
          }
          continue;
        }
        value += ch;
        j += 1;
      }
      if (!closed) throw new GraphQLError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (/[0-9]/.test(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        }
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------

export class GraphQLError extends Error {}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly directives: DirectiveNode[];
  readonly selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  readonly kind: 'spread';
  readonly name: string;
  readonly directives: DirectiveNode[];
}

interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly directives: DirectiveNode[];
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class Parser {
  readonly #tokens: Token[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }

  #next(): Token {
    const token = this.#tokens[this.#pos];
    if (!token) throw new GraphQLError('unexpected end of document');
    this.#pos += 1;
    return token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) throw new GraphQLError(`expected "${value}"`);
  }

  #skipIfPunct(value: string): boolean {
    const token = this.#peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  #expectName(value?: string): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new GraphQLError('expected a name');
    if (value !== undefined && token.value !== value) throw new GraphQLError(`expected "${value}"`);
    return token.value;
  }

  #peekName(value: string): boolean {
    const token = this.#peek();
    return token?.kind === 'name' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.#peek()) {
      if (this.#peekName('fragment')) {
        this.#next();
        const name = this.#expectName();
        this.#expectName('on');
        const typeCondition = this.#expectName();
        this.#parseDirectives();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selectionSet: this.#parseSelectionSet() });
      } else {
        operations.push(this.#parseOperation());
      }
    }
    if (!operations.length) throw new GraphQLError('document has no operation');
    return { operations, fragments };
  }

  #parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    const token = this.#peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operation = this.#next().value as 'query' | 'mutation' | 'subscription';
      const next = this.#peek();
      if (next?.kind === 'name') name = this.#next().value;
    }
    const variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.#skipIfPunct('(')) {
      while (!this.#skipIfPunct(')')) {
        this.#expectPunct('$');
        const varName = this.#expectName();
        this.#expectPunct(':');
        this.#parseType();
        let defaultValue: ValueNode | null = null;
        if (this.#skipIfPunct('=')) defaultValue = this.#parseValue();
        this.#parseDirectives();
        variableDefinitions.push({ name: varName, defaultValue });
      }
    }
    this.#parseDirectives();
    return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.#parseSelectionSet() };
  }

  #parseType(): void {
    if (this.#skipIfPunct('[')) {
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    this.#skipIfPunct('!');
  }

  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.#skipIfPunct('}')) {
      selections.push(this.#parseSelection());
    }
    return selections;
  }

  #parseSelection(): SelectionNode {
    const token = this.#peek();
    if (token?.kind === 'ellipsis') {
      this.#next();
      if (this.#peekName('on')) {
        this.#next();
        const typeCondition = this.#expectName();
        const directives = this.#parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.#parseSelectionSet() };
      }
      const next = this.#peek();
      if (next?.kind === 'name' && next.value !== 'on') {
        const name = this.#next().value;
        const directives = this.#parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.#parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selectionSet: this.#parseSelectionSet() };
    }
    let name = this.#expectName();
    let alias: string | null = null;
    if (this.#skipIfPunct(':')) {
      alias = name;
      name = this.#expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.#skipIfPunct('(')) {
      while (!this.#skipIfPunct(')')) {
        const argName = this.#expectName();
        this.#expectPunct(':');
        args.push({ name: argName, value: this.#parseValue() });
      }
    }
    const directives = this.#parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '{') {
      selectionSet = this.#parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  #parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.#skipIfPunct('@')) {
      const name = this.#expectName();
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.#skipIfPunct('(')) {
        while (!this.#skipIfPunct(')')) {
          const argName = this.#expectName();
          this.#expectPunct(':');
          args.push({ name: argName, value: this.#parseValue() });
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  #parseValue(): ValueNode {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.#expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.#skipIfPunct(']')) values.push(this.#parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.#skipIfPunct('}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLError('expected a value');
  }
}

// ---------------------------------------------------------------------------------------------
// schema tables
// ---------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Ref: ['name', 'target'],
  GitObject: ['oid', 'abbreviatedOid'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'mergedAt', 'closedAt', 'createdAt', 'updatedAt', 'author', 'repository', 'url', 'headRef', 'baseRef'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const RETURN_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Ref: { target: 'GitObject' },
  Issue: { author: 'User', repository: 'Repository' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { author: 'User', repository: 'Repository', files: 'PullRequestChangedFileConnection', headRef: 'Ref', baseRef: 'Ref' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  IssueComment: { author: 'User' },
  IssueCommentEdge: { node: 'IssueComment' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Node' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue', interfaces: '__Type', possibleTypes: '__Type', ofType: '__Type' },
  __Field: { args: '__InputValue', type: '__Type' },
  __InputValue: { type: '__Type' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '__Type', directives: '__Directive' },
  __Directive: { args: '__InputValue' },
};

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const INPUTS: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitHeadline', 'commitBody', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment']);

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

type GqlObject = { __typename: string; [key: string]: unknown };

function userObj(ctx: ForgeContext): GqlObject {
  return { __typename: 'User', login: ctx.viewer.login, databaseId: ctx.viewer.id, name: ctx.viewer.name, email: ctx.viewer.email };
}

function repoObj(repo: RepoRec): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: RepoRec, pull: PullRec): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function encodeCursor(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    return /^([ni]):.+/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function pageInfoFor(total: number, start: number, end: number, encodeEnd: (index: number) => string | null): GqlObject {
  return {
    __typename: 'PageInfo',
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: start < end ? encodeEnd(start) : null,
    endCursor: start < end ? encodeEnd(end - 1) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  readonly ctx: ForgeContext;
  readonly variables: Record<string, unknown>;
  readonly fragments: Map<string, FragmentNode>;
  readonly errors: Array<{ message: string; path?: Array<string | number> }>;
}

function coerceValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
      return Number(node.value);
    case 'float':
      return Number(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => coerceValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = coerceValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) {
    const value = coerceValue(arg.value, variables);
    if (value !== undefined) out[arg.name] = value;
  }
  return out;
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') continue;
    const ifArg = directive.args.find((a) => a.name === 'if');
    const value = ifArg ? coerceValue(ifArg.value, variables) : false;
    if (directive.name === 'skip' && value === true) return true;
    if (directive.name === 'include' && value !== true) return true;
  }
  return false;
}

function typeMatches(typename: string, condition: string): boolean {
  if (typename === condition) return true;
  if (condition === 'Node') return NODE_TYPES.has(typename);
  return false;
}

/** Validate the operation against the schema; returns error messages for unknown fields. */
function validateOperation(operation: OperationNode, fragments: Map<string, FragmentNode>): string[] {
  const errors: string[] = [];
  const root = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const walk = (typeName: string, selections: SelectionNode[], seenSpreads: Set<string>): void => {
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        if (seenSpreads.has(selection.name)) continue;
        seenSpreads.add(selection.name);
        const fragment = fragments.get(selection.name);
        if (fragment) walk(fragment.typeCondition, fragment.selectionSet, seenSpreads);
        continue;
      }
      if (selection.kind === 'inline') {
        walk(selection.typeCondition ?? typeName, selection.selectionSet, seenSpreads);
        continue;
      }
      const field = selection;
      if (field.name === '__typename') continue;
      const fields = FIELDS[typeName];
      if (!fields || !fields.includes(field.name)) {
        errors.push(`Cannot query field "${field.name}" on type "${typeName}".`);
        continue;
      }
      if (field.selectionSet) {
        const returnType = RETURN_TYPES[typeName]?.[field.name];
        if (returnType) walk(returnType, field.selectionSet, new Set(seenSpreads));
      }
    }
  };
  // Mutation root fields live on the Mutation pseudo-type for validation purposes.
  if (root === 'Mutation') {
    const mutationFields = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
    for (const selection of operation.selectionSet) {
      if (selection.kind === 'field') {
        if (!mutationFields.includes(selection.name)) {
          errors.push(`Cannot query field "${selection.name}" on type "Mutation".`);
          continue;
        }
        const payload: Record<string, string> = {
          createIssue: 'CreateIssuePayload',
          closeIssue: 'CloseIssuePayload',
          createPullRequest: 'CreatePullRequestPayload',
          mergePullRequest: 'MergePullRequestPayload',
          addComment: 'AddCommentPayload',
        };
        if (selection.selectionSet) walk(payload[selection.name], selection.selectionSet, new Set());
      } else if (selection.kind === 'inline') {
        walk('Mutation', selection.selectionSet, new Set());
      }
    }
    return errors;
  }
  walk('Query', operation.selectionSet, new Set());
  return errors;
}

function executeSelectionSet(
  exec: ExecContext,
  typename: string,
  object: GqlObject,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (!fragment) continue;
      if (directivesSkip(selection.directives, exec.variables)) continue;
      if (!typeMatches(typename, fragment.typeCondition)) continue;
      Object.assign(out, executeSelectionSet(exec, typename, object, fragment.selectionSet, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (directivesSkip(selection.directives, exec.variables)) continue;
      if (selection.typeCondition && !typeMatches(typename, selection.typeCondition)) continue;
      Object.assign(out, executeSelectionSet(exec, typename, object, selection.selectionSet, path));
      continue;
    }
    const field = selection;
    if (directivesSkip(field.directives, exec.variables)) continue;
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    if (field.name === '__typename') {
      out[key] = typename;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(exec, typename, object, field);
    } catch (err) {
      exec.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (field.selectionSet) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        const itemType = RETURN_TYPES[typename]?.[field.name] ?? typename;
        out[key] = value.map((item, index) =>
          item !== null && typeof item === 'object'
            ? executeSelectionSet(exec, (item as GqlObject).__typename ?? itemType, item as GqlObject, field.selectionSet!, [...fieldPath, index])
            : item,
        );
      } else if (typeof value === 'object') {
        const itemType = (value as GqlObject).__typename ?? RETURN_TYPES[typename]?.[field.name] ?? typename;
        out[key] = executeSelectionSet(exec, itemType, value as GqlObject, field.selectionSet, fieldPath);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// field resolvers
// ---------------------------------------------------------------------------------------------

function findRepoByDbId(ctx: ForgeContext, dbId: number): RepoRec | null {
  for (const repo of ctx.store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function decodeRepoId(ctx: ForgeContext, id: unknown): RepoRec {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') throw new GraphQLError('invalid repository id');
  const repo = findRepoByDbId(ctx, Number(parsed.parts[0]));
  if (!repo) throw new GraphQLError('repository not found');
  return repo;
}

function decodeIssueId(ctx: ForgeContext, id: unknown): { repo: RepoRec; issue: IssueRec } {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') throw new GraphQLError('invalid issue id');
  const repo = findRepoByDbId(ctx, Number(parsed.parts[0]));
  const issue = repo?.issues.get(Number(parsed.parts[1]));
  if (!repo || !issue) throw new GraphQLError('issue not found');
  return { repo, issue };
}

function decodePullId(ctx: ForgeContext, id: unknown): { repo: RepoRec; pull: PullRec } {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') throw new GraphQLError('invalid pull request id');
  const repo = findRepoByDbId(ctx, Number(parsed.parts[0]));
  const pull = repo?.pulls.get(Number(parsed.parts[1]));
  if (!repo || !pull) throw new GraphQLError('pull request not found');
  return { repo, pull };
}

function decodeNode(ctx: ForgeContext, id: unknown): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoByDbId(ctx, Number(parsed.parts[0]));
    return repo ? repoObj(repo) : null;
  }
  if (parsed.kind === 'Issue') {
    const repo = findRepoByDbId(ctx, Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    return repo && issue ? issueObj(repo, issue) : null;
  }
  if (parsed.kind === 'PullRequest') {
    const repo = findRepoByDbId(ctx, Number(parsed.parts[0]));
    const pull = repo?.pulls.get(Number(parsed.parts[1]));
    return repo && pull ? pullObj(repo, pull) : null;
  }
  if (parsed.kind === 'User') return userObj(ctx);
  return null;
}

function typeObject(name: string): GqlObject | null {
  if (FIELDS[name]) return { __typename: '__Type', typeName: name, kind: name === 'Node' ? 'INTERFACE' : 'OBJECT' };
  if (ENUMS[name]) return { __typename: '__Type', typeName: name, kind: 'ENUM' };
  if (INPUTS[name]) return { __typename: '__Type', typeName: name, kind: 'INPUT_OBJECT' };
  if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) return { __typename: '__Type', typeName: name, kind: 'SCALAR' };
  return null;
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map(String));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
  const compare = (a: IssueRec, b: IssueRec): number => {
    if (field === 'COMMENTS') return a.comments.length - b.comments.length || a.number - b.number;
    return a.number - b.number;
  };
  list.sort((a, b) => (direction === 'DESC' ? -compare(a, b) : compare(a, b)));
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : 30;
  let start = 0;
  const after = decodeCursor(args.after);
  if (after?.startsWith('n:')) {
    const cursorNumber = Number(after.slice(2));
    const index = list.findIndex((i) => i.number === cursorNumber);
    if (index >= 0) start = index + 1;
  }
  const slice = list.slice(start, start + first);
  const end = start + slice.length;
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueObj(repo, issue)),
    pageInfo: pageInfoFor(list.length, start, end, (index) => encodeCursor(`n:${list[index].number}`)),
    totalCount: list.length,
  };
}

function pullsConnection(repo: RepoRec, args: Record<string, unknown>): GqlObject {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map(String));
    list = list.filter((p) => {
      const state = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : 30;
  let start = 0;
  const after = decodeCursor(args.after);
  if (after?.startsWith('n:')) {
    const cursorNumber = Number(after.slice(2));
    const index = list.findIndex((p) => p.number === cursorNumber);
    if (index >= 0) start = index + 1;
  }
  const slice = list.slice(start, start + first);
  const end = start + slice.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: slice.map((pull) => pullObj(repo, pull)),
    pageInfo: pageInfoFor(list.length, start, end, (index) => encodeCursor(`n:${list[index].number}`)),
    totalCount: list.length,
  };
}

function filesConnection(repo: RepoRec, pull: PullRec, args: Record<string, unknown>): GqlObject {
  const files = pullDiff(repo, pull);
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : 30;
  let start = 0;
  const after = decodeCursor(args.after);
  if (after?.startsWith('i:')) {
    const index = Number(after.slice(2));
    if (Number.isSafeInteger(index) && index >= 0) start = index + 1;
  }
  const slice = files.slice(start, start + first);
  const end = start + slice.length;
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: slice.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions })),
    pageInfo: pageInfoFor(files.length, start, end, (index) => encodeCursor(`i:${index}`)),
    totalCount: files.length,
  };
}

function resolveField(exec: ExecContext, typename: string, object: GqlObject, field: FieldNode): unknown {
  const ctx = exec.ctx;
  const args = argsOf(field, exec.variables);
  switch (typename) {
    case 'Query': {
      if (field.name === 'viewer') return userObj(ctx);
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (owner !== ctx.viewer.login || typeof name !== 'string') return null;
        const repo = ctx.store.getRepo(ctx.viewer.login, name);
        return repo ? repoObj(repo) : null;
      }
      if (field.name === 'node') return decodeNode(ctx, args.id);
      if (field.name === '__type') return typeof args.name === 'string' ? typeObject(args.name) : null;
      if (field.name === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'User': {
      if (field.name === 'id') return globalId('User', ctx.viewer.id);
      if (field.name === 'databaseId') return ctx.viewer.id;
      if (field.name === 'login') return ctx.viewer.login;
      if (field.name === 'name') return ctx.viewer.name;
      if (field.name === 'email') return ctx.viewer.email;
      if (field.name === 'url') return `https://github.com/${ctx.viewer.login}`;
      break;
    }
    case 'Repository': {
      const repo = object.repo as RepoRec;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.dbId);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObj(ctx);
        case 'description':
          return repo.description;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? { __typename: 'Ref', repo, name: repo.defaultBranch, oid: tip } : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueObj(repo, issue) : null;
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullObj(repo, pull) : null;
        }
        case 'pullRequests':
          return pullsConnection(repo, args);
      }
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return object.name;
      if (field.name === 'target') {
        return { __typename: 'GitObject', oid: object.oid };
      }
      break;
    }
    case 'GitObject': {
      if (field.name === 'oid') return object.oid;
      if (field.name === 'abbreviatedOid') return String(object.oid).slice(0, 7);
      break;
    }
    case 'Issue': {
      const issue = object.issue as IssueRec;
      const repo = object.repo as RepoRec;
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.dbId, issue.number);
        case 'databaseId':
          return issue.dbId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return userObj(ctx);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'repository':
          return repoObj(repo);
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return object.nodes;
      if (field.name === 'pageInfo') return object.pageInfo;
      if (field.name === 'totalCount') return object.totalCount;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return object.hasNextPage;
      if (field.name === 'hasPreviousPage') return object.hasPreviousPage;
      if (field.name === 'startCursor') return object.startCursor;
      if (field.name === 'endCursor') return object.endCursor;
      break;
    }
    case 'PullRequest': {
      const pull = object.pull as PullRec;
      const repo = object.repo as RepoRec;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo.dbId, pull.number);
        case 'databaseId':
          return pull.dbId;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files':
          return filesConnection(repo, pull, args);
        case 'mergedAt':
          return pull.mergedAt;
        case 'closedAt':
          return pull.closedAt;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'author':
          return userObj(ctx);
        case 'repository':
          return repoObj(repo);
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'headRef': {
          const tip = repo.refs.get(`refs/heads/${pull.headRef}`);
          return tip ? { __typename: 'Ref', repo, name: pull.headRef, oid: tip } : null;
        }
        case 'baseRef': {
          const tip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          return tip ? { __typename: 'Ref', repo, name: pull.baseRef, oid: tip } : null;
        }
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return object.path;
      if (field.name === 'additions') return object.additions;
      if (field.name === 'deletions') return object.deletions;
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return object.commentGlobalId;
      if (field.name === 'body') return object.body;
      if (field.name === 'author') return userObj(ctx);
      if (field.name === 'createdAt') return object.createdAt;
      if (field.name === 'updatedAt') return object.updatedAt;
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return object.node;
      if (field.name === 'cursor') return object.cursor ?? null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return object.issue;
      if (field.name === 'clientMutationId') return object.clientMutationId ?? null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return object.pullRequest;
      if (field.name === 'clientMutationId') return object.clientMutationId ?? null;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return object.commentEdge;
      if (field.name === 'subject') return object.subject;
      if (field.name === 'clientMutationId') return object.clientMutationId ?? null;
      break;
    }
    case '__Type': {
      const typeName = object.typeName as string;
      const kind = object.kind as string;
      switch (field.name) {
        case 'name':
          return typeName;
        case 'kind':
          return kind;
        case 'description':
          return null;
        case 'fields':
          return kind === 'OBJECT' || kind === 'INTERFACE'
            ? (FIELDS[typeName] ?? []).map((name) => ({ __typename: '__Field', name }))
            : null;
        case 'enumValues':
          return kind === 'ENUM' ? (ENUMS[typeName] ?? []).map((name) => ({ __typename: '__EnumValue', name })) : null;
        case 'inputFields':
          return kind === 'INPUT_OBJECT' ? (INPUTS[typeName] ?? []).map((name) => ({ __typename: '__InputValue', name })) : null;
        case 'interfaces':
          return [];
        case 'possibleTypes':
          return typeName === 'Node'
            ? ['Repository', 'Issue', 'PullRequest', 'User'].map((name) => ({ __typename: '__Type', typeName: name, kind: 'OBJECT' }))
            : null;
        case 'ofType':
          return null;
        case 'specifiedByURL':
          return null;
      }
      break;
    }
    case '__Field': {
      if (field.name === 'name') return object.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return object.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
    }
    case '__InputValue': {
      if (field.name === 'name') return object.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return null;
      if (field.name === 'defaultValue') return null;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { __typename: '__Type', typeName: 'Query', kind: 'OBJECT' };
      if (field.name === 'mutationType') return { __typename: '__Type', typeName: 'Mutation', kind: 'OBJECT' };
      if (field.name === 'subscriptionType') return null;
      if (field.name === 'types') return [];
      if (field.name === 'directives') return [];
      break;
    }
    default:
      break;
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${typename}".`);
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function executeMutationField(exec: ExecContext, field: FieldNode): GqlObject {
  const ctx = exec.ctx;
  const args = argsOf(field, exec.variables);
  const input = isRecord(args.input) ? args.input : {};
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (field.name) {
    case 'createIssue': {
      const repo = decodeRepoId(ctx, input.repositoryId);
      const title = input.title;
      if (typeof title !== 'string' || !title) throw new GraphQLError('title is required');
      const issue = createIssueRecord(ctx.store, repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        nowIso: ctx.nowIso,
      });
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId };
    }
    case 'closeIssue': {
      const { repo, issue } = decodeIssueId(ctx, input.issueId);
      issue.state = 'closed';
      issue.closedAt = ctx.nowIso;
      issue.updatedAt = ctx.nowIso;
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue), clientMutationId };
    }
    case 'createPullRequest': {
      const repo = decodeRepoId(ctx, input.repositoryId);
      const title = input.title;
      const headRefName = input.headRefName;
      const baseRefName = input.baseRefName;
      if (typeof title !== 'string' || !title) throw new GraphQLError('title is required');
      if (typeof headRefName !== 'string' || !repo.refs.has(`refs/heads/${headRefName}`)) {
        throw new GraphQLError('head ref does not exist');
      }
      if (typeof baseRefName !== 'string' || !repo.refs.has(`refs/heads/${baseRefName}`)) {
        throw new GraphQLError('base ref does not exist');
      }
      const pull = createPullRecord(ctx.store, repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        headRef: headRefName,
        baseRef: baseRefName,
        nowIso: ctx.nowIso,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId };
    }
    case 'mergePullRequest': {
      const { repo, pull } = decodePullId(ctx, input.pullRequestId);
      try {
        mergePullRecord(repo, pull, ctx);
      } catch (err) {
        if (err instanceof DomainError) throw new GraphQLError(err.message);
        throw err;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId };
    }
    case 'addComment': {
      const { repo, issue } = decodeIssueId(ctx, input.subjectId);
      const body = input.body;
      if (typeof body !== 'string' || !body) throw new GraphQLError('body is required');
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body, authorLogin: ctx.viewer.login, createdAt: ctx.nowIso, updatedAt: ctx.nowIso };
      issue.comments.push(comment);
      issue.updatedAt = ctx.nowIso;
      const node: GqlObject = {
        __typename: 'IssueComment',
        commentGlobalId: globalId('IssueComment', repo.dbId, issue.number, comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(`c:${comment.id}`) },
        subject: issueObj(repo, issue),
        clientMutationId,
      };
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

// ---------------------------------------------------------------------------------------------
// request entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  readonly body: unknown;
}

function executeOne(
  ctx: ForgeContext,
  query: unknown,
  variables: unknown,
  operationName: unknown,
): Record<string, unknown> {
  if (typeof query !== 'string' || !query.trim()) {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName) {
    operation = document.operations.find((op) => op.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    if (document.operations.length > 1) {
      return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
    }
    operation = document.operations[0];
  }
  const vars: Record<string, unknown> = isRecord(variables) ? { ...variables } : {};
  for (const def of operation.variableDefinitions) {
    if (vars[def.name] === undefined && def.defaultValue) vars[def.name] = coerceValue(def.defaultValue, vars);
  }
  const validationErrors = validateOperation(operation, document.fragments);
  if (validationErrors.length) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const exec: ExecContext = { ctx, variables: vars, fragments: document.fragments, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.operation === 'mutation') {
    for (const selection of operation.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      try {
        const payload = executeMutationField(exec, selection);
        data[key] = selection.selectionSet
          ? executeSelectionSet(exec, payload.__typename, payload, selection.selectionSet, [key])
          : payload;
      } catch (err) {
        exec.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
        data[key] = null;
      }
    }
  } else {
    const root: GqlObject = { __typename: 'Query' };
    Object.assign(data, executeSelectionSet(exec, 'Query', root, operation.selectionSet, []));
  }
  if (exec.errors.length) return { data, errors: exec.errors };
  return { data };
}

/** Handle a POST /api/graphql body (single operation object or a batch array). */
export function handleGraphQL(ctx: ForgeContext, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    return { body: body.map((entry) => (isRecord(entry) ? executeOne(ctx, entry.query, entry.variables, entry.operationName) : { data: null, errors: [{ message: 'Invalid batch entry.' }] })) };
  }
  if (!isRecord(body)) return { body: { data: null, errors: [{ message: 'Must provide query string.' }] } };
  return { body: executeOne(ctx, body.query, body.variables, body.operationName) };
}
