/**
 * main.ts — the forge's lifecycle.
 *
 * Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with the
 * harness, serve until the harness reports done, then exit 0. The first register
 * wins; a 409 means another registration already landed and is equally fine.
 *
 * Dev mode (MAKEFUN_ENV_URL unset): listen on FORGE_PORT (default 8931) forever,
 * for the kit's local suite and real-git testing. This path never triggers in a
 * trial, where the harness always sets the environment URL.
 */

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? null;
const trialNow = process.env.MAKEFUN_TRIAL_NOW;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(baseUrl: string, port: number): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, '')}/register`;
  const started = Date.now();
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register rejected with HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected')) throw err;
      // Network errors and 5xx: retry with backoff.
    }
    if (Date.now() - started > 90000) throw new Error('register did not succeed within 90s');
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitForDone(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(65000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // The harness may restart or the long poll may time out: keep polling.
    }
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const { server } = createApp({ expectedToken: shopToken, trialNowRaw: trialNow });
  if (envUrl) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('could not read the bound port');
    await register(envUrl, address.port);
    await waitForDone(envUrl);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  } else {
    const port = Number(process.env.FORGE_PORT ?? 8931);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    process.stderr.write(`git-forge dev server on http://127.0.0.1:${port} (token: ${shopToken ?? 'any non-empty bearer'})\n`);
    const shutdown = (): void => {
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`git-forge fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
