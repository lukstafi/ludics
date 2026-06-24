import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs";
import { writeJsonFile } from "./json.ts";
import { join } from "path";
import { type ProjectConfig, loadConfigSync, harnessDir, resolveProjectPath, postponedProjectSet, t3codeIntegrationEnabled } from "./config.ts";
import { tasksCreate } from "./tasks/index.ts";
import { addFrontmatterField, transitionStatus, appendToSection, setDependencyScalar, parseTaskFrontmatter, TERMINAL_STATUSES } from "./tasks/markdown.ts";
import { safeSyncOutput } from "./spawn.ts";
import { clusterCurrentMachine, selectOnlineCapableMachine } from "./cluster.ts";
import { runRemoteCommand } from "./remote.ts";

// --- Types ---

interface TestHealthEntry {
  lastRun: string;
  passed: boolean;
  failures?: string;
}

export type TestHealthState = Record<string, TestHealthEntry>;

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
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: { test?: string } };
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

/** @internal exported for tests only */
export function testHealthStatePath(): string {
  return join(harnessDir(), "mag", "test-health.json");
}

/** @internal exported for tests only */
export function loadTestHealthState(): TestHealthState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(testHealthStatePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as TestHealthState;
  } catch {
    return {};
  }
}

/** @internal exported for tests only */
export function saveTestHealthState(state: TestHealthState): void {
  const dir = join(harnessDir(), "mag");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeJsonFile(testHealthStatePath(), state);
}

// --- Execution ---

/** gh-ludics-539: a project's test-health run depends on the t3code integration
 *  when it carries `requires_t3code: true` or is the `t3code-ludics` project
 *  (name fallback — zero-migration before the per-project annotation lands). */
export function projectRequiresT3code(project: ProjectConfig): boolean {
  return project.requires_t3code === true
    || project.name.toLowerCase() === "t3code-ludics";
}

// --- Capability gating (gh-ludics-578) ---

/** Result of evaluating a project's `requirements` against the current host.
 *  - `satisfied`: no requirements, or the current host meets every present key.
 *  - `unmet`: the current host is known but lacks a required capability.
 *  - `host-unknown`: capabilities are unprovable (cluster disabled or the host
 *    doesn't resolve to a `cluster.machines` entry). */
export type RequirementsCheck =
  | { status: "satisfied" }
  | { status: "unmet"; reqs: { os?: string; gpu?: string } }
  | { status: "host-unknown"; reqs: { os?: string; gpu?: string } };

/**
 * Evaluate `project.requirements` against the current host, mirroring
 * `selectMachineForSlot`'s per-key exact-equality semantics projected onto the
 * current machine: for each *present* requirement key (`os`, `gpu`), the host
 * satisfies it iff `currentMachine[key] === reqs[key]`. A project with no
 * requirements (or an empty requirements object) is always satisfied — even on
 * an unknown host (so this gate never disables test-health for requirement-free
 * projects on standalone deployments).
 */
export function requirementsSatisfiedByCurrentHost(project: ProjectConfig): RequirementsCheck {
  const reqs = project.requirements;
  const hasReqs = !!(reqs && (reqs.os || reqs.gpu));
  if (!hasReqs) return { status: "satisfied" };
  const current = clusterCurrentMachine(); // undefined when cluster disabled OR host unresolved
  if (!current) return { status: "host-unknown", reqs: reqs! };
  const ok = (!reqs!.os || current.os === reqs!.os)
    && (!reqs!.gpu || current.gpu === reqs!.gpu);
  return ok ? { status: "satisfied" } : { status: "unmet", reqs: reqs! };
}

// Test seam: routed remote execution dispatches through this holder so tests can
// inject a synthetic result (no real SSH/network). Mirrors the
// _runAllTestHealthDispatch pattern below.
/** @internal exported for tests only */
export const _remoteTestExec: { fn: typeof runRemoteCommand } = { fn: runRemoteCommand };

