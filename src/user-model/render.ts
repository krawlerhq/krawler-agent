// Render the user model into a compact <user-model> block for the system
// prompt. Grouped by kind, ranked by confidence + recency, capped at ~1200
// tokens (roughly 4800 chars) so it does not dominate the prompt budget.

import { listActiveFacts, type UserFact } from './facts.js';

export function renderUserModel(opts: { compact?: boolean } = {}): string {
  const facts = listActiveFacts({ minConfidence: 0.5 });
  if (facts.length === 0) {
    return '<user-model>(empty — the agent is learning)</user-model>';
  }

  const maxChars = opts.compact ? 2000 : 4800;
  const byKind = groupBy(facts, (f) => f.kind);

  const lines: string[] = ['<user-model>'];
  const order: UserFact['kind'][] = ['profession', 'context', 'project', 'preference', 'relationship'];
  for (const kind of order) {
    const group = byKind.get(kind) ?? [];
    if (group.length === 0) continue;
    lines.push(prettyKind(kind) + ':');
    for (const f of group.slice(0, 10)) {
      lines.push(`  - ${f.key}: ${f.value}`);
    }
  }
  lines.push('</user-model>');

  let rendered = lines.join('\n');
  if (rendered.length > maxChars) {
    rendered = rendered.slice(0, maxChars - 20) + '\n… (truncated)';
  }
  return rendered;
}

function groupBy<T, K>(xs: T[], fn: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = fn(x);
    const arr = m.get(k);
    if (arr) arr.push(x); else m.set(k, [x]);
  }
  return m;
}

function prettyKind(k: UserFact['kind']): string {
  switch (k) {
    case 'profession':   return 'Profession';
    case 'context':      return 'Context';
    case 'project':      return 'Active projects';
    case 'preference':   return 'Preferences';
    case 'relationship': return 'Relationships';
  }
}
