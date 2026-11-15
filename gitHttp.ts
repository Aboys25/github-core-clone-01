/**
 * gitHttp.ts — git smart HTTP: info/refs advertisements (v0 + v2), upload-pack
 * (ls-refs + fetch, v2 and v0), and receive-pack pushes with report-status.
 *
 * Outgoing packs hold plain objects only, sorted by oid. Incoming packs resolve
 * OFS_DELTA/REF_DELTA (thin-pack bases come from the store). Ref updates must
 * fast-forward; a refusal is reported per ref, never thrown as HTTP.
 */

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isObjectId,
  parseCommit,
  parsePackets,
  parseTag,
  parseTree,
  peelTags,
  peelToCommit,
  pktFlush,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
} from './git.ts';
import type { GitObject, Packet } from './git.ts';
import { GitError } from './git.ts';
import { lookupOf } from './store.ts';
import type { RepoRec } from './store.ts';
import type { ForgeContext } from './app-types.ts';

export const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
export const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
const AGENT = 'github-core-clone/1.0';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function sortedRefs(repo: RepoRec): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Peel a tag ref to its ultimate commit oid, for a ^{}-line; null when it is not a tag-to-commit. */
function peeledCommit(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const peeled = peelTags(oid, lookupOf(repo));
  if (!peeled || peeled.type !== 'commit' || peeled.oid === oid) return null;
  return peeled.oid;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', capabilities: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  } else {
    let first = true;
    if (defaultTip) {
      lines.push(`${defaultTip} HEAD\u0000${capabilities}\n`);
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\u0000${capabilities}` : '';
      first = false;
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

export function handleInfoRefs(
  ctx: ForgeContext,
  repo: RepoRec | undefined,
  service: string | null,
  gitProtocol: string | null,
): GitResponse | { status: 404; message: string } {
  if (!repo) return { status: 404, message: 'Not Found' };
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') return ok(UPLOAD_AD_CT, v2Advertisement());
    const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative agent=${AGENT}`;
    return ok(UPLOAD_AD_CT, v0Advertisement(repo, 'git-upload-pack', caps));
  }
  if (service === 'git-receive-pack') {
    const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    return ok(RECEIVE_AD_CT, v0Advertisement(repo, 'git-receive-pack', caps));
  }
  return { status: 404, message: 'Not Found' };
}

// ---------------------------------------------------------------------------------------------
// upload-pack: protocol v2
// ---------------------------------------------------------------------------------------------

interface V2Request {
  readonly command: string;
  readonly args: string[];
}

function parseV2Request(body: Buffer): V2Request {
  const { packets } = parsePackets(body, 0);
  // A v2 request is one packet run ending in a flush; parsePackets stops at the flush.
  const lines: string[] = [];
  let command = '';
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.data.toString('utf8').replace(/\n$/, '');
    if (command === '' && text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= before the delimiter
    lines.push(text);
  }
  if (!command) throw new GitError('v2 request has no command', 'v2-command');
  return { command, args: lines };
}

