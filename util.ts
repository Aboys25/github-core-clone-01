/**
 * util.ts — trial time, opaque global ids, and small shared helpers.
 *
 * Determinism rule: MAKEFUN_TRIAL_NOW is the only "now" anything may carry.
 * It is parsed once at startup; every timestamp the forge emits derives from it.
 */

import { SCENARIO_EPOCH_SEC } from './scenario.ts';

export interface TrialTime {
  /** Unix seconds. */
  readonly sec: number;
  /** RFC 3339 form, for created_at / updated_at / merged_at. */
  readonly iso: string;
}

/** Parse MAKEFUN_TRIAL_NOW (RFC 3339 or epoch milliseconds); fall back to the scenario epoch. */
export function parseTrialTime(raw: string | undefined): TrialTime {
  let ms = NaN;
  if (raw !== undefined && raw !== '') {
    if (/^-?\d+$/.test(raw.trim())) ms = Number(raw.trim());
    else ms = Date.parse(raw.trim());
  }
  if (!Number.isFinite(ms)) ms = SCENARIO_EPOCH_SEC * 1000;
  const sec = Math.floor(ms / 1000);
  return { sec, iso: new Date(sec * 1000).toISOString() };
}

/** An opaque, stable, decodable Relay-style global id: base64 of "Kind:part:part". */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id made by globalId(); null when the shape is wrong. */
export function parseGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text || /[\u0000-\u001f]/.test(text)) return null;
  const segments = text.split(':');
  if (segments.length < 2) return null;
  // Re-encoding must round-trip, so random strings do not decode into phantom ids.
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  return { kind: segments[0], parts: segments.slice(1) };
}

/** True for a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string field, or a default when it is missing or not a string. */
export function stringField(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

/** Parse "Name <email> 1700000000 +0000" identity lines. */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number; tz: string } {
  const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line, email: '', timestamp: 0, tz: '+0000' };
  return { name: match[1], email: match[2], timestamp: Number(match[3]), tz: match[4] };
}

/** "Name <email> ts +0000" for a commit/tag header. */
export function formatIdentity(name: string, email: string, timestamp: number): string {
  return `${name} <${email}> ${timestamp} +0000`;
}

/**
 * git check-ref-format subset for full ref names ("refs/heads/x"). Rejects
 * control characters (including newlines — a stored name reaches the raw
 * protocol advertisement verbatim), spaces, ~ ^ : ? * [ \, "..", "@{",
 * leading/trailing slashes, empty components, components starting with ".",
 * and components ending with ".lock". A name with no slash is not a ref.
 */
export function isValidRefName(name: string): boolean {
  if (name === '' || name === '@') return false;
  if (!name.includes('/')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
    const ch = name[i];
    if (ch === '~' || ch === '^' || ch === ':' || ch === '?' || ch === '*' || ch === '[' || ch === '\\') return false;
  }
  for (const component of name.split('/')) {
    if (component === '' || component.startsWith('.') || component.endsWith('.lock')) return false;
  }
  return true;
}

/** A short branch name is valid when refs/heads/<name> is a valid ref name. */
export function isValidBranchName(name: string): boolean {
  return name !== '' && isValidRefName(`refs/heads/${name}`);
}

/** Repository names: the rule REST has always enforced, shared with MCP. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Format a unix-seconds commit timestamp as RFC 3339; out-of-range values fall back to the epoch. */
export function formatCommitDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? '1970-01-01T00:00:00.000Z' : date.toISOString();
}
