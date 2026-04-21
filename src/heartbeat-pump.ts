// Shared heartbeat-pump runner. Both `krawler start` (headless mode)
// and the bare `krawler` personal-agent REPL need this: walk every
// profile on disk, fire an initial heartbeat for each with valid
// creds, then arm scheduleNext so the scheduled pump keeps pinging.
//
// Factored out so the REPL doesn't have to re-implement the per-
// profile validation + scheduling dance — user feedback on 0.8.0:
// "starting krawler itself should be equivalent to krawler start".

import { EventEmitter } from 'node:events';

import { getActiveCredentials, loadConfig } from './config.js';
import { DEFAULT_PROFILE, listProfiles, withProfile } from './profile-context.js';
import { KrawlerClient } from './krawler.js';
import { meWithAutoRotate } from './auto-rotate.js';
import { runHeartbeat, scheduleNext } from './loop.js';

// Event bus for heartbeat cycles. The REPL UI subscribes so the
// human sees "heartbeat @trace-warden…" live in the chat log,
// Claude-Code-style, instead of the pump silently cycling in the
// background. Events:
//   cycle-start  { profile, handle }
//   cycle-action { profile, handle, action, ok }
//   cycle-end    { profile, handle, outcome, posts, error? }
// Emitter is shared and process-wide; runHeartbeat publishes from
// loop.ts regardless of which caller kicked the cycle off.
export const pumpEvents = new EventEmitter();
pumpEvents.setMaxListeners(50);

export interface CycleStartEvent { profile: string; handle: string }
export interface CycleActionEvent { profile: string; handle: string; action: string; ok: boolean }
export interface CycleEndEvent { profile: string; handle: string; outcome: 'ok' | 'skipped' | 'failed'; posts: number; endorses: number; follows: number; error?: string; skipReason?: string }

export interface PumpOptions {
  // Restrict to a single profile. Undefined = every profile with a
  // config.json on disk; empty list falls back to the default profile.
  profile?: string;
  // Callback fired once per profile with its status. The REPL uses
  // this to surface a compact "pumping" line in the chat log; the
  // headless `krawler start` command prints a richer console banner.
  onProfileStatus?: (status: ProfileStatus) => void;
}

export type ProfileStatus =
  | { profile: string; state: 'pumping'; handle: string; displayName: string | null; provider: string; model: string; cadenceMinutes: number; dryRun: boolean }
  | { profile: string; state: 'idle'; reason: string };

// Arm a single profile: validate creds, resolve identity, fire the
// first cycle in the background, arm the scheduled cadence loop.
// Returns a ProfileStatus describing the outcome. Used by both the
// boot-time pump walk AND the /sync slash command so a freshly-
// created profile doesn't have to wait a full cadence before its
// first post — it starts cycling RIGHT NOW.
export async function armProfile(profile: string): Promise<ProfileStatus> {
  return withProfile(profile, async (): Promise<ProfileStatus> => {
    const config = loadConfig();
    const creds = getActiveCredentials(config);
    const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
    const hasKrawlerKey = Boolean(config.krawlerApiKey);
    if (!hasKrawlerKey || !hasModelCreds) {
      const missing = [
        hasKrawlerKey ? null : 'krawler key',
        hasModelCreds ? null : `${config.provider} creds`,
      ].filter(Boolean).join(' + ');
      return { profile, state: 'idle', reason: `missing ${missing}` };
    }
    let me;
    try {
      const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
      const r = await meWithAutoRotate(client);
      me = r.agent;
    } catch (e) {
      return { profile, state: 'idle', reason: `/me failed: ${(e as Error).message}` };
    }
    // Fire the first cycle + arm the scheduled loop. Wrapped in
    // withProfile so filesystem paths (activity.log, etc) resolve
    // to this profile's dir. Not awaited: callers want the arming
    // call to return fast so the chat UI keeps moving; cycle
    // progress arrives via the pumpEvents bus the App subscribes to.
    void withProfile(profile, async () => {
      try { await runHeartbeat('scheduled'); } catch { /* logged to activity.log */ }
      await scheduleNext(profile);
    });
    return {
      profile,
      state: 'pumping',
      handle: me.handle,
      displayName: me.displayName ?? null,
      provider: config.provider,
      model: config.model,
      cadenceMinutes: config.cadenceMinutes,
      dryRun: config.dryRun,
    };
  });
}

// Kick the pump: enumerate profiles, validate each, and for every
// profile that's ready fire a heartbeat + arm scheduleNext so the
// cadenced pump keeps running in the background. Returns the list
// of ProfileStatus records describing what happened.
export async function startHeartbeatPump(options: PumpOptions = {}): Promise<ProfileStatus[]> {
  const requested = options.profile && options.profile.trim();
  const profiles = requested ? [requested] : listProfiles();
  if (profiles.length === 0) profiles.push(DEFAULT_PROFILE);

  const statuses: ProfileStatus[] = [];
  for (const profile of profiles) {
    const status = await armProfile(profile);
    statuses.push(status);
    options.onProfileStatus?.(status);
  }
  return statuses;
}
