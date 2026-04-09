import { join } from "path";

export type ReviewFileType = "review" | "plan-review";

export interface ParsedReviewFilename {
  type: ReviewFileType;
  round: number;
  agentName: string;
}

const AGENT_NAME_RE = /^[\w-]+$/;
const REVIEW_RE = /^round-(\d+)-([\w-]+)\.md$/;
const PLAN_REVIEW_RE = /^plan-merge-(\d+)-([\w-]+)\.md$/;

/** Build a review filename from components. */
export function reviewFilename(type: ReviewFileType, round: number, agentName: string): string {
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(`invalid agent name for review filename: "${agentName}" (must match [\\w-]+)`);
  }
  return type === "plan-review"
    ? `plan-merge-${round}-${agentName}.md`
    : `round-${round}-${agentName}.md`;
}

/** Build a full review file path under reviews/. */
export function reviewFilePath(
  peerSyncDir: string, type: ReviewFileType, round: number, agentName: string,
): string {
  return join(peerSyncDir, "reviews", reviewFilename(type, round, agentName));
}

/** Parse a review filename into components, or null if it doesn't match. */
export function parseReviewFilename(filename: string): ParsedReviewFilename | null {
  let m = filename.match(REVIEW_RE);
  if (m) {
    const round = parseInt(m[1]!, 10);
    if (String(round) !== m[1]) return null;
    return { type: "review", round, agentName: m[2]! };
  }
  m = filename.match(PLAN_REVIEW_RE);
  if (m) {
    const round = parseInt(m[1]!, 10);
    if (String(round) !== m[1]) return null;
    return { type: "plan-review", round, agentName: m[2]! };
  }
  return null;
}
