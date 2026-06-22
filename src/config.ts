// Config reading for ludics (Phase 2: native YAML parsing)

import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import YAML from "yaml";
import { atomicWriteFileSync, isPlainObject } from "./json.ts";
import { PRIORITY_INCREASE, priorityValue } from "./tasks/markdown.ts";
import type { Provider } from "./orchestration-defaults.ts";

const DEFAULT_STALE_THRESHOLD = 86400; // 24 hours

export interface AdapterConfigEntry {
  enabled?: boolean;
  /** Default argv tokens or shell-style arg string appended for this adapter. */
  default_args?: string[] | string;
}

export interface ProjectConfig {
  name: string;
  repo: string;
  /** Optional upstream repo used for GitHub issue sync, briefing staging-vs-upstream
   *  lag reporting, and the once-daily keepalive fast-forward jobs (inbound always;
   *  outbound when `outbound_sync_enabled` is true). PR creation targets `repo`
   *  (the working/staging fork). */
  upstream_repo?: string;
  /**
   * Local checkout path for the project. Either:
   * - a plain string (back-compat; `~/`-relative is expanded against the
   *   resolving machine's `$HOME`), or
   * - a map keyed by cluster machine name (e.g. `mac-studio`) or OS identifier
   *   (`macos` / `linux`, matching `cluster.machines[].os` — NOT `darwin`),
   *   selected most-specific-first (machine name → OS). Use the map only when
   *   the cluster spans genuinely divergent roots that the `~/`-relative
   *   convention cannot bridge (e.g. macOS `/Users` vs Linux `/home`).
   * Resolved via {@link projectConfigPath} / {@link resolveProjectPath}.
   */
  path?: string | Record<string, string>;
  issues?: boolean;
  priority?: boolean;
  /** When true, tasks from this project are excluded from the ready queue,
   *  auto-assignment, and auto-start. For temporarily disabling processing
   *  (e.g. required machine unavailable). */
  postponed?: boolean;
  /**
   * When true, task sorting uses milestone as the primary key (lexicographic),
   * with virtual priority as the tiebreaker within the same milestone.
   * Tasks without a milestone sort after all milestoned tasks.
   * Default: false.
   */
  milestones?: boolean;
  /** Directory for proposal documents, relative to project repo root.
   *  If unset, the draft-proposal orchestrator auto-detects from docs/, doc/, .docs/;
   *  falls back to docs/proposals/. */
  proposals_path?: string;
  /**
   * Per-adapter args profile for tasks in this project.
   * Entry value can be:
   * - shell-style string
   * - argv token array
   * - object with { args: ... }
   */
  adapter_profiles?: Record<string, { args?: string[] | string } | string[] | string>;
  /** Custom prompt for the @codex review PR comment. Overrides the default review focus. */
  codex_review_prompt?: string;
  /** Command to run the project's test suite locally (e.g. "bun test", "dune runtest").
   *  Auto-detected from project directory contents when unset. */
  test_command?: string;
  /** Hardware/OS requirements for slot assignment.
   *  Tasks in this project only auto-assign to machines satisfying all specified requirements.
   *  Task-level requirements override project-level values for the same key. */
  requirements?: { os?: string; gpu?: string };
  /** When true and `upstream_repo` is set, the once-daily keepalive tick attempts
   *  a `git push upstream origin/<default>:<default>` from the staging checkout
   *  whenever origin is strictly ahead of upstream. Fast-forward-only by
   *  construction: a `git merge-base --is-ancestor upstream/<u> origin/<o>`
   *  pre-check plus git's server-side non-ff rejection guarantee the push is
   *  fast-forward (no `--force` / `--force-with-lease` is ever used).
   *  Throttled via `mag/last-outbound-fast-forward-<project>.epoch`.
   *  Default `false` — absent fields are treated as not enabled. See
   *  docs/proposals/gh-ludics-540-outbound-staging-ff.md. */
  outbound_sync_enabled?: boolean;
  /** When true, `checkProjectTestHealth` / `runAllTestHealth` skip this
   *  project's test-health run while t3code integration is paused
   *  (`mag.t3code_integration_enabled` is false). Forward-compatible
   *  per-project flag; the `t3code-ludics` project is also matched by name as
   *  a fallback. Default `false`. See docs/proposals/t3code-integration-feature-flag.md. */
  requires_t3code?: boolean;
}

