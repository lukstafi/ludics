// Retrospective collection — extract last assistant message per turn from t3code
// threads at task completion, write to retrospectives/<task-id>.json.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";
import type { OrchestrationState } from "./orchestration/state.ts";
import type { T3Thread, T3ThreadMessage } from "./t3code/types.ts";
import { threadModel } from "./t3code/types.ts";

// --- Types ---

export interface RetrospectiveVerdict {
  round: number;
  type: "review" | "plan-review";
  verdict: "approve" | "request_changes" | "timeout";
  reviewer: string | null;
}

export interface RetrospectiveThread {
  threadId: string;
  agentName: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface RetrospectiveTurn {
  threadId: string;
  agentName: string;
  turnIndex: number;
  turnId: string | null;
  phase: string | null;
  timestamp: string;
  message: string;
}

export interface MissingThread {
  threadId: string;
  agentName: string;
  reason: string;
}

export interface RetrospectiveData {
  taskId: string;
  title: string;
  status: string;
  completedAt: string;
  startedAt: string | null;
  slot: number | null;
  mode: string | null;
  proposalPath: string | null;
  prUrl: string | null;
  githubUrl: string | null;
  phases: string[];
  rounds: number;
  mergeRound: number;
  planMergeRound: number;
  agents: string[];
  verdicts: RetrospectiveVerdict[];
  threads: RetrospectiveThread[];
  turns: RetrospectiveTurn[];
  missingThreads: MissingThread[];
  suggestRefactorSummary: string | null;
  workflowFeedbackSummary: string | null;
  collectedAt: string;
}

// --- Phase timeline helpers ---

interface PhaseEntry {
  phase: string;
  since: number; // epoch seconds
}

function buildPhaseTimeline(taskId: string, slot: number | null): {
  phases: string[];
  timeline: PhaseEntry[];
} {
  const eventsFile = join(harnessDir(), "journal", "events.jsonl");
  if (!existsSync(eventsFile)) return { phases: [], timeline: [] };

  let content: string;
  try {
    content = readFileSync(eventsFile, "utf-8").trim();
  } catch {
    return { phases: [], timeline: [] };
  }
  if (!content) return { phases: [], timeline: [] };

  const lines = content.split("\n");
  const entries: PhaseEntry[] = [];

  // First pass: try matching by taskId
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event_type !== "phase_transition") continue;
      if (event.task === taskId) {
        const phase = String(event.action ?? event.phase ?? "");
        const epoch = Number(event.epoch ?? 0);
        if (phase && epoch) entries.push({ phase, since: epoch });
      }
    } catch {
      continue;
    }
  }

  // Fallback: if no task-matched events, try slot-based matching
  if (entries.length === 0 && slot !== null) {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.event_type !== "phase_transition") continue;
        if (event.slot === slot && !event.task) {
          const phase = String(event.action ?? event.phase ?? "");
          const epoch = Number(event.epoch ?? 0);
          if (phase && epoch) entries.push({ phase, since: epoch });
        }
      } catch {
        continue;
      }
    }
  }

  entries.sort((a, b) => a.since - b.since);

  // Ordered unique phases
  const phases: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!seen.has(entry.phase)) {
      seen.add(entry.phase);
      phases.push(entry.phase);
    }
  }

  return { phases, timeline: entries };
}

function phaseAtTimestamp(timeline: PhaseEntry[], isoTimestamp: string): string | null {
  if (timeline.length === 0) return null;
  const epoch = Math.floor(new Date(isoTimestamp).getTime() / 1000);

  // Find latest entry with since <= epoch
  let result: string | null = null;
  for (const entry of timeline) {
    if (entry.since <= epoch) {
      result = entry.phase;
    } else {
      break; // sorted, so no need to continue
    }
  }
  return result;
}

// --- Turn extraction ---

