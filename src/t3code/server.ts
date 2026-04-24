import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { createServer } from "node:net";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";
import { setsidWrap } from "../orchestration/util.ts";
import { readJsonFile, writeJsonFile } from "../json.ts";

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
import { safeSyncOutput } from "../spawn.ts";

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
/** How long after startedAt we consider a server "too young to kill". */
const STARTUP_GRACE_MS = 15_000;
/** How long to wait for another process holding the lock to finish starting. */
const LOCK_WAIT_MS = 20_000;

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

// ---------------------------------------------------------------------------
// File-based lock to prevent concurrent ensureServer() callers from racing.
// ---------------------------------------------------------------------------

function lockPath(harnessDir: string): string {
  return join(t3codeDir(harnessDir), "server.lock");
}

interface LockContent {
  pid: number;
  acquiredAt: string;
}

function tryAcquireLock(harnessDir: string): boolean {
  const lp = lockPath(harnessDir);
  const content: LockContent = { pid: process.pid, acquiredAt: isoNow() };
  try {
    // wx = exclusive create — fails if file already exists
    writeFileSync(lp, JSON.stringify(content) + "\n", { flag: "wx" });
    return true;
  } catch {
    // Lock file exists — check if holder is still alive
    try {
      const existing = JSON.parse(readFileSync(lp, "utf-8")) as LockContent;
      if (existing.pid !== process.pid && processAlive(existing.pid)) {
        return false; // held by a live process
      }
      // Holder is dead — steal the lock
      writeFileSync(lp, JSON.stringify(content) + "\n");
      return true;
    } catch {
      // Corrupt lock file — steal it
      writeFileSync(lp, JSON.stringify(content) + "\n");
      return true;
    }
  }
}

function releaseLock(harnessDir: string): void {
  try { unlinkSync(lockPath(harnessDir)); } catch { /* ignore */ }
}

/**
 * Check whether the recorded server was started recently enough that we should
 * not kill it — it may still be initialising.
 */
function withinStartupGrace(record: T3CodeServerRecord): boolean {
  if (!record.startedAt) return false;
  const started = new Date(record.startedAt).getTime();
  return Date.now() - started < STARTUP_GRACE_MS;
}

