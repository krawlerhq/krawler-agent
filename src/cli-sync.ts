// Auto-sync platform agents → local profiles.
//
// After /login lands a user-level kcli_live_ token, the CLI knows
// who the human is and can ask krawler.com for their owned agents.
// For any agent without a matching local profile, we call the new
// POST /me/agents/:handle/keys/issue-for-cli endpoint, get a fresh
// kra_live_ key, and write ~/.config/krawler-agent/profiles/<handle>/
// config.json.
//
// Closes the loop from "spawned agent on krawler.com" to "agent is
// posting" without any manual key-pasting. The first iteration of
// this flow required the user to copy-paste each key into its own
// config.json by hand.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, normalizeModelForProvider } from './config.js';
import { KrawlerClient } from './krawler.js';
import { loadPersonalConfig } from './personal.js';
import { listProfiles, profileDir } from './profile-context.js';
import { armProfile } from './heartbeat-pump.js';
import type { UserAuth } from './auth.js';

export type SyncOutcome =
  | { profile: string; handle: string; state: 'created' }
  | { profile: string; handle: string; state: 'skipped'; reason: string }
  | { profile: string; handle: string; state: 'failed'; reason: string };

// Profiles don't have to be named after their handle — but the sync
// creates new ones with handle as the dir name so the mapping is
// obvious. To decide whether an agent already has a local profile,
// we load each existing profile's config.json and read its
// krawlerApiKey; if the agent-server has a matching key hash for
// that agent, the profile covers it. Simpler approach for this
// version: match by profile dir name == handle. Users who named
// their profiles something else still get a new profile with the
// handle name (duplicate local state; acceptable for now).
function hasProfileForHandle(handle: string): boolean {
  const existing = listProfiles();
  if (existing.includes(handle)) return true;
  // Also tolerate case-insensitive matches.
  return existing.some((p) => p.toLowerCase() === handle.toLowerCase());
}

// Write a minimal config.json for a freshly-synced agent. Inherits
// provider + model from the personal agent so the new agent uses
// whichever model the human is already using (normalised to the
// slug shape the provider serves).
function writeProfileConfig(profile: string, apiKey: string): void {
  const personal = loadPersonalConfig();
  const effectiveModel = normalizeModelForProvider(personal.provider, personal.model);
  const base = loadConfig();
  const dir = profileDir(profile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'config.json');
  const cfg = {
    provider: personal.provider,
    model: effectiveModel,
    krawlerApiKey: apiKey,
    krawlerBaseUrl: base.krawlerBaseUrl || 'https://krawler.com/api',
    cadenceMinutes: 10,
    behaviors: { post: true, endorse: true, follow: true },
    dryRun: false,
    legacyHeartbeat: true,
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// Walk the user's owned agents, create local profiles for any that
// don't have one yet. Returns per-agent outcomes the caller can
// surface to the chat log. Dead / banned agents are skipped with
// a reason; already-local agents are skipped too. A failure on
// one agent doesn't abort the rest.
export async function syncPlatformAgents(
  auth: UserAuth,
  onStep?: (outcome: SyncOutcome) => void,
): Promise<SyncOutcome[]> {
  const base = loadConfig().krawlerBaseUrl || 'https://krawler.com/api';
  const client = new KrawlerClient(base, '');
  const list = await client.listMyAgents(auth.token);
  const outcomes: SyncOutcome[] = [];
  for (const a of list.agents) {
    if (a.status === 'dead') {
      const o: SyncOutcome = { profile: a.handle, handle: a.handle, state: 'skipped', reason: 'agent is dead' };
      outcomes.push(o); onStep?.(o); continue;
    }
    if (a.status === 'banned') {
      const o: SyncOutcome = { profile: a.handle, handle: a.handle, state: 'skipped', reason: 'agent is banned' };
      outcomes.push(o); onStep?.(o); continue;
    }
    if (hasProfileForHandle(a.handle)) {
      // Profile exists locally but the in-process pump may not have
      // armed it yet — this is the common case when /sync runs after
      // the user spawned an agent on krawler.com and the krawler CLI
      // was already running (boot-time pump walked the old profile
      // list). Await armProfile so the /sync log surfaces the ACTUAL
      // outcome (was 'kicked a cycle' unconditionally through 0.12.9,
      // which silently lied when armProfile's pre-flight rejected
      // missing creds — user saw green log lines but the dashboard
      // kept showing "sleeping" because no heartbeat ever fired).
      let reason = 'already local';
      try {
        const status = await armProfile(a.handle);
        reason = status.state === 'pumping'
          ? 'already local \u2014 kicked a cycle'
          : `already local \u2014 cannot heartbeat (${status.reason}). Run /keys to add the missing key.`;
      } catch (e) {
        reason = `already local \u2014 arm failed: ${(e as Error).message}`;
      }
      const o: SyncOutcome = { profile: a.handle, handle: a.handle, state: 'skipped', reason };
      outcomes.push(o); onStep?.(o); continue;
    }
    try {
      const issued = await client.issueCliKey(auth.token, a.handle);
      writeProfileConfig(a.handle, issued.apiKey);
      // Fire the first cycle immediately so the human doesn't wait a
      // full cadence before the "Post for the first time" setup step
      // turns green. armProfile is non-blocking on runHeartbeat itself
      // (it kicks that in the background) but DOES await the creds +
      // /me checks, so awaiting it here tells us if the new profile
      // is ready to cycle. If not (e.g. no Anthropic key yet in
      // shared-keys.json), we emit a 'created' outcome with a reason
      // suffix so the human knows the agent was created locally but
      // will sit idle until they add the missing key.
      let note = '';
      try {
        const status = await armProfile(a.handle);
        if (status.state !== 'pumping') {
          note = ` (cannot heartbeat yet: ${status.reason}. Run /keys to add the missing key.)`;
        }
      } catch { /* non-fatal — profile is still written */ }
      const o: SyncOutcome = note
        ? { profile: a.handle, handle: a.handle, state: 'skipped', reason: `created locally${note}` }
        : { profile: a.handle, handle: a.handle, state: 'created' };
      outcomes.push(o); onStep?.(o);
    } catch (e) {
      const o: SyncOutcome = { profile: a.handle, handle: a.handle, state: 'failed', reason: (e as Error).message };
      outcomes.push(o); onStep?.(o);
    }
  }
  return outcomes;
}
