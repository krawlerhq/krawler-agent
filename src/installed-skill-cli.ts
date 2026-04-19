// `krawler skill` subcommands for the github-sourced installed-skills
// flow (not the v1.0 routing playbooks, which live under
// `krawler playbook` now). Each command operates on the cache under
// ~/.config/krawler-agent/{profile}/installed-skills/ populated by the
// heartbeat loop (see src/skill-refs.ts).
//
// Subcommands:
//   list                 tabular view of what's installed on this profile
//   show <slug>          print the local SKILL.md body
//   sync <slug>          re-pull upstream into the local copy
//
// Future (behind GH-auth work):
//   pr <slug>            open a pull request to upstream with local edits

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';

import { getInstalledSkillsDir } from './config.js';
import { listInstalledSkills, rawUrlForSkill } from './skill-refs.js';

interface LocalSkillMeta {
  origin: string;
  title?: string;
  path?: string;
  installedAt: string;
  lastSyncedAt: string;
  lastSyncHash: string;
}

function loadLocalBody(slug: string): string | null {
  const p = join(getInstalledSkillsDir(), slug, 'SKILL.md');
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function loadLocalMeta(slug: string): LocalSkillMeta | null {
  const p = join(getInstalledSkillsDir(), slug, 'meta.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as LocalSkillMeta; } catch { return null; }
}

function relTime(iso: string | undefined): string {
  if (!iso) return '?';
  const d = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function registerInstalledSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage the github-sourced skills this agent has installed. Each skill lives locally under the profile dir and may diverge from upstream over time.');

  skill
    .command('list')
    .description('Show every installed skill on this profile with install time, size, and whether the local copy has diverged from upstream.')
    .action(() => {
      const skills = listInstalledSkills();
      if (skills.length === 0) {
        // eslint-disable-next-line no-console
        console.log('(no installed skills on this profile)');
        return;
      }
      const w = Math.max(...skills.map((s) => s.slug.length));
      for (const s of skills) {
        const installedAt = s.meta ? relTime(s.meta.installedAt) : '?';
        const status = s.edited ? 'edited' : 'clean ';
        const origin = s.meta ? s.meta.origin : '(no meta)';
        // eslint-disable-next-line no-console
        console.log(`${s.slug.padEnd(w)}  ${status}  ${String(s.bodyBytes).padStart(6)}B  ${installedAt.padEnd(10)}  ${origin}`);
      }
    });

  skill
    .command('show <slug>')
    .description('Print the local SKILL.md body for one installed skill.')
    .action((slug: string) => {
      const body = loadLocalBody(slug);
      if (body === null) {
        // eslint-disable-next-line no-console
        console.error(`no installed skill with slug "${slug}". run "krawler skill list" to see what is installed.`);
        process.exit(2);
      }
      // eslint-disable-next-line no-console
      console.log(body);
    });

  skill
    .command('sync <slug>')
    .description('Re-pull the upstream SKILL.md from its origin URL and overwrite the local copy. Refuses by default if the local copy has diverged; pass --force to overwrite local edits.')
    .option('--force', 'overwrite local edits even if the local body has diverged from the upstream-at-install version')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const meta = loadLocalMeta(slug);
      const body = loadLocalBody(slug);
      if (!meta || !body) {
        // eslint-disable-next-line no-console
        console.error(`no installed skill with slug "${slug}". run "krawler skill list" to see what is installed.`);
        process.exit(2);
        return;
      }
      const { createHash } = await import('node:crypto');
      const currentHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const localDiverged = currentHash !== meta.lastSyncHash;
      if (localDiverged && !opts.force) {
        // eslint-disable-next-line no-console
        console.error(
          `${slug}: local copy has diverged from the install-time body. Pass --force to overwrite local edits, or run "krawler skill pr ${slug}" (future) to send them upstream.`,
        );
        process.exit(3);
        return;
      }
      const raw = rawUrlForSkill(meta.origin);
      const res = await fetch(raw, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`fetch ${raw} failed with HTTP ${res.status}`);
        process.exit(4);
        return;
      }
      const next = await res.text();
      const nextHash = createHash('sha256').update(next).digest('hex').slice(0, 16);
      writeFileSync(join(getInstalledSkillsDir(), slug, 'SKILL.md'), next, { mode: 0o600 });
      const newMeta: LocalSkillMeta = {
        ...meta,
        lastSyncedAt: new Date().toISOString(),
        lastSyncHash: nextHash,
      };
      writeFileSync(join(getInstalledSkillsDir(), slug, 'meta.json'), JSON.stringify(newMeta, null, 2) + '\n', { mode: 0o600 });
      const changed = nextHash !== currentHash;
      // eslint-disable-next-line no-console
      console.log(`${slug}: synced from ${meta.origin}  (${changed ? 'body changed' : 'body unchanged'}${opts.force && localDiverged ? ', local edits overwritten' : ''})`);
    });
}
