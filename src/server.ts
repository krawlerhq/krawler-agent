import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { PROVIDERS, getActiveCredentials, loadConfig, readActivityLog, redactConfig, saveConfig } from './config.js';
import { MODEL_SUGGESTIONS, pickIdentity } from './model.js';
import { pauseAgent, runHeartbeat, scheduleNext, startAgent } from './loop.js';
import { gatewayIsRunning, startGateway, stopGateway } from './gateway.js';
import { KrawlerClient, registerAgent } from './krawler.js';
import { listRecentTurns } from './agent/trajectory.js';
import { countActiveFacts, listActiveFacts } from './user-model/facts.js';
import { listSkills, refreshRegistry } from './skills/registry.js';
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

  // --- Krawler identity endpoints ---
  // One-click agent provisioning. Uses the configured provider's model to
  // pick handle/displayName/bio/avatarStyle, then POSTs to krawler.com's
  // unauthenticated /agents endpoint. Stores the returned kra_live_ key in
  // config so the harness can start running. The user never touches the key.
  //
  // TODO(v1): move identity picking into a proper `krawler-claim-identity`
  // skill so it is versioned/endorsed/replaceable like any other skill. For
  // v0 the pickIdentity() helper is the mechanism.
  app.post('/api/agent/create', async (_req, reply) => {
    const config = loadConfig();
    if (config.krawlerApiKey) {
      reply.code(409);
      return { error: 'agent already exists — rotate or delete first' };
    }
    const creds = getActiveCredentials(config);
    const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
    if (!hasModelCreds) {
      reply.code(400);
      return { error: `add your ${config.provider} credentials first` };
    }

    // Fetch the spec docs so the model picks an identity aligned with them.
    const base = config.krawlerBaseUrl.replace(/\/api\/?$/, '');
    const fetchDoc = async (url: string) => {
      try {
        const r = await fetch(url);
        return r.ok ? await r.text() : '';
      } catch { return ''; }
    };
    const [skillMd, heartbeatMd] = await Promise.all([
      fetchDoc(base + '/skill.md'),
      fetchDoc(base + '/heartbeat.md'),
    ]);

    let identity;
    try {
      identity = await pickIdentity({
        provider: config.provider,
        model: config.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        skillMd,
        heartbeatMd,
      });
    } catch (e) {
      reply.code(502);
      return { error: `model could not draft an identity: ${(e as Error).message}` };
    }

    let result;
    try {
      result = await registerAgent(config.krawlerBaseUrl, identity);
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }

    saveConfig({ ...config, krawlerApiKey: result.key });
    return {
      agent: result.agent,
      keyLast4: result.key.slice(-4),
      config: redactConfig(loadConfig()),
    };
  });

  // Current agent: /me plus recent own posts. Masked key only.
  app.get('/api/agent/summary', async (_req, reply) => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      reply.code(404);
      return { error: 'no agent provisioned yet' };
    }
    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
    try {
      const { agent } = await client.me();
      let recentPosts: Array<{ id: string; body: string; createdAt: string }> = [];
      try {
        const { posts } = await client.feed();
        recentPosts = posts.filter((p) => p.author.handle === agent.handle).slice(0, 5);
      } catch { /* feed is best-effort */ }
      return {
        agent,
        keyLast4: config.krawlerApiKey.slice(-4),
        recentPosts,
      };
    } catch (e) {
      reply.code(502);
      return { error: (e as Error).message };
    }
  });

  // Disconnect the local install from the current Krawler agent. This only
  // clears the key locally; the agent record on krawler.com persists.
  app.delete('/api/agent', async () => {
    const config = loadConfig();
    saveConfig({ ...config, krawlerApiKey: '' });
    return { config: redactConfig(loadConfig()) };
  });

  // Return the full agent key. Only served on the loopback interface to the
  // local user; the dashboard already has filesystem access to config.json.
  app.get('/api/agent/reveal-key', async (_req, reply) => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      reply.code(404);
      return { error: 'no key set' };
    }
    return { key: config.krawlerApiKey };
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

  return app;
}
