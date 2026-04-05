// Retrospective collection — extract last assistant message per turn from t3code
// threads at task completion, write to retrospectives/<task-id>.json.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import YAML from "yaml";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";
import { parseReviewFilename } from "./orchestration/review-files.ts";
import { queueRequest } from "./queue.ts";
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

export interface RetrospectiveReview {
  round: number;
  type: "review" | "plan-review";
  reviewer: string;
  verdict: "approve" | "request_changes" | "timeout";
  content: string;
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
  reviews: RetrospectiveReview[];
  threads: RetrospectiveThread[];
  turns: RetrospectiveTurn[];
  missingThreads: MissingThread[];
  suggestRefactorSummary: string | null;
  workflowFeedback: Record<string, string>;
  /** @deprecated Use workflowFeedback instead */
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

  // Phase-transition events store the task identifier in the `task` field.
  // Legacy events may use a slugified feature value; match by taskId and its slug.
  const matchIds = new Set<string>([taskId]);
  const slugified = taskId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slugified !== taskId) matchIds.add(slugified);

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event_type !== "phase_transition") continue;
      const eventTask = String(event.task ?? "");
      if (eventTask && matchIds.has(eventTask)) {
        const phase = String(event.status ?? "");
        const epoch = Number(event.epoch ?? 0);
        if (phase && epoch) entries.push({ phase, since: epoch });
      }
    } catch {
      continue;
    }
  }

  // Fallback: if no task/feature-matched events, try slot-based matching
  if (entries.length === 0 && slot !== null) {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.event_type !== "phase_transition") continue;
        if (event.slot === slot) {
          const phase = String(event.status ?? "");
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
      const parsed = parseReviewFilename(f);
      if (parsed) {
        const content = readFileSync(join(reviewsDir, f), "utf-8");
        const verdict = parseVerdictFromContent(content);
        verdicts.push({ round: parsed.round, type: parsed.type, verdict, reviewer: parsed.agentName });
      }
    }
  } catch {
    // ignore read errors
  }

  verdicts.sort((a, b) => a.round - b.round);
  return verdicts;
}

export function extractReviews(peerSyncDir: string): RetrospectiveReview[] {
  const reviewsDir = join(peerSyncDir, "reviews");
  if (!existsSync(reviewsDir)) return [];

  const reviews: RetrospectiveReview[] = [];

  try {
    const files = readdirSync(reviewsDir).filter((f: string) => f.endsWith(".md"));

    for (const f of files) {
      const parsed = parseReviewFilename(f);
      if (!parsed) continue; // Unrecognized filenames silently skipped
      try {
        const content = readFileSync(join(reviewsDir, f), "utf-8");
        const verdict = parseVerdictFromContent(content);
        reviews.push({ round: parsed.round, type: parsed.type, reviewer: parsed.agentName, verdict, content });
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    // directory read error — return empty
  }

  // Sort: round ASC, plan-review before review at same round, reviewer alpha
  reviews.sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    if (a.type !== b.type) return a.type === "plan-review" ? -1 : 1;
    return a.reviewer.localeCompare(b.reviewer);
  });

  return reviews;
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
    return content || null;
  } catch {
    return null;
  }
}

/** Read all workflow feedback files from peerSyncDir, keyed by agent name. */
function extractAllWorkflowFeedback(peerSyncDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(peerSyncDir)) return result;

  try {
    const files = readdirSync(peerSyncDir).filter((f: string) => /^workflow-feedback.*\.md$/.test(f));
    for (const f of files) {
      const content = readFileSync(join(peerSyncDir, f), "utf-8");
      if (content) {
        // Extract agent name: workflow-feedback-coder.md → coder
        const match = f.match(/^workflow-feedback-(.+)\.md$/);
        const key = match?.[1] ?? f;
        result[key] = content;
      }
    }
  } catch { /* ignore */ }
  return result;
}