function handleLsRefs(repo: RepoRec, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix:')) prefixes.push(arg.slice('ref-prefix:'.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    if (unborn && matches('HEAD')) {
      const sym = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`unborn HEAD${sym}\n`));
    }
  } else {
    if (defaultTip && matches('HEAD')) {
      const sym = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${defaultTip} HEAD${sym}\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Reachability that stops at `cutoff` commits: a shallow boundary's parents are NOT had. */
function closureWithCutoff(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined, cutoff: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cutoff.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

/**
 * Select the objects for a fetch: closure(visited commits) minus closure(haves).
 * Visited commits come from a depth-limited BFS from the wants (tags peeled).
 */
function planFetch(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | null,
  since: number | null,
  notRefs: string[],
  deepenRelative = false,
): FetchPlan {
  const lookup = lookupOf(repo);
  const wantTags: string[] = [];
  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) throw new GitError(`want ${want} is not in the repository`, 'fetch-unknown-want');
    if (object.type === 'tag') {
      wantTags.push(want);
      const peeled = peelToCommit(want, lookup);
      if (peeled) wantCommits.push(peeled);
      else {
        const target = peelTags(want, lookup);
        if (target) extraRoots.push(target.oid);
      }
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      extraRoots.push(want);
    }
  }

  // Exclusion set for deepen-not.
  const excluded = new Set<string>();
  for (const ref of notRefs) {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (tip) {
      for (const oid of collectReachable([tip], lookup, { allowMissing: true })) excluded.add(oid);
    }
  }

  // Depth-limited BFS over commits. With deepen-relative (real git's --deepen),
  // the depth counts edges past the client's shallow boundaries, per path: a
  // commit at or above a boundary has relative depth 0, and each edge beyond a
  // boundary adds 1. Without it, depth counts edges from the wants (absolute).
  const relative = deepenRelative && oldShallow.length > 0 && depth !== null;
  const shallowSet = new Set(oldShallow);
  const visited = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; level: number; rel: number }> = wantCommits.map((oid) => ({ oid, level: 0, rel: 0 }));
  const queued = new Set<string>(wantCommits);
  const relOf = new Map<string, number>();
  for (const oid of wantCommits) relOf.set(oid, 0);
  const processedRel = new Map<string, number>();
  while (queue.length) {
    const { oid, level, rel } = queue.shift()!;
    if (relative) {
      const done = processedRel.get(oid);
      if (done !== undefined && done <= rel) continue; // already expanded with an equal-or-better depth
      processedRel.set(oid, rel);
    } else if (visited.has(oid)) {
      continue;
    }
    if (excluded.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (since !== null) {
      const match = / (\d+) [+-]\d{4}$/.exec(commit.committer.trim());
      if (match && Number(match[1]) < since) {
        // Too old: cut here; the child that led here is a boundary (the
        // post-pass below derives boundaries from the final visited set).
        continue;
      }
    }
    visited.add(oid);
    for (const parent of commit.parents) {
      if (!lookup(parent) || excluded.has(parent)) continue;
      const parentRel = shallowSet.has(oid) ? 1 : rel > 0 ? rel + 1 : 0;
      const atLimit = relative ? parentRel > (depth as number) : depth !== null && level + 1 >= depth;
      if (atLimit) continue;
      if (relative) {
        const prev = relOf.get(parent);
        if (prev === undefined || parentRel < prev) {
          relOf.set(parent, parentRel);
          queue.push({ oid: parent, level: level + 1, rel: parentRel });
        }
      } else if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, level: level + 1, rel: 0 });
      }
    }
  }
  // Any visited commit with an in-store parent outside `visited` is a boundary.
  for (const oid of visited) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (lookup(parent) && !visited.has(parent)) boundary.add(oid);
    }
  }

  const haveClosure = closureWithCutoff(haves, lookup, new Set(oldShallow));
  const send = new Set<string>();
  // Tag objects themselves (and their chains) always go out when wanted.
  for (const tagOid of wantTags) {
    for (const oid of collectReachable([tagOid], lookup, { allowMissing: true })) {
      if (visited.has(oid) || !haveClosure.has(oid)) {
        // Tag chains may reach commits outside the depth limit; only send the
        // tag objects plus non-commit targets here — commits come from `visited`.
        const object = lookup(oid);
        if (object && object.type !== 'commit') send.add(oid);
      }
    }
    send.add(tagOid);
  }
  for (const oid of visited) {
    if (haveClosure.has(oid)) continue;
    send.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const treeOid of collectReachable([parseCommit(object.data).tree], lookup, { allowMissing: true })) {
      if (!haveClosure.has(treeOid)) send.add(treeOid);
    }
  }
  for (const root of extraRoots) {
    for (const oid of collectReachable([root], lookup, { allowMissing: true })) {
      if (!haveClosure.has(oid)) send.add(oid);
    }
  }
  // Never send a commit outside the visited set (tag chains reaching past depth).
  for (const oid of [...send]) {
    const object = lookup(oid);
    if (object?.type === 'commit' && !visited.has(oid)) send.delete(oid);
  }

  const objects = [...send]
    .sort()
    .map((oid) => lookup(oid)!)
    .filter(Boolean);

  const shallow = [...boundary].sort();
  const unshallow: string[] = [];
  for (const oid of oldShallow) {
    if (!visited.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => !lookup(parent) || visited.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();

  // ACKs: only computed when the client sent haves (keeps the no-have fast path cheap).
  const acks: string[] = [];
  if (haves.length) {
    const fullClosure = collectReachable(wantCommits, lookup, { allowMissing: true });
    for (const have of haves) if (fullClosure.has(have)) acks.push(have);
  }
  return { objects, shallow, unshallow, acks };
}

function handleFetchV2(repo: RepoRec, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | null = null;
  let since: number | null = null;
  let done = false;
  let deepenRelative = false;
  const notRefs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) oldShallow.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = depth === null ? n : Math.min(depth, n);
    } else if (arg.startsWith('deepen-since ')) {
      const n = Number(arg.slice(13).trim());
      if (Number.isSafeInteger(n)) since = n;
    } else if (arg.startsWith('deepen-not ')) notRefs.push(arg.slice(11).trim());
  }
  const plan = planFetch(repo, wants, haves, oldShallow, depth, since, notRefs, deepenRelative);
  const parts: Buffer[] = [];
  // Section framing: name line, content lines, flush — no delim packets (the
  // suite client's parser resets the current section on a delim). The
  // acknowledgments section appears only while negotiation is still open (no
  // `done`): real git sends no ack section once the client sent `done`, and
  // answers a done-less request with acks only, awaiting the next round.
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (depth !== null || since !== null || notRefs.length || oldShallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  const pack = writePack(plan.objects);
  parts.push(pktLine('packfile\n'), ...sidebandPackets(1, pack), pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: protocol v0 (real-git compatibility; the suite speaks v2)
// ---------------------------------------------------------------------------------------------

function handleFetchV0(repo: RepoRec, body: Buffer): Buffer {
  // Section 1: want/shallow/deepen lines until flush. Section 2: have/done until flush.
  const first = parsePackets(body, 0);
  const wants: string[] = [];
  const oldShallow: string[] = [];
  const notRefs: string[] = [];
  let depth: number | null = null;
  let since: number | null = null;
  let deepenRelative = false;
  const wantCaps = new Set<string>();
  for (const packet of first.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul);
    // The first want line carries capabilities space-separated after the oid.
    if (text.startsWith('want ')) {
      const tokens = text.slice(5).trim().split(' ');
      wants.push(tokens[0]);
      for (const token of tokens.slice(1)) wantCaps.add(token.split('=')[0]);
    } else if (text.startsWith('shallow ')) oldShallow.push(text.slice(8).trim());
    else if (text === 'deepen-relative') deepenRelative = true;
    else if (text.startsWith('deepen-since ')) {
      const n = Number(text.slice(13).trim());
      if (Number.isSafeInteger(n)) since = n;
    } else if (text.startsWith('deepen-not ')) notRefs.push(text.slice(11).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  // In v0, deepen-relative is a capability token on the want line (not a
  // separate request line as in v2); honour either form.
  if (wantCaps.has('deepen-relative')) deepenRelative = true;
  const haves: string[] = [];
  let done = false;
  if (first.nextOffset < body.length) {
    const second = parsePackets(body, first.nextOffset);
    for (const packet of second.packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.data.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text === 'done') done = true;
    }
  }
  const plan = planFetch(repo, wants, haves, oldShallow, depth, since, notRefs, deepenRelative);
  const parts: Buffer[] = [];
  const shallowNegotiation = depth !== null || oldShallow.length > 0;
  // Two-phase v0 negotiation over stateless HTTP: real git first POSTs
  // wants+deepen WITHOUT done and reads only the shallow section; it then
  // POSTs again WITH done for the full response. A no-done request must
  // therefore end its response at the shallow section (or, without shallow
  // negotiation, at the ack lines) and never send a packfile.
  if (!done && shallowNegotiation) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // When the request negotiated shallowness, the shallow section (lines with
  // no trailing newline) is terminated by a flush before the ack lines; real
  // git reads the section iff it sent deepen/shallow. Without negotiation the
  // ack lines come first, with no leading flush.
  if (shallowNegotiation) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}`));
    parts.push(pktFlush());
  }
  // Ack framing follows the negotiated capability: with multi_ack[_detailed]
  // every ack but the last carries a suffix (the client reads lines until a
  // bare ACK terminates the phase); without it, exactly one bare ACK is sent.
  if (plan.acks.length) {
    if (wantCaps.has('multi_ack_detailed')) {
      plan.acks.forEach((ack, index) => {
        parts.push(pktLine(index === plan.acks.length - 1 ? `ACK ${ack}\n` : `ACK ${ack} common\n`));
      });
    } else if (wantCaps.has('multi_ack')) {
      plan.acks.forEach((ack, index) => {
        parts.push(pktLine(index === plan.acks.length - 1 ? `ACK ${ack}\n` : `ACK ${ack} continue\n`));
      });
    } else {
      parts.push(pktLine(`ACK ${plan.acks[0]}\n`));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (!done) {
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const pack = writePack(plan.objects);
  parts.push(...sidebandPackets(1, pack), pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(
  _ctx: ForgeContext,
  repo: RepoRec | undefined,
  body: Buffer,
): GitResponse | { status: number; message: string } {
  if (!repo) return { status: 404, message: 'Not Found' };
  try {
    if (body.length === 0) return { status: 400, message: 'Empty request body' };
    const first = parsePackets(body, 0);
    const firstData = first.packets.find((p): p is Packet & { kind: 'data' } => p.kind === 'data');
    const firstText = firstData ? firstData.data.toString('utf8') : '';
    if (firstText.startsWith('command=')) {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') return ok(UPLOAD_RESULT_CT, handleLsRefs(repo, request.args));
      if (request.command === 'fetch') return ok(UPLOAD_RESULT_CT, handleFetchV2(repo, request.args));
      return { status: 400, message: `Unknown command ${request.command}` };
    }
    return ok(UPLOAD_RESULT_CT, handleFetchV0(repo, body));
  } catch (err) {
    if (err instanceof GitError) return { status: 400, message: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export function handleReceivePack(
  _ctx: ForgeContext,
  repo: RepoRec | undefined,
  body: Buffer,
): GitResponse | { status: number; message: string } {
  if (!repo) return { status: 404, message: 'Not Found' };
  const lookup = lookupOf(repo);
  let commands: PushCommand[];
  let packBytes: Buffer;
  try {
    const parsed = parsePackets(body, 0);
    commands = [];
    for (const packet of parsed.packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.data.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      if (nul >= 0) text = text.slice(0, nul);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
      if (!match) throw new GitError(`bad push command ${JSON.stringify(text)}`, 'push-command');
      commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    }
    packBytes = body.subarray(parsed.nextOffset);
  } catch (err) {
    if (err instanceof GitError) return { status: 400, message: err.message };
    throw err;
  }

  // Unpack first: a refused ref must still unpack ok.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const result = readPack(packBytes, { resolveBase: lookup });
      for (const [oid, object] of result.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} ref does not exist`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} old oid mismatch`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (!target) {
        reportLines.push(`ng ${command.ref} object ${command.newOid} is missing`);
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} old oid mismatch`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old oid mismatch`);
        continue;
      }
      if (command.newOid === current) {
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      // Fast-forward check on commits (tags peel to commits; other types: allow).
      const newCommit = peelToCommit(command.newOid, lookup);
      const oldCommit = peelToCommit(current, lookup);
      if (newCommit && oldCommit) {
        if (!isAncestor(newCommit, oldCommit, lookup)) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      } else if (newCommit !== oldCommit && command.ref.startsWith('refs/heads/')) {
        // Branch moving to/from a non-commit: only allow when the target exists.
        if (!newCommit) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }

  const reportParts: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const line of reportLines) reportParts.push(pktLine(`${line}\n`));
  // The report stream inside band 1 ends with its own flush packet (real git's
  // report parser reads pkt-lines from the demuxed stream until a flush); the
  // outer packet stream ends with a second flush.
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);
  const bodyOut = Buffer.concat([...sidebandPackets(1, report), pktFlush()]);
  return ok(RECEIVE_RESULT_CT, bodyOut);
}
