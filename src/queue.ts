// Mag queue functions — queue-based communication with Claude Code Mag session

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";

function queueFile(): string {
  return join(harnessDir(), "mag", "queue.jsonl");
}

function resultsDir(): string {
  return join(harnessDir(), "mag", "results");
}

export function queueRequest(action: string, extra?: string): string {
  const file = queueFile();
  mkdirSync(dirname(file), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const requestId = `req-${Math.floor(Date.now() / 1000)}-${process.pid}`;

  let request: string;
  if (extra) {
    request = `{"id":"${requestId}","action":"${action}","timestamp":"${timestamp}",${extra}}`;
  } else {
    request = `{"id":"${requestId}","action":"${action}","timestamp":"${timestamp}"}`;
  }

  appendFileSync(file, request + "\n");
  emitEvent({ event_type: "queue_request", source: "cli", scope: "queue", action, message: requestId });
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
    try {
      const req = JSON.parse(line);
      console.log(`  ${req.id}: ${req.action} (${req.timestamp})`);
    } catch {
      console.log(`  (unparseable): ${line.slice(0, 80)}`);
    }
  }
}

export function writeResult(requestId: string, status: string, outputFile?: string): void {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const resultFile = join(dir, `${requestId}.json`);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if (outputFile && existsSync(outputFile)) {
    const content = JSON.stringify(readFileSync(outputFile, "utf-8"));
    writeFileSync(resultFile, `{"id":"${requestId}","status":"${status}","timestamp":"${timestamp}","output":${content}}\n`);
  } else {
    writeFileSync(resultFile, `{"id":"${requestId}","status":"${status}","timestamp":"${timestamp}"}\n`);
  }
  emitEvent({ event_type: "queue_result", source: "mag", scope: "queue", status, message: requestId });
}
