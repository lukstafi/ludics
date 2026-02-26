// Structured event log — append-only JSONL for observability
// Inspired by agent-duo's append_event pattern, adapted for TypeScript/Bun.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { harnessDir } from "./config.ts";

export interface LudicsEvent {
  ts: string;
  epoch: number;
  event_type: string;
  source: string;
  scope: string;
  slot?: number;
  task?: string;
  adapter?: string;
  action?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

function eventsFile(): string {
  return join(harnessDir(), "journal", "events.jsonl");
}

/** Append a structured event to journal/events.jsonl.
 *  Best-effort only: never fails the caller. */
export function emitEvent(event: Omit<LudicsEvent, "ts" | "epoch">): void {
  try {
    const now = new Date();
    const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const epoch = Math.floor(now.getTime() / 1000);

    const full = { ts, epoch, ...event } as LudicsEvent;

    // Strip undefined fields before serialization
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(full)) {
      if (v !== undefined) cleaned[k] = v;
    }

    const dir = join(harnessDir(), "journal");
    mkdirSync(dir, { recursive: true });
    appendFileSync(eventsFile(), JSON.stringify(cleaned) + "\n");
  } catch {
    // Best-effort: never fail the caller
  }
}

// --- CLI query ---

interface EventsQueryOptions {
  type?: string;
  task?: string;
  scope?: string;
  source?: string;
  since?: string;
  limit?: number;
}

function eventsQuery(opts: EventsQueryOptions): void {
  const file = eventsFile();
  if (!existsSync(file)) {
    console.log("No events recorded yet");
    return;
  }

  const content = readFileSync(file, "utf-8").trim();
  if (!content) {
    console.log("No events recorded yet");
    return;
  }

  const lines = content.split("\n");

  // Parse --since as either ISO string or epoch seconds
  let sinceEpoch = 0;
  if (opts.since) {
    const parsed = Number(opts.since);
    if (Number.isFinite(parsed) && parsed > 1e9) {
      sinceEpoch = parsed;
    } else {
      sinceEpoch = Math.floor(new Date(opts.since).getTime() / 1000);
    }
  }

  const results: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as LudicsEvent;
      if (opts.type && event.event_type !== opts.type) continue;
      if (opts.task && event.task !== opts.task) continue;
      if (opts.scope && event.scope !== opts.scope) continue;
      if (opts.source && event.source !== opts.source) continue;
      if (sinceEpoch && event.epoch < sinceEpoch) continue;
      results.push(event);
    } catch {
      continue;
    }
  }

  const limited = opts.limit ? results.slice(-opts.limit) : results;

  if (limited.length === 0) {
    console.log("No matching events");
    return;
  }

  for (const event of limited) {
    console.log(JSON.stringify(event));
  }
}

export function runEvents(args: string[]): void {
  const opts: EventsQueryOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--type": opts.type = args[++i]; break;
      case "--task": opts.task = args[++i]; break;
      case "--scope": opts.scope = args[++i]; break;
      case "--source": opts.source = args[++i]; break;
      case "--since": opts.since = args[++i]; break;
      case "--limit": opts.limit = parseInt(args[++i] ?? "50", 10); break;
    }
  }

  eventsQuery(opts);
}