export async function ensureServer(
  options: EnsureServerOptions = {},
): Promise<T3CodeServerRecord> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  mkdirSync(t3codeDir(harnessDir), { recursive: true });

  // Fast path: server already running — no lock needed.
  const existing = await serverStatus({ harnessDir });
  if (existing.running && existing.record) return existing.record;

  // ---- Acquire lock ----
  const lockDeadline = Date.now() + LOCK_WAIT_MS;
  while (!tryAcquireLock(harnessDir)) {
    // Another process is starting the server — wait for it.
    if (Date.now() >= lockDeadline) {
      // Timed out waiting; steal the lock so we don't deadlock.
      releaseLock(harnessDir);
      if (!tryAcquireLock(harnessDir)) {
        throw new Error("unable to acquire t3code server lock after timeout");
      }
      break;
    }
    await sleep(1_000);
    // Re-check: the other process may have finished starting.
    const recheck = await serverStatus({ harnessDir });
    if (recheck.running && recheck.record) {
      return recheck.record;
    }
  }

  try {
    // Re-check status after acquiring lock — the previous holder may have
    // successfully started the server.
    const afterLock = await serverStatus({ harnessDir });
    if (afterLock.running && afterLock.record) return afterLock.record;

    // Only kill the old process if it is NOT within the startup grace period.
    if (afterLock.record) {
      if (withinStartupGrace(afterLock.record)) {
        // Server was started very recently — give it more time instead of
        // killing it.  Wait up to the remaining grace period.
        const started = new Date(afterLock.record.startedAt!).getTime();
        const remainingGrace = STARTUP_GRACE_MS - (Date.now() - started);
        if (remainingGrace > 0) {
          const graceDeadline = Date.now() + remainingGrace;
          while (Date.now() < graceDeadline) {
            await sleep(1_000);
            const graceCheck = await serverStatus({ harnessDir });
            if (graceCheck.running && graceCheck.record) return graceCheck.record;
          }
        }
        // If still not running after grace, fall through and restart.
      }
      if (inspectManagedServerProcess(afterLock.record).matchesRecord) {
        await terminateProcess(afterLock.record.pid);
      }
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

    // DB resilience before each server start.
    // Order matters: integrity-check (and auto-recover) FIRST, then backup.
    // This ensures .bak is always a copy of a known-good (or just-recovered)
    // database — not a copy of a corrupt one.
    const dbPath = join(t3Home, "userdata", "state.sqlite");
    const dbHealthy = checkAndRecoverDb(dbPath);
    if (dbHealthy) {
      backupDb(dbPath);
    }

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
    // Preserve previous crash log for upstream reporting
    if (existsSync(stderrPath)) {
      const crashLog = join(t3codeDir(harnessDir), "server-crashes.log");
      try {
        const prev = readFileSync(stderrPath, "utf-8").trim();
        if (prev) {
          appendFileSync(crashLog, `\n--- crash at ${isoNow()} ---\n${prev}\n`);
        }
      } catch { /* ignore */ }
    }
    try {
      // Wrap in setsid to isolate the server in its own session/process group.
      proc = Bun.spawn(setsidWrap(command), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: Bun.file(stderrPath),
        env: process.env as Record<string, string>,
      });
    } catch (error) {
      // Remove marker so the dashboard doesn't show "starting…" indefinitely
      try { unlinkSync(t3codeStartingPath(harnessDir)); } catch { /* ignore */ }
      throw new Error(
        `unable to start t3code server: ${error instanceof Error ? error.message : String(error)}\n  hint: run \`ludics t3code doctor\` for diagnostics`,
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

    // Write the record immediately so concurrent callers can see
    // startedAt and respect the grace period.
    writeJsonFile(t3codeServerPath(harnessDir), record);

    try {
      await waitForReady(record, START_TIMEOUT_MS);
    } finally {
      // Always clear the starting marker once we know the outcome
      try { unlinkSync(t3codeStartingPath(harnessDir)); } catch { /* ignore */ }
    }
    // Re-write with confirmed-good record (same content, but ensures
    // atomic write after successful startup).
    writeJsonFile(t3codeServerPath(harnessDir), record);
    return record;
  } finally {
    releaseLock(harnessDir);
  }
}

export async function stopServer(options: EnsureServerOptions = {}): Promise<boolean> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  const record = readServerRecord(harnessDir);
  if (!record) return false;

  // Checkpoint the WAL before killing the process — this is the single most
  // impactful change for preventing corruption on unclean shutdown.  The
  // checkpoint runs while the t3code process is still alive (holding its own
  // connection); SQLite supports multiple concurrent readers so opening a
  // second connection here is safe.  Errors are non-fatal.
  const dbPath = join(record.stateDir, "userdata", "state.sqlite");
  checkpointWal(dbPath);

  const inspection = inspectManagedServerProcess(record);
  const stopped = inspection.matchesRecord
    ? await terminateProcess(record.pid)
    : false;
  const path = t3codeServerPath(harnessDir);
  if (existsSync(path)) unlinkSync(path);
  return stopped;
}


