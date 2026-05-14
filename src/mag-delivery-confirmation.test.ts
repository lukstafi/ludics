// Regression tests for the delivery-confirmation sentinel (gh-ludics-526).
//
// maybeFeedMagQueue() used to be fire-and-forget: a skill delivered into the
// Mag pane right before an auto-compaction (or crash, or dropped input) was
// silently lost — no result JSON, no retry. These tests pin the sentinel
// write, the reconciliation pass, the delivery gate, and the shared retry-cap
// helper that together close that gap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function harnessDir(): string {
  return join(TMP, "harness");
}
function magDir(): string {
  return join(harnessDir(), "mag");
}
function queueFile(): string {
  return join(magDir(), "queue.jsonl");
}
function lastDeliveredFile(): string {
  return join(magDir(), "last-delivered.json");
}
function resultFile(id: string): string {
  return join(magDir(), "results", `${id}.json`);
}
function currentRequestIdFile(): string {
  return join(magDir(), "current-request-id");
}

function writeConfig(homeDir: string, magSection = ""): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
${magSection}`);
  return configPath;
}

function readQueueIds(): string[] {
  if (!existsSync(queueFile())) return [];
  const content = readFileSync(queueFile(), "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((l) => JSON.parse(l).id as string);
}

function readEvents(): Record<string, unknown>[] {
  const file = join(harnessDir(), "journal", "events.jsonl");
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-delivery-confirm-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(join(magDir(), "results"), { recursive: true });
  mkdirSync(join(harnessDir(), "journal"), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

// --- AC 1: sentinel written on the success path, none on send failure ---

describe("deliverPoppedSkill — sentinel write (AC 1)", () => {
  test("successful send writes mag/last-delivered.json and emits mag_queue_feed", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-A", action: "learn" });

    const sent = deliverPoppedSkill(
      { requestId: "req-A", command: "/ludics-learn", line },
      { send: () => true, nowMs: Date.parse("2026-05-14T08:06:28Z") },
    );

    expect(sent).toBe(true);
    expect(existsSync(lastDeliveredFile())).toBe(true);
    const sentinel = JSON.parse(readFileSync(lastDeliveredFile(), "utf-8"));
    expect(sentinel.requestId).toBe("req-A");
    expect(sentinel.command).toBe("/ludics-learn");
    expect(sentinel.line).toBe(line);
    expect(sentinel.deliveredAt).toBe("2026-05-14T08:06:28Z");
    expect(readEvents().some((e) => e.event_type === "mag_queue_feed")).toBe(true);
  });

  test("failed send writes NO sentinel and re-queues via the retry-cap path", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-A", action: "learn" });

    const sent = deliverPoppedSkill(
      { requestId: "req-A", command: "/ludics-learn", line },
      { send: () => false },
    );

    expect(sent).toBe(false);
    expect(existsSync(lastDeliveredFile())).toBe(false);
    // re-queued at head with an incremented _retry_count
    const content = readFileSync(queueFile(), "utf-8").trim();
    expect(JSON.parse(content)._retry_count).toBe(1);
    expect(JSON.parse(content).id).toBe("req-A");
  });
});

// --- AC 7: queuePopSkill exposes the requestId captured at pop time ---

describe("queuePopSkill — requestId exposure (AC 7)", () => {
  test("return value includes requestId matching the request id and current-request-id file", async () => {
    const { queuePopSkill } = await import("./mag.ts");
    writeFileSync(queueFile(), JSON.stringify({ id: "req-POP-1", action: "learn" }) + "\n");

    const popped = await queuePopSkill();

    expect(popped).not.toBeNull();
    expect(popped!.requestId).toBe("req-POP-1");
    expect(popped!.command).toBe("/ludics-learn");
    // The id must be captured at pop time, not re-read later — it is also the
    // value written to mag/current-request-id.
    expect(readFileSync(currentRequestIdFile(), "utf-8")).toBe("req-POP-1");
  });
});

// --- AC 2 / AC 3: reconciliation confirms, re-queues, or drops ---

describe("reconcileLastDelivered (AC 2, AC 3)", () => {
  test("result JSON present → sentinel cleared, queue untouched (result checked before timeout)", async () => {
    const { reconcileLastDelivered } = await import("./mag.ts");
    // Harness condition: an OLD deliveredAt (well past the timeout) AND a
    // present result file — the confirmed branch must win over the timeout
    // branch, so the line is never re-queued.
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-DONE", command: "/ludics-learn",
      line: JSON.stringify({ id: "req-DONE", action: "learn" }),
      deliveredAt: "2020-01-01T00:00:00Z",
    }));
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));

    reconcileLastDelivered();

    expect(existsSync(lastDeliveredFile())).toBe(false);
    expect(readQueueIds()).toEqual([]); // not double-queued
  });

  test("past threshold, no result → line re-queued at head with _retry_count++, sentinel cleared, mag_queue_requeued emitted", async () => {
    const { reconcileLastDelivered } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-LOST", action: "learn" });
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-LOST", command: "/ludics-learn", line,
      deliveredAt: "2020-01-01T00:00:00Z",
    }));

    reconcileLastDelivered();

    expect(existsSync(lastDeliveredFile())).toBe(false);
    const content = readFileSync(queueFile(), "utf-8").trim();
    expect(JSON.parse(content).id).toBe("req-LOST");
    expect(JSON.parse(content)._retry_count).toBe(1);
    expect(readEvents().some((e) => e.event_type === "mag_queue_requeued")).toBe(true);
  });

  test("past threshold, _retry_count at the cap → item dropped, not reinserted, sentinel cleared, mag_queue_dropped emitted", async () => {
    const { reconcileLastDelivered } = await import("./mag.ts");
    // Harness condition: _retry_count already at DEFAULT_MAX_REQUEUE_RETRIES (3).
    const line = JSON.stringify({ id: "req-POISON", action: "learn", _retry_count: 3 });
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-POISON", command: "/ludics-learn", line,
      deliveredAt: "2020-01-01T00:00:00Z",
    }));

    reconcileLastDelivered();

    expect(existsSync(lastDeliveredFile())).toBe(false);
    expect(readQueueIds()).toEqual([]); // dropped, not reinserted
    expect(readEvents().some((e) => e.event_type === "mag_queue_dropped")).toBe(true);
  });

  test("under threshold, no result → sentinel left untouched for the next tick", async () => {
    const { reconcileLastDelivered } = await import("./mag.ts");
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-FRESH", command: "/ludics-learn",
      line: JSON.stringify({ id: "req-FRESH", action: "learn" }),
      deliveredAt: new Date().toISOString(),
    }));

    reconcileLastDelivered();

    expect(existsSync(lastDeliveredFile())).toBe(true);
    expect(readQueueIds()).toEqual([]);
  });
});

// --- AC 4: delivery gated on the sentinel ---

describe("deliveryGateBlocked (AC 4)", () => {
  function writeSentinel(deliveredAt: string): void {
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-INFLIGHT", command: "/ludics-learn",
      line: JSON.stringify({ id: "req-INFLIGHT", action: "learn" }),
      deliveredAt,
    }));
  }

  test("unresolved sentinel under threshold → blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    writeSentinel(new Date().toISOString());
    expect(deliveryGateBlocked()).toBe(true);
  });

  test("matching result JSON exists → not blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    writeSentinel(new Date().toISOString());
    writeFileSync(resultFile("req-INFLIGHT"), JSON.stringify({ id: "req-INFLIGHT", status: "ok" }));
    expect(deliveryGateBlocked()).toBe(false);
  });

  test("sentinel past threshold → not blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    writeSentinel("2020-01-01T00:00:00Z");
    expect(deliveryGateBlocked()).toBe(false);
  });

  test("no sentinel → not blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    expect(deliveryGateBlocked()).toBe(false);
  });
});

// --- AC 4: direct (non-keepalive) callers also reconcile before popping ---

describe("maybeFeedMagQueue — reconcile-as-invariant for direct callers (AC 4)", () => {
  test("a direct call with an expired sentinel for A re-queues A and clears the sentinel before B can be delivered", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    // A was delivered long ago and never confirmed (compaction lost it).
    const lineA = JSON.stringify({ id: "req-A", action: "learn" });
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-A", command: "/ludics-learn", line: lineA,
      deliveredAt: "2020-01-01T00:00:00Z",
    }));
    // B is queued behind it.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-B", action: "learn" }) + "\n");
    // Mag is settled so maybeFeedMagQueue proceeds past the readiness guard.
    touchSentinel(join(magDir(), "settled"));

    // Inject a failing send so the test never touches a real tmux pane; the
    // reconcile/gate logic under test runs identically regardless of send.
    await maybeFeedMagQueue({ send: () => false });

    // The in-function reconcileLastDelivered() must have run BEFORE any pop:
    // A's sentinel is cleared (not overwritten by a B sentinel) and A's line
    // is back in the durable queue — never silently lost.
    expect(existsSync(lastDeliveredFile())).toBe(false);
    const ids = readQueueIds();
    expect(ids).toContain("req-A");
    expect(ids).toContain("req-B");
  });
});

// --- AC 6: shared retry-cap helper ---

describe("requeueWithRetryCap — shared retry-cap logic (AC 6)", () => {
  test("under the cap → reinserts at head with _retry_count++ and returns 'requeued'", async () => {
    const { requeueWithRetryCap } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-1", action: "learn", _retry_count: 1 });

    const outcome = requeueWithRetryCap(line, "/ludics-learn", "send-failed");

    expect(outcome).toBe("requeued");
    const content = readFileSync(queueFile(), "utf-8").trim();
    expect(JSON.parse(content)._retry_count).toBe(2);
  });

  test("at the cap → drops the item, returns 'dropped', does not reinsert", async () => {
    const { requeueWithRetryCap } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-1", action: "learn", _retry_count: 3 });

    const outcome = requeueWithRetryCap(line, "/ludics-learn", "delivery-unconfirmed");

    expect(outcome).toBe("dropped");
    expect(readQueueIds()).toEqual([]);
  });

  test("honors a configured mag.max_requeue_retries", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, "mag:\n  max_requeue_retries: 5\n");
    const { requeueWithRetryCap } = await import("./mag.ts");
    // _retry_count 3 is under a configured cap of 5 → still requeued.
    const line = JSON.stringify({ id: "req-1", action: "learn", _retry_count: 3 });

    const outcome = requeueWithRetryCap(line, "/ludics-learn", "send-failed");

    expect(outcome).toBe("requeued");
    expect(JSON.parse(readFileSync(queueFile(), "utf-8").trim())._retry_count).toBe(4);
  });
});

// --- AC 8: dashboard in-flight sentinel exposure (server contract) ---

describe("readInFlightDelivery (AC 8)", () => {
  test("returns the sentinel payload when unresolved", async () => {
    const { readInFlightDelivery } = await import("./mag.ts");
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-IF", command: "/ludics-learn",
      line: JSON.stringify({ id: "req-IF", action: "learn" }),
      deliveredAt: "2026-05-14T08:06:28Z",
    }));

    const inFlight = readInFlightDelivery();
    expect(inFlight).not.toBeNull();
    expect(inFlight!.requestId).toBe("req-IF");
    expect(inFlight!.command).toBe("/ludics-learn");
    expect(inFlight!.deliveredAt).toBe("2026-05-14T08:06:28Z");
  });

  test("returns null once a matching result JSON exists", async () => {
    const { readInFlightDelivery } = await import("./mag.ts");
    writeFileSync(lastDeliveredFile(), JSON.stringify({
      requestId: "req-IF", command: "/ludics-learn",
      line: JSON.stringify({ id: "req-IF", action: "learn" }),
      deliveredAt: "2026-05-14T08:06:28Z",
    }));
    writeFileSync(resultFile("req-IF"), JSON.stringify({ id: "req-IF", status: "ok" }));

    expect(readInFlightDelivery()).toBeNull();
  });

  test("returns null when there is no sentinel", async () => {
    const { readInFlightDelivery } = await import("./mag.ts");
    expect(readInFlightDelivery()).toBeNull();
  });
});

// --- Round-trip fidelity: sentinel survives write → read ---

describe("last-delivered sentinel round-trip fidelity", () => {
  test("deliverPoppedSkill write → readInFlightDelivery preserves every field", async () => {
    const { deliverPoppedSkill, readInFlightDelivery } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-RT", action: "learn", _retry_count: 2 });

    deliverPoppedSkill(
      { requestId: "req-RT", command: "/ludics-learn", line },
      { send: () => true, nowMs: Date.parse("2026-05-14T09:00:00Z") },
    );

    const got = readInFlightDelivery();
    expect(got).toEqual({
      requestId: "req-RT",
      command: "/ludics-learn",
      line,
      deliveredAt: "2026-05-14T09:00:00Z",
    });
  });
});
