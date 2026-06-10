import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { PEER_SYNC_DIRNAME, peerSyncPath } from "./peer-sync.ts";
import { slugify } from "./util.ts";
import { safeSyncOutput } from "../spawn.ts";
import { findProjectConfig, type ProjectConfig } from "../config.ts";

export interface WorktreeSetup {
  rootWorktree: string;
  peerSyncDir: string;
  agentWorktrees: Record<string, string>;
  branches: Record<string, string>;
}

export function runGit(projectDir: string, args: string[]): string {
  const r = safeSyncOutput(["git", ...args], { cwd: projectDir });
  if (!r.ok) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
  return r.stdout;
}

export function maybeGit(projectDir: string, args: string[]): string {
  return safeSyncOutput(["git", ...args], { cwd: projectDir }).stdout;
}

/** Paths that the orchestrator manages inside worktrees and must never be committed. */
export const GIT_EXCLUDE_ENTRIES = [
  PEER_SYNC_DIRNAME,
  ".ludics-orchestration.json",
  ".claude",
  ".agents",
  ".agent-sessions",
  "node_modules",
  "_build_review*",
];

/** Entries the orchestrator may write into a worktree root before any agent commits.
 *  Used by the orphan-recovery path in {@link addWorktree} and the cleanup-hardening
 *  path in `processDeferredCleanups`. Narrower than {@link GIT_EXCLUDE_ENTRIES} —
 *  excludes `.agents`, `.agent-sessions`, and `_build_review*` (agent work-product
 *  or sibling targets), so the presence of any of those means the dir contains
 *  real work and recovery must NOT proceed silently. */
export const ORPHAN_RECOVERY_ALLOWLIST = [
  PEER_SYNC_DIRNAME,
  ".claude",
  ".ludics-orchestration.json",
  "node_modules",
] as const;

/** Classify the contents of a directory at `path` for orphan-recovery purposes.
 *  Returns `recoverable` with the entries to preserve when contents are a subset
 *  of {@link ORPHAN_RECOVERY_ALLOWLIST} (after silently dropping `.DS_Store` noise),
 *  or `unrecognized` with the offending entries otherwise. `.DS_Store` is treated
 *  as silently-removable noise but does NOT count toward `preserve`. */
export function classifyOrphanDir(
  path: string,
): { kind: "recoverable"; preserve: string[] } | { kind: "unrecognized"; offending: string[] } {
  const entries = readdirSync(path);
  const allowlist = new Set<string>(ORPHAN_RECOVERY_ALLOWLIST);
  const preserve: string[] = [];
  const offending: string[] = [];
  let dropDsStore = false;
  for (const entry of entries) {
    if (entry === ".DS_Store") { dropDsStore = true; continue; }
    if (allowlist.has(entry)) preserve.push(entry);
    else offending.push(entry);
  }
  if (offending.length > 0) return { kind: "unrecognized", offending };
  if (dropDsStore) {
    try { rmSync(join(path, ".DS_Store"), { force: true }); } catch { /* best-effort */ }
  }
  return { kind: "recoverable", preserve };
}

/** Best-effort cleanup of an orphan worktree directory: if `path` exists, its
 *  basename matches the orchestration worktree naming pattern relative to
 *  `projectDir`, AND its contents match {@link ORPHAN_RECOVERY_ALLOWLIST},
 *  remove the orchestration entries and `rmdir` the parent so the next
 *  `addWorktree(path, ...)` does not need to enter the inline recovery branch.
 *
 *  Returns `true` on successful purge (or if `path` did not exist), `false` if
 *  the path failed the orchestration-name guard, contents were unrecognized,
 *  or any removal step failed. Does not throw — failures are logged via
 *  `console.error`.
 *
 *  The orchestration-name guard mirrors {@link removeWorktreeByPath}'s safety
 *  constraint: this is a destructive operation, and a corrupted or malicious
 *  cleanup manifest could otherwise list arbitrary paths whose contents
 *  happen to be a subset of the allow-list (e.g. a user's `node_modules` or
 *  `.claude` directory) and have them silently wiped. The guard is enforced
 *  inside the function rather than at the call site so it cannot be bypassed
 *  by future callers. */
