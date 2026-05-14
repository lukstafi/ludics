import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { withSyntheticHarness } from "../test-utils.ts";
import { loadSessionSweepState, sweepStatePath } from "./sweep-state.ts";
import { runSessionSweep } from "./sweep.ts";

const harnessDir = withSyntheticHarness(beforeEach, afterEach);

/** Write a raw sweeper-state file with the given records, bypassing the
 *  loader's mode filter so we can verify what the loader keeps/drops. */
function writeRawSweepState(records: Array<Record<string, unknown>>): void {
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  const sessions: Record<string, unknown> = {};
  for (const r of records) {
    sessions[`${r.mode}|${r.projectDir}|${r.name}`] = r;
  }
  writeFileSync(sweepStatePath(), JSON.stringify({ version: 1, sessions }, null, 2) + "\n");
}

describe("loadSessionSweepState — SweepMode narrowed to t3code (gh-ludics-524 AC4)", () => {
  test("drops persisted legacy agent-claude / agent-codex records, keeps t3code", () => {
    const base = {
      projectDir: join(harnessDir(), "proj"),
      cleanupCommand: ["ludics", "t3code", "stop-thread", "x"],
      detachedStreak: 0,
      firstSeenAt: "2026-05-14T00:00:00Z",
      lastSeenAt: "2026-05-14T00:00:00Z",
    };
    writeRawSweepState([
      { ...base, mode: "agent-claude", name: "task-legacy-claude" },
      { ...base, mode: "agent-codex", name: "task-legacy-codex" },
      { ...base, mode: "t3code", name: "thread-keep" },
    ]);

    const state = loadSessionSweepState();
    const modes = Object.values(state.sessions).map((r) => r.mode);
    // Invariant: SWEEP_TARGET_MODES no longer admits the agent modes, so the
    // loader filters those records out. Would fail if SweepMode/SWEEP_TARGET_MODES
    // still included agent-claude/agent-codex.
    expect(modes).toEqual(["t3code"]);
    expect(Object.values(state.sessions)[0]!.name).toBe("thread-keep");
  });
});

describe("runSessionSweep — t3code path intact after agent-branch pruning (gh-ludics-524 AC4)", () => {
  test("dry-run with a registered t3code record reports a summary and never runs an agent cleanup command", async () => {
    writeRawSweepState([
      {
        mode: "t3code",
        projectDir: join(harnessDir(), "proj"),
        name: "thread-detached",
        cleanupCommand: ["ludics", "t3code", "stop-thread", "thread-detached"],
        detachedStreak: 0,
        firstSeenAt: "2026-05-14T00:00:00Z",
        lastSeenAt: "2026-05-14T00:00:00Z",
      },
    ]);

    const logSpy = spyOn(console, "log");
    let logged: string[];
    try {
      await runSessionSweep({ dryRun: true });
      logged = logSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      logSpy.mockRestore();
    }

    // Invariant: the sweep still runs to completion on the t3code-only path
    // and emits its summary line — would fail if the agent-branch pruning
    // broke collectAttachedKeys / knownSessionStillPresent.
    expect(logged.some((l) => l.startsWith("sessions sweep:"))).toBe(true);
    // No agent cleanup driver was ever invoked (none can exist post-removal).
    expect(logged.some((l) => /agent-claude|agent-codex/.test(l))).toBe(false);
  });
});
