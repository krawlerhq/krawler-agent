// Post-turn fact extractor. Reads the turn's inbound + outbound, calls a
// cheap ("one tier down") model via generateObject, and upserts the resulting
// facts into user_fact. Runs async; never on the hot path.
//
// See design.md §1.8, §10 #3.

import { generateObject } from 'ai';
import { z } from 'zod';

import { buildFactExtractorModel } from '../agent/model.js';
import type { Config } from '../config.js';
import { getDb } from '../db.js';
import { upsertFact, USER_FACT_KINDS, type UserFactKind } from './facts.js';
import { renderUserModel } from './render.js';

const factCandidateSchema = z.object({
  kind: z.enum(USER_FACT_KINDS),
  key: z.string().min(1).max(120).describe(
    'A short slug-style key naming the fact, e.g. "timezone", "prefers_short_replies", "current_project_name".',
  ),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

const extractionSchema = z.object({
  facts: z.array(factCandidateSchema).max(8),
});

export async function extractFactsForTurn(config: Config, turnId: string): Promise<number> {
  const db = getDb();
  const row = db.prepare(
    `SELECT inbound_text as inbound, outbound_text as outbound, peer_id as peerId
     FROM turn WHERE id = ?`,
  ).get(turnId) as { inbound: string | null; outbound: string | null; peerId: string | null } | undefined;
  if (!row || !row.inbound) return 0;

  const { languageModel } = buildFactExtractorModel(config);
  const currentModel = renderUserModel({ compact: true });

  const system =
    'Extract durable facts about the user from the turn below. A fact is ' +
    'durable if it would still be useful a week from now. Skip ephemeral state ' +
    '(what they had for lunch), opinions about specific posts, or anything ' +
    'already in the current user model.\n\n' +
    `Allowed kinds: ${USER_FACT_KINDS.join(', ')}.\n` +
    '- preference: a lasting like/dislike or style choice\n' +
    '- relationship: person or org the user works with\n' +
    '- project: named initiative the user is working on\n' +
    '- profession: role or area of expertise\n' +
    '- context: background state (timezone, work schedule, location)\n\n' +
    'Confidence: 0 to 1. Use > 0.8 only when the fact is explicit. Use 0.5 ' +
    'to 0.8 for strong implications. Below 0.5 means do not emit.\n' +
    'Return an empty facts array when nothing durable is present.\n\n' +
    `CURRENT USER MODEL:\n${currentModel}\n`;

  const prompt =
    `TURN INBOUND (from the user):\n${row.inbound}\n\n` +
    `TURN OUTBOUND (agent's reply):\n${row.outbound ?? '(none)'}\n`;

  let facts: z.infer<typeof factCandidateSchema>[];
  try {
    const { object } = await generateObject({
      model: languageModel,
      schema: extractionSchema,
      system,
      prompt,
    });
    facts = object.facts.filter((f) => f.confidence >= 0.5);
  } catch {
    return 0;
  }

  let written = 0;
  for (const f of facts) {
    try {
      upsertFact({
        kind: f.kind as UserFactKind,
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        sourceTurn: turnId,
      });
      written += 1;
    } catch { /* skip individual failures */ }
  }
  return written;
}
