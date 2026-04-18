// Load skills from disk. A skill is a directory under SKILLS_DIR named by the
// skill slug; it must contain SKILL.md (front-matter + body) and may contain
// examples.jsonl, evals.jsonl, tools.json, meta.json.
//
// See design.md §3.1.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import matter from 'gray-matter';

import { SKILLS_DIR } from '../config.js';
import type { Skill, SkillExample, SkillMeta } from './types.js';
import { skillFrontmatterSchema, skillMetaSchema } from './types.js';

export function ensureSkillsDir(): string {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
  const drafts = join(SKILLS_DIR, 'drafts');
  if (!existsSync(drafts)) mkdirSync(drafts, { recursive: true, mode: 0o700 });
  return SKILLS_DIR;
}

// Lists every skill directory in SKILLS_DIR (excluding 'drafts'). Skips dirs
// that do not contain SKILL.md rather than throwing, so one bad skill doesn't
// break the whole registry.
export function listSkillDirs(): string[] {
  ensureSkillsDir();
  const out: string[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    if (entry === 'drafts') continue;
    const full = join(SKILLS_DIR, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      if (!existsSync(join(full, 'SKILL.md'))) continue;
      out.push(full);
    } catch { /* unreadable; skip */ }
  }
  return out;
}

export function loadSkill(path: string): Skill | null {
  const id = basename(path);
  const skillPath = join(path, 'SKILL.md');
  if (!existsSync(skillPath)) return null;

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(readFileSync(skillPath, 'utf8'));
  } catch {
    return null;
  }

  const fm = skillFrontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    // eslint-disable-next-line no-console
    console.warn(`skill ${id}: invalid front-matter`, fm.error.issues[0]?.message);
    return null;
  }

  const meta = loadMeta(path);
  const examples = loadExamples(path);

  return {
    id,
    path,
    frontmatter: fm.data,
    body: parsed.content.trim(),
    meta,
    examples,
  };
}

export function loadAllSkills(): Skill[] {
  const skills: Skill[] = [];
  for (const dir of listSkillDirs()) {
    const s = loadSkill(dir);
    if (s) skills.push(s);
  }
  return skills;
}

export function loadMeta(skillPath: string): SkillMeta {
  const metaPath = join(skillPath, 'meta.json');
  if (!existsSync(metaPath)) {
    const blank = skillMetaSchema.parse({});
    return blank;
  }
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'));
    const parsed = skillMetaSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch { /* fall through */ }
  return skillMetaSchema.parse({});
}

export function saveMeta(skillPath: string, meta: SkillMeta): void {
  writeFileSync(join(skillPath, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
}

function loadExamples(skillPath: string): SkillExample[] {
  const p = join(skillPath, 'examples.jsonl');
  if (!existsSync(p)) return [];
  const out: SkillExample[] = [];
  const lines = readFileSync(p, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.input === 'string') {
        out.push({
          input: obj.input,
          output: typeof obj.output === 'string' ? obj.output : undefined,
          tool_sequence: Array.isArray(obj.tool_sequence) ? obj.tool_sequence : undefined,
        });
      }
    } catch { /* skip bad line */ }
  }
  return out;
}

// Stable content hash for SKILL.md + examples so we know when to re-embed.
export function skillContentHash(skill: Skill): string {
  const h = createHash('sha256');
  h.update(skill.frontmatter.name);
  h.update('\n---\n');
  h.update(skill.frontmatter.description);
  h.update('\n---\n');
  h.update(skill.body);
  h.update('\n---\n');
  for (const e of skill.examples) {
    h.update(e.input);
    h.update('\n');
    if (e.output) h.update(e.output);
  }
  return h.digest('hex').slice(0, 16);
}
