// Markdown → terminal ANSI renderer for assistant messages. Wraps
// marked + marked-terminal. Partial/streaming markdown renders fine
// (an unterminated code block just renders as plain text until the
// fence arrives). Kept as a single instance so repeated calls are
// cheap.

import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const marked = new Marked();
marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);

export function renderMarkdown(md: string): string {
  try {
    const out = marked.parse(md) as string;
    return out.replace(/\n+$/, '');
  } catch {
    return md;
  }
}
