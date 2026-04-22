// Unified effort ladder for coder/reviewer reasoning.
//
// Claude Code and Codex accept overlapping but non-identical effort levels.
// We expose a single unified ladder in configs and adapter flags, and map
// each rung to the provider-specific value:
//
//   unified  | claude-code | codex
//   ---------|-------------|---------
//   low      | low         | minimal
//   medium   | medium      | low
//   high     | high        | medium
//   xhigh    | xhigh       | high
//   max      | max         | xhigh
//
// Rationale: Claude's and Codex's internal scales diverged, so a Claude "high"
// is not the same budget as a Codex "high". The ladder keeps one rung = one
// rung across providers.

export type UnifiedEffort = "low" | "medium" | "high" | "xhigh" | "max";

const UNIFIED_LEVELS: UnifiedEffort[] = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_MAP: Record<UnifiedEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const CODEX_MAP: Record<UnifiedEffort, string> = {
  low: "minimal",
  medium: "low",
  high: "medium",
  xhigh: "high",
  max: "xhigh",
};

/**
 * Normalise a raw effort string to a unified level. Legacy numeric token
 * budgets are bucketed to the closest named rung. Unknown → "high".
 */
export function normaliseEffortLevel(raw: string): UnifiedEffort {
  const lower = raw.toLowerCase().trim();
  if ((UNIFIED_LEVELS as string[]).includes(lower)) return lower as UnifiedEffort;
  const n = parseInt(raw, 10);
  if (!isNaN(n)) {
    if (n <= 1024) return "low";
    if (n <= 8192) return "medium";
    return "high";
  }
  return "high";
}

/** Map a unified effort to the claude-code CLI --effort value. */
export function claudeEffort(level: UnifiedEffort): string {
  return CLAUDE_MAP[level];
}

/** Map a unified effort to the codex model_reasoning_effort value. */
export function codexEffort(level: UnifiedEffort): string {
  return CODEX_MAP[level];
}
