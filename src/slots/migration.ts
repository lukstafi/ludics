// One-time slots.md → JSON migration helper

import { readFileSync } from "fs";
import type { SlotData } from "./types.ts";
import { emptySlotData } from "./json.ts";

function parseSlotBlocks(content: string): Map<number, string> {
  const blocks = new Map<number, string>();
  let currentSlot = 0;
  let currentBlock = "";

  for (const line of content.split("\n")) {
    const m = line.match(/^##\s+Slot\s+(\d+)/);
    if (m) {
      if (currentSlot !== 0) {
        blocks.set(currentSlot, currentBlock);
      }
      currentSlot = parseInt(m[1]!, 10);
      currentBlock = line + "\n";
      continue;
    }
    if (line === "---" || line === "# Slots") continue;
    currentBlock += line + "\n";
  }

  if (currentSlot !== 0) {
    blocks.set(currentSlot, currentBlock);
  }

  return blocks;
}

function getField(block: string, field: string): string {
  const marker = `**${field}:**`;
  for (const line of block.split("\n")) {
    const idx = line.indexOf(marker);
    if (idx >= 0) {
      return line.slice(idx + marker.length).trim();
    }
  }
  return "";
}

function extractSection(block: string, sectionName: string): string {
  const lines = block.split("\n");
  let inSection = false;
  let content = "";
  for (const line of lines) {
    if (line === `**${sectionName}:**`) {
      inSection = true;
      continue;
    }
    if (inSection && /^\*\*[A-Z]/.test(line)) {
      break;
    }
    if (inSection) {
      content += line + "\n";
    }
  }
  return content.trimEnd();
}

function nullIfEmpty(val: string): string | null {
  const v = val.trim();
  if (!v || v === "null" || v === "(empty)") return null;
  return v;
}

function blockToSlotData(slot: number, block: string): SlotData {
  const base = emptySlotData(slot);
  const process = getField(block, "Process");
  if (process) base.process = process;
  base.task = nullIfEmpty(getField(block, "Task"));
  base.mode = nullIfEmpty(getField(block, "Mode"));
  base.session = nullIfEmpty(getField(block, "Session"));
  base.path = nullIfEmpty(getField(block, "Path"));
  base.started = nullIfEmpty(getField(block, "Started"));
  base.adapterArgs = nullIfEmpty(getField(block, "Adapter Args"));
  base.machine = nullIfEmpty(getField(block, "Machine"));
  base.sessionStarted = nullIfEmpty(getField(block, "Session Started"));
  base.liveness = nullIfEmpty(getField(block, "Liveness"));
  base.terminals = extractSection(block, "Terminals");
  base.runtime = extractSection(block, "Runtime");
  base.git = extractSection(block, "Git");
  return base;
}

/** Parse a legacy slots.md file into SlotData objects for one-time migration. */
export function migrateMarkdownToSlotData(slotsFilePath: string, count: number): Map<number, SlotData> {
  const content = readFileSync(slotsFilePath, "utf-8");
  const blocks = parseSlotBlocks(content);
  const result = new Map<number, SlotData>();
  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    if (block) {
      result.set(i, blockToSlotData(i, block));
    } else {
      result.set(i, emptySlotData(i));
    }
  }
  return result;
}