/** Best-effort project checkout path on a *remote* worker. Uses the project's
 *  configured `path` literally (a leading `~` is left for the remote shell to
 *  expand — NOT against the controller's HOME), else the `~/<repoTail>`
 *  convention. No local `existsSync` — the path lives on the worker. */
function remoteProjectPath(project: ProjectConfig): string {
  if (project.path) return String(project.path);
  const repoTail = String(project.repo ?? "").split("/").pop() ?? "";
  return `~/${repoTail}`;
}

/** Shared post-run finalization for an *actually-executed* suite (local or
 *  remote): extract failure text, persist `mag/test-health.json`, and file a
 *  fix-task on a real non-zero result. Guarantees AC4's "same result shape as a
 *  local run" by being the single code path both runs flow through. */
function finalizeExecutedRun(
  project: ProjectConfig,
  run: { ok: boolean; stdout: string; stderr: string; timedOut: boolean },
  duration: number,
): TestHealthResult {
  const passed = run.ok;
  let failures: string | undefined;
  if (!passed) {
    const source = run.stderr.trim().length >= 20 ? run.stderr : (run.stdout || run.stderr);
    failures = source.slice(-500);
    if (run.timedOut) {
      failures = `timeout after 300s\n${failures}`;
    }
  }

  const state = loadTestHealthState();
  state[project.name] = { lastRun: new Date().toISOString(), passed, ...(failures ? { failures } : {}) };
  saveTestHealthState(state);

  if (!passed) {
    fileTestFailureEpisode(project.name, failures);
  }

  return { skipped: false, passed, duration, failures };
}

/** Statuses that mean a child episode is no longer doing work. Mirrors
 *  `containerCompletionSweep`'s `TERMINAL_FOR_CHILD` ({done, abandoned}) plus
 *  the broader terminal set so a `stale`/`merged` child never counts as an
 *  active episode. A child in any of these states is "resolved"; one in any
 *  other status (ready/in-progress/etc.) is an active open episode. */
const CHILD_RESOLVED_STATUSES: ReadonlySet<string> = new Set([
  ...TERMINAL_STATUSES, // done, abandoned, merged, stale
]);

/**
 * Container/child auto-filer for a failing test suite (gh-ludics-605).
 *
 * The per-project umbrella task ("Fix broken test suite: <proj>") is a
 * `leaf: false` container; each failure *episode* is a dated child filed
 * `subtask_of` it. This replaces the old status-blind `tasksCreate` call, which
 * went permanently silent once the single per-project task reached a terminal
 * status (the fingerprint existence check is status-blind — issue #605).
 *
 * `tasksCreate` itself stays pure (idempotent fingerprint create); ALL policy
 * lives here.
 *
 *   res = tasksCreate(container-title)             // pure
 *   if res.created:  promote to container + file first dated child
 *   else (exists):
 *     terminal status  -> revive to `ready`, ensure container, file fresh child
 *     non-terminal AND has an active (open) child -> NO-OP (episode in flight)
 *     non-terminal AND no active child -> file a fresh dated child
 *
 * The "non-terminal but no active child" branch is the self-heal guard
 * (see PR notes): `verify-container-completion` only NOTIFIES — it never closes
 * the container — so a container can sit `ready` with all children already
 * resolved while the suite is still red. Keying the no-op on an *active child*
 * (not merely on container status) means a still-failing suite always carries
 * an open episode instead of silently losing the signal.
 */
