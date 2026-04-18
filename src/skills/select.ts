// Ranked skill selection. See design.md §1.7 for the scoring formula.
//
// v1.0 composition (no krawler endorsement term yet; that lands in v1.4 when
// krawler-side skill posts are endorsable):
//
//   score(q, s) =
//       W_COS * cosine(q, s.embedding)
//     + W_OUT * sigmoid(s.avg_outcome_score)
//     + W_REC * exp(-age_days / 30)
//     - W_PEN * recent_failure_penalty
//
// Triggers short-circuit the ranking: if a skill declares `triggers: [keyword: "foo"]`
// and the inbound contains "foo", the skill scores W_TRIG additive boost.

import { embed, cosine } from './embedding.js';
import { listSkills, embeddingsAreReady, refreshRegistry } from './registry.js';
import type { Skill, SkillTrigger } from './types.js';

const W_COS = 0.65;
const W_OUT = 0.15;
const W_REC = 0.05;
const W_TRIG = 0.20;
const W_PEN = 0.10;

export interface SkillCandidate {
  skill: Skill;
  score: number;
  reasons: { term: string; value: number }[];
}

export async function selectSkills(
  query: string,
  opts: { k?: number; channel?: string; peerId?: string } = {},
): Promise<SkillCandidate[]> {
  const k = opts.k ?? 5;
  if (!embeddingsAreReady()) await refreshRegistry({ embed: true });

  const skills = listSkills().filter((s) => s.frontmatter.status === 'active');
  if (skills.length === 0) return [];

  const queryEmb = await embed(query);
  const now = Date.now();

  const candidates: SkillCandidate[] = [];
  for (const s of skills) {
    // Channel-gated triggers: if any trigger names a channel and it does not
    // match, skip the skill entirely.
    if (!passesChannelGate(s, opts.channel)) continue;

    const reasons: { term: string; value: number }[] = [];

    const cos = s.embedding ? cosine(queryEmb, s.embedding) : 0;
    reasons.push({ term: 'cosine', value: +(cos * W_COS).toFixed(4) });

    const outTerm = sigmoid(s.meta.avg_outcome_score);
    reasons.push({ term: 'outcome', value: +(outTerm * W_OUT).toFixed(4) });

    const recTerm = recencyTerm(s.meta.last_run_at, now);
    reasons.push({ term: 'recency', value: +(recTerm * W_REC).toFixed(4) });

    const trigTerm = triggerMatch(s.frontmatter.triggers, query) ? 1 : 0;
    if (trigTerm) reasons.push({ term: 'trigger', value: +(trigTerm * W_TRIG).toFixed(4) });

    const penTerm = failurePenalty(s.meta.recent_failures);
    if (penTerm > 0) reasons.push({ term: 'failure', value: +(-penTerm * W_PEN).toFixed(4) });

    const score = W_COS * cos + W_OUT * outTerm + W_REC * recTerm + W_TRIG * trigTerm - W_PEN * penTerm;
    candidates.push({ skill: s, score, reasons });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, k);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function recencyTerm(lastRunIso: string | undefined, now: number): number {
  if (!lastRunIso) return 0.5; // neutral for never-run
  const last = Date.parse(lastRunIso);
  if (!Number.isFinite(last)) return 0.5;
  const days = (now - last) / 86400_000;
  return Math.exp(-days / 30);
}

function failurePenalty(recentFailures: number): number {
  if (recentFailures <= 0) return 0;
  // Saturate quickly: 3 failures = 0.5, 10 failures = ~0.77.
  return 1 - Math.exp(-recentFailures / 4);
}

function triggerMatch(triggers: SkillTrigger[], query: string): boolean {
  if (triggers.length === 0) return false;
  const q = query.toLowerCase();
  for (const t of triggers) {
    if ('keyword' in t && t.keyword && q.includes(t.keyword.toLowerCase())) return true;
  }
  return false;
}

function passesChannelGate(s: Skill, channel?: string): boolean {
  if (!channel) return true;
  const channelTriggers = s.frontmatter.triggers.filter((t): t is { channel: string } => 'channel' in t);
  if (channelTriggers.length === 0) return true;
  return channelTriggers.some((t) => t.channel === channel);
}
