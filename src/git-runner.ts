// Injectable git runner + remote/branch helpers shared across briefing-lag
// and staging-ff (and any future module that needs to shell out to git). All
// subprocess calls go through the injected `RunGit` callable so tests can
// inject a fake; the production `defaultRunGit` routes through
// `safeSyncOutput` per the spawn.ts policy.

import { resolve } from "path";
import { safeSyncOutput } from "./spawn.ts";

export interface RunGitResult {
  stdout: string;
  /**
   * stderr from the spawn. Optional so existing fake runners that
   * return only { stdout, exitCode } keep compiling. Production
   * runners (defaultRunGit) populate this; gh-ludics-540's outbound
   * push classifier consumes it to distinguish auth failures from
   * transient network errors.
   */
  stderr?: string;
  exitCode: number;
}

/** A minimal git runner: takes argv and a cwd, returns stdout + exit code (and optional stderr). */
export type RunGit = (args: string[], cwd: string) => RunGitResult;

export interface DetectedBranches {
  origin: string | null;
  upstream: string | null;
}

/**
 * Resolve `~/`-prefixed and bare paths to absolute, normalized form.
 *
 * `~/foo` → `resolve($HOME, "foo")`; everything else → `resolve(raw)`.
 * `resolve` collapses `..` segments and trailing slashes, and turns relative
 * inputs into absolute paths anchored at the current working directory. This
 * subsumes the `expandHomePath` helper that previously lived in
 * `sessions/sweep-state.ts`, whose downstream consumers required absolute
 * paths.
 */
export function expandHome(raw: string): string {
  if (raw.startsWith("~/")) return resolve(process.env.HOME ?? "~", raw.slice(2));
  return resolve(raw);
}