function extractTurnsFromThread(
  thread: T3Thread,
  agentName: string,
  timeline: PhaseEntry[],
): { turns: RetrospectiveTurn[]; threadMeta: RetrospectiveThread; missing: MissingThread | null } {
  const messages = thread.messages ?? [];

  if (messages.length === 0) {
    return {
      turns: [],
      threadMeta: {
        threadId: thread.id,
        agentName,
        title: thread.title,
        model: threadModel(thread),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        turnCount: 0,
      },
      missing: { threadId: thread.id, agentName, reason: "no messages" },
    };
  }

  // Group messages by turnId
  const turnGroups = new Map<string, T3ThreadMessage[]>();
  let nullTurnCounter = 0;

  for (const msg of messages) {
    const key = msg.turnId ?? `__null_${nullTurnCounter++}`;
    const group = turnGroups.get(key);
    if (group) {
      group.push(msg);
    } else {
      turnGroups.set(key, [msg]);
    }
  }

  // Extract last assistant message per turn group
  const turns: RetrospectiveTurn[] = [];
  let turnIndex = 0;

  for (const [key, groupMessages] of turnGroups) {
    const assistantMessages = groupMessages.filter((m) => m.role === "assistant");
    if (assistantMessages.length === 0) continue;

    // Prefer non-streaming messages
    const nonStreaming = assistantMessages.filter((m) => !m.streaming);
    const selected = nonStreaming.length > 0
      ? nonStreaming[nonStreaming.length - 1]!
      : assistantMessages[assistantMessages.length - 1]!;

    const turnId = key.startsWith("__null_") ? null : key;

    turns.push({
      threadId: thread.id,
      agentName,
      turnIndex,
      turnId,
      phase: phaseAtTimestamp(timeline, selected.createdAt),
      timestamp: selected.createdAt,
      message: selected.text,
    });
    turnIndex++;
  }

  return {
    turns,
    threadMeta: {
      threadId: thread.id,
      agentName,
      title: thread.title,
      model: threadModel(thread),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      turnCount: turns.length,
    },
    missing: null,
  };
}

// --- Review verdict extraction ---

function extractVerdicts(peerSyncDir: string): RetrospectiveVerdict[] {
  const reviewsDir = join(peerSyncDir, "reviews");
  if (!existsSync(reviewsDir)) return [];

  const verdicts: RetrospectiveVerdict[] = [];

  try {
    const files = readdirSync(reviewsDir).filter((f: string) => f.endsWith(".md"));

    for (const f of files) {
      // Normal review: round-N-reviewer.md or round-N-coder.md
      const roundMatch = f.match(/^round-(\d+)-(\w+)\.md$/);
      if (roundMatch) {
        const round = parseInt(roundMatch[1]!, 10);
        const reviewer = roundMatch[2]!;
        const content = readFileSync(join(reviewsDir, f), "utf-8");
        const verdict = parseVerdictFromContent(content);
        verdicts.push({ round, type: "review", verdict, reviewer });
        continue;
      }

      // Plan-review: plan-merge-M-reviewer.md or plan-merge-M-coder.md
      const planMatch = f.match(/^plan-merge-(\d+)-(\w+)\.md$/);
      if (planMatch) {
        const round = parseInt(planMatch[1]!, 10);
        const reviewer = planMatch[2]!;
        const content = readFileSync(join(reviewsDir, f), "utf-8");
        const verdict = parseVerdictFromContent(content);
        verdicts.push({ round, type: "plan-review", verdict, reviewer });
      }
    }
  } catch {
    // ignore read errors
  }

  verdicts.sort((a, b) => a.round - b.round);
  return verdicts;
}

function parseVerdictFromContent(content: string): "approve" | "request_changes" | "timeout" {
  const upper = content.toUpperCase();
  if (upper.includes("APPROVE") && !upper.includes("REQUEST_CHANGES")) return "approve";
  if (upper.includes("REQUEST_CHANGES")) return "request_changes";
  return "timeout";
}

// --- Artifact extraction ---

