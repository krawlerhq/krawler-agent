#!/usr/bin/env node
// Smoke test for cross-provider model slug normalization (0.12.9).
//
// Covers two layers:
//   1. normalizeModelForProvider() is a pure function — assert every
//      (provider, stale-slug) pair repairs to a sane slug.
//   2. saveConfig({ provider: 'ollama' }) on a profile whose stored
//      model is anthropic/claude-opus-4.7 auto-resets the model so the
//      on-disk config never sits in a broken cross-provider state.
//
// Run: node scripts/smoke-normalize-model.mjs
// Expects dist/ to be built (`pnpm run build` first) or falls back to
// tsx-compiled source via `node --import tsx`.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect $HOME to a throwaway tmpdir so loadConfig/saveConfig touch
// only our scratch profile, never the user's real ~/.config.
const scratchHome = mkdtempSync(join(tmpdir(), 'krawler-smoke-'));
process.env.HOME = scratchHome;

const { normalizeModelForProvider, loadConfig, saveConfig } = await import('../dist/config.js');

let failures = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.error(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

// --- pure-function cases ---
// Ollama eating a leftover openrouter-style claude slug (the bug).
assert(
  'ollama + anthropic/claude-opus-4.7 → llama3.3',
  normalizeModelForProvider('ollama', 'anthropic/claude-opus-4.7'),
  'llama3.3',
);
// Ollama eating a bare anthropic slug.
assert(
  'ollama + claude-opus-4-7 → llama3.3',
  normalizeModelForProvider('ollama', 'claude-opus-4-7'),
  'llama3.3',
);
// Ollama eating a bare openai slug.
assert(
  'ollama + gpt-4o → llama3.3',
  normalizeModelForProvider('ollama', 'gpt-4o'),
  'llama3.3',
);
// Legit ollama tags left alone.
assert('ollama + llama3.3 unchanged', normalizeModelForProvider('ollama', 'llama3.3'), 'llama3.3');
assert('ollama + qwen2.5:14b unchanged', normalizeModelForProvider('ollama', 'qwen2.5:14b'), 'qwen2.5:14b');
assert('ollama + mistral:latest unchanged', normalizeModelForProvider('ollama', 'mistral:latest'), 'mistral:latest');

// Anthropic eating a foreign openrouter slug.
assert(
  'anthropic + openai/gpt-4o → claude-opus-4-7',
  normalizeModelForProvider('anthropic', 'openai/gpt-4o'),
  'claude-opus-4-7',
);
// Anthropic eating a bare gemini slug.
assert(
  'anthropic + gemini-2.5-pro → claude-opus-4-7',
  normalizeModelForProvider('anthropic', 'gemini-2.5-pro'),
  'claude-opus-4-7',
);
// Anthropic repairing a dotted version (pre-existing behavior).
assert(
  'anthropic + claude-opus-4.7 → claude-opus-4-7',
  normalizeModelForProvider('anthropic', 'claude-opus-4.7'),
  'claude-opus-4-7',
);

// OpenAI eating a foreign slug.
assert(
  'openai + anthropic/claude-opus-4.7 → gpt-4o',
  normalizeModelForProvider('openai', 'anthropic/claude-opus-4.7'),
  'gpt-4o',
);
assert('openai + gpt-4o unchanged', normalizeModelForProvider('openai', 'gpt-4o'), 'gpt-4o');
assert('openai + o1-mini unchanged', normalizeModelForProvider('openai', 'o1-mini'), 'o1-mini');

// Google eating a foreign slug.
assert(
  'google + claude-opus-4-7 → gemini-2.5-pro',
  normalizeModelForProvider('google', 'claude-opus-4-7'),
  'gemini-2.5-pro',
);
assert('google + gemini-2.5-flash unchanged', normalizeModelForProvider('google', 'gemini-2.5-flash'), 'gemini-2.5-flash');

// Openrouter repairs (pre-existing + new bare openai/google handling).
assert(
  'openrouter + claude-opus-4-7 → anthropic/claude-opus-4.7',
  normalizeModelForProvider('openrouter', 'claude-opus-4-7'),
  'anthropic/claude-opus-4.7',
);
assert(
  'openrouter + gpt-4o → openai/gpt-4o',
  normalizeModelForProvider('openrouter', 'gpt-4o'),
  'openai/gpt-4o',
);
assert(
  'openrouter + gemini-2.5-pro → google/gemini-2.5-pro',
  normalizeModelForProvider('openrouter', 'gemini-2.5-pro'),
  'google/gemini-2.5-pro',
);

// --- round-trip saveConfig ---
// 1. Prime the profile as anthropic/claude-opus-4.7 (i.e. openrouter-style).
saveConfig({ provider: 'openrouter', model: 'anthropic/claude-opus-4.7' });
const afterPrime = loadConfig();
assert('prime: provider=openrouter', afterPrime.provider, 'openrouter');
assert('prime: model=anthropic/claude-opus-4.7', afterPrime.model, 'anthropic/claude-opus-4.7');

// 2. Flip provider to ollama without touching model — this is the exact
//    broken state the user observed. saveConfig must reset the slug.
saveConfig({ provider: 'ollama' });
const afterFlip = loadConfig();
assert('flip: provider=ollama', afterFlip.provider, 'ollama');
assert('flip: model no longer cross-provider orphan', afterFlip.model, 'llama3.3');

// 3. Read config.json off disk to confirm the repair was persisted, not
//    only rewritten in memory by loadConfig.
const configPath = join(scratchHome, '.config', 'krawler-agent', 'config.json');
const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
assert('on-disk: provider=ollama', onDisk.provider, 'ollama');
assert('on-disk: model=llama3.3', onDisk.model, 'llama3.3');

// --- cleanup ---
rmSync(scratchHome, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
