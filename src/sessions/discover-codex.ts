// Codex session discovery
// Layout: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
// First line: {"type":"session_meta","payload":{"id":...,"cwd":...,"source":...}}

import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import type { DiscoveredSession } from "../types.ts";
import { parseSourceKind } from "../types.ts";
import { readFirstLines } from "./read-lines.ts";

const MAX_SCAN_LINES = 20;

function normalizeCwd(cwd: string): string {
  return cwd !== "/" ? cwd.replace(/\/+$/, "") : cwd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface SessionMeta {
  id?: string;
  cwd?: string;
  source?: string;
  cli_version?: string;
  model_provider?: string;
}

function parseSessionMeta(firstLine: string): SessionMeta | null {
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (!isRecord(parsed)) return null;
    if (parsed.type === "session_meta" && isRecord(parsed.payload)) {
      const payload = parsed.payload;
      return {
        id: getString(payload.id),
        cwd: getString(payload.cwd),
        source: getString(payload.source) ?? "unknown",
        cli_version: getString(payload.cli_version),
        model_provider: getString(payload.model_provider),
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

function parseFallback(lines: string[]): { id: string; cwd: string; source: string } | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const payload = isRecord(parsed.payload) ? parsed.payload : null;
      const cwd = getString(parsed.cwd)
        ?? (payload ? getString(payload.cwd) : undefined)
        ?? getString(parsed.workdir)
        ?? getString(parsed.workingDirectory);
      if (cwd) {
        return {
          id: getString(parsed.id) ?? (payload ? getString(payload.id) : undefined) ?? "",
          cwd,
          source: getString(parsed.source) ?? (payload ? getString(payload.source) : undefined) ?? "unknown",
        };
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return null;
}

function walkJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  function walk(d: string): void {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".jsonl")) {
          files.push(full);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  walk(dir);
  return files;
}

export async function discoverCodex(
  staleThreshold: number,
): Promise<DiscoveredSession[]> {
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME!, ".codex");
  const sessionsDir = join(codexHome, "sessions");

  if (!existsSync(sessionsDir)) return [];

  const now = Math.floor(Date.now() / 1000);
  const jsonlFiles = walkJsonlFiles(sessionsDir);
  const sessions: DiscoveredSession[] = [];

  for (const file of jsonlFiles) {
    let mtimeEpoch: number;
    try {
      const st = statSync(file);
      mtimeEpoch = Math.floor(st.mtimeMs / 1000);
    } catch {
      continue;
    }

    // Skip stale sessions
    if (now - mtimeEpoch > staleThreshold) continue;

    const lines = await readFirstLines(file, MAX_SCAN_LINES);
    if (lines.length === 0) continue;

    let sessionId = "";
    let cwd = "";
    let source: string = "unknown";
    let meta: Record<string, unknown> = {};

    // Try session_meta first
    const sessionMeta = parseSessionMeta(lines[0]);
    if (sessionMeta?.cwd) {
      sessionId = sessionMeta.id ?? "";
      cwd = sessionMeta.cwd;
      source = sessionMeta.source ?? "unknown";
      meta = {
        cli_version: sessionMeta.cli_version ?? null,
        model_provider: sessionMeta.model_provider ?? null,
        file,
      };
    }

    // Fallback: scan first N lines
    if (!cwd) {
      const fallback = parseFallback(lines);
      if (fallback) {
        sessionId = fallback.id;
        cwd = fallback.cwd;
        source = fallback.source;
        meta = { file };
      }
    }

    if (!cwd) continue;

    // Use filename as ID fallback
    if (!sessionId) {
      sessionId = basename(file, ".jsonl");
    }

    sessions.push({
      agentType: "codex",
      cwd: normalizeCwd(cwd),
      cwdNormalized: normalizeCwd(cwd),
      sessionId,
      source: parseSourceKind(source),
      lastActivityEpoch: mtimeEpoch,
      meta,
    });
  }

  return sessions;
}
