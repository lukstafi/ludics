import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureT3codeIfEnabled, cleanupDoneTaskThreads, maybeFillEmptySlots } from "./mag.ts";
import * as serverMod from "./t3code/server.ts";
import * as retroMod from "./retrospective.ts";

// gh-ludics-539: the t3code integration feature flag gates three mag.ts
// surfaces — the t3code server nudge (ensureT3codeIfEnabled), the t3code
// thread-deletion block inside cleanupDoneTaskThreads, and keepalive auto-fill
// (maybeFillEmptySlots).

let TMP = "";
const ORIGINAL = {
  HOME: process.env.HOME,
  CONFIG: process.env.LUDICS_CONFIG,
  HARNESS: process.env.LUDICS_HARNESS_DIR,
};

/** Write config.yaml; `mag` is the YAML body under the `mag:` key (already indented). */
function writeConfig(mag: string): void {
  const configPath = join(TMP, "config.yaml");
  writeFileSync(configPath, `state_repo: test/state\nstate_path: harness\nslots:\n  count: 2\n${mag}`);
  process.env.LUDICS_CONFIG = configPath;
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-mag-t3code-flag-"));
  process.env.HOME = TMP;
  process.env.LUDICS_HARNESS_DIR = TMP;
});

afterEach(() => {
  if (ORIGINAL.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL.HOME;
  if (ORIGINAL.CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL.CONFIG;
  if (ORIGINAL.HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL.HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("ensureT3codeIfEnabled — feature-flag gate (gh-ludics-539, AC 6)", () => {
  test("flag off: short-circuits — no server nudge, no 'ensuring' log", async () => {
    writeConfig(""); // no mag section → t3code_integration_enabled absent → off
    const ensureSpy = spyOn(serverMod, "ensureServer").mockResolvedValue(
      {} as Awaited<ReturnType<typeof serverMod.ensureServer>>,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureT3codeIfEnabled("test");
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      // Invariant: the gate returns before the dynamic import + ensureServer
      // call. If the !t3codeIntegrationEnabled() clause were dropped, ensureServer
      // would run (flag-on test below is the positive control).
      expect(ensureSpy).not.toHaveBeenCalled();
      expect(calls.some((l) => l.includes("ensuring t3code server"))).toBe(false);
    } finally {
      errSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });

  test("flag on but ensure_t3code: false: still short-circuits (independent switch preserved)", async () => {
    writeConfig("mag:\n  t3code_integration_enabled: true\n  ensure_t3code: false\n");
    const ensureSpy = spyOn(serverMod, "ensureServer").mockResolvedValue(
      {} as Awaited<ReturnType<typeof serverMod.ensureServer>>,
    );
    try {
      await ensureT3codeIfEnabled("test");
      // The pre-existing ensure_t3code === false switch must keep working.
      expect(ensureSpy).not.toHaveBeenCalled();
    } finally {
      ensureSpy.mockRestore();
    }
  });

  test("flag on, ensure_t3code unset: nudges the server (positive control)", async () => {
    writeConfig("mag:\n  t3code_integration_enabled: true\n");
    const ensureSpy = spyOn(serverMod, "ensureServer").mockResolvedValue(
      {} as Awaited<ReturnType<typeof serverMod.ensureServer>>,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureT3codeIfEnabled("test");
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      // Mutation evidence: with both switches allowing, ensureServer IS called
      // and the 'ensuring' line IS logged — so the flag-off assertions above
      // are meaningful, not vacuous.
      expect(ensureSpy).toHaveBeenCalled();
      expect(calls.some((l) => l.includes("ensuring t3code server"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });
});

describe("cleanupDoneTaskThreads — feature-flag gate (gh-ludics-539, AC 7)", () => {
  /** Write a done task carrying a t3code thread id (so threadIdsToDelete is non-empty). */
  function writeDoneTask(id: string): void {
    const tasksDir = join(TMP, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\nstatus: done\nt3code_threads: [thread-x]\n---\n# ${id}\n`,
    );
  }

  test("flag off: retro fallback still runs; t3code thread-delete block is skipped", async () => {
    writeConfig(""); // flag off
    writeDoneTask("task-done-paused");
    const retroSpy = spyOn(retroMod, "collectRetrospectiveFallback").mockResolvedValue(undefined);
    const statusSpy = spyOn(serverMod, "serverStatus");
    try {
      await cleanupDoneTaskThreads();
      // Invariant (AC 7 revision): the gate sits at the t3code-delete block, NOT
      // the whole function — so the non-t3code retrospective-fallback loop still
      // runs. A whole-function early-return would skip collectRetrospectiveFallback.
      expect(retroSpy).toHaveBeenCalled();
      expect(retroSpy.mock.calls.some((c) => c[0] === "task-done-paused")).toBe(true);
      // And the t3code thread-delete block is skipped: serverStatus is never probed
      // even though the task carries a thread id (threadIdsToDelete is non-empty).
      expect(statusSpy).not.toHaveBeenCalled();
    } finally {
      retroSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("flag on: t3code thread-delete block IS reached (positive control)", async () => {
    writeConfig("mag:\n  t3code_integration_enabled: true\n");
    writeDoneTask("task-done-live");
    const retroSpy = spyOn(retroMod, "collectRetrospectiveFallback").mockResolvedValue(undefined);
    const statusSpy = spyOn(serverMod, "serverStatus").mockResolvedValue({
      running: false,
    } as Awaited<ReturnType<typeof serverMod.serverStatus>>);
    try {
      await cleanupDoneTaskThreads();
      // Mutation evidence: with the flag on, the thread-delete block runs and
      // probes serverStatus — so the flag-off "not called" assertion is real.
      expect(statusSpy).toHaveBeenCalled();
    } finally {
      retroSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });
});

describe("maybeFillEmptySlots — feature-flag gate (gh-ludics-539, AC 5)", () => {
  test("flag off: logs 'auto-fill skipped' and assigns no slot", async () => {
    // Harness: autonomy auto + an empty slot + a ready/elaborated candidate
    // carrying a proposal — the minimal state that drives keepalive auto-fill
    // all the way to selectOrchestrationFlagsForTask.
    writeConfig("mag:\n  autonomy_level:\n    start_sessions: auto\n");
    const tasksDir = join(TMP, "tasks");
    const slotsDir = join(TMP, "slots");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(slotsDir, { recursive: true });
    writeFileSync(
      join(tasksDir, "task-keepalive-paused.md"),
      `---\nid: task-keepalive-paused\ntitle: Keepalive paused\nproject: ludics\n`
        + `status: ready\npriority: B\neffort: medium\nelaborated: 2026-05-01\n`
        + `proposal: docs/proposals/x.md\ndependencies:\n  blocks: []\n  blocked_by: []\n`
        + `  relates_to: []\n  subtask_of: null\ncontext: ludics\nuses_browser: false\n`
        + `created: 2026-05-01\nsource: manual\n---\n# task-keepalive-paused\n`,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await maybeFillEmptySlots();
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      // Invariant: the keepalive catch turns the paused error into a clear log +
      // early return — no slot file is written (slotAssign never runs).
      expect(calls.some((l) => l.includes("auto-fill skipped: t3code integration paused"))).toBe(true);
      expect(readdirSync(slotsDir)).toEqual([]);
      expect(existsSync(join(slotsDir, "slot-1.json"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
