// Regression tests for the in-flight delivery directory (gh-ludics-535;
// supersedes the gh-ludics-526 sentinel + timeout + retry-cap suite).
//
// Each test pins one of the proposal's acceptance criteria from
// docs/proposals/in-flight-deliveries-panel.md. The shared invariant is
// that the gate stays serializing (≤ 1 unresolved delivery at a time)
// but recovery is passive: a delivery resolves naturally when its result
// JSON appears, or by user action via the dashboard panel. Nothing
// auto-times-out, auto-requeues, or auto-drops.

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
function inFlightDirPath(): string {
  return join(magDir(), "in-flight");
}
function inFlightFilePath(id: string): string {
  return join(inFlightDirPath(), `${id}.json`);
}
function legacyLastDeliveredPath(): string {
  return join(magDir(), "last-delivered.json");
}
function resultFile(id: string): string {
  return join(magDir(), "results", `${id}.json`);
}
function currentRequestIdFile(): string {
  return join(magDir(), "current-request-id");
}

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
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

// --- A1: deliverPoppedSkill writes mag/in-flight/<id>.json on Tier-2 send ---

describe("deliverPoppedSkill — in-flight write (A1)", () => {
  test("successful Tier-2 send writes mag/in-flight/<id>.json with all fields and emits mag_queue_feed", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-A", action: "learn" });

    const sent = deliverPoppedSkill(
      { requestId: "req-A", command: "/ludics-learn", line },
      { send: () => true, nowMs: Date.parse("2026-05-14T08:06:28Z") },
    );

    expect(sent).toBe(true);
    expect(existsSync(inFlightFilePath("req-A"))).toBe(true);
    const record = JSON.parse(readFileSync(inFlightFilePath("req-A"), "utf-8"));
    expect(record.requestId).toBe("req-A");
    expect(record.command).toBe("/ludics-learn");
    expect(record.line).toBe(line);
    // ISO-with-no-ms format is contract — the dashboard renders it raw.
    expect(record.deliveredAt).toBe("2026-05-14T08:06:28Z");
    expect(readEvents().some((e) => e.event_type === "mag_queue_feed")).toBe(true);
  });
});

// --- A5: send-failure rollback — verbatim line, no retry-count, no events ---

describe("deliverPoppedSkill — send-failure rollback (A5)", () => {
  test("failed send writes NO in-flight record and reinserts the verbatim line at queue head", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-A", action: "learn" });

    const sent = deliverPoppedSkill(
      { requestId: "req-A", command: "/ludics-learn", line },
      { send: () => false },
    );

    expect(sent).toBe(false);
    expect(existsSync(inFlightFilePath("req-A"))).toBe(false);
    const content = readFileSync(queueFile(), "utf-8").trim();
    const reinserted = JSON.parse(content);
    expect(reinserted.id).toBe("req-A");
    // Verbatim: no `_retry_count` key added — the entire retry-cap machinery
    // (gh-ludics-526) is gone with gh-ludics-535.
    expect("_retry_count" in reinserted).toBe(false);
    // No `mag_queue_requeued` / `mag_queue_dropped` events on this path.
    expect(readEvents().some((e) => e.event_type === "mag_queue_requeued")).toBe(false);
    expect(readEvents().some((e) => e.event_type === "mag_queue_dropped")).toBe(false);
  });
});

// --- A1 (Tier-3 control): expectsResult:false skips the in-flight write ---

describe("deliverPoppedSkill — Tier-3 items skip the in-flight write", () => {
  test("expectsResult:false → successful send writes NO in-flight record but still emits mag_queue_feed", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-MSG", action: "message", content: "hello" });

    const sent = deliverPoppedSkill(
      { requestId: "req-MSG", command: "hello", line, expectsResult: false },
      { send: () => true },
    );

    expect(sent).toBe(true);
    expect(existsSync(inFlightFilePath("req-MSG"))).toBe(false);
    expect(readEvents().some((e) => e.event_type === "mag_queue_feed")).toBe(true);
  });

  test("expectsResult:true → in-flight record still written (Tier-2 unchanged)", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-SKILL", action: "learn" });

    const sent = deliverPoppedSkill(
      { requestId: "req-SKILL", command: "/ludics-learn", line, expectsResult: true },
      { send: () => true },
    );

    expect(sent).toBe(true);
    expect(existsSync(inFlightFilePath("req-SKILL"))).toBe(true);
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

  test("expectsResult is true for a registered skill action, false for a Tier-3 message", async () => {
    const { queuePopSkill } = await import("./mag.ts");

    writeFileSync(queueFile(), JSON.stringify({ id: "req-POP-SKILL", action: "learn" }) + "\n");
    const skill = await queuePopSkill();
    expect(skill!.expectsResult).toBe(true);

    writeFileSync(queueFile(), JSON.stringify({ id: "req-POP-MSG", action: "message", content: "hi" }) + "\n");
    const msg = await queuePopSkill();
    expect(msg!.expectsResult).toBe(false);
  });
});

// --- A2: reconcileInFlight is passive — delete on result-exists, nothing else ---