/** Copy workflow feedback files to harness/feedback/ for the digest pipeline. */
function persistWorkflowFeedback(peerSyncDir: string, taskId: string): void {
  if (!existsSync(peerSyncDir)) return;

  try {
    const files = readdirSync(peerSyncDir).filter((f: string) => /^workflow-feedback.*\.md$/.test(f));
    if (files.length === 0) return;

    const feedbackDir = join(harnessDir(), "feedback");
    mkdirSync(feedbackDir, { recursive: true });

    for (const f of files) {
      // Name: <taskId>--<original-filename> to avoid collisions
      const destName = `${taskId}--${f}`;
      copyFileSync(join(peerSyncDir, f), join(feedbackDir, destName));
    }
  } catch { /* non-critical */ }
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

  // Auto-queue suggestion processing if retrospective contains suggestions
  const hasRequestChanges = data.reviews?.some(r => r.verdict === "request_changes") ?? false;
  if (data.suggestRefactorSummary || Object.keys(data.workflowFeedback).length > 0 || hasRequestChanges) {
    try {
      queueRequest({ action: "process-suggestions", task: data.taskId });
    } catch {
      // Non-critical: don't fail retrospective write if queue append fails
    }
  }
}

// --- Primary collector ---

export async function collectAndWriteRetrospective(state: OrchestrationState): Promise<void> {
  const taskId = state.taskId;
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

  // Tmux capture fallback: when backend is tmux and t3code produced no turns,
  // read accumulated pane captures from disk.
  if (state.backend === "tmux" && allTurns.length === 0) {
    const { readTmuxCaptures } = await import("./orchestration/tmux-capture.ts");
    const captures = readTmuxCaptures(state.peerSyncDir);

    const agentCaptures = new Map<string, typeof captures>();
    for (const cap of captures) {
      const list = agentCaptures.get(cap.agentName) ?? [];
      list.push(cap);
      agentCaptures.set(cap.agentName, list);
    }

    for (const [agentName, caps] of agentCaptures) {
      allThreads.push({
        threadId: "tmux-capture",
        agentName,
        title: `tmux capture for ${agentName}`,
        model: "unknown",
        createdAt: caps[0]!.timestamp,
        updatedAt: caps[caps.length - 1]!.timestamp,
        turnCount: caps.length,
      });

      for (let i = 0; i < caps.length; i++) {
        allTurns.push({
          threadId: "tmux-capture",
          agentName,
          turnIndex: i,
          turnId: null,
          phase: caps[i]!.phase,
          timestamp: caps[i]!.timestamp,
          message: caps[i]!.content,
        });
      }
    }
  }

  // Sort turns chronologically
  allTurns.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Extract full reviews and derive verdicts for backward compatibility
  const reviews = extractReviews(state.peerSyncDir);
  const verdicts: RetrospectiveVerdict[] = reviews.map((r) => ({
    round: r.round,
    type: r.type,
    verdict: r.verdict,
    reviewer: r.reviewer,
  }));

  // Extract artifact summaries
  const suggestRefactorSummary = extractArtifactSummary(state.peerSyncDir, /^suggest-refactor.*\.md$/);
  const workflowFeedback = extractAllWorkflowFeedback(state.peerSyncDir);

  // Copy feedback files to harness/feedback/ for the digest pipeline
  persistWorkflowFeedback(state.peerSyncDir, taskId);

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
    reviews,
    threads: allThreads,
    turns: allTurns,
    missingThreads: allMissing,
    suggestRefactorSummary,
    workflowFeedback,
    workflowFeedbackSummary: Object.values(workflowFeedback)[0] ?? null,
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
    reviews: [],
    threads: allThreads,
    turns: allTurns,
    missingThreads: allMissing,
    suggestRefactorSummary: null,
    workflowFeedback: {},
    workflowFeedbackSummary: null,
    collectedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  writeRetrospective(data);
  console.error(`ludics: retrospective fallback written for ${taskId} (${allTurns.length} turns)`);
}
