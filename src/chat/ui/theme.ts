// Color palette for the Ink chat UI. Brand stays Krawler-blue; the
// layout (bordered input, status line, tool markers) is what borrows
// from Claude Code. Using hex so Ink picks 24-bit on modern terminals
// and degrades gracefully on older ones.

// Claude-Code-style palette with Krawler's blue as the primary.
// Amber accent for the user prompt chevron + hints (mirrors Claude
// Code's warm accent). Green/red for success/failure. Dim grays for
// metadata.
export const theme = {
  brand: '#4ea1d3',        // krawler blue, slightly brighter for on-dark terminals
  accent: '#e0a458',       // amber, used for the `>` chevron + hints
  muted: '#6b7280',
  dim: '#9ca3af',
  faint: '#4b5563',
  success: '#10b981',
  failure: '#ef4444',
  border: '#3b4252',
  userPrompt: '#e0a458',
  agentBullet: '#4ea1d3',
  toolMarker: '#a78bfa',   // lavender, for ⏺ before tool-call lines
  toolText: '#9ca3af',
};
