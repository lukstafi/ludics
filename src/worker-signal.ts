// Worker-to-controller signaling — workers report task status, controller polls and reconciles

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { harnessDir, slotsFilePath } from "./config.ts";
import { parseSlotBlocks, getTask, getMachine } from "./slots/markdown.ts";
import { isRemoteMachine } from "./remote.ts";
import { slotClear } from "./slots/index.ts";
import { emitEvent } from "./events.ts";

interface WorkerSignal {
  taskId: string;
  status: string;   // "done" | "error" | "progress"
  message: string;
  epoch: number;
}

function signalsDir(): string {
  return join(harnessDir(), "worker-signals");
}

function signalFilePath(slotNum: number): string {
  return join(signalsDir(), `slot-${slotNum}.json`);
}

/** Write a status signal on the worker machine (called by worker). */
export function workerReportStatus(
  slotNum: number,
  payload: { taskId: string; status: string; message: string },
): void {
  const dir = signalsDir();
  mkdirSync(dir, { recursive: true });

  const signal: WorkerSignal = {
    ...payload,
    epoch: Math.floor(Date.now() / 1000),
  };

  writeFileSync(signalFilePath(slotNum), JSON.stringify(signal, null, 2) + "\n");
  console.error(`ludics: worker signal written for slot ${slotNum}: ${payload.status}`);
}

/** Read and output a local signal file (called remotely by controller via SSH). */
export function workerReadSignal(slotNum: number): string | null {
  const file = signalFilePath(slotNum);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8").trim();
}

/** Clear a signal file after it has been processed. */
export function workerClearSignal(slotNum: number): void {
  const file = signalFilePath(slotNum);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}

/**
 * Controller polls all remote slots for worker signals and reconciles.
 * Called from federationTick() on the controller machine.
 * Reads signal files locally from the state repo (committed by worker keepalive,
 * pulled by federationTick before this function is called).
 */
export function controllerPollWorkers(): void {
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const content = readFileSync(sFile, "utf-8");
  const blocks = parseSlotBlocks(content);

  for (const [slotNum, block] of blocks) {
    const machineName = getMachine(block).trim();
    if (!machineName || machineName === "null" || !isRemoteMachine(machineName)) continue;

    const currentTaskId = getTask(block).trim();
    if (!currentTaskId || currentTaskId === "null") continue;

    // Read signal locally (committed by worker keepalive, pulled by federationTick)
    const signalContent = workerReadSignal(slotNum);
    if (!signalContent) continue;

    let signal: WorkerSignal;
    try {
      signal = JSON.parse(signalContent) as WorkerSignal;
    } catch {
      console.error(`ludics: worker-signal: invalid JSON for slot ${slotNum}`);
      continue;
    }

    // Validate task ID matches current slot assignment
    if (signal.taskId !== currentTaskId) {
      console.error(`ludics: worker-signal: stale signal for ${signal.taskId} on slot ${slotNum} (current: ${currentTaskId}) — clearing`);
      workerClearSignal(slotNum);
      continue;
    }

    // Process the signal
    switch (signal.status) {
      case "done":
        console.error(`ludics: worker-signal: task ${signal.taskId} completed on ${machineName}`);
        slotClear(slotNum, "done");
        emitEvent({
          event_type: "worker_signal_done",
          source: "federation",
          scope: "slot",
          slot: slotNum,
          task: signal.taskId,
          machine: machineName,
          message: signal.message || "completed via worker signal",
        });
        break;

      case "error":
        console.error(`ludics: worker-signal: task ${signal.taskId} errored on ${machineName}: ${signal.message}`);
        emitEvent({
          event_type: "worker_signal_error",
          source: "federation",
          scope: "slot",
          slot: slotNum,
          task: signal.taskId,
          machine: machineName,
          message: signal.message,
        });
        break;

      default:
        // "progress" or other — log but don't act
        break;
    }

    // Clear the processed signal locally (committed by stateCheckpoint at end of federationTick)
    workerClearSignal(slotNum);
  }
}

/** CLI handler for `ludics worker-signal` subcommand. */
export async function runWorkerSignal(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "read": {
      const slotNum = parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(slotNum) || slotNum < 1) {
        throw new Error("usage: ludics worker-signal read <slot-number>");
      }
      const content = workerReadSignal(slotNum);
      if (content) {
        console.log(content);
      }
      break;
    }

    case "write": {
      const slotNum = parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(slotNum) || slotNum < 1) {
        throw new Error("usage: ludics worker-signal write <slot> --status <status> --task <taskId>");
      }
      let status = "";
      let taskId = "";
      let message = "";
      for (let i = 2; i < args.length; i++) {
        switch (args[i]) {
          case "--status": status = args[++i] ?? ""; break;
          case "--task": taskId = args[++i] ?? ""; break;
          case "--message": message = args[++i] ?? ""; break;
        }
      }
      if (!status || !taskId) {
        throw new Error("--status and --task are required");
      }
      workerReportStatus(slotNum, { taskId, status, message });
      break;
    }

    case "clear": {
      const slotNum = parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(slotNum) || slotNum < 1) {
        throw new Error("usage: ludics worker-signal clear <slot-number>");
      }
      workerClearSignal(slotNum);
      break;
    }

    default:
      throw new Error(`unknown worker-signal command: ${sub} (use: read, write, clear)`);
  }
}