describe("reconcileInFlight (A2)", () => {
  function seedInFlight(id: string): void {
    mkdirSync(inFlightDirPath(), { recursive: true });
    writeFileSync(inFlightFilePath(id), JSON.stringify({
      requestId: id,
      command: "/ludics-learn",
      line: JSON.stringify({ id, action: "learn" }),
      deliveredAt: "2020-01-01T00:00:00Z",
    }));
  }

  test("result JSON present → record deleted, queue untouched (no re-queue)", async () => {
    const { reconcileInFlight } = await import("./mag.ts");
    seedInFlight("req-DONE");
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));

    reconcileInFlight();

    // The invariant: a resolved record is cleared, never re-queued — A2
    // (passive deletion). If reconcileInFlight had carried forward the
    // gh-ludics-526 timeout branch this would also append to queue.jsonl.
    expect(existsSync(inFlightFilePath("req-DONE"))).toBe(false);
    expect(readQueueIds()).toEqual([]);
  });

  test("no result, old deliveredAt → record left alone (no auto-requeue, no auto-drop)", async () => {
    const { reconcileInFlight } = await import("./mag.ts");
    seedInFlight("req-OLD");

    reconcileInFlight();

    // The A2 invariant: age does NOT trigger requeue/drop. Under
    // gh-ludics-526 this would have re-queued at the 10-min timeout — A4
    // removes that branch.
    expect(existsSync(inFlightFilePath("req-OLD"))).toBe(true);
    expect(readQueueIds()).toEqual([]);
    expect(readEvents().some((e) => e.event_type === "mag_queue_requeued")).toBe(false);
    expect(readEvents().some((e) => e.event_type === "mag_queue_dropped")).toBe(false);
  });

  test("idempotent — second reconcile is a no-op after the first cleared the record", async () => {
    const { reconcileInFlight } = await import("./mag.ts");
    seedInFlight("req-DONE");
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));

    reconcileInFlight();
    reconcileInFlight(); // double-clear path — unlinkSync ENOENT swallow

    expect(existsSync(inFlightFilePath("req-DONE"))).toBe(false);
    expect(readQueueIds()).toEqual([]);
  });
});

// --- A3: deliveryGateBlocked is true iff any record lacks a matching result ---

describe("deliveryGateBlocked (A3)", () => {
  function writeRecord(id: string, deliveredAt: string = new Date().toISOString()): void {
    mkdirSync(inFlightDirPath(), { recursive: true });
    writeFileSync(inFlightFilePath(id), JSON.stringify({
      requestId: id, command: "/ludics-learn",
      line: JSON.stringify({ id, action: "learn" }),
      deliveredAt,
    }));
  }

  test("unresolved record present → blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    writeRecord("req-INFLIGHT");
    expect(deliveryGateBlocked()).toBe(true);
  });

  test("record present AND matching result JSON exists → not blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    writeRecord("req-INFLIGHT");
    writeFileSync(resultFile("req-INFLIGHT"), JSON.stringify({ id: "req-INFLIGHT", status: "ok" }));
    expect(deliveryGateBlocked()).toBe(false);
  });

  test("no records → not blocked", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    expect(deliveryGateBlocked()).toBe(false);
  });

  test("record with an ancient deliveredAt is STILL blocking — no age cutoff (A4)", async () => {
    const { deliveryGateBlocked } = await import("./mag.ts");
    // Mutation-test the gate against the removed age branch: under
    // gh-ludics-526 this returned false at age > 10 min; under A3 the gate
    // is purely "record exists without result".
    writeRecord("req-OLD", "2020-01-01T00:00:00Z");
    expect(deliveryGateBlocked()).toBe(true);
  });
});

// --- AC 4: direct (non-keepalive) callers also reconcile before popping ---

describe("maybeFeedMagQueue — reconcile-as-invariant for direct callers (AC 4)", () => {
  test("a resolved in-flight record is cleared before any pop", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    // A was delivered and its result has landed but reconcile hasn't run yet.
    mkdirSync(inFlightDirPath(), { recursive: true });
    const lineA = JSON.stringify({ id: "req-A", action: "learn" });
    writeFileSync(inFlightFilePath("req-A"), JSON.stringify({
      requestId: "req-A", command: "/ludics-learn", line: lineA,
      deliveredAt: "2020-01-01T00:00:00Z",
    }));
    writeFileSync(resultFile("req-A"), JSON.stringify({ id: "req-A", status: "ok" }));
    // B is queued behind it.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-B", action: "learn" }) + "\n");
    // Mag is settled so maybeFeedMagQueue proceeds past the readiness guard.
    touchSentinel(join(magDir(), "settled"));

    // Inject a failing send so the test never touches a real tmux pane.
    await maybeFeedMagQueue({ send: () => false });

    // The in-function reconcileInFlight() must have run BEFORE any pop —
    // A's record is gone (result landed) and B's verbatim line is back in
    // the durable queue (the failed-send rollback never overwrote anything).
    expect(existsSync(inFlightFilePath("req-A"))).toBe(false);
    expect(readQueueIds()).toContain("req-B");
  });
});

// --- gh-ludics-535 follow-up: maybeFeedMagQueue orphan-pop (no permanent
// wedge) — the deliveryGateBlocked() pause is gone. The orphan-pop fires at
// the pop site only: when Mag is idle AND a pending skill item would
// otherwise be popped. An unresolved in-flight record observed at that point
// is a genuine orphan; that event pops exactly one orphan and nudges instead
// of delivering, so the queue always drains. With an empty queue there is no
// pop opportunity, so a lingering orphan is left untouched (it wedges
// nothing) and cleared lazily on the next event with a real pending item. ---

