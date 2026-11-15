/**
 * store.ts — the in-memory forge: repositories, git objects, refs, labels, issues,
 * pull requests, and the shared domain operations REST, GraphQL, and MCP all use.
 *
 * Everything lives in Maps, in insertion order, so behaviour is deterministic for a
 * given request sequence. Timestamps come from the trial time passed in, never the
 * clock.
 */

import {
  buildCommit,
  buildTreeFromMap,
  diffTrees,
  flattenTree,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  peelToCommit,
  threeWayMerge,
} from './git.ts';
import type { DiffFile, FlatEntry, GitObject, GitObjectType } from './git.ts';
import { formatIdentity } from './util.ts';
import type { ScenarioUser } from './scenario.ts';

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  readonly id: number;
  body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  readonly number: number;
  readonly dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: CommentRec[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  readonly number: number;
  readonly dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreate: string | null;
  readonly baseShaAtCreate: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoRec {
  readonly dbId: number;
  readonly name: string;
  readonly owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  counter: number;
  commentSeq: number;
  labelSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export class DomainError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  #dbSeq = 1;

  nextDbId(): number {
    return this.#dbSeq++;
  }

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  createRepo(owner: string, name: string, opts: { description?: string | null; isPrivate?: boolean; defaultBranch?: string; nowIso: string }): RepoRec | null {
    if (this.repos.has(Store.key(owner, name))) return null;
    const repo: RepoRec = {
      dbId: this.nextDbId(),
      name,
      owner,
      description: opts.description ?? null,
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      counter: 0,
      commentSeq: 0,
      labelSeq: 0,
      createdAt: opts.nowIso,
      updatedAt: opts.nowIso,
    };
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }
}

// ---------------------------------------------------------------------------------------------
// object + ref helpers
// ---------------------------------------------------------------------------------------------

export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function lookupOf(repo: RepoRec): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/** Resolve a ref-ish to a commit oid: HEAD, full ref, branch/tag short name, or oid. */
export function resolveToCommit(repo: RepoRec, refish: string): string | null {
  const lookup = lookupOf(repo);
  if (refish === 'HEAD') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip ? peelToCommit(tip, lookup) : null;
  }
  const direct = repo.refs.get(refish) ?? repo.refs.get(`refs/heads/${refish}`) ?? repo.refs.get(`refs/tags/${refish}`);
  if (direct) return peelToCommit(direct, lookup);
  if (isObjectId(refish)) return peelToCommit(refish, lookup);
  return null;
}

/** Resolve a ref-ish to any object oid (no peeling). */
export function resolveToObject(repo: RepoRec, refish: string): string | null {
  if (refish === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(refish) ?? repo.refs.get(`refs/heads/${refish}`) ?? repo.refs.get(`refs/tags/${refish}`);
  if (direct) return direct;
  if (isObjectId(refish) && repo.objects.has(refish)) return refish;
  return null;
}

/** The tree oid at a commit, or null when the ref does not resolve. */
export function treeAt(repo: RepoRec, refish: string): string | null {
  const commitOid = resolveToCommit(repo, refish);
  if (!commitOid) return null;
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------------------------
// commits authored by the forge (contents API, merges)
// ---------------------------------------------------------------------------------------------

export interface ForgeIdentity {
  readonly viewer: ScenarioUser;
  readonly nowSec: number;
  readonly nowIso: string;
}

/** Create a commit object on `branch`, creating the branch from the default tip if needed. */
export function commitOnBranch(
  repo: RepoRec,
  branch: string,
  treeOid: string,
  message: string,
  id: ForgeIdentity,
): { commitOid: string; parent: string | null } {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref) ?? null;
  if (parent === null && branch !== repo.defaultBranch) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const who = formatIdentity(id.viewer.name, id.viewer.email, id.nowSec);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const commitOid = putObject(repo, 'commit', buildCommit({
    tree: treeOid,
    parents: parent ? [parent] : [],
    message: body,
    author: who,
    committer: who,
  }));
  repo.refs.set(ref, commitOid);
  repo.updatedAt = id.nowIso;
  return { commitOid, parent };
}

/** The flat file map at a branch tip (empty when the branch is unborn). */
export function flatAtBranch(repo: RepoRec, branch: string): Map<string, FlatEntry> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const commitOid = peelToCommit(tip, lookupOf(repo));
  if (!commitOid) return new Map();
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(parseCommit(object.data).tree, lookupOf(repo));
}

// ---------------------------------------------------------------------------------------------
// issues + pulls
// ---------------------------------------------------------------------------------------------

