/**
 * rest.ts — the REST v3 surface: /api/v3 root + meta, users, repositories,
 * branches, commits, git refs, contents, labels, issues, comments, pull requests.
 *
 * Shapes are GitHub-compatible and permissive (extra fields are fine). Errors are
 * JSON {message}. A foreign owner is 404, never 403. Repository creation through
 * POST /api/v3/user/repos is the only creation path; a push cannot invent a repo.
 */

import {
  buildTreeFromMap,
  isObjectId,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
} from './git.ts';
import type { FlatEntry } from './git.ts';
import {
  DomainError,
  commitOnBranch,
  createIssueRecord,
  createPullRecord,
  flatAtBranch,
  liveBaseSha,
  liveHeadSha,
  lookupOf,
  mergePullRecord,
  pullDiff,
  pullMergeable,
  putObject,
  resolveToCommit,
} from './store.ts';
import type { IssueRec, Label, PullRec, RepoRec } from './store.ts';
import { formatCommitDate, globalId, isRecord, isValidBranchName, isValidRefName, isValidRepoName, parseIdentity, stringField } from './util.ts';
import type { ForgeContext } from './app-types.ts';

export interface RestRequest {
  readonly method: string;
  /** Decoded path segments below /api/v3 (e.g. ['repos', owner, repo, 'issues']). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown> | null;
  readonly host: string;
}

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

const NOT_FOUND = () => err(404, 'Not Found');

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

function userObject(ctx: ForgeContext): Record<string, unknown> {
  return {
    login: ctx.viewer.login,
    id: ctx.viewer.id,
    node_id: globalId('User', ctx.viewer.id),
    avatar_url: '',
    gravatar_id: '',
    url: `https://api.github.com/users/${ctx.viewer.login}`,
    html_url: `https://github.com/${ctx.viewer.login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoObject(ctx: ForgeContext, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(ctx),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    allow_forking: true,
    web_commit_signoff_required: false,
  };
}

function labelObject(ctx: ForgeContext, repo: RepoRec, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', repo.dbId, label.name),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueObject(ctx: ForgeContext, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: globalId('Issue', repo.dbId, issue.number),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userObject(ctx),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelObject(ctx, repo, label) : { name, color: 'ededed', description: null };
    }),
    assignee: null,
    locked: false,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentObject(ctx: ForgeContext, repo: RepoRec, number: number, comment: IssueRec['comments'][number], kind: 'issues' | 'pulls'): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.dbId, number, comment.id),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/${kind}/${number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/${kind}/${number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userObject(ctx),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function commitObject(ctx: ForgeContext, repo: RepoRec, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const message = commit.message.replace(/\n+$/, '');
  return {
    sha: oid,
    node_id: globalId('Commit', repo.dbId, oid),
    commit: {
      author: { name: author.name, email: author.email, date: formatCommitDate(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: formatCommitDate(committer.timestamp) },
      message,
      tree: { sha: commit.tree, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: userObject(ctx),
    committer: userObject(ctx),
    parents: commit.parents.map((sha) => ({
      sha,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    })),
  };
}

/** Commits reachable from the live head tip but not from the merge base (0 when a tip is missing). */
function pullCommitCount(repo: RepoRec, pull: PullRec): number {
  const lookup = lookupOf(repo);
  const headSha = liveHeadSha(repo, pull);
  const baseSha = liveBaseSha(repo, pull);
  if (!headSha || !baseSha) return 0;
  const headCommit = peelToCommit(headSha, lookup);
  const baseCommit = peelToCommit(baseSha, lookup);
  if (!headCommit || !baseCommit) return 0;
  const base = mergeBase(headCommit, baseCommit, lookup);
  const baseReachable = new Set(base ? listCommits(base, lookup).map((entry) => entry.oid) : []);
  return listCommits(headCommit, lookup).filter((entry) => !baseReachable.has(entry.oid)).length;
}

function pullObject(ctx: ForgeContext, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = liveHeadSha(repo, pull);
  const baseSha = liveBaseSha(repo, pull);
  const files = pullDiff(repo, pull);
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const mergeable = pullMergeable(repo, pull);
  return {
    id: pull.dbId,
    node_id: globalId('PullRequest', repo.dbId, pull.number),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userObject(ctx),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/${headSha ?? ''}`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userObject(ctx),
      repo: repoObject(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userObject(ctx),
      repo: repoObject(ctx, repo),
    },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    merged: pull.merged,
    mergeable: mergeable === 'UNKNOWN' ? null : mergeable === 'MERGEABLE',
    rebaseable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    merged_by: pull.merged ? userObject(ctx) : null,
    comments: pull.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: pullCommitCount(repo, pull),
    additions,
    deletions,
    changed_files: files.length,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** The repo for a request, or null when the owner is foreign or the repo is missing. */
function repoFor(ctx: ForgeContext, owner: string, name: string): RepoRec | null {
  if (owner !== ctx.viewer.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  return {
    perPage: Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const n = Number(segment);
  return Number.isSafeInteger(n) ? n : null;
}

/** Resolve a contents path within a tree; returns the entry plus its parent chain info. */
function treeEntryAt(
  repo: RepoRec,
  treeOid: string,
  path: string,
): { entry: FlatEntry; isDir: false } | { entries: Array<{ name: string; entry: FlatEntry; isDir: boolean }>; isDir: true } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let currentOid = treeOid;
  const lookup = lookupOf(repo);
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentOid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const found = entries.find((e) => e.name === segments[i]);
    if (!found) return null;
    if (i === segments.length - 1) {
      if (found.mode === '40000') {
        const dirObject = repo.objects.get(found.oid);
        if (!dirObject || dirObject.type !== 'tree') return null;
        return {
          isDir: true,
          entries: parseTree(dirObject.data).map((e) => ({ name: e.name, entry: { oid: e.oid, mode: e.mode }, isDir: e.mode === '40000' })),
        };
      }
      return { isDir: false, entry: { oid: found.oid, mode: found.mode } };
    }
    if (found.mode !== '40000') return null;
    currentOid = found.oid;
  }
  // Empty path: the root tree itself.
  const rootObject = repo.objects.get(currentOid);
  if (!rootObject || rootObject.type !== 'tree') return null;
  return {
    isDir: true,
    entries: parseTree(rootObject.data).map((e) => ({ name: e.name, entry: { oid: e.oid, mode: e.mode }, isDir: e.mode === '40000' })),
  };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: ForgeContext, req: RestRequest): RestResponse {
  const [head, ...rest] = req.segments;
  try {
    if (req.segments.length === 0) {
      if (req.method !== 'GET') return NOT_FOUND();
      return ok(
        {
          current_user_url: 'https://api.github.com/user',
          current_user_authorizations_html_url: 'https://github.com/settings/applications',
          authorizations_url: 'https://api.github.com/authorizations',
          code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page,sort,order}',
          commit_search_url: 'https://api.github.com/search/commits?q={query}{&page,per_page,sort,order}',
          emails_url: 'https://api.github.com/user/emails',
          emojis_url: 'https://api.github.com/emojis',
          events_url: 'https://api.github.com/events',
          feeds_url: 'https://api.github.com/feeds',
          followers_url: 'https://api.github.com/user/followers',
          following_url: 'https://api.github.com/user/following{/target}',
          gists_url: 'https://api.github.com/gists{/gist_id}',
          hub_url: 'https://api.github.com/hub',
          issue_search_url: 'https://api.github.com/search/issues?q={query}{&page,per_page,sort,order}',
          issues_url: 'https://api.github.com/issues',
          keys_url: 'https://api.github.com/user/keys',
          label_search_url: 'https://api.github.com/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
          notifications_url: 'https://api.github.com/notifications',
          organization_url: 'https://api.github.com/orgs/{org}',
          organization_repositories_url: 'https://api.github.com/orgs/{org}/repos{?type,page,per_page,sort}',
          organization_teams_url: 'https://api.github.com/orgs/{org}/teams',
          public_gists_url: 'https://api.github.com/gists/public',
          rate_limit_url: 'https://api.github.com/rate_limit',
          repository_url: 'https://api.github.com/repos/{owner}/{repo}',
          repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}',
          current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}',
          starred_url: 'https://api.github.com/user/starred{/owner}{/repo}',
          starred_gists_url: 'https://api.github.com/gists/starred',
          topic_search_url: 'https://api.github.com/search/topics?q={query}{&page,per_page}',
          user_url: 'https://api.github.com/users/{user}',
          user_organizations_url: 'https://api.github.com/user/orgs',
          user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort}',
          user_search_url: 'https://api.github.com/search/users?q={query}{&page,per_page,sort,order}',
        },
        200,
        { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo, read:org' },
      );
    }
    if (head === 'meta' && rest.length === 0) {
      if (req.method !== 'GET') return NOT_FOUND();
      return ok({
        verifiable_password_authentication: true,
        ssh_key_fingerprints: {},
        ssh_keys: [],
        hooks: [],
        web: [],
        api: [],
        git: [],
        packages: [],
        pages: [],
        importer: [],
        actions: [],
        dependabot: [],
        installed_version: '1.0.0',
      });
    }
    if (head === 'user') return handleUser(ctx, req, rest);
    if (head === 'repos') return handleRepos(ctx, req, rest);
    return NOT_FOUND();
  } catch (error) {
    if (error instanceof DomainError) return err(error.status, error.message);
    throw error;
  }
}

function handleUser(ctx: ForgeContext, req: RestRequest, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method !== 'GET') return NOT_FOUND();
    const user = userObject(ctx);
    return ok({ ...user, name: ctx.viewer.name, email: ctx.viewer.email, bio: null, public_repos: ctx.store.listRepos(ctx.viewer.login).length });
  }
  if (rest[0] === 'repos' && rest.length === 1) {
    if (req.method === 'GET') {
      const { perPage, page } = pagination(req.query);
      const all = ctx.store.listRepos(ctx.viewer.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      if (page < totalPages) {
        const base = `http://${req.host}/api/v3/user/repos?per_page=${perPage}`;
        headers.Link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${totalPages}>; rel="last"`;
      }
      return ok(slice.map((repo) => repoObject(ctx, repo)), 200, headers);
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const name = stringField(body, 'name');
      if (!name) return err(422, 'name is required');
      if (!isValidRepoName(name)) return err(422, 'name is invalid');
      const defaultBranch = typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main';
      if (!isValidBranchName(defaultBranch)) return err(422, 'default_branch is invalid');
      const repo = ctx.store.createRepo(ctx.viewer.login, name, {
        description: typeof body.description === 'string' ? body.description : null,
        isPrivate: body.private === true,
        defaultBranch,
        nowIso: ctx.nowIso,
      });
      if (!repo) return err(422, `Repository ${ctx.viewer.login}/${name} already exists`);
      return ok(repoObject(ctx, repo), 201);
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

function handleRepos(ctx: ForgeContext, req: RestRequest, rest: string[]): RestResponse {
  const [owner, name, ...tail] = rest;
  if (!owner || !name) return NOT_FOUND();
  const repo = repoFor(ctx, owner, name);
  if (tail.length === 0) {
    if (req.method === 'GET') {
      if (!repo) return NOT_FOUND();
      return ok(repoObject(ctx, repo));
    }
    if (req.method === 'PATCH') {
      if (!repo) return NOT_FOUND();
      const body = req.body ?? {};
      if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
      if (typeof body.default_branch === 'string' && body.default_branch) {
        if (!isValidBranchName(body.default_branch)) return err(422, 'default_branch is invalid');
        repo.defaultBranch = body.default_branch;
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = ctx.nowIso;
      return ok(repoObject(ctx, repo));
    }
    if (req.method === 'DELETE') {
      if (!repo) return NOT_FOUND();
      ctx.store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return NOT_FOUND();
  }
  if (!repo) return NOT_FOUND();
  const [section, ...sectionRest] = tail;
  switch (section) {
    case 'branches':
      return handleBranches(ctx, req, repo, sectionRest);
    case 'commits':
      return handleCommits(ctx, req, repo, sectionRest);
    case 'git':
      return handleGitRefs(ctx, req, repo, sectionRest);
    case 'contents':
      return handleContents(ctx, req, repo, sectionRest);
    case 'labels':
      return handleLabels(ctx, req, repo, sectionRest);
    case 'issues':
      return handleIssues(ctx, req, repo, sectionRest);
    case 'pulls':
      return handlePulls(ctx, req, repo, sectionRest);
    default:
      return NOT_FOUND();
  }
}

// ---------------------------------------------------------------------------------------------
// branches / commits / git refs
// ---------------------------------------------------------------------------------------------

function branchObject(ctx: ForgeContext, repo: RepoRec, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    _links: {
      html: `https://github.com/${repo.owner}/${repo.name}/tree/${name}`,
      self: `https://api.github.com/repos/${repo.owner}/${repo.name}/branches/${name}`,
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/branches/${name}/protection`,
  };
}

function handleBranches(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  if (req.method !== 'GET') return NOT_FOUND();
  const branches = [...repo.refs.entries()]
    .filter(([name]) => name.startsWith('refs/heads/'))
    .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), sha }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (rest.length === 0) {
    const { perPage, page } = pagination(req.query);
    return ok(branches.slice((page - 1) * perPage, page * perPage).map((b) => branchObject(ctx, repo, b.name, b.sha)));
  }
  const branchName = rest.join('/');
  const found = branches.find((b) => b.name === branchName);
  if (!found) return NOT_FOUND();
  return ok(branchObject(ctx, repo, found.name, found.sha));
}

function handleCommits(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  if (req.method !== 'GET') return NOT_FOUND();
  if (rest.length === 0) {
    const refish = req.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveToCommit(repo, refish);
    if (!tip) return ok([]);
    const { perPage, page } = pagination(req.query);
    const entries = listCommits(tip, lookupOf(repo));
    const slice = entries.slice((page - 1) * perPage, page * perPage);
    const out: unknown[] = [];
    for (const entry of slice) {
      const serialized = commitObject(ctx, repo, entry.oid);
      if (serialized) out.push(serialized);
    }
    return ok(out);
  }
  if (rest.length === 1) {
    const tip = resolveToCommit(repo, rest[0]);
    if (!tip) return NOT_FOUND();
    const serialized = commitObject(ctx, repo, tip);
    if (!serialized) return NOT_FOUND();
    return ok(serialized);
  }
  return NOT_FOUND();
}

function handleGitRefs(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  if (rest[0] !== 'refs') return NOT_FOUND();
  const refRest = rest.slice(1);
  if (req.method === 'POST' && refRest.length === 0) {
    const body = req.body ?? {};
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'ref and sha are required');
    if (!isValidRefName(ref)) return err(422, 'ref is invalid');
    if (!repo.objects.has(sha)) return err(422, 'sha does not exist');
    if (repo.refs.has(ref)) return err(422, 'ref already exists');
    for (const existing of repo.refs.keys()) {
      if (existing.startsWith(`${ref}/`) || ref.startsWith(`${existing}/`)) {
        return err(422, 'ref conflicts with an existing ref');
      }
    }
    if (ref.startsWith('refs/heads/') && !peelToCommit(sha, lookupOf(repo))) {
      return err(422, 'branch must point at a commit');
    }
    repo.refs.set(ref, sha);
    repo.updatedAt = ctx.nowIso;
    return ok({ ref, node_id: globalId('Ref', repo.dbId, ref), url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}`, object: { sha, type: repo.objects.get(sha)!.type, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${repo.objects.get(sha)!.type}s/${sha}` } }, 201);
  }
  if (req.method === 'GET') {
    if (refRest.length === 0) {
      return ok([...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, sha]) => ({
        ref,
        node_id: globalId('Ref', repo.dbId, ref),
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
      })));
    }
    const wanted = `refs/${refRest.join('/')}`;
    // Exact match first, then prefix match (GitHub lists refs under a namespace).
    const exact = repo.refs.get(wanted);
    if (exact) {
      return ok({ ref: wanted, node_id: globalId('Ref', repo.dbId, wanted), url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${wanted.slice(5)}`, object: { sha: exact, type: repo.objects.get(exact)?.type ?? 'commit', url: '' } });
    }
    const prefix = `${wanted}/`;
    const matches = [...repo.refs.entries()].filter(([ref]) => ref.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (matches.length) {
      return ok(matches.map(([ref, sha]) => ({ ref, node_id: globalId('Ref', repo.dbId, ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } })));
    }
    return NOT_FOUND();
  }
  if (req.method === 'PATCH' && refRest.length > 0) {
    const wanted = `refs/${refRest.join('/')}`;
    const body = req.body ?? {};
    const sha = stringField(body, 'sha');
    if (!isValidRefName(wanted)) return err(422, 'ref is invalid');
    if (!isObjectId(sha) || !repo.objects.has(sha)) return err(422, 'sha does not exist');
    if (!repo.refs.has(wanted)) return NOT_FOUND();
    if (wanted.startsWith('refs/heads/') && !peelToCommit(sha, lookupOf(repo))) {
      return err(422, 'branch must point at a commit');
    }
    repo.refs.set(wanted, sha);
    repo.updatedAt = ctx.nowIso;
    return ok({ ref: wanted, node_id: globalId('Ref', repo.dbId, wanted), url: '', object: { sha, type: repo.objects.get(sha)!.type, url: '' } });
  }
  if (req.method === 'DELETE' && refRest.length > 0) {
    const wanted = `refs/${refRest.join('/')}`;
    if (!repo.refs.delete(wanted)) return NOT_FOUND();
    repo.updatedAt = ctx.nowIso;
    return { status: 204, body: null };
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsFileObject(ctx: ForgeContext, repo: RepoRec, path: string, name: string, oid: string, size: number, refish: string): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    sha: oid,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${encodeURIComponent(refish)}`,
    git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${encodeURIComponent(refish)}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(refish)}/${path}`,
    _links: { git: '', html: '', self: '' },
  };
}

