import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "path";

/**
 * Migrate legacy `<t3codeDir>/state/` → `<t3codeDir>/userdata/`.
 *
 * t3code upstream renamed `--state-dir` to `--home-dir` and now appends
 * `/userdata/` internally.  Our old layout put the SQLite DB directly
 * under `state/`; the new layout expects it under `userdata/`.
 */
function migrateStateDirIfNeeded(t3Dir: string): void {
  const oldDir = join(t3Dir, "state");
  const newDir = join(t3Dir, "userdata");
  if (existsSync(join(oldDir, "state.sqlite")) && !existsSync(newDir)) {
    renameSync(oldDir, newDir);
  }
}
import { harnessDir as defaultHarnessDir } from "../config.ts";
import { networkHostname } from "../network.ts";
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

const DEFAULT_PORT = 3773;
const MAX_PORT_SCAN = 50;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

/**
 * Resolve the host to bind / advertise.
 * In tailscale mode this returns the Tailnet hostname; otherwise "127.0.0.1".
 */
export function resolveHost(): string {
  const nh = networkHostname();
  // networkHostname() returns "localhost" when mode is localhost — map to IPv4 literal
  return nh === "localhost" ? "127.0.0.1" : nh;
}

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

/**
 * Path to the "server is starting" marker file.
 * Written just before Bun.spawn() and cleared on successful startup.
 * Used by the dashboard to show "starting…" while keepalive is reviving the server.
 */
export function t3codeStartingPath(harnessDir: string = defaultHarnessDir()): string {
  return join(t3codeDir(harnessDir), "starting.json");
}

