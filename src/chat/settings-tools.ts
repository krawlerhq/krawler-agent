// Settings-management tools for the chat REPL. These let the human
// ask the agent to change harness config in plain language:
// "switch to claude-sonnet-4-6", "dial the cadence up to 2 hours",
// "turn off follows for now", "sync the solution-architect skill".
//
// Pre-0.6 these hit a localhost HTTP server running alongside the
// chat REPL (the local dashboard). 0.6 removes the local dashboard
// entirely; these tools now call the same code the old HTTP routes
// called, and additionally PATCH the server's runtime config when the
// install has a pair token on disk. Provider API keys stay local.
//
// Explicitly NOT exposed:
//   - setKrawlerApiKey / setModelKey: keys pasted into chat could leak
//     via transcript / stdout / swap, so we route credential management
//     through config.json + `krawler login` only.
//   - kill / rotate / delete: destructive one-way ops warrant a deliberate
//     CLI call, not a chat nudge.

import { tool } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { getInstalledSkillsDir, loadConfig, loadPairToken, redactConfig, saveConfig } from '../config.js';
import { KrawlerClient } from '../krawler.js';
import { currentProfileName, listProfiles, profileDir, withProfile, DEFAULT_PROFILE } from '../profile-context.js';
import { listInstalledSkills as listRefs, rawUrlForSkill } from '../skill-refs.js';
import type { ToolRenderHooks } from './tools.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// Apply a runtime patch. Server-first when the install is paired
// (so other linked installs pick up the change on their next cycle);
// local-fallback when unpaired. Returns a small outcome string so the
// tool render line names where the change landed.
async function applyRuntimePatch(profile: string, patch: Record<string, unknown>): Promise<'server' | 'local'> {
  return withProfile(profile, async () => {
    const pair = loadPairToken();
    if (pair && pair.handle) {
      const config = loadConfig();
      const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey ?? '');
      await client.patchRuntimeConfig(pair.token, pair.handle, patch);
      return 'server';
    }
    // Unpaired — legacy path, write to local config.json so the next
    // heartbeat still sees the change. Shape of `patch` maps 1:1 to
    // the local Config schema for provider/model/cadence/dryRun.
    const cfg = loadConfig();
    saveConfig({ ...cfg, ...patch });
    return 'local';
  });
}

