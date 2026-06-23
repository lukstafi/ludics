// Mag queue functions — queue-based communication with Claude Code Mag session

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, rmdirSync } from "fs";
import { join, dirname } from "path";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";
import { atomicWriteFileSync, isPlainObject, writeJsonFileCompact } from "./json.ts";
import { isWorkerContext } from "./orchestration/state.ts";

function queueFile(): string {
  return join(harnessDir(), "mag", "queue.jsonl");
}

// gh-ludics-592 (defect 2): the Mag request queue (mag/queue.jsonl) is the
// controller-coordinator's — only the controller drains it. A federation worker
// must never create or mutate the tracked queue file (nor its .lock dir): a
// local write blocks `git pull --ff-only` and strands the worker on a stale
// harness clone (the resurrection incident). Every write/mutate public API
// early-returns BEFORE `withQueueLock` in worker context, returning an
// API-compatible "nothing to do" result. Read-only helpers are untouched. A
// worker never drains the queue, so suppressing the write half is a no-op
// functionally — it only keeps the tree clean.

const LOCK_MAX_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 30_000;

function breakStaleLock(lockDir: string, ownerFile: string): boolean {
  let pid = 0;
  let ts = 0;
  let ownerMissing = false;
  try {
    const owner = readFileSync(ownerFile, "utf-8");
    const [pidStr, tsStr] = owner.split("\n");
    pid = Number(pidStr);
    ts = Number(tsStr);
  } catch {
    ownerMissing = true;
  }

  if (ownerMissing) {
    // A rightful holder may have just mkdir'd the lock dir and been preempted
    // before writing the owner file. Breaking the lock here would violate
    // mutual exclusion (both holder and breaker would proceed). Fall back to
    // the lock directory's own mtime: only break once the dir itself is older
    // than the stale threshold, so a concurrent holder has had ample time to
    // either finish writing the owner file or crash.
    let dirMtimeMs = 0;
    try {
      dirMtimeMs = statSync(lockDir).mtimeMs;
    } catch {
      // Dir vanished between our EEXIST and the stat — nothing to break.
      // Signal "retry" so the outer loop attempts mkdirSync again.
      return true;
    }
    if (Date.now() - dirMtimeMs <= LOCK_STALE_MS) return false;
    try { rmdirSync(lockDir); return true; } catch { return false; }
  }

  const ageStale = Number.isFinite(ts) && ts > 0 && (Date.now() - ts > LOCK_STALE_MS);
  let pidDead = false;
  if (Number.isFinite(pid) && pid > 0) {
    try { process.kill(pid, 0); } catch { pidDead = true; }
  } else {
    pidDead = true;
  }
  if (!ageStale && !pidDead) return false;
  try { unlinkSync(ownerFile); } catch { /* ignore */ }
  try { rmdirSync(lockDir); } catch { return false; }
  return true;
}

export function withQueueLock<T>(fn: () => T): T {
  const file = queueFile();
  mkdirSync(dirname(file), { recursive: true });
  const lockDir = file + ".lock";
  const ownerFile = join(lockDir, "owner");

  let acquired = false;
  for (let i = 0; i < LOCK_MAX_ATTEMPTS; i++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerFile, `${process.pid}\n${Date.now()}`);
      acquired = true;
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (breakStaleLock(lockDir, ownerFile)) {
        continue; // retry immediately after breaking stale lock
      }
      if (i === LOCK_MAX_ATTEMPTS - 1) break;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
  if (!acquired) {
    throw new Error(`queue lock timeout after ${(LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS) / 1000}s at ${lockDir}`);
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(ownerFile); } catch { /* ignore */ }
    try { rmdirSync(lockDir); } catch { /* ignore */ }
  }
}

function resultsDir(): string {
  return join(harnessDir(), "mag", "results");
}

let requestCounter = 0;

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseQueueLines(content: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    const parsed = parseJsonRecord(line);
    if (parsed) result.push(parsed);
  }
  return result;
}

function nextRequestId(): string {
  // Keep the historical req-<epoch>-<number> shape while ensuring uniqueness
  // within a process even when many requests are queued in the same second.
  const epoch = Math.floor(Date.now() / 1000);
  requestCounter = (requestCounter + 1) % 1_000_000;
  const suffix = (process.pid * 1_000_000) + requestCounter;
  return `req-${epoch}-${suffix}`;
}