function fileTestFailureEpisode(projectName: string, failures: string | undefined): void {
  const res = tasksCreate(`Fix broken test suite: ${projectName}`, projectName, "A");

  if (res.created) {
    addFrontmatterField(res.path, "leaf", "false"); // promote fresh task to container (stays `ready`)
    createEpisodeChild(projectName, failures, res.id);
    return;
  }

  const status = parseTaskFrontmatter(readFileSync(res.path, "utf-8")).status ?? "ready";

  if (TERMINAL_STATUSES.includes(status)) {
    // Container was closed (done/abandoned/merged/stale): revive + fresh child.
    transitionStatus(res.path, status, "ready");
    addFrontmatterField(res.path, "leaf", "false"); // idempotent ensure-container
    createEpisodeChild(projectName, failures, res.id);
    return;
  }

  // Container is non-terminal. No-op only if an active (open) child episode
  // already exists; otherwise file a fresh dated child so a still-red suite
  // never loses its open episode.
  if (hasActiveChild(res.id)) return;
  addFrontmatterField(res.path, "leaf", "false"); // idempotent ensure-container
  createEpisodeChild(projectName, failures, res.id);
}

/** True iff the container has at least one child (`subtask_of: <parentId>`)
 *  whose status is NOT resolved (i.e. an open episode is in flight). */
