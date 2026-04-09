import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseMergeVoteFilename } from "./merge-vote-files.ts";

export function readMergeVotes(
  peerSyncDir: string,
  round: number,
): Record<string, string> {
  const dir = join(peerSyncDir, "merge-votes");
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const parsed = parseMergeVoteFilename(entry);
    if (!parsed || parsed.round !== round) continue;
    const agent = parsed.agentName;
    const value = readFileSync(join(dir, entry), "utf-8").trim();
    if (value) out[agent] = value;
  }
  return out;
}

export function hasConsensus(votes: Record<string, string>): boolean {
  const values = Object.values(votes).filter(Boolean);
  if (values.length < 2) return false;
  return new Set(values).size === 1;
}

export function determineWinner(
  votes: Record<string, string>,
  debateRounds: number,
): string {
  const counts = new Map<string, number>();
  for (const value of Object.values(votes)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = "";
  let bestCount = -1;
  for (const [candidate, count] of counts.entries()) {
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  if (best) return best;
  if (debateRounds > 0) return Object.values(votes)[0] ?? "";
  return "";
}