describe("maybeFeedMagQueue — orphan-pop replaces the delivery-gate pause", () => {
  function seedInFlight(id: string, deliveredAt: string): void {
    mkdirSync(inFlightDirPath(), { recursive: true });
    writeFileSync(inFlightFilePath(id), JSON.stringify({
      requestId: id, command: "/ludics-learn",
      line: JSON.stringify({ id, action: "learn" }),
      deliveredAt,
    }));
  }

  test("one unresolved orphan + Mag idle → clears that record, sends one nudge, returns true, delivers NO queued skill", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    seedInFlight("req-ORPHAN", "2026-05-15T08:00:00Z");
    // A queued skill sits behind the orphan — it must NOT be delivered this tick.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-QUEUED", action: "learn" }) + "\n");
    touchSentinel(join(magDir(), "settled"));

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });

    expect(result).toBe(true);
    // Orphan record cleared.
    expect(existsSync(inFlightFilePath("req-ORPHAN"))).toBe(false);
    // Exactly one send — the nudge — and it is NOT a skill delivery.
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("req-ORPHAN");
    expect(sends[0]).toContain("no matching result log");
    // The queued skill is untouched (not popped, no in-flight record).
    expect(readQueueIds()).toEqual(["req-QUEUED"]);
    expect(existsSync(inFlightFilePath("req-QUEUED"))).toBe(false);
    // Observability event emitted.
    expect(readEvents().some((e) => e.event_type === "mag_in_flight_orphan_cleared")).toBe(true);
    // The atomic claim ran before the orphan-pop, so the settled sentinel is
    // consumed even on the orphan-pop path. The next keepalive tick will not
    // see a stale settled state and deliver a skill into the now-busy (just
    // nudged) Mag pane — it falls through to the isMagReady() pane check.
    expect(existsSync(join(magDir(), "settled"))).toBe(false);
  });

  test("two orphans → one cleared per call; two calls clear both (each call needs a pending queue item)", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    seedInFlight("req-OLD", "2026-05-15T08:00:00Z");
    seedInFlight("req-NEW", "2026-05-15T09:00:00Z");
    // A pending skill item must be present for the pop site to be reached;
    // it stays unpopped while an orphan is cleared instead.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-QUEUED", action: "learn" }) + "\n");

    // First call: oldest orphan cleared, queued item untouched.
    touchSentinel(join(magDir(), "settled"));
    const r1 = await maybeFeedMagQueue({ send: () => true });
    expect(r1).toBe(true);
    expect(existsSync(inFlightFilePath("req-OLD"))).toBe(false);
    expect(existsSync(inFlightFilePath("req-NEW"))).toBe(true);
    expect(readQueueIds()).toEqual(["req-QUEUED"]);

    // Second call: remaining orphan cleared, queued item still untouched.
    touchSentinel(join(magDir(), "settled"));
    const r2 = await maybeFeedMagQueue({ send: () => true });
    expect(r2).toBe(true);
    expect(existsSync(inFlightFilePath("req-NEW"))).toBe(false);
    expect(readQueueIds()).toEqual(["req-QUEUED"]);
  });

  test("orphan present but request queue EMPTY → in-flight record untouched, no nudge, returns false (no pop opportunity)", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    seedInFlight("req-ORPHAN", "2026-05-15T08:00:00Z");
    // No queue file at all — a bare keepalive tick. With nothing to pop there
    // is no pop site, so the orphan-pop must NOT run; the orphan is left for a
    // later event where a real pending item is waiting (it wedges nothing).
    touchSentinel(join(magDir(), "settled"));

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });

    expect(result).toBe(false);
    expect(existsSync(inFlightFilePath("req-ORPHAN"))).toBe(true);
    expect(sends.length).toBe(0);
    expect(readEvents().some((e) => e.event_type === "mag_in_flight_orphan_cleared")).toBe(false);
  });

  test("orphan lingering with an empty queue is cleared lazily on the next event that has a pending item", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    seedInFlight("req-ORPHAN", "2026-05-15T08:00:00Z");

    // First event: empty queue → orphan untouched.
    touchSentinel(join(magDir(), "settled"));
    const sends: string[] = [];
    const r1 = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });
    expect(r1).toBe(false);
    expect(existsSync(inFlightFilePath("req-ORPHAN"))).toBe(true);
    expect(sends.length).toBe(0);

    // Second event: a real pending item arrives → orphan-pop fires now.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-QUEUED", action: "learn" }) + "\n");
    touchSentinel(join(magDir(), "settled"));
    const r2 = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });
    expect(r2).toBe(true);
    expect(existsSync(inFlightFilePath("req-ORPHAN"))).toBe(false);
    expect(sends.length).toBe(1);
    expect(readQueueIds()).toEqual(["req-QUEUED"]);
  });

  test("nudge is sent exactly once per orphan — a follow-up call finds no record and does not re-nudge", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    seedInFlight("req-ORPHAN", "2026-05-15T08:00:00Z");
    // A pending item is required for the pop site (and thus the orphan-pop)
    // to be reached.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-QUEUED", action: "learn" }) + "\n");

    const sends: string[] = [];
    touchSentinel(join(magDir(), "settled"));
    await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });
    // Record gone — a second tick must not re-nudge the same orphan.
    touchSentinel(join(magDir(), "settled"));
    await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });

    // Two sends total: the one-time orphan nudge, then the normal delivery of
    // the queued item once the orphan is gone. The nudge text appears once.
    expect(sends.filter((c) => c.includes("no matching result log")).length).toBe(1);
    expect(sends.filter((c) => c.includes("req-ORPHAN")).length).toBe(1);
  });

  test("no orphans → normal pop+deliver still works (regression check)", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    // No in-flight records. One queued skill.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-NORMAL", action: "learn" }) + "\n");
    touchSentinel(join(magDir(), "settled"));

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });

    expect(result).toBe(true);
    // The queued skill was delivered: sent once, popped from the queue, and
    // an in-flight record written for it (Tier-2 contract).
    expect(sends.length).toBe(1);
    expect(readQueueIds()).toEqual([]);
    expect(existsSync(inFlightFilePath("req-NORMAL"))).toBe(true);
    expect(readEvents().some((e) => e.event_type === "mag_queue_feed")).toBe(true);
  });

  test("resolved record is reconciled away, then normal delivery proceeds (no false orphan-pop)", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    // A delivered skill whose result JSON has landed — must be reconciled,
    // NOT treated as an orphan.
    seedInFlight("req-DONE", "2026-05-15T08:00:00Z");
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));
    writeFileSync(queueFile(), JSON.stringify({ id: "req-NEXT", action: "learn" }) + "\n");
    touchSentinel(join(magDir(), "settled"));

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });

    expect(result).toBe(true);
    expect(existsSync(inFlightFilePath("req-DONE"))).toBe(false);
    // The resolved record was not an orphan — normal delivery happened.
    expect(readQueueIds()).toEqual([]);
    expect(existsSync(inFlightFilePath("req-NEXT"))).toBe(true);
    expect(readEvents().some((e) => e.event_type === "mag_in_flight_orphan_cleared")).toBe(false);
  });

  test("Mag not idle → no orphan-pop (genuinely in-flight delivery is left alone)", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");

    // An in-flight record but NO settled sentinel — Mag may be mid-turn, so
    // its result JSON is legitimately absent. maybeFeedMagQueue must bail at
    // the idle precondition without touching the record.
    seedInFlight("req-INFLIGHT", "2026-05-15T08:00:00Z");

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({ send: (_s, cmd) => { sends.push(cmd); return true; } });

    expect(result).toBe(false);
    expect(existsSync(inFlightFilePath("req-INFLIGHT"))).toBe(true);
    expect(sends.length).toBe(0);
  });
});

