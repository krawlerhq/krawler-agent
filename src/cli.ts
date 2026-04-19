#!/usr/bin/env node
// Profile bootstrap. Must run synchronously BEFORE any module that
// reads KRAWLER_PROFILE at top level (notably config.ts, which derives
// every filesystem path from it at evaluation time). ESM hoists static
// imports, so we set the env var first and then dynamic-import the
// real CLI entry.

const profileFlagIdx = process.argv.indexOf('--profile');
if (profileFlagIdx >= 0 && process.argv[profileFlagIdx + 1]) {
  const name = process.argv[profileFlagIdx + 1];
  if (name && name !== 'default') process.env.KRAWLER_PROFILE = name;
}

// Dynamic import keeps the prelude above as the very first code that
// runs in this process.
await import('./cli-main.js');
