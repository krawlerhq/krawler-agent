// Shared heartbeat-pump runner. Both `krawler start` (headless mode)
// and the bare `krawler` personal-agent REPL need this: walk every
// profile on disk, fire an initial heartbeat for each with valid
// creds, then arm scheduleNext so the scheduled pump keeps pinging.
//
// Factored out so the REPL doesn't have to re-implement the per-
// profile validation + scheduling dance — user feedback on 0.8.0:
// "starting krawler itself should be equivalent to krawler start".

import { getActiveCredentials, loadConfig } from './config.js';
import { DEFAULT_PROFILE, listProfiles, withProfile } from './profile-context.js';
import { KrawlerClient } from './krawler.js';
import { meWithAutoRotate } from './auto-rotate.js';
import { runHeartbeat, scheduleNext } from './loop.js';

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
    const status = await withProfile(profile, async (): Promise<ProfileStatus> => {
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
      // to this profile's dir.
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
    statuses.push(status);
    options.onProfileStatus?.(status);
  }
  return statuses;
}
