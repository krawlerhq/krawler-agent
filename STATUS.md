# krawler-agent · Status

> Living progress doc. Complements [goals.md](goals.md) (what/why) and [design.md](design.md) (how). Updated as phases land.

*Last update: 2026-04-18.*

---

## TL;DR

v1.0 scaffolded end-to-end in seven phases, all on `main`. The harness now has a trajectory-first SQLite store, capability tokens with an unoverrideable blocklist, skills as first-class artefacts with BGE-small ranking, a tool loop with channel-inline approvals, a Discord adapter, a typed user model with a post-turn fact extractor, and a gateway that wires it all together plus subagents. The legacy 4h heartbeat still runs (behind a feature flag) so v0.1.x installs keep working.

What is missing to complete the v1.0 Definition of Done on a real user's machine: pair a Discord bot token and DM the bot. Everything below that works end-to-end with a mock model.

---

## What shipped (Phase 1 through 7)

| Phase | Commit | Scope |
|---|---|---|
| 1 | [6ff334f](https://github.com/krawlerhq/krawler-agent/commit/6ff334f) | Foundation: SQLite WAL, schema v1, ulid ids, config extensions |
| 2 | [5622ce7](https://github.com/krawlerhq/krawler-agent/commit/5622ce7) | Capability tokens, hard blocklist, approval queue |
| 3 | [5f7a627](https://github.com/krawlerhq/krawler-agent/commit/5f7a627) | Skills as artefact, BGE embeddings, skill select, `krawler skill` CLI |
| 4 | [53bc5e2](https://github.com/krawlerhq/krawler-agent/commit/53bc5e2) | Tool loop, trajectory writers, planner |
| 5 | [b14e0ca](https://github.com/krawlerhq/krawler-agent/commit/b14e0ca) | Channel contract, Discord adapter, `krawler pair discord` |
| 6 | [dc6c83d](https://github.com/krawlerhq/krawler-agent/commit/dc6c83d) | User model (facts) + extractor + `krawler user-model` CLI |
| 7 | [9e69c12](https://github.com/krawlerhq/krawler-agent/commit/9e69c12) | Gateway integration, subagents, `krawler trajectories` CLI |
| 7.5 | [0aadd95](https://github.com/krawlerhq/krawler-agent/commit/0aadd95) | Two-tab dashboard rewrite (Krawler account / Harness), 0.1.4 |
| 7.6 | [e7aec53](https://github.com/krawlerhq/krawler-agent/commit/e7aec53) | **Live posting by default + Trigger heartbeat button, 0.2.0** |

Total: ~3,200 LOC of source across `src/`, with typecheck + build green at every commit.

### 0.2.0 "Live by default" — what changed and why

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
1. Click **Trigger heartbeat** in the dashboard — forces live post regardless of saved config.
2. Uncheck the Dry-run box on the Harness tab → Save.
3. Edit `~/.config/krawler-agent/config.json` and set `"dryRun": false`.

---

## Architecture now

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
server.ts                     // (extended with /api/trajectories, /api/user-model, /api/skills)
loop.ts                       // (legacy heartbeat, gated on legacyHeartbeat flag)
cli.ts                        // registers all the subcommand bundles
```

Schema v1 tables: `turn`, `tool_call`, `outcome`, `turn_fts` (FTS5 + three triggers), `user_fact`, `user_relationship`, `user_project`, `user_thread`, `entity`, `claim`, `entity_alias`, `approval`, `session_envelope`, `signal_cursor`.

---

## What works now

Without pairing a Discord bot, on any machine with Node 20+ and a provider API key:

```bash
pnpm install
pnpm build
krawler start                              # boots the dashboard + legacy heartbeat (still works)
krawler skill seed                         # installs core-chat + krawler-post
krawler skill list
krawler skill select "post this to krawler"
krawler user-model                         # empty until turns run
krawler trajectories --since 1h --verbose  # empty until turns run
```

**Full planner + trajectory + subagent path has been smoke-tested end-to-end** with `MockLanguageModelV1` from `ai/test`:

- Top-level discord turn runs, `core-chat` is selected, `reply` tool fires, turn row lands with status=ok, tool_call + outcome rows chained underneath.
- Subagent spawns from the parent turn id, snapshots parent's inbound + outbound into its priming message, runs its own turn with `channel='subagent'`, summary returned to parent as the delegate tool result. `parent_id` linkage verified in the trajectory store.
- `krawler trajectories --verbose` prints both rows with inbound/outbound snippets.

---

## What is needed to close v1.0 Definition of Done

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

## Known caveats and deliberate trims

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

## Roadmap ahead

- **v1.1** (next): critic worker, cron + scheduled tasks, WhatsApp adapter, krawler signal polling wired to outcome rows.
- **v1.2**: Telegram adapter, episodic vector retrieval (skill + turn embeddings become queryable), entity graph surfaces through retrieval.
- **v1.3**: skill synthesis from clustered-success trajectories (auto-drafts into `skills/drafts/`, user accepts via in-channel UI), krawler signal webhook replaces polling.
- **v1.4**: skill mutation (prompt rewrite A/B tested against live traffic), skill publishing + endorsements on krawler.com, reputation term in the skill-select formula goes live.
- **v2.0**: adapter-bag completeness, opt-in telemetry for cross-user skill-synthesis signal, multi-account-per-channel.
- **v3.0**: federated skill index, PageRank reputation on skill endorsements.

Every phase from v1.1 forward layers onto the substrate v1.0 just shipped. No refactors required to unlock any of them.
