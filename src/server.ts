import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { PROVIDERS, loadConfig, readActivityLog, redactConfig, saveConfig } from './config.js';
import { MODEL_SUGGESTIONS } from './model.js';
import { pauseAgent, runHeartbeat, scheduleNext, startAgent } from './loop.js';

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
    logger: { level: 'info' },
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
  // process restarted.
  scheduleNext();

  return app;
}