export type GlobalAdapterMode = "t3code" | "tmux";

export interface LudicsFullConfig {
  state_repo: string;
  state_path: string;
  staleThresholdSeconds: number;
  /** Global orchestration backend: "t3code" (default) or "tmux". */
  adapter?: GlobalAdapterMode;
  slots?: { count?: number };
  projects?: ProjectConfig[];
  adapters?: Record<string, AdapterConfigEntry>;
  mag?: Record<string, unknown>;
  triggers?: Record<string, unknown>;
  notifications?: {
    provider?: string;
    /** Topic keys: outgoing (Mag→user), incoming (user→Mag), agents (operational) */
    topics?: Record<string, string>;
    priorities?: Record<string, number>;
    /** Bearer token for ntfy.sh authentication */
    token?: string;
    public_filter?: {
      auto_publish?: string[];
      never_publish?: string[];
    };
  };
  dashboard?: { port?: number; ttl?: number };
  cluster?: {
    transport?: string;
    domain?: string;
    secret?: string;
    machines?: Array<Record<string, unknown>>;
  };
}

export function ludicsRoot(): string {
  // Prefer cwd when it looks like a ludics checkout. Without this, a stale
  // `~/.local/bin/ludics` symlink pointing at a task worktree would make every
  // subsequent init re-install from the worktree (self-reinforcing hijack).
  const cwd = process.cwd();
  if (existsSync(join(cwd, "bin", "ludics")) && existsSync(join(cwd, "templates"))) {
    return cwd;
  }

  // Prefer the invoked entry script path in dev mode (`bun run src/index.ts`),
  // where process.execPath points to the Bun executable in ~/.bun/bin.
  const entry = process.argv[1] ?? "";
  if (entry.includes("/src/")) {
    return entry.replace(/\/src\/.*$/, "");
  }
  if (entry.includes("/bin/")) {
    return entry.replace(/\/bin\/.*$/, "");
  }

  const execPath = process.execPath;
  // Compiled binary path in production mode.
  if (execPath.includes("/bin/ludics")) {
    return execPath.replace(/\/bin\/.*$/, "");
  }
  return cwd;
}

export function pointerConfigPath(): string {
  if (process.env.LUDICS_CONFIG) return process.env.LUDICS_CONFIG;
  if (process.env.PAI_LITE_CONFIG) return process.env.PAI_LITE_CONFIG;
  const newPath = join(process.env.HOME!, ".config/ludics/config.yaml");
  if (existsSync(newPath)) return newPath;
  // Legacy fallback for upgrades from pai-lite
  const legacyPath = join(process.env.HOME!, ".config/pai-lite/config.yaml");
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}

function parseYamlFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf-8");
  const parsed: unknown = YAML.parse(text);
  if (!isPlainObject(parsed)) return {};
  return parsed;
}

function resolveConfigPath(): string {
  const pointer = pointerConfigPath();
  if (!existsSync(pointer)) return pointer;

  const data = parseYamlFile(pointer);
  const stateRepo = (data.state_repo as string) ?? "";
  const statePath = (data.state_path as string) || "harness";

  if (stateRepo) {
    const repoName = stateRepo.split("/").pop()!;
    const harnessConfig = join(process.env.HOME!, repoName, statePath, "config.yaml");
    if (existsSync(harnessConfig)) return harnessConfig;
  }

  return pointer;
}

// --- Config key validation against reference schema ---

// Paths where child keys are user-defined, not from the reference schema
const FREEFORM_CHILDREN = new Set([
  "triggers",                // trigger names: startup, sync, etc.
  "notifications.topics",
  "notifications.priorities",
]);