export function processAlive(pid: number): boolean {
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
  const r = safeSyncOutput(["ps", "-p", String(pid), "-o", "command="]);
  return r.ok && r.stdout ? r.stdout : null;
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

  throw new Error(`t3code server did not become ready: ${lastError}\n  hint: run \`ludics t3code doctor\` for diagnostics`);
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
    // Accept absolute paths (existsSync) OR bare command names resolvable via PATH (Bun.which).
    // This handles e.g. LUDICS_T3CODE_BIN=t3 where `t3` is on PATH but not a filesystem path.
    const foundOnDisk = existsSync(preferred);
    const foundInPath = !foundOnDisk ? Bun.which(preferred) : null;
    const found = foundOnDisk || foundInPath !== null;
    const resolvedPath = foundOnDisk ? preferred : (foundInPath ?? preferred);
    return {
      command: found ? [preferred] : null,
      detail: found
        ? `LUDICS_T3CODE_BIN=${preferred} (resolved: ${resolvedPath})`
        : `LUDICS_T3CODE_BIN=${preferred} (not found on disk or in PATH)`,
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

    // 7. SDK version freshness (installed vs resolved by bun)
    {
      const launcher = resolveLauncherCandidate();
      const repoDir = launcher.detail.match(/source repo at (.+)/)?.[1];
      if (repoDir) {
        const bunCacheDir = join(repoDir, "node_modules", ".bun");
        let installedVersion: string | null = null;
        let latestCached: string | null = null;
        // Find all cached SDK versions and pick the highest
        if (existsSync(bunCacheDir)) {
          try {
            const entries = readdirSync(bunCacheDir);
            const sdkVersions = entries
              .map((e) => e.match(/^@anthropic-ai\+claude-agent-sdk@([0-9.]+)/)?.[1])
              .filter((v): v is string => v != null)
              .sort();
            if (sdkVersions.length > 0) latestCached = sdkVersions[sdkVersions.length - 1];
          } catch { /* ignore */ }
        }
        // Check the canonical node_modules path
        const installedPkgPath = join(repoDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
        try {
          const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as { version?: string };
          installedVersion = pkg.version ?? null;
        } catch { /* may be hoisted into .bun only */ }
        const effectiveVersion = installedVersion ?? latestCached;
        // Compare against npm registry latest
        const npmLatest = (() => {
          const r = safeSyncOutput(["npm", "view", "@anthropic-ai/claude-agent-sdk", "version"]);
          return r.ok && r.stdout ? r.stdout : null;
        })();
        if (effectiveVersion && npmLatest && effectiveVersion !== npmLatest) {
          checks.push({
            name: "SDK version freshness",
            passed: true, // warning, not failure — may be intentional
            detail: `claude-agent-sdk@${effectiveVersion} (latest: ${npmLatest}) — run \`bun update @anthropic-ai/claude-agent-sdk\` to update`,
          });
        } else if (effectiveVersion) {
          checks.push({
            name: "SDK version freshness",
            passed: true,
            detail: `claude-agent-sdk@${effectiveVersion}${npmLatest ? " (latest)" : ""}`,
          });
        }
      }
    }

    // 8. stderr log hints (last few lines if file exists)
    const stderrPath = join(t3codeDir(harnessDir), "server-stderr.log");
    if (existsSync(stderrPath)) {
      {
        const r = safeSyncOutput(["tail", "-n", "5", stderrPath]);
        if (r.ok && r.stdout) {
          checks.push({
            name: "server-stderr.log (last 5 lines)",
            passed: true,
            detail: r.stdout,
          });
        }
      }
    }
  }

  const ok = checks.filter((c) => c.name !== "server-stderr.log (last 5 lines)").every((c) => c.passed);
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// SQLite crash-resilience helpers
// ---------------------------------------------------------------------------

/**
 * Checkpoint the WAL file before a clean stop.
 * Uses TRUNCATE mode to flush all WAL frames to the main DB file and reset the
 * WAL to zero length.  Falls back to PASSIVE (which doesn't need an exclusive
 * lock) when the t3code process still holds a write lock.  Errors are non-fatal
 * — the stop must always proceed regardless.
 */
function checkpointWal(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  try {
    const db = new Database(dbPath, { readwrite: true });
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // TRUNCATE needs exclusive lock; fall back to passive
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch { /* ignore */ }
    }
    db.close();
  } catch (err) {
    console.error(`t3code: WAL checkpoint failed: ${err}`);
  }
}

/**
 * Copy state.sqlite (+ WAL/SHM side-files if present) to .bak before each
 * server start, rotating the previous .bak to .bak.1 (keeping last 2 copies).
 *
 * Only called when the DB has already been verified as healthy, so .bak is
 * always a copy of a known-good database.
 */
function backupDb(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const bak = dbPath + ".bak";
  const bak1 = dbPath + ".bak.1";
  // Rotate: drop old .bak.1 (and its side-files), then move .bak → .bak.1.
  // Side-files must be rotated alongside their main DB file so that .bak.1
  // remains self-consistent if it is ever used for a restore.
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(bak1 + suffix)) {
      try { unlinkSync(bak1 + suffix); } catch { /* ignore */ }
    }
  }
  if (existsSync(bak)) {
    try { renameSync(bak, bak1); } catch { /* ignore */ }
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(bak + suffix)) {
      try { renameSync(bak + suffix, bak1 + suffix); } catch { /* ignore */ }
    }
  }
  // Copy current DB and any WAL/SHM side-files to .bak
  try {
    copyFileSync(dbPath, bak);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(dbPath + ext)) {
        try { copyFileSync(dbPath + ext, bak + ext); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error(`t3code: DB backup failed: ${err}`);
  }
}

