/**
 * git.ts — the git object model, pkt-line codec, packfile read/write, traversal,
 * merge-base, three-way merge, and line diff. Node standard library only.
 *
 * The wire formats implemented here are git's documented smart-HTTP formats:
 * pkt-lines (4-hex length, 0000 flush, 0001 delim, 0002 response-end, max 65520),
 * packfile v2 (plain objects on write; OFS_DELTA/REF_DELTA resolved on read),
 * and SHA-1 object ids over "<type> <size>\0" + bytes.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: Array<[string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export class GitError extends Error {
  readonly code: string;

  constructor(message: string, code = 'protocol') {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 over "<type> <size>\0" + bytes, exactly as git computes it. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  return createHash('sha1').update(`${type} ${data.length}\u0000`, 'utf8').update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** One pkt-line: 4 lowercase hex digits of length (header included) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length + 4 > PKT_LINE_MAX) throw new GitError('pkt-line payload too large', 'pkt-size');
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Packet =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Parse pkt-lines from `buffer` starting at `start`, stopping after the first flush
 * (or at end of input). Returns the packets and the offset just past what was read,
 * so a caller can treat the remainder as raw bytes (a packfile after a flush).
 */
export function parsePackets(buffer: Buffer, start = 0): { packets: Packet[]; nextOffset: number } {
  const packets: Packet[] = [];
  let offset = start;
  for (;;) {
    if (offset === buffer.length) return { packets, nextOffset: offset };
    if (offset + 4 > buffer.length) throw new GitError('truncated pkt-line header', 'pkt-truncated');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, nextOffset: offset + 4 };
    }
    if (header === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-f]{4}$/.test(header)) throw new GitError(`bad pkt-line header ${JSON.stringify(header)}`, 'pkt-header');
    const length = parseInt(header, 16);
    if (length < 4 || length > PKT_LINE_MAX) throw new GitError(`bad pkt-line length ${length}`, 'pkt-length');
    if (offset + length > buffer.length) throw new GitError('truncated pkt-line payload', 'pkt-truncated');
    packets.push({ kind: 'data', data: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
}

/** Parse every pkt-line in a complete buffer (no raw tail expected). */
export function parseAllPackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = parsePackets(buffer, offset);
    packets.push(...parsed.packets);
    if (parsed.nextOffset === offset) throw new GitError('pkt-line parser made no progress', 'pkt-stuck');
    offset = parsed.nextOffset;
    // parsePackets stops after a flush; keep going only while bytes remain and the
    // last packet was a flush that was not terminal for this framing (v2 requests
    // end with a flush, so a trailing flush ends the loop naturally).
    if (parsed.packets[parsed.packets.length - 1]?.kind === 'flush' && offset >= buffer.length) break;
  }
  return packets;
}

/** Split a sideband payload into band-1 packets of at most 65515 data bytes each. */
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = PKT_LINE_MAX_PAYLOAD - 1;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// objects: tree / commit / tag
// ---------------------------------------------------------------------------------------------

/** Parse a tree object into entries; refuses a malformed layout. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode', 'tree-parse');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const nul = buffer.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new GitError('tree entry is truncated', 'tree-parse');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitError('tree entry mode is not octal', 'tree-parse');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitError('tree entry has a bad object id', 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new GitError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new GitError('commit has a bad parent id', 'commit-parse');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitError('tag header has no value', 'tag-parse');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitError('tag has a bad type', 'tag-parse');
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  if (!isObjectId(fields.tree)) throw new GitError('buildCommit needs a valid tree id', 'commit-build');
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new GitError('buildCommit needs valid parent ids', 'commit-build');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries
 * (gitlinks skipped), tag → its target, blob → nothing.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
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

/** Follow tag objects to their ultimate target; null when the chain leaves the store. */
export function peelTags(oid: string, lookup: ObjectLookup): { oid: string; type: GitObjectType } | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = lookup(current);
    if (!object) return null;
    if (object.type !== 'tag') return { oid: current, type: object.type };
    current = parseTag(object.data).object;
  }
}