export function purgeOrphanDirIfRecoverable(projectDir: string, path: string): boolean {
  const repoName = basename(resolve(projectDir));
  const base = basename(path);
  const prefix = repoName + "-";
  if (!base.startsWith(prefix) || !isOrchWorktreeSuffix(base.slice(prefix.length))) {
    console.error(`ludics: refusing to purge orphan dir "${path}" — does not match orchestration naming`);
    return false;
  }
  if (!existsSync(path)) return true;
  let classification: ReturnType<typeof classifyOrphanDir>;
  try {
    classification = classifyOrphanDir(path);
  } catch (err) {
    console.error(`ludics: orphan-dir purge failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (classification.kind === "unrecognized") return false;
  try {
    for (const entry of classification.preserve) {
      rmSync(join(path, entry), { recursive: true, force: true });
    }
    rmdirSync(path);
    return true;
  } catch (err) {
    console.error(`ludics: orphan-dir purge failed at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Subset of {@link GIT_EXCLUDE_ENTRIES} that is unambiguously orchestration-internal —
 *  safe to proactively `git rm --cached` from the index so these paths do not enter
 *  future commits on the current branch. Deliberately excludes paths that projects
 *  may legitimately track themselves (`.claude`, `.agents`, `node_modules`,
 *  `_build_review*`); those continue to rely on the defensive `git reset HEAD --`
 *  step inside {@link autoCommitWorktree}. */
const UNTRACK_PATHS = [
  PEER_SYNC_DIRNAME,
  ".ludics-orchestration.json",
  ".agent-sessions",
] as const;

/**
 * Ensure that all {@link GIT_EXCLUDE_ENTRIES} are present in the local
 * `.git/info/exclude` for the given repo or worktree path, and that the narrow
 * {@link UNTRACK_PATHS} subset is not tracked in the index.
 *
 * Uses `--git-common-dir` so that worktrees write to the shared exclude
 * file that git actually reads (not the per-worktree git dir).
 *
 * For {@link UNTRACK_PATHS} (`.peer-sync`, `.ludics-orchestration.json`,
 * `.agent-sessions`) that happen to be tracked, runs `git rm --cached -r` and
 * records the staged deletion(s) in a dedicated `chore: untrack
 * orchestration-internal files` commit on the current branch. The working-tree
 * copies are left in place. Other `GIT_EXCLUDE_ENTRIES` (`.claude`, `.agents`,
 * `node_modules`, `_build_review*`) are NOT untracked here — projects may
 * legitimately commit them, and the defensive reset in {@link autoCommitWorktree}
 * handles those cases.
 *
 * Idempotent: repeated calls produce neither duplicate exclude entries nor
 * additional chore commits. Throws on unexpected git failure in the
 * exclude-file setup — this is required setup, not best-effort. A failed chore
 * commit logs a warning but does not throw.
 *
 * This is the primary source of truth for orchestration-worktree exclusions;
 * do not combine it with `:(exclude)` pathspecs on `git add`. See
 * `docs/testing-patterns.md` § "Orchestration Worktree Exclusions".
 */
export function ensureGitExcludes(repoPath: string): void {
  const commonDir = runGit(repoPath, ["rev-parse", "--git-common-dir"]);
  const resolvedGitDir = resolve(repoPath, commonDir);
  const infoDir = join(resolvedGitDir, "info");
  const excludePath = join(infoDir, "exclude");

  mkdirSync(infoDir, { recursive: true });

  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf-8");
  } catch {
    // File doesn't exist yet — will be created.
  }

  const existingLines = new Set(existing.split("\n"));
  const missing = GIT_EXCLUDE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, existing + prefix + missing.join("\n") + "\n");
  }

  untrackOrchestrationInternal(repoPath);
}

/** Untrack the narrow {@link UNTRACK_PATHS} subset from the index, if any of them
 *  are tracked, and commit the staged deletion(s) with a dedicated chore message.
 *  No-op otherwise. Never throws — a failed chore commit logs a warning.
 *
 *  Safety: if there are pre-existing staged changes (e.g. from an adapter or
 *  a concurrent agent staging state before setup), skip the untrack step
 *  entirely — otherwise `git commit` would sweep those unrelated changes into
 *  the synthetic chore commit. The exclude-file write in {@link ensureGitExcludes}
 *  has already completed by the time we're called, so skipping here only
 *  leaves already-tracked orchestration paths in the index, which the
 *  defensive reset in {@link autoCommitWorktree} still handles at commit time.
 */
function untrackOrchestrationInternal(repoPath: string): void {
  const ls = safeSyncOutput(["git", "ls-files", "--", ...UNTRACK_PATHS], { cwd: repoPath });
  if (!ls.ok || !ls.stdout) return;

  // Refuse to run if there are pre-existing staged changes — otherwise our
  // chore commit would silently include them.
  const preStaged = maybeGit(repoPath, ["diff", "--cached", "--name-only"]);
  if (preStaged) {
    console.error(
      `ludics: skipping untrack of orchestration-internal files in ${repoPath}: pre-existing staged changes detected`,
    );
    return;
  }

  for (const path of UNTRACK_PATHS) {
    maybeGit(repoPath, ["rm", "--cached", "-r", "--ignore-unmatch", "--", path]);
  }

  const staged = maybeGit(repoPath, ["diff", "--cached", "--name-only"]);
  if (!staged) return;

  const commit = safeSyncOutput(
    ["git", "commit", "-m", "chore: untrack orchestration-internal files"],
    { cwd: repoPath },
  );
  if (!commit.ok) {
    console.error(
      `ludics: untrack chore commit failed in ${repoPath}: ${commit.stderr || "unknown error"}`,
    );
  }
}

