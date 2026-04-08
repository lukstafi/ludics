// Slot adapter output helpers — mergeAdapterState and addNoteToSlotData
// All parse/write/field-access functions have been removed (migrated to JSON).

import type { SlotData } from "./types.ts";

export function addNoteToSlotData(data: SlotData, note: string): SlotData {
  return { ...data, runtime: data.runtime + `- ${note}\n` };
}

export function mergeAdapterState(data: SlotData, adapterOutput: string): SlotData {
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

  const result = { ...data };
  if (hasTerminals) result.terminals = terminalsSection;
  if (hasRuntime) result.runtime = runtimeSection;
  if (hasGit) result.git = gitSection;
  if (adapterSession) result.session = adapterSession;
  return result;
}
