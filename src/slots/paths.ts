// Extract slot paths from per-slot JSON files for session classification

import { existsSync } from "fs";
import type { SlotPath } from "../types.ts";
import { readAllSlotJson } from "./json.ts";
import { slotsCount } from "../config.ts";

/** Parse git section body (no header) for working directory paths. */
function extractGitPathsFromString(content: string | undefined): string[] {
  if (!content) return [];
  const paths: string[] = [];
  for (const line of content.split("\n")) {
    const wdMatch = line.match(/Working directory:\s*(.+?)(?:\s*\(worktree\))?$/);
    if (wdMatch) {
      const p = wdMatch[1].trim();
      if (p) paths.push(p);
    }
    const wtMatch = line.match(/worktree:\s*(.+)$/);
    if (wtMatch) {
      const p = wtMatch[1].trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

export async function extractSlotPaths(harness: string): Promise<SlotPath[]> {
  const count = slotsCount();
  const slots = readAllSlotJson(count, harness);
  const results: SlotPath[] = [];

  for (const [, data] of slots) {
    if (!data.mode) continue;
    if (data.path) {
      results.push({ slot: data.slot, path: data.path });
      continue;
    }
    const gitPaths = extractGitPathsFromString(data.git);
    if (gitPaths.length > 0) {
      for (const p of gitPaths) {
        results.push({ slot: data.slot, path: p });
      }
      continue;
    }
    if (data.session) {
      if (data.session.startsWith("/") && existsSync(data.session)) {
        results.push({ slot: data.slot, path: data.session });
      } else {
        const homePath = `${process.env.HOME}/${data.session}`;
        if (existsSync(homePath)) {
          results.push({ slot: data.slot, path: homePath });
        }
      }
    }
  }
  return results;
}
