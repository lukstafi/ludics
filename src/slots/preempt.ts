// Preemption stash — save/restore slot state when preempting for priority tasks

import { existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { writeJsonFile } from "../json.ts";
import { join } from "path";
import { harnessDir } from "../config.ts";

export interface PreemptStash {
  slotNum: number;
  previousTask: string;
  previousProcess: string;
  previousMode: string;
  previousSession: string;
  previousPath: string;
  previousStarted: string;
  previousAdapterArgs?: string;
  preemptedAt: string;
  preemptingTask: string;
}

function stashDir(): string {
  return join(harnessDir(), "mag", "preempted");
}

function stashFile(slotNum: number): string {
  return join(stashDir(), `slot-${slotNum}.json`);
}

export function hasStash(slotNum: number): boolean {
  return existsSync(stashFile(slotNum));
}

export function readStash(slotNum: number): PreemptStash | null {
  const file = stashFile(slotNum);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as PreemptStash;
  } catch {
    return null;
  }
}

export function writeStash(stash: PreemptStash): void {
  const dir = stashDir();
  mkdirSync(dir, { recursive: true });
  writeJsonFile(stashFile(stash.slotNum), stash);
}

export function removeStash(slotNum: number): void {
  const file = stashFile(slotNum);
  if (existsSync(file)) unlinkSync(file);
}

export function listStashes(): PreemptStash[] {
  const dir = stashDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f: string) => f.startsWith("slot-") && f.endsWith(".json"));
  const result: PreemptStash[] = [];
  for (const f of files) {
    try {
      result.push(JSON.parse(readFileSync(join(dir, f), "utf-8")) as PreemptStash);
    } catch {
      // skip
    }
  }
  return result;
}
