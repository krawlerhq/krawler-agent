// Shell tool for the chat agent. Gives the model a single
// shell(command, cwd?) tool that runs a command via /bin/sh -c on
// the human's machine, captures stdout/stderr, and returns the
// result. Safety model is config-gated (not per-call prompted):
//
//   * config.shell.enabled defaults to false. The tool is ALWAYS
//     registered with the model so it can tell the human how to
//     enable it; execute() refuses when the flag is off and returns
//     a plain-text hint.
//   * config.shell.timeoutSeconds (default 30) kills the command.
//   * config.shell.maxOutputBytes (default 20_000) caps each of
//     stdout/stderr independently. Overflow flips truncated=true.
//
// Why config-gated instead of per-call confirm in the UI: matches
// the existing "keys live in config, not chat" pattern; the trust
// decision happens once in a text editor the human controls, not
// every turn. Per-call confirm can land later if we want the tighter
// audit trail; design.md has a note.
//
// Output is returned to the model as a structured object; the Ink
// ToolCall row renders `$ <cmd>` on start and the exit-code summary
// on end. Full stdout/stderr appears in the tool-result stream to
// the model, NOT on the terminal — keeping long outputs from
// flooding the chat. If the human needs raw output they can ask
// the agent to print it.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import { tool } from 'ai';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import type { ToolRenderHooks } from './tools.js';

export interface ShellResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  command: string;
  cwd: string;
}

export function buildShellTools(hooks: ToolRenderHooks) {
  return {
    shell: tool({
      description: 'Run a shell command on the human\'s machine via /bin/sh -c. Returns { exitCode, stdout, stderr, timedOut, ... }. Pipes, redirects, and shell syntax all work. Use for local reads (ls, git status, grep, cat, date, uname), small scripts, and inspection. Do NOT run sudo (stdin is not captured; it hangs). Do NOT assume a command is safe because the shell flag is enabled — think twice before rm / mv / destructive edits, and explain your plan to the human first when it matters. The tool is OFF by default; when disabled, the result tells you how the human can enable it — pass that message along, don\'t retry.',
      inputSchema: z.object({
        command: z.string().min(1).max(4000).describe('Shell command. Example: "ls ~/Downloads", "git status", "grep -r TODO src/", "date +%s". No sudo.'),
        cwd: z.string().max(512).optional().describe('Working directory for the command. Defaults to the process cwd. "~" and "$HOME" are expanded.'),
      }),
      execute: async ({ command, cwd }) => {
        const config = loadConfig();
        if (!config.shell?.enabled) {
          hooks.onToolStart('shell', `$ ${command}`);
          const reason = 'shell tool is disabled. Ask the human if they want to turn it on (they can say "turn on shell access" and you will call the setShellEnabled tool); or they can edit ~/.config/krawler-agent/config.json and set shell.enabled = true. Do NOT retry until enabled.';
          hooks.onToolEnd('shell', 'disabled', false);
          return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: reason,
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            command,
            cwd: cwd ?? process.cwd(),
            disabled: true,
          } satisfies ShellResult & { disabled: true };
        }
        const timeoutMs = (config.shell.timeoutSeconds ?? 30) * 1000;
        const maxBytes = config.shell.maxOutputBytes ?? 20_000;
        const resolvedCwd = (cwd ?? process.cwd())
          .replace(/^~(\/|$)/, `${homedir()}$1`)
          .replace(/^\$HOME(\/|$)/, `${homedir()}$1`);
        hooks.onToolStart('shell', `$ ${command}`);
        try {
          const result = await runShell(command, resolvedCwd, timeoutMs, maxBytes);
          const outcome = result.timedOut
            ? `timed out after ${config.shell.timeoutSeconds}s`
            : `exit ${result.exitCode}`;
          hooks.onToolEnd('shell', outcome, result.ok);
          return result;
        } catch (e) {
          hooks.onToolEnd('shell', `failed: ${(e as Error).message}`, false);
          throw e;
        }
      },
    }),
  };
}

function runShell(command: string, cwd: string, timeoutMs: number, maxBytes: number): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd });
    } catch (e) {
      resolvePromise({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: (e as Error).message,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        command,
        cwd,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const absorb = (chunk: Buffer, which: 'out' | 'err') => {
      const s = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length >= maxBytes) { stdoutTruncated = true; return; }
        const room = maxBytes - stdout.length;
        if (s.length <= room) stdout += s;
        else { stdout += s.slice(0, room); stdoutTruncated = true; }
      } else {
        if (stderr.length >= maxBytes) { stderrTruncated = true; return; }
        const room = maxBytes - stderr.length;
        if (s.length <= room) stderr += s;
        else { stderr += s.slice(0, room); stderrTruncated = true; }
      }
    };
    child.stdout.on('data', (c: Buffer) => absorb(c, 'out'));
    child.stderr.on('data', (c: Buffer) => absorb(c, 'err'));
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      // Hard kill if SIGTERM doesn't take within 2s.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolvePromise({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        command,
        cwd,
      });
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      resolvePromise({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + e.message,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        command,
        cwd,
      });
    });
  });
}
