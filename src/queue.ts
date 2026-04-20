// Mag queue functions — queue-based communication with Claude Code Mag session

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";
import { isPlainObject } from "./json.ts";

function queueFile(): string {
  return join(harnessDir(), "mag", "queue.jsonl");
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
  | { action: "briefing" | "suggest" | "health-check" | "adopt-sessions" }
  | { action: "elaborate" | "draft-proposal" | "split-task" | "verify-completion" | "complete-task" | "process-suggestions"; task: string }
  | { action: "revise-proposal"; task: string; feedback?: string }
  | { action: "preempt"; task: string; autonomy: string }
  | { action: "feedback-digest"; repo: string }
  | { action: "message"; content: string }
  | { action: "adapter-followup"; task: string; adapter: string; followup_msg?: string };

export function queueRequest(req: QueueAction): string {
  const file = queueFile();
  mkdirSync(dirname(file), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const requestId = nextRequestId();

  const record = { id: requestId, ...req, timestamp };
  appendFileSync(file, JSON.stringify(record) + "\n");
  emitEvent({ event_type: "queue_request", source: "cli", scope: "queue", action: req.action, message: requestId });
  return requestId;
}

export function queuePop(): string | null {
  const file = queueFile();
  if (!existsSync(file)) return null;

  const content = readFileSync(file, "utf-8").trim();
  if (!content) return null;

  const lines = content.split("\n");
  const first = lines[0]!;
  writeFileSync(file, lines.slice(1).join("\n") + (lines.length > 1 ? "\n" : ""));
  emitEvent({ event_type: "queue_pop", source: "keepalive", scope: "queue", message: first.slice(0, 200) });
  return first;
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
  const tmp = file + ".tmp";
  writeFileSync(tmp, lines.length > 0 ? lines.join("\n") + "\n" : "");
  renameSync(tmp, file);
}

// Note: same read-modify-write pattern as queuePopOne/queuePopAll.
// Concurrent appendFileSync (from queueRequest) between read and rename
// could theoretically be lost, but the window is tiny and a proper fix
// requires a queue-wide lock (out of scope for this change).
export function queueReinsertHead(line: string): void {
  const lines = readQueueLines();
  writeQueueLines([line, ...lines]);
}

export function queuePopOne(): string | null {
  const lines = readQueueLines();
  if (lines.length === 0) return null;
  const first = lines[0]!;
  writeQueueLines(lines.slice(1));
  emitEvent({ event_type: "queue_pop", source: "cli", scope: "queue", message: first.slice(0, 200) });
  return first;
}

export function queuePopAll(): string[] {
  const lines = readQueueLines();
  if (lines.length === 0) return [];
  writeQueueLines([]);
  emitEvent({ event_type: "queue_pop", source: "cli", scope: "queue", message: `popped ${lines.length} items` });
  return lines;
}

export function queueList(): Record<string, unknown>[] {
  return readQueueLines()
    .map(line => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isPlainObject(parsed)) {
          return { raw: line };
        }
        return parsed as Record<string, unknown>;
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
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : ({ error: "non-object result", raw: typeof parsed } as Record<string, unknown>);
      return { file, data, mtimeMs };
    } catch {
      return { file, data: { error: "parse error" } as Record<string, unknown>, mtimeMs };
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
  writeFileSync(resultFile, JSON.stringify(result) + "\n");
  emitEvent({ event_type: "queue_result", source: "mag", scope: "queue", status, message: requestId });
}
