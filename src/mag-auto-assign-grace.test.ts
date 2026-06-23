// Tests for the auto-assign grace window (lukstafi/ludics auto-assign race).
//
// The keepalive auto-fill grabs a task for an empty slot the instant the task
// becomes assignable, which twice raced a deliberate manual launch within one
// keepalive beat. The fix introduces a persisted per-task "first-seen-
// assignable" debounce (`mag/auto-assign-seen.json`, task-id -> epochSeconds):
// a freshly-assignable task must wait at least one full beat (~75s grace)
// before the auto-fill may claim it.
//
// These tests pin the pure gate `autoAssignGraceGate(taskId, candidateSet,
// nowSeconds, graceSeconds)` with an injected clock so they are deterministic:
//   (a) a freshly-seen task is skipped on the first beat, then assigned once
//       the grace elapses;
//   (b) a task seen longer ago than the grace assigns immediately;
//   (c) sidecar entries are cleared when a task leaves the candidate set.

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

describe("autoAssignGraceGate", () => {
  // (a) Freshly-seen task: skipped on first beat, assigned after grace elapses.
  test("freshly-seen task is skipped on first beat, then assigned after grace", async () => {
    const { autoAssignGraceGate } = await import("./mag.ts");
    const t0 = 1_000_000;

    // First beat: task is newly assignable → record `now`, skip.
    expect(autoAssignGraceGate("task-X", ["task-X"], t0, GRACE)).toBe(false);
    expect(readSeen()["task-X"]).toBe(t0);

    // A beat later, still inside the grace window → still skip.
    expect(autoAssignGraceGate("task-X", ["task-X"], t0 + 60, GRACE)).toBe(false);

    // Past the grace window → proceed.
    expect(autoAssignGraceGate("task-X", ["task-X"], t0 + GRACE, GRACE)).toBe(true);
    expect(autoAssignGraceGate("task-X", ["task-X"], t0 + GRACE + 5, GRACE)).toBe(true);
  });

  // (b) A task whose first-seen epoch is already older than the grace assigns
  //     immediately (a long-standing assignable task does not wait).
  test("task seen longer ago than grace assigns immediately", async () => {
    const { autoAssignGraceGate } = await import("./mag.ts");
    const seenAt = 1_000_000;
    // Pre-seed the sidecar via a prior beat at seenAt.
    expect(autoAssignGraceGate("task-Y", ["task-Y"], seenAt, GRACE)).toBe(false);

    // Now a much later beat: gate proceeds on the very first check past grace.
    expect(autoAssignGraceGate("task-Y", ["task-Y"], seenAt + 10_000, GRACE)).toBe(true);
  });

  // (c) Sidecar entries are cleared when a task leaves the candidate set, so
  //     re-entering resets the grace.
  test("entries are cleared when a task leaves the candidate set", async () => {
    const { autoAssignGraceGate } = await import("./mag.ts");
    const t0 = 1_000_000;

    // Two candidates seen.
    autoAssignGraceGate("task-A", ["task-A", "task-B"], t0, GRACE);
    expect(Object.keys(readSeen()).sort()).toEqual(["task-A", "task-B"]);

    // Next beat: task-B has left the candidate set → its entry is cleared.
    autoAssignGraceGate("task-A", ["task-A"], t0 + 10, GRACE);
    expect(Object.keys(readSeen())).toEqual(["task-A"]);
    // task-A's original first-seen epoch is preserved (grace not reset).
    expect(readSeen()["task-A"]).toBe(t0);

    // task-B re-enters later → grace resets (recorded at the new `now`), so it
    // is skipped on this re-entry beat.
    expect(autoAssignGraceGate("task-B", ["task-A", "task-B"], t0 + 200, GRACE)).toBe(false);
    expect(readSeen()["task-B"]).toBe(t0 + 200);
  });

  // clearAutoAssignSeen drops a task's record (called after a real assignment),
  // so a later re-entry restarts the grace.
  test("clearAutoAssignSeen drops the record so re-entry restarts grace", async () => {
    const { autoAssignGraceGate, clearAutoAssignSeen } = await import("./mag.ts");
    const t0 = 1_000_000;
    autoAssignGraceGate("task-Z", ["task-Z"], t0, GRACE);
    expect(readSeen()["task-Z"]).toBe(t0);

    clearAutoAssignSeen("task-Z");
    expect("task-Z" in readSeen()).toBe(false);

    // Re-entry records a fresh first-seen and is skipped this beat.
    expect(autoAssignGraceGate("task-Z", ["task-Z"], t0 + 1000, GRACE)).toBe(false);
    expect(readSeen()["task-Z"]).toBe(t0 + 1000);
  });
});