let configValidated = false;

function validateConfigKeys(
  userObj: Record<string, unknown>,
  refObj: Record<string, unknown>,
  path: string,
): void {
  if (FREEFORM_CHILDREN.has(path)) return;
  const refKeys = new Set(Object.keys(refObj));
  for (const key of Object.keys(userObj)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (!refKeys.has(key)) {
      const normalized = key.replace(/-/g, "_");
      if (refKeys.has(normalized)) {
        console.error(`ludics: config warning: "${fullPath}" uses hyphens — did you mean "${path ? path + "." : ""}${normalized}"?`);
      } else {
        console.error(`ludics: config warning: unknown key "${fullPath}"`);
      }
      continue;
    }
    const userVal = userObj[key];
    const refVal = refObj[key];
    if (userVal && refVal && typeof userVal === "object" && typeof refVal === "object"
        && !Array.isArray(userVal) && !Array.isArray(refVal)) {
      validateConfigKeys(userVal as Record<string, unknown>, refVal as Record<string, unknown>, fullPath);
    }
  }
}

let referenceConfig: Record<string, unknown> | null | undefined;

function loadReferenceConfig(): Record<string, unknown> | null {
  if (referenceConfig !== undefined) return referenceConfig;
  try {
    // Try ludicsRoot first (works for compiled binary), then import.meta.dir (works for bun run dev)
    let refPath = join(ludicsRoot(), "templates", "config.reference.yaml");
    if (!existsSync(refPath)) {
      refPath = join(import.meta.dir, "..", "templates", "config.reference.yaml");
    }
    if (!existsSync(refPath)) { referenceConfig = null; return null; }
    referenceConfig = parseYamlFile(refPath);
    return referenceConfig;
  } catch {
    referenceConfig = null;
    return null;
  }
}

function validateConfig(data: Record<string, unknown>): void {
  const ref = loadReferenceConfig();
  if (ref) validateConfigKeys(data, ref, "");
}

