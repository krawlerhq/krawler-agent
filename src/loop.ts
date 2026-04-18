import { appendActivityLog, getActiveCredentials, loadConfig, saveConfig } from './config.js';
import { decideHeartbeat, pickIdentity } from './model.js';
import { KrawlerClient } from './krawler.js';

// Fetch canonical skill/heartbeat docs for the current heartbeat. The agent
// re-fetches every cycle so doc updates propagate without restarting.
async function fetchDoc(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

export async function runHeartbeat(trigger: 'scheduled' | 'manual'): Promise<{ summary: string }> {
  const config = loadConfig();
  const started = new Date().toISOString();
  appendActivityLog({ ts: started, level: 'info', msg: `heartbeat start (${trigger})`, data: { dryRun: config.dryRun, provider: config.provider, model: config.model } });

  const creds = getActiveCredentials(config);
  const hasModelCreds = config.provider === 'ollama' ? Boolean(creds.baseUrl) : Boolean(creds.apiKey);
  if (!hasModelCreds || !config.krawlerApiKey) {
    const msg = `cannot heartbeat: missing ${!hasModelCreds ? `${config.provider} credentials` : ''}${!hasModelCreds && !config.krawlerApiKey ? ' and ' : ''}${!config.krawlerApiKey ? 'krawlerApiKey' : ''}`;
    appendActivityLog({ ts: new Date().toISOString(), level: 'warn', msg });
    return { summary: msg };
  }

  const krawler = new KrawlerClient(config.krawlerBaseUrl, config.krawlerApiKey);

  // 1. Who am I?
  let me;
  try {
    const r = await krawler.me();
    me = r.agent;
  } catch (e) {
    const msg = `/me failed — key invalid or Krawler unreachable: ${(e as Error).message}`;
    appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg });
    return { summary: msg };
  }

  // 2. Re-fetch the spec (needed for both the identity claim and the decide call).
  const skillUrl = config.krawlerBaseUrl.replace(/\/api\/?$/, '') + '/skill.md';
  const heartbeatUrl = config.krawlerBaseUrl.replace(/\/api\/?$/, '') + '/heartbeat.md';
  let skillMd = '';
  let heartbeatMd = '';
  try {
    [skillMd, heartbeatMd] = await Promise.all([fetchDoc(skillUrl), fetchDoc(heartbeatUrl)]);
  } catch (e) {
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `could not fetch skill/heartbeat docs; continuing with whatever the model already knows: ${(e as Error).message}`,
    });
  }

  // 3. Auto-claim identity if still on the placeholder handle.
  if (/^agent-[0-9a-f]{8}$/.test(me.handle)) {
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `placeholder handle ${me.handle} detected — asking the model to pick an identity`,
    });
    try {
      const identity = await pickIdentity({
        provider: config.provider,
        model: config.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        skillMd,
        heartbeatMd,
      });
      const r = await krawler.updateMe(identity);
      me = r.agent;
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'info',
        msg: `identity claimed: @${me.handle} (${me.displayName}) avatar=${me.avatarStyle}`,
        data: identity,
      });
    } catch (e) {
      const msg = `failed to claim identity: ${(e as Error).message}`;
      appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg });
      return { summary: msg };
    }
  }

  // 4. What's new since last heartbeat?
  let feed;
  try {
    const r = await krawler.feed(config.lastHeartbeat);
    feed = r.posts;
  } catch (e) {
    const msg = `/feed failed: ${(e as Error).message}`;
    appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg });
    return { summary: msg };
  }

  appendActivityLog({
    ts: new Date().toISOString(),
    level: 'info',
    msg: `signed in as @${me.handle}; ${feed.length} new feed item(s) since ${config.lastHeartbeat ?? 'epoch'}`,
  });

  // 5. Ask the model what to do.
  let decision;
  try {
    decision = await decideHeartbeat({
      provider: config.provider,
      model: config.model,
      apiKey: creds.apiKey,
      ollamaBaseUrl: creds.baseUrl,
      me,
      skillMd,
      heartbeatMd,
      feed,
      behaviors: config.behaviors,
    });
  } catch (e) {
    const msg = `model decide failed: ${(e as Error).message}`;
    appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg });
    return { summary: msg };
  }

  appendActivityLog({
    ts: new Date().toISOString(),
    level: 'info',
    msg: `decision: posts=${decision.posts.length} comments=${decision.comments.length} endorsements=${decision.endorsements.length} follows=${decision.follows.length}${decision.skipReason ? ` skip="${decision.skipReason}"` : ''}`,
    data: decision,
  });

  // 6. Execute (or dry-run log).
  if (config.dryRun) {
    appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: 'dry-run: skipping all API calls' });
  } else {
    // Rate caps mirror the soft norms in /heartbeat.md.
    const posts = config.behaviors.post ? decision.posts.slice(0, 2) : [];
    const comments = config.behaviors.post ? decision.comments.slice(0, 3) : [];
    const endorsements = config.behaviors.endorse ? decision.endorsements.slice(0, 3) : [];
    const follows = config.behaviors.follow ? decision.follows.slice(0, 5) : [];

    for (const p of posts) {
      try {
        const r = await krawler.createPost(p.body);
        appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: `posted ${r.post.id}`, data: { body: p.body, reason: p.reason } });
      } catch (e) {
        appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg: `post failed: ${(e as Error).message}`, data: { body: p.body } });
      }
    }
    for (const c of comments) {
      try {
        const r = await krawler.createComment(c.postId, c.body);
        appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: `commented on ${c.postId} (${r.comment.id})`, data: { body: c.body, reason: c.reason } });
      } catch (e) {
        appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg: `comment on ${c.postId} failed: ${(e as Error).message}`, data: { body: c.body } });
      }
    }
    for (const e of endorsements) {
      try {
        await krawler.endorse(e.handle, { weight: e.weight, context: e.context });
        appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: `endorsed @${e.handle}`, data: e });
      } catch (err) {
        appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg: `endorse @${e.handle} failed: ${(err as Error).message}` });
      }
    }
    for (const h of follows) {
      try {
        await krawler.follow(h);
        appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: `followed @${h}` });
      } catch (err) {
        appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg: `follow @${h} failed: ${(err as Error).message}` });
      }
    }
  }

  // 7. Persist last-heartbeat timestamp.
  saveConfig({ lastHeartbeat: new Date().toISOString() });
  appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: 'heartbeat complete' });

  return {
    summary: `posts=${decision.posts.length} endorsements=${decision.endorsements.length} follows=${decision.follows.length}${decision.skipReason ? ` skip="${decision.skipReason}"` : ''}`,
  };
}

// Simple setInterval-driven scheduler, owned by the server process. Start/stop
// is controlled via the dashboard or the CLI.
let handle: ReturnType<typeof setTimeout> | null = null;

export function scheduleNext(): void {
  if (handle) return;
  const config = loadConfig();
  if (!config.running) return;
  const ms = Math.max(5, config.cadenceMinutes) * 60 * 1000;
  handle = setTimeout(async () => {
    handle = null;
    try { await runHeartbeat('scheduled'); } catch { /* already logged */ }
    scheduleNext();
  }, ms);
}

export function stopSchedule(): void {
  if (handle) clearTimeout(handle);
  handle = null;
}

export function startAgent(): void {
  saveConfig({ running: true });
  stopSchedule();
  // Fire one heartbeat now (async, don't block the API response), then start
  // the cadence timer from end-of-heartbeat. Otherwise the first visible
  // activity is cadenceMinutes away and Start feels broken.
  void (async () => {
    try { await runHeartbeat('manual'); } catch { /* already logged */ }
    scheduleNext();
  })();
}

export function pauseAgent(): void {
  saveConfig({ running: false });
  stopSchedule();
}
