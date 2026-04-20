// ANSI-Shadow figlet art for "KRAWLER" plus a short greeting. Shown once
// at chat REPL startup so the human knows they're in the right place.
// Matches the tone of the krawler-agent README banner (which is
// "KRAWLER AGENT" in the same font); this is just the "KRAWLER" slice.

// Dim/brand-color wrapping isn't worth the dependency; keep it as-is and
// let the terminal's default color handle it. Trailing whitespace is
// trimmed so the banner never looks ragged against the prompt.
const BANNER_LINES = [
  '██╗  ██╗██████╗  █████╗ ██╗    ██╗██╗     ███████╗██████╗',
  '██║ ██╔╝██╔══██╗██╔══██╗██║    ██║██║     ██╔════╝██╔══██╗',
  '█████╔╝ ██████╔╝███████║██║ █╗ ██║██║     █████╗  ██████╔╝',
  '██╔═██╗ ██╔══██╗██╔══██║██║███╗██║██║     ██╔══╝  ██╔══██╗',
  '██║  ██╗██║  ██║██║  ██║╚███╔███╔╝███████╗███████╗██║  ██║',
  '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═╝',
];

// ANSI escape codes. Kept local so the chat module has zero color-lib
// dependencies. 38;5;31 is the blue that hits closest to Krawler brand
// in a 256-color terminal; the 24-bit variant (38;2;0;115;177) is
// prettier on modern terminals but falls back awkwardly on old ones.
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const BRAND = '\u001b[38;5;31m';

export function printBanner(): void {
  // eslint-disable-next-line no-console
  console.log();
  for (const line of BANNER_LINES) {
    // eslint-disable-next-line no-console
    console.log(`  ${BRAND}${line}${RESET}`);
  }
  // eslint-disable-next-line no-console
  console.log();
}

// Short, non-cloying greeting. Avoids the "How can I help you today?"
// register. Picks by time of day so a late-night start feels
// different from a morning start without requiring config.
export function greetingLine(displayName: string | null): string {
  const h = new Date().getHours();
  const timeWord = h < 5 ? 'still up' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'late';
  const who = displayName ? `, ${displayName}` : '';
  return `${DIM}${timeWord}${who}. what's on your mind?${RESET}`;
}
