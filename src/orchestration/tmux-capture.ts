// Tmux pane capture for retrospective — captures structured agent output
// at each round end and stores to peerSyncDir/captures/ for later inclusion
// in the retrospective JSON.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmuxCapture } from "../adapters/tmux.ts";
import { tmuxSessionName } from "../adapters/tmux-adapter.ts";
import type { T3ProviderKind } from "../t3code/types.ts";
import { agentParticipatesInPhase } from "./phases.ts";
import type { OrchestrationState } from "./state.ts";

export interface TmuxCaptureEntry {
  agentName: string;
  phase: string;
  round: number;
  timestamp: string;
  content: string;
  hash: string;
}

export interface CaptureHeader {
  agentName: string;
  phase: string;
  round: number;
  timestamp: string;
  hash: string;
}

/**
 * Parse the structured header block from a capture file.
 * Returns null if the separator or any required field is missing.
 */
export function parseCaptureHeader(raw: string): { header: CaptureHeader; content: string } | null {
  const separatorIdx = raw.indexOf("\n---\n");
  if (separatorIdx === -1) return null;

  const headerText = raw.slice(0, separatorIdx);
  const content = raw.slice(separatorIdx + 5).trim();

  const agentMatch = headerText.match(/^agent:\s*(.+)$/m);
  const phaseMatch = headerText.match(/^phase:\s*(.+)$/m);
  const roundMatch = headerText.match(/^round:\s*(\d+)$/m);
  const timestampMatch = headerText.match(/^timestamp:\s*(.+)$/m);
  const hashMatch = headerText.match(/^hash:\s*(.+)$/m);

  if (!agentMatch || !phaseMatch || !roundMatch || !timestampMatch || !hashMatch) return null;

  return {
    header: {
      agentName: agentMatch[1]!.trim(),
      phase: phaseMatch[1]!.trim(),
      round: parseInt(roundMatch[1]!, 10),
      timestamp: timestampMatch[1]!.trim(),
      hash: hashMatch[1]!.trim(),
    },
    content,
  };
}

/** Output-entry marker per provider. */
const ENTRY_MARKERS: Record<T3ProviderKind, string> = {
  "claude-code": "⏺",
  "codex": "• ",
};

/**
 * Extract clean structured output from raw tmux pane text.
 * Reuses the publishTerminalState pattern from mag.ts:
 * find last output marker, trim to prompt, strip separator lines.
 *
 * @param provider — selects the entry marker: ⏺ for claude-code, • for codex.
 *                    Defaults to "claude-code".
 */
export function extractCleanPaneOutput(raw: string, provider: T3ProviderKind = "claude-code"): string | null {
  const lines = raw.split("\n");
  const marker = ENTRY_MARKERS[provider];

  // Find last entry-marker line (provider-specific)
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(marker)) {
      startIdx = i;
      break;
    }
  }

  // Find last prompt line (❯ or $) and cut there
  let endIdx = lines.length;
  for (let i = lines.length - 1; i >= startIdx; i--) {
    if (lines[i]!.includes("❯") || /^\s*\$\s/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }

  const cleaned = lines.slice(startIdx, endIdx)
    .filter((l) => !l.match(/^[─]{4,}/));  // drop line separators

  const snippet = cleaned.join("\n").trim();
  if (!snippet) return null;

  // Filter out trivially short captures
  const nonWsLines = cleaned.filter((l) => l.trim().length > 0);
  if (nonWsLines.length < 5) return null;

  return snippet;
}

function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(content);
  return hasher.digest("hex");
}

function capturesDir(peerSyncDir: string): string {
  return join(peerSyncDir, "captures");
}

/**
 * Find the most recent capture file for a given agent and return its hash.
 * Returns null if no previous capture exists.
 */
function lastCaptureHash(peerSyncDir: string, agentName: string): string | null {
  const dir = capturesDir(peerSyncDir);
  if (!existsSync(dir)) return null;

  try {
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith(`-${agentName}.txt`))
      .sort();
    if (files.length === 0) return null;

    const raw = readFileSync(join(dir, files[files.length - 1]!), "utf-8");
    const parsed = parseCaptureHeader(raw);
    return parsed?.header.hash ?? null;
  } catch {
    return null;
  }
}

/**
 * Capture + clean + dedup + write for all participating agents.
 * Only runs when backend === "tmux".
 */
export function captureTmuxAgentOutputs(state: OrchestrationState): void {
  if (state.backend !== "tmux") return;

  const dir = capturesDir(state.peerSyncDir);
  mkdirSync(dir, { recursive: true });

  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;

    const session = tmuxSessionName(state.slot, agent.name, state.taskId);
    const raw = tmuxCapture(session, 200);
    if (!raw) continue;

    const cleaned = extractCleanPaneOutput(raw, agent.provider);
    if (!cleaned) continue;

    const hash = hashContent(cleaned);

    // Dedup: skip if hash matches the last capture for this agent
    const prevHash = lastCaptureHash(state.peerSyncDir, agent.name);
    if (prevHash === hash) continue;

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const header = [
      `agent: ${agent.name}`,
      `phase: ${state.phase}`,
      `round: ${state.round}`,
      `timestamp: ${timestamp}`,
      `hash: ${hash}`,
      "---",
    ].join("\n");

    const filename = `round-${String(state.round).padStart(3, '0')}-${state.phase}-${agent.name}.txt`;
    writeFileSync(join(dir, filename), `${header}\n${cleaned}\n`);
  }
}

/**
 * Read all capture files from peerSyncDir/captures/ and return parsed entries.
 * Sorted by round then agent name.
 */
export function readTmuxCaptures(peerSyncDir: string): TmuxCaptureEntry[] {
  const dir = capturesDir(peerSyncDir);
  if (!existsSync(dir)) return [];

  const entries: TmuxCaptureEntry[] = [];

  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".txt"));

    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), "utf-8");
        const parsed = parseCaptureHeader(raw);
        if (!parsed) continue;

        entries.push({
          ...parsed.header,
          content: parsed.content,
        });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  entries.sort((a, b) => a.round !== b.round ? a.round - b.round : a.agentName.localeCompare(b.agentName));
  return entries;
}