export function loadConfigSync(): LudicsFullConfig {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath} (run: ludics init)`);
  }

  const data = parseYamlFile(configPath) as Record<string, unknown>;
  if (!configValidated) {
    validateConfig(data);
    configValidated = true;
  }

  const staleEnv = process.env.SESSIONS_STALE_THRESHOLD;
  const staleThresholdSeconds = staleEnv ? parseInt(staleEnv, 10) : DEFAULT_STALE_THRESHOLD;

  const rawAdapter = data.adapter as string | undefined;
  let adapter: GlobalAdapterMode | undefined;
  if (rawAdapter) {
    if (rawAdapter === "t3code" || rawAdapter === "tmux") {
      adapter = rawAdapter;
    } else {
      console.error(`ludics: config warning: unknown adapter "${rawAdapter}" — expected "t3code" or "tmux"`);
    }
  }

  return {
    state_repo: (data.state_repo as string) ?? "",
    state_path: (data.state_path as string) || "harness",
    staleThresholdSeconds,
    adapter,
    slots: data.slots as LudicsFullConfig["slots"],
    projects: data.projects as LudicsFullConfig["projects"],
    adapters: data.adapters as LudicsFullConfig["adapters"],
    mag: data.mag as LudicsFullConfig["mag"],
    triggers: data.triggers as LudicsFullConfig["triggers"],
    notifications: data.notifications as LudicsFullConfig["notifications"],
    dashboard: data.dashboard as LudicsFullConfig["dashboard"],
    cluster: (data.cluster ?? data["feder" + "ation"]) as LudicsFullConfig["cluster"],
  };
}

// Async wrapper for backward compatibility with Phase 1 callers
export async function loadConfig(): Promise<LudicsFullConfig> {
  return loadConfigSync();
}

/**
 * Return the parsed `mag.orchestration` config block (or undefined when absent
 * or config loading fails). Neutral, exported home for the orchestration record
 * so non-adapter modules (e.g. `transport-t3code.ts`) can resolve it without
 * importing an adapter's private `loadConfigOrchestration` helper (task-13dee93b).
 */
export function loadOrchestrationConfig(): Record<string, unknown> | undefined {
  try {
    const cfg = loadConfigSync();
    const mag = cfg.mag as Record<string, unknown> | undefined;
    return mag?.orchestration as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the global orchestration adapter mode.
 * Defaults to "t3code" when the key is absent for backward compatibility.
 */
export function globalAdapter(): GlobalAdapterMode {
  try {
    const config = loadConfigSync();
    return config.adapter ?? "t3code";
  } catch {
    return "t3code";
  }
}

/**
 * Thrown when a project's `path` is a machine/OS map but no entry matches the
 * resolution target. A hard error (rather than an empty string) so a
 * misconfigured map cannot silently fall through to the empty-path fallback
 * chain (`makeAdapterContext` local re-resolve / `resolveProjectDir` →
 * `process.cwd()`) and dispatch a slot against the wrong root.
 */
export class ProjectPathMapMissError extends Error {}

/** Map `process.platform` to the config's OS vocabulary (`macos` / `linux`). */
function currentOsId(): string {
  return process.platform === "darwin" ? "macos" : "linux";
}

/**
 * Select the configured checkout path string for a project, honoring the
 * `string | Record<string,string>` schema. Returns the **unexpanded** string
 * (a leading `~/` is left for the resolving machine to expand against its own
 * `$HOME`).
 *
 * For a map, selects most-specific-first: machine name → that machine's OS →
 * `undefined`. `machine` defaults to the local cluster machine name; the OS
 * defaults to the local platform. Returns `undefined` when no `path` is
 * configured or (for a map) no key matches — callers that are dispatch
 * authorities translate the map-miss into a thrown {@link ProjectPathMapMissError};
 * best-effort/display callers treat `undefined` as "no path".
 *
 * Cluster lookups are done via a lazy `require("./cluster.ts")` (cluster.ts
 * imports this module, so a static import would create a cycle); only the map
 * branch touches cluster, so plain-string configs never do.
 */
export function projectConfigPath(p: ProjectConfig, machine?: string): string | undefined {
  const raw = p.path;
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  // Map form: resolve target machine name + OS.
  let targetName = machine;
  let targetOs: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- cluster.ts imports config.ts; lazy require breaks the cycle
    const cluster = require("./cluster.ts") as typeof import("./cluster.ts");
    if (!targetName) targetName = cluster.clusterCurrentMachineName() ?? undefined;
    targetOs = machine ? cluster.clusterMachine(machine)?.os : cluster.clusterCurrentMachine()?.os;
  } catch { /* cluster unavailable — fall back to platform OS below */ }
  if (!targetOs) targetOs = machine ? undefined : currentOsId();
  if (targetName && raw[targetName] !== undefined) return raw[targetName];
  if (targetOs && raw[targetOs] !== undefined) return raw[targetOs];
  return undefined;
}

/**
 * Find the ProjectConfig entry matching a given project directory.
 * Match semantics, tried in order against each configured project's `path`:
 * - Exact match against the configured path (with `~/` expansion).
 * - The directory is a subdirectory of the configured path (`<path>/...`).
 * - The directory is an orchestration worktree sibling of the configured
 *   path: same parent directory, basename prefixed with the project's
 *   directory basename plus `-` (e.g. `~/ocannl-staging` matches
 *   `~/ocannl-staging-task-71e28eb1-s1`). Without this branch the
 *   wrong-base-repo gate in `verifyPhaseOutcome` silently no-ops for every
 *   orchestration slot, because slots always run inside such worktrees.
 *
 * Falls back to basename match against project name or repo tail when no
 * `path` is configured (or none of the path branches match).
 */
export function findProjectConfig(
  projectDir: string,
  config?: LudicsFullConfig,
): ProjectConfig | null {
  const cfg = config ?? loadConfigSync();
  const normalized = projectDir.replace(/\/+$/, "");
  return (cfg.projects ?? []).find((p) => {
    // Best-effort reverse lookup: a map-miss yields `undefined` and simply
    // falls through to the name/repo-tail match below (no throw — this is not
    // a dispatch authority).
    const cfgPath = projectConfigPath(p);
    if (cfgPath) {
      const expanded = (cfgPath.startsWith("~/")
        ? join(process.env.HOME ?? "~", cfgPath.slice(2))
        : cfgPath).replace(/\/+$/, "");
      if (normalized === expanded || normalized.startsWith(expanded + "/")) return true;
      // Orchestration worktree sibling: same parent, basename prefixed with
      // the configured project's basename + "-". The "-" separator anchors
      // the match so a sibling project literally named `<base>extra/` (no
      // dash) does not false-positive.
      const expandedParent = dirname(expanded);
      const expandedBase = basename(expanded);
      if (
        expandedBase.length > 0 &&
        dirname(normalized) === expandedParent &&
        basename(normalized).startsWith(expandedBase + "-")
      ) {
        return true;
      }
    }
    const dir = basename(normalized).toLowerCase();
    const repoTail = String(p.repo ?? "").split("/").pop()?.toLowerCase() ?? "";
    return dir === String(p.name ?? "").toLowerCase() || dir === repoTail;
  }) ?? null;
}

/** Look up a project config entry by project name or repo-tail (case-insensitive). */
export function findProjectConfigByName(
  projectName: string,
  config?: LudicsFullConfig,
): ProjectConfig | null {
  if (!projectName) return null;
  const cfg = config ?? loadConfigSync();
  const key = projectName.toLowerCase();
  return (cfg.projects ?? []).find((p) => {
    const repoTail = (p.repo.split("/").pop() ?? "").toLowerCase();
    return p.name.toLowerCase() === key || repoTail === key;
  }) ?? null;
}

export function harnessDir(): string {
  if (process.env.LUDICS_HARNESS_DIR) return process.env.LUDICS_HARNESS_DIR;

  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }

  const data = parseYamlFile(configPath);
  const stateRepo = (data.state_repo as string) ?? "";
  const statePath = (data.state_path as string) || "harness";

  const repoName = stateRepo.split("/").pop()!;
  return join(process.env.HOME!, repoName, statePath);
}

export function stateRepoDir(): string {
  const config = loadConfigSync();
  const repoName = config.state_repo.split("/").pop()!;
  return join(process.env.HOME!, repoName);
}


export function slotJsonDir(harness?: string): string {
  const h = harness ?? harnessDir();
  return join(h, "slots");
}

export function slotsCount(): number {
  const config = loadConfigSync();
  return config.slots?.count ?? 6;
}

export function priorityProjects(): string[] {
  const config = loadConfigSync();
  return (config.projects ?? []).filter((p) => p.priority).map((p) => p.name);
}

export function postponedProjects(): Set<string> {
  const config = loadConfigSync();
  return new Set((config.projects ?? []).filter((p) => p.postponed).map((p) => p.name.toLowerCase()));
}

/**
 * Wrap a Set in a Proxy that throws on any mutator method, so cached singletons
 * cannot be polluted by callers (`postponedProjectSet().add(x)`). `Object.freeze`
 * is inert on Set — `.add()` / `.delete()` / `.clear()` still mutate the backing
 * store. The Proxy enforces the read-only contract at runtime; the public return
 * type is `ReadonlySet<string>` so TypeScript blocks mutation calls at compile time.
 */
function readonlySet<T>(set: Set<T>): ReadonlySet<T> {
  return new Proxy(set, {
    get(target, prop) {
      if (prop === "add" || prop === "delete" || prop === "clear") {
        throw new TypeError(`readonly Set: '${String(prop)}' is not allowed`);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ReadonlySet<T>;
}

// Cached singleton of postponed-project names. Audit (gh-ludics-405): callers
// in mag.ts and flow.ts use `.has()` only, but the structural hazard remains —
// any future caller doing `postponedProjectSet().add(x)` would permanently
// pollute the cache. The Proxy mutator-trap closes that hazard at runtime;
// `ReadonlySet<string>` closes it at compile time.
let _postponedProjectsCache: ReadonlySet<string> | null = null;
export function postponedProjectSet(): ReadonlySet<string> {
  if (!_postponedProjectsCache) _postponedProjectsCache = readonlySet(postponedProjects());
  return _postponedProjectsCache;
}

/** Test-only: reset cached postponed-project set. Not exported via index.ts. */
export function _resetPostponedProjectsCache(): void {
  _postponedProjectsCache = null;
}

export function preemptAutonomy(): "auto" | "suggest" {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const levels = mag?.autonomy_level as Record<string, unknown> | undefined;
  const val = levels?.preempt_slots;
  return val === "auto" ? "auto" : "suggest";
}

export function cleanupDelayHours(): number {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const val = mag?.cleanup_delay_hours;
  if (typeof val === "number" && val > 0) return Math.min(val, 72);
  // Default just under a day so that an entry recorded at time T, plus the next
  // ~6h reaping tick after the window elapses, lands the reap "next day" rather
  // than next-day-plus. Keeps a full overnight re-attach window for inspection.
  return 21;
}

export function startSessionsAutonomy(): "auto" | "suggest" | "manual" {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const levels = mag?.autonomy_level as Record<string, unknown> | undefined;
  const val = levels?.start_sessions;
  if (val === "auto") return "auto";
  if (val === "suggest") return "suggest";
  return "manual";
}

/**
 * Whether the t3code integration is enabled. Default `false` — the integration
 * is paused (see docs/proposals/t3code-integration-feature-flag.md). Gates
 * session discovery, adapter assignment, orchestration auto-flag selection,
 * the t3code server nudge, and test-health for t3code-dependent projects.
 * Strict opt-in: only literal `true` enables; absent / `false` / strings /
 * truthy non-booleans all return `false`.
 */
export function t3codeIntegrationEnabled(): boolean {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  return mag?.t3code_integration_enabled === true;
}

/**
 * Resolve the checkout path for a project by name.
 *
 * Local resolution (no `machine`, or `machine` == this node, or no cluster):
 * checks the `path` field in config, then falls back to ~/name and ~/repos/name,
 * existsSync-gating each candidate against the local disk.
 *
 * Remote resolution (controller resolving for a non-local destination
 * `machine`): selects the destination's `path` (machine/OS map entry or the
 * plain string) and returns it **unexpanded** — a leading `~/` is left for the
 * worker to expand against its own `$HOME` — and **without** existsSync gating,
 * since the controller cannot see the worker's disk (gh-ludics-579 AC3). The
 * worker-side `createWorktrees` guard owns the actual checkout-existence check.
 *
 * @throws {ProjectPathMapMissError} when the matched project's `path` is a
 *   machine/OS map with no entry for the resolution target — a hard error so a
 *   misconfigured map cannot silently fall through to a wrong-root fallback.
 */
export function resolveProjectPath(projectName: string, machine?: string): string {
  const config = loadConfigSync();
  const projects = config.projects ?? [];

  // A `machine` denotes a *remote* destination only when cluster is enabled and
  // we can resolve the current node's name. Standalone / no-cluster / same-node
  // → local resolution (the `machine` arg is a no-op), preserving every existing
  // single-box and local caller's behaviour.
  let isRemote = false;
  if (machine) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- cluster.ts imports config.ts; lazy require breaks the cycle
      const cluster = require("./cluster.ts") as typeof import("./cluster.ts");
      const current = cluster.clusterCurrentMachineName();
      isRemote = !!current && machine !== current;
    } catch { isRemote = false; }
  }

  for (const p of projects) {
    const name = String(p.name ?? "").toLowerCase();
    const repo = String(p.repo ?? "");
    const repoTail = repo.split("/").pop() ?? "";
    if (
      name === projectName.toLowerCase()
      || repoTail.toLowerCase() === projectName.toLowerCase()
    ) {
      const selected = projectConfigPath(p, machine);
      // Map present but no machine/OS key matched → loud config error rather
      // than an empty path that would fall through to the wrong root.
      if (selected === undefined && isPlainObject(p.path)) {
        throw new ProjectPathMapMissError(
          `project "${projectName}" has a path map with no entry for machine ` +
          `"${machine ?? "<local>"}" or its OS — add a machine- or OS-keyed entry to projects[].path`,
        );
      }

      if (isRemote) {
        // Ship unexpanded, no existsSync (controller can't see the worker disk).
        if (selected) return selected;
        // No `path` configured → conventional ~/<repoTail> (worker expands).
        return repoTail ? `~/${repoTail}` : (projectName ? `~/${projectName}` : "");
      }

      // Local resolution (unchanged semantics).
      if (selected) {
        const resolved = selected.startsWith("~/")
          ? join(process.env.HOME ?? "~", selected.slice(2))
          : selected;
        if (existsSync(resolved)) return resolved;
      }
      // repo is the working repo directly; try upstream_repo tail as fallback
      const upstreamRepo = String(p.upstream_repo ?? "");
      const upstreamTail = upstreamRepo ? (upstreamRepo.split("/").pop() ?? "") : "";
      const home = process.env.HOME ?? "~";
      const tails = upstreamTail && upstreamTail !== repoTail
        ? [repoTail, upstreamTail]
        : [repoTail];
      for (const tail of tails) {
        for (const candidate of [
          join(home, tail),
          join(home, "repos", tail),
          join(home, tail.toLowerCase()),
        ]) {
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  // No project config matched. For a remote destination, return the conventional
  // ~/<projectName> unexpanded (no local existsSync — AC3).
  if (isRemote) return projectName ? `~/${projectName}` : "";
  // Last resort (local): try ~/projectName
  const home = process.env.HOME ?? "~";
  for (const candidate of [
    join(home, projectName),
    join(home, projectName.toLowerCase()),
    join(home, "repos", projectName.toLowerCase()),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/**
 * Resolve the absolute proposals directory for a project.
 * Uses configuredPath (relative to projectDir) if provided.
 * Otherwise probes docs/, doc/, .docs/ and appends proposals/.
 * Falls back to docs/proposals/.
 */
export function resolveProposalsPath(projectDir: string, configuredPath?: string): string {
  if (configuredPath) return join(projectDir, configuredPath);
  for (const candidate of ["docs", "doc", ".docs"]) {
    const p = join(projectDir, candidate);
    if (existsSync(p) && statSync(p).isDirectory()) {
      return join(projectDir, candidate, "proposals");
    }
  }
  return join(projectDir, "docs", "proposals");
}

/**
 * Set of projects with `priority: true` in config, cached per process.
 * Audit (gh-ludics-405): `priorityProjectSet` is module-private and only
 * `.has()` is read by callers, but it shares the same structural hazard as
 * `postponedProjectSet` — a singleton mutable Set returned by getter. Same
 * Proxy + ReadonlySet strategy applied for consistency with the postponed
 * cache; both sites use `readonlySet()`.
 */
let _priorityProjectsCache: ReadonlySet<string> | null = null;
function priorityProjectSet(): ReadonlySet<string> {
  if (!_priorityProjectsCache) {
    _priorityProjectsCache = readonlySet(new Set(priorityProjects().map((p) => p.toLowerCase())));
  }
  return _priorityProjectsCache;
}

/** Test-only: reset cached priority-project set. Not exported via index.ts. */
export function _resetPriorityProjectsCache(): void {
  _priorityProjectsCache = null;
}

/**
 * Test-only: peek the cached priority-project set reference for identity-based
 * eviction tests (mirrors the canonical pre/post-eviction `===`/`!==` rungs in
 * `src/tasks/markdown.test.ts`). Not exported via index.ts.
 */
export function _peekPriorityProjectsCache(): ReadonlySet<string> | null {
  return _priorityProjectsCache;
}

/**
 * Returns the effective (virtual) priority for a task, applying a one-level
 * boost when the task's project has `priority: true` in config:
 *   A → S, B → A, C → B, D → C (non-priority tasks keep their actual priority).
 * Delegates to the shared PRIORITY_INCREASE table so future ladder changes
 * only need to touch markdown.ts.
 */
export function effectivePriority(priority: string, project: string): string {
  if (!priorityProjectSet().has(project.toLowerCase())) return priority;
  return PRIORITY_INCREASE[priority] ?? priority;
}

/**
 * Numeric sort key for virtual priority: S=0, A=1, B=2, C=3, D=4, other=9.
 * Applies priority-project boost automatically.
 */
export function effectivePriorityValue(priority: string, project: string): number {
  return priorityValue(effectivePriority(priority, project));
}

/**
 * Returns the set of project names that have milestones enabled in config.
 */
export function milestonesEnabledProjects(): Set<string> {
  const config = loadConfigSync();
  const result = new Set<string>();
  for (const project of (config.projects ?? [])) {
    if (project.milestones) result.add(project.name.toLowerCase());
  }
  return result;
}

/**
 * Returns the milestone sort key for a task.
 * If the task's project has milestones enabled and the task has a milestone,
 * returns the milestone string (sorts alphabetically/lexicographically).
 * Otherwise returns "\uFFFF" so the task sorts after all milestoned tasks.
 *
 * Pass the pre-computed `enabledProjects` set to avoid repeated config reads
 * inside sort comparators.
 */
export function milestoneKey(
  milestone: string | undefined | null,
  project: string,
  enabledProjects: Set<string>,
): string {
  if (enabledProjects.has(project) && milestone) return milestone;
  return "\uFFFF";
}

// --- Orchestration defaults writer (task-b43bd578) ---
//
// Persists the dashboard role-switcher's choice to
// mag.orchestration.default_coder / default_reviewer in config.yaml.
//
// Uses YAML.parseDocument + setIn + toString to preserve unrelated keys,
// ordering, and comments on the rest of the file. Explicit null values
// are persisted as YAML `null` (not deleted) so the dashboard can
// distinguish present-null from absent on reload (AC 9, AC 10, AC 11).
export function writeOrchestrationDefaults(state: {
  coder: Provider | null;
  reviewer: Provider | null;
  coderClass?: "claude-opus" | "claude-fable";
  reviewerClass?: "claude-opus" | "claude-fable";
}): void {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath} (run: ludics init)`);
  }
  const text = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(text);
  doc.setIn(["mag", "orchestration", "default_coder"], state.coder);
  doc.setIn(["mag", "orchestration", "default_reviewer"], state.reviewer);
  // task-13dee93b: persist the per-role high-end class when provided; absent
  // fields leave the existing config key untouched.
  let seedFable = false;
  if (state.coderClass !== undefined) {
    doc.setIn(["mag", "orchestration", "coder_class"], state.coderClass);
    if (state.coderClass === "claude-fable") seedFable = true;
  }
  if (state.reviewerClass !== undefined) {
    doc.setIn(["mag", "orchestration", "reviewer_class"], state.reviewerClass);
    if (state.reviewerClass === "claude-fable") seedFable = true;
  }
  // Idempotent backfill: a claude-fable selection requires a resolvable
  // model_classes.claude-fable, or the session would throw "…is required" at
  // launch. Seed the canonical value only when the key is absent — never
  // overwrite a user's existing value.
  if (seedFable && doc.getIn(["mag", "orchestration", "model_classes", "claude-fable"]) === undefined) {
    doc.setIn(["mag", "orchestration", "model_classes", "claude-fable"], "claude-fable-5");
  }
  atomicWriteFileSync(configPath, doc.toString());
}

