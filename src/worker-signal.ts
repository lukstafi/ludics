// Worker-to-controller signaling — workers report task status, controller polls and reconciles

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { harnessDir, slotsFilePath } from "./config.ts";
import { parseSlotBlocks, getTask, getMachine } from "./slots/markdown.ts";
import { isRemoteMachine } from "./remote.ts";
import { slotClear } from "./slots/index.ts";
import { emitEvent } from "./events.ts";
import { federationCurrentMachineName, resolveControllerCandidates } from "./federation.ts";
import { federationHttpPost } from "./federation-http.ts";

interface WorkerSignal {
  taskId: string;
  status: string;   // "done" | "error" | "progress"
  message: string;
  epoch: number;
  machine: string;
}

function signalsDir(): string {
  return join(harnessDir(), "worker-signals");
}

function signalFilePath(slotNum: number): string {
  return join(signalsDir(), `slot-${slotNum}.json`);
}

/** Write a status signal on the worker machine and POST to controller via HTTP. */
export async function workerReportStatus(
  slotNum: number,
  payload: { taskId: string; status: string; message: string; machine?: string },
): Promise<void> {
  const dir = signalsDir();
  mkdirSync(dir, { recursive: true });

  const signal: WorkerSignal = {
    ...payload,
    epoch: Math.floor(Date.now() / 1000),
    machine: payload.machine ?? federationCurrentMachineName() ?? "",
  };

  // Write local signal file (observability + retry source)
  writeFileSync(signalFilePath(slotNum), JSON.stringify(signal, null, 2) + "\n");
  console.error(`ludics: worker signal written for slot ${slotNum}: ${payload.status}`);

  // POST to controller via HTTP — try candidates in priority order (leader > console).
  // Uses resolveControllerCandidates() instead of currentLeader() to avoid stale leader.json.
  const candidates = resolveControllerCandidates();
  for (const candidate of candidates) {
    const result = await federationHttpPost(candidate, "/federation/signal", {
      ...signal, slot: slotNum,
    });
    if (result.ok) {
      // Controller processed — clear local file
      workerClearSignal(slotNum);
      console.error(`ludics: worker signal for slot ${slotNum} delivered via HTTP to ${candidate.name}`);
      break;
    }
    console.error(`ludics: worker signal HTTP delivery to ${candidate.name} failed (status=${result.status})`);
  }
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

const SIGNAL_MAX_AGE_SECONDS = 1800; // 30 minutes

/**
 * Worker-side retry for undelivered signals. Called from workerKeepalive().
 * Checks for local signal files and retries HTTP POST to controller.
 * Clears expired signals (>30 min). Local files are NOT delivered via git.
 */
export async function retryUndeliveredSignals(): Promise<void> {
  const dir = signalsDir();
  if (!existsSync(dir)) return;

  // Use resolveControllerCandidates() instead of currentLeader() to avoid stale leader.json
  const candidates = resolveControllerCandidates();
  if (candidates.length === 0) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("slot-") && f.endsWith(".json"));
  } catch { return; }

  const now = Math.floor(Date.now() / 1000);

  for (const file of files) {
    const filePath = join(dir, file);
    let signal: WorkerSignal;
    try {
      signal = JSON.parse(readFileSync(filePath, "utf-8")) as WorkerSignal;
    } catch { continue; }

    // Expire old signals
    if (signal.epoch > 0 && (now - signal.epoch) > SIGNAL_MAX_AGE_SECONDS) {
      console.error(`ludics: worker-signal: expired signal for ${file} (age: ${now - signal.epoch}s) — clearing`);
      try { unlinkSync(filePath); } catch { /* ignore */ }
      continue;
    }

    // Extract slot number from filename
    const slotMatch = file.match(/^slot-(\d+)\.json$/);
    if (!slotMatch) continue;
    const slotNum = parseInt(slotMatch[1]!, 10);

    // Try candidates in priority order until one accepts
    let delivered = false;
    for (const candidate of candidates) {
      const result = await federationHttpPost(candidate, "/federation/signal", {
        ...signal, slot: slotNum,
      });
      if (result.ok) {
        delivered = true;
        try { unlinkSync(filePath); } catch { /* ignore */ }
        console.error(`ludics: worker-signal: retried signal for slot ${slotNum} delivered via HTTP to ${candidate.name}`);
        break;
      }
    }

    if (delivered) break; // rate-limit: one successful retry per keepalive
  }
}

/**
 * Controller polls all remote slots for worker signals and reconciles.
 * Called from federationTick() on the controller machine.
 * Legacy path for signals that arrived via git before HTTP was enabled;
 * HTTP signals are processed inline in the /federation/signal handler.
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

    // Validate machine matches current slot assignment
    if (!signal.machine) {
      console.error(`ludics: worker-signal: missing machine field for slot ${slotNum} — clearing`);
      workerClearSignal(slotNum);
      continue;
    }
    if (signal.machine !== machineName) {
      console.error(`ludics: worker-signal: machine mismatch for slot ${slotNum} (signal: ${signal.machine}, slot: ${machineName}) — clearing`);
      workerClearSignal(slotNum);
      continue;
    }

    // Defense-in-depth: discard signals older than 30 minutes to guard against
    // stale signal replay when the same task is reassigned to the same machine.
    const signalAge = Math.floor(Date.now() / 1000) - signal.epoch;
    if (signalAge > 1800) {
      console.error(`ludics: worker-signal: expired signal for slot ${slotNum} (age: ${signalAge}s) — clearing`);
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
      let machine: string | undefined;
      for (let i = 2; i < args.length; i++) {
        switch (args[i]) {
          case "--status": status = args[++i] ?? ""; break;
          case "--task": taskId = args[++i] ?? ""; break;
          case "--message": message = args[++i] ?? ""; break;
          case "--machine": machine = args[++i] ?? ""; break;
        }
      }
      if (!status || !taskId) {
        throw new Error("--status and --task are required");
      }
      await workerReportStatus(slotNum, { taskId, status, message, machine });
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
