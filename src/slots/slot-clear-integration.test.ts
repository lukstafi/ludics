// Integration coverage for task-72a318c3 AC 9.4 — verify that slotClear /
// slotAssign actually reap a real child process via the adapter stop path.
//
// Spawns `sleep 600` as a stand-in for `orch run-internal`, writes its PID
// into tmux-slot-<N>.json, then asserts the child is dead within 2s of
// slotClear / slotAssign. No tmux/ttyd processes are actually launched —
// the adapter's stop() handles a missing tmux session gracefully (the
// `tmux kill-session` / `pkill ttyd` calls become harmless no-ops).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slotAssign, slotClear } from "./index.ts";
import { emptySlotData, writeSlotJson } from "./json.ts";

setDefaultTimeout(15_000);

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

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

function writeTask(tasksDir: string, id: string, title: string): void {
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${title}"
project: demo
status: ready
priority: B
deadline: null
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
effort: medium
context: demo
uses_browser: false
slot: null
adapter: null
created: 2026-03-07
started: null
completed: null
modified: null
source: local
---
`);
}

/** Spawn a real long-running child process that can receive SIGTERM.
 *  Prefers `sleep`; falls back to `node -e 'setInterval'` if sleep is missing. */
function spawnLongRunningChild(): { pid: number; kill: () => void } {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    proc = Bun.spawn(
      ["node", "-e", "setInterval(() => {}, 10000)"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  }
  return {
    pid: proc.pid!,
    kill: () => {
      try { process.kill(proc.pid!, "SIGKILL"); } catch { /* already dead */ }
    },
  };
}

/** Resolve when the pid is no longer alive. `process.kill(pid, 0)` throws
 *  ESRCH once the process is reaped; that is the success signal. Polls every
 *  50ms up to timeoutMs; returns false on timeout. */
async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — the child is gone.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function seedTmuxSlotState(harness: string, slot: number, pid: number): string {
  const dir = join(harness, "orchestration");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `tmux-slot-${slot}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      slot,
      ttydPids: {},
      orchestration: {
        stateFile: `slot-${slot}.json`,
        mode: "pair",
        pid,
      },
    }),
  );
  return file;
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-slot-clear-integration-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("slotClear / slotAssign integration (task-72a318c3)", () => {
  test("slotClear reaps a real spawned child process within 2s", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-integration-clear", "Integration clear");

    await slotAssign(1, "task-integration-clear", "tmux");

    const child = spawnLongRunningChild();
    const stateFile = seedTmuxSlotState(harness, 1, child.pid);
    expect(existsSync(stateFile)).toBe(true);

    try {
      await slotClear(1, "ready");

      // AC 9.4: real orch run-internal is reaped within ~2s of slotClear.
      const died = await waitForDeath(child.pid, 2000);
      expect(died).toBe(true);
      expect(existsSync(stateFile)).toBe(false);
    } finally {
      child.kill();
    }
  });

  test("slotAssign reassignment reaps a real spawned child process within 2s", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-integration-old", "Integration old");
    writeTask(tasksDir, "task-integration-new", "Integration new");

    await slotAssign(1, "task-integration-old", "tmux");

    const child = spawnLongRunningChild();
    const stateFile = seedTmuxSlotState(harness, 1, child.pid);
    expect(existsSync(stateFile)).toBe(true);

    try {
      await slotAssign(1, "task-integration-new", "tmux");

      const died = await waitForDeath(child.pid, 2000);
      expect(died).toBe(true);
      expect(existsSync(stateFile)).toBe(false);
    } finally {
      child.kill();
    }
  });
});
