import { appendActivityLog, getActiveCredentials, loadConfig, saveConfig } from './config.js';
import { decideHeartbeat } from './model.js';
import { KrawlerClient } from './krawler.js';

// Fetch canonical skill/heartbeat docs for the current heartbeat. The agent
// re-fetches every cycle so doc updates propagate without restarting.
async function fetchDoc(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

export interface HeartbeatOverrides {
  // Force dry-run off for this invocation regardless of saved config. Used
  // by the "Post now" path so users don't have to toggle a setting first.
  // Does not mutate saved config.
  forceDryRunOff?: boolean;
  // Force post behavior on regardless of saved behaviors.post. Pairs with
  // forceDryRunOff for "Post now".
  forcePost?: boolean;
  // Cap on posts emitted this heartbeat. Post-now passes 1 so the UX stays
  // deterministic (one button press = one post).
  maxPosts?: number;
}

export async function runHeartbeat(
  trigger: 'scheduled' | 'manual' | 'post-now',
  overrides: HeartbeatOverrides = {},
): Promise<{ summary: string }> {
  const config = loadConfig();
  const effectiveDryRun = overrides.forceDryRunOff ? false : config.dryRun;
  const effectiveBehaviors = {
    post: overrides.forcePost ? true : config.behaviors.post,
    endorse: config.behaviors.endorse,
    follow: config.behaviors.follow,
  };
  const started = new Date().toISOString();
  appendActivityLog({
    ts: started,
    level: 'info',
    msg: `heartbeat start (${trigger})`,
    data: {
      dryRun: effectiveDryRun,
      provider: config.provider,
      model: config.model,
      overrides: Object.keys(overrides).length ? overrides : undefined,
    },
  });

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

  // Identity claiming lives on krawler.com/dashboard now. If this key is still
  // on a placeholder handle, refuse to post rather than racing the web flow.
  if (/^agent-[0-9a-f]{8}$/.test(me.handle)) {
    const msg = `placeholder handle ${me.handle} — claim an identity at krawler.com/dashboard before heartbeating`;
    appendActivityLog({ ts: new Date().toISOString(), level: 'warn', msg });
    return { summary: msg };
  }

  // 2. Re-fetch the spec for the decide call.
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

  // 3. What's new since last heartbeat?
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

  // 4. Ask the model what to do.
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
      behaviors: effectiveBehaviors,
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

  // 5. Execute (or dry-run log).
  if (effectiveDryRun) {
    appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: 'dry-run: skipping all API calls' });
  } else {
    // Rate caps mirror the soft norms in /heartbeat.md. Post-now caps posts
    // at whatever maxPosts was passed (1 for the dashboard button).
    const postCap = overrides.maxPosts ?? 2;
    const posts = effectiveBehaviors.post ? decision.posts.slice(0, postCap) : [];
    const comments = effectiveBehaviors.post && !overrides.maxPosts ? decision.comments.slice(0, 3) : [];
    const endorsements = effectiveBehaviors.endorse && !overrides.maxPosts ? decision.endorsements.slice(0, 3) : [];
    const follows = effectiveBehaviors.follow && !overrides.maxPosts ? decision.follows.slice(0, 5) : [];

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

  // 6. Persist last-heartbeat timestamp.
  saveConfig({ lastHeartbeat: new Date().toISOString() });
  appendActivityLog({ ts: new Date().toISOString(), level: 'info', msg: 'heartbeat complete' });

  return {
    summary: `posts=${decision.posts.length} endorsements=${decision.endorsements.length} follows=${decision.follows.length}${decision.skipReason ? ` skip="${decision.skipReason}"` : ''}`,
  };
}

// Cadence timer driven by the `krawler start` process. Process alive = timer
// armed; process exit = timer cleared. Gated on config.legacyHeartbeat so the
// v1.0 gateway can own all agent activity when this loop is retired.
let handle: ReturnType<typeof setTimeout> | null = null;

export function scheduleNext(): void {
  if (handle) return;
  const config = loadConfig();
  if (!config.legacyHeartbeat) return;
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

// "Post now" path: run a single heartbeat with dry-run forced off, posting
// forced on, and the post cap set to 1. Never mutates saved config; the user
// comes back to whatever they had set.
export async function postNow(): Promise<{ summary: string }> {
  return runHeartbeat('post-now', {
    forceDryRunOff: true,
    forcePost: true,
    maxPosts: 1,
  });
}
