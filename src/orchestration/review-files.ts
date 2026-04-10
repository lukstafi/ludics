import { join } from "path";
import { validateAgentName, parseCanonicalInt } from "./filename-utils";

export type ReviewFileType = "review" | "plan-review";

export interface ParsedReviewFilename {
  type: ReviewFileType;
  round: number;
  agentName: string;
}

const REVIEW_RE = /^round-(\d+)-([\w-]+)\.md$/;
const PLAN_REVIEW_RE = /^plan-merge-(\d+)-([\w-]+)\.md$/;

/** Build a review filename from components. */
export function reviewFilename(type: ReviewFileType, round: number, agentName: string): string {
  validateAgentName(agentName, "review filename");
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
    const round = parseCanonicalInt(m[1]!);
    if (round === null) return null;
    return { type: "review", round, agentName: m[2]! };
  }
  m = filename.match(PLAN_REVIEW_RE);
  if (m) {
    const round = parseCanonicalInt(m[1]!);
    if (round === null) return null;
    return { type: "plan-review", round, agentName: m[2]! };
  }
  return null;
}
