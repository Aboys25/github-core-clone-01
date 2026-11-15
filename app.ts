/**
 * app.ts — the HTTP server: routing, auth, JSON plumbing, and the git endpoints.
 *
 * Auth: Authorization: Bearer <MAKEFUN_SHOP_TOKEN> (exact match when the token is
 * set; any non-empty bearer when it is not, for local runs). /healthz takes no
 * auth. Every JSON reply carries application/json + a non-empty
 * X-GitHub-Request-Id; unknown routes are JSON 404s, never HTML. Bodies are
 * buffered whole and answered with Content-Length so keep-alive stays cheap.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitHttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { RestRequest } from './rest.ts';
import { Store } from './store.ts';
import type { ForgeContext } from './app-types.ts';
import { VIEWER } from './scenario.ts';
import { isRecord, parseTrialTime } from './util.ts';

const JSON_CT = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

export interface AppConfig {
  /** Expected bearer token, or null to accept any non-empty bearer (local runs). */
  readonly expectedToken: string | null;
  readonly trialNowRaw: string | undefined;
}

export interface App {
  readonly server: Server;
  readonly context: ForgeContext;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = body === null && status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': JSON_CT,
    'Content-Length': payload.length,
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkAuth(req: IncomingMessage, expectedToken: string | null): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^(?:Bearer|token)\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  if (expectedToken === null) return match[1].length > 0;
  return match[1] === expectedToken;
}

interface RouteInfo {
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly host: string;
}

function parseRoute(req: IncomingMessage): RouteInfo {
  const host = req.headers.host ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const segments = pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { segments, query: url.searchParams, host };
}

export function createApp(config: AppConfig): App {
  const trialTime = parseTrialTime(config.trialNowRaw);
  const context: ForgeContext = {
    store: new Store(),
    viewer: VIEWER,
    nowSec: trialTime.sec,
    nowIso: trialTime.iso,
  };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      try {
        const route = parseRoute(req);
        const { segments } = route;

        // Health: no auth, always 200.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isApi =
          (segments[0] === 'api' && (segments[1] === 'v3' || segments[1] === 'graphql')) ||
          segments[0] === 'mcp' ||
          (segments.length >= 2 && segments[1]?.endsWith('.git'));
        if (!isApi) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!checkAuth(req, config.expectedToken)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          let body: Record<string, unknown> | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                if (!isRecord(parsed)) {
                  sendJson(res, 400, { message: 'Request body must be a JSON object' });
                  return;
                }
                body = parsed;
              } catch {
                sendJson(res, 400, { message: 'Malformed JSON body' });
                return;
              }
            }
          }
          const restReq: RestRequest = { method, segments: restSegments, query: route.query, body, host: route.host };
          const result = handleRest(context, restReq);
          sendJson(res, result.status, result.body, result.headers);
          return;
        }

        // GraphQL.
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          if (raw.length === 0) {
            sendJson(res, 400, { data: null, errors: [{ message: 'Must provide query string.' }] });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { data: null, errors: [{ message: 'Malformed JSON body.' }] });
            return;
          }
          const result = handleGraphQL(context, parsed);
          sendJson(res, 200, result.body);
          return;
        }

        // MCP.
        if (segments[0] === 'mcp' && segments.length === 1) {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(context, raw.toString('utf8'));
          if (result.status === 202) {
            res.writeHead(202, {
              'Content-Length': 0,
              'MCP-Protocol-Version': '2026-07-28',
              'X-GitHub-Request-Id': nextRequestId(),
            });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, { 'MCP-Protocol-Version': '2026-07-28' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
        if (segments.length >= 3 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          const repo = owner === context.viewer.login ? context.store.getRepo(owner, repoName) : undefined;
          const endpoint = segments.slice(2).join('/');
          if (method === 'GET' && endpoint === 'info/refs') {
            const service = route.query.get('service');
            const result = handleInfoRefs(context, repo, service, req.headers['git-protocol'] ?? null);
            if ('message' in result) {
              sendJson(res, result.status, { message: result.message });
              return;
            }
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && endpoint === 'git-upload-pack') {
            const raw = await readBody(req);
            const result = handleUploadPack(context, repo, raw);
            if ('message' in result) {
              sendJson(res, result.status, { message: result.message });
              return;
            }
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && endpoint === 'git-receive-pack') {
            const raw = await readBody(req);
            const result = handleReceivePack(context, repo, raw);
            if ('message' in result) {
              sendJson(res, result.status, { message: result.message });
              return;
            }
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash, never HTML: a 500 JSON keeps the suite (and the trial) alive.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
          else res.end();
        } catch {
          try {
            res.end();
          } catch {
            /* socket already gone */
          }
        }
      }
    })();
  });

  return { server, context };
}