function hasActiveChild(parentId: string): boolean {
  const dir = join(harnessDir(), "tasks");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let fm;
    try {
      fm = parseTaskFrontmatter(readFileSync(join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    if (fm.dependencies?.subtask_of !== parentId) continue;
    if (!CHILD_RESOLVED_STATUSES.has(fm.status ?? "ready")) return true;
  }
  return false;
}

/**
 * File one dated failure-episode child task `subtask_of` the container.
 *
 * Title is episode-unique by date (`… — YYYY-MM-DD`) — a stable child title
 * would reintroduce the same fingerprint muzzle one level down. Same-day
 * double-breaks no-op via `tasksCreate`'s existence check; cross-day breaks get
 * a fresh child. The title is deliberately NOT fingerprinted by stderr content
 * (flaky output would proliferate children). The failures excerpt is embedded
 * in the child's `## Context` section so the episode is actionable without
 * cross-referencing `mag/test-health.json`.
 */
function createEpisodeChild(projectName: string, failures: string | undefined, parentId: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const child = tasksCreate(`Fix broken test suite: ${projectName} — ${today}`, projectName, "A");
  // Same-day double-break: the dated child already exists → no-op (don't
  // re-link or append divergent failure text). The existing open child keeps
  // the active-episode signal.
  if (!child.created) return;
  // Link to the container so containerCompletionSweep discovers the child.
  setDependencyScalar(child.path, "subtask_of", parentId);
  if (failures && failures.trim().length > 0) {
    appendToSection(child.path, "Context", `Failing tests (${today}):\n\n\`\`\`\n${failures.trim()}\n\`\`\``);
  }
}

/**
 * Handle a project whose current host does NOT satisfy its requirements
 * (AC4/AC5). `host-unknown` skips directly (capabilities unprovable). For a
 * known-but-incapable host, route the suite to a capability-matched, online
 * worker; degrade to a `requirements-unmet` skip — with NO state mutation and NO
 * fix-task — whenever routing can't complete for a capability/connectivity
 * reason. Only an actually-executed remote suite with a real non-zero result
 * files a fix-task.
 */
function routeOrSkipRequirementsUnmet(
  project: ProjectConfig,
  check: Extract<RequirementsCheck, { status: "unmet" | "host-unknown" }>,
  options?: { force?: boolean },
): TestHealthResult {
  const SKIP: TestHealthResult = { skipped: true, reason: "requirements-unmet" };

  // Unprovable capabilities (cluster off / host unresolved): skip, do not route.
  if (check.status === "host-unknown") return SKIP;

  // Known-but-incapable host: route to a fresh-heartbeat capable worker, if any.
  const worker = selectOnlineCapableMachine(check.reqs);
  if (!worker) return SKIP; // no eligible/online worker (AC5)

  // Resolve the command WITHOUT probing the controller's process cwd: when the
  // project has no `test_command` AND no checkout resolvable on the controller,
  // `resolveProjectPath` returns "" and `detectTestCommand("")` would probe files
  // in the current working directory (e.g. the ludics repo's own bun.lock),
  // wrongly routing an unrelated command. Only auto-detect against a real path.
  const localPath = resolveProjectPath(project.name); // "" or an existing path
  const testCmd = project.test_command?.trim() || (localPath ? detectTestCommand(localPath) : null);
  if (!testCmd) return SKIP; // cannot route a command we can't name (synchronous remote detection isn't possible)

  // Respect the same nightly rate-limit gate as the local path, so routing does
  // not SSH the worker and run the full suite on every keepalive tick.
  const config = loadConfigSync();
  const state = loadTestHealthState();
  if (!options?.force && !shouldRunTestHealth(project.name, state, config)) {
    return { skipped: true, reason: "rate-limited" };
  }

  const start = Date.now();
  const result = _remoteTestExec.fn(worker, testCmd, { cwd: remoteProjectPath(project), timeout: 300_000 });
  const duration = Date.now() - start;

  // Transport/connectivity failure: the suite never ran → skip-not-fail (AC5).
  if (result.kind === "transport-error") return SKIP;

  // The suite actually executed remotely: map exactly like a local run (AC4).
  return finalizeExecutedRun(project, result, duration);
}

export function checkProjectTestHealth(
  project: ProjectConfig,
  options?: { force?: boolean },
): TestHealthResult {
  if (postponedProjectSet().has(project.name.toLowerCase())) {
    return { skipped: true, reason: "postponed" };
  }
  // gh-ludics-539: skip t3code-dependent projects while the integration is
  // paused. Returns before path/test-command resolution and execution — no
  // 300s timeout run, no test-health.json entry, no fix-task.
  if (projectRequiresT3code(project) && !t3codeIntegrationEnabled()) {
    return { skipped: true, reason: "t3code-integration-paused" };
  }
  // gh-ludics-578: capability gate — after postponed/t3code (AC7 precedence),
  // before path resolution / command detection / execution. A host that can't
  // satisfy the project's requirements routes to a capable worker or skips
  // `requirements-unmet` (never runs-and-fails locally / files a false-positive
  // fix-task). Cheap (host-only); no path cost to avoid.
  const capability = requirementsSatisfiedByCurrentHost(project);
  if (capability.status !== "satisfied") {
    return routeOrSkipRequirementsUnmet(project, capability, options);
  }
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

  return finalizeExecutedRun(project, proc, duration);
}

// --- Batch ---

// Test seam: runAllTestHealth dispatches through this holder so tests can
// observe whether checkProjectTestHealth was invoked for a given project
// (AC1's invariant: the batch-loop postponed guard short-circuits before
// dispatch). The two guards otherwise produce identical observables.
/** @internal exported for tests only */
export const _runAllTestHealthDispatch: { fn: typeof checkProjectTestHealth } = {
  fn: checkProjectTestHealth,
};

export function runAllTestHealth(options?: { project?: string; force?: boolean }): void {
  const config = loadConfigSync();
  const projects = config.projects ?? [];

  for (const p of projects) {
    if (options?.project && p.name !== options.project) continue;
    try {
      // Inside the try block so a malformed entry (e.g. non-string `name`,
      // which the cast-based config loader does not validate) does not abort
      // the entire batch — fault isolation matches the existing per-project
      // try/catch contract.
      if (postponedProjectSet().has(p.name.toLowerCase())) {
        console.error(`[test-health] ${p.name}: skipped (postponed)`);
        continue;
      }
      // gh-ludics-539: batch-loop skip mirroring the postponed short-circuit —
      // surfaces the visible skip line and avoids dispatch (no command
      // detection, no 300s run) for t3code-dependent projects while paused.
      if (projectRequiresT3code(p) && !t3codeIntegrationEnabled()) {
        console.error(`[test-health] ${p.name}: skipped (t3code-integration-paused)`);
        continue;
      }
      const result = _runAllTestHealthDispatch.fn(p, { force: options?.force });
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
