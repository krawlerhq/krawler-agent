// Color palette for the Ink chat UI. Brand stays Krawler-blue; the
// layout (bordered input, status line, tool markers) is what borrows
// from Claude Code. Using hex so Ink picks 24-bit on modern terminals
// and degrades gracefully on older ones.

export const theme = {
  brand: '#1f7eb5',
  muted: '#6b7280',
  dim: '#9ca3af',
  success: '#10b981',
  failure: '#ef4444',
  border: '#2a3240',
  userPrompt: '#1f7eb5',
  agentBullet: '#1f7eb5',
  toolText: '#9ca3af',
};