// --- Codex P1 follow-up: orphan-pop is gated to a CONFIRMED settled turn.
// `isMagSettled()` (the stop-hook sentinel) is proof the turn ended;
// `isMagReady()` (pane quiet >5s) is only a heuristic — a Tier-2 skill can
// legitimately still be running while its pane is quiet (waiting on a subagent
// or a long Bash call). On the ready-only path an in-flight record must NOT be
// reclassified as an orphan: clearing it + delivering the next skill would
// break the one-in-flight serialization invariant. Instead maybeFeedMagQueue
// returns false — a bounded pause resolved by the next stop-hook settle. ---

describe("maybeFeedMagQueue — orphan-pop gated to a confirmed settled turn (Codex P1)", () => {
  function seedInFlight(id: string, deliveredAt: string): void {
    mkdirSync(inFlightDirPath(), { recursive: true });
    writeFileSync(inFlightFilePath(id), JSON.stringify({
      requestId: id, command: "/ludics-learn",
      line: JSON.stringify({ id, action: "learn" }),
      deliveredAt,
    }));
  }

  test("ready-only path + unresolved in-flight record → returns false, record kept, NO nudge, NO orphan event, NO delivery", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");

    // Mag is NOT settled (no stop-hook sentinel) but the pane is quiet
    // (isReady() true). The in-flight skill may still be running — its result
    // JSON is legitimately absent. A queued skill sits behind it.
    seedInFlight("req-INFLIGHT", "2026-05-15T08:00:00Z");
    writeFileSync(queueFile(), JSON.stringify({ id: "req-QUEUED", action: "learn" }) + "\n");

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({
      send: (_s, cmd) => { sends.push(cmd); return true; },
      isReady: () => true,
    });

    // Bounded pause: false, and nothing was touched.
    expect(result).toBe(false);
    // The in-flight record is NOT cleared — it may still be a running skill.
    expect(existsSync(inFlightFilePath("req-INFLIGHT"))).toBe(true);
    // No nudge sent, no skill delivered (the one-in-flight invariant holds).
    expect(sends.length).toBe(0);
    // The queued skill stays put — not popped, no in-flight record for it.
    expect(readQueueIds()).toEqual(["req-QUEUED"]);
    expect(existsSync(inFlightFilePath("req-QUEUED"))).toBe(false);
    // No orphan-classification event — orphan-pop requires a settled turn.
    expect(readEvents().some((e) => e.event_type === "mag_in_flight_orphan_cleared")).toBe(false);
  });

  test("ready-only path + NO in-flight record → normal pop + deliver still works", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");

    // Ready-only path, nothing in flight: delivering is always safe because an
    // in-flight record is written for every Tier-2 delivery, so "no record"
    // means "no Tier-2 skill running".
    writeFileSync(queueFile(), JSON.stringify({ id: "req-NORMAL", action: "learn" }) + "\n");

    const sends: string[] = [];
    const result = await maybeFeedMagQueue({
      send: (_s, cmd) => { sends.push(cmd); return true; },
      isReady: () => true,
    });

    expect(result).toBe(true);
    expect(sends.length).toBe(1);
    expect(readQueueIds()).toEqual([]);
    expect(existsSync(inFlightFilePath("req-NORMAL"))).toBe(true);
    expect(readEvents().some((e) => e.event_type === "mag_queue_feed")).toBe(true);
  });

  test("bounded pause resolves: a later settled event with the same record still unresolved runs the orphan-pop", async () => {
    const { maybeFeedMagQueue } = await import("./mag.ts");
    const { touchSentinel } = await import("./sentinel.ts");

    seedInFlight("req-INFLIGHT", "2026-05-15T08:00:00Z");
    writeFileSync(queueFile(), JSON.stringify({ id: "req-QUEUED", action: "learn" }) + "\n");

    // Event 1 — ready-only path: bounded pause, record untouched.
    const sends: string[] = [];
    const r1 = await maybeFeedMagQueue({
      send: (_s, cmd) => { sends.push(cmd); return true; },
      isReady: () => true,
    });
    expect(r1).toBe(false);
    expect(existsSync(inFlightFilePath("req-INFLIGHT"))).toBe(true);
    expect(sends.length).toBe(0);

    // Event 2 — the stop hook now fires (settled). The same record is still
    // unresolved → confirmed turn-end proves it is a genuine orphan, so the
    // orphan-pop runs and clears it. This proves the pause is bounded.
    touchSentinel(join(magDir(), "settled"));
    const r2 = await maybeFeedMagQueue({
      send: (_s, cmd) => { sends.push(cmd); return true; },
    });
    expect(r2).toBe(true);
    expect(existsSync(inFlightFilePath("req-INFLIGHT"))).toBe(false);
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("req-INFLIGHT");
    expect(sends[0]).toContain("no matching result log");
    expect(readEvents().some((e) => e.event_type === "mag_in_flight_orphan_cleared")).toBe(true);
    // The queued skill was NOT delivered on the orphan-pop event.
    expect(readQueueIds()).toEqual(["req-QUEUED"]);
  });
});

