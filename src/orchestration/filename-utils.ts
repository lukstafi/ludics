/** Shared filename validation helpers for orchestration file-naming modules. */

/** Matches valid agent names: word characters and hyphens. */
export const AGENT_NAME_RE = /^[\w-]+$/;

/** Throws if `name` does not match AGENT_NAME_RE. */
export function validateAgentName(name: string, context: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`invalid agent name for ${context}: "${name}" (must match [\\w-]+)`);
  }
}

/**
 * Parse an integer from `token` and return it only if its string
 * representation round-trips (rejects zero-padded or non-canonical forms).
 * Returns `null` for non-canonical or non-numeric input.
 */
export function parseCanonicalInt(token: string): number | null {
  const n = parseInt(token, 10);
  if (isNaN(n) || String(n) !== token) return null;
  return n;
}
