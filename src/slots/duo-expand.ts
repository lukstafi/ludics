/**
 * Shared helper for expanding a single duo intent into two pair-mode slot assignments.
 * Used by both maybeFillEmptySlots() (auto-fill) and the slot assign CLI (manual).
 */

import { loadConfigSync } from "../config.ts";

export interface DuoExpansion {
  slotA: { slot: number; args: string };
  slotB: { slot: number; args: string };
}

/**
 * Strip any existing --pair, --duo, --coder, --reviewer flags from baseArgs.
 * Returns only the non-mode/non-role fragments (e.g. --plan, --gather, --effort).
 */
function stripModeAndRoleFlags(baseArgs: string): string {
  return baseArgs
    .split(/\s+/)
    .filter((tok) => {
      if (tok === "--pair" || tok === "--duo") return false;
      if (tok.startsWith("--coder") || tok.startsWith("--reviewer")) return false;
      if (tok.startsWith("--agent")) return false;
      return true;
    })
    .join(" ")
    .trim();
}

/**
 * Given two available slot numbers and the base adapter args,
 * produce two pair-mode arg strings with swapped coder/reviewer and --duo-peer-slot.
 *
 * Reads default_coder / default_reviewer from config to determine the providers.
 * The base args may include phase flags (--plan, --gather) and effort/model overrides
 * which are preserved on both slots.
 */
export function expandDuoSlots(
  slotA: number,
  slotB: number,
  baseArgs: string,
): DuoExpansion {
  let coder = "claude-code";
  let reviewer = "codex";
  try {
    const config = loadConfigSync();
    const mag = config.mag as Record<string, unknown> | undefined;
    const orch = mag?.orchestration as Record<string, unknown> | undefined;
    if (orch?.default_coder) coder = String(orch.default_coder).trim();
    if (orch?.default_reviewer) reviewer = String(orch.default_reviewer).trim();
  } catch {
    // use defaults
  }

  // Extract coder/reviewer from existing args if explicitly provided (e.g. --coder codex:model)
  const coderMatch = baseArgs.match(/--coder\s+(\S+)/);
  const reviewerMatch = baseArgs.match(/--reviewer\s+(\S+)/);
  if (coderMatch) coder = coderMatch[1]!;
  if (reviewerMatch) reviewer = reviewerMatch[1]!;

  const extras = stripModeAndRoleFlags(baseArgs);

  const argsA = [
    "--pair",
    `--coder ${coder}`,
    `--reviewer ${reviewer}`,
    `--duo-peer-slot=${slotB}`,
    extras,
  ].filter(Boolean).join(" ");

  const argsB = [
    "--pair",
    `--coder ${reviewer}`,
    `--reviewer ${coder}`,
    `--duo-peer-slot=${slotA}`,
    extras,
  ].filter(Boolean).join(" ");

  return {
    slotA: { slot: slotA, args: argsA },
    slotB: { slot: slotB, args: argsB },
  };
}