// --- A6: pre-send result-file dedup (Tier-2 only) ---

describe("deliverPoppedSkill — pre-send dedup (A6)", () => {
  test("Tier-2 + pre-existing result file → no send, no in-flight write, mag_queue_already_resolved emitted, pop consumed", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-X", action: "learn" });
    // Pre-write the result before the pop is delivered (the manual-bypass
    // pattern Mag uses, A10).
    writeFileSync(resultFile("req-X"), JSON.stringify({ id: "req-X", status: "ok" }));
    let called = 0;
    const sendSpy = (_s: string, _cmd: string): boolean => { called++; return true; };

    const sent = deliverPoppedSkill(
      { requestId: "req-X", command: "/ludics-learn", line },
      { send: sendSpy },
    );

    // The A6 invariant — send must not run, pop is consumed (return true so
    // the caller knows not to reinsert), no in-flight record written.
    expect(called).toBe(0);
    expect(sent).toBe(true);
    expect(existsSync(inFlightFilePath("req-X"))).toBe(false);
    expect(readEvents().some((e) => e.event_type === "mag_queue_already_resolved")).toBe(true);
  });

  test("Tier-2 + no result file → normal delivery path (send called, in-flight written)", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-X", action: "learn" });
    let called = 0;
    const sendSpy = (_s: string, _cmd: string): boolean => { called++; return true; };

    const sent = deliverPoppedSkill(
      { requestId: "req-X", command: "/ludics-learn", line },
      { send: sendSpy },
    );

    expect(called).toBe(1);
    expect(sent).toBe(true);
    expect(existsSync(inFlightFilePath("req-X"))).toBe(true);
    expect(readEvents().some((e) => e.event_type === "mag_queue_already_resolved")).toBe(false);
  });

  test("Tier-3 + pre-existing result file → send STILL runs (dedup gated off, no in-flight write)", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-MSG", action: "message", content: "hi" });
    // Tier-3 items never expect a result file — even if one happens to
    // exist with a matching id, dedup must skip the check.
    writeFileSync(resultFile("req-MSG"), JSON.stringify({ id: "req-MSG", status: "ok" }));
    let called = 0;
    const sendSpy = (_s: string, _cmd: string): boolean => { called++; return true; };

    const sent = deliverPoppedSkill(
      { requestId: "req-MSG", command: "hi", line, expectsResult: false },
      { send: sendSpy },
    );

    expect(called).toBe(1);
    expect(sent).toBe(true);
    expect(existsSync(inFlightFilePath("req-MSG"))).toBe(false);
    expect(readEvents().some((e) => e.event_type === "mag_queue_already_resolved")).toBe(false);
  });

  // A10: manual bypass — Mag pre-writes a result with a skip-marker status
  // and the A6 dedup check honours it by construction. Three documented
  // status conventions exercised separately.
  for (const status of ["skipped-duplicate", "skipped-superseded", "preempted"] as const) {
    test(`A10 manual bypass: pre-written result status "${status}" suppresses delivery`, async () => {
      const { deliverPoppedSkill } = await import("./mag.ts");
      const line = JSON.stringify({ id: "req-SKIP", action: "learn" });
      // Synthetic result with the skip-marker status — same result-file
      // machinery the worker uses, distinguished only by `status` string.
      writeFileSync(resultFile("req-SKIP"), JSON.stringify({
        id: "req-SKIP", status, timestamp: "2026-05-15T10:00:00Z",
      }));
      let called = 0;
      const sendSpy = (_s: string, _cmd: string): boolean => { called++; return true; };

      const sent = deliverPoppedSkill(
        { requestId: "req-SKIP", command: "/ludics-learn", line },
        { send: sendSpy },
      );

      expect(called).toBe(0);
      expect(sent).toBe(true);
      expect(existsSync(inFlightFilePath("req-SKIP"))).toBe(false);
    });
  }
});

// --- A8: listInFlightDeliveries returns sorted array, filters resolved ---