function handleContents(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  const path = rest.join('/');
  if (path === '' || path.split('/').includes('..')) return err(422, 'path is invalid');
  const refish = req.query.get('ref') ?? repo.defaultBranch;

  if (req.method === 'GET') {
    const treeOid = treeAtRef(repo, refish);
    if (!treeOid) return NOT_FOUND();
    const found = treeEntryAt(repo, treeOid, path);
    if (!found) return NOT_FOUND();
    if (found.isDir) {
      return ok(found.entries.map((e) => {
        const childPath = `${path}/${e.name}`;
        if (e.isDir) {
          return {
            type: 'dir', size: 0, name: e.name, path: childPath, sha: e.entry.oid,
            url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${childPath}?ref=${encodeURIComponent(refish)}`,
            git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${e.entry.oid}`,
            html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${encodeURIComponent(refish)}/${childPath}`,
            download_url: null, _links: {},
          };
        }
        const size = repo.objects.get(e.entry.oid)?.data.length ?? 0;
        return { ...contentsFileObject(ctx, repo, childPath, e.name, e.entry.oid, size, refish), content: undefined, download_url: null };
      }));
    }
    const object = repo.objects.get(found.entry.oid);
    if (!object || object.type !== 'blob') return NOT_FOUND();
    const name = path.split('/').pop()!;
    return ok({
      ...contentsFileObject(ctx, repo, path, name, found.entry.oid, object.data.length, refish),
      content: object.data.toString('base64'),
    });
  }

  if (req.method === 'PUT') {
    const body = req.body ?? {};
    const contentRaw = typeof body.content === 'string' ? body.content : null;
    if (contentRaw === null) return err(422, 'content is required');
    const stripped = contentRaw.replace(/\s+/g, '');
    // Buffer.from(x, 'base64') never throws — it silently drops bad characters —
    // so validate the canonical shape first (empty content is a 0-byte file).
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stripped)) {
      return err(422, 'content is not valid base64');
    }
    const content = Buffer.from(stripped, 'base64');
    const message = stringField(body, 'message', `Update ${path}`);
    const branch = stringField(body, 'branch', repo.defaultBranch) || repo.defaultBranch;
    if (!isValidBranchName(branch)) return err(422, 'branch is invalid');
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    const flat = flatAtBranch(repo, branch);
    const existing = flat.get(path);
    if (existing && !givenSha) return err(409, 'sha is required to update an existing file');
    if (existing && givenSha && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    if (!existing) {
      for (const key of flat.keys()) {
        if (key.startsWith(`${path}/`) || path.startsWith(`${key}/`)) {
          return err(422, 'path conflicts with an existing file or directory');
        }
      }
    }
    const blobOid = putObject(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const treeOid = buildTreeFromMap(flat, (type, data) => putObject(repo, type, data));
    const { commitOid } = commitOnBranch(repo, branch, treeOid, message, ctx);
    const name = path.split('/').pop()!;
    const commit = commitObject(ctx, repo, commitOid)!;
    return ok(
      {
        content: { ...contentsFileObject(ctx, repo, path, name, blobOid, content.length, branch), content: contentRaw, encoding: 'base64' },
        commit,
      },
      existing ? 200 : 201,
    );
  }

  if (req.method === 'DELETE') {
    const body = req.body ?? {};
    const message = stringField(body, 'message', `Delete ${path}`);
    const branch = stringField(body, 'branch', repo.defaultBranch) || repo.defaultBranch;
    if (!isValidBranchName(branch)) return err(422, 'branch is invalid');
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    const flat = flatAtBranch(repo, branch);
    const existing = flat.get(path);
    if (!existing) return NOT_FOUND();
    if (!givenSha) return err(409, 'sha is required to delete a file');
    if (givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    flat.delete(path);
    const treeOid = buildTreeFromMap(flat, (type, data) => putObject(repo, type, data));
    const { commitOid } = commitOnBranch(repo, branch, treeOid, message, ctx);
    return ok({ content: null, commit: commitObject(ctx, repo, commitOid)! });
  }
  return NOT_FOUND();
}

function treeAtRef(repo: RepoRec, refish: string): string | null {
  const commitOid = resolveToCommit(repo, refish);
  if (!commitOid) return null;
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------------------------
// labels / issues / pulls
// ---------------------------------------------------------------------------------------------

function handleLabels(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const { perPage, page } = pagination(req.query);
      return ok([...repo.labels.values()].slice((page - 1) * perPage, page * perPage).map((l) => labelObject(ctx, repo, l)));
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const name = stringField(body, 'name');
      if (!name) return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, `label ${name} already exists`);
      repo.labelSeq += 1;
      const label: Label = {
        id: repo.labelSeq,
        name,
        color: stringField(body, 'color', 'ededed').replace(/^#/, '') || 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(name, label);
      return ok(labelObject(ctx, repo, label), 201);
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

function parseLabelNames(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function handleIssues(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      else list.sort((a, b) => a.number - b.number);
      const { perPage, page } = pagination(req.query);
      return ok(list.slice((page - 1) * perPage, page * perPage).map((i) => issueObject(ctx, repo, i)));
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const title = stringField(body, 'title');
      if (!title) return err(422, 'title is required');
      const labels = parseLabelNames(body);
      if (labels === null) return err(422, 'labels must be an array');
      for (const name of labels) {
        if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
      }
      const issue = createIssueRecord(ctx.store, repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        labels,
        nowIso: ctx.nowIso,
      });
      return ok(issueObject(ctx, repo, issue), 201);
    }
    return NOT_FOUND();
  }
  const number = parseNumber(rest[0]);
  if (number === null) return NOT_FOUND();
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      if (!issue) return NOT_FOUND();
      return ok(issueObject(ctx, repo, issue));
    }
    if (req.method === 'PATCH') {
      if (!issue) return NOT_FOUND();
      const body = req.body ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? ctx.nowIso : null;
      }
      if (body.labels !== undefined) {
        const labels = parseLabelNames(body);
        if (labels === null) return err(422, 'labels must be an array');
        for (const name of labels) {
          if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
        }
        issue.labels = labels;
      }
      issue.updatedAt = ctx.nowIso;
      return ok(issueObject(ctx, repo, issue));
    }
    return NOT_FOUND();
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (!issue) return NOT_FOUND();
    if (req.method === 'GET') {
      const { perPage, page } = pagination(req.query);
      return ok(issue.comments.slice((page - 1) * perPage, page * perPage).map((c) => commentObject(ctx, repo, number, c, 'issues')));
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const commentBody = stringField(body, 'body');
      if (!commentBody) return err(422, 'body is required');
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: commentBody, authorLogin: ctx.viewer.login, createdAt: ctx.nowIso, updatedAt: ctx.nowIso };
      issue.comments.push(comment);
      issue.updatedAt = ctx.nowIso;
      return ok(commentObject(ctx, repo, number, comment, 'issues'), 201);
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

function handlePulls(ctx: ForgeContext, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { perPage, page } = pagination(req.query);
      return ok(list.slice((page - 1) * perPage, page * perPage).map((p) => pullObject(ctx, repo, p)));
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (!title) return err(422, 'title is required');
      if (!head || !base) return err(422, 'head and base are required');
      const headRef = head.includes(':') ? head.split(':').slice(1).join(':') : head;
      if (!repo.refs.has(`refs/heads/${headRef}`)) return err(422, `head ref ${headRef} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return err(422, `base ref ${base} does not exist`);
      const pull = createPullRecord(ctx.store, repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        headRef,
        baseRef: base,
        nowIso: ctx.nowIso,
      });
      return ok(pullObject(ctx, repo, pull), 201);
    }
    return NOT_FOUND();
  }
  const number = parseNumber(rest[0]);
  if (number === null) return NOT_FOUND();
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      if (!pull) return NOT_FOUND();
      return ok(pullObject(ctx, repo, pull));
    }
    if (req.method === 'PATCH') {
      if (!pull) return NOT_FOUND();
      const body = req.body ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' && pull.state === 'closed' && !pull.merged) {
        pull.state = 'open';
        pull.closedAt = null;
      } else if (body.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedAt = ctx.nowIso;
      }
      pull.updatedAt = ctx.nowIso;
      return ok(pullObject(ctx, repo, pull));
    }
    return NOT_FOUND();
  }
  if (rest[1] === 'files' && rest.length === 2) {
    if (req.method !== 'GET') return NOT_FOUND();
    if (!pull) return NOT_FOUND();
    const files = pullDiff(repo, pull);
    const { perPage, page } = pagination(req.query);
    return ok(files.slice((page - 1) * perPage, page * perPage).map((f) => ({
      sha: f.newOid ?? f.oldOid ?? '',
      filename: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${liveHeadSha(repo, pull) ?? ''}/${f.path}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${liveHeadSha(repo, pull) ?? ''}/${f.path}`,
      contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${f.path}?ref=${encodeURIComponent(pull.headRef)}`,
    })));
  }
  if (rest[1] === 'merge' && rest.length === 2) {
    if (req.method !== 'PUT') return NOT_FOUND();
    if (!pull) return NOT_FOUND();
    const { sha } = mergePullRecord(repo, pull, ctx);
    return ok({ sha, merged: true, message: `Pull Request successfully merged` });
  }
  return NOT_FOUND();
}
