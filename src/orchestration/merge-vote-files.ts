import { join } from "path";
import { validateAgentName, parseCanonicalInt } from "./filename-utils";

const MERGE_VOTE_RE = /^round-(\d+)-([\w-]+)\.txt$/;

/** Build a merge vote filename. */
export function mergeVoteFilename(round: number, agentName: string): string {
  validateAgentName(agentName, "merge vote filename");
  return `round-${round}-${agentName}.txt`;
}

/** Build a full merge vote file path under merge-votes/. */
export function mergeVoteFilePath(peerSyncDir: string, round: number, agentName: string): string {
  return join(peerSyncDir, "merge-votes", mergeVoteFilename(round, agentName));
}

/** Parse a merge vote filename into components, or null if it doesn't match. */
export function parseMergeVoteFilename(filename: string): { round: number; agentName: string } | null {
  const m = filename.match(MERGE_VOTE_RE);
  if (!m) return null;
  const round = parseCanonicalInt(m[1]!);
  if (round === null) return null;
  return { round, agentName: m[2]! };
}