export function hasRemote(cwd: string, name: string, runGit: RunGit): boolean {
  const r = runGit(["remote"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(name);
}

/** Options for {@link detectDefaultBranches}. */
export interface DetectDefaultBranchesOptions {
  /**
   * When true, insert an `ls-remote --symref <remote> HEAD` network tier
   * between the local symbolic-ref tier and the `main`/`master` probe tier.
   * Performs up to N network round-trips — one `ls-remote --symref` per
   * remote queried, i.e. 2 for the `{ origin, upstream }` pair when both
   * remotes exist. Intended for callers that have just warmed network
   * connectivity (e.g. after `git fetch <remote>`), so the round-trip is
   * cheap.
   *
   * Default `false` — fully local, no network I/O.
   *
   * The `IO` suffix in the option name is load-bearing: it surfaces the
   * network contract at call sites without requiring readers to consult
   * JSDoc. `{ authoritativeIO: true }` reads as "this path performs
   * network I/O" at a glance — preserving the lexical-signal property
   * that a separate `…Authoritative` export name used to provide.
   */
  authoritativeIO?: boolean;
}

/**
 * Detect the default branch *name* for each of origin and upstream.
 *
 * **Returns names, not refs.** A bare `"main"` is the branch name; using
 * it as `git log main..HEAD` compares against the *local* `main`, which in
 * worktrees already contains the branch's commits and silently yields zero
 * output. For a ready-to-use comparison base, prefer
 * {@link resolveBaseRef}.
 *
 * @example
 * // WRONG — `main` is interpreted as the local branch:
 * //   git log main..HEAD            // silently empty in worktrees
 * // RIGHT — qualify with the remote:
 * //   const { origin } = detectDefaultBranches(cwd, runGit);
 * //   if (origin) runGit(["log", `origin/${origin}..HEAD`], cwd);
 * // BETTER — use the helper that returns a ready-to-use ref:
 * //   const base = resolveBaseRef(cwd, runGit);
 * //   if (base) runGit(["log", `${base}..HEAD`], cwd);
 *
 * Tier ordering per remote (each tier short-circuits on success):
 *  1. `git symbolic-ref refs/remotes/<remote>/HEAD` — present when the repo
 *     was cloned or `git remote set-head <remote> -a` has been run.
 *  2. (only when `opts.authoritativeIO === true`) `git ls-remote --symref
 *     <remote> HEAD` — network round-trip; parses `ref: refs/heads/<n>
 *     HEAD` from stdout. Used by callers that already warmed the network
 *     (e.g. immediately after `git fetch`) to detect non-`main`/`master`
 *     defaults like `develop` or `trunk`.
 *  3. `git rev-parse --verify --quiet refs/remotes/<remote>/{main,master}`
 *     — covers manually-added remotes that lack `refs/remotes/<r>/HEAD`.
 *  4. `null`.
 */
export function detectDefaultBranches(
  cwd: string,
  runGit: RunGit,
  opts: DetectDefaultBranchesOptions = {},
): DetectedBranches {
  const authoritativeIO = opts.authoritativeIO === true;
  const read = (remote: string): string | null => {
    const primary = runGit(["symbolic-ref", `refs/remotes/${remote}/HEAD`], cwd);
    if (primary.exitCode === 0) {
      const line = primary.stdout.trim();
      const prefix = `refs/remotes/${remote}/`;
      if (line.startsWith(prefix)) {
        const name = line.slice(prefix.length);
        if (name) return name;
      }
    }
    if (authoritativeIO) {
      const symref = runGit(["ls-remote", "--symref", remote, "HEAD"], cwd);
      if (symref.exitCode === 0) {
        // Expected line: `ref: refs/heads/<branch>\tHEAD` (whitespace may
        // be a tab or spaces depending on git version).
        const m = symref.stdout.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD\b/m);
        if (m && m[1]) return m[1];
      }
    }
    for (const candidate of ["main", "master"]) {
      const verify = runGit(
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`],
        cwd,
      );
      if (verify.exitCode === 0 && verify.stdout.trim() !== "") return candidate;
    }
    return null;
  };
  return { origin: read("origin"), upstream: read("upstream") };
}

/**
 * Resolve a ready-to-use comparison base (a git ref) for `git log
 * <base>..HEAD`, `git diff <base>...HEAD`, and similar invocations.
 *
 * Cascade (first non-null wins):
 *  1. If `detectDefaultBranches(cwd, runGit).origin` is non-null, return
 *     `origin/<that-name>`.
 *  2. Else if `.upstream` is non-null, return `upstream/<that-name>`.
 *  3. Else, for each candidate in `["main", "master"]`, probe
 *     `git rev-parse --verify --quiet refs/heads/<candidate>`; on the
 *     first non-empty success return the bare name.
 *  4. Else `null`.
 *
 * Prefer this over {@link detectDefaultBranches} when a single comparison
 * base is wanted. `detectDefaultBranches` returns branch *names*, so
 * passing them straight into `git log <name>..HEAD` compares against the
 * *local* branch — which in worktrees already contains the branch's
 * commits and silently yields zero output. `resolveBaseRef`'s return value
 * is always remote-qualified (or a verified local fallback), so this
 * footgun cannot fire.
 *
 * Local-only: no network round-trip. Each call performs at most a small
 * handful of `git` invocations; no caching is performed.
 */
export function resolveBaseRef(cwd: string, runGit: RunGit): string | null {
  const detected = detectDefaultBranches(cwd, runGit);
  if (detected.origin) return `origin/${detected.origin}`;
  if (detected.upstream) return `upstream/${detected.upstream}`;
  for (const candidate of ["main", "master"]) {
    const verify = runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
      cwd,
    );
    if (verify.exitCode === 0 && verify.stdout.trim() !== "") return candidate;
  }
  return null;
}

/**
 * Run `fn` with `targetBranch` checked out, restoring the prior branch (or
 * detached-HEAD SHA) afterwards. If the current branch is already
 * `targetBranch`, the checkout and the restore are both skipped.
 *
 * On checkout failure (entering), throws with the git error message. The
 * callback's exceptions propagate after the restore runs in `finally`.
 *
 * Contract: `fn` must leave the worktree in a state where checkout-back
 * will succeed. A `git merge --ff-only` satisfies this (never dirties the
 * tree); arbitrary callback behaviour does not. The restore is best-effort
 * — callers that need guaranteed restore must keep the tree clean.
 *
 * Synchronous only: `fn` must not return a Promise. The finally block runs
 * as soon as `fn()` returns, so for an async callback the branch restore
 * would fire before the awaited git work settled — the awaited commands
 * would then execute on the wrong branch. The conditional-type constraint
 * on `fn` makes the misuse un-compilable: `T` must not extend `PromiseLike`,
 * so an `async` callback or one returning a `Promise` fails to typecheck.
 * If you need async, build a dedicated `withCheckoutAsync` that awaits
 * before restoring.
 */
export function withCheckout<T>(
  cwd: string,
  targetBranch: string,
  runGit: RunGit,
  fn: () => T extends PromiseLike<unknown> ? never : T,
): T {
  const abbrev = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const rawName = abbrev.exitCode === 0 ? abbrev.stdout.trim() : "";
  const priorBranch = rawName && rawName !== "HEAD" ? rawName : null;
  const priorHeadSha = priorBranch === null ? (() => {
    const r = runGit(["rev-parse", "HEAD"], cwd);
    return r.exitCode === 0 ? r.stdout.trim() : null;
  })() : null;

  if (priorBranch === targetBranch) {
    return fn() as T;
  }

  const co = runGit(["checkout", targetBranch], cwd);
  if (co.exitCode !== 0) {
    throw new Error(`checkout ${targetBranch} failed: ${co.stdout.trim().slice(0, 200)}`);
  }
  try {
    return fn() as T;
  } finally {
    if (priorBranch) {
      runGit(["checkout", priorBranch], cwd);
    } else if (priorHeadSha) {
      runGit(["checkout", "--detach", priorHeadSha], cwd);
    }
  }
}

/**
 * Production git runner — wraps Bun.spawnSync via safeSyncOutput so this
 * call path complies with spawn.ts's policy. Preserves the historic
 * RunGitResult shape: untrimmed stdout + exit code (so callers that
 * fingerprint output with their own trim/regex logic keep working).
 */
export const defaultRunGit: RunGit = (args, cwd) => {
  const res = safeSyncOutput(["git", "-C", cwd, ...args], { trim: false });
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
};
