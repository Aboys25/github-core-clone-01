/**
 * mcp.ts — Model Context Protocol over POST /mcp (JSON-RPC 2.0, JSON responses).
 *
 * Modern era (2026-07-28): server/discover, no session, no SSE stream. Legacy
 * era (≤2025-11-25): initialize + notifications/initialized. Six tools with the
 * exact canonical argument names the suite maps onto; results carry both
 * structuredContent and a JSON text part.
 */

import { DomainError, createIssueRecord, createPullRecord, mergePullRecord } from './store.ts';
import type { RepoRec } from './store.ts';
import { globalId, isRecord, isValidRepoName } from './util.ts';
import type { ForgeContext } from './app-types.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly required: string[];
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, required };
}

const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the viewer.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'The repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    owner: { type: 'string', description: 'The owner login (the viewer).' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
    body: { type: 'string', description: 'The pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with a squash commit.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

// ---------------------------------------------------------------------------------------------
// tool implementations (shared domain operations, MCP-shaped results)
// ---------------------------------------------------------------------------------------------

function repoObject(ctx: ForgeContext, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ctx.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueObject(ctx: ForgeContext, repo: RepoRec, issue: RepoRec['issues'] extends Map<number, infer I> ? I : never): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: globalId('Issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: ctx.viewer.login, id: ctx.viewer.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullObject(ctx: ForgeContext, repo: RepoRec, pull: RepoRec['pulls'] extends Map<number, infer P> ? P : never): Record<string, unknown> {
  return {
    id: pull.dbId,
    node_id: globalId('PullRequest', repo.dbId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate },
    base: { ref: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate },
    user: { login: ctx.viewer.login, id: ctx.viewer.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

function repoForTool(ctx: ForgeContext, args: Record<string, unknown>): RepoRec | null {
  let owner = args.owner;
  let repoName = args.repo;
  if ((owner === undefined || repoName === undefined) && typeof args.full_name === 'string') {
    const [o, r] = args.full_name.split('/');
    owner = owner ?? o;
    repoName = repoName ?? r;
  }
  if (owner !== ctx.viewer.login || typeof repoName !== 'string') return null;
  return ctx.store.getRepo(ctx.viewer.login, repoName) ?? null;
}

function callTool(ctx: ForgeContext, name: string, args: Record<string, unknown>): { value: unknown; isError: boolean } {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || !repoName) return { value: 'name is required', isError: true };
      if (!isValidRepoName(repoName)) return { value: 'name is invalid', isError: true };
      const repo = ctx.store.createRepo(ctx.viewer.login, repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        isPrivate: args.private === true,
        nowIso: ctx.nowIso,
      });
      if (!repo) return { value: `Repository ${ctx.viewer.login}/${repoName} already exists`, isError: true };
      return { value: repoObject(ctx, repo), isError: false };
    }
    case 'get_repo': {
      const repo = repoForTool(ctx, args);
      if (!repo) return { value: 'Not Found', isError: true };
      return { value: repoObject(ctx, repo), isError: false };
    }
    case 'create_issue': {
      const repo = repoForTool(ctx, args);
      if (!repo) return { value: 'Not Found', isError: true };
      const title = args.title;
      if (typeof title !== 'string' || !title) return { value: 'title is required', isError: true };
      const issue = createIssueRecord(ctx.store, repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        nowIso: ctx.nowIso,
      });
      return { value: issueObject(ctx, repo, issue), isError: false };
    }
    case 'list_issues': {
      const repo = repoForTool(ctx, args);
      if (!repo) return { value: 'Not Found', isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.number - b.number);
      return { value: list.map((issue) => issueObject(ctx, repo, issue)), isError: false };
    }
    case 'create_pull_request': {
      const repo = repoForTool(ctx, args);
      if (!repo) return { value: 'Not Found', isError: true };
      const title = args.title;
      const head = args.head;
      const base = args.base;
      if (typeof title !== 'string' || !title) return { value: 'title is required', isError: true };
      if (typeof head !== 'string' || !repo.refs.has(`refs/heads/${head}`)) return { value: 'head ref does not exist', isError: true };
      if (typeof base !== 'string' || !repo.refs.has(`refs/heads/${base}`)) return { value: 'base ref does not exist', isError: true };
      const pull = createPullRecord(ctx.store, repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        nowIso: ctx.nowIso,
      });
      return { value: pullObject(ctx, repo, pull), isError: false };
    }
    case 'merge_pull_request': {
      const repo = repoForTool(ctx, args);
      if (!repo) return { value: 'Not Found', isError: true };
      const rawNumber = args.pull_number;
      const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : NaN;
      if (!Number.isSafeInteger(number)) return { value: 'pull_number is required', isError: true };
      const pull = repo.pulls.get(number);
      if (!pull) return { value: 'Not Found', isError: true };
      try {
        const { sha } = mergePullRecord(repo, pull, ctx);
        return { value: { sha, merged: true, message: 'Pull Request successfully merged', number }, isError: false };
      } catch (err) {
        if (err instanceof DomainError) return { value: err.message, isError: true };
        throw err;
      }
    }
    default:
      return { value: `Unknown tool ${name}`, isError: true };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

export interface McpResponse {
  readonly status: number;
  /** null body + 202 = notification acknowledgement with an empty body. */
  readonly body: unknown;
}

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResultPayload(value: unknown, isError: boolean): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
  if (isError) out.isError = true;
  return out;
}

function dispatchOne(ctx: ForgeContext, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = (request.id ?? null) as RpcId;
  const isNotification = request.id === undefined;
  const method = request.method;
  if (typeof method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request: method is required');
  }
  if (method.startsWith('notifications/')) return null; // notifications: 202, empty body
  if (isNotification) return null;

  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      protocolVersion: MODERN_VERSION,
      supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
      serverInfo,
      capabilities: { tools: {} },
      _meta: {
        'io.modelcontextprotocol/serverInfo': serverInfo,
        'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
      },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = [MODERN_VERSION, ...LEGACY_VERSIONS].includes(requested) ? requested : LEGACY_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, toolsListResult());
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return rpcError(id, -32602, `Unknown tool ${name}`);
    const args = isRecord(params.arguments) ? params.arguments : {};
    for (const required of def.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return rpcResult(id, toolResultPayload(`Missing required argument: ${required}`, true));
      }
    }
    try {
      const { value, isError } = callTool(ctx, name, args);
      return rpcResult(id, toolResultPayload(value, isError));
    } catch (err) {
      return rpcResult(id, toolResultPayload(err instanceof Error ? err.message : 'Tool call failed', true));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle a POST /mcp body. `bodyText` is the raw request text (non-JSON bodies
 * are a 400 with JSON-RPC -32700). Returns the HTTP status and JSON body.
 */
export function handleMcp(ctx: ForgeContext, bodyText: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, body: rpcError(null, -32600, 'Invalid Request: empty batch') };
    const results: unknown[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        results.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const result = dispatchOne(ctx, entry);
      if (result !== null) results.push(result);
    }
    if (results.length === 0) return { status: 202, body: null };
    return { status: 200, body: results };
  }
  if (!isRecord(parsed)) return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  const result = dispatchOne(ctx, parsed);
  if (result === null) return { status: 202, body: null };
  return { status: 200, body: result };
}
