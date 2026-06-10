export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
} as const;

export type T3ProviderKind = "codex" | "claude-code";

/** Provider kind as used on the t3code WebSocket wire protocol. */
export type T3WireProviderKind = "codex" | "claudeAgent";

/** Convert Ludics provider name to t3code wire format. */
export function toWireProvider(provider: T3ProviderKind): T3WireProviderKind {
  return provider === "claude-code" ? "claudeAgent" : provider;
}

/** Convert t3code wire format to Ludics provider name. */
export function fromWireProvider(wire: T3WireProviderKind): T3ProviderKind {
  return wire === "claudeAgent" ? "claude-code" : wire;
}

export type T3RuntimeMode = "approval-required" | "full-access";
export type T3InteractionMode = "default" | "plan";
export type T3ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type T3SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type T3ServiceTier = "fast" | "flex";
export type T3AssistantDeliveryMode = "buffered" | "streaming";

/** Model selection as used on the t3code wire protocol. */
export interface T3ModelSelection {
  provider: T3WireProviderKind;
  model: string;
  options?: Record<string, unknown>;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection?: T3ModelSelection | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface T3LatestTurn {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  assistantMessageId?: string | null;
}

export interface T3ThreadSession {
  threadId: string;
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  providerName?: string | null;
  runtimeMode: T3RuntimeMode;
  activeTurnId?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

export interface T3Thread {
  id: string;
  projectId: string;
  title: string;
  modelSelection: T3ModelSelection;
  runtimeMode: T3RuntimeMode;
  interactionMode?: T3InteractionMode;
  branch?: string | null;
  worktreePath?: string | null;
  latestTurn?: T3LatestTurn | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  session?: T3ThreadSession | null;
  messages?: T3ThreadMessage[];
}

/** Helper to extract a flat model string from a thread. */
export function threadModel(thread: T3Thread): string {
  return thread.modelSelection.model;
}

/** Helper to extract a flat model string from a project. */
export function projectModel(project: T3Project): string | null {
  return project.defaultModelSelection?.model ?? null;
}

export interface T3Snapshot {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3Thread[];
  updatedAt: string;
}

export interface T3CommandResult {
  sequence?: number;
  eventId?: string;
}

export type T3MessageRole = "user" | "assistant" | "system";

export interface T3ThreadMessage {
  id: string;
  role: T3MessageRole;
  /** Plain text content of the message. */
  text: string;
  createdAt: string;
  updatedAt: string;
  /** Turn ID this message belongs to, if applicable. */
  turnId?: string | null;
  /** Whether the message is still being streamed. */
  streaming?: boolean;
}

export interface T3ProjectCreateCommand {
  type: "project.create";
  commandId: string;
  projectId: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection?: T3ModelSelection | null;
  createdAt: string;
}

export interface T3ThreadCreateCommand {
  type: "thread.create";
  commandId: string;
  threadId: string;
  projectId: string;
  title: string;
  modelSelection: T3ModelSelection;
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  createdAt: string;
}

export interface T3ThreadDeleteCommand {
  type: "thread.delete";
  commandId: string;
  threadId: string;
}

export interface T3ThreadTurnStartCommand {
  type: "thread.turn.start";
  commandId: string;
  threadId: string;
  message: {
    messageId: string;
    role: "user";
    text: string;
    attachments: unknown[];
  };
  modelSelection?: T3ModelSelection;
  providerOptions?: Record<string, unknown>;
  assistantDeliveryMode?: T3AssistantDeliveryMode;
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
  createdAt: string;
}

export interface T3ThreadTurnInterruptCommand {
  type: "thread.turn.interrupt";
  commandId: string;
  threadId: string;
  turnId?: string;
  createdAt: string;
}

export interface T3ThreadSessionStopCommand {
  type: "thread.session.stop";
  commandId: string;
  threadId: string;
  createdAt: string;
}

export type T3Command =
  | T3ProjectCreateCommand
  | T3ThreadCreateCommand
  | T3ThreadDeleteCommand
  | T3ThreadTurnStartCommand
  | T3ThreadTurnInterruptCommand
  | T3ThreadSessionStopCommand;

export interface T3DomainEvent {
  type: string;
  payload?: Record<string, unknown>;
  sequence?: number;
  eventId?: string;
}

export interface T3WsPush {
  type: "push";
  channel: string;
  data: unknown;
}

export interface T3WsResponse<T = unknown> {
  id: string;
  result?: T;
  error?: {
    message: string;
  };
}

export interface T3CodeServerRecord {
  pid: number;
  port: number;
  host: string;
  webUrl: string;
  wsUrl: string;
  authToken?: string;
  stateDir: string;
  startedAt: string;
  command: string[];
}

export interface T3CodeThreadRecord {
  threadId: string;
  projectId: string;
  worktreePath: string;
  title: string;
  model: string;
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
  branch?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface T3CodeOrchestrationRef {
  stateFile: string;
  mode: "duo" | "pair" | "solo" | "pilot";
  pid?: number;
}

export interface T3CodeSlotState {
  slot: number;
  threads: T3CodeThreadRecord[];
  orchestration?: T3CodeOrchestrationRef;
}
