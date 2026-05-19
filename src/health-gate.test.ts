import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  shouldSkipHealthCheck,
  shouldSkipPeriodic,
  HEALTH_GATE_THRESHOLD,
  MAG_AUTO_ACTIONS,
  isMagAutoAction,
  latestUserActionEpoch,
  writeGateSnapshot,
  countGateEligibleLines,
} from "./health-gate.ts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `health-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "journal"), { recursive: true });
  mkdirSync(join(dir, "mag"), { recursive: true });
  return dir;
}

function writeEvents(dir: string, lines: number): void {
  const body = Array.from({ length: lines }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
  writeFileSync(join(dir, "journal", "events.jsonl"), body);
}

function writeHealthSnapshot(dir: string, obj: Record<string, unknown>): void {
  writeFileSync(join(dir, "mag", "health-last.json"), JSON.stringify(obj));
}

describe("shouldSkipHealthCheck (compat wrapper)", () => {
  test("first run with no health-last.json → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 100);
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.priorLines).toBe(0);
    expect(res.reason).toContain("first run");
    rmSync(dir, { recursive: true });
  });

  test("snapshot present but missing eventsJsonlLines → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 100);
    writeHealthSnapshot(dir, { timestamp: "2026-04-24T00:00:00Z", findings: [] });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("signal");
    rmSync(dir, { recursive: true });
  });

  test("delta under threshold → skip: true", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 1030);
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(true);
    expect(res.currentLines).toBe(1030);
    expect(res.priorLines).toBe(1000);
    expect(res.reason).toContain("30");
    rmSync(dir, { recursive: true });
  });

  test("delta exactly at threshold (300) → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 1000 + HEALTH_GATE_THRESHOLD);
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.currentLines - res.priorLines).toBe(HEALTH_GATE_THRESHOLD);
    rmSync(dir, { recursive: true });
  });

  test("delta over threshold → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 1000 + HEALTH_GATE_THRESHOLD + 100);
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.currentLines).toBe(1000 + HEALTH_GATE_THRESHOLD + 100);
    expect(res.priorLines).toBe(1000);
    rmSync(dir, { recursive: true });
  });

  test("events.jsonl missing → skip: false (fail open)", () => {
    const dir = makeTmpDir();
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("fail open");
    rmSync(dir, { recursive: true });
  });

  test("events.jsonl empty → skip: false (fail open)", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "journal", "events.jsonl"), "");
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("fail open");
    rmSync(dir, { recursive: true });
  });

  test("non-numeric eventsJsonlLines → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 100);
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: "1000" });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("signal");
    rmSync(dir, { recursive: true });
  });

  test("line count handles file without trailing newline", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "journal", "events.jsonl"), "a\nb\nc");
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.currentLines).toBe(3);
    rmSync(dir, { recursive: true });
  });

  test("negative delta (rotated/compacted log) → skip: false (fail open)", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 200);
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("backward");
    expect(res.reason).toContain("fail open");
    expect(res.currentLines).toBe(200);
    expect(res.priorLines).toBe(1000);
    rmSync(dir, { recursive: true });
  });

  test("health_check_skipped events are excluded from the gate count (legacy substring fallback)", () => {
    const dir = makeTmpDir();
    const realLines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ event_type: "mag_queue_feed", n: i }));
    const skipLines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ event_type: "health_check_skipped", n: i }));
    writeFileSync(join(dir, "journal", "events.jsonl"), [...realLines, ...skipLines].join("\n") + "\n");
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.currentLines).toBe(40);
    expect(res.skip).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("meta.gateSkip: true events are excluded from the gate count (unified marker)", () => {
    const dir = makeTmpDir();
    const realLines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ event_type: "mag_queue_feed", n: i }));
    // Use a non-canonical event_type so legacy substring exclusion can't act.
    const skipLines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ event_type: "some_other_skip", meta: { gateSkip: true }, n: i }));
    writeFileSync(join(dir, "journal", "events.jsonl"), [...realLines, ...skipLines].join("\n") + "\n");
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    // 40 real + 0 marker-excluded = 40 eligible, delta 40 < 300 → skip.
    expect(res.currentLines).toBe(40);
    expect(res.skip).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("many skip-marker events alone cannot push delta over threshold", () => {
    const dir = makeTmpDir();
    const skipLines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ event_type: "health_check_skipped", n: i }));
    writeFileSync(join(dir, "journal", "events.jsonl"), skipLines.join("\n") + "\n");
    writeHealthSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.currentLines).toBe(0);
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("empty");
    rmSync(dir, { recursive: true });
  });
});

