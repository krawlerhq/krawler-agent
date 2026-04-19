// `krawler skill` subcommands. Simple wrappers over the loader/registry/
// seeder. Installs from local paths for v1.0; remote installs land in v1.4
// when skill posts on krawler.com are endorsable.

import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { Command } from 'commander';

import { getSkillsDir } from '../config.js';
import { selectSkills } from './select.js';
import { refreshRegistry, listSkills, getSkill } from './registry.js';
import { seedIfEmpty } from './seed.js';
import { ensureSkillsDir, loadSkill } from './loader.js';

export function registerSkillCommands(program: Command): void {
  const skill = program.command('skill').description('Manage skills.');

  skill
    .command('list')
    .description('List installed skills with stats.')
    .action(async () => {
      ensureSkillsDir();
      seedIfEmpty();
      await refreshRegistry({ embed: false });
      const skills = listSkills();
      if (skills.length === 0) {
        // eslint-disable-next-line no-console
        console.log('(no skills installed)');
        return;
      }
      for (const s of skills) {
        // eslint-disable-next-line no-console
        console.log(
          `${s.id.padEnd(30)} v${s.frontmatter.version}  ` +
          `${s.frontmatter.status.padEnd(8)}  ` +
          `${s.meta.runs_total} runs  ` +
          `${s.frontmatter.description}`,
        );
      }
    });

  skill
    .command('show <id>')
    .description('Print a skill\'s SKILL.md body.')
    .action(async (id: string) => {
      ensureSkillsDir();
      seedIfEmpty();
      await refreshRegistry({ embed: false });
      const s = getSkill(id);
      if (!s) {
        // eslint-disable-next-line no-console
        console.error(`skill ${id} not found`);
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log(`# ${s.id} (v${s.frontmatter.version})\n`);
      // eslint-disable-next-line no-console
      console.log(s.frontmatter.description);
      // eslint-disable-next-line no-console
      console.log('\n---\n');
      // eslint-disable-next-line no-console
      console.log(s.body);
    });

  skill
    .command('install <source>')
    .description('Install a skill from a local directory path (v1.0). Remote install via krawler.com lands in v1.4.')
    .option('--as <id>', 'install under a different id than the source directory name')
    .action(async (source: string, opts: { as?: string }) => {
      const src = resolve(source);
      if (!existsSync(src) || !statSync(src).isDirectory()) {
        // eslint-disable-next-line no-console
        console.error(`not a directory: ${src}`);
        process.exit(1);
      }
      const loaded = loadSkill(src);
      if (!loaded) {
        // eslint-disable-next-line no-console
        console.error(`${src} does not look like a skill dir (missing or invalid SKILL.md)`);
        process.exit(1);
      }
      const targetId = opts.as ?? basename(src);
      ensureSkillsDir();
      const dest = join(getSkillsDir(), targetId);
      if (existsSync(dest)) {
        // eslint-disable-next-line no-console
        console.error(`already installed: ${targetId}. Remove first with 'krawler skill remove ${targetId}'.`);
        process.exit(1);
      }
      mkdirSync(dest, { recursive: true, mode: 0o700 });
      cpSync(src, dest, { recursive: true });
      // eslint-disable-next-line no-console
      console.log(`installed ${loaded.frontmatter.name} -> ${dest}`);
    });

  skill
    .command('seed')
    .description('Install the default v1.0 skill set if the skills dir is empty.')
    .action(async () => {
      const { seeded } = seedIfEmpty();
      if (seeded.length === 0) {
        // eslint-disable-next-line no-console
        console.log('no seeding needed (skills already present)');
      } else {
        // eslint-disable-next-line no-console
        console.log(`seeded: ${seeded.join(', ')}`);
      }
    });

  skill
    .command('select <query>')
    .description('Show what skill.select would rank for a given query. Useful for tuning triggers.')
    .option('-k <k>', 'how many candidates to print', '5')
    .option('--channel <channel>', 'simulate the inbound coming from a specific channel')
    .action(async (query: string, opts: { k: string; channel?: string }) => {
      ensureSkillsDir();
      seedIfEmpty();
      await refreshRegistry({ embed: true });
      const cands = await selectSkills(query, {
        k: Number(opts.k) || 5,
        channel: opts.channel,
      });
      if (cands.length === 0) {
        // eslint-disable-next-line no-console
        console.log('(no active skills match)');
        return;
      }
      for (const c of cands) {
        const reasons = c.reasons.map((r) => `${r.term}:${r.value.toFixed(3)}`).join(' ');
        // eslint-disable-next-line no-console
        console.log(`${c.score.toFixed(4)}  ${c.skill.id.padEnd(30)} ${reasons}`);
      }
    });
}