function worktreeExists(projectDir: string, path: string): boolean {
  const list = maybeGit(projectDir, ["worktree", "list", "--porcelain"]);
  return list.split("\n").some((line) => line === `worktree ${path}`);
}

/**
 * True iff `path` is registered with git as a worktree AND that registration's
 * branch line is `branch refs/heads/<branch>`. Used by the resume short-circuit
 * in {@link addWorktree} — the directory existing on disk is not enough; git
 * must agree (a) that the directory IS the worktree and (b) that it tracks
 * the named branch. Any other shape (different path, different branch,
 * detached HEAD, prunable record) falls through to the teardown-and-recreate
 * path.
 */
function registeredWorktreeMatches(projectDir: string, path: string, branch: string): boolean {
  const list = maybeGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (!list) return false;
  return parseRegisteredWorktreeMatches(list, path, branch);
}

/**
 * Pure helper extracted from {@link registeredWorktreeMatches} for testability.
 * Given a `git worktree list --porcelain` body, return whether `path` is
 * registered, not prunable, and tracks `refs/heads/<branch>`.
 *
 * `git worktree list --porcelain` emits records separated by blank lines,
 * each beginning with `worktree <path>`.
 *
 * The `prunable` marker can appear bare (`prunable`) or with an attached
 * reason (`prunable gitdir file points to non-existent location`), so
 * match by prefix on the trimmed line — exact-equality matching would
 * miss the with-reason form and let the short-circuit accept a stale
 * registration. (Codex P2 reviewer note on PR #519.)
 */
export function parseRegisteredWorktreeMatches(
  porcelain: string,
  path: string,
  branch: string,
): boolean {
  if (!porcelain) return false;
  const records = porcelain.split(/\n\n+/);
  for (const record of records) {
    const lines = record.split("\n");
    const head = lines[0];
    if (head !== `worktree ${path}`) continue;
    if (lines.some((line) => {
      const trimmed = line.trim();
      return trimmed === "prunable" || trimmed.startsWith("prunable ");
    })) return false;
    return lines.includes(`branch refs/heads/${branch}`);
  }
  return false;
}

/** True iff the local branch ref `refs/heads/<branch>` exists in `projectDir`. */
function branchRefExists(projectDir: string, branch: string): boolean {
  return safeSyncOutput(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: projectDir },
  ).ok;
}

function removeIfRegistered(projectDir: string, path: string): void {
  if (worktreeExists(projectDir, path)) {
    maybeGit(projectDir, ["worktree", "remove", "--force", path]);
  }
}

/** Overall slug shape: lowercase alphanumeric segments separated by hyphens. */
const SLUG_SHAPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Multi-segment slug — at least two hyphen-separated segments (e.g. `task-abc`). */
const MULTI_SEGMENT_SLUG_RE = /^[a-z0-9]+-[a-z0-9]+/;
/** Slot marker anywhere in the suffix (e.g. `-s3`). */
const SLOT_MARKER_RE = /-s\d+(?:-|$)/;

/**
 * Validate that `suffix` (the part after `{repoName}-`) matches the
 * orchestration worktree naming shape: `{taskSlug}(-s{N})?(-{agentSlug})?`.
 *
 * Accepts multi-segment task slugs (`task-abc`, `task-abc-s2-agent`) and
 * single-segment slugs only when a slot marker is present (`feat-s1`).
 * Rejects generic names like `backup` or `scratch` that lack both traits.
 */
function isOrchWorktreeSuffix(suffix: string): boolean {
  if (!SLUG_SHAPE_RE.test(suffix)) return false;
  return MULTI_SEGMENT_SLUG_RE.test(suffix) || SLOT_MARKER_RE.test(suffix);
}

/** Remove a single worktree by its concrete path. Idempotent — no-op if not registered.
 *  Safety: validates that the path basename matches the orchestration worktree naming
 *  pattern (`{repoName}-{taskSlug}(-s{N})?(-{agentSlug})?`) to prevent accidental
 *  removal of unrelated directories. */
export function removeWorktreeByPath(projectDir: string, path: string): void {
  const repoName = basename(resolve(projectDir));
  const base = basename(path);
  const prefix = repoName + "-";
  if (!base.startsWith(prefix) || !isOrchWorktreeSuffix(base.slice(prefix.length))) {
    console.error(`ludics: refusing to remove worktree "${path}" — does not match orchestration naming`);
    return;
  }
  removeIfRegistered(projectDir, path);
}

/** Delete branches locally and remotely. Deduplicates, idempotent, best-effort for remote.
 *  Safety: skips any branch that does not start with `ludics/` to prevent accidental
 *  deletion of protected branches (main, master, etc.) due to state corruption. */