describe("listInFlightDeliveries (A8)", () => {
  function seed(id: string, deliveredAt: string): void {
    mkdirSync(inFlightDirPath(), { recursive: true });
    writeFileSync(inFlightFilePath(id), JSON.stringify({
      requestId: id, command: "/ludics-learn",
      line: JSON.stringify({ id, action: "learn" }),
      deliveredAt,
    }));
  }

  test("returns records sorted by deliveredAt ascending (oldest first)", async () => {
    const { listInFlightDeliveries } = await import("./mag.ts");
    seed("req-NEW", "2026-05-15T12:00:00Z");
    seed("req-OLD", "2026-05-14T08:00:00Z");
    seed("req-MID", "2026-05-15T08:00:00Z");

    const got = listInFlightDeliveries();
    expect(got.map(r => r.requestId)).toEqual(["req-OLD", "req-MID", "req-NEW"]);
  });

  test("filters out records whose result JSON has appeared", async () => {
    const { listInFlightDeliveries } = await import("./mag.ts");
    seed("req-PENDING", "2026-05-15T10:00:00Z");
    seed("req-DONE", "2026-05-15T11:00:00Z");
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));

    const got = listInFlightDeliveries();
    expect(got.map(r => r.requestId)).toEqual(["req-PENDING"]);
  });

  test("returns [] when directory is absent", async () => {
    const { listInFlightDeliveries } = await import("./mag.ts");
    expect(listInFlightDeliveries()).toEqual([]);
  });
});

// --- A11: state-migration triple ---
// (1) positive backfill from legacy mag/last-delivered.json
// (2) negative control — no inputs, no directory created
// (3) JSON round-trip fidelity via writeInFlight/readInFlight
// Plus: malformed record is skipped without crashing the keepalive.

describe("migrateLastDeliveredFile (A11 positive backfill)", () => {
  test("legacy mag/last-delivered.json is migrated to mag/in-flight/<id>.json and the old file is unlinked", async () => {
    const { migrateLastDeliveredFile, readInFlight } = await import("./mag.ts");
    // Harness condition: a valid legacy sentinel from gh-ludics-526's regime.
    const legacyRecord = {
      requestId: "req-LEG",
      command: "/ludics-briefing",
      line: JSON.stringify({ id: "req-LEG", action: "briefing" }),
      deliveredAt: "2026-05-15T07:40:12Z",
    };
    writeFileSync(legacyLastDeliveredPath(), JSON.stringify(legacyRecord));

    migrateLastDeliveredFile();

    expect(existsSync(inFlightFilePath("req-LEG"))).toBe(true);
    expect(existsSync(legacyLastDeliveredPath())).toBe(false);
    const got = readInFlight("req-LEG");
    expect(got).toEqual(legacyRecord);
  });

  test("idempotent — re-running on a worktree with no legacy file is a no-op", async () => {
    const { migrateLastDeliveredFile } = await import("./mag.ts");
    const legacyRecord = {
      requestId: "req-LEG",
      command: "/ludics-briefing",
      line: JSON.stringify({ id: "req-LEG", action: "briefing" }),
      deliveredAt: "2026-05-15T07:40:12Z",
    };
    writeFileSync(legacyLastDeliveredPath(), JSON.stringify(legacyRecord));

    migrateLastDeliveredFile();
    // Second run: legacy file is gone — must not throw, must not unwrite.
    migrateLastDeliveredFile();

    expect(existsSync(inFlightFilePath("req-LEG"))).toBe(true);
  });
});

describe("migrateLastDeliveredFile (A11 negative control)", () => {
  test("no legacy file and no in-flight dir → migrator creates no directory and writes no record", async () => {
    const { migrateLastDeliveredFile, listInFlight } = await import("./mag.ts");

    migrateLastDeliveredFile();

    // The A11 negative-control invariant: idempotent means no side effects,
    // not "equivalent output after a terminate-and-restart". Asserting
    // `existsSync(inFlightDirPath())` is false catches a migrator that
    // unconditionally mkdirs.
    expect(existsSync(inFlightDirPath())).toBe(false);
    expect(listInFlight()).toEqual([]);
  });
});

describe("in-flight record round-trip fidelity (A11 JSON round-trip leg)", () => {
  test("writeInFlight → readInFlight preserves every field byte-equal", async () => {
    const { writeInFlight, readInFlight } = await import("./mag.ts");
    const record = {
      requestId: "req-RT",
      command: "/ludics-learn",
      line: JSON.stringify({ id: "req-RT", action: "learn", _retry_count: 2 }),
      deliveredAt: "2026-05-14T09:00:00Z",
    };

    writeInFlight(record);
    const got = readInFlight("req-RT");

    expect(got).toEqual(record);
  });

  test("deliverPoppedSkill write → readInFlight preserves every field", async () => {
    const { deliverPoppedSkill, readInFlight } = await import("./mag.ts");
    const line = JSON.stringify({ id: "req-RT", action: "learn", _retry_count: 2 });

    deliverPoppedSkill(
      { requestId: "req-RT", command: "/ludics-learn", line },
      { send: () => true, nowMs: Date.parse("2026-05-14T09:00:00Z") },
    );

    expect(readInFlight("req-RT")).toEqual({
      requestId: "req-RT",
      command: "/ludics-learn",
      line,
      deliveredAt: "2026-05-14T09:00:00Z",
    });
  });
});

describe("listInFlight — skips malformed records (A11 robustness)", () => {
  test("malformed JSON in the directory is skipped; valid records still surface", async () => {
    const { listInFlight, reconcileInFlight } = await import("./mag.ts");
    mkdirSync(inFlightDirPath(), { recursive: true });
    writeFileSync(join(inFlightDirPath(), "req-BAD.json"), "{not valid json");
    writeFileSync(inFlightFilePath("req-OK"), JSON.stringify({
      requestId: "req-OK", command: "/ludics-learn",
      line: JSON.stringify({ id: "req-OK", action: "learn" }),
      deliveredAt: "2026-05-15T10:00:00Z",
    }));

    // The list helper must filter the malformed entry, not throw.
    const got = listInFlight();
    expect(got.map(r => r.requestId)).toEqual(["req-OK"]);
    // reconcileInFlight iterates listInFlight — also must not throw.
    reconcileInFlight();
    expect(existsSync(inFlightFilePath("req-OK"))).toBe(true);
  });

  test("record missing requestId / line is rejected as malformed", async () => {
    const { readInFlight } = await import("./mag.ts");
    mkdirSync(inFlightDirPath(), { recursive: true });
    // Missing `line` — required field.
    writeFileSync(inFlightFilePath("req-MISSING"), JSON.stringify({
      requestId: "req-MISSING", command: "/ludics-learn", deliveredAt: "2026-05-15T10:00:00Z",
    }));

    expect(readInFlight("req-MISSING")).toBeNull();
  });
});

