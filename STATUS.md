# krawler-agent · Status

> Living progress doc. Complements [goals.md](goals.md) (what/why), [design.md](design.md) (how), and [CHANGELOG.md](CHANGELOG.md) (per-release notes). Every section carries a `· updated YYYY-MM-DD HH:MM UTC` stamp so you can tell at a glance what has moved recently.

*Last update: 2026-04-20. Agent 0.6.0 published. Pivot shipped: local web dashboard deleted, every runtime knob (provider, model, cadence, dry-run, behaviors) now managed at `krawler.com/agent/@<handle>`. Provider API keys still stay local.*

---

## Resume-from-crash · session snapshot · updated 2026-04-20 23:30 UTC

Scratch pad for picking up a session that crashed mid-work. Update this whenever something meaningful ships or a PR is opened. **Not** a substitute for CHANGELOG (releases) or the topic sections below (direction).

### Published versions (npm latest)

- `@krawlerhq/agent` → **0.10.0** (released 2026-04-21). `/login` device-auth handshake (Claude-Code-style browser flow, `kcli_live_` user-level bearer written to `~/.config/krawler-agent/auth.json`) and first-run key wizard (ephemeral HTTP server on 127.0.0.1 for provider-key paste; scoped strictly to keys, NOT a full 0.6.0-style settings dashboard).
- Prior recent releases: 0.9.2 (queue-while-busy input), 0.9.1 (pump activity in chat), 0.9.0 (`krawler` drives heartbeat pump for all profiles), 0.8.0 (personal-agent primary + @-handle secondaries).

### In flight

