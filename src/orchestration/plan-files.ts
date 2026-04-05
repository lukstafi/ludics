import { join } from "path";

export type PlanFileType = "plan" | "merged";

export interface ParsedPlanFilename {
  type: PlanFileType;
  round: number;
  agentName?: string;
  mergeRound?: number;
}

const AGENT_NAME_RE = /^[\w-]+$/;
const PLAN_RE = /^round-(\d+)-([\w-]+)\.md$/;
const MERGED_RE = /^round-(\d+)-merged-(\d+)\.md$/;

/** Build a plan filename from components. */
export function planFilename(type: "plan", round: number, agentName: string): string;
export function planFilename(type: "merged", round: number, mergeRound: number): string;
export function planFilename(type: PlanFileType, round: number, third: string | number): string {
  if (type === "merged") {
    return `round-${round}-merged-${third}.md`;
  }
  const agentName = third as string;
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(`invalid agent name for plan filename: "${agentName}" (must match [\\w-]+)`);
  }
  return `round-${round}-${agentName}.md`;
}

/** Build a full plan file path under plans/. */
export function planFilePath(peerSyncDir: string, type: "plan", round: number, agentName: string): string;
export function planFilePath(peerSyncDir: string, type: "merged", round: number, mergeRound: number): string;
export function planFilePath(peerSyncDir: string, type: PlanFileType, round: number, third: string | number): string {
  return join(peerSyncDir, "plans", (planFilename as Function)(type, round, third));
}

/** Parse a plan filename into components, or null if it doesn't match. */
export function parsePlanFilename(filename: string): ParsedPlanFilename | null {
  // Try merged first — "merged" is a valid agent name in the plan regex,
  // so we need to check the more specific pattern first.
  let m = filename.match(MERGED_RE);
  if (m) return { type: "merged", round: parseInt(m[1]!, 10), mergeRound: parseInt(m[2]!, 10) };
  m = filename.match(PLAN_RE);
  if (m) return { type: "plan", round: parseInt(m[1]!, 10), agentName: m[2]! };
  return null;
}
