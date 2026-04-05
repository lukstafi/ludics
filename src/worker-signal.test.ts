import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
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

function harnessDir(): string {
  return join(TMP, "harness");
}

/** Write a slots.md with one remote slot assigned to the given machine and task. */
function writeSlotsFile(slotNum: number, machineName: string, taskId: string): void {
  const content = `# Slots

## Slot ${slotNum}

**Process:** test-project
**Task:** ${taskId}
**Machine:** ${machineName}
**Mode:** tmux
`;
  writeFileSync(join(harnessDir(), "slots.md"), content);
}

/** Write a worker signal JSON file for the given slot. */
function writeSignalFile(slotNum: number, signal: Record<string, unknown>): void {
  const dir = join(harnessDir(), "worker-signals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `slot-${slotNum}.json`), JSON.stringify(signal, null, 2));
}

function signalExists(slotNum: number): boolean {
  return existsSync(join(harnessDir(), "worker-signals", `slot-${slotNum}.json`));
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-ws-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(harnessDir(), { recursive: true });
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

describe("controllerPollWorkers machine validation", () => {
  // Without federation config, federationCurrentMachineName() returns null,
  // so isRemoteMachine("worker-a") returns true (fail-closed). This lets us
  // test controller behavior for remote slots without a real federation setup.

  test("accepts valid signal with matching taskId and machine", async () => {
    const { controllerPollWorkers } = await import("./worker-signal.ts");
    writeSlotsFile(1, "worker-a", "task-abc");
    // Use "progress" status to avoid triggering slotClear() which needs git
    writeSignalFile(1, {
      taskId: "task-abc",
      status: "progress",
      message: "in progress",
      epoch: Math.floor(Date.now() / 1000),
      machine: "worker-a",
    });

    controllerPollWorkers();

    // Signal should be cleared after processing (not rejected)
    expect(signalExists(1)).toBe(false);
  });

  test("rejects signal with missing machine field", async () => {
    const { controllerPollWorkers } = await import("./worker-signal.ts");
    writeSlotsFile(1, "worker-a", "task-abc");
    writeSignalFile(1, {
      taskId: "task-abc",
      status: "done",
      message: "completed",
      epoch: Math.floor(Date.now() / 1000),
      // no machine field
    });

    controllerPollWorkers();

    // Signal should be cleared (rejected)
    expect(signalExists(1)).toBe(false);
  });

  test("rejects signal with mismatched machine", async () => {
    const { controllerPollWorkers } = await import("./worker-signal.ts");
    writeSlotsFile(1, "worker-a", "task-abc");
    writeSignalFile(1, {
      taskId: "task-abc",
      status: "done",
      message: "completed",
      epoch: Math.floor(Date.now() / 1000),
      machine: "worker-b", // mismatch
    });

    controllerPollWorkers();

    // Signal should be cleared (rejected)
    expect(signalExists(1)).toBe(false);
  });

  test("workerReportStatus writes signal with machine field", async () => {
    const { workerReportStatus, workerReadSignal } = await import("./worker-signal.ts");
    workerReportStatus(1, {
      taskId: "task-xyz",
      status: "done",
      message: "ok",
      machine: "worker-a",
    });

    const raw = workerReadSignal(1);
    expect(raw).toBeTruthy();
    const signal = JSON.parse(raw!);
    expect(signal.machine).toBe("worker-a");
    expect(signal.taskId).toBe("task-xyz");
  });
});
