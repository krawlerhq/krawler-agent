// `krawler trajectories` CLI. Inspect the last N turns.

import { Command } from 'commander';

import { getDb } from '../db.js';
import { listRecentTurns } from './trajectory.js';

export function registerAgentCommands(program: Command): void {
  program
    .command('trajectories')
    .description('Print recent turns with tool-call counts and outcomes.')
    .option('--since <spec>', 'time window: 1h, 1d, 7d, or epoch ms', '1d')
    .option('--limit <n>', 'how many turns to show', '25')
    .option('--verbose', 'include inbound/outbound snippets')
    .action((opts: { since: string; limit: string; verbose?: boolean }) => {
      const sinceMs = parseSince(opts.since);
      const limit = Math.max(1, Math.min(500, Number(opts.limit) || 25));
      const turns = listRecentTurns({ sinceMs, limit });
      if (turns.length === 0) {
        // eslint-disable-next-line no-console
        console.log('(no turns in window)');
        return;
      }
      const db = getDb();
      const callCount = db.prepare(`SELECT COUNT(*) as n FROM tool_call WHERE turn_id = ?`);
      for (const t of turns) {
        const { n: nCalls } = callCount.get(t.id) as { n: number };
        const when = new Date(t.startedAt).toISOString().replace('T', ' ').slice(0, 19);
        const status = t.status.padEnd(9);
        const latency = t.latencyMs ? `${t.latencyMs}ms` : '...';
        const channel = t.channel.padEnd(9);
        const skills = t.skillIds.length ? t.skillIds.join(',') : '-';
        // eslint-disable-next-line no-console
        console.log(
          `${when}  ${channel}  ${status}  ${nCalls}tc  ${latency.padStart(7)}  skill=${skills}  ${t.id}`,
        );
        if (opts.verbose) {
          if (t.inboundText) {
            // eslint-disable-next-line no-console
            console.log(`    > ${trim(t.inboundText)}`);
          }
          if (t.outboundText) {
            // eslint-disable-next-line no-console
            console.log(`    < ${trim(t.outboundText)}`);
          }
        }
      }
    });
}

function parseSince(spec: string): number {
  const m = /^(\d+)([hdmw])$/.exec(spec);
  if (m && m[1] && m[2]) {
    const n = Number(m[1]);
    const unit = m[2];
    const mult = unit === 'h' ? 3600_000 : unit === 'd' ? 86_400_000 : unit === 'w' ? 7 * 86_400_000 : 60_000;
    return Date.now() - n * mult;
  }
  const asNum = Number(spec);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  return Date.now() - 86_400_000;
}

function trim(s: string): string {
  const oneLine = s.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? oneLine.slice(0, 137) + '...' : oneLine;
}