// --- task-c16f71b5: delivery-time staleness gate -----------------------------
//
// An autonomously enqueued, condition-gated request (carrying `enqueueSource`)
// whose motivating predicate no longer holds at pop time is consumed without
// sending: no `send`, no in-flight record, a `skipped-stale` skip-marker (Tier-2
// only), and a `mag_queue_skipped_stale` event. Records without `enqueueSource`
// always deliver.

describe("deliverPoppedSkill — delivery-time staleness gate (task-c16f71b5)", () => {
  function tasksDir(): string {
    return join(harnessDir(), "tasks");
  }
  function writeTask(id: string, frontmatter: string): void {
    mkdirSync(tasksDir(), { recursive: true });
    writeFileSync(join(tasksDir(), `${id}.md`), `---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n`);
  }
  function readResult(id: string): Record<string, unknown> | null {
    if (!existsSync(resultFile(id))) return null;
    return JSON.parse(readFileSync(resultFile(id), "utf-8")) as Record<string, unknown>;
  }
  function skippedStaleEvents(): Record<string, unknown>[] {
    return readEvents().filter((e) => e.event_type === "mag_queue_skipped_stale");
  }

  // AC8(a): a stale autonomous elaborate is dropped — no send, skip-marker
  // written, event emitted, no in-flight record. (The gh-ludics-609 replay.)
  test("stale autonomous elaborate (already elaborated) is dropped without sending", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    writeTask("task-stale", "status: ready\nleaf: true\nelaborated: 2026-06-25\n");
    const line = JSON.stringify({ id: "req-EL", action: "elaborate", task: "task-stale", enqueueSource: "keepalive" });

    let sendCalls = 0;
    const sent = deliverPoppedSkill(
      { requestId: "req-EL", command: "/ludics-elaborate task-stale", line, expectsResult: true },
      { send: () => { sendCalls++; return true; } },
    );

    // The pop is consumed (return true) but the skill is NOT sent — the
    // invariant that would break under the old behaviour (no-op Mag round-trip).
    expect(sent).toBe(true);
    expect(sendCalls).toBe(0);
    expect(existsSync(inFlightFilePath("req-EL"))).toBe(false);
    const marker = readResult("req-EL");
    expect(marker?.status).toBe("skipped-stale");
    expect(marker?.action).toBe("elaborate");
    expect(marker?.task).toBe("task-stale");
    expect(typeof marker?.reason).toBe("string");
    expect(String(marker?.reason)).toContain("elaborated");
    expect(skippedStaleEvents().length).toBe(1);
  });

  // AC8(b): a non-stale autonomous record delivers normally.
  test("non-stale autonomous elaborate (not yet elaborated) delivers normally", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    writeTask("task-fresh", "status: ready\nleaf: true\n");
    const line = JSON.stringify({ id: "req-EL2", action: "elaborate", task: "task-fresh", enqueueSource: "keepalive" });

    let sendCalls = 0;
    const sent = deliverPoppedSkill(
      { requestId: "req-EL2", command: "/ludics-elaborate task-fresh", line, expectsResult: true },
      { send: () => { sendCalls++; return true; } },
    );

    expect(sent).toBe(true);
    expect(sendCalls).toBe(1);
    expect(existsSync(inFlightFilePath("req-EL2"))).toBe(true); // delivered → in-flight written
    expect(readResult("req-EL2")).toBeNull(); // no skip-marker
    expect(skippedStaleEvents().length).toBe(0);
  });

  // AC8(c): a record WITHOUT enqueueSource always delivers, even when its
  // predicate would report stale. Proves the drop is gated on the field, not
  // the predicate alone — mutation guard against dropping user/CLI records.
  test("record lacking enqueueSource delivers even when the predicate would say stale", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    writeTask("task-stale-cli", "status: ready\nleaf: true\nelaborated: 2026-06-25\n");
    // Same already-elaborated task as (a) but no enqueueSource on the line.
    const line = JSON.stringify({ id: "req-CLI", action: "elaborate", task: "task-stale-cli" });

    let sendCalls = 0;
    const sent = deliverPoppedSkill(
      { requestId: "req-CLI", command: "/ludics-elaborate task-stale-cli", line, expectsResult: true },
      { send: () => { sendCalls++; return true; } },
    );

    expect(sent).toBe(true);
    expect(sendCalls).toBe(1);
    expect(existsSync(inFlightFilePath("req-CLI"))).toBe(true);
    expect(readResult("req-CLI")).toBeNull();
    expect(skippedStaleEvents().length).toBe(0);
  });

  // AC8(d): a Tier-3 drop (expectsResult:false) writes NO result file but still
  // emits the event.
  test("Tier-3 stale drop emits the event but writes no result file", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    writeTask("task-stale-t3", "status: ready\nleaf: true\nelaborated: 2026-06-25\n");
    const line = JSON.stringify({ id: "req-T3", action: "elaborate", task: "task-stale-t3", enqueueSource: "keepalive" });

    let sendCalls = 0;
    const sent = deliverPoppedSkill(
      { requestId: "req-T3", command: "/ludics-elaborate task-stale-t3", line, expectsResult: false },
      { send: () => { sendCalls++; return true; } },
    );

    expect(sent).toBe(true);
    expect(sendCalls).toBe(0);
    expect(readResult("req-T3")).toBeNull(); // Tier-3 → no skip-marker
    expect(skippedStaleEvents().length).toBe(1); // …but the event still fires
  });

  // Per-action predicate coverage. Each pair instantiates one drop condition and
  // its non-stale control, observed at the delivery seam.
  test("draft-proposal drops when a proposal already exists, delivers when absent", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");

    writeTask("task-dp1", "status: ready\nleaf: true\nproposal: docs/proposals/x.md\n");
    const dropLine = JSON.stringify({ id: "req-DP1", action: "draft-proposal", task: "task-dp1", enqueueSource: "keepalive" });
    let dropped = 0;
    deliverPoppedSkill({ requestId: "req-DP1", command: "/ludics-draft-proposal task-dp1", line: dropLine, expectsResult: true },
      { send: () => { dropped++; return true; } });
    expect(dropped).toBe(0);
    expect(readResult("req-DP1")?.status).toBe("skipped-stale");

    writeTask("task-dp2", "status: ready\nleaf: true\n");
    const okLine = JSON.stringify({ id: "req-DP2", action: "draft-proposal", task: "task-dp2", enqueueSource: "keepalive" });
    let okSends = 0;
    deliverPoppedSkill({ requestId: "req-DP2", command: "/ludics-draft-proposal task-dp2", line: okLine, expectsResult: true },
      { send: () => { okSends++; return true; } });
    expect(okSends).toBe(1);
    expect(readResult("req-DP2")).toBeNull();
  });

  test("draft-proposal drops when has_questions is set", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    writeTask("task-dpq", "status: ready\nleaf: true\nhas_questions: true\n");
    const line = JSON.stringify({ id: "req-DPQ", action: "draft-proposal", task: "task-dpq", enqueueSource: "keepalive" });
    let sends = 0;
    deliverPoppedSkill({ requestId: "req-DPQ", command: "/ludics-draft-proposal task-dpq", line, expectsResult: true },
      { send: () => { sends++; return true; } });
    expect(sends).toBe(0);
    expect(String(readResult("req-DPQ")?.reason)).toContain("questions");
  });

  test("preempt delivers on preempt-queued, drops once the task is in-progress", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");

    writeTask("task-pre1", "status: preempt-queued\nleaf: true\n");
    const okLine = JSON.stringify({ id: "req-PRE1", action: "preempt", task: "task-pre1", autonomy: "auto", enqueueSource: "sync" });
    let okSends = 0;
    deliverPoppedSkill({ requestId: "req-PRE1", command: "/ludics-preempt task-pre1", line: okLine, expectsResult: true },
      { send: () => { okSends++; return true; } });
    expect(okSends).toBe(1);

    writeTask("task-pre2", "status: in-progress\nleaf: true\n");
    const dropLine = JSON.stringify({ id: "req-PRE2", action: "preempt", task: "task-pre2", autonomy: "auto", enqueueSource: "sync" });
    let dropSends = 0;
    deliverPoppedSkill({ requestId: "req-PRE2", command: "/ludics-preempt task-pre2", line: dropLine, expectsResult: true },
      { send: () => { dropSends++; return true; } });
    expect(dropSends).toBe(0);
    expect(readResult("req-PRE2")?.status).toBe("skipped-stale");
  });

  test("verify-container-completion drops on a reopened child and on a terminal container", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");

    // Reopened child: container not terminal but a child is back to in-progress.
    writeTask("task-cont", "status: ready\nleaf: false\n");
    writeTask("task-child", "status: in-progress\nleaf: true\ndependencies:\n  subtask_of: task-cont\n");
    const childLine = JSON.stringify({ id: "req-VC1", action: "verify-container-completion", task: "task-cont", enqueueSource: "sync" });
    let vc1 = 0;
    deliverPoppedSkill({ requestId: "req-VC1", command: "/ludics-verify-container task-cont", line: childLine, expectsResult: true },
      { send: () => { vc1++; return true; } });
    expect(vc1).toBe(0);
    expect(String(readResult("req-VC1")?.reason)).toContain("children");

    // Container already terminal.
    writeTask("task-cont2", "status: done\nleaf: false\n");
    const termLine = JSON.stringify({ id: "req-VC2", action: "verify-container-completion", task: "task-cont2", enqueueSource: "sync" });
    let vc2 = 0;
    deliverPoppedSkill({ requestId: "req-VC2", command: "/ludics-verify-container task-cont2", line: termLine, expectsResult: true },
      { send: () => { vc2++; return true; } });
    expect(vc2).toBe(0);
    expect(String(readResult("req-VC2")?.reason)).toContain("terminal");
  });

  test("verify-container-completion delivers when every child is terminal", async () => {
    const { deliverPoppedSkill } = await import("./mag.ts");
    writeTask("task-cont3", "status: ready\nleaf: false\n");
    writeTask("task-child3", "status: done\nleaf: true\ndependencies:\n  subtask_of: task-cont3\n");
    const line = JSON.stringify({ id: "req-VC3", action: "verify-container-completion", task: "task-cont3", enqueueSource: "sync" });
    let sends = 0;
    deliverPoppedSkill({ requestId: "req-VC3", command: "/ludics-verify-container task-cont3", line, expectsResult: true },
      { send: () => { sends++; return true; } });
    expect(sends).toBe(1);
    expect(readResult("req-VC3")).toBeNull();
  });
});
