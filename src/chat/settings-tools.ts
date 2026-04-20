// Settings-management tools for the chat REPL. These let the human
// ask the agent to change local harness config in plain language:
// "switch to claude-sonnet-4-6", "dial the cadence up to 2 hours",
// "turn off follows for now", "sync the solution-architect skill".
// Each tool hits the settings HTTP API that's already bound on
// localhost by the REPL (same URL the web page uses) and renders
// an inline dim-italic thought-line the same way post/follow/endorse
// do.
//
// Explicitly NOT exposed:
//   - setKrawlerApiKey / setModelKey: keys pasted into chat could
//     leak via transcript / stdout / swap, so we route credential
//     management only through the web UI. The agent tells the
//     human "paste it at http://127.0.0.1:8717/" when asked.
//   - kill / rotate / delete: destructive one-way ops that warrant
//     a web-UI confirmation, not a chat nudge.
//   - startHeartbeat / stopHeartbeat: the REPL already fires the
//     idle-heartbeat; flipping it from chat would be confusing.
//
// The tools ALSO preserve agent autonomy (prime directive #1):
// they're the HUMAN asking the agent to help manage THEIR harness,
// which is a legitimate request. The autonomy principle only
// applies to krawler.com actions (post, follow, endorse).

import { tool } from 'ai';
import open from 'open';
import { z } from 'zod';

import type { ToolRenderHooks } from './tools.js';

// HTTP helper. Each tool call does a single request against the
// already-bound settings server, which is on the same host as the
// chat REPL. Non-2xx responses surface as tool errors so the model
// sees the failure and can explain it to the human.
async function hit(
  settingsUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(settingsUrl.replace(/\/+$/, '') + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text.length ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>) && String((data as { error: unknown }).error)) ||
      res.statusText;
    throw new Error(`${method} ${path} ${res.status}: ${msg}`);
  }
  return data;
}

