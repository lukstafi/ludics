// Config reading for ludics (Phase 2: native YAML parsing)

import { existsSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import YAML from "yaml";
import { isPlainObject } from "./json.ts";

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
   *  lag reporting, and the once-daily keepalive fast-forward job. PR creation targets
   *  `repo` (the working/staging fork); forwarding staging commits upstream is manual. */
  upstream_repo?: string;
  path?: string;
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
  return process.cwd();
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
  return parsed as Record<string, unknown>;
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
 * Find the ProjectConfig entry matching a given project directory.
 * Match semantics: explicit `path` match (with ~/… expansion and worktree prefix),
 * then fallback to basename match against project name or repo tail.
 */
export function findProjectConfig(
  projectDir: string,
  config?: LudicsFullConfig,
): ProjectConfig | null {
  const cfg = config ?? loadConfigSync();
  return (cfg.projects ?? []).find((p) => {
    if (p.path) {
      const expanded = (String(p.path).startsWith("~/")
        ? join(process.env.HOME ?? "~", String(p.path).slice(2))
        : String(p.path)).replace(/\/+$/, "");
      if (projectDir === expanded || projectDir.startsWith(expanded + "/")) return true;
    }
    const dir = basename(projectDir).toLowerCase();
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

let _postponedProjectsCache: Set<string> | null = null;
export function postponedProjectSet(): Set<string> {
  if (!_postponedProjectsCache) _postponedProjectsCache = postponedProjects();
  return _postponedProjectsCache;
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
  return 25;
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
 * Resolve the local checkout path for a project by name.
 * Checks the `path` field in config, then falls back to ~/name and ~/repos/name.
 */
export function resolveProjectPath(projectName: string): string {
  const config = loadConfigSync();
  const projects = config.projects ?? [];
  for (const p of projects) {
    const name = String(p.name ?? "").toLowerCase();
    const repo = String(p.repo ?? "");
    const repoTail = repo.split("/").pop() ?? "";
    if (
      name === projectName.toLowerCase()
      || repoTail.toLowerCase() === projectName.toLowerCase()
    ) {
      if (p.path) {
        const resolved = String(p.path).startsWith("~/")
          ? join(process.env.HOME ?? "~", String(p.path).slice(2))
          : String(p.path);
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
  // Last resort: try ~/projectName
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

/** Set of projects with `priority: true` in config, cached per process. */
let _priorityProjectsCache: Set<string> | null = null;
function priorityProjectSet(): Set<string> {
  if (!_priorityProjectsCache) {
    _priorityProjectsCache = new Set(priorityProjects().map((p) => p.toLowerCase()));
  }
  return _priorityProjectsCache;
}

/**
 * Returns the effective (virtual) priority for a task, applying a one-level
 * boost when the task's project has `priority: true` in config:
 *   A → S, B → A, C → B (non-priority tasks keep their actual priority).
 */
export function effectivePriority(priority: string, project: string): string {
  if (!priorityProjectSet().has(project.toLowerCase())) return priority;
  switch (priority) {
    case "A": return "S";
    case "B": return "A";
    case "C": return "B";
    default: return priority;
  }
}

/**
 * Numeric sort key for virtual priority: S=0, A=1, B=2, C=3, other=9.
 * Applies priority-project boost automatically.
 */
export function effectivePriorityValue(priority: string, project: string): number {
  const ep = effectivePriority(priority, project);
  switch (ep) {
    case "S": return 0;
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
    default: return 9;
  }
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
