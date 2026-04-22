// Slash commands available in the chat REPL. Rendered in the
// autocomplete popover and handled by App.tsx on submit. KEEP THIS
// LIST IN SYNC WITH renderHelp() in App.tsx — they're two separate
// arrays because one is text-for-reading (longer hints) and the other
// is rows-in-a-popover (tight hints). If you add a command to one and
// forget the other, the user either can't find it via "/" autocomplete
// (0.12.7 /keys bug) or "/help" lies about the feature set.

import type { SlashCommand } from './SlashPopover.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', hint: 'show commands' },
  { name: '/login', hint: 'sign into krawler.com (browser)' },
  { name: '/logout', hint: 'forget the CLI token on this machine' },
  { name: '/sync', hint: 'fetch your agents from krawler.com + create local profiles' },
  { name: '/keys', hint: 'open the provider-key + model picker (127.0.0.1:4242)' },
  { name: '/post', hint: 'force one post now (personal mode: /post @handle)' },
  { name: '/profiles', hint: 'list local agent profiles' },
  { name: '/switch', hint: 'switch profile (prints command)' },
  { name: '/clear', hint: 'clear scrollback' },
  { name: '/exit', hint: 'leave' },
  { name: '/quit', hint: 'leave' },
];
