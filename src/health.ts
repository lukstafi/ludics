import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { type ProjectConfig, loadConfigSync, harnessDir, resolveProjectPath } from "./config.ts";
import { tasksCreate } from "./tasks/index.ts";
import { safeSyncOutput } from "./spawn.ts";

// --- Types ---

interface TestHealthEntry {
  lastRun: string;
  passed: boolean;
  failures?: string;
}

type TestHealthState = Record<string, TestHealthEntry>;

interface TestHealthResult {
  skipped: boolean;
  reason?: string;
  passed?: boolean;
  duration?: number;
  failures?: string;
}

// --- Detection ---

export function detectTestCommand(projectPath: string): string | null {
  if (existsSync(join(projectPath, "dune-project"))) return "dune runtest";
  if (existsSync(join(projectPath, "bun.lockb")) || existsSync(join(projectPath, "bun.lock"))) return "bun test";
  try {
    const pkgPath = join(projectPath, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.scripts?.test) return "npm test";
    }
  } catch { /* malformed package.json — skip */ }
  try {
    const makePath = join(projectPath, "Makefile");
    if (existsSync(makePath)) {
      const content = readFileSync(makePath, "utf8").slice(0, 65536);
      if (/^test:/m.test(content)) return "make test";
    }
  } catch { /* unreadable Makefile — skip */ }
  return null;
}

// --- Scheduling ---

export function shouldRunTestHealth(
  projectName: string,
  state: TestHealthState,
  config: { mag?: Record<string, unknown> },
  now: Date = new Date(),
): boolean {
  const nightHours = (config.mag?.test_health_night_hours as [number, number] | undefined) ?? [0, 6];
  const [start, end] = nightHours;
  const hour = now.getHours(); // local time — matches launchd semantics
  const inNightWindow = start <= end
    ? (hour >= start && hour < end)
    : (hour >= start || hour < end);
  const entry = state[projectName];
  const lastRun = entry?.lastRun ? new Date(entry.lastRun).getTime() : 0;
  const stale = now.getTime() - lastRun >= 24 * 3600 * 1000;
  return inNightWindow || stale;
}

// --- State persistence ---

function testHealthStatePath(): string {
  return join(harnessDir(), "mag", "test-health.json");
}

function loadTestHealthState(): TestHealthState {
  try {
    const parsed = JSON.parse(readFileSync(testHealthStatePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as TestHealthState;
  } catch {
    return {};
  }
}

function saveTestHealthState(state: TestHealthState): void {
  const dir = join(harnessDir(), "mag");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(testHealthStatePath(), JSON.stringify(state, null, 2));
}

// --- Execution ---

export function checkProjectTestHealth(
  project: ProjectConfig,
  options?: { force?: boolean },
): TestHealthResult {
  const projectPath = resolveProjectPath(project.name);
  if (!existsSync(projectPath)) return { skipped: true, reason: "path-not-found" };

  const testCmd = (project.test_command?.trim() || null) ?? detectTestCommand(projectPath);
  if (!testCmd) return { skipped: true, reason: "no-test-command" };

  const config = loadConfigSync();
  const state = loadTestHealthState();
  if (!options?.force && !shouldRunTestHealth(project.name, state, config)) {
    return { skipped: true, reason: "rate-limited" };
  }

  const start = Date.now();
  const proc = safeSyncOutput(["sh", "-c", testCmd], { cwd: projectPath, timeout: 300_000, trim: false });
  const duration = Date.now() - start;
  const passed = proc.ok;

  let failures: string | undefined;
  if (!passed) {
    const source = proc.stderr.trim().length >= 20 ? proc.stderr : (proc.stdout || proc.stderr);
    failures = source.slice(-500);
    if (proc.timedOut) {
      failures = `timeout after 300s\n${failures}`;
    }
  }

  state[project.name] = { lastRun: new Date().toISOString(), passed, ...(failures ? { failures } : {}) };
  saveTestHealthState(state);

  if (!passed) {
    tasksCreate(`Fix broken test suite: ${project.name}`, project.name, "A");
  }

  return { skipped: false, passed, duration, failures };
}

// --- Batch ---

export function runAllTestHealth(options?: { project?: string; force?: boolean }): void {
  const config = loadConfigSync();
  const projects = config.projects ?? [];

  for (const p of projects) {
    if (options?.project && p.name !== options.project) continue;
    try {
      const result = checkProjectTestHealth(p, { force: options?.force });
      if (result.skipped) {
        console.error(`[test-health] ${p.name}: skipped (${result.reason})`);
      } else if (result.passed) {
        console.error(`[test-health] ${p.name}: passed (${(result.duration! / 1000).toFixed(1)}s)`);
      } else {
        console.error(`[test-health] ${p.name}: FAILED — fix task filed (${(result.duration! / 1000).toFixed(1)}s)`);
      }
    } catch (err) {
      console.error(`[test-health] ${p.name}: error —`, err);
    }
  }
}