export function createIssueRecord(
  store: Store,
  repo: RepoRec,
  opts: { title: string; body?: string; labels?: string[]; nowIso: string },
): IssueRec {
  const number = repo.counter + 1;
  repo.counter = number;
  const issue: IssueRec = {
    number,
    dbId: store.nextDbId(),
    title: opts.title,
    body: opts.body ?? '',
    state: 'open',
    labels: [...(opts.labels ?? [])],
    comments: [],
    createdAt: opts.nowIso,
    updatedAt: opts.nowIso,
    closedAt: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPullRecord(
  store: Store,
  repo: RepoRec,
  opts: { title: string; body?: string; headRef: string; baseRef: string; nowIso: string },
): PullRec {
  const number = repo.counter + 1;
  repo.counter = number;
  const pull: PullRec = {
    number,
    dbId: store.nextDbId(),
    title: opts.title,
    body: opts.body ?? '',
    state: 'open',
    merged: false,
    headRef: opts.headRef,
    baseRef: opts.baseRef,
    headShaAtCreate: repo.refs.get(`refs/heads/${opts.headRef}`) ?? null,
    baseShaAtCreate: repo.refs.get(`refs/heads/${opts.baseRef}`) ?? null,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: opts.nowIso,
    updatedAt: opts.nowIso,
    closedAt: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}

export function liveHeadSha(repo: RepoRec, pull: PullRec): string | null {
  return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
}

export function liveBaseSha(repo: RepoRec, pull: PullRec): string | null {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
}

/** The diff of a pull request: merge-base tree vs head tip tree, from LIVE tips. */
export function pullDiff(repo: RepoRec, pull: PullRec): DiffFile[] {
  const lookup = lookupOf(repo);
  const headTip = liveHeadSha(repo, pull);
  const baseTip = liveBaseSha(repo, pull);
  if (!headTip || !baseTip) return [];
  const headCommit = peelToCommit(headTip, lookup);
  const baseCommit = peelToCommit(baseTip, lookup);
  if (!headCommit || !baseCommit) return [];
  const base = mergeBase(headCommit, baseCommit, lookup);
  const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
  const headFlat = flattenTree(headTree, lookup);
  if (!base) return diffTrees(new Map(), headFlat, lookup);
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  return diffTrees(flattenTree(baseTree, lookup), headFlat, lookup);
}

/** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' from live tips and the three-way merge. */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const lookup = lookupOf(repo);
  const headTip = liveHeadSha(repo, pull);
  const baseTip = liveBaseSha(repo, pull);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const headCommit = peelToCommit(headTip, lookup);
  const baseCommit = peelToCommit(baseTip, lookup);
  if (!headCommit || !baseCommit) return 'UNKNOWN';
  const base = mergeBase(headCommit, baseCommit, lookup);
  const headFlat = flattenTree(parseCommit(repo.objects.get(headCommit)!.data).tree, lookup);
  const oursFlat = flattenTree(parseCommit(repo.objects.get(baseCommit)!.data).tree, lookup);
  const baseFlat = base ? flattenTree(parseCommit(repo.objects.get(base)!.data).tree, lookup) : new Map<string, FlatEntry>();
  const { conflicts } = threeWayMerge(baseFlat, oursFlat, headFlat);
  return conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge a pull request onto its base branch using LIVE tips.
 * Throws DomainError(405) on conflict, DomainError(405) when already closed.
 */
export function mergePullRecord(repo: RepoRec, pull: PullRec, id: ForgeIdentity): { sha: string } {
  if (pull.state !== 'open') throw new DomainError(405, 'Pull request is not open');
  const lookup = lookupOf(repo);
  const headTip = liveHeadSha(repo, pull);
  const baseTip = liveBaseSha(repo, pull);
  if (!headTip || !baseTip) throw new DomainError(405, 'Pull request head or base is missing');
  const headCommit = peelToCommit(headTip, lookup);
  const baseCommit = peelToCommit(baseTip, lookup);
  if (!headCommit || !baseCommit) throw new DomainError(405, 'Pull request head or base is missing');
  const base = mergeBase(headCommit, baseCommit, lookup);
  const headFlat = flattenTree(parseCommit(repo.objects.get(headCommit)!.data).tree, lookup);
  const oursFlat = flattenTree(parseCommit(repo.objects.get(baseCommit)!.data).tree, lookup);
  const baseFlat = base ? flattenTree(parseCommit(repo.objects.get(base)!.data).tree, lookup) : new Map<string, FlatEntry>();
  const { merged, conflicts } = threeWayMerge(baseFlat, oursFlat, headFlat);
  if (!merged) throw new DomainError(405, `Merge conflict in: ${conflicts.join(', ')}`);
  const treeOid = buildTreeFromMap(merged, (type, data) => putObject(repo, type, data));
  const { commitOid } = commitOnBranch(repo, pull.baseRef, treeOid, `${pull.title} (#${pull.number})`, id);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = id.nowIso;
  pull.mergeCommitSha = commitOid;
  pull.closedAt = id.nowIso;
  pull.updatedAt = id.nowIso;
  return { sha: commitOid };
}