describe("shouldSkipPeriodic — mode dispatch", () => {
  test("count mode: same semantics as wrapper, plus fail-open on negative", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "test-last.json");
    writeGateSnapshot(snap, 1000);
    const dec = shouldSkipPeriodic({
      gateName: "test", snapshotPath: snap, signal: 1100, threshold: 300, mode: "count",
    });
    expect(dec.skip).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("fingerprint mode: equal → skip, changed → run", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "fp-last.json");
    writeGateSnapshot(snap, "abc");
    const eq = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: "abc", threshold: 0, mode: "fingerprint" });
    expect(eq.skip).toBe(true);
    const diff = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: "xyz", threshold: 0, mode: "fingerprint" });
    expect(diff.skip).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("fingerprint mode: first run → run (fail open)", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "fp-missing.json");
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: "abc", threshold: 0, mode: "fingerprint" });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("first run");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: current=null (read error) → run", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br-last.json");
    writeGateSnapshot(snap, 100);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: null, threshold: 3600, mode: "activity-window" });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("unreadable");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: current=0 + prior snapshot → skip (proposal's core skip case)", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br-last.json");
    writeGateSnapshot(snap, 1_000_000_000);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: 0, threshold: 3600, mode: "activity-window" });
    expect(dec.skip).toBe(true);
    expect(dec.reason).toContain("no qualifying user activity");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: current=0 + first run → run", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br-missing.json");
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: 0, threshold: 3600, mode: "activity-window" });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("first run");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: current > prior → run (new activity since prior)", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br.json");
    writeGateSnapshot(snap, 1_000_000_000);
    const now = new Date(2_000_000_000 * 1000);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: 1_999_999_900, threshold: 3600, mode: "activity-window", now });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("new user activity");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: current <= prior + recent → run (defensive recent-activity arm)", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br.json");
    const now = new Date(2_000_000_000 * 1000);
    const recent = Math.floor(now.getTime() / 1000) - 60; // 60s ago
    writeGateSnapshot(snap, recent);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: recent, threshold: 3600, mode: "activity-window", now });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("recent activity");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: current <= prior + stale → skip", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br.json");
    const now = new Date(2_000_000_000 * 1000);
    const stale = Math.floor(now.getTime() / 1000) - 24 * 3600; // 24h ago
    writeGateSnapshot(snap, stale);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: stale, threshold: 18 * 3600, mode: "activity-window", now });
    expect(dec.skip).toBe(true);
    expect(dec.reason).toContain("no progress");
    rmSync(dir, { recursive: true });
  });

  test("activity-window: prior in the future → run (clock-skew defense)", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "br.json");
    const now = new Date(2_000_000_000 * 1000);
    const futurePrior = Math.floor(now.getTime() / 1000) + 1_000_000;
    writeGateSnapshot(snap, futurePrior);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: futurePrior - 10, threshold: 3600, mode: "activity-window", now });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("clock skew");
    rmSync(dir, { recursive: true });
  });

  test("epoch-unchanged: current <= prior → skip", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "v.json");
    writeGateSnapshot(snap, 1_000_000_000);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: 1_000_000_000, threshold: 0, mode: "epoch-unchanged" });
    expect(dec.skip).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("epoch-unchanged: current > prior → run", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "v.json");
    writeGateSnapshot(snap, 1_000_000_000);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: 1_000_000_100, threshold: 0, mode: "epoch-unchanged" });
    expect(dec.skip).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("epoch-unchanged: current=0 (unresolvable) → run (fail open)", () => {
    const dir = makeTmpDir();
    const snap = join(dir, "mag", "v.json");
    writeGateSnapshot(snap, 1_000_000_000);
    const dec = shouldSkipPeriodic({ gateName: "t", snapshotPath: snap, signal: 0, threshold: 0, mode: "epoch-unchanged" });
    expect(dec.skip).toBe(false);
    expect(dec.reason).toContain("no resolvable activity epoch");
    rmSync(dir, { recursive: true });
  });
});

describe("isMagAutoAction", () => {
  test("each MAG_AUTO_ACTIONS entry classifies as auto", () => {
    for (const action of MAG_AUTO_ACTIONS) {
      expect(isMagAutoAction({ action })).toBe(true);
    }
  });

  test("message + /compact classifies as auto", () => {
    expect(isMagAutoAction({ action: "message", messageContent: "/compact" })).toBe(true);
  });

  test("message + user-content does NOT classify as auto", () => {
    expect(isMagAutoAction({ action: "message", messageContent: "hello world" })).toBe(false);
  });

  test("message + missing messageContent (pre-upgrade) fails open to user-action", () => {
    expect(isMagAutoAction({ action: "message" })).toBe(false);
  });

  test("non-denylisted action (elaborate) classifies as user", () => {
    expect(isMagAutoAction({ action: "elaborate" })).toBe(false);
  });

  test("empty record → false", () => {
    expect(isMagAutoAction({})).toBe(false);
  });
});

