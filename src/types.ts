// Shared types for ludics TypeScript migration

// --- Session Discovery ---

export type AgentType = "t3code" | "codex" | "claude-code";
export type SourceKind = "cli" | "vscode" | "exec" | "appServer" | "app" | "web" | "unknown";

/** Narrow an untrusted string (Codex `session_meta.source` JSONL field, etc.)
 *  to a valid {@link SourceKind}. Unknown / non-string values collapse to
 *  `"unknown"` — the existing fallback used elsewhere in session discovery
 *  (e.g. `discover-codex.ts:144` and `discover-claude.ts:153`). Default-to-
 *  safe is the right policy here: an unknown source kind shouldn't crash
 *  session discovery on a single malformed log. */
export function parseSourceKind(raw: unknown): SourceKind {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim();
  if (
    s === "cli" || s === "vscode" || s === "exec" || s === "appServer" ||
    s === "app" || s === "web" || s === "unknown"
  ) return s;
  return "unknown";
}

export interface DiscoveredSession {
  agentType: AgentType;
  cwd: string;
  cwdNormalized: string;
  sessionId: string;
  source: SourceKind;
  lastActivityEpoch: number;
  meta: Record<string, unknown>;
}

export interface Orchestration {
  type: string;
  mode: string;
  taskId: string;
  phase: string;
  round: string;
  peerSyncPath: string;
}

export interface MergedSession {
  cwd: string;
  cwdNormalized: string;
  sources: DiscoveredSession[];
  agents: AgentType[];
  ids: string[];
  lastActivityEpoch: number;
  lastActivity: string; // ISO timestamp
  stale: boolean;
  slot: number | null;
  slotPath: string | null;
  orchestration: Orchestration | null;
}

export interface SlotPath {
  slot: number;
  path: string;
}

export interface DiscoveryResult {
  generatedAt: string;
  staleAfterHours: number;
  sources: Record<string, number>;
  slots: SlotPath[];
  classified: MergedSession[];
  unclassified: MergedSession[];
}

// --- Config (minimal for Phase 1, expanded in Phase 2) ---

export interface LudicsConfig {
  state_repo: string;
  state_path: string;
  staleThresholdSeconds: number;
}
