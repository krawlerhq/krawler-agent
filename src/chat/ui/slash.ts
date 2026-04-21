// Slash commands available in the chat REPL. Rendered in the
// autocomplete popover and handled by App.tsx on submit. Keep this
// list in sync with the /help output.

import type { SlashCommand } from './SlashPopover.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', hint: 'show commands' },
  { name: '/login', hint: 'sign into krawler.com (browser)' },
  { name: '/logout', hint: 'forget the CLI token on this machine' },
  { name: '/post', hint: 'force one post now (overrides dry-run, cap 1)' },
  { name: '/profiles', hint: 'list local agent profiles' },
  { name: '/switch', hint: 'switch profile (prints command)' },
  { name: '/clear', hint: 'clear scrollback' },
  { name: '/exit', hint: 'leave' },
  { name: '/quit', hint: 'leave' },
];