/** How long (ms) a starting.json marker is considered fresh. */
const STARTING_MARKER_TTL_MS = 120_000;

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
    // HTTP fallback: the PID may be a wrapper process whose command line
    // doesn't match our patterns, but the server is actually running.
    const httpAlive = await httpHealthCheck(record);
    if (!httpAlive) {
      return { running: false, record, snapshot: null, reason: "pid reused by another process" };
    }
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

  const existing = await serverStatus({ harnessDir });
  if (existing.running && existing.record) return existing.record;

  if (existing.record && inspectManagedServerProcess(existing.record).matchesRecord) {
    await terminateProcess(existing.record.pid);
  }

  const host = resolveHost();
  const port = await findAvailablePort(DEFAULT_PORT, host);
  const webUrl = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}`;
  // Auth token: only use when explicitly provided via env var.
  // Tailnet-only setups don't need auth; auth doesn't work upstream.
  const authToken = (process.env.LUDICS_T3CODE_AUTH_TOKEN ?? "").trim() || undefined;
  const t3Home = t3codeDir(harnessDir);
  migrateStateDirIfNeeded(t3Home);
  const command = buildLaunchCommand({
    port,
    host,
    homeDir: t3Home,
    authToken,
  });

  // Write a "starting" marker before spawning so the dashboard can show
  // "starting…" while the server is coming up.  Cleared on successful start.
  writeJsonFile(t3codeStartingPath(harnessDir), { since: isoNow() });

  let proc: Bun.Subprocess;
  const stderrPath = join(t3codeDir(harnessDir), "server-stderr.log");
  try {
    proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(stderrPath),
      env: process.env as Record<string, string>,
    });
  } catch (error) {
    // Remove marker so the dashboard doesn't show "starting…" indefinitely
    try { unlinkSync(t3codeStartingPath(harnessDir)); } catch { /* ignore */ }
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
    stateDir: t3Home,
    startedAt: isoNow(),
    command,
  };

  try {
    await waitForReady(record, START_TIMEOUT_MS);
  } finally {
    // Always clear the starting marker once we know the outcome
    try { unlinkSync(t3codeStartingPath(harnessDir)); } catch { /* ignore */ }
  }
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
    || commandLine.startsWith("npm ")
    || commandLine.includes(" npm ")
    || commandLine.includes("/npm ")
    || commandLine.includes(" src/index.ts")
    || commandLine.includes(" dist/index.mjs")
    || commandLine.includes("bun run ")
    || commandLine.includes("bun --cwd ");
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

async function httpHealthCheck(record: T3CodeServerRecord): Promise<boolean> {
  try {
    const response = await fetch(record.webUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
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

async function findAvailablePort(start: number, host: string = "127.0.0.1"): Promise<number> {
  for (let port = start; port < start + MAX_PORT_SCAN; port++) {
    if (await portAvailable(port, host)) return port;
  }
  throw new Error(`no free port found in range ${start}-${start + MAX_PORT_SCAN - 1}`);
}

async function portAvailable(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

interface LauncherCandidate {
  /** The base command tokens (e.g. ["bun","run","--cwd",…] or ["t3"]). Null when none found. */
  command: string[] | null;
  /** Human-readable description for diagnostics. */
  detail: string;
}

/**
 * Resolve the best available t3code launcher.
 * Single source of truth used by both buildLaunchCommand() and doctorServer().
 */
function resolveLauncherCandidate(): LauncherCandidate {
  const preferred = (process.env.LUDICS_T3CODE_BIN ?? "").trim();
  const repoOverride = (process.env.LUDICS_T3CODE_REPO ?? "").trim();
  const home = process.env.HOME ?? "~";
  // Prefer t3code-ludics (the local fork with ludics integrations)
  const ludicsRepo = join(home, "t3code-ludics");
  const plainRepo = join(home, "t3code");
  const sourceRepo = resolve(repoOverride || (existsSync(ludicsRepo) ? ludicsRepo : plainRepo));
  const sourceServerDir = join(sourceRepo, "apps", "server");

  if (preferred) {
    const found = existsSync(preferred);
    return {
      command: found ? [preferred] : null,
      detail: found ? `LUDICS_T3CODE_BIN=${preferred}` : `LUDICS_T3CODE_BIN=${preferred} (file not found)`,
    };
  }
  if (existsSync(join(sourceServerDir, "src", "index.ts"))) {
    return {
      command: ["bun", "run", "--cwd", sourceServerDir, "start"],
      detail: `source repo at ${sourceRepo}`,
    };
  }
  const t3bin = Bun.which("t3");
  if (t3bin) {
    return { command: ["t3"], detail: `t3 binary at ${t3bin}` };
  }
  if (Bun.which("npx")) {
    return { command: ["npx", "-y", "t3"], detail: "will use npx -y t3 (slow first run)" };
  }
  return {
    command: null,
    detail: "no launcher found; install t3 or keep source at ~/t3code-ludics",
  };
}

function buildLaunchCommand(input: {
  port: number;
  host?: string;
  homeDir: string;
  authToken?: string;
}): string[] {
  const { command } = resolveLauncherCandidate();

  if (!command) {
    throw new Error(
      "t3code launcher not found; keep the source repo at ~/t3code-ludics (or ~/t3code), install `t3`, or set LUDICS_T3CODE_BIN/LUDICS_T3CODE_REPO",
    );
  }

  const args = [
    ...command,
    "--mode",
    "desktop",
    "--port",
    String(input.port),
    "--home-dir",
    input.homeDir,
    "--no-browser",
  ];
  if (input.host) {
    args.push("--host", input.host);
  }
  if (input.authToken) {
    args.push("--auth-token", input.authToken);
  }
  return args;
}

export interface T3CodeDoctorResult {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/**
 * Health check for the t3code server setup.
 * Verifies binary availability, server record, process state, and HTTP reachability.
 * Returns a structured result suitable for CLI output.
 */
export async function doctorServer(
  options: EnsureServerOptions = {},
): Promise<T3CodeDoctorResult> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // 1. Binary / launcher availability
  {
    const launcher = resolveLauncherCandidate();
    checks.push({ name: "launcher", passed: launcher.command !== null, detail: launcher.detail });
  }

  // 2. server.json record exists
  const record = readServerRecord(harnessDir);
  {
    const passed = record !== null;
    checks.push({
      name: "server.json",
      passed,
      detail: passed ? t3codeServerPath(harnessDir) : "no record — server has never been started",
    });
  }

  if (record) {
    // 3. Process alive
    const inspection = inspectManagedServerProcess(record);
    checks.push({
      name: "process alive",
      passed: inspection.alive,
      detail: inspection.alive
        ? `pid ${record.pid} is running`
        : `pid ${record.pid} is dead (stale record)`,
    });

    // 4. Command line matches record (detects PID reuse)
    if (inspection.alive) {
      checks.push({
        name: "process identity",
        passed: inspection.matchesRecord,
        detail: inspection.matchesRecord
          ? `command line matches t3code record`
          : `command line mismatch — pid may be reused: ${inspection.commandLine ?? "(unreadable)"}`,
      });
    }

    // 5. HTTP health check
    const httpOk = await httpHealthCheck(record);
    checks.push({
      name: "HTTP reachable",
      passed: httpOk,
      detail: httpOk ? record.webUrl : `${record.webUrl} did not respond (server down or starting)`,
    });

    // 6. WebSocket / snapshot
    if (httpOk) {
      const client = new T3CodeClient({
        url: record.wsUrl,
        token: record.authToken,
        requestTimeoutMs: 3_000,
      });
      try {
        const snapshot = await client.getSnapshot();
        checks.push({
          name: "WebSocket snapshot",
          passed: true,
          detail: `${snapshot.projects.length} project(s), ${snapshot.threads.length} thread(s)`,
        });
      } catch (err) {
        checks.push({
          name: "WebSocket snapshot",
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        client.close();
      }
    }

    // 7. stderr log hints (last few lines if file exists)
    const stderrPath = join(t3codeDir(harnessDir), "server-stderr.log");
    if (existsSync(stderrPath)) {
      try {
        const content = Bun.spawnSync(["tail", "-n", "5", stderrPath], {
          stdout: "pipe",
          stderr: "pipe",
          env: process.env as Record<string, string>,
        }).stdout.toString().trim();
        if (content) {
          checks.push({
            name: "server-stderr.log (last 5 lines)",
            passed: true,
            detail: content,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  const ok = checks.filter((c) => c.name !== "server-stderr.log (last 5 lines)").every((c) => c.passed);
  return { ok, checks };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
