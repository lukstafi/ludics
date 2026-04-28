// Per-slot JSON file read/write layer

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { harnessDir } from "../config.ts";
import { isPlainObject } from "../json.ts";
import type { SlotData } from "./types.ts";

/**
 * Normalize a raw `task` field (from slot JSON, markdown migration, or
 * frontmatter) into a real task identifier or `undefined`. Treats `null`,
 * `undefined`, the empty/whitespace string, and the legacy `"null"` sentinel
 * (case-insensitive) as absent.
 *
 * Single source of truth for the normalization that callers used to do inline
 * with `taskId && taskId !== "null"` checks.
 */
export function normalizeTaskId(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  return trimmed;
}

export function slotJsonDir(harness?: string): string {
  const h = harness ?? harnessDir();
  return join(h, "slots");
}

export function slotJsonPath(slot: number, harness?: string): string {
  return join(slotJsonDir(harness), `slot-${slot}.json`);
}

export function emptySlotData(slot: number): SlotData {
  return {
    slot,
    process: "(empty)",
    task: null,
    mode: null,
    session: null,
    path: null,
    started: null,
    adapterArgs: null,
    machine: null,
    sessionStarted: null,
    liveness: null,
    terminals: "",
    runtime: "",
    git: "",
  };
}

/** Read a single slot JSON file. Returns emptySlotData if absent; throws on corrupt JSON. */
export function readSlotJson(slot: number, harness?: string): SlotData {
  const file = slotJsonPath(slot, harness);
  if (!existsSync(file)) return emptySlotData(slot);
  const raw = readFileSync(file, "utf-8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`corrupt slot JSON: ${file}: parsed value is not an object`);
    }
    return parsed as unknown as SlotData;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("corrupt slot JSON:")) throw err;
    throw new Error(`corrupt slot JSON: ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Atomically write a slot JSON file (write tmp + rename). */
export function writeSlotJson(slot: number, data: SlotData, harness?: string): void {
  const dir = slotJsonDir(harness);
  mkdirSync(dir, { recursive: true });
  const file = slotJsonPath(slot, harness);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Read all slot JSON files (1..count). */
export function readAllSlotJson(count: number, harness?: string): Map<number, SlotData> {
  const map = new Map<number, SlotData>();
  for (let i = 1; i <= count; i++) {
    map.set(i, readSlotJson(i, harness));
  }
  return map;
}

/** Serialize SlotData to the legacy markdown format for display/compat. */
export function slotDataToMarkdown(data: SlotData): string {
  const n = (v: string | null): string => v ?? "null";
  return `## Slot ${data.slot}

**Process:** ${data.process}
**Task:** ${n(data.task)}
**Mode:** ${n(data.mode)}
**Session:** ${n(data.session)}
**Path:** ${n(data.path)}
**Started:** ${n(data.started)}
**Adapter Args:** ${n(data.adapterArgs)}
**Machine:** ${n(data.machine)}
**Session Started:** ${n(data.sessionStarted)}
**Liveness:** ${n(data.liveness)}

**Terminals:**
${data.terminals}
**Runtime:**
${data.runtime}
**Git:**
${data.git}`;
}