export function buildSettingsTools(settingsUrl: string, profile: string, hooks: ToolRenderHooks) {
  // Caller is responsible for only invoking this when settingsUrl
  // is non-null (the REPL skips the call entirely when the local
  // settings server didn't bind). Keeping the signature non-nullable
  // lets TS infer a stable, narrow ToolSet type at the call site.

  const qs = (path: string) => path + (path.includes('?') ? '&' : '?') + `profile=${encodeURIComponent(profile)}`;

  return {
    getConfig: tool({
      description: 'Read the current harness config (redacted; keys are masked). Use when the human asks "what model am I on?" or "what\'s my cadence?" so you answer from live config instead of memory.',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('getConfig', 'reading harness config');
        try {
          const r = await hit(settingsUrl, 'GET', qs('/api/config')) as { config: Record<string, unknown> } | null;
          hooks.onToolEnd('getConfig', 'ok', true);
          return r?.config ?? {};
        } catch (e) {
          hooks.onToolEnd('getConfig', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setProvider: tool({
      description: 'Change the model provider for this agent. Valid values: anthropic, openai, google, openrouter, ollama. BEFORE calling this, confirm that the matching API key is already saved in the config (call getConfig first; look for has<Provider>ApiKey). If the key is NOT saved, refuse and tell the human to paste the key on the settings page first. Changing provider mid-session ends the current turn once the tool resolves.',
      inputSchema: z.object({
        provider: z.enum(['anthropic', 'openai', 'google', 'openrouter', 'ollama']),
      }),
      execute: async ({ provider }) => {
        hooks.onToolStart('setProvider', `switching provider to ${provider}`);
        try {
          await hit(settingsUrl, 'PATCH', qs('/api/config'), { provider });
          hooks.onToolEnd('setProvider', 'ok', true);
          return { ok: true, provider };
        } catch (e) {
          hooks.onToolEnd('setProvider', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setModel: tool({
      description: 'Change the model name for the current provider. Examples: "claude-sonnet-4-6" on anthropic, "anthropic/claude-opus-4-7" on openrouter, "gpt-4o" on openai. The model slug must be valid for the provider; a wrong one fails the next cycle.',
      inputSchema: z.object({
        model: z.string().min(1).max(120),
      }),
      execute: async ({ model }) => {
        hooks.onToolStart('setModel', `setting model to ${model}`);
        try {
          await hit(settingsUrl, 'PATCH', qs('/api/config'), { model });
          hooks.onToolEnd('setModel', 'ok', true);
          return { ok: true, model };
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
          await hit(settingsUrl, 'PATCH', qs('/api/config'), { cadenceMinutes });
          hooks.onToolEnd('setCadence', 'ok', true);
          return { ok: true, cadenceMinutes };
        } catch (e) {
          hooks.onToolEnd('setCadence', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    setDryRun: tool({
      description: 'Toggle dry-run mode. When on, the daemon logs decisions but skips the actual Krawler API calls (no real posts, follows, endorses). Useful for testing prompt changes.',
      inputSchema: z.object({
        dryRun: z.boolean(),
      }),
      execute: async ({ dryRun }) => {
        hooks.onToolStart('setDryRun', `dry-run ${dryRun ? 'on' : 'off'}`);
        try {
          await hit(settingsUrl, 'PATCH', qs('/api/config'), { dryRun });
          hooks.onToolEnd('setDryRun', 'ok', true);
          return { ok: true, dryRun };
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
          const r = await hit(settingsUrl, 'GET', qs('/api/installed-skills')) as { skills: Array<Record<string, unknown>> };
          hooks.onToolEnd('listInstalledSkills', `ok (${r.skills?.length ?? 0})`, true);
          return r.skills ?? [];
        } catch (e) {
          hooks.onToolEnd('listInstalledSkills', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    syncInstalledSkill: tool({
      description: 'Re-pull an installed SKILL.md from its upstream origin and overwrite the local copy. Refuses if the local body has diverged (the reflection loop or the human edited it), unless force=true. When the human asks you to refresh a skill or pick up upstream changes, use this.',
      inputSchema: z.object({
        slug: z.string().min(1).max(120),
        force: z.boolean().optional(),
      }),
      execute: async ({ slug, force }) => {
        const label = force ? `re-syncing ${slug} (force)` : `re-syncing ${slug}`;
        hooks.onToolStart('syncInstalledSkill', label);
        try {
          const r = await hit(settingsUrl, 'POST', qs(`/api/installed-skills/${encodeURIComponent(slug)}/sync`), force ? { force: true } : {}) as { changed?: boolean; overwroteLocalEdits?: boolean };
          const outcome = r?.overwroteLocalEdits ? 'ok (overwrote local edits)' : r?.changed ? 'ok (body changed)' : 'ok (no changes)';
          hooks.onToolEnd('syncInstalledSkill', outcome, true);
          return { ok: true, ...r };
        } catch (e) {
          hooks.onToolEnd('syncInstalledSkill', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    listProfiles: tool({
      description: 'List every agent profile configured on this machine, each with its Krawler handle (or "(no key)" if unconfigured). Use to answer "what other agents do I have?" or "which profiles exist?".',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('listProfiles', 'listing profiles');
        try {
          const r = await hit(settingsUrl, 'GET', '/api/profiles') as { profiles: Array<Record<string, unknown>> };
          hooks.onToolEnd('listProfiles', `ok (${r.profiles?.length ?? 0})`, true);
          return r.profiles ?? [];
        } catch (e) {
          hooks.onToolEnd('listProfiles', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),

    addProfile: tool({
      description: 'Create a new local profile slot for another Krawler agent and open the local settings page in the browser, scoped to the new profile, so the human can paste the new agent\'s Krawler key. The human still needs to spawn the Krawler agent on krawler.com/agents and paste its key; this tool only creates the local slot and opens the right page. Provider API keys (Anthropic / OpenAI / etc) are already shared across profiles, so the human usually only needs to paste the Krawler key.',
      inputSchema: z.object({}),
      execute: async () => {
        hooks.onToolStart('addProfile', 'creating new profile slot');
        try {
          const r = await hit(settingsUrl, 'POST', '/api/profiles') as { name: string };
          // Open the settings page on the new profile so the human
          // lands on the right form. Non-fatal: if the open() call
          // fails (headless box, no browser, SSH), the tool still
          // returns the profile name and the model can point the
          // human at the URL manually.
          const target = settingsUrl.replace(/\/+$/, '') + `/?profile=${encodeURIComponent(r.name)}`;
          let opened = false;
          try {
            await open(target);
            opened = true;
          } catch { /* silent; url is in the outcome */ }
          const outcome = opened
            ? `ok (${r.name}, opened ${target})`
            : `ok (${r.name}, open ${target} to paste the Krawler key)`;
          hooks.onToolEnd('addProfile', outcome, true);
          return { ...r, settingsUrl: target, opened };
        } catch (e) {
          hooks.onToolEnd('addProfile', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),
  };
}
