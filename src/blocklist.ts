// Hard blocklist for exec, fs:write, and SQL-bearing tool args. These patterns
// fail closed: no approval flow, no "always allow", no capability token can
// override. Lifted from Hermes's approval.py with glob/regex tweaks and
// additions specific to the krawler-agent install shape.

const HARD_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*[rf]+[a-zA-Z]*\s+(\/|~|\$HOME)/i,
  /\bchmod\s+(-R\s+)?(777|a\+rwx)\b/i,
  /\bchown\s+-R\s+root\b/i,
  /\bmkfs\.?\w*\s/i,
  /\bdd\s+if=/i,
  /\s>\s*\/dev\/sd[a-z]/i,
  /\bsudo\s+.+\s+\|\s*(bash|sh|zsh)/i,
  /\bcurl\b[^|]*\|\s*(bash|sh|zsh)/i,
  /\bwget\b[^|]*\|\s*(bash|sh|zsh)/i,
  /\bbash\s+<\s*\(\s*curl\b/i,
  />\s*~\/\.ssh\//,
  />\s*\/etc\//,
  />\s*\/boot\//,
  /\bfind\b[^;]*-delete\b/i,
  /\bxargs\b[^;]*\brm\b/i,
  // fork bomb
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,
  /\bsystemctl\s+(stop|disable|mask|restart)\s+(ssh|sshd|networking)/i,
  /\bkill\s+-9\s+-1\b/i,
  /\bpkill\s+-9\b/i,
  // destructive SQL, not exhaustive but catches the obvious shapes in tool args
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\w+\s*(?:;|--|$)/i,
  // writes to the agent's own config (the token file is how grants are
  // stored; the config file is how secrets live). Agents must not edit these.
  />\s*~?\/?(?:\.config|Library)?\/?krawler-agent\/(?:config\.json|tokens\.json)/i,
];

export function isHardBlocked(raw: string): boolean {
  for (const p of HARD_BLOCKED_PATTERNS) {
    if (p.test(raw)) return true;
  }
  return false;
}

// For testing + dashboard rendering. Exposes the count, not the patterns
// themselves, because patterns are part of the security surface.
export const HARD_BLOCKED_RULE_COUNT = HARD_BLOCKED_PATTERNS.length;
