// Slots Markdown parser — parse/write slots.md

import { writeFileSync } from "fs";

export function emptyBlock(slot: number): string {
  return `## Slot ${slot}

**Process:** (empty)
**Task:** null
**Mode:** null
**Session:** null
**Path:** null
**Started:** null
**Adapter Args:** null
**Session Started:** null

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
export function getSessionStarted(block: string): string { return getField(block, "Session Started"); }
export function getMachine(block: string): string { return getField(block, "Machine"); }
export function getLiveness(block: string): string { return getField(block, "Liveness"); }

/**
 * Update (or insert) a structured `**Field:** value` header line in a slot block.
 * If the field is present it is replaced in-place.
 * If absent (old-format block), it is inserted after the last header field line
 * so that slotStart() can always stamp an active-session marker regardless of
 * when the block was created.
 */
export function setField(block: string, field: string, value: string): string {
  const marker = `**${field}:**`;
  const lines = block.split("\n");
  const idx = lines.findIndex(l => l.startsWith(marker));
  if (idx >= 0) {
    lines[idx] = `${marker} ${value}`;
    return lines.join("\n");
  }
  // Field absent — insert after the last header field line.
  // Header fields have the pattern "**Key:** value" (space after the colon-star).
  // Section headers like "**Terminals:**" have nothing after the colon-star and
  // are excluded by the trailing-space requirement.
  const lastHeaderIdx = lines.reduce(
    (best, l, i) => (/^\*\*[^*]+:\*\*\s/.test(l) ? i : best),
    -1,
  );
  if (lastHeaderIdx >= 0) {
    lines.splice(lastHeaderIdx + 1, 0, `${marker} ${value}`);
    return lines.join("\n");
  }
  // No header fields found at all (degenerate block) — append before first blank line
  const firstBlankIdx = lines.findIndex(l => l.trim() === "");
  const insertAt = firstBlankIdx >= 0 ? firstBlankIdx : lines.length;
  lines.splice(insertAt, 0, `${marker} ${value}`);
  return lines.join("\n");
}

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
  let adapterSession: string | null = null;

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
    if (line.startsWith("**Mode:") || line.startsWith("**Feature:")) {
      currentSection = "";
      continue;
    }
    if (line.startsWith("**Session:**")) {
      // Extract session value from adapter output to update the slot block
      const sessionValue = line.slice("**Session:**".length).trim();
      if (sessionValue) {
        adapterSession = sessionValue;
      }
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
      // Update Session field if adapter provided one
      if (adapterSession && line.startsWith("**Session:**")) {
        output.push(`**Session:** ${adapterSession}`);
      } else {
        output.push(line);
      }
    }
  }

  return output.join("\n");
}
