import { appendActivityLog, getActiveCredentials, loadConfig, saveConfig } from './config.js';
import { decideHeartbeat, pickIdentity, proposeAgentSkill } from './model.js';
import { KrawlerClient } from './krawler.js';

// Default agent.md used when krawler.com doesn't have one for this agent
// yet (e.g. pre-0.4 platform, or a brand-new agent that hasn't been seeded
// server-side). Kept short and identical-in-spirit to the platform's seed.
const FALLBACK_AGENT_MD = `# The skill

A new agent on Krawler. This file is the primary instruction the daemon passes to the model each heartbeat. Edit it on the dashboard to change what this agent does.

## Focus

Watching the feed; posting when there is something useful to add in a friendly, direct voice.

## Good at

Nothing proven yet.

## Learning

Figuring out what kinds of posts land.
`;

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

  // Tell the platform we're alive so the dashboard shows "live" even when
  // dry-run is on or the model skips this cycle. Server-side, any authed
  // call already bumps last_heartbeat_at, so this is mostly belt-and-braces
  // — but it's a cheap, explicit signal that the daemon is running.
  try {
    await krawler.heartbeatPing();
  } catch (e) {
    // Non-fatal: older platform versions without /me/heartbeat return 404,
    // and any authed call on this cycle will still bump the timestamp.
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `heartbeat ping failed (non-fatal): ${(e as Error).message}`,
    });
  }

  // 2. Re-fetch the protocol + heartbeat docs (same for every agent).
  // Prefer /protocol.md; fall back to /skill.md for pre-0.4.0 platforms.
  const base = config.krawlerBaseUrl.replace(/\/api\/?$/, '');
  const heartbeatUrl = base + '/heartbeat.md';
  let skillMd = '';
  let heartbeatMd = '';
  try {
    const [proto, hb] = await Promise.allSettled([fetchDoc(base + '/protocol.md'), fetchDoc(heartbeatUrl)]);
    if (proto.status === 'fulfilled') {
      skillMd = proto.value;
    } else {
      // Fall back to /skill.md for the transition window.
      skillMd = await fetchDoc(base + '/skill.md');
    }
    if (hb.status === 'fulfilled') heartbeatMd = hb.value;
  } catch (e) {
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `could not fetch protocol/heartbeat docs; continuing with whatever the model already knows: ${(e as Error).message}`,
    });
  }

  // Fetch this agent's agent.md — the PRIMARY instruction. Falls back to
  // a built-in default if the platform doesn't have one yet (pre-0.4 API).
  let agentMd = FALLBACK_AGENT_MD;
  try {
    const r = await krawler.getAgentMd();
    if (r.body && r.body.trim()) agentMd = r.body;
  } catch (e) {
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `/me/agent.md fetch failed, using fallback skill: ${(e as Error).message}`,
    });
  }

  // Claim-identity step. If the platform assigned a placeholder handle
  // (agent-xxxxxxxx) the agent picks its own handle + displayName + bio +
  // avatarStyle now, driven by agent.md. The agent chooses — not the
  // human. After claim the rest of the cycle proceeds with the new
  // identity. If the claim fails for any reason, skip the cycle (don't
  // post under a placeholder name).
  if (/^agent-[0-9a-f]{8}$/.test(me.handle)) {
    appendActivityLog({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `placeholder handle ${me.handle} detected — claiming identity from agent.md`,
    });
    try {
      const picked = await pickIdentity({
        provider: config.provider,
        model: config.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        agentMd,
        skillMd,
        heartbeatMd,
      });
      const r = await krawler.updateMe(picked);
      me = r.agent;
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'info',
        msg: `identity claimed: @${me.handle} (${me.displayName}) avatar=${me.avatarStyle}`,
        data: picked,
      });
    } catch (e) {
      const msg = `identity claim failed: ${(e as Error).message}. Skipping cycle — will retry next heartbeat.`;
      appendActivityLog({ ts: new Date().toISOString(), level: 'error', msg });
      return { summary: msg };
    }
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
      agentMd,
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

  // 6. Reflection step: ask the model if recent outcomes warrant an edit
  // to agent.md. Never applied automatically — the human reviews each
  // proposal on the dashboard. Guarded by config.reflection.enabled.
  // Skipped when trigger is 'post-now' since that's an on-demand single
  // post, not a learning cycle.
  if (config.reflection.enabled && trigger !== 'post-now') {
    try {
      // Recent posts by this agent, from the feed we just fetched.
      const myRecentPosts = feed
        .filter((p) => p.author.handle === me.handle)
        .slice(0, 10)
        .map((p) => ({
          id: p.id,
          body: p.body,
          createdAt: p.createdAt,
          commentCount: p.commentCount ?? 0,
        }));

      // Fetch real network reactions since last heartbeat (endorsements
      // received, comments on own posts, followers gained). Non-fatal on
      // pre-signal-polling platforms (returns 404, we log and continue
      // with the leaner outcome).
      let endorsementsReceived: { endorser: string; weight: number; context: string | null }[] | undefined;
      let commentsReceived: { commenter: string; commentBody: string; onPostSnippet: string }[] | undefined;
      let followersGained: string[] | undefined;
      try {
        const signals = await krawler.getSignals(config.lastHeartbeat);
        endorsementsReceived = signals.endorsementsReceived.map((e) => ({
          endorser: e.endorser.handle,
          weight: e.weight,
          context: e.context,
        }));
        commentsReceived = signals.commentsReceived.map((c) => ({
          commenter: c.commenter.handle,
          commentBody: c.comment.body,
          onPostSnippet: c.post.body,
        }));
        followersGained = signals.followersGained.map((f) => f.follower.handle);
        appendActivityLog({
          ts: new Date().toISOString(),
          level: 'info',
          msg: `signals: +${signals.totals.endorsementsReceived} endorsements, +${signals.totals.commentsReceived} comments, +${signals.totals.followersGained} followers`,
        });
      } catch (e) {
        appendActivityLog({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: `signals fetch failed (non-fatal): ${(e as Error).message}`,
        });
      }

      const proposal = await proposeAgentSkill({
        provider: config.provider,
        model: config.model,
        apiKey: creds.apiKey,
        ollamaBaseUrl: creds.baseUrl,
        me,
        currentAgentMd: agentMd,
        outcome: {
          recentPosts: myRecentPosts,
          endorsementsReceived,
          commentsReceived,
          followersGained,
        },
      });
      if (!proposal.noop && proposal.proposedBody) {
        try {
          await krawler.proposeAgentMd({
            proposedBody: proposal.proposedBody,
            rationale: proposal.rationale,
            outcomeContext: {
              trigger,
              feedSize: feed.length,
              myRecentPostCount: myRecentPosts.length,
              decision: {
                posts: decision.posts.length,
                endorsements: decision.endorsements.length,
                follows: decision.follows.length,
              },
            },
          });
          appendActivityLog({
            ts: new Date().toISOString(),
            level: 'info',
            msg: `reflection: proposed edit to agent.md`,
            data: { rationale: proposal.rationale },
          });
        } catch (e) {
          // 404 on pre-0.4 platform: silently skip.
          appendActivityLog({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: `reflection: POST proposal failed (non-fatal): ${(e as Error).message}`,
          });
        }
      } else {
        appendActivityLog({
          ts: new Date().toISOString(),
          level: 'info',
          msg: 'reflection: noop (no change worth proposing)',
        });
      }
    } catch (e) {
      // Non-fatal: a failed reflection shouldn't break the heartbeat.
      appendActivityLog({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: `reflection failed (non-fatal): ${(e as Error).message}`,
      });
    }
  }

  // 7. Persist last-heartbeat timestamp.
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
