import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROVIDERS, getInstalledSkillsDir, loadConfig, readActivityLog, redactConfig, saveConfig } from './config.js';
import type { Provider } from './config.js';
import { validateKrawlerKey, validateProviderCredential } from './credentials.js';
import { DEFAULT_PROFILE, PROFILE_ROOT, listProfiles, profileDir, withProfile } from './profile-context.js';
import { KrawlerClient } from './krawler.js';
import { MODEL_SUGGESTIONS } from './model.js';
import { runHeartbeat, stopSchedule } from './loop.js';
import { startGateway } from './gateway.js';
import { listInstalledSkills, rawUrlForSkill } from './skill-refs.js';
import { rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const updateConfigSchema = z.object({
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  googleApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  ollamaBaseUrl: z.string().url().optional(),
  krawlerApiKey: z.string().optional(),
  krawlerBaseUrl: z.string().url().optional(),
  cadenceMinutes: z.number().int().min(5).max(24 * 60).optional(),
  dryRun: z.boolean().optional(),
  reflection: z.object({ enabled: z.boolean() }).optional(),
});

// Local settings server. Scope is intentionally narrow: paste keys, switch
// provider, toggle dry-run, read who-am-I off krawler.com. Identity claiming,
// feed, activity, and start/pause all live elsewhere now (krawler.com for
// identity; the TTY process for lifecycle).
export async function buildServer() {
  const app = Fastify({
    logger: { level: 'warn' },
    disableRequestLogging: true,
    // Tear idle keep-alive sockets down on close() so Ctrl+C in the CLI is
    // prompt even if a browser tab is still open pointing at the settings page.
    forceCloseConnections: true,
  });

  // Serve the settings HTML/JS. In dev (tsx), __dirname is src/; in a
  // published install it's dist/. Both sit one level above web/.
  const webRoot = resolve(__dirname, '..', 'web');
  await app.register(fastifyStatic, { root: webRoot, prefix: '/', decorateReply: false });

  // Which profile does this request target? ?profile=<name> query param
  // selects a specific profile; omitted falls back to the default so
  // the existing single-profile UI keeps working unchanged. Every
  // handler that reads/writes config wraps its body in withProfile()
  // so loadConfig / saveConfig resolve to the right files.
  const profileOf = (req: { query: unknown }): string => {
    const q = (req.query ?? {}) as { profile?: string };
    const name = (q.profile || '').trim();
    return name || DEFAULT_PROFILE;
  };

  // List every configured profile with enough info to label the
  // switcher by what the human actually cares about: the Krawler handle
  // that profile is configured for. The profile NAME is an internal
  // directory key (default, agent-2, ...), NOT something the human
  // should have to think about. The dropdown renders by handle; the
  // name is just the stable id we thread through ?profile= on API
  // calls.
  //
  // Each entry:
  //   name         the profile directory name (stable, internal)
  //   hasKey       does config.json have a Krawler key pasted?
  //   handle       GET /me handle if the key resolves, else null
  //   displayName  GET /me displayName if the key resolves, else null
  //   placeholder  true if handle still matches /^agent-[0-9a-f]{8}$/
  //                (identity not yet claimed on first heartbeat)
  app.get('/api/profiles', async () => {
    const names = listProfiles();
    if (!names.includes(DEFAULT_PROFILE)) names.unshift(DEFAULT_PROFILE);
    const profiles = await Promise.all(names.map(async (name) => {
      return withProfile(name, async () => {
        const config = loadConfig();
        const hasKey = Boolean(config.krawlerApiKey);
        const creds = config.provider === 'ollama'
          ? Boolean(config.ollamaBaseUrl)
          : Boolean(
              config.provider === 'anthropic' ? config.anthropicApiKey :
              config.provider === 'openai' ? config.openaiApiKey :
              config.provider === 'google' ? config.googleApiKey :
              config.provider === 'openrouter' ? config.openrouterApiKey :
              '',
            );
        const base = {
          name,
          provider: config.provider,
          model: config.model,
          cadenceMinutes: config.cadenceMinutes,
          dryRun: config.dryRun,
          lastHeartbeat: config.lastHeartbeat ?? null,
          hasModelCreds: creds,
        };
        if (!hasKey) {
          return { ...base, hasKey: false, handle: null, displayName: null, avatarStyle: null, placeholder: false, meError: null };
        }
        try {
          const { agent } = await new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey).me();
          return {
            ...base,
            hasKey: true,
            handle: agent.handle,
            displayName: agent.displayName,
            avatarStyle: agent.avatarStyle ?? null,
            placeholder: /^agent-[0-9a-f]{8}$/.test(agent.handle),
            meError: null,
          };
        } catch (e) {
          // Surface the raw error so the dashboard pill can say what
          // actually happened ("key rejected (HTTP 401)", "DNS lookup
          // failed", etc.) instead of guessing "krawler.com unreachable"
          // for every non-2xx /me response. A wrong key is far more
          // common than an outage.
          return { ...base, hasKey: true, handle: null, displayName: null, avatarStyle: null, placeholder: false, meError: (e as Error).message };
        }
      });
    }));
    return { profiles };
  });

  // Create a new profile with an auto-generated name so the human
  // doesn't have to invent one. The profile name is an implementation
  // detail (a dir under ~/.config/krawler-agent/profiles/); the Krawler
  // handle is the real identity, and that lands on the profile when
  // the human pastes the key.
  //
  // Picks the smallest N such that "agent-N" is not already taken
  // (starts at 2 so "default" keeps its name as agent-1-ish). Returns
  // the chosen name so the client can switch to it.
  app.post('/api/profiles', async () => {
    const taken = new Set(listProfiles());
    taken.add(DEFAULT_PROFILE);
    let n = 2;
    while (taken.has(`agent-${n}`)) n++;
    const name = `agent-${n}`;
    // Server lazily creates the profile dir + config.json on first
    // withProfile() write. Trigger that here so /api/profiles sees
    // the new name on its next GET.
    withProfile(name, () => { saveConfig(loadConfig()); });
    return { name };
  });

  app.get('/api/config', async (req) => withProfile(profileOf(req), () => ({
    profile: profileOf(req),
    config: redactConfig(loadConfig()),
    modelSuggestions: MODEL_SUGGESTIONS,
  })));

  // Each secret-ish field maps to the provider we should probe against when
  // its value changes. ollamaBaseUrl uses the 'ollama' probe even though it
  // isn't a secret, because a wrong URL is just as broken as a wrong key.
  const FIELD_PROVIDER: Record<string, Provider> = {
    anthropicApiKey: 'anthropic',
    openaiApiKey: 'openai',
    googleApiKey: 'google',
    openrouterApiKey: 'openrouter',
    ollamaBaseUrl: 'ollama',
  };

  app.patch('/api/config', async (req, reply) => {
    const parsed = updateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'invalid body' };
    }
    const patch: Record<string, unknown> = { ...parsed.data };
    // Empty-string for a secret field means "clear it". Older clients
    // sometimes sent empty strings for untouched inputs and the server
    // defensively stripped them; the current dashboard only PATCHes fields
    // the user explicitly edited, so the strip is no longer needed and
    // would block the "Remove" button in the shared-keys pane.

    // Validate credentials the moment they land rather than letting a
    // typo sit in config.json until the next heartbeat silently fails.
    // Only fields whose value actually changed get probed (no point
    // re-hitting the provider on a no-op save).
    return withProfile(profileOf(req), async () => {
      const current = loadConfig();

      for (const [field, provider] of Object.entries(FIELD_PROVIDER)) {
        const next = patch[field];
        if (typeof next !== 'string' || !next.trim()) continue;
        const prev = (current as unknown as Record<string, string>)[field];
        if (next === prev) continue;
        const r = await validateProviderCredential(provider, next);
        if (!r.ok) {
          reply.code(400);
          return { error: `${field}: ${r.reason}`, validation: { field, provider, reason: r.reason } };
        }
      }

      if (typeof patch.krawlerApiKey === 'string' && patch.krawlerApiKey.trim() && patch.krawlerApiKey !== current.krawlerApiKey) {
        const effectiveBase = typeof patch.krawlerBaseUrl === 'string' && patch.krawlerBaseUrl.trim()
          ? patch.krawlerBaseUrl
          : current.krawlerBaseUrl;
        const r = await validateKrawlerKey(effectiveBase, patch.krawlerApiKey as string);
        if (!r.ok) {
          reply.code(400);
          return { error: `krawlerApiKey: ${r.reason}`, validation: { field: 'krawlerApiKey', provider: 'krawler', reason: r.reason } };
        }
      }

      const merged = { ...current, ...patch };
      saveConfig(merged);
      return { profile: profileOf(req), config: redactConfig(loadConfig()) };
    });
  });

  app.get('/api/log', async (req) => withProfile(profileOf(req), () => {
    const limit = Math.min(500, Math.max(1, Number((req.query as { limit?: string }).limit) || 200));
    return { profile: profileOf(req), log: readActivityLog(limit) };
  }));

  // Read-only "who is this key bound to on krawler.com" passthrough. Surfaces
  // handle + display name + placeholder flag so the settings page can show a
  // truthful identity header instead of duplicating state locally.
  app.get('/api/me', async (req) => withProfile(profileOf(req), async () => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      return { profile: profileOf(req), agent: null, placeholderHandle: false, reason: 'no-key' };
    }
    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
    try {
      const { agent } = await client.me();
      const placeholderHandle = /^agent-[0-9a-f]{8}$/.test(agent.handle);
      return { profile: profileOf(req), agent, placeholderHandle, reason: null };
    } catch (e) {
      return { profile: profileOf(req), agent: null, placeholderHandle: false, reason: (e as Error).message };
    }
  }));

  // Reveal the stored key over the loopback so the settings page can copy it
  // for use in other harnesses (OpenClaw, Hermes, your own). 127.0.0.1 + 0600
  // config file means the trust boundary is already crossed.
  app.get('/api/agent/reveal-key', async (req, reply) => withProfile(profileOf(req), () => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      reply.code(404);
      return { error: 'no Krawler key configured' };
    }
    return { profile: profileOf(req), key: config.krawlerApiKey };
  }));

  // Disconnect the local install from the Krawler agent. Clears the key
  // locally; the agent on krawler.com is untouched.
  app.delete('/api/agent', async (req) => withProfile(profileOf(req), () => {
    const config = loadConfig();
    saveConfig({ ...config, krawlerApiKey: '' });
    return { profile: profileOf(req), config: redactConfig(loadConfig()) };
  }));

  // Fire one heartbeat for this profile now and return the summary. The
  // scheduler is untouched (next cycle still fires on its own timer);
  // this is the "Heartbeat now" button in the agents table.
  app.post('/api/heartbeat', async (req, reply) => {
    const profile = profileOf(req);
    try {
      const result = await withProfile(profile, () => runHeartbeat('manual'));
      return { profile, ok: true, summary: result.summary };
    } catch (e) {
      reply.code(500);
      return { profile, ok: false, error: (e as Error).message };
    }
  });

  // Delete a profile directory, including its config.json, activity log,
  // chat history, installed skills, and playbooks. The Krawler agent on
  // krawler.com is untouched; the human can still spawn a new local
  // profile and paste the same key if they want to reconnect.
  //
  // The default profile is undeletable — it's the fallback every other
  // part of the agent runtime falls back to, and wiping ~/.config/krawler-agent/
  // would also take out shared-keys.json.
  app.delete('/api/profiles/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      reply.code(400);
      return { error: 'invalid profile name' };
    }
    if (name === DEFAULT_PROFILE) {
      reply.code(400);
      return { error: 'the default profile cannot be deleted' };
    }
    if (!listProfiles().includes(name)) {
      reply.code(404);
      return { error: `no profile named "${name}"` };
    }
    try { stopSchedule(name); } catch { /* ignore */ }
    const dir = profileDir(name);
    if (!dir.startsWith(PROFILE_ROOT + '/profiles/')) {
      // Belt-and-braces: never let a malformed name traverse outside the
      // profiles tree. profileDir() already scopes it, but double-check.
      reply.code(500);
      return { error: 'refused to delete outside profiles tree' };
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      reply.code(500);
      return { error: `rm failed: ${(e as Error).message}` };
    }
    return { ok: true, name };
  });

  // List the installed skills cached under this profile's dir. Returns
  // the full body of each so the settings page can show a read-only
  // viewer + Copy-body button. Drives the manual PR-back flow: the
  // reflection loop evolves bodies over time, the human inspects via
  // this endpoint, copies the text, and opens a PR by hand upstream.
  app.get('/api/installed-skills', async (req) => withProfile(profileOf(req), () => {
    const stats = listInstalledSkills();
    const skills = stats.map((s) => {
      const bodyPath = join(getInstalledSkillsDir(), s.slug, 'SKILL.md');
      let body = '';
      try { body = readFileSync(bodyPath, 'utf8'); } catch { /* ignore */ }
      return {
        slug: s.slug,
        origin: s.meta?.origin ?? null,
        title: s.meta?.title ?? null,
        path: s.meta?.path ?? null,
        installedAt: s.meta?.installedAt ?? null,
        lastSyncedAt: s.meta?.lastSyncedAt ?? null,
        edited: s.edited,
        bodyBytes: s.bodyBytes,
        body,
      };
    });
    return { profile: profileOf(req), skills };
  }));

  // Re-pull an installed skill's body from its upstream origin URL and
  // overwrite the local copy. Refuses when the local copy has diverged
  // from the install-time hash unless force=true is passed. Updates
  // meta.json's lastSyncedAt + lastSyncHash on success. Same semantics
  // as the `krawler skill sync` CLI command; this is just the
  // settings-page surface.
  app.post('/api/installed-skills/:slug/sync', async (req, reply) => withProfile(profileOf(req), async () => {
    const { slug } = req.params as { slug: string };
    const { force } = (req.body as { force?: boolean } | null) ?? {};
    const dir = join(getInstalledSkillsDir(), slug);
    const bodyPath = join(dir, 'SKILL.md');
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(bodyPath) || !existsSync(metaPath)) {
      reply.code(404);
      return { error: `no installed skill with slug "${slug}"` };
    }
    let meta: {
      origin: string; title?: string; path?: string;
      installedAt: string; lastSyncedAt: string; lastSyncHash: string;
    };
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      reply.code(500);
      return { error: `meta.json for "${slug}" is unreadable` };
    }
    const body = readFileSync(bodyPath, 'utf8');
    const { createHash } = await import('node:crypto');
    const currentHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const diverged = currentHash !== meta.lastSyncHash;
    if (diverged && !force) {
      reply.code(409);
      return { error: `local copy has diverged from install-time body; pass force=true to overwrite`, diverged: true };
    }
    const raw = rawUrlForSkill(meta.origin);
    const res = await fetch(raw, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
    if (!res.ok) {
      reply.code(502);
      return { error: `upstream fetch failed: HTTP ${res.status}` };
    }
    const next = await res.text();
    const nextHash = createHash('sha256').update(next).digest('hex').slice(0, 16);
    writeFileSync(bodyPath, next, { mode: 0o600 });
    const newMeta = { ...meta, lastSyncedAt: new Date().toISOString(), lastSyncHash: nextHash };
    writeFileSync(metaPath, JSON.stringify(newMeta, null, 2) + '\n', { mode: 0o600 });
    return { profile: profileOf(req), ok: true, changed: nextHash !== currentHash, overwroteLocalEdits: diverged };
  }));

  // Start the v1.0 gateway (channel-driven tool loop) when a channel has creds.
  // The legacy cadenced loop is owned by the CLI process directly (see cli.ts);
  // this stays here because the gateway's lifetime is already server-scoped.
  const bootConfig = loadConfig();
  if (!bootConfig.legacyHeartbeat || Object.values(bootConfig.channels).some((c) => 'botToken' in c && c.botToken)) {
    startGateway().catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[server] gateway boot failed:', (e as Error).message);
    });
  }

  return app;
}
