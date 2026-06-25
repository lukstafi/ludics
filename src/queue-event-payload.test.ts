import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { withSyntheticHarness } from "./test-utils.ts";
import { queueRequest, queueRequestAtHead } from "./queue.ts";

function readLastEvent(stateDir: string): Record<string, unknown> {
  const evPath = join(stateDir, "journal", "events.jsonl");
  expect(existsSync(evPath)).toBe(true);
  const lines = readFileSync(evPath, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function readLastQueueRecord(stateDir: string): Record<string, unknown> {
  const qPath = join(stateDir, "mag", "queue.jsonl");
  expect(existsSync(qPath)).toBe(true);
  const lines = readFileSync(qPath, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function readFirstQueueRecord(stateDir: string): Record<string, unknown> {
  const qPath = join(stateDir, "mag", "queue.jsonl");
  expect(existsSync(qPath)).toBe(true);
  const lines = readFileSync(qPath, "utf8").trim().split("\n");
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("queue_request event payload — messageContent field (gh-ludics-538)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("queueRequest with action=message attaches messageContent verbatim", () => {
    queueRequest({ action: "message", content: "/compact" });
    const ev = readLastEvent(getStateDir());
    expect(ev.event_type).toBe("queue_request");
    expect(ev.action).toBe("message");
    expect(ev.messageContent).toBe("/compact");
  });

  test("queueRequest with action=message truncates content to 200 chars", () => {
    const long = "a".repeat(500);
    queueRequest({ action: "message", content: long });
    const ev = readLastEvent(getStateDir());
    expect(typeof ev.messageContent).toBe("string");
    expect((ev.messageContent as string).length).toBe(200);
  });

  test("queueRequest with non-message action omits messageContent", () => {
    queueRequest({ action: "briefing" });
    const ev = readLastEvent(getStateDir());
    expect(ev.event_type).toBe("queue_request");
    expect(ev.action).toBe("briefing");
    expect("messageContent" in ev).toBe(false);
  });

  test("queueRequestAtHead with action=message attaches messageContent", () => {
    queueRequestAtHead({ action: "message", content: "/compact" });
    const ev = readLastEvent(getStateDir());
    expect(ev.action).toBe("message");
    expect(ev.messageContent).toBe("/compact");
  });

  test("queueRequestAtHead with non-message action omits messageContent", () => {
    queueRequestAtHead({ action: "feedback-digest", repo: "ludics" });
    const ev = readLastEvent(getStateDir());
    expect(ev.action).toBe("feedback-digest");
    expect("messageContent" in ev).toBe(false);
  });
});

// gh-ludics-538 AC 11: the additive `bypassGate` field on the queue RECORD
// (not the event) carries CLI-bypass provenance to the dispatch-time gate.
describe("queue record — bypassGate field (gh-ludics-538 AC 11)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("queueRequest with extras.bypassGate=true persists bypassGate on the record", () => {
    queueRequest({ action: "briefing" }, { bypassGate: true });
    const rec = readLastQueueRecord(getStateDir());
    expect(rec.action).toBe("briefing");
    expect(rec.bypassGate).toBe(true);
  });

  test("queueRequest without extras omits bypassGate (gated path stays default)", () => {
    queueRequest({ action: "briefing" });
    const rec = readLastQueueRecord(getStateDir());
    expect(rec.action).toBe("briefing");
    expect("bypassGate" in rec).toBe(false);
  });

  test("queueRequest with extras.bypassGate=false omits the field (only true is persisted)", () => {
    queueRequest({ action: "briefing" }, { bypassGate: false });
    const rec = readLastQueueRecord(getStateDir());
    expect("bypassGate" in rec).toBe(false);
  });

  test("queueRequestAtHead with extras.bypassGate=true persists bypassGate", () => {
    queueRequestAtHead({ action: "health-check" }, { bypassGate: true });
    const rec = readFirstQueueRecord(getStateDir());
    expect(rec.action).toBe("health-check");
    expect(rec.bypassGate).toBe(true);
  });

  test("bypassGate survives a JSON round-trip on the queue record", () => {
    queueRequest({ action: "verify-completion", task: "task-rt" }, { bypassGate: true });
    const rec = readLastQueueRecord(getStateDir());
    // Re-serialize and re-parse to prove the field is not dropped by the
    // record's own JSON encoding (the dispatch path re-parses the record).
    const roundTripped = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    expect(roundTripped.action).toBe("verify-completion");
    expect(roundTripped.task).toBe("task-rt");
    expect(roundTripped.bypassGate).toBe(true);
  });

  test("bypassGate is NOT mirrored onto the queue_request event payload", () => {
    queueRequest({ action: "briefing" }, { bypassGate: true });
    const ev = readLastEvent(getStateDir());
    expect(ev.event_type).toBe("queue_request");
    // bypassGate is record-only provenance — the event stays unchanged.
    expect("bypassGate" in ev).toBe(false);
  });
});

