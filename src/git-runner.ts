// Injectable git runner + remote/branch helpers shared across briefing-lag
// and staging-ff (and any future module that needs to shell out to git). All
// subprocess calls go through the injected `RunGit` callable so tests can
// inject a fake; the production `defaultRunGit` routes through
// `safeSyncOutput` per the spawn.ts policy.

import { join } from "path";
import { safeSyncOutput } from "./spawn.ts";

export interface RunGitResult {
  stdout: string;
  exitCode: number;
}

/** A minimal git runner: takes argv and a cwd, returns stdout + exit code. */
export type RunGit = (args: string[], cwd: string) => RunGitResult;

export interface DetectedBranches {
  origin: string | null;
  upstream: string | null;
}

export function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return path;
}

export function hasRemote(cwd: string, name: string, runGit: RunGit): boolean {
  const r = runGit(["remote"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(name);
}

/**
 * Detect the default branch name for each of origin and upstream.
 *
 * Local-only: no network round-trip. Used by the briefing path where any
 * added latency would compound on every tick.
 *
 * Primary path: `git symbolic-ref refs/remotes/<remote>/HEAD`. This ref
 * exists when the repo was cloned (git creates it automatically) or when
 * the user has explicitly run `git remote set-head <remote> -a`.
 *
 * Fallback: for manually-added remotes (`git remote add upstream … && git
 * fetch upstream`), git does NOT create `refs/remotes/upstream/HEAD`, so
 * the primary path returns null. Probe the two overwhelmingly common
 * default branches — `main` then `master` — via `git rev-parse --verify`.
 *
 * If neither the symbolic ref nor a `main`/`master` ref is present, return
 * null.
 */
export function detectDefaultBranches(cwd: string, runGit: RunGit): DetectedBranches {
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
 * Detect the default branch name with an authoritative `ls-remote --symref`
 * tier that queries the remote directly. Intended for paths that have
 * already established network connectivity (e.g. `git fetch <remote>` moments
 * earlier), so the ls-remote round-trip is cheap.
 *
 * Tier ordering per remote: symbolic-ref (local) → ls-remote --symref
 * (network) → main/master probe (local) → null. Each tier short-circuits
 * on success.
 */
export function detectDefaultBranchesAuthoritative(
  cwd: string,
  runGit: RunGit,
): DetectedBranches {
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
    const symref = runGit(["ls-remote", "--symref", remote, "HEAD"], cwd);
    if (symref.exitCode === 0) {
      // Expected line: `ref: refs/heads/<branch>\tHEAD` (whitespace may be
      // a tab or spaces depending on git version).
      const m = symref.stdout.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD\b/m);
      if (m && m[1]) return m[1];
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
 */
export function withCheckout<T>(
  cwd: string,
  targetBranch: string,
  runGit: RunGit,
  fn: () => T,
): T {
  const abbrev = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const rawName = abbrev.exitCode === 0 ? abbrev.stdout.trim() : "";
  const priorBranch = rawName && rawName !== "HEAD" ? rawName : null;
  const priorHeadSha = priorBranch === null ? (() => {
    const r = runGit(["rev-parse", "HEAD"], cwd);
    return r.exitCode === 0 ? r.stdout.trim() : null;
  })() : null;

  if (priorBranch === targetBranch) return fn();

  const co = runGit(["checkout", targetBranch], cwd);
  if (co.exitCode !== 0) {
    throw new Error(`checkout ${targetBranch} failed: ${co.stdout.trim().slice(0, 200)}`);
  }
  try {
    return fn();
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
  return { stdout: res.stdout, exitCode: res.exitCode };
};
