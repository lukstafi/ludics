// Slots Markdown parser — parse/write slots.md

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { SlotBlock } from "./types.ts";

export function emptyBlock(slot: number): string {
  return `## Slot ${slot}

**Process:** (empty)
**Task:** null
**Mode:** null
**Session:** null
**Path:** null
**Started:** null
**Adapter Args:** null

**Terminals:**

**Runtime:**

**Git:**
`;
}

export function parseSlotBlocks(content: string): Map<number, string> {
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

export function getField(block: string, field: string): string {
  const marker = `**${field}:**`;
  for (const line of block.split("\n")) {
    const idx = line.indexOf(marker);
    if (idx >= 0) {
      return line.slice(idx + marker.length).trim();
    }
  }
  return "";
}

export function getProcess(block: string): string { return getField(block, "Process"); }
export function getTask(block: string): string { return getField(block, "Task"); }
export function getMode(block: string): string { return getField(block, "Mode"); }
export function getSession(block: string): string { return getField(block, "Session"); }
export function getPath(block: string): string { return getField(block, "Path"); }
export function getStarted(block: string): string { return getField(block, "Started"); }
export function getAdapterArgs(block: string): string { return getField(block, "Adapter Args"); }

export function writeSlotFile(filePath: string, blocks: Map<number, string>, count: number): void {
  const parts: string[] = ["# Slots\n\n"];
  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i) ?? emptyBlock(i);
    parts.push(block);
    if (i < count) {
      parts.push("\n---\n\n");
    }
  }
  writeFileSync(filePath, parts.join(""));
}

export function addNoteToBlock(block: string, note: string): string {
  const lines = block.split("\n");
  const output: string[] = [];
  let inRuntime = false;
  let inserted = false;

  for (const line of lines) {
    if (line === "**Runtime:**") {
      inRuntime = true;
      output.push(line);
      continue;
    }
    if (inRuntime && line === "**Git:**") {
      output.push(`- ${note}`);
      output.push(line);
      inserted = true;
      inRuntime = false;
      continue;
    }
    output.push(line);
  }

  if (inRuntime && !inserted) {
    output.push(`- ${note}`);
  }
  if (!inserted && !inRuntime) {
    output.push("**Runtime:**");
    output.push(`- ${note}`);
  }

  return output.join("\n");
}

export function mergeAdapterState(block: string, adapterOutput: string): string {
  // Extract sections from adapter output
  let terminalsSection = "";
  let runtimeSection = "";
  let gitSection = "";
  let hasTerminals = false;
  let hasRuntime = false;
  let hasGit = false;
  let currentSection = "";

  for (const line of adapterOutput.split("\n")) {
    if (line.startsWith("**Terminals:") || line.startsWith("**Terminals**")) {
      currentSection = "terminals";
      hasTerminals = true;
      continue;
    }
    if (line.startsWith("**Runtime:") || line.startsWith("**Runtime**")) {
      currentSection = "runtime";
      hasRuntime = true;
      continue;
    }
    if (line.startsWith("**Git:") || line.startsWith("**Git**")) {
      currentSection = "git";
      hasGit = true;
      continue;
    }
    if (line.startsWith("**Mode:") || line.startsWith("**Session:") || line.startsWith("**Feature:")) {
      currentSection = "";
      continue;
    }
    if (/^\*\*[^*]+:\*\*/.test(line)) {
      currentSection = "runtime";
      hasRuntime = true;
      runtimeSection += line + "\n";
      continue;
    }

    switch (currentSection) {
      case "terminals": terminalsSection += line + "\n"; break;
      case "runtime": runtimeSection += line + "\n"; break;
      case "git": gitSection += line + "\n"; break;
    }
  }

  // Rebuild block, replacing sections the adapter provided
  const output: string[] = [];
  let skipUntilNext = false;

  for (const line of block.split("\n")) {
    if (line === "**Terminals:**") {
      output.push("**Terminals:**");
      if (hasTerminals) {
        if (terminalsSection.trim()) output.push(terminalsSection.trimEnd());
        skipUntilNext = true;
      } else {
        skipUntilNext = false;
      }
      continue;
    }
    if (line === "**Runtime:**") {
      output.push("**Runtime:**");
      if (hasRuntime) {
        if (runtimeSection.trim()) output.push(runtimeSection.trimEnd());
        skipUntilNext = true;
      } else {
        skipUntilNext = false;
      }
      continue;
    }
    if (line === "**Git:**") {
      output.push("**Git:**");
      if (hasGit) {
        if (gitSection.trim()) output.push(gitSection.trimEnd());
        skipUntilNext = true;
      } else {
        skipUntilNext = false;
      }
      continue;
    }

    if (/^\*\*/.test(line)) {
      skipUntilNext = false;
    }

    if (!skipUntilNext) {
      output.push(line);
    }
  }

  return output.join("\n");
}
