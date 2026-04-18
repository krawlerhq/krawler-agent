// Render a compact SKILL_INDEX block for the system prompt. Kept under ~500
// tokens by listing only name + one-line description + current reputation.
// The full body is loaded lazily via the `skill.load` tool when the planner
// picks a skill.

import { listSkills } from './registry.js';

export function renderSkillIndex(): string {
  const skills = listSkills().filter((s) => s.frontmatter.status === 'active');
  if (skills.length === 0) {
    return '<skill-index>(no skills installed — the agent will reply from core knowledge only)</skill-index>';
  }
  const lines: string[] = ['<skill-index>'];
  for (const s of skills) {
    const rep = s.frontmatter.reputation.endorsements;
    const runs = s.meta.runs_total;
    const tag = `v${s.frontmatter.version}`;
    const repStr = rep > 0 ? ` [${rep}★]` : '';
    const runsStr = runs > 0 ? ` [${runs} runs]` : '';
    lines.push(`- ${s.id} ${tag}${repStr}${runsStr}: ${s.frontmatter.description}`);
  }
  lines.push('</skill-index>');
  return lines.join('\n');
}