export type QueueAction =
  | { action: "briefing" | "suggest" | "health-check" | "adopt-sessions" | "sync-learnings" }
  | { action: "elaborate" | "draft-proposal" | "split-task" | "verify-completion" | "verify-container-completion" | "complete-task" | "process-suggestions"; task: string }
  | { action: "revise-proposal"; task: string; feedback?: string }
  | { action: "preempt"; task: string; autonomy: string }
  | { action: "feedback-digest"; repo: string }
  | { action: "message"; content: string }
  | { action: "adapter-followup"; task: string; adapter: string; followup_msg?: string };

/** Optional side-band fields stored on the queue record alongside the
 *  discriminated-union `QueueAction`. Kept separate from `QueueAction` so the
 *  action types stay tight; `bypassGate` is provenance metadata, not a new
 *  action variant. Set by manual CLI handlers in `src/mag.ts` so a queued
 *  request from `ludics mag <skill>` skips the dispatch-time activity gate
 *  even when the snapshot would otherwise suppress it (gh-ludics-538 AC 11).
 *  `triggeredBy` records the request id that caused a follow-up enqueue
 *  (e.g. the briefing/health-check that gated a /compact) so retried
 *  dispatches can dedup against an already-queued follow-up (PR #552 review
 *  by Codex: send-failure rollback used to double-queue /compact). */
export interface QueueRequestExtras {
  bypassGate?: boolean;
  triggeredBy?: string;
}

