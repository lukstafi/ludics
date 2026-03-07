import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "path";
import { harnessDir as defaultHarnessDir } from "../config.ts";
import { T3CodeClient } from "./client.ts";
import type { T3CodeServerRecord, T3CodeSlotState, T3Snapshot } from "./types.ts";

export interface T3CodeServerStatus {
  running: boolean;
  record: T3CodeServerRecord | null;
  snapshot: T3Snapshot | null;
  reason?: string;
}

interface EnsureServerOptions {
  harnessDir?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3773;
const MAX_PORT_SCAN = 50;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

export interface T3CodeProcessInspection {
  pid: number;
  alive: boolean;
  commandLine: string | null;
  matchesRecord: boolean;
}

export function t3codeDir(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "t3code");
}

export function t3codeServerPath(harnessDir: string = defaultHarnessDir()): string {
  return join(t3codeDir(harnessDir), "server.json");
}

export function t3codeServerStateDir(harnessDir: string = defaultHarnessDir()): string {
  return join(t3codeDir(harnessDir), "state");
}

export function t3codeSlotPath(slot: number, harnessDir: string = defaultHarnessDir()): string {
  return join(t3codeDir(harnessDir), `slot-${slot}.json`);
}

export function readServerRecord(harnessDir: string = defaultHarnessDir()): T3CodeServerRecord | null {
  return readJsonFile<T3CodeServerRecord>(t3codeServerPath(harnessDir));
}

export function readSlotState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): T3CodeSlotState | null {
  return readJsonFile<T3CodeSlotState>(t3codeSlotPath(slot, harnessDir));
}

export function writeSlotState(
  state: T3CodeSlotState,
  harnessDir: string = defaultHarnessDir(),
): void {
  writeJsonFile(t3codeSlotPath(state.slot, harnessDir), state);
}

export function removeSlotState(slot: number, harnessDir: string = defaultHarnessDir()): void {
  const path = t3codeSlotPath(slot, harnessDir);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export async function serverStatus(
  options: EnsureServerOptions = {},
): Promise<T3CodeServerStatus> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  const record = readServerRecord(harnessDir);
  if (!record) {
    return { running: false, record: null, snapshot: null, reason: "not started" };
  }

  const inspection = inspectManagedServerProcess(record);
  if (!inspection.alive) {
    return { running: false, record, snapshot: null, reason: "pid not running" };
  }
  if (!inspection.matchesRecord) {
    return { running: false, record, snapshot: null, reason: "pid reused by another process" };
  }

  const client = new T3CodeClient({
    url: record.wsUrl,
    token: record.authToken,
    requestTimeoutMs: 2_000,
  });

  try {
    const snapshot = await client.getSnapshot();
    return { running: true, record, snapshot };
  } catch (error) {
    return {
      running: false,
      record,
      snapshot: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.close();
  }
}

export async function ensureServer(
  options: EnsureServerOptions = {},
): Promise<T3CodeServerRecord> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  mkdirSync(t3codeDir(harnessDir), { recursive: true });
  mkdirSync(t3codeServerStateDir(harnessDir), { recursive: true });

  const existing = await serverStatus({ harnessDir });
  if (existing.running && existing.record) return existing.record;

  if (existing.record && inspectManagedServerProcess(existing.record).matchesRecord) {
    await terminateProcess(existing.record.pid);
  }

  const port = await findAvailablePort(DEFAULT_PORT);
  const host = DEFAULT_HOST;
  const webUrl = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}`;
  const authToken = (process.env.LUDICS_T3CODE_AUTH_TOKEN ?? "").trim() || undefined;
  const command = buildLaunchCommand({
    port,
    stateDir: t3codeServerStateDir(harnessDir),
    authToken,
  });

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: process.env as Record<string, string>,
    });
  } catch (error) {
    throw new Error(
      `unable to start t3code server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof (proc as { unref?: () => void }).unref === "function") {
    (proc as { unref: () => void }).unref();
  }

  const record: T3CodeServerRecord = {
    pid: proc.pid,
    port,
    host,
    webUrl,
    wsUrl,
    authToken,
    stateDir: t3codeServerStateDir(harnessDir),
    startedAt: isoNow(),
    command,
  };

  await waitForReady(record, START_TIMEOUT_MS);
  writeJsonFile(t3codeServerPath(harnessDir), record);
  return record;
}

export async function stopServer(options: EnsureServerOptions = {}): Promise<boolean> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  const record = readServerRecord(harnessDir);
  if (!record) return false;

  const inspection = inspectManagedServerProcess(record);
  const stopped = inspection.matchesRecord
    ? await terminateProcess(record.pid)
    : false;
  const path = t3codeServerPath(harnessDir);
  if (existsSync(path)) unlinkSync(path);
  return stopped;
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

export function commandLineMatchesServerRecord(
  commandLine: string | null,
  record: T3CodeServerRecord,
): boolean {
  if (!commandLine) return false;
  if (!commandLine.includes(record.stateDir)) return false;
  return commandLine.startsWith("t3 ")
    || commandLine.includes("/t3 ")
    || commandLine.startsWith("npx ")
    || commandLine.includes(" npx ")
    || commandLine.includes(" src/index.ts")
    || commandLine.includes(" dist/index.mjs");
}

export function inspectManagedServerProcess(record: T3CodeServerRecord): T3CodeProcessInspection {
  const alive = processAlive(record.pid);
  const commandLine = alive ? processCommandLine(record.pid) : null;
  return {
    pid: record.pid,
    alive,
    commandLine,
    matchesRecord: alive && commandLineMatchesServerRecord(commandLine, record),
  };
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!processAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(100);
  }

  if (processAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
  }

  return !processAlive(pid);
}

async function waitForReady(record: T3CodeServerRecord, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown startup failure";

  while (Date.now() < deadline) {
    if (!processAlive(record.pid)) {
      throw new Error("t3code process exited during startup");
    }

    const client = new T3CodeClient({
      url: record.wsUrl,
      token: record.authToken,
      requestTimeoutMs: 1_000,
    });

    try {
      await client.getSnapshot();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(200);
    } finally {
      client.close();
    }
  }

  throw new Error(`t3code server did not become ready: ${lastError}`);
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + MAX_PORT_SCAN; port++) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`no free port found in range ${start}-${start + MAX_PORT_SCAN - 1}`);
}

async function portAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, DEFAULT_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

function buildLaunchCommand(input: {
  port: number;
  stateDir: string;
  authToken?: string;
}): string[] {
  const preferred = (process.env.LUDICS_T3CODE_BIN ?? "").trim();
  const repoOverride = (process.env.LUDICS_T3CODE_REPO ?? "").trim();
  const homeRepo = join(process.env.HOME ?? "~", "t3code");
  const sourceRepo = resolve(repoOverride || homeRepo);
  const sourceServerDir = join(sourceRepo, "apps", "server");
  const command = preferred
    ? [preferred]
    : Bun.which("t3")
      ? ["t3"]
      : existsSync(join(sourceServerDir, "src", "index.ts"))
        ? ["bun", "--cwd", sourceServerDir, "src/index.ts"]
        : Bun.which("npx")
          ? ["npx", "-y", "t3"]
          : null;

  if (!command) {
    throw new Error(
      "t3code launcher not found; install `t3`, keep the source repo at ~/t3code, or set LUDICS_T3CODE_BIN/LUDICS_T3CODE_REPO",
    );
  }

  const args = [
    ...command,
    "--mode",
    "desktop",
    "--port",
    String(input.port),
    "--state-dir",
    input.stateDir,
    "--no-browser",
  ];
  if (input.authToken) {
    args.push("--auth-token", input.authToken);
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
