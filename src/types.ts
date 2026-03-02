// Shared types for ludics TypeScript migration

// --- Session Discovery ---

export type AgentType = "codex" | "claude-code" | "tmux" | "ttyd";
export type SourceKind = "cli" | "vscode" | "exec" | "appServer" | "app" | "web" | "unknown";

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
  type: "agent-duo" | "agent-pair-codex" | "agent-pair-claude";
  mode: string;
  feature: string;
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