export function queueRequest(req: QueueAction, extras?: QueueRequestExtras): string {
  if (isWorkerContext()) return ""; // worker: never write the tracked queue (gh-ludics-592)
  const file = queueFile();
  mkdirSync(dirname(file), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const requestId = nextRequestId();

  const baseRecord: Record<string, unknown> = { id: requestId, ...req, timestamp };
  if (extras?.bypassGate === true) baseRecord.bypassGate = true;
  if (typeof extras?.triggeredBy === "string" && extras.triggeredBy.length > 0) {
    baseRecord.triggeredBy = extras.triggeredBy;
  }
  withQueueLock(() => {
    appendFileSync(file, JSON.stringify(baseRecord) + "\n");
  });
  emitEvent(buildQueueRequestEvent(req, requestId));
  return requestId;
}

/** Build the queue_request event payload. For action="message", attach a
 *  truncated `messageContent` so the briefing user-action signal can
 *  distinguish auto-/compact (Mag-internal) from a user message after the
 *  queue record itself has been popped (gh-ludics-538). */
function buildQueueRequestEvent(req: QueueAction, requestId: string): {
  event_type: "queue_request"; source: string; scope: string;
  action: string; message: string; messageContent?: string;
} {
  const base = { event_type: "queue_request" as const, source: "cli", scope: "queue", action: req.action, message: requestId };
  if (req.action === "message") {
    return { ...base, messageContent: String(req.content ?? "").slice(0, 200) };
  }
  return base;
}

function readQueueLines(): string[] {
  const file = queueFile();
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8");
  if (!content || content === "\n") return [];
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  // Blank lines are not valid JSONL entries — drop them as corruption.
  // Non-blank malformed JSON is preserved as-is.
  return lines.filter(l => l.length > 0);
}

function writeQueueLines(lines: string[]): void {
  const file = queueFile();
  atomicWriteFileSync(file, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

export function queueReinsertHead(line: string): void {
  if (isWorkerContext()) return; // worker: never write the tracked queue (gh-ludics-592)
  withQueueLock(() => {
    const lines = readQueueLines();
    writeQueueLines([line, ...lines]);
  });
}

/**
 * Like queueRequest, but prepends to the queue head instead of appending to
 * the tail. Used to enforce ordering when one dispatched request must enqueue
 * a follow-up that runs *before* anything that landed in the tail meanwhile
 * (e.g., health-check coupling /compact directly behind itself — see
 * docs/proposals/auto-compact-after-checkpoints.md).
 */
export function queueRequestAtHead(req: QueueAction, extras?: QueueRequestExtras): string {
  if (isWorkerContext()) return ""; // worker: never write the tracked queue (gh-ludics-592)
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const requestId = nextRequestId();
  const baseRecord: Record<string, unknown> = { id: requestId, ...req, timestamp };
  if (extras?.bypassGate === true) baseRecord.bypassGate = true;
  if (typeof extras?.triggeredBy === "string" && extras.triggeredBy.length > 0) {
    baseRecord.triggeredBy = extras.triggeredBy;
  }
  queueReinsertHead(JSON.stringify(baseRecord));
  emitEvent(buildQueueRequestEvent(req, requestId));
  return requestId;
}

/** True iff the queue already contains a `/compact` follow-up tagged with
 *  the given `triggeredBy` request id. Used by the briefing/health-check
 *  dispatch branches to dedup their `/compact` enqueue on send-failure
 *  rollback retries (PR #552 review by Codex). */
export function queueHasCompactForTrigger(triggerId: string): boolean {
  if (!triggerId) return false;
  for (const line of readQueueLines()) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      rec.action === "message" &&
      rec.content === "/compact" &&
      rec.triggeredBy === triggerId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Re-fire helper (gh-ludics-535): mint a fresh request id (same shape as
 * queueRequest's `req-<epoch>-<counter>`), stamp the original id as
 * `re-fired-from` provenance, and reinsert at the queue head. Returns the
 * new id. Used by the dashboard's `/api/in-flight-refire` endpoint to
 * avoid duplicate-fire when the pre-send dedup check sees the original
 * result file.
 */
export function queueReinsertHeadWithFreshId(
  record: Record<string, unknown>,
  originalId: string,
): string {
  // worker: return a syntactically valid id without reinserting (gh-ludics-592)
  if (isWorkerContext()) return nextRequestId();
  const newId = nextRequestId();
  const updated = { ...record, id: newId, "re-fired-from": originalId };
  queueReinsertHead(JSON.stringify(updated));
  return newId;
}

export function queuePopOne(): string | null {
  if (isWorkerContext()) return null; // worker: never drain/rewrite the tracked queue (gh-ludics-592)
  const result = withQueueLock(() => {
    const lines = readQueueLines();
    if (lines.length === 0) return null;
    const first = lines[0]!;
    writeQueueLines(lines.slice(1));
    return first;
  });
  if (result !== null) {
    emitEvent({ event_type: "queue_pop", source: "cli", scope: "queue", message: result.slice(0, 200) });
  }
  return result;
}

export function queuePopAll(): string[] {
  if (isWorkerContext()) return []; // worker: never drain/rewrite the tracked queue (gh-ludics-592)
  const lines = withQueueLock(() => {
    const all = readQueueLines();
    if (all.length === 0) return [];
    writeQueueLines([]);
    return all;
  });
  if (lines.length > 0) {
    emitEvent({ event_type: "queue_pop", source: "cli", scope: "queue", message: `popped ${lines.length} items` });
  }
  return lines;
}

export type QueuePromoteResult =
  | { status: "promoted"; record: Record<string, unknown> }
  | { status: "already-head" }
  | { status: "not-found" };

function findLineIndexById(lines: string[], id: string): number {
  return lines.findIndex(line => {
    const rec = parseJsonRecord(line);
    return rec !== null && rec.id === id;
  });
}

export function queuePromoteToTop(id: string): QueuePromoteResult {
  if (isWorkerContext()) return { status: "not-found" }; // worker: never rewrite the tracked queue (gh-ludics-592)
  const result = withQueueLock<QueuePromoteResult>(() => {
    const lines = readQueueLines();
    const idx = findLineIndexById(lines, id);
    if (idx < 0) return { status: "not-found" };
    if (idx === 0) return { status: "already-head" };
    const [promoted] = lines.splice(idx, 1);
    writeQueueLines([promoted!, ...lines]);
    const record = parseJsonRecord(promoted!) ?? {};
    return { status: "promoted", record };
  });
  if (result.status === "promoted") {
    emitEvent({ event_type: "queue_mutate", source: "cli", scope: "queue", action: "promote", message: id });
  }
  return result;
}

export type QueueCancelResult =
  | { status: "cancelled"; line: string; request: Record<string, unknown> }
  | { status: "not-found" };

export function queueCancel(id: string): QueueCancelResult {
  if (isWorkerContext()) return { status: "not-found" }; // worker: never rewrite the tracked queue (gh-ludics-592)
  const result = withQueueLock<QueueCancelResult>(() => {
    const lines = readQueueLines();
    const idx = findLineIndexById(lines, id);
    if (idx < 0) return { status: "not-found" };
    const [removed] = lines.splice(idx, 1);
    const request = parseJsonRecord(removed!);
    writeQueueLines(lines);
    // parseJsonRecord returned non-null above (findLineIndexById matched on rec.id)
    return { status: "cancelled", line: removed!, request: request! };
  });
  if (result.status === "cancelled") {
    emitEvent({ event_type: "queue_mutate", source: "cli", scope: "queue", action: "cancel", message: id });
  }
  return result;
}

export type QueueDequeueResult =
  | { status: "empty" }
  | { status: "mismatch" }
  | { status: "popped"; line: string; request: Record<string, unknown> | null };

export function queuePopExpected(expectedLine?: string): QueueDequeueResult {
  if (isWorkerContext()) return { status: "empty" }; // worker: never drain/rewrite the tracked queue (gh-ludics-592)
  return withQueueLock(() => {
    const lines = readQueueLines();
    if (lines.length === 0) return { status: "empty" };
    const first = lines[0]!;
    if (expectedLine !== undefined && first !== expectedLine) {
      return { status: "mismatch" };
    }
    writeQueueLines(lines.slice(1));
    const request = parseJsonRecord(first);
    return { status: "popped", line: first, request };
  });
}

export function queueList(): Record<string, unknown>[] {
  return readQueueLines()
    .map(line => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isPlainObject(parsed)) {
          return { raw: line };
        }
        return parsed;
      } catch { return { raw: line }; }
    });
}

export function queuePending(): boolean {
  const file = queueFile();
  if (!existsSync(file)) return false;
  const content = readFileSync(file, "utf-8").trim();
  return content.length > 0;
}

export function queueHasPendingAction(action: string): boolean {
  const file = queueFile();
  if (!existsSync(file)) return false;

  const content = readFileSync(file, "utf-8").trim();
  if (!content) return false;

  return parseQueueLines(content).some(req => req.action === action);
}

export function queueHasPendingActionForTask(action: string, taskId: string): boolean {
  const file = queueFile();
  if (!existsSync(file)) return false;

  const content = readFileSync(file, "utf-8").trim();
  if (!content) return false;

  return parseQueueLines(content).some(
    req => req.action === action && String(req.task ?? "") === taskId
  );
}

export function queueHasPendingFeedbackDigest(repo: string): boolean {
  const file = queueFile();
  if (!existsSync(file)) return false;

  const content = readFileSync(file, "utf-8").trim();
  if (!content) return false;

  return parseQueueLines(content).some(
    req => req.action === "feedback-digest" && String(req.repo ?? "") === repo
  );
}

export function queueShow(): void {
  const file = queueFile();
  if (!existsSync(file)) {
    console.log("No pending queue requests");
    return;
  }
  const content = readFileSync(file, "utf-8").trim();
  if (!content) {
    console.log("No pending queue requests");
    return;
  }
  const lines = content.split("\n");
  console.log(`${lines.length} pending request(s):`);
  for (const line of lines) {
    const req = parseJsonRecord(line);
    if (req) {
      console.log(`  ${String(req.id ?? "")}: ${String(req.action ?? "")} (${String(req.timestamp ?? "")})`);
    } else {
      console.log(`  (unparseable): ${line.slice(0, 80)}`);
    }
  }
}

export function recentResults(limit: number = 20): { file: string; data: Record<string, unknown>; mtimeMs: number }[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => {
      const full = join(dir, f);
      try {
        return { file: full, mtimeMs: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
  return files.map(({ file, mtimeMs }) => {
    try {
      const parsed = parseJsonRecord(readFileSync(file, "utf-8"));
      const data = parsed ?? ({ error: "invalid result JSON" } as Record<string, unknown>);
      return { file, data, mtimeMs };
    } catch {
      return { file, data: { error: "read error" } as Record<string, unknown>, mtimeMs };
    }
  });
}

export function writeResult(requestId: string, status: string, outputFile?: string, extra?: Record<string, unknown>): void {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const resultFile = join(dir, `${requestId}.json`);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const result: Record<string, unknown> = { id: requestId, status, timestamp, ...extra };
  if (outputFile && existsSync(outputFile)) {
    result.output = readFileSync(outputFile, "utf-8");
  }
  writeJsonFileCompact(resultFile, result);
  emitEvent({ event_type: "queue_result", source: "mag", scope: "queue", status, message: requestId });
}