export function buildSettingsTools(_settingsUrlIgnored: string | null, profile: string, hooks: ToolRenderHooks) {
  return {
    getConfig: tool({
      description: 'Read the current harness config (redacted; keys are masked). Use when the human asks "what model am I on?" or "what\'s my cadence?" so you answer from live config instead of memory.',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('getConfig', 'reading harness config');
        try {
          const config = withProfile(profile, () => redactConfig(loadConfig()));
          hooks.onToolEnd('getConfig', 'ok', true);
          return config;
        } catch (e) {
          hooks.onToolEnd('getConfig', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setProvider: tool({
      description: 'Change the model provider for this agent. Valid values: anthropic, openai, google, openrouter, ollama. Confirm the matching API key is saved first (call getConfig and look for has<Provider>ApiKey). If the install is linked to krawler.com, this updates server-side runtime config; otherwise it writes the local config.json.',
      inputSchema: z.object({
        provider: z.enum(['anthropic', 'openai', 'google', 'openrouter', 'ollama']),
      }),
      execute: async ({ provider }) => {
        hooks.onToolStart('setProvider', `switching provider to ${provider}`);
        try {
          const target = await applyRuntimePatch(profile, { provider });
          hooks.onToolEnd('setProvider', `ok (${target})`, true);
          return { ok: true, provider, target };
        } catch (e) {
          hooks.onToolEnd('setProvider', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setModel: tool({
      description: 'Change the model name for the current provider. Examples: "claude-sonnet-4-6" on anthropic, "anthropic/claude-opus-4-7" on openrouter, "gpt-4o" on openai. Invalid slugs fail the next cycle.',
      inputSchema: z.object({
        model: z.string().min(1).max(120),
      }),
      execute: async ({ model }) => {
        hooks.onToolStart('setModel', `setting model to ${model}`);
        try {
          const target = await applyRuntimePatch(profile, { model });
          hooks.onToolEnd('setModel', `ok (${target})`, true);
          return { ok: true, model, target };
        } catch (e) {
          hooks.onToolEnd('setModel', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setCadence: tool({
      description: 'Change how often the scheduled heartbeat fires in headless mode. Minutes between cycles. Valid 5..1440. Does NOT affect the chat-mode idle-heartbeat which is always 45s after user goes quiet.',
      inputSchema: z.object({
        cadenceMinutes: z.number().int().min(5).max(24 * 60),
      }),
      execute: async ({ cadenceMinutes }) => {
        hooks.onToolStart('setCadence', `heartbeat cadence: every ${cadenceMinutes} min`);
        try {
          const target = await applyRuntimePatch(profile, { cadenceMinutes });
          hooks.onToolEnd('setCadence', `ok (${target})`, true);
          return { ok: true, cadenceMinutes, target };
        } catch (e) {
          hooks.onToolEnd('setCadence', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setDryRun: tool({
      description: 'Toggle dry-run mode. When on, the agent logs decisions but skips the actual Krawler API calls (no real posts, follows, endorses). Useful for testing prompt changes.',
      inputSchema: z.object({
        dryRun: z.boolean(),
      }),
      execute: async ({ dryRun }) => {
        hooks.onToolStart('setDryRun', `dry-run ${dryRun ? 'on' : 'off'}`);
        try {
          const target = await applyRuntimePatch(profile, { dryRun });
          hooks.onToolEnd('setDryRun', `ok (${target})`, true);
          return { ok: true, dryRun, target };
        } catch (e) {
          hooks.onToolEnd('setDryRun', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    listInstalledSkills: tool({
      description: 'List every SKILL.md this agent has installed under its profile, with slug, origin url, body size, install time, and whether the local copy has diverged from the upstream (edited).',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('listInstalledSkills', 'listing installed skills');
        try {
          const stats = withProfile(profile, () => listRefs()) as ReturnType<typeof listRefs>;
          const out = stats.map((s) => ({
            slug: s.slug,
            origin: s.meta?.origin ?? null,
            title: s.meta?.title ?? null,
            path: s.meta?.path ?? null,
            installedAt: s.meta?.installedAt ?? null,
            lastSyncedAt: s.meta?.lastSyncedAt ?? null,
            edited: s.edited,
            bodyBytes: s.bodyBytes,
          }));
          hooks.onToolEnd('listInstalledSkills', `ok (${out.length})`, true);
          return out;
        } catch (e) {
          hooks.onToolEnd('listInstalledSkills', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    syncInstalledSkill: tool({
      description: 'Re-pull an installed SKILL.md from its upstream origin and overwrite the local copy. Refuses if the local body has diverged (the reflection loop or the human edited it), unless force=true.',
      inputSchema: z.object({
        slug: z.string().min(1).max(120),
        force: z.boolean().optional(),
      }),
      execute: async ({ slug, force }) => {
        const label = force ? `re-syncing ${slug} (force)` : `re-syncing ${slug}`;
        hooks.onToolStart('syncInstalledSkill', label);
        try {
          const result = await withProfile(profile, async () => {
            const dir = join(getInstalledSkillsDir(), slug);
            const bodyPath = join(dir, 'SKILL.md');
            const metaPath = join(dir, 'meta.json');
            if (!existsSync(bodyPath) || !existsSync(metaPath)) {
              throw new Error(`no installed skill with slug "${slug}"`);
            }
            const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
              origin: string; title?: string; path?: string;
              installedAt: string; lastSyncedAt: string; lastSyncHash: string;
            };
            const body = readFileSync(bodyPath, 'utf8');
            const currentHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
            const diverged = currentHash !== meta.lastSyncHash;
            if (diverged && !force) {
              throw new Error(`local copy has diverged; pass force=true to overwrite`);
            }
            const raw = rawUrlForSkill(meta.origin);
            const res = await fetch(raw, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
            if (!res.ok) throw new Error(`upstream fetch failed: HTTP ${res.status}`);
            const next = await res.text();
            const nextHash = createHash('sha256').update(next).digest('hex').slice(0, 16);
            writeFileSync(bodyPath, next, { mode: 0o600 });
            const newMeta = { ...meta, lastSyncedAt: new Date().toISOString(), lastSyncHash: nextHash };
            writeFileSync(metaPath, JSON.stringify(newMeta, null, 2) + '\n', { mode: 0o600 });
            return { changed: nextHash !== currentHash, overwroteLocalEdits: diverged };
          });
          const outcome = result.overwroteLocalEdits ? 'ok (overwrote local edits)' : result.changed ? 'ok (body changed)' : 'ok (no changes)';
          hooks.onToolEnd('syncInstalledSkill', outcome, true);
          return { ok: true, ...result };
        } catch (e) {
          hooks.onToolEnd('syncInstalledSkill', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    listProfiles: tool({
      description: 'List every agent profile configured on this machine by directory name. Use to answer "what other agents do I have?" or "which profiles exist?".',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('listProfiles', 'listing profiles');
        try {
          const names = listProfiles();
          if (!names.includes(DEFAULT_PROFILE)) names.unshift(DEFAULT_PROFILE);
          const out = names.map((name) =>
            withProfile(name, () => {
              const cfg = loadConfig();
              const pair = loadPairToken();
              return {
                name,
                hasKey: Boolean(cfg.krawlerApiKey),
                pairedHandle: pair?.handle ?? null,
              };
            }),
          );
          hooks.onToolEnd('listProfiles', `ok (${out.length})`, true);
          return out;
        } catch (e) {
          hooks.onToolEnd('listProfiles', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    addProfile: tool({
      description: 'Create a new local profile slot for another Krawler agent. Tells the human how to finish the setup (paste the Krawler agent key, then `krawler link --profile <name>`). Provider API keys are already shared across profiles on this machine.',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('addProfile', 'creating new profile slot');
        try {
          const taken = new Set(listProfiles());
          taken.add(DEFAULT_PROFILE);
          let n = 2;
          while (taken.has(`agent-${n}`)) n++;
          const name = `agent-${n}`;
          // Lazily create the profile dir by writing an empty config.json
          // in the target dir. withProfile() scopes all path helpers in
          // config.ts to this profile so saveConfig lands in the right
          // place.
          withProfile(name, () => {
            const dir = profileDir(name);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            saveConfig(loadConfig());
          });
          const hint = `New slot created at ~/.config/krawler-agent/profiles/${name}/. Next: paste the Krawler agent key from krawler.com/agents into ${name}'s config.json (or run \`krawler link --profile ${name}\` to pair without pasting).`;
          hooks.onToolEnd('addProfile', `ok (${name})`, true);
          return { name, hint };
        } catch (e) {
          hooks.onToolEnd('addProfile', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),
  };
}
