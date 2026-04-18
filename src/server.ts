import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { PROVIDERS, getActiveCredentials, loadConfig, readActivityLog, redactConfig, saveConfig } from './config.js';
import { KrawlerClient } from './krawler.js';
import { MODEL_SUGGESTIONS, pickIdentity } from './model.js';
import { pauseAgent, runHeartbeat, scheduleNext, startAgent } from './loop.js';
import { gatewayIsRunning, startGateway, stopGateway } from './gateway.js';
import { listRecentTurns } from './agent/trajectory.js';
import { countActiveFacts, listActiveFacts } from './user-model/facts.js';
import { getSkill, listSkills, refreshRegistry } from './skills/registry.js';
import { seedIfEmpty } from './skills/seed.js';

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
  behaviors: z
    .object({
      post: z.boolean().optional(),
      endorse: z.boolean().optional(),
      follow: z.boolean().optional(),
    })
    .optional(),
  dryRun: z.boolean().optional(),
});

export async function buildServer() {
  const app = Fastify({
    // Silence the per-request incoming/completed pair — dashboard polls
    // /api/config + /api/log every few seconds and that's the entire terminal
    // contents otherwise. Warn+error still print. The in-app Activity log has
    // everything a user actually cares about.
    logger: { level: 'warn' },
    disableRequestLogging: true,
  });

  // Serve the dashboard HTML/JS. In dev (tsx), __dirname is src/; in a
  // published install it's dist/. Both sit one level above web/.
  const webRoot = resolve(__dirname, '..', 'web');
  await app.register(fastifyStatic, { root: webRoot, prefix: '/', decorateReply: false });

  app.get('/api/config', async () => {
    return { config: redactConfig(loadConfig()), modelSuggestions: MODEL_SUGGESTIONS };
  });

  app.patch('/api/config', async (req, reply) => {
    const parsed = updateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'invalid body' };
    }
    // Empty-string keys mean "leave unchanged" — drop them before merging.
    const patch: Record<string, unknown> = { ...parsed.data };
    for (const k of ['anthropicApiKey', 'openaiApiKey', 'googleApiKey', 'openrouterApiKey', 'krawlerApiKey']) {
      if (patch[k] === '') delete patch[k];
    }
    const current = loadConfig();
    const merged = {
      ...current,
      ...patch,
      behaviors: { ...current.behaviors, ...((patch.behaviors as typeof current.behaviors) ?? {}) },
    };
    saveConfig(merged);
    return { config: redactConfig(loadConfig()) };
  });

  app.post('/api/start', async () => {
    startAgent();
    return { config: redactConfig(loadConfig()) };
  });

  app.post('/api/pause', async () => {
    pauseAgent();
    return { config: redactConfig(loadConfig()) };
  });

  app.post('/api/heartbeat/trigger', async () => {
    const r = await runHeartbeat('manual');
    return { ok: true, summary: r.summary, config: redactConfig(loadConfig()) };
  });

  app.get('/api/log', async (req) => {
    const limit = Math.min(500, Math.max(1, Number((req.query as { limit?: string }).limit) || 200));
    return { log: readActivityLog(limit) };
  });

  // Reboot the scheduler if the user persisted running=true before the
  // process restarted. When legacyHeartbeat is off this is a no-op.
  scheduleNext();

  // Start the v1.0 gateway (channel-driven tool loop) unless legacyHeartbeat
  // is the only driver the user has opted into. The gateway boots channels
  // that have creds; no creds = nothing to boot.
  const bootConfig = loadConfig();
  if (!bootConfig.legacyHeartbeat || Object.values(bootConfig.channels).some((c) => 'botToken' in c && c.botToken)) {
    startGateway().catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[server] gateway boot failed:', (e as Error).message);
    });
  }

  // --- v1.0 dashboard endpoints ---
  app.get('/api/trajectories', async (req) => {
    const q = req.query as { limit?: string; since?: string };
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 50));
    const sinceMs = q.since ? parseInt(q.since, 10) || 0 : 0;
    return { turns: listRecentTurns({ limit, sinceMs }) };
  });

  app.get('/api/user-model', async () => {
    return { count: countActiveFacts(), facts: listActiveFacts({ limit: 200 }) };
  });

  app.get('/api/skills', async () => {
    seedIfEmpty();
    await refreshRegistry({ embed: false });
    const skills = listSkills().map((s) => ({
      id: s.id,
      version: s.frontmatter.version,
      status: s.frontmatter.status,
      description: s.frontmatter.description,
      runs_total: s.meta.runs_total,
      avg_outcome_score: s.meta.avg_outcome_score,
      endorsements: s.frontmatter.reputation.endorsements,
    }));
    return { skills, gatewayRunning: gatewayIsRunning() };
  });

  // --- Krawler account tab ---
  //
  // Summary of the Krawler-side identity: /me (handle, display, bio, avatar)
  // plus a few recent posts from /feed. All authed by the stored kra_live_ key.
  // Returns 404-ish `{ agent: null }` shapes instead of throwing so the UI can
  // render an empty-state card without JS error handling.
  app.get('/api/agent/summary', async () => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      return { agent: null, recentPosts: [], placeholderHandle: false, reason: 'no-key' };
    }
    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
    try {
      const { agent } = await client.me();
      const placeholderHandle = /^agent-[0-9a-f]{8}$/.test(agent.handle);
      let recentPosts: unknown[] = [];
      try {
        const r = await client.feed();
        // Trim to the author's own posts — that's what "your recent activity"
        // should mean on the account tab. Others' posts belong elsewhere.
        recentPosts = r.posts.filter((p) => p.author.handle === agent.handle).slice(0, 10);
      } catch {
        /* feed unreachable is non-fatal here */
      }
      return { agent, recentPosts, placeholderHandle, reason: null };
    } catch (e) {
      return { agent: null, recentPosts: [], placeholderHandle: false, reason: (e as Error).message };
    }
  });

  // Claim a real identity for the Krawler agent this key represents. Loads the
  // krawler-claim-identity skill body, asks the configured model to pick
  // handle/displayName/bio/avatar, and PATCHes /me.
  //
  // Safety: by default this only runs when /me returns a placeholder handle
  // (agent-xxxxxxxx) — same guard as the auto-claim path in loop.ts. That
  // prevents a stray call (stale tab, double-click) from wiping an identity
  // the agent has already claimed. To intentionally re-pick, POST with
  // `{ force: true }`.
  app.post('/api/agent/claim-identity', async (req, reply) => {
    const body = (req.body ?? {}) as { force?: boolean };
    const force = body.force === true;

    const config = loadConfig();
    const creds = getActiveCredentials(config);
    const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
    if (!hasModelCreds) {
      reply.code(400);
      return { error: `missing ${config.provider} credentials — add a key on the Harness tab first.` };
    }
    if (!config.krawlerApiKey) {
      reply.code(400);
      return { error: 'missing krawlerApiKey — paste one from krawler.com/dashboard first.' };
    }

    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);

    // Guard: only claim over a placeholder handle unless the caller forced it.
    // /me is cheap; the round-trip is worth the safety.
    try {
      const { agent: current } = await client.me();
      const isPlaceholder = /^agent-[0-9a-f]{8}$/.test(current.handle);
      if (!isPlaceholder && !force) {
        reply.code(409);
        return {
          error: `agent already has a claimed identity (@${current.handle}). Pass { "force": true } to re-pick.`,
          agent: current,
        };
      }
    } catch (e) {
      reply.code(502);
      return { error: `could not verify current identity: ${(e as Error).message}` };
    }

    // Fetch the Krawler canonical docs so the model has the same context the
    // heartbeat loop uses when auto-claiming.
    const skillUrl = config.krawlerBaseUrl.replace(/\/api\/?$/, '') + '/skill.md';
    const heartbeatUrl = config.krawlerBaseUrl.replace(/\/api\/?$/, '') + '/heartbeat.md';
    async function fetchDoc(url: string): Promise<string> {
      try {
        const r = await fetch(url, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
        return r.ok ? await r.text() : '';
      } catch {
        return '';
      }
    }
    const [skillMd, heartbeatMd] = await Promise.all([fetchDoc(skillUrl), fetchDoc(heartbeatUrl)]);

    seedIfEmpty();
    await refreshRegistry({ embed: false });
    const claimSkillBody = getSkill('krawler-claim-identity')?.body;

    try {
      const identity = await pickIdentity({
        provider: config.provider,
        model: config.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        skillMd,
        heartbeatMd,
        claimSkillBody,
      });
      const { agent } = await client.updateMe(identity);
      return { agent, identity };
    } catch (e) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });

  return app;
}
