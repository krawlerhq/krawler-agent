import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { PROVIDERS, loadConfig, readActivityLog, redactConfig, saveConfig } from './config.js';
import { KrawlerClient } from './krawler.js';
import { MODEL_SUGGESTIONS } from './model.js';
import { startGateway } from './gateway.js';

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

  app.get('/api/config', async () => {
    return { config: redactConfig(loadConfig()), modelSuggestions: MODEL_SUGGESTIONS };
  });

  app.patch('/api/config', async (req, reply) => {
    const parsed = updateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'invalid body' };
    }
    const patch: Record<string, unknown> = { ...parsed.data };
    for (const k of ['anthropicApiKey', 'openaiApiKey', 'googleApiKey', 'openrouterApiKey', 'krawlerApiKey']) {
      if (patch[k] === '') delete patch[k];
    }
    const current = loadConfig();
    const merged = { ...current, ...patch };
    saveConfig(merged);
    return { config: redactConfig(loadConfig()) };
  });

  app.get('/api/log', async (req) => {
    const limit = Math.min(500, Math.max(1, Number((req.query as { limit?: string }).limit) || 200));
    return { log: readActivityLog(limit) };
  });

  // Read-only "who is this key bound to on krawler.com" passthrough. Surfaces
  // handle + display name + placeholder flag so the settings page can show a
  // truthful identity header instead of duplicating state locally.
  app.get('/api/me', async () => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      return { agent: null, placeholderHandle: false, reason: 'no-key' };
    }
    const client = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);
    try {
      const { agent } = await client.me();
      const placeholderHandle = /^agent-[0-9a-f]{8}$/.test(agent.handle);
      return { agent, placeholderHandle, reason: null };
    } catch (e) {
      return { agent: null, placeholderHandle: false, reason: (e as Error).message };
    }
  });

  // Reveal the stored key over the loopback so the settings page can copy it
  // for use in other harnesses (OpenClaw, Hermes, your own). 127.0.0.1 + 0600
  // config file means the trust boundary is already crossed.
  app.get('/api/agent/reveal-key', async (_req, reply) => {
    const config = loadConfig();
    if (!config.krawlerApiKey) {
      reply.code(404);
      return { error: 'no Krawler key configured' };
    }
    return { key: config.krawlerApiKey };
  });

  // Disconnect the local install from the Krawler agent. Clears the key
  // locally; the agent on krawler.com is untouched.
  app.delete('/api/agent', async () => {
    const config = loadConfig();
    saveConfig({ ...config, krawlerApiKey: '' });
    return { config: redactConfig(loadConfig()) };
  });

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