/**
 * Run `PRAGMA integrity_check` on state.sqlite.  If it fails, attempt
 * automatic recovery via `sqlite3 .recover` (pipe into a fresh DB), verify the
 * result, then swap it in.  If `.recover` also fails, fall back to the most
 * recent `.bak` file.  Returns true if the DB is (or was recovered to) a usable
 * state; false if nothing worked (caller proceeds at its own risk).
 */
function checkAndRecoverDb(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true; // fresh start — nothing to check

  // ---- Integrity check (with retry for transient file lock issues after server stop) ----
  let integrityOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const result = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
        integrityOk = result?.integrity_check === "ok";
        if (!integrityOk) {
          console.error(
            `t3code: integrity check failed: ${result?.integrity_check ?? "(no result)"}`,
          );
        }
      } finally {
        db.close();
      }
      break; // success — no retry needed
    } catch (err) {
      if (attempt < 2) {
        // Transient file lock — wait and retry
        Bun.sleepSync(500);
        continue;
      }
      console.error(`t3code: integrity check error: ${err}`);
      integrityOk = false;
    }
  }

  if (integrityOk) return true;

  // ---- Attempt recovery via sqlite3 .recover ----
  console.error("t3code: attempting automatic recovery...");
  const recoveredPath = dbPath + ".recovered";
  if (existsSync(recoveredPath)) {
    try { unlinkSync(recoveredPath); } catch { /* ignore */ }
  }

  const recoverResult = safeSyncOutput([
    "bash",
    "-c",
    `sqlite3 ${JSON.stringify(dbPath)} ".recover" | sqlite3 ${JSON.stringify(recoveredPath)}`,
  ]);

  if (recoverResult.ok && existsSync(recoveredPath)) {
    // Verify the recovered DB before committing to it
    let recoveredOk = false;
    try {
      const db2 = new Database(recoveredPath, { readonly: true });
      try {
        const r = db2.query("PRAGMA integrity_check").get() as {
          integrity_check: string;
        } | null;
        recoveredOk = r?.integrity_check === "ok";
      } finally {
        db2.close();
      }
    } catch { /* fall through to backup restore */ }

    if (recoveredOk) {
      // Swap: rename corrupt DB aside, place recovered DB at canonical path
      renameSync(dbPath, dbPath + ".corrupt");
      renameSync(recoveredPath, dbPath);
      // Remove orphaned WAL/SHM files left over from the old (now corrupt) DB
      for (const ext of ["-wal", "-shm"]) {
        if (existsSync(dbPath + ext)) {
          try { unlinkSync(dbPath + ext); } catch { /* ignore */ }
        }
      }
      console.error("t3code: recovery succeeded — swapped to recovered DB");
      return true;
    }
  }

  // ---- .recover failed — try restoring from backup ----
  // Try .bak first, then .bak.1. Verify each backup's integrity before
  // committing to it — either could be corrupt if a previous start failed.
  console.error("t3code: .recover failed, trying backup restore...");
  for (const bakPath of [dbPath + ".bak", dbPath + ".bak.1"]) {
    if (!existsSync(bakPath)) continue;
    let bakOk = false;
    try {
      const dbBak = new Database(bakPath, { readonly: true });
      try {
        const r = dbBak.query("PRAGMA integrity_check").get() as {
          integrity_check: string;
        } | null;
        bakOk = r?.integrity_check === "ok";
      } finally {
        dbBak.close();
      }
    } catch { /* try next candidate */ }

    if (!bakOk) {
      console.error(`t3code: backup ${bakPath} failed integrity check, skipping...`);
      continue;
    }

    try {
      renameSync(dbPath, dbPath + ".corrupt");
      copyFileSync(bakPath, dbPath);
      // Restore WAL/SHM from backup if present; otherwise remove stale ones
      for (const ext of ["-wal", "-shm"]) {
        if (existsSync(bakPath + ext)) {
          try { copyFileSync(bakPath + ext, dbPath + ext); } catch { /* ignore */ }
        } else if (existsSync(dbPath + ext)) {
          try { unlinkSync(dbPath + ext); } catch { /* ignore */ }
        }
      }
      console.error(`t3code: restored from ${bakPath}`);
      return true;
    } catch (err) {
      console.error(`t3code: restore from ${bakPath} failed: ${err}`);
    }
  }

  console.error("t3code: no usable backup — starting with corrupt DB (may fail)");
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
