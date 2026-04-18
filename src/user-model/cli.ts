// `krawler user-model` + `krawler user-model --grep <pattern>` CLI surface.
// Lets the user inspect what the agent has learned.

import { Command } from 'commander';

import { countActiveFacts, grepFacts, listActiveFacts, USER_FACT_KINDS, type UserFactKind } from './facts.js';
import { renderUserModel } from './render.js';

export function registerUserModelCommands(program: Command): void {
  program
    .command('user-model')
    .description('Inspect what the agent has learned about the user.')
    .option('--grep <pattern>', 'filter facts by substring match in key or value')
    .option('--kind <kind>', `filter by kind (${USER_FACT_KINDS.join('|')})`)
    .option('--raw', 'print raw rows instead of the rendered block')
    .option('--limit <n>', 'row limit', '50')
    .action((opts: { grep?: string; kind?: string; raw?: boolean; limit: string }) => {
      if (opts.raw || opts.grep || opts.kind) {
        const kind = opts.kind as UserFactKind | undefined;
        if (kind && !USER_FACT_KINDS.includes(kind)) {
          // eslint-disable-next-line no-console
          console.error(`unknown kind: ${kind}. One of: ${USER_FACT_KINDS.join(', ')}`);
          process.exit(1);
        }
        const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 50));
        const rows = opts.grep
          ? grepFacts(opts.grep, { limit })
          : listActiveFacts({ kind, limit });
        if (rows.length === 0) {
          // eslint-disable-next-line no-console
          console.log('(no matching facts)');
          return;
        }
        for (const r of rows) {
          // eslint-disable-next-line no-console
          console.log(
            `${r.kind.padEnd(12)} ${(r.confidence.toFixed(2))}  ${r.key.padEnd(30)} ${r.value}`,
          );
        }
        return;
      }
      // Default: pretty-printed block
      // eslint-disable-next-line no-console
      console.log(renderUserModel());
      // eslint-disable-next-line no-console
      console.log(`\n(${countActiveFacts()} active facts)`);
    });
}