describe("latestUserActionEpoch", () => {
  function ev(epoch: number, extra: Record<string, unknown>): string {
    return JSON.stringify({ ts: new Date(epoch * 1000).toISOString(), epoch, source: "test", scope: "test", ...extra });
  }

  test("notify_incoming advances the signal", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const target = Math.floor(now.getTime() / 1000) - 300;
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(target, { event_type: "notify_incoming", message: "msg" }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(target);
    rmSync(dir, { recursive: true });
  });

  test("Mag-auto briefing queue_request does NOT advance signal", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const target = Math.floor(now.getTime() / 1000) - 300;
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(target, { event_type: "queue_request", action: "briefing", message: "req-x" }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("user-initiated elaborate queue_request advances signal", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const target = Math.floor(now.getTime() / 1000) - 300;
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(target, { event_type: "queue_request", action: "elaborate", message: "req-x" }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(target);
    rmSync(dir, { recursive: true });
  });

  test("auto-/compact message queue_request does NOT advance signal", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const target = Math.floor(now.getTime() / 1000) - 300;
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(target, { event_type: "queue_request", action: "message", messageContent: "/compact", message: "req-x" }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("user message queue_request advances signal (messageContent != /compact)", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const target = Math.floor(now.getTime() / 1000) - 300;
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(target, { event_type: "queue_request", action: "message", messageContent: "hello", message: "req-x" }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(target);
    rmSync(dir, { recursive: true });
  });

  test("meta.gateSkip events are excluded even when their action would otherwise count", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const target = Math.floor(now.getTime() / 1000) - 300;
    // notify_incoming-shaped event but marked as gate skip — should be excluded.
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(target, { event_type: "notify_incoming", message: "msg", meta: { gateSkip: true } }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("empty events.jsonl + no git repo → returns 0 (clean dead window)", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "journal", "events.jsonl"), "");
    // No tasks/ subdir at all so the git source is skipped (existsSync false).
    const now = new Date(2_000_000_000 * 1000);
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("corrupt events.jsonl read error → returns null (signal unreadable)", () => {
    const dir = makeTmpDir();
    // Truly unreadable: a directory at the path where the file should be.
    rmSync(join(dir, "journal"), { recursive: true });
    mkdirSync(join(dir, "journal", "events.jsonl"), { recursive: true });
    const now = new Date(2_000_000_000 * 1000);
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(null);
    rmSync(dir, { recursive: true });
  });

  test("non-Mag task commit advances signal (Gap C — conservative proxy)", () => {
    const dir = makeTmpDir();
    // Init a real git repo so `git log -- tasks/` returns commits.
    const r = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    r(["init", "-q"]);
    r(["config", "user.email", "test@example.com"]);
    r(["config", "user.name", "Test User"]);
    r(["config", "commit.gpgsign", "false"]);
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks", "test.md"), "---\nstatus: ready\n---\nhi\n");
    r(["add", "tasks/test.md"]);
    r(["commit", "-q", "-m", "add task"]);
    const now = new Date();
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(typeof got).toBe("number");
    expect(got).toBeGreaterThan(0);
    rmSync(dir, { recursive: true });
  });

  test("look-back window bounds activity (very old activity excluded)", () => {
    const dir = makeTmpDir();
    const now = new Date(2_000_000_000 * 1000);
    const ancient = Math.floor(now.getTime() / 1000) - 100 * 24 * 3600; // 100 days ago
    writeFileSync(join(dir, "journal", "events.jsonl"),
      ev(ancient, { event_type: "notify_incoming", message: "msg" }) + "\n");
    const got = latestUserActionEpoch({ stateDir: dir, now, lookbackHours: 48 });
    expect(got).toBe(0);
    rmSync(dir, { recursive: true });
  });
});

describe("countGateEligibleLines — JSON-aware predicate", () => {
  test("excludes meta.gateSkip lines from arbitrary event types", () => {
    const dir = makeTmpDir();
    const path = join(dir, "journal", "events.jsonl");
    const real = JSON.stringify({ event_type: "any", n: 1 });
    const skip = JSON.stringify({ event_type: "made_up_skip", n: 2, meta: { gateSkip: true } });
    writeFileSync(path, [real, skip, real, real].join("\n") + "\n");
    expect(countGateEligibleLines(path)).toBe(3);
    rmSync(dir, { recursive: true });
  });
});

describe("writeGateSnapshot round-trip", () => {
  test("number signal also preserved under legacy eventsJsonlLines alias", () => {
    const dir = makeTmpDir();
    const path = join(dir, "mag", "test-last.json");
    writeGateSnapshot(path, 12345);
    const parsed = JSON.parse(require("fs").readFileSync(path, "utf8"));
    expect(parsed.signal).toBe(12345);
    expect(parsed.eventsJsonlLines).toBe(12345);
    expect(typeof parsed.timestamp).toBe("string");
    rmSync(dir, { recursive: true });
  });

  test("string signal omits the legacy alias", () => {
    const dir = makeTmpDir();
    const path = join(dir, "mag", "fp-last.json");
    writeGateSnapshot(path, "abc123");
    const parsed = JSON.parse(require("fs").readFileSync(path, "utf8"));
    expect(parsed.signal).toBe("abc123");
    expect("eventsJsonlLines" in parsed).toBe(false);
    rmSync(dir, { recursive: true });
  });
});
