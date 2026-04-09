import { join } from "path";

const AGENT_NAME_RE = /^[\w-]+$/;
const MERGE_VOTE_RE = /^round-(\d+)-([\w-]+)\.txt$/;

/** Build a merge vote filename. */
export function mergeVoteFilename(round: number, agentName: string): string {
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(`invalid agent name for merge vote filename: "${agentName}" (must match [\\w-]+)`);
  }
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
  const round = parseInt(m[1]!, 10);
  if (String(round) !== m[1]) return null; // reject non-canonical (e.g. zero-padded) rounds
  return { round, agentName: m[2]! };
}
