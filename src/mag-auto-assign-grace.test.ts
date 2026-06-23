// Tests for the auto-assign grace window (lukstafi/ludics auto-assign race).
//
// The keepalive auto-fill grabs a task for an empty slot the instant the task
// becomes assignable, which twice raced a deliberate manual launch within one
// keepalive beat. The fix introduces a persisted per-task "first-seen-
// assignable" debounce (`mag/auto-assign-seen.json`, task-id -> epochSeconds):
// a freshly-assignable task must wait at least one full beat (~75s grace)
// before the auto-fill may claim it.
//
// The bookkeeping is split into two pieces (Codex PR #591 review), each pinned
// here with an injected clock so the tests are deterministic:
//
//   - `autoAssignGraceGate(taskId, nowSeconds, graceSeconds)` — runs ONLY for a
//     task that has already passed every assignment-eligibility check and is
//     about to be assigned. It records first-seen on first sight and reports
//     whether the grace elapsed. A task that never reaches the gate (because it
//     isn't actually assignable this beat) is therefore never recorded/aged.
//
//   - `reconcileAutoAssignSeen(candidateSet, nowSeconds)` — runs UNCONDITIONALLY
//     every beat against the full current candidate set, clearing entries for
//     tasks that have left the set (so re-entry resets the grace) and pruning
//     stale entries, independent of whether any candidate reaches the gate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function harnessDir(): string {
  return join(TMP, "harness");
}
function seenFile(): string {
  return join(harnessDir(), "mag", "auto-assign-seen.json");
}
function readSeen(): Record<string, number> {
  if (!existsSync(seenFile())) return {};
  return JSON.parse(readFileSync(seenFile(), "utf-8")) as Record<string, number>;
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-grace-"));
  process.env.HOME = TMP;
  // No config file: autoAssignGraceSeconds() falls back to the default, and
  // the gate's grace arg is passed explicitly in every test anyway.
  delete process.env.LUDICS_CONFIG;
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
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

const GRACE = 75;
const PRUNE = 24 * 60 * 60;

describe("autoAssignGraceGate", () => {
  // (a) Freshly-seen task: skipped on first beat, assigned after grace elapses.
  test("freshly-seen task is skipped on first beat, then assigned after grace", async () => {
    const { autoAssignGraceGate } = await import("./mag.ts");
    const t0 = 1_000_000;

    // First beat: task is newly assignable → record `now`, skip.
    expect(autoAssignGraceGate("task-X", t0, GRACE)).toBe(false);
    expect(readSeen()["task-X"]).toBe(t0);

    // A beat later, still inside the grace window → still skip.
    expect(autoAssignGraceGate("task-X", t0 + 60, GRACE)).toBe(false);

    // Past the grace window → proceed.
    expect(autoAssignGraceGate("task-X", t0 + GRACE, GRACE)).toBe(true);
    expect(autoAssignGraceGate("task-X", t0 + GRACE + 5, GRACE)).toBe(true);
  });

  // (b) A task whose first-seen epoch is already older than the grace assigns
  //     immediately (a long-standing assignable task does not wait).
  test("task seen longer ago than grace assigns immediately", async () => {
    const { autoAssignGraceGate } = await import("./mag.ts");
    const seenAt = 1_000_000;
    // Pre-seed the sidecar via a prior beat at seenAt.
    expect(autoAssignGraceGate("task-Y", seenAt, GRACE)).toBe(false);

    // Now a much later beat: gate proceeds on the very first check past grace.
    expect(autoAssignGraceGate("task-Y", seenAt + 10_000, GRACE)).toBe(true);
  });

  // (d) The gate records/ages ONLY the task it is called with — a task that
  //     never reaches the gate (not assignable this beat) is never recorded.
  //     This is the Codex fix #1 invariant: eligibility gates the recording.
  test("gate records only the task it is invoked for, not other candidates", async () => {
    const { autoAssignGraceGate } = await import("./mag.ts");
    const t0 = 1_000_000;

    // Only the assignable task reaching the gate is recorded; a sibling
    // candidate that failed a downstream eligibility check is never passed in,
    // so it is never aged.
    expect(autoAssignGraceGate("task-assignable", t0, GRACE)).toBe(false);
    expect(Object.keys(readSeen())).toEqual(["task-assignable"]);
    expect("task-not-yet-assignable" in readSeen()).toBe(false);
  });
});

describe("reconcileAutoAssignSeen", () => {
  // (c) Entries are cleared when a task leaves the candidate set, so re-entering
  //     resets the grace. This runs unconditionally each beat — independent of
  //     whether any candidate reaches the gate.
  test("entries are cleared when a task leaves the candidate set", async () => {
    const { autoAssignGraceGate, reconcileAutoAssignSeen } = await import("./mag.ts");
    const t0 = 1_000_000;

    // Two candidates recorded via the gate (both reach it on their beat).
    autoAssignGraceGate("task-A", t0, GRACE);
    autoAssignGraceGate("task-B", t0, GRACE);
    expect(Object.keys(readSeen()).sort()).toEqual(["task-A", "task-B"]);

    // Next beat: reconcile against a candidate set without task-B → its entry
    // is cleared, task-A's original first-seen is preserved.
    reconcileAutoAssignSeen(["task-A"], t0 + 10);
    expect(Object.keys(readSeen())).toEqual(["task-A"]);
    expect(readSeen()["task-A"]).toBe(t0);

    // task-B re-enters and reaches the gate later → grace resets (recorded at
    // the new `now`), so it is skipped on this re-entry beat.
    expect(autoAssignGraceGate("task-B", t0 + 200, GRACE)).toBe(false);
    expect(readSeen()["task-B"]).toBe(t0 + 200);
  });

  // Codex fix #2: a recorded task that leaves the candidate set on a beat where
  // NOTHING reaches the gate (e.g. all slots busy → early return before any
  // assignment) is still cleared, because reconcile runs unconditionally.
  test("clears a departed task even when no candidate reaches the gate", async () => {
    const { autoAssignGraceGate, reconcileAutoAssignSeen } = await import("./mag.ts");
    const t0 = 1_000_000;

    // task-busy was recorded as assignable on an earlier beat.
    autoAssignGraceGate("task-busy", t0, GRACE);
    expect(readSeen()["task-busy"]).toBe(t0);

    // Later beat: task-busy has left the candidate set (e.g. manually assigned
    // while all slots were occupied). No candidate is assigned this beat, but
    // reconcile against the empty candidate set still clears the stale entry.
    reconcileAutoAssignSeen([], t0 + 30);
    expect("task-busy" in readSeen()).toBe(false);

    // When it later re-enters and reaches the gate, it gets a FRESH grace
    // window rather than inheriting the old (already-aged) timestamp.
    expect(autoAssignGraceGate("task-busy", t0 + 40, GRACE)).toBe(false);
    expect(readSeen()["task-busy"]).toBe(t0 + 40);
  });

  // Stale entries past the prune bound are dropped even if still in the set.
  test("prunes entries older than the prune bound", async () => {
    const { autoAssignGraceGate, reconcileAutoAssignSeen } = await import("./mag.ts");
    const t0 = 1_000_000;
    autoAssignGraceGate("task-old", t0, GRACE);

    // Still in the candidate set, but now far past the prune window → dropped.
    reconcileAutoAssignSeen(["task-old"], t0 + PRUNE + 1);
    expect("task-old" in readSeen()).toBe(false);
  });
});

describe("clearAutoAssignSeen", () => {
  // clearAutoAssignSeen drops a task's record (called after a real assignment),
  // so a later re-entry restarts the grace.
  test("clearAutoAssignSeen drops the record so re-entry restarts grace", async () => {
    const { autoAssignGraceGate, clearAutoAssignSeen } = await import("./mag.ts");
    const t0 = 1_000_000;
    autoAssignGraceGate("task-Z", t0, GRACE);
    expect(readSeen()["task-Z"]).toBe(t0);

    clearAutoAssignSeen("task-Z");
    expect("task-Z" in readSeen()).toBe(false);

    // Re-entry records a fresh first-seen and is skipped this beat.
    expect(autoAssignGraceGate("task-Z", t0 + 1000, GRACE)).toBe(false);
    expect(readSeen()["task-Z"]).toBe(t0 + 1000);
  });
});