/** Follow tags to a commit; null when the target is not a commit or is missing. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  const peeled = peelTags(oid, lookup);
  return peeled && peeled.type === 'commit' ? peeled.oid : null;
}

// ---------------------------------------------------------------------------------------------
// packfile read
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitError('pack entry has no size header', 'pack-truncated');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitError('pack entry size varint is too long', 'pack-corrupt');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitError('ofs-delta has no base offset', 'pack-truncated');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('ofs-delta base offset is truncated', 'pack-truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new GitError('delta size varint is truncated', 'delta-corrupt');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new GitError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitError('delta copy offset is truncated', 'delta-corrupt');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitError('delta copy size is truncated', 'delta-corrupt');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new GitError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new GitError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size', 'delta-corrupt');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new GitError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out.
 * Every object's SHA-1 is recomputed and its declared size checked.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new GitError(`pack is ${buffer.length} bytes, too short`, 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack does not start with PACK', 'pack-header');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new GitError('pack trailer checksum does not match its bytes', 'pack-checksum');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new GitError(`ofs-delta at ${entryOffset} names an invalid base offset`, 'pack-delta');
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitError('ref-delta base id is truncated', 'pack-truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new GitError('pack entry inflated size does not match its declaration', 'pack-size');
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new GitError('pack has stray bytes before its trailer', 'pack-trailing');

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitError('delta cycle in pack', 'pack-delta-cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new GitError('ofs-delta base is not in the pack', 'pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new GitError('ref-delta base is neither in the pack nor in the store', 'pack-delta-base');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, checksumOk, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in the caller's order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// traversal, merge-base, trees, merge, diff
// ---------------------------------------------------------------------------------------------

/** True when `ancestor` is reachable from `tip` by following parents (or equal). */
export function isAncestor(tip: string, ancestor: string, lookup: ObjectLookup): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge-base of two commits: BFS from `a`, then BFS from `b` for the first hit. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const seenB = new Set<string>();
  const queueB = [b];
  while (queueB.length) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a tree (recursively) into path → entry. Gitlinks are kept opaque. */
export function flattenTree(treeOid: string, lookup: ObjectLookup, out = new Map<string, FlatEntry>(), prefix = ''): Map<string, FlatEntry> {
  const object = lookup(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(entry.oid, lookup, out, path);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Build nested tree objects from a flat path map, storing each object through `put`.
 * Returns the root tree oid. An empty map yields the empty tree.
 */
export function buildTreeFromMap(
  flat: ReadonlyMap<string, FlatEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** Split content into lines the way git counts them (a trailing newline ends the last line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** LCS-based added/deleted line counts between two blobs; heuristic for very large files. */
export function diffLineCounts(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  if (a.equals(b)) return { additions: 0, deletions: 0 };
  const aLines = splitLines(a.toString('utf8'));
  const bLines = splitLines(b.toString('utf8'));
  if (aLines.length * bLines.length > 9000000) {
    return { additions: bLines.length, deletions: aLines.length };
  }
  let prev = new Uint32Array(bLines.length + 1);
  let curr = new Uint32Array(bLines.length + 1);
  for (let i = 1; i <= aLines.length; i += 1) {
    for (let j = 1; j <= bLines.length; j += 1) {
      curr[j] = aLines[i - 1] === bLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[bLines.length];
  return { additions: bLines.length - lcs, deletions: aLines.length - lcs };
}

export interface DiffFile {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** Diff two flat trees; entries sorted by path. Blob bytes come from `lookup`. */
export function diffTrees(
  before: ReadonlyMap<string, FlatEntry>,
  after: ReadonlyMap<string, FlatEntry>,
  lookup: ObjectLookup,
): DiffFile[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: DiffFile[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && !newEntry) {
      const oldData = lookup(oldEntry.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'removed', additions: 0, deletions: splitLines(oldData.toString('utf8')).length, oldOid: oldEntry.oid, newOid: null });
    } else if (!oldEntry && newEntry) {
      const newData = lookup(newEntry.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'added', additions: splitLines(newData.toString('utf8')).length, deletions: 0, oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry && newEntry && (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode)) {
      const oldData = lookup(oldEntry.oid)?.data ?? Buffer.alloc(0);
      const newData = lookup(newEntry.oid)?.data ?? Buffer.alloc(0);
      const counts = diffLineCounts(oldData, newData);
      out.push({ path, status: 'modified', ...counts, oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/**
 * Three-way merge of flat trees. Returns the merged map, or the conflicting paths
 * when both sides changed the same path differently.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): { merged: Map<string, FlatEntry> | null; conflicts: string[] } {
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let winner: FlatEntry | undefined;
    if (same(o, t)) winner = o;
    else if (same(o, b)) winner = t;
    else if (same(t, b)) winner = o;
    else {
      conflicts.push(path);
      continue;
    }
    if (winner !== undefined) merged.set(path, winner);
  }
  return { merged: conflicts.length ? null : merged, conflicts };
}

export interface CommitListEntry {
  readonly oid: string;
  readonly commit: CommitView;
  readonly timestamp: number;
}

/** Commits reachable from `tip`, newest first (committer time desc, discovery order breaks ties). */
export function listCommits(tip: string, lookup: ObjectLookup): CommitListEntry[] {
  const seen = new Set<string>();
  const order: CommitListEntry[] = [];
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const match = / (\d+) [+-]\d{4}$/.exec(commit.committer.trim());
    order.push({ oid, commit, timestamp: match ? Number(match[1]) : 0 });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
  }
  return order
    .map((entry, index) => ({ entry, index }))
    .sort((x, y) => y.entry.timestamp - x.entry.timestamp || x.index - y.index)
    .map(({ entry }) => entry);
}
