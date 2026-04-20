// Auto-rotate the Krawler API key on 401 using the pair token stored in this
// profile (see `krawler pair` in cli-main.ts and the local-install pair flow
// on krawler.com).
//
// Why this lives in its own module: both the headless heartbeat loop
// (src/loop.ts) and the chat REPL (src/chat/repl.ts) call `client.me()`
// early and bail out if the call throws. Before this module existed, a 401
// on /me (stored key revoked on krawler.com, or rotated elsewhere) left
// the human to manually paste a new key. With a pair token on disk, we
// can detect the 401, call POST /me/keys/rotate-via-pair, write the new
// kra_live_ key into config.json, update the live KrawlerClient instance,
// and retry /me once — all without any human paste.
//
// Fail modes:
//   - No pair token on disk → surface the original 401 unchanged so the
//     dashboard shows the manual-rotate CTA ("Open krawler.com/agents").
//   - rotate-via-pair itself fails (token expired / revoked / agent
//     deleted) → log the reason, surface the original 401.
//   - Network error on retry → surface it.
//
// The `attemptAutoRotate` function returns { rotated: true, newKey } on
// success, { rotated: false, reason } otherwise. Callers decide how to
// render.

import type { Agent, KrawlerClient } from './krawler.js';
import { appendActivityLog, loadConfig, loadPairToken, saveConfig } from './config.js';

export interface AutoRotateResult {
  rotated: boolean;
  newKey?: string;
  reason?: string;
}

// Best-effort: read pair token, attempt rotate, persist new key. Caller
// passes the existing client so we can setKey on it in-place (so the
// client's next call uses the fresh key without a restart).
export async function attemptAutoRotate(client: KrawlerClient): Promise<AutoRotateResult> {
  const pair = loadPairToken();
  if (!pair) {
    return { rotated: false, reason: 'no pair token on this install' };
  }
  try {
    const { apiKey: newKey, handle } = await client.rotateViaPair(pair.token);
    // Persist to this profile's config.json. saveConfig merges so we don't
    // clobber provider or cadence. loadConfig + saveConfig both honour the
    // current profile context via AsyncLocalStorage, so this lands in the
    // right file for multi-profile installs.
    const cfg = loadConfig();
    saveConfig({ ...cfg, krawlerApiKey: newKey });
    // Keep the live client in sync so the caller's next .me() uses the
    // fresh key. Without this, caller would need to construct a new
    // KrawlerClient manually.
    client.setKey(newKey);
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `auto-rotated Krawler API key via pair token (agent @${handle})`,
    });
    return { rotated: true, newKey };
  } catch (e) {
    const reason = (e as Error).message;
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `auto-rotate via pair token failed: ${reason}`,
    });
    return { rotated: false, reason };
  }
}

// Convenience wrapper: try client.me(); on 401, attempt a rotate, retry once.
// Used in place of a bare client.me() anywhere that expects /me to succeed.
export async function meWithAutoRotate(client: KrawlerClient): Promise<{ agent: Agent }> {
  try {
    return await client.me();
  } catch (e) {
    const status = (e as Error & { status?: number }).status;
    if (status !== 401 && status !== 403) throw e;
    const result = await attemptAutoRotate(client);
    if (!result.rotated) throw e;
    // Retry once with the fresh key.
    return await client.me();
  }
}
