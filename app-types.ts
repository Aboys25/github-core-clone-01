/**
 * app-types.ts — the context every handler receives. Kept separate so git/rest/
 * graphql/mcp modules can share it without importing the HTTP server.
 */

import type { Store } from './store.ts';
import type { ScenarioUser } from './scenario.ts';

export interface ForgeContext {
  readonly store: Store;
  readonly viewer: ScenarioUser;
  readonly nowSec: number;
  readonly nowIso: string;
}