// task-c16f71b5: the additive `enqueueSource` field opts an autonomous,
// condition-gated record into the delivery-time staleness re-check. Mirrors the
// bypassGate provenance idiom — set-when-on-the-allow-list, omitted otherwise.
describe("queue record — enqueueSource field (task-c16f71b5)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("queueRequest persists a valid enqueueSource on the record", () => {
    queueRequest({ action: "elaborate", task: "task-es" }, { enqueueSource: "keepalive" });
    const rec = readLastQueueRecord(getStateDir());
    expect(rec.action).toBe("elaborate");
    // Invariant: an autonomous record carries its provenance, so the delivery
    // gate can distinguish it from a user/CLI enqueue. Without this the gate
    // never fires and stale pops reach Mag again.
    expect(rec.enqueueSource).toBe("keepalive");
  });

  test("queueRequest without extras omits enqueueSource (user/CLI records never gated)", () => {
    queueRequest({ action: "elaborate", task: "task-es" });
    const rec = readLastQueueRecord(getStateDir());
    expect(rec.action).toBe("elaborate");
    expect("enqueueSource" in rec).toBe(false);
  });

  test("queueRequest with an off-allow-list enqueueSource omits the field", () => {
    // Only keepalive/sync/retrospective are persisted — a stray value (cast to
    // bypass tsc, mimicking malformed input) must never land on the record.
    queueRequest(
      { action: "elaborate", task: "task-es" },
      { enqueueSource: "manual" as unknown as "keepalive" },
    );
    const rec = readLastQueueRecord(getStateDir());
    expect("enqueueSource" in rec).toBe(false);
  });

  test("queueRequestAtHead persists a valid enqueueSource", () => {
    queueRequestAtHead({ action: "elaborate", task: "task-es" }, { enqueueSource: "sync" });
    const rec = readFirstQueueRecord(getStateDir());
    expect(rec.enqueueSource).toBe("sync");
  });

  test("enqueueSource survives a JSON round-trip on the queue record", () => {
    queueRequest({ action: "preempt", task: "task-rt", autonomy: "auto" }, { enqueueSource: "sync" });
    const rec = readLastQueueRecord(getStateDir());
    // Re-serialize and re-parse to prove the field is not dropped by the
    // record's own JSON encoding (deliverPoppedSkill re-parses the raw line).
    const roundTripped = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    expect(roundTripped.action).toBe("preempt");
    expect(roundTripped.task).toBe("task-rt");
    expect(roundTripped.enqueueSource).toBe("sync");
  });

  test("enqueueSource is NOT mirrored onto the queue_request event payload", () => {
    queueRequest({ action: "elaborate", task: "task-es" }, { enqueueSource: "keepalive" });
    const ev = readLastEvent(getStateDir());
    expect(ev.event_type).toBe("queue_request");
    expect("enqueueSource" in ev).toBe(false);
  });
});
