// Mag queue functions — queue-based communication with Claude Code Mag session

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";

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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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

  for (const line of content.split("\n")) {
    try {
      const request = JSON.parse(line) as Record<string, unknown>;
      if (request.action === action) return true;
    } catch {
      continue;
    }
  }

  return false;
}

export function queueHasPendingFeedbackDigest(repo: string): boolean {
  const file = queueFile();
  if (!existsSync(file)) return false;

  const content = readFileSync(file, "utf-8").trim();
  if (!content) return false;

  for (const line of content.split("\n")) {
    try {
      const request = JSON.parse(line) as Record<string, unknown>;
      if (request.action === "feedback-digest" && String(request.repo ?? "") === repo) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
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

export function writeResult(requestId: string, status: string, outputFile?: string): void {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const resultFile = join(dir, `${requestId}.json`);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const result: Record<string, unknown> = { id: requestId, status, timestamp };
  if (outputFile && existsSync(outputFile)) {
    result.output = readFileSync(outputFile, "utf-8");
  }
  writeFileSync(resultFile, JSON.stringify(result) + "\n");
  emitEvent({ event_type: "queue_result", source: "mag", scope: "queue", status, message: requestId });
}