export function deleteBranches(projectDir: string, branches: string[]): void {
  const unique = [...new Set(branches)];
  for (const branch of unique) {
    if (!branch.startsWith("ludics/")) {
      console.error(`ludics: refusing to delete branch "${branch}" — does not match ludics/ prefix`);
      continue;
    }
    safeSyncOutput(["git", "branch", "-D", branch], { cwd: projectDir });
    const result = safeSyncOutput(["git", "push", "origin", "--delete", branch], { cwd: projectDir });
    if (!result.ok) {
      console.error(`ludics: remote branch delete failed for ${branch}: ${result.stderr ?? "unknown"}`);
    }
  }
}

function addWorktree(projectDir: string, path: string, branch: string, base: string): void {
  // Resume short-circuit: when the worktree directory still exists on disk,
  // the branch ref still exists in projectDir, AND git's own registration
  // agrees that this directory tracks this branch, leave everything alone.
  // No removeIfRegistered, no `git worktree add`, no filesystem touch — so any
  // uncommitted scratch the user (or a mid-round agent) left in the worktree
  // survives the call.
  //
  // Conservative: any inconsistency (registered path differs, registered
  // branch differs, prunable record, detached HEAD, missing branch ref)
  // falls through to the existing teardown-and-recreate path so the
  // orphan-recovery branch below remains the recovery seam for unusual
  // states.
  //
  // Paired with scope (1) of `proposal-commit-on-main-and-worktree-resume`:
  // the proposal commit is reliably on the project's default branch before
  // `createWorktrees` runs, so per-agent branches inherit it on first
  // creation, and a later resume preserves whatever the agents have done
  // since.
  if (
    existsSync(path) &&
    branchRefExists(projectDir, branch) &&
    registeredWorktreeMatches(projectDir, path, branch)
  ) {
    return;
  }

  removeIfRegistered(projectDir, path);

  // Orphan recovery: directory exists but git no longer registers it as a worktree
  // (typically because `git worktree prune` swept the admin record while the
  // scaffolding remained on disk). Move the orchestration entries aside, recreate
  // the worktree via `git worktree add`, then move the entries back into place.
  let recoveredEntries: string[] | null = null;
  let tempDir: string | null = null;
  if (existsSync(path)) {
    const c = classifyOrphanDir(path);
    if (c.kind === "unrecognized") {
      throw new Error(
        `orphan worktree-directory detected at ${path} with non-orchestration content (${c.offending.join(", ")}); manual recovery needed`,
      );
    }
    tempDir = `${path}.orphan-recover`;
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    for (const entry of c.preserve) {
      renameSync(join(path, entry), join(tempDir, entry));
    }
    rmdirSync(path);
    recoveredEntries = c.preserve;
  }

  const branchExists = safeSyncOutput(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: projectDir },
  ).ok;
  try {
    if (branchExists) {
      runGit(projectDir, ["worktree", "add", path, branch]);
    } else {
      runGit(projectDir, ["worktree", "add", "-b", branch, path, base]);
    }
  } catch (err) {
    if (tempDir && existsSync(tempDir)) {
      console.error(
        `ludics: orphan recovery aborted for ${path}; preserved orchestration entries remain at ${tempDir}`,
      );
    }
    throw err;
  }

  if (recoveredEntries && tempDir) {
    for (const entry of recoveredEntries) {
      const target = join(path, entry);
      if (existsSync(target) || lstatExistsLink(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      renameSync(join(tempDir, entry), target);
    }
    try { rmdirSync(tempDir); } catch { /* leftover noise — leave for operator */ }
  }
}

/** `existsSync` follows symlinks, so a dangling symlink at `target` reports false
 *  and a subsequent `renameSync(...)` would fail with EEXIST. Detect link presence
 *  via `lstatSync` so we can pre-remove dangling links before moving entries back. */
function lstatExistsLink(target: string): boolean {
  try { return lstatSync(target).isSymbolicLink(); } catch { return false; }
}

export function defaultMainBranch(projectDir: string): string {
  const remoteHead = maybeGit(projectDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  const local = maybeGit(projectDir, ["branch", "--show-current"]);
  return local || "main";
}

/**
 * Fast-forward the project's main branch from `origin/<mainBranch>` so that
 * worktrees forked from it inherit fresh upstream state instead of whatever
 * the local checkout happened to point at. Without this, a stale local main
 * (e.g. user has not pulled in a while) silently propagates into every new
 * orchestration worktree.
 *
 * Best-effort and silent on graceful skip:
 * - No `origin` remote (e.g. local-only test repos): skip.
 * - Working tree is checked out to a different branch than `mainBranch`: skip
 *   (we don't switch branches under the user).
 * - Working tree has uncommitted changes: skip (we don't risk perturbing
 *   in-flight work, even though merge --ff-only would normally be safe).
 * - `git fetch` fails (network outage etc.): warn, skip — slot startup must
 *   not block on remote reachability.
 * - `git merge --ff-only` fails because local diverged from origin: warn,
 *   skip. We never force; divergence means the user has committed work
 *   directly on main and that work must be preserved.
 *
 * Never throws.
 */
export function refreshMainBranchFromRemote(projectDir: string, mainBranch: string): void {
  const dir = resolve(projectDir);
  // `git remote` may list a name purely from leftover `remote.<name>.*`
  // config keys even when no URL is set; require `remote.origin.url` so we
  // never try to fetch a phantom remote (this would otherwise produce a
  // noisy warning in test repos that set `remote.origin.gh-resolved` without
  // a real remote URL).
  const originUrl = safeSyncOutput(["git", "config", "--get", "remote.origin.url"], { cwd: dir });
  if (!originUrl.ok || originUrl.stdout.trim().length === 0) return;
  const current = maybeGit(dir, ["branch", "--show-current"]).trim();
  if (current !== mainBranch) return;
  const dirty = maybeGit(dir, ["status", "--porcelain"]).trim();
  if (dirty.length > 0) return;
  const fetchResult = safeSyncOutput(["git", "fetch", "origin", mainBranch], { cwd: dir });
  if (!fetchResult.ok) {
    console.error(`ludics: refreshMainBranchFromRemote: git fetch origin ${mainBranch} failed in ${dir} — continuing with stale local state`);
    return;
  }
  const mergeResult = safeSyncOutput(["git", "merge", "--ff-only", `origin/${mainBranch}`], { cwd: dir });
  if (!mergeResult.ok) {
    console.error(`ludics: refreshMainBranchFromRemote: ff-only merge of origin/${mainBranch} failed in ${dir} — local branch has diverged from origin, continuing with stale local state`);
  }
}

/**
 * Count commits on the worktree's HEAD ahead of `origin/<base>` where base is
 * resolved from `projectDir` (shared remote refs). Returns `null` on any git
 * error — callers should treat this as "cannot compare" and skip, not as zero.
 */
export function countCommitsAhead(worktreePath: string, projectDir: string): number | null {
  try {
    const base = defaultMainBranch(projectDir);
    const r = Bun.spawnSync(
      ["git", "rev-list", "--count", `origin/${base}..HEAD`],
      { cwd: worktreePath },
    );
    if (r.exitCode !== 0) return null;
    const n = parseInt(String(r.stdout).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Canonical orchestration branch name for a task/slot/suffix combination. */
export function orchBranchName(taskId: string, slot: number | undefined, suffix: string): string {
  const featureSlug = slugify(taskId);
  const slotSuffix = slot ? `-s${slot}` : "";
  return `ludics/${featureSlug}${slotSuffix}/${suffix}`;
}

/** Canonical worktree directory stem: `{repoName}-{slug}{slotSuffix}`. */
export function orchWorktreeStem(repoName: string, taskId: string, slot?: number): string {
  const featureSlug = slugify(taskId);
  const slotSuffix = slot ? `-s${slot}` : "";
  return `${repoName}-${featureSlug}${slotSuffix}`;
}

export function createWorktrees(
  projectDir: string,
  taskId: string,
  agents: Array<{ name: string }>,
  mainBranch: string = defaultMainBranch(projectDir),
  slot?: number,
  mode: "duo" | "pair" | "solo" | "pilot" = "duo",
): WorktreeSetup {
  // Refresh the project's main branch from origin so new worktrees fork from
  // current upstream rather than whatever the local checkout last pointed at.
  // Best-effort: any reason this can't proceed (no origin, wrong branch
  // checked out, dirty working tree, network failure, or local divergence) is
  // logged and skipped — see refreshMainBranchFromRemote for details.
  refreshMainBranchFromRemote(projectDir, mainBranch);

  const parentDir = dirname(resolve(projectDir));
  const repoName = basename(resolve(projectDir));
  const stem = orchWorktreeStem(repoName, taskId, slot);
  const rootWorktree = join(parentDir, stem);
  const peerSyncDir = peerSyncPath(rootWorktree);
  const branches: Record<string, string> = {
    root: orchBranchName(taskId, slot, "root"),
  };
  // Invariant (paired with scope (1) of `proposal-commit-on-main-and-worktree-resume`):
  // every per-agent and root branch is forked from `mainBranch` (resolved by
  // `defaultMainBranch(projectDir)` unless the caller passes a different
  // value). In duo mode the coder and reviewer never share a branch, so the
  // proposal commit reaches them only if it is already on `mainBranch` at
  // the moment `addWorktree` runs — which is what the worker-skill edits in
  // `skills/ludics-{draft,revise}-proposal-worker.md` step "Commit and push"
  // guarantee. Do not change the `mainBranch` argument here without also
  // re-validating that the worker still commits the proposal on the same
  // branch.
  addWorktree(projectDir, rootWorktree, branches.root, mainBranch);

  const agentWorktrees: Record<string, string> = {};
  if (mode === "pair" || mode === "solo" || mode === "pilot") {
    // Pair / solo / pilot: all agents share the root worktree and branch.
    // Solo and pilot have a single agent; pair has coder + reviewer sharing one worktree.
    for (const agent of agents) {
      branches[agent.name] = branches.root;
      agentWorktrees[agent.name] = rootWorktree;
    }
  } else {
    // Duo mode: each agent gets its own worktree and branch.
    // Each per-agent branch is forked from `mainBranch` (see invariant
    // comment on the root `addWorktree` call above).
    for (const agent of agents) {
      const path = join(parentDir, `${stem}-${slugify(agent.name)}`);
      const branch = orchBranchName(taskId, slot, slugify(agent.name));
      branches[agent.name] = branch;
      addWorktree(projectDir, path, branch, mainBranch);
      agentWorktrees[agent.name] = path;
    }
  }

  // Symlink node_modules from the project dir into worktrees so that
  // typecheck, tests, and tooling work without a separate install.
  const projectNodeModules = join(resolve(projectDir), "node_modules");
  if (existsSync(projectNodeModules)) {
    const uniquePaths = new Set([rootWorktree, ...Object.values(agentWorktrees)]);
    for (const wt of uniquePaths) {
      const target = join(wt, "node_modules");
      if (!existsSync(target)) {
        try { symlinkSync(projectNodeModules, target); } catch { /* ignore */ }
      }
    }
  }

  // Write .git/info/exclude so orchestration files are never committed,
  // even if agents run their own git add / git commit -a.
  ensureGitExcludes(resolve(projectDir));
  const allWorktrees = new Set([rootWorktree, ...Object.values(agentWorktrees)]);
  for (const wt of allWorktrees) {
    ensureGitExcludes(wt);
  }

  // Order is load-bearing (clear-then-set, set last): the clear `--unset-all`s
  // any stale/wrong gh-resolved value on BOTH origin and upstream; the seed
  // then re-installs the known-good `origin.gh-resolved=base` so a no-`--repo`
  // `gh pr create` resolves the PR base to origin (staging), not the fork
  // parent. See seedGhResolvedToOrigin for the full rationale.
  clearGhResolvedMarkers(resolve(projectDir));
  seedGhResolvedToOrigin(resolve(projectDir));

  // Best-effort: provision an `upstream` remote for fork projects (those whose
  // config carries `upstream_repo`). The config lookup MUST NOT throw —
  // `findProjectConfig` calls `loadConfigSync`, which throws when no config
  // file exists, and `createWorktrees` is otherwise config-independent (ad-hoc
  // test repos, local-only worktrees, and CI without a config file must all
  // still succeed). On any config-load failure we fall back to null and skip
  // upstream provisioning; the origin pin above always runs.
  let projectConfig: ProjectConfig | null = null;
  try {
    projectConfig = findProjectConfig(resolve(projectDir));
  } catch {
    projectConfig = null;
  }
  if (projectConfig?.upstream_repo) {
    ensureUpstreamRemote(resolve(projectDir), projectConfig.upstream_repo);
  }

  return { rootWorktree, peerSyncDir, agentWorktrees, branches };
}

/**
 * Defense-in-depth against `gh-resolved` poisoning: clear any
 * `remote.<name>.gh-resolved` markers on `origin` and `upstream` so that
 * `gh` CLI invocations inside worktrees can't be silently retargeted to the
 * wrong repository. Worktrees share `.git/config` with the parent repo, so a
 * single clear on the parent covers all worktrees.
 *
 * Best-effort: uses `safeSyncOutput`, which does not throw. If the config key
 * is absent, `git config --unset-all` exits non-zero and is silently ignored.
 *
 * Uses `--unset-all` (not `--unset`) so that if the key has multiple values
 * (from a prior `git config --add` or a hand-edited `.git/config`), every
 * value is removed. `--unset` would fail with exit code 5 on multi-valued
 * keys, and the failure would be silently swallowed by `safeSyncOutput`,
 * leaving the poisoning marker in place — defeating the hardening.
 */
export function clearGhResolvedMarkers(projectDir: string): void {
  for (const remote of ["origin", "upstream"]) {
    safeSyncOutput(
      ["git", "config", "--unset-all", `remote.${remote}.gh-resolved`],
      { cwd: projectDir },
    );
  }
}

/**
 * Pre-create defense (layer 2 of gh-staging-fork hardening, companion to PR
 * #554): pin `gh pr create`'s base-repo resolution to `origin` by writing
 * `remote.origin.gh-resolved=base` on the parent repo. Worktrees share
 * `.git/config` with the parent, so a single write covers all worktrees.
 *
 * `gh-resolved=base` on a remote means "this remote IS the base repo," so a
 * no-`--repo` `gh pr create` resolves the PR base to **origin**, overriding
 * gh's default of targeting the fork parent for a fork-of-upstream clone. This
 * fixes the `ahrefs/ocannl#458` class of bug: after {@link clearGhResolvedMarkers}
 * wipes any stored resolution, gh would otherwise fall back to its
 * parent-targeting default on a fork — re-creating the wrong-repo PR.
 *
 * MUST run AFTER {@link clearGhResolvedMarkers} (the clear `--unset-all`s both
 * origin and upstream; this re-installs ONLY the origin marker). Pinning is set
 * only on origin — an `upstream.gh-resolved=base` would say "upstream is the
 * base" and re-create the very bug we are preventing.
 *
 * Uses `--replace-all` so a pre-existing multi-valued key collapses to exactly
 * one `base` value even if this helper is ever called without the preceding
 * clear. Best-effort via `safeSyncOutput` (never throws), matching the
 * surrounding hardening helpers — local-only or unusual repos must not abort
 * orchestration startup.
 *
 * Gated on `remote.origin.url` being present (same guard as
 * {@link refreshMainBranchFromRemote}): writing `remote.origin.gh-resolved`
 * on a repo with no origin URL would CREATE a phantom `[remote "origin"]`
 * section, after which `git remote add origin <url>` fails with "remote origin
 * already exists" — blocking a later real-origin setup on local-only repos.
 * Skipping when origin has no URL loses nothing: `gh pr create` cannot target a
 * URL-less origin anyway, so there is no resolution to pin. In production the
 * project repo is a real clone, so origin.url is always present and the seed
 * always runs.
 *
 * Base-for-all-projects assumption: no currently configured project wants
 * orchestration PRs to land on the upstream parent it forked from. Fork
 * projects (ocannl-staging) want PRs on the staging fork; all others are
 * non-fork, where origin is already canonical and `=base` is what gh does
 * anyway (redundant, harmless). If a future project genuinely wants
 * upstream-targeted PRs, it must opt out deliberately (a per-project setting) —
 * otherwise this seed silently retargets its PRs to origin. Such a project must
 * surface as a deliberate opt-out rather than relying on gh's default fork
 * resolution.
 */
export function seedGhResolvedToOrigin(projectDir: string): void {
  const originUrl = safeSyncOutput(["git", "config", "--get", "remote.origin.url"], { cwd: projectDir });
  if (!originUrl.ok || originUrl.stdout.trim().length === 0) return;
  safeSyncOutput(
    ["git", "config", "--replace-all", "remote.origin.gh-resolved", "base"],
    { cwd: projectDir },
  );
}

/**
 * Idempotently provision an `upstream` remote on the parent repo for fork
 * projects (those whose config carries `upstream_repo`), so coders can pull
 * from upstream during the work phase without manual setup. Worktrees inherit
 * the parent's `.git/config`, so a single add covers all worktrees.
 *
 * No-op when `upstreamRepo` is blank or an `upstream` remote URL already exists
 * — an operator's existing `upstream` URL is never rewritten or duplicated.
 * Idempotency keys on `remote.upstream.url` (the URL), NOT a bare `git remote`
 * listing: a leftover `remote.upstream.gh-resolved` key with no URL must not
 * count as "remote exists."
 *
 * The upstream URL is minted in SSH form (`git@github.com:<owner>/<repo>.git`),
 * matching how state repos are cloned elsewhere (`src/init.ts`) and the current
 * OCANNL setup. Best-effort via `safeSyncOutput` (never throws) — a missing
 * upstream remote is a convenience gap, not a reason to abort worktree startup.
 * Safe alongside {@link seedGhResolvedToOrigin}: the origin pin keeps PR
 * resolution on origin regardless of the upstream remote's presence, and
 * {@link clearGhResolvedMarkers} has already wiped any `upstream.gh-resolved`.
 */
export function ensureUpstreamRemote(projectDir: string, upstreamRepo: string): void {
  if (!upstreamRepo) return;
  const existing = safeSyncOutput(
    ["git", "config", "--get", "remote.upstream.url"],
    { cwd: projectDir },
  );
  if (existing.ok && existing.stdout.trim().length > 0) return;
  const url = `git@github.com:${upstreamRepo}.git`;
  const added = safeSyncOutput(["git", "remote", "add", "upstream", url], { cwd: projectDir });
  if (!added.ok) {
    console.error(
      `ludics: failed to add upstream remote (${url}) in ${projectDir}: ${added.stderr || "unknown error"}`,
    );
  }
}

export function symlinkPeerSync(
  peerSyncDir: string,
  agentWorktrees: Record<string, string>,
): void {
  // Deduplicate: in pair mode all agents share the root worktree
  const uniquePaths = new Set(Object.values(agentWorktrees));
  for (const worktreePath of uniquePaths) {
    mkdirSync(worktreePath, { recursive: true });
    const linkPath = join(worktreePath, PEER_SYNC_DIRNAME);
    // If peerSyncDir is already inside this worktree, skip symlinking
    if (resolve(peerSyncDir).startsWith(resolve(worktreePath))) continue;
    try {
      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink() && readlinkSync(linkPath) === peerSyncDir) continue;
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      rmSync(linkPath, { recursive: true, force: true });
    }
    symlinkSync(peerSyncDir, linkPath);
  }
}

export function cleanupWorktrees(
  projectDir: string,
  taskId: string,
  agents: Array<{ name: string }>,
  slot?: number,
  mode: "duo" | "pair" | "solo" | "pilot" = "duo",
): void {
  const featureSlug = slugify(taskId);
  const parentDir = dirname(resolve(projectDir));
  const repoName = basename(resolve(projectDir));
  const stem = orchWorktreeStem(repoName, taskId, slot);
  const rootWorktree = join(parentDir, stem);
  const expectedPrefix = join(parentDir, `${repoName}-${featureSlug}`);
  if (!rootWorktree.startsWith(expectedPrefix)) {
    console.error(`ludics: refusing to remove worktree outside expected prefix: ${rootWorktree}`);
    return;
  }
  removeIfRegistered(projectDir, rootWorktree);
  if (mode === "duo") {
    for (const agent of agents) {
      const agentPath = join(parentDir, `${stem}-${slugify(agent.name)}`);
      if (!agentPath.startsWith(expectedPrefix)) {
        console.error(`ludics: refusing to remove worktree outside expected prefix: ${agentPath}`);
        continue;
      }
      removeIfRegistered(projectDir, agentPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-commit helpers
// ---------------------------------------------------------------------------

/** Pathspecs for unstaging orchestration-internal paths after `git add -A`.
 *  `.git/info/exclude` prevents untracked files from being staged, but if any
 *  orchestration path is already tracked, `git add -A` would still stage it.
 *  These pathspecs are passed to `git reset HEAD --` to defensively unstage them.
 *  Narrowed to the entries NOT already handled by the proactive untrack step in
 *  {@link ensureGitExcludes} — i.e. paths that projects may legitimately commit
 *  (`.claude`, `.agents`, `node_modules`, `_build_review*`), so we must not
 *  untrack them but still must keep them out of orchestration round commits.
 *  Glob entries are expanded to match both top-level and nested occurrences. */
const ORCHESTRATION_RESET_PATHS = GIT_EXCLUDE_ENTRIES
  .filter((e) => !(UNTRACK_PATHS as readonly string[]).includes(e))
  .flatMap((e) => (/[*?[]/.test(e) ? [e, `**/${e}`] : [e]));

export interface AutoCommitResult {
  /** Whether the worktree had eligible uncommitted changes. */
  dirty: boolean;
  /** Whether a commit was created. */
  committed: boolean;
  /** SHA of the created commit, if any. */
  commitSha?: string;
  /** Error message if something went wrong. */
  error?: string;
}

/**
 * Auto-commit any uncommitted changes in the given directory.
 * Relies on {@link ensureGitExcludes} having been called to set up
 * `.git/info/exclude` with orchestration-internal paths (handles untracked files).
 * Additionally unstages any already-tracked orchestration paths via
 * {@link ORCHESTRATION_RESET_PATHS} to prevent them from being committed.
 * Returns a structured result. Safe to call on clean worktrees (no-op).
 *
 * Do NOT add `:(exclude)` pathspecs to the `git add -A` call below — doing
 * so while the same pattern is in `.git/info/exclude` causes git to exit 1
 * when the excluded directory exists, which `runGit` then throws. See
 * `docs/testing-patterns.md` § "Orchestration Worktree Exclusions".
 */
export function autoCommitWorktree(
  worktreePath: string,
  commitMessage: string,
): AutoCommitResult {
  // Use runGit (throws on failure) in try/catch so we can distinguish
  // "clean tree" from "git command failed". maybeGit collapses both to "".
  let status: string;
  try {
    status = runGit(worktreePath, ["status", "--porcelain"]);
  } catch (err) {
    return { dirty: false, committed: false, error: `status check failed: ${err}` };
  }

  if (!status) return { dirty: false, committed: false }; // clean tree

  try {
    runGit(worktreePath, ["add", "-A"]);
    // Defensive: unstage orchestration-internal paths in case any are tracked.
    maybeGit(worktreePath, ["reset", "HEAD", "--", ...ORCHESTRATION_RESET_PATHS]);
    // Re-check: if only orchestration files changed, nothing remains staged.
    const staged = maybeGit(worktreePath, ["diff", "--cached", "--name-only"]);
    if (!staged) return { dirty: false, committed: false };
    runGit(worktreePath, ["commit", "-m", commitMessage]);
    const sha = maybeGit(worktreePath, ["rev-parse", "--short", "HEAD"]);
    return { dirty: true, committed: true, commitSha: sha || undefined };
  } catch (err) {
    return { dirty: true, committed: false, error: String(err) };
  }
}

/**
 * Push the current branch, setting upstream tracking if needed.
 * Freshly-created worktree branches may not have an upstream, so
 * we use `git push -u origin <branch>`.
 */
export function pushBranch(worktreePath: string, branch: string): void {
  runGit(worktreePath, ["push", "-u", "origin", branch]);
}
