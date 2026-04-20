// Secondary-agent registry for the chat REPL. The REPL's "primary"
// agent is whichever profile the user launched with (default unless
// --profile was passed). Any OTHER profile on this machine is
// addressable as @<handle> inside the REPL buffer.
//
// This module is responsible for enumerating those other profiles on
// boot, building a driver + system prompt for each, and returning a
// map keyed by handle. Failures are swallowed (skip + warn) so a
// broken profile doesn't block the primary REPL from opening.

import { DEFAULT_PROFILE, listProfiles, withProfile } from '../profile-context.js';
import { getActiveCredentials, loadConfig } from '../config.js';
import { KrawlerClient } from '../krawler.js';
import { meWithAutoRotate } from '../auto-rotate.js';

import type { DriverDeps } from './ui/driver.js';

export interface AgentEntry {
  handle: string;
  displayName: string | null;
  profile: string;
  driver: DriverDeps;
  // System prompt is built lazily the first time this agent is addressed,
  // not on boot. Boot-time system-prompt builds call krawler.com for the
  // feed + activity log, which would add N round-trips for N-1 profiles
  // the user may never @-tag. We stash the factory here instead.
  buildSystem: () => Promise<string>;
}

export interface AgentRegistry {
  primaryProfile: string;
  // handle → entry for every OTHER profile than the primary. The
  // primary's own handle/driver already live in the App props from
  // repl.ts, so this map is strictly for @-routing targets.
  byHandle: Record<string, AgentEntry>;
}

// Build drivers for every profile EXCEPT the primary. The primary is
// built inline in repl.ts (it has its own waiting-for-creds loop,
// identity fetch error handling, prime-directives fetch). Secondaries
// fail soft: a profile with a stale key or a failed me() is dropped
// from the registry with a dim stderr warning, not fatal.
export async function buildSecondaryAgents(
  primaryProfile: string,
  buildSystemForProfile: (profile: string) => Promise<string>,
): Promise<AgentRegistry> {
  const all = listProfiles();
  // Ensure default is covered even if ~/.config/krawler-agent/config.json
  // doesn't exist yet (listProfiles already checks, but double-cover).
  if (!all.includes(DEFAULT_PROFILE)) all.unshift(DEFAULT_PROFILE);
  const others = all.filter((n) => n !== primaryProfile);
  const byHandle: Record<string, AgentEntry> = {};

  const settled = await Promise.allSettled(
    others.map((profile) =>
      withProfile(profile, async (): Promise<AgentEntry | null> => {
        const cfg = loadConfig();
        if (!cfg.krawlerApiKey) return null;
        const creds = getActiveCredentials(cfg);
        if (cfg.provider !== 'ollama' && !creds.apiKey) return null;
        const krawler = new KrawlerClient(cfg.krawlerBaseUrl, cfg.krawlerApiKey);
        const { agent: me } = await meWithAutoRotate(krawler);
        const driver: DriverDeps = {
          krawler,
          provider: cfg.provider,
          modelName: cfg.model,
          apiKey: creds.apiKey,
          ollamaBaseUrl: creds.baseUrl,
          settingsUrl: null,
          profileName: profile,
          // Placeholder — the actual string is built lazily via buildSystem
          // the first time this agent is addressed. Driver.runTurn overrides
          // `system` per invocation anyway.
          system: '',
        };
        return {
          handle: me.handle,
          displayName: me.displayName ?? null,
          profile,
          driver,
          buildSystem: () => withProfile(profile, () => buildSystemForProfile(profile)) as Promise<string>,
        };
      }),
    ),
  );

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const profile = others[i];
    if (!r || !profile) continue;
    if (r.status === 'rejected') {
      const DIM = '\u001b[2m';
      const RESET = '\u001b[0m';
      // eslint-disable-next-line no-console
      console.error(`  ${DIM}skipped profile "${profile}" — ${(r.reason as Error)?.message ?? r.reason}${RESET}`);
      continue;
    }
    if (r.value) byHandle[r.value.handle] = r.value;
  }

  return { primaryProfile, byHandle };
}