function extractArtifactSummary(peerSyncDir: string, pattern: RegExp): string | null {
  if (!existsSync(peerSyncDir)) return null;

  try {
    const files = readdirSync(peerSyncDir).filter((f: string) => pattern.test(f));
    if (files.length === 0) return null;

    // Pick the most recent (last alphabetically)
    files.sort();
    const content = readFileSync(join(peerSyncDir, files[files.length - 1]!), "utf-8");
    return content.slice(0, 500) || null;
  } catch {
    return null;
  }
}

// --- Task frontmatter reading ---

interface TaskFrontmatter {
  title: string;
  status: string;
  started: string | null;
  completed: string | null;
  proposal: string | null;
  url: string | null;
  t3codeThreads: string[];
}

function readTaskFrontmatter(taskId: string): TaskFrontmatter | null {
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return null;

  try {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const data = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;

    // Parse t3code_threads: [id1, id2]
    let threads: string[] = [];
    const threadsMatch = content.match(/^t3code_threads:\s*\[(.+)\]$/m);
    if (threadsMatch) {
      threads = threadsMatch[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    }

    const isNonNull = (v: unknown): v is string =>
      typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "null";

    return {
      title: String(data.title ?? taskId),
      status: String(data.status ?? "done"),
      started: isNonNull(data.started) ? String(data.started) : null,
      completed: isNonNull(data.completed) ? String(data.completed) : null,
      proposal: isNonNull(data.proposal) ? String(data.proposal) : null,
      url: isNonNull(data.url) ? String(data.url) : null,
      t3codeThreads: threads,
    };
  } catch {
    return null;
  }
}

// --- Write helper ---

function writeRetrospective(data: RetrospectiveData): void {
  const dir = join(harnessDir(), "retrospectives");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${data.taskId}.json`), JSON.stringify(data, null, 2));

  emitEvent({
    event_type: "retrospective_written",
    source: "retrospective",
    scope: "task",
    task: data.taskId,
    slot: data.slot ?? undefined,
    message: `retrospective written for ${data.taskId} (${data.turns.length} turns, ${data.threads.length} threads)`,
  });
}

// --- Primary collector ---

export async function collectAndWriteRetrospective(state: OrchestrationState): Promise<void> {
  const taskId = state.taskId ?? state.feature;
  const fm = readTaskFrontmatter(taskId);

  // Extract PR URL from agent states
  let prUrl: string | null = null;
  for (const agentState of Object.values(state.agentStates)) {
    if (agentState.prUrl) {
      prUrl = agentState.prUrl;
      break;
    }
  }

  // Build phase timeline
  const { phases, timeline } = buildPhaseTimeline(taskId, state.slot);

  // Get t3code snapshot
  const allThreads: RetrospectiveThread[] = [];
  const allTurns: RetrospectiveTurn[] = [];
  const allMissing: MissingThread[] = [];

  try {
    const { serverStatus } = await import("./t3code/server.ts");
    const status = await serverStatus({ harnessDir: harnessDir() });

    if (status.running && status.snapshot) {
      const snapshot = status.snapshot;

      for (const [agentName, threadId] of Object.entries(state.threadIds)) {
        const thread = snapshot.threads.find((t) => t.id === threadId);
        if (!thread) {
          allMissing.push({ threadId, agentName, reason: "not in snapshot" });
          continue;
        }

        const { turns, threadMeta, missing } = extractTurnsFromThread(thread, agentName, timeline);
        allThreads.push(threadMeta);
        allTurns.push(...turns);
        if (missing) allMissing.push(missing);
      }
    } else {
      // Server not running — record all threads as missing
      for (const [agentName, threadId] of Object.entries(state.threadIds)) {
        allMissing.push({ threadId, agentName, reason: "t3code server not running" });
      }
    }
  } catch {
    // t3code unavailable — proceed with empty thread data
    for (const [agentName, threadId] of Object.entries(state.threadIds)) {
      allMissing.push({ threadId, agentName, reason: "t3code error" });
    }
  }

  // Sort turns chronologically
  allTurns.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Extract review verdicts
  const verdicts = extractVerdicts(state.peerSyncDir);

  // Extract artifact summaries
  const suggestRefactorSummary = extractArtifactSummary(state.peerSyncDir, /^suggest-refactor.*\.md$/);
  const workflowFeedbackSummary = extractArtifactSummary(state.peerSyncDir, /^workflow-feedback.*\.md$/);

  const now = new Date();
  const data: RetrospectiveData = {
    taskId,
    title: fm?.title ?? taskId,
    status: fm?.status ?? "done",
    completedAt: fm?.completed ?? now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    startedAt: fm?.started ?? state.startedAt ?? null,
    slot: state.slot,
    mode: state.mode,
    proposalPath: fm?.proposal ?? null,
    prUrl,
    githubUrl: fm?.url ?? null,
    phases,
    rounds: state.round,
    mergeRound: state.mergeRound,
    planMergeRound: state.planMergeRound ?? 0,
    agents: state.agents.map((a) => a.name),
    verdicts,
    threads: allThreads,
    turns: allTurns,
    missingThreads: allMissing,
    suggestRefactorSummary,
    workflowFeedbackSummary,
    collectedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  writeRetrospective(data);
  console.error(`ludics: retrospective written for ${taskId} (${allTurns.length} turns, ${allThreads.length} threads)`);
}

// --- Fallback collector ---

export async function collectRetrospectiveFallback(taskId: string): Promise<void> {
  const fm = readTaskFrontmatter(taskId);
  if (!fm) {
    console.error(`ludics: retrospective fallback: task file not found for ${taskId}`);
    return;
  }

  const threadIds = fm.t3codeThreads;

  // Build phase timeline (best-effort from events)
  const { phases, timeline } = buildPhaseTimeline(taskId, null);

  const allThreads: RetrospectiveThread[] = [];
  const allTurns: RetrospectiveTurn[] = [];
  const allMissing: MissingThread[] = [];

  if (threadIds.length > 0) {
    try {
      const { serverStatus } = await import("./t3code/server.ts");
      const status = await serverStatus({ harnessDir: harnessDir() });

      if (status.running && status.snapshot) {
        const snapshot = status.snapshot;

        for (const threadId of threadIds) {
          const thread = snapshot.threads.find((t) => t.id === threadId);
          if (!thread) {
            allMissing.push({ threadId, agentName: "unknown", reason: "not in snapshot" });
            continue;
          }

          const { turns, threadMeta, missing } = extractTurnsFromThread(thread, "unknown", timeline);
          allThreads.push(threadMeta);
          allTurns.push(...turns);
          if (missing) allMissing.push(missing);
        }
      } else {
        for (const threadId of threadIds) {
          allMissing.push({ threadId, agentName: "unknown", reason: "t3code server not running" });
        }
      }
    } catch {
      for (const threadId of threadIds) {
        allMissing.push({ threadId, agentName: "unknown", reason: "t3code error" });
      }
    }
  }

  allTurns.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const now = new Date();
  const data: RetrospectiveData = {
    taskId,
    title: fm.title,
    status: fm.status,
    completedAt: fm.completed ?? now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    startedAt: fm.started,
    slot: null,
    mode: null,
    proposalPath: fm.proposal,
    prUrl: null,
    githubUrl: fm.url,
    phases,
    rounds: 0,
    mergeRound: 0,
    planMergeRound: 0,
    agents: [],
    verdicts: [],
    threads: allThreads,
    turns: allTurns,
    missingThreads: allMissing,
    suggestRefactorSummary: null,
    workflowFeedbackSummary: null,
    collectedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  writeRetrospective(data);
  console.error(`ludics: retrospective fallback written for ${taskId} (${allTurns.length} turns)`);
}
