import { join } from "path";
import { validateAgentName, parseCanonicalInt } from "./filename-utils";

export type PlanFileType = "plan" | "merged";

export interface ParsedPlanFilename {
  type: PlanFileType;
  round: number;
  agentName?: string;
  planMergeRound?: number;
}

const PLAN_RE = /^round-(\d+)-([\w-]+)\.md$/;
const MERGED_RE = /^round-(\d+)-merged-(\d+)\.md$/;

/** Build an individual plan filename. */
export function planFilename(round: number, agentName: string): string {
  validateAgentName(agentName, "plan filename");
  return `round-${round}-${agentName}.md`;
}

/** Build a merged plan filename. */
export function mergedPlanFilename(round: number, planMergeRound: number): string {
  return `round-${round}-merged-${planMergeRound}.md`;
}

/** Build a full individual plan file path under plans/. */
export function planFilePath(peerSyncDir: string, round: number, agentName: string): string {
  return join(peerSyncDir, "plans", planFilename(round, agentName));
}

/** Build a full merged plan file path under plans/. */
export function mergedPlanFilePath(peerSyncDir: string, round: number, planMergeRound: number): string {
  return join(peerSyncDir, "plans", mergedPlanFilename(round, planMergeRound));
}

/** Parse a plan filename into components, or null if it doesn't match. */
export function parsePlanFilename(filename: string): ParsedPlanFilename | null {
  // Try merged first — "merged" is a valid agent name in the plan regex,
  // so we need to check the more specific pattern first.
  let m = filename.match(MERGED_RE);
  if (m) {
    const round = parseCanonicalInt(m[1]!);
    const planMergeRound = parseCanonicalInt(m[2]!);
    if (round === null || planMergeRound === null) return null;
    return { type: "merged", round, planMergeRound };
  }
  m = filename.match(PLAN_RE);
  if (m) {
    const round = parseCanonicalInt(m[1]!);
    if (round === null) return null;
    return { type: "plan", round, agentName: m[2]! };
  }
  return null;
}