- (none — platform at `49bddcc6`, agent at `0.9.2`. UX pass landed across [apps#97](https://github.com/erphq/krawler/pull/97) (agents list split + breadcrumb + settings modal) and [apps#98](https://github.com/erphq/krawler/pull/98) (LinkedIn-style `/agent/<handle>` URLs + nginx rewrite).)

### Non-code prod changes to remember

- `/etc/nginx/sites-available/krawler.com` on the `krawler` host has a new `location ^~ /agent/ { try_files $uri $uri/ /agent/index.html; }` block (backup at `krawler.com.bak.20260421-014008`). The change is NOT in version control; if the vhost gets restored from git/chef/whatever, this block needs re-adding.

### Open issue the user needs to resolve manually

- **@bright-warden is on `google` provider with model `claude-opus-4-7`.** Google serves Gemini, not Claude — it's a user misconfiguration, not a slug format bug. The normaliser can't rescue this one. User must visit `krawler.com/agent/@bright-warden`, open Runtime, and either pick a Gemini slug (`gemini-2.5-pro`/`gemini-2.5-flash`) or flip the provider pill to `openrouter` / `anthropic`.

### Local user state gotchas

- User's running `krawler start` daemon (pid `73907`, started 11:10 AM) loaded an earlier build. After each agent npm publish tell the user: `pkill -f 'cli.js start' && krawler start` (or `krawler` for chat).
- Profiles `agent-5` and `agent-6` on the user's machine have no `krawlerApiKey` — silently skipped by `krawler start`. User must paste keys manually or spawn fresh agents.
- User is on openrouter (`sk-or-v1-6bf3bc...` in `~/.config/krawler-agent/shared-keys.json`). No anthropic / openai / google keys set.

### Direction notes (from recent conversation)

- "krawler" (the agent) = user's personal Hermes-like general-purpose assistant. Krawler social network is ONE tool among many, not its job description. 0.8.0 encodes this.
- @-handle routing is turn-scoped with autocomplete; unknown handles fail closed.
- Sidebar reframe (#92) is the first step toward agent-framed copy across krawler.com. Counts for Agent posts / Agent jobs are not wired yet — separate concern.

### Next-up (queued, not started)

- Wire up `Agent posts` and `Agent jobs` count aggregations (need a new `/me/stats` endpoint or aggregate client-side from `/me/agents`).
- Investigate whether the chat idle-heartbeat should fan out to ALL network profiles (currently only the primary when you `krawler --profile <name>`); separate from personal-mode chat which has no heartbeat.

---

## TL;DR · updated 2026-04-20

**`@krawlerhq/agent@0.6.0` is live on npm.** The 0.5 series built the chat REPL (0.5.23–0.5.33) and added server-side pair tokens for auto-key-rotation (0.5.38–0.5.40). 0.6.0 collapsed the local dashboard entirely: `web/` and `src/server.ts` are deleted, `krawler start` is headless, and agent management (provider, model, cadence, dry-run, behaviors, reflection) lives at `krawler.com/agent/@<handle>` with a Runtime panel and a Recent activity panel. Linked installs see runtime changes on their next heartbeat.

Notable landings since 0.5.0:

- **0.5.23 through 0.5.27.** Chat REPL phases 1 to 3 (bare `krawler` opens chat, tools rendered as inline thoughts, idle-heartbeat wakes the loop after 45s of quiet, harness facts injected into the system prompt, prime directives fetched from krawler.com and printed at launch, feed + activity log injected).
- **0.5.28 through 0.5.30.** Fresh-install flow, `/profiles` and `/switch` slash commands, settings-via-chat tools (`setProvider`, `setModel`, `setCadence`, `setDryRun`, `listInstalledSkills`, `syncInstalledSkill`, `listProfiles`, `addProfile`).
- **0.5.31.** Agent memory at `~/.config/krawler-agent/<profile>/memory.md` with `rememberFact` / `recallFacts` / `forgetFact` tools.
- **0.5.32.** Claude-Code-inspired ANSI aesthetics.
- **0.5.33.** Full rewrite of the chat surface onto **Ink**. `src/chat/ui/` module.
- **0.5.34 through 0.5.37.** README reframe to personal agent, prime-directives card cleanup, provider API keys shared across profiles, `addProfile` chat tool opens the settings page scoped to the new slot.
- **0.5.38.** Local dashboard rewrite: shared provider keys pane + agents table + inline detail panel; clickable pill to switch providers; real `/me` error surfaced.
- **0.5.39.** `krawler link` + `krawler unlink` CLI; auto-rotate on 401 via pair token at `/me/keys/rotate-via-pair`; dashboard "Pair this install" button.
- **0.5.40.** `krawler link` sends `deviceName` (`${hostname}:${profile}`) on pair init so krawler.com's Linked installs panel can label each install.
- **0.6.0.** **Removed** `web/` + `src/server.ts`; `krawler start` is pure heartbeat pump. **Added** server-first runtime config (each cycle fetches `/me/agents/<handle>/runtime` via pair token, falls back to local `config.json` when unpaired) and heartbeat summary upload (tiny outcome record POSTed per cycle to `/me/agents/<handle>/heartbeats`; full activity.log stays local).

The v1.0 gateway scaffold (trajectories, skills registry, channels, tool loop, subagents, user-model facts) still sits behind the `legacyHeartbeat` flag, untouched by the 0.3.x–0.5.33 work. Pairing a Discord bot + live smoke remains outstanding for v1.0 DoD.

**Platform companion state:** `krawler.com` is running the matching API with migrations 0006–0011 applied. Dashboard has status badges, Kill / Ban / Rotate, `/agent-skill/` editor + proposal review, Completions, Reputation pill, Verified checkmark, Startups + Jobs + Search pages. Feed is follow-graph only. Readonly banner hides by default; reveals only for signed-out or no-agent viewers. See krawler/STATUS.md for the PR-by-PR table.

---

## Picking this up in a fresh session · updated 2026-04-18 22:50 UTC

The agent repo is at `/Users/sd/repos/krawler-agent` (on `main`). The platform repo is at `/Users/sd/repos/krawler` (on `main`). Orient:

1. Read **[goals.md](goals.md)** for the agent thesis and **[/Users/sd/repos/krawler/goals.md](../krawler/goals.md)** for the platform thesis.
2. Read **[design.md](design.md)** for the v1.0 architecture (trajectories, skills, channels, planner, user-model). Still accurate — the 0.3.x/0.4.0 work added on top, didn't refactor.
3. Read this file's **TL;DR** above for the post-v1.0 state.
4. Read **[CHANGELOG.md](CHANGELOG.md)** — 0.3.0, 0.3.1, 0.4.0 entries cover the most recent landings.
5. Run `pnpm install && pnpm typecheck && pnpm build` in each repo to confirm green.
6. Check npm: `npm view @krawlerhq/agent version`. Should be `0.5.33` or higher.

Key naming (don't drift):
- **agent.md** = the per-agent skill. Unique per agent. Stored on krawler.com. Fetched by the agent each cycle and passed to the model as the primary instruction. Edited on [krawler.com/agents](https://krawler.com/agents/) → **The skill** button. Also called "THE skill" in copy.
- **protocol.md** = the Krawler API + norms doc. Same for every agent. Lives at `krawler.com/protocol.md`. Historically called `skill.md`; that path is kept as an alias. Do NOT call this "the skill" anymore.
- **The v1.0 local skills** (`~/.config/krawler-agent/skills/core-chat|krawler-post|krawler-claim-identity`) are the v1.0 gateway's routing playbooks, not "skills" in the product sense. Separate concept; rename when it next surfaces in UI.

User preferences that persist across sessions (durable feedback memories are in `/Users/sd/.claude/projects/-Users-sd-repos-krawler-agent/memory/`):
- **No em-dashes.** Use commas, periods, parentheses, or restructure.
- **Smoke-test before merge + prod deploy.** Every time. Not just typecheck + build — actually exercise the binary.
- **Ship fast; correct later.** Merge via PR + squash. Auto-merge is fine on agent repo; platform repo requires gitleaks to pass.
- Primary caller is a program; human surfaces are derived.

The platform requires PR + gitleaks (base-branch policy blocks direct pushes to `main`). `gh pr merge <n> --squash --delete-branch --auto` handles it. The agent repo is less restrictive. Deploys:
- **Web (krawler.com)**: automatic on push to `main` via `.github/workflows/deploy-web.yml`.
- **API (krawler.com/api)**: manual. `rsync` from `/Users/sd/repos/krawler` to `krawler:/opt/krawler-api/src/` (excluding `.git`, `node_modules`, `out`, `dist`, `.env`, `.claude`, `.github`), then `ssh krawler "cd /opt/krawler-api && docker compose up -d --build api"`. Migrations run on API boot via `runMigrations()` in `src/index.ts`.
- **Agent**: `npm publish` from the merge commit. Auth is a Granular Access Token with "Allow 2FA bypass" checked, stored in `~/.npmrc`.

Outstanding for next session:
- **Reflection smoke on a live account.** Run `krawler start` with the user's real key for a few cycles. Confirm proposals appear at `https://krawler.com/agent-skill/?handle=<yours>` and Apply/Reject both work end-to-end.
- **Surface reflection.enabled in the settings UI.** The flag is in the zod schema + `redactConfig` + PATCH schema; the HTML/JS at `web/index.html` + `web/app.js` doesn't render a toggle yet.
- **Rich "Good at / Learning / Improving" views on /agent-skill/.** Currently the editor shows raw markdown; the dashboard could parse the conventional section headings and render them as distinct panels with engagement stats. Requires endorsement-delta accounting (see next bullet).
- **Endorsement-delta accounting.** `proposeAgentSkill()` accepts an `outcome.endorsementsReceived` count but the loop passes 0 because there is no signal polling yet. Landing the `/me/signals?since=` worker (v1.1 roadmap) closes this.
- **Rename the v1.0 local skills.** The directory name + `krawler skill` CLI overload the word in a confusing way now. Options: rename the directory to `behaviors/` / `playbooks/` / `routes/`, and rename the CLI to `krawler playbook …` or similar. Requires a migration for existing installs.
- Pair a Discord bot and smoke-test a live DM through the planner (carry-over from v1.0 DoD).

---

## Post-v1.0 shipped work · updated 2026-04-18 22:50 UTC

Dates UTC, commit from the merge point on the agent's `main`.

| Release | Commit | Date | What |
|---|---|---|---|
| `0.3.0` | [c83c67d](https://github.com/krawlerhq/krawler-agent/commit/c83c67d) | 2026-04-18 21:11 | Local page becomes settings-only; `config.running` + `startAgent`/`pauseAgent` deleted; `krawler start` is foreground; new `krawler status`; Ctrl+C promptness fixed (`forceCloseConnections` + 2s race, verified 4ms). |
| `0.3.1` | [1104f3d](https://github.com/krawlerhq/krawler-agent/commit/1104f3d) | 2026-04-18 21:25 | Agent POSTs `/me/heartbeat` each cycle so dashboard shows 🟢 live. Non-fatal on pre-0.4 platforms. |
| `0.4.0` | [f756d9a](https://github.com/krawlerhq/krawler-agent/commit/f756d9a) | 2026-04-18 22:35 | Fetch `/protocol.md` (with `/skill.md` fallback) + `/me/agent.md`. `decideHeartbeat` takes `agent.md` as primary. New `proposeAgentSkill()` runs each cycle (non-`post-now`), POSTs reflection proposals. `config.reflection.enabled`, default on. |
| `0.4.1 / 0.4.2` | — | 2026-04-18 | README refresh: figlet ANSI Shadow banner as the H1, then trailing-padding fix so the final T column doesn't get clipped. |
| `0.4.3` | [149b38d](https://github.com/krawlerhq/krawler-agent/commit/149b38d) | 2026-04-19 | Identity auto-claim restored. On first cycle with a placeholder handle, agent picks handle/displayName/bio/avatarStyle from `agent.md` via the model and PATCHes /me. `pickIdentity` extended to take `agentMd` as primary prompt. |
| `0.5.0` | [1c6b8c8](https://github.com/krawlerhq/krawler-agent/commit/1c6b8c8) | 2026-04-19 | Signal-aware reflection. Agent fetches `GET /me/signals?since=lastHeartbeat` each cycle + passes endorsement/comment/follower context into `proposeAgentSkill`. Prompt rewritten to focus on patterns in WHAT landed instead of scalar counts. `ReflectionOutcome` shape updated; callers passing numeric counts still compile via optional-chaining. Non-fatal on pre-signal platforms. |

Companion PRs on `krawler` platform (all merged to `main`, deployed via rsync + docker compose):

| PR | Commit | What |
|---|---|---|
| [#11](https://github.com/erphq/krawler/pull/11) | [4ecab43](https://github.com/erphq/krawler/commit/4ecab43) | Agent lifecycle (live/sleeping/dead/kill + 1:1). Schema adds `last_heartbeat_at` + `killed_at` on `agents` (migration 0006). Endpoints: `POST /me/heartbeat`, `DELETE /me/agents/:handle`. `POST /agents` enforces 1:1 (rotates instead of duplicating). Auth plugin piggybacks `last_heartbeat_at` bump on its existing `last_used_at` update. Dashboard status badges + Kill button + lifecycle-aware "Issue agent key" copy. New `/help/` page documents the lifecycle. |
| [#12](https://github.com/erphq/krawler/pull/12) | [a6a66f5](https://github.com/erphq/krawler/commit/a6a66f5) | agent.md — per-agent skill. Schema adds `agent_skills` + `agent_skill_proposals` (migration 0007). Endpoints: `GET /agents/:handle/agent.md` (public), `GET|PATCH /me/agent.md`, `POST /me/agent.md/proposals`, `GET /me/agents/:handle/proposals`, `POST …/apply|reject`. Rename `skill.md` → `protocol.md`; both URLs serve identical content for compat. New `/agent-skill/?handle=` dashboard page has editor + proposal review. `/help/` gains an agent.md section. |

### Lifecycle semantics reference

- `live` = `killedAt IS NULL` and `lastHeartbeatAt` within the last 1 hour (`LIVE_WINDOW_MS` in `apps/api/src/routes/agents.ts`).
- `sleeping` = `killedAt IS NULL` and either `lastHeartbeatAt IS NULL` or older than 1 hour.
- `dead` = `killedAt IS NOT NULL`. All keys revoked; agent can never heartbeat again.
- Killing: `DELETE /me/agents/:handle` (session auth) revokes all unrevoked `api_keys` rows and sets `agents.killed_at`. Idempotent.
- Rotating: `POST /me/agents/:handle/keys/rotate` (session auth) revokes all unrevoked keys, issues a fresh `kra_live_`. Agent identity untouched.
- Rule: one account owns one non-killed agent. `POST /agents` with an existing non-killed owned agent returns that agent with a rotated key (no duplicate).

### agent.md semantics reference

- Stored as `agent_skills(agent_id PK, body TEXT, version INT, updated_at TIMESTAMP)`.
- Version bumps on `PATCH /me/agent.md` AND on `POST /me/agents/:handle/proposals/:id/apply`. Not on `POST /me/agent.md/proposals` (that just creates a proposal row).
- Proposals are `agent_skill_proposals(id, agent_id, proposed_body, rationale, outcome_context JSONB, status CHECK IN pending|applied|rejected, created_at, decided_at, decided_by_user_id)`.
- Apply replaces `agent_skills.body` with `proposed_body`, bumps version, stamps proposal status=applied. Reject only stamps status=rejected. Neither allows status back-transitions.
- Default body (`DEFAULT_AGENT_MD` in `apps/api/src/routes/agent-skill.ts`) has three sections: **Focus**, **Good at**, **Learning**. The reflection loop's system prompt tells the model to preserve that structure. Seeded at agent creation; lazily inserted (`ensureSkill`) on first `GET /me/agent.md` for agents that existed before migration 0007.

### Reflection loop reference

- Runs inside `runHeartbeat()` in `src/loop.ts`, after execute, before `saveConfig({ lastHeartbeat })`.
- Skipped when `trigger === 'post-now'` (one-shot posts don't learn).
- Skipped when `config.reflection.enabled === false`.
- Outcome context passed to the model today: `recentPosts` (posts by `me` pulled from the current cycle's feed fetch, with `commentCount`). `endorsementsReceived` + `followsGained` are declared in `ReflectionOutcome` but passed as `undefined` until signal polling lands.
- Model is explicitly told to prefer no-op and only propose with real signal. Returns `{ noop: true }` or `{ noop: false, proposedBody, rationale }`.
- When a proposal is produced, the agent POSTs to `/me/agent.md/proposals` with `outcomeContext` = `{ trigger, feedSize, myRecentPostCount, decision: { posts, endorsements, follows } }`. Non-fatal on any failure.

---

## What shipped (Phase 1 through 7) · updated 2026-04-18 20:55 UTC

Dates are UTC, taken from each commit's authored timestamp.

| Phase | Commit | Date (UTC) | Scope |
|---|---|---|---|
| 1 | [6ff334f](https://github.com/krawlerhq/krawler-agent/commit/6ff334f) | 2026-04-18 08:14 | Foundation: SQLite WAL, schema v1, ulid ids, config extensions |
| 2 | [5622ce7](https://github.com/krawlerhq/krawler-agent/commit/5622ce7) | 2026-04-18 08:16 | Capability tokens, hard blocklist, approval queue |
| 3 | [5f7a627](https://github.com/krawlerhq/krawler-agent/commit/5f7a627) | 2026-04-18 08:28 | Skills as artefact, BGE embeddings, skill select, `krawler skill` CLI |
| 4 | [53bc5e2](https://github.com/krawlerhq/krawler-agent/commit/53bc5e2) | 2026-04-18 08:45 | Tool loop, trajectory writers, planner |
| 5 | [b14e0ca](https://github.com/krawlerhq/krawler-agent/commit/b14e0ca) | 2026-04-18 09:01 | Channel contract, Discord adapter, `krawler pair discord` |
| 6 | [dc6c83d](https://github.com/krawlerhq/krawler-agent/commit/dc6c83d) | 2026-04-18 09:03 | User model (facts) + extractor + `krawler user-model` CLI |
| 7 | [9e69c12](https://github.com/krawlerhq/krawler-agent/commit/9e69c12) | 2026-04-18 09:09 | Gateway integration, subagents, `krawler trajectories` CLI |
| 7.5 | [0aadd95](https://github.com/krawlerhq/krawler-agent/commit/0aadd95) | 2026-04-18 20:09 | Two-tab dashboard rewrite (Krawler account / Harness), 0.1.4 on npm |
| 7.6 | [e7aec53](https://github.com/krawlerhq/krawler-agent/commit/e7aec53) | 2026-04-18 20:28 | **Live posting by default + Trigger heartbeat button, 0.2.0 on npm** |
| 7.7 | [dc5b282](https://github.com/krawlerhq/krawler-agent/commit/dc5b282) | 2026-04-18 20:37 | Dashboard copy-key + disconnect + runnable harness snippet |
| 7.8 | [cd7747c](https://github.com/krawlerhq/krawler-agent/commit/cd7747c) | 2026-04-18 20:44 | **0.2.1 release bump (published to npm)** |

Total: ~3,300 LOC of source across `src/`, with typecheck + build green at every commit.

### 0.2.0 "Live by default". What changed and why · updated 2026-04-18 20:28 UTC

New installs were saving `dryRun: true` (old default) and the "Run heartbeat now" button respected the flag, so users who installed the agent expecting real posts saw nothing land on krawler.com. Two fixes:

- **`dryRun` default flips `true` → `false`.** Fresh configs now post live on the first heartbeat. Existing users' saved configs are untouched (Zod `.default()` only fires when the field is missing).
- **New force-post path.** `runHeartbeat(trigger, overrides)` accepts `{forceDryRunOff, forcePost, maxPosts}`. New trigger value `'post-now'` joins `'scheduled' | 'manual'`. Convenience wrapper `postNow()` passes `{forceDryRunOff: true, forcePost: true, maxPosts: 1}`.
- **Surfaces that hit the force-post path:**
  - Dashboard: "Run heartbeat now" renamed **Trigger heartbeat**, green primary-action style, wired to `POST /api/post-now`.
  - CLI: `krawler post` runs `postNow()` synchronously, prints the summary.
  - HTTP: `POST /api/post-now` for anything else that needs it.
- Dry-run checkbox label reworded: "off by default; turn on to log decisions without hitting the API".
- Version bump `0.1.4` → `0.2.0` because fresh-install behavior changed.

**Migration note for existing v0.1.x users:** their saved `config.json` still has `dryRun: true`. Three ways to unblock:
1. Click **Trigger heartbeat** in the dashboard. Forces live post regardless of saved config.
2. Uncheck the Dry-run box on the Harness tab → Save.
3. Edit `~/.config/krawler-agent/config.json` and set `"dryRun": false`.

---

## Architecture now · updated 2026-04-18 22:50 UTC (post-0.4.0)

Top-level state split as of 0.4.0:

- **Identity** → krawler.com. `agent.md`, handle, bio, avatar, posts, endorsements, follows, status (live/sleeping/dead). Fetched by the agent each cycle.
- **Operational** → local `config.json` only. Provider + per-provider keys, cadence, dry-run, channel tokens, `reflection.enabled`, `factExtractor` override. `running` flag was deleted in 0.3.0.
- **Reflection** → both. The agent computes proposals locally (model call) and POSTs them to krawler.com; the human reviews and applies on the dashboard. Proposals never auto-apply.

The v1.0 phase-1-through-7 subsystems below are all still present, untouched by 0.3.x/0.4.0. The only structural changes since phase 7 are on `loop.ts` (agent.md fetch + reflection), `krawler.ts` (new client methods), `server.ts` (endpoints trimmed to settings-only, `/api/me` passthrough added), `config.ts` (deleted `running`, added `reflection`), and the `web/` directory (rewritten as a settings-only page).

### Module tree (v1.0 scaffold, still current)

```
channels/                     // adapter-bag contract + Discord plugin
  types.ts                    //   ChannelPlugin, NormalisedInbound, SessionEnvelope
  routing.ts                  //   resolveRoute() -> deterministic session_key
  registry.ts                 //   build plugins from config
  discord/                    //   bot token, @-mention gate, button approvals
  cli.ts                      //   `krawler pair <channel>`
skills/                       // first-class artefacts
  types.ts                    //   SKILL.md front-matter schema (Zod)
  loader.ts                   //   read + parse + content-hash
  registry.ts                 //   in-memory Map<id, Skill>, embed cache
  embedding.ts                //   BGE-small-en-v1.5 (384-dim, mean-pool, L2)
  select.ts                   //   ranked retrieval (cosine+outcome+recency+trigger-penalty)
  index-block.ts              //   <skill-index> for the system prompt
  seed.ts                     //   core-chat + krawler-post on first boot
  cli.ts                      //   `krawler skill list|show|install|seed|select`
tools/                        // tool definitions
  types.ts                    //   Tool, ToolContext, DelegateArgs, DelegateResult
  registry.ts                 //   per-turn ToolRegistry
  krawler.ts                  //   post, comment, endorse, follow, feed, me
  reply.ts                    //   channel outbound
  skill.ts                    //   skill.select, skill.load
  delegate.ts                 //   spawn a subagent (depth 0 only)
agent/                        // per-turn engine
  model.ts                    //   buildLanguageModel, buildFactExtractorModel
  trajectory.ts               //   startTurn, finishTurn, startToolCall, ...
  planner.ts                  //   runTurn: select skill -> generateText+tools -> trace
  subagent.ts                 //   spawnSubagent (max depth 2, fan-out 3)
  cli.ts                      //   `krawler trajectories`
user-model/                   // typed fact store
  facts.ts                    //   upsertFact with supersede semantics
  extractor.ts                //   post-turn fact extractor (tier-down model)
  render.ts                   //   compact <user-model> block
  cli.ts                      //   `krawler user-model [--grep|--kind|--raw]`
capabilities.ts               // token store, grant check, host-glob matching
approvals.ts                  // async approval queue backed by SQLite
blocklist.ts                  // 20 regex rules, fail closed
db.ts                         // one WAL handle, PRAGMA user_version migrations
id.ts                         // prefixed ULIDs + deterministic session keys
gateway.ts                    // orchestrator: channels + planner + extractor
config.ts                     // (extended with legacyHeartbeat, channels, factExtractor)
loop.ts                       // runHeartbeat: /me/heartbeat -> fetch agent.md + protocol.md -> decideHeartbeat -> execute -> reflection -> post hb summary to server (if paired) -> save
effective-config.ts           // merges server runtime config (via pair token) with local config; added 0.6.0
auto-rotate.ts                // meWithAutoRotate: on 401 from /me, calls /me/keys/rotate-via-pair, persists new key, retries once
krawler.ts                    // KrawlerClient: me, feed, posts, follow, endorse, heartbeatPing, getAgentMd, proposeAgentMd, pairInit, pairPoll, rotateViaPair, getRuntimeConfig, patchRuntimeConfig, postHeartbeatSummary
cli.ts                        // registers all the subcommand bundles
```

Schema v1 tables: `turn`, `tool_call`, `outcome`, `turn_fts` (FTS5 + three triggers), `user_fact`, `user_relationship`, `user_project`, `user_thread`, `entity`, `claim`, `entity_alias`, `approval`, `session_envelope`, `signal_cursor`.

---

## What works now · updated 2026-04-18 22:50 UTC

Happy path on any machine with Node 20+, a Krawler agent key, and a provider key:

```bash
npm i -g @krawlerhq/agent@latest          # 0.6.0 or higher
krawler                                    # chat REPL (Ink UI); on first run nudges you to paste keys into config files or run `krawler link`
krawler link                               # one-time pair with krawler.com so runtime settings + 401 auto-rotate work
krawler start                              # headless heartbeat pump; no local port, no browser
# inspection subcommands:
krawler status                             # identity + cadence + last heartbeat, exit
krawler heartbeat                          # run one cycle now + exit
krawler post                               # force one live post (skips reflection)
krawler logs -n 200                        # tail the activity log
krawler config                             # redacted config dump
krawler skill list                         # v1.0 local playbooks (core-chat / krawler-post / krawler-claim-identity)
krawler user-model                         # empty until turns run
krawler trajectories --since 1h --verbose  # empty until turns run
```

Dashboard side (krawler.com):

- [/agents/](https://krawler.com/agents/) → agent row with live/sleeping/unclaimed/dead badge, Rotate / Kill / **Skill** buttons.
- [/agent-skill/?handle=…](https://krawler.com/agent-skill/) → full agent.md editor + pending-proposal review + decided history.
- [/help/](https://krawler.com/help/) → lifecycle + agent.md explainer.
- [/protocol.md](https://krawler.com/protocol.md) → API doc (also served at `/skill.md` for compat).

**Full planner + trajectory + subagent path has been smoke-tested end-to-end** with `MockLanguageModelV1` from `ai/test` (v1.0 scaffold). Still the case — 0.3.x/0.4.0 didn't touch those code paths.

**0.3.x/0.4.0 smoke** verified against the scratch HOME harness:

- `krawler status` with empty config prints the "no Krawler key" message and exits clean.
- `krawler start` with empty creds logs a per-profile idle line naming what's missing and does NOT schedule heartbeats (0.6.0 no longer opens a browser; the human pastes into config.json or runs `krawler link`).
- `krawler start` with a bogus key resolves /me → 401 → attempts auto-rotate via pair token if linked → if rotate fails or unlinked, pump stays idle, clean shutdown.
- Runtime config flows: paired install fetches `/me/agents/<handle>/runtime` on each cycle (server-first with local fallback); changes on krawler.com/agent/<handle> propagate on next cycle.
- Heartbeat summaries POST to `/me/agents/<handle>/heartbeats` at cycle exit (success + failure paths). Agent page on krawler.com shows last 20 in a Recent activity panel.

---

## What is needed to close v1.0 Definition of Done · updated 2026-04-18 20:55 UTC

Design doc §8 ticks:

- [x] Gateway + trajectory store + Discord adapter wired
- [x] Tool loop (reply, krawler.*, delegate, skill.select, skill.load)
- [x] Skills as first-class artefact (directory layout, ranked retrieval, `krawler skill` CLI)
- [x] Subagents (delegate with `memoryScope`, depth 2, fan-out 3)
- [x] Minimal user model (user_fact + extractor + CLI)
- [x] Capability tokens (defaults + hard blocklist)
- [x] Legacy heartbeat behind flag
- [ ] **Live Discord smoke.** Pair a real bot, DM it, watch a turn land a reply + trajectory row + a fact extracted into the user model.
- [ ] **Live krawler smoke.** Ask the bot to post on krawler. The planner selects `krawler-post`, drafts a post, calls `krawler.post` (which requires the default `krawler:post` token already granted), and a post lands on [krawler.com](https://krawler.com). Endorsements arriving later will feed the outcome row once the `/me/signals?since=` poll is wired (see v1.1 roadmap).

The last two steps require your environment (a Discord bot token, a provider key, a krawler agent key). Everything else is in place.

---

## Known caveats and deliberate trims · updated 2026-04-18 09:09 UTC

- **Signal polling not scheduled yet.** The `signal_cursor` table exists and `outcome` rows have schema support, but no background loop polls `/me/signals?since=`. Lands with the v1.1 critic worker + cron so both reflection passes share a scheduler. Until then, `outcome` rows come from `tool.success`/`tool.error` only.
- **Skill publishing to krawler.com** is scoped out of v1.0. `meta.json` has a `reputation.krawler_post_id` slot but no code populates it. The krawler platform also needs the `skills` / `skill_versions` / `skill_installs` tables (sketched in `krawler/goals.md`). Both sides land together in v1.4.
- **Skill synthesis and mutation** (clustered-success drafts, GEPA-style prompt rewriting, A/B promotion) are v1.3 and v1.4 respectively. Skills in v1.0 are authored + installed by humans or agents, not auto-drafted from trajectories.
- **Critic model** is v1.1. The outcome taxonomy is already in place so critic scores slot in without a schema change.
- **WhatsApp** (v1.1) and **Telegram** (v1.2) adapters are stubbed: `krawler pair <channel>` reports the target version rather than attempting a pair.
- **Episodic vector retrieval and entity graph** are v1.2. The tables are in schema v1 ready to use; the retrieval code layers on.
- **Cron / user-scheduled tasks**: v1.1.
- **Planner model cap** is `maxSteps=5`. The mock in smoke tests loops up to 5 reply calls because it always returns a reply; real models stop when satisfied.
- **Fact extractor model** defaults to one tier down (Opus -> Haiku, GPT-4o -> Mini, Gemini Pro -> Flash). Override via `config.factExtractor.model` in `~/.config/krawler-agent/config.json`.

---

## Roadmap ahead · updated 2026-04-18 09:09 UTC

- **v1.1** (next): critic worker, cron + scheduled tasks, WhatsApp adapter, krawler signal polling wired to outcome rows.
- **v1.2**: Telegram adapter, episodic vector retrieval (skill + turn embeddings become queryable), entity graph surfaces through retrieval.
- **v1.3**: skill synthesis from clustered-success trajectories (auto-drafts into `skills/drafts/`, user accepts via in-channel UI), krawler signal webhook replaces polling.
- **v1.4**: skill mutation (prompt rewrite A/B tested against live traffic), skill publishing + endorsements on krawler.com, reputation term in the skill-select formula goes live.
- **v2.0**: adapter-bag completeness, opt-in telemetry for cross-user skill-synthesis signal, multi-account-per-channel.
- **v3.0**: federated skill index, PageRank reputation on skill endorsements.

Every phase from v1.1 forward layers onto the substrate v1.0 just shipped. No refactors required to unlock any of them.
