// Once-per-day autonomous staging-fork fast-forward from upstream.
//
// For each project with `upstream_repo`, attempts a fast-forward-only merge
// from `upstream/<default>` into the staging fork's default branch on the
// canonical project checkout. Never pushes, never creates branches or PRs,
// never operates inside slot worktrees, and aborts if the working tree is
// dirty. Throttled per-project via a sentinel file so each project runs at
// most once every 24 hours.

import { existsSync, statSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { detectDefaultBranches, type RunGit } from "./briefing-lag.ts";
import type { ProjectConfig } from "./config.ts";

export type FastForwardOutcome =
  | "throttled"
  | "skipped-no-path"
  | "skipped-no-upstream-remote"
  | "skipped-no-default-branch"
  | "skipped-dirty-worktree"
  | "already-up-to-date"
  | "fast-forwarded"
  | "diverged"
  | "error";

export interface FastForwardProjectResult {
  project: string;
  outcome: FastForwardOutcome;
  detail?: string;
  advancedBy?: number;
}

export interface FastForwardOptions {
  now: Date;
  runGit: RunGit;
  /** Directory holding per-project sentinels. */
  sentinelDir: string;
  /** Throttle window in seconds. Default 24h. */
  throttleSeconds?: number;
  /** Callback for emitting events (decoupled from ./events.ts to keep this module pure). */
  emitEvent?: (ev: { type: string; project: string; message: string }) => void;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return path;
}

function sentinelFile(dir: string, project: string): string {
  return join(dir, `last-fast-forward-${project}.epoch`);
}

function sentinelFresh(file: string, now: Date, windowSec: number): boolean {
  if (!existsSync(file)) return false;
  try {
    const mtime = statSync(file).mtimeMs;
    const ageSec = (now.getTime() - mtime) / 1000;
    return ageSec < windowSec;
  } catch {
    return false;
  }
}

function touchSentinel(file: string, now: Date): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
  } catch {}
  try {
    writeFileSync(file, String(Math.floor(now.getTime() / 1000)));
    utimesSync(file, now, now);
  } catch {}
}

function hasRemote(cwd: string, name: string, runGit: RunGit): boolean {
  const r = runGit(["remote"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(name);
}

function worktreeClean(cwd: string, runGit: RunGit): boolean {
  const r = runGit(["status", "--porcelain"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.trim() === "";
}

function currentBranch(cwd: string, runGit: RunGit): string | null {
  const r = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (r.exitCode !== 0) return null;
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : null;
}

function commitCount(cwd: string, range: string, runGit: RunGit): number | null {
  const r = runGit(["rev-list", "--count", range], cwd);
  if (r.exitCode !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Fast-forward the staging checkout's default branch from upstream/<default>.
 * Returns an outcome describing what happened; callers can treat everything
 * except `fast-forwarded` / `already-up-to-date` / `throttled` as diagnostic.
 */
export function maybeFastForwardStagingFromUpstream(
  projects: ProjectConfig[],
  opts: FastForwardOptions,
): FastForwardProjectResult[] {
  const throttle = opts.throttleSeconds ?? 24 * 3600;
  const out: FastForwardProjectResult[] = [];
  for (const p of projects) {
    if (!p.upstream_repo) continue;
    const project = p.name || p.repo || "(unnamed)";

    const sentinel = sentinelFile(opts.sentinelDir, project);
    if (sentinelFresh(sentinel, opts.now, throttle)) {
      out.push({ project, outcome: "throttled" });
      continue;
    }

    const path = p.path ? expandHome(String(p.path)) : null;
    if (!path || !existsSync(path)) {
      out.push({ project, outcome: "skipped-no-path", detail: p.path ?? undefined });
      continue;
    }
    if (!hasRemote(path, "upstream", opts.runGit)) {
      out.push({ project, outcome: "skipped-no-upstream-remote" });
      continue;
    }

    // Fetch upstream (best-effort; failures are non-fatal but abort the FF).
    const fetched = opts.runGit(["fetch", "upstream", "--quiet"], path);
    if (fetched.exitCode !== 0) {
      out.push({ project, outcome: "error", detail: `fetch failed: ${fetched.stdout.trim().slice(0, 200)}` });
      opts.emitEvent?.({
        type: "staging_fast_forward_error",
        project,
        message: `fetch upstream failed for ${project}`,
      });
      // Touch the sentinel so we don't spam every keepalive tick on persistent failure.
      touchSentinel(sentinel, opts.now);
      continue;
    }

    const branches = detectDefaultBranches(path, opts.runGit);
    if (!branches.origin || !branches.upstream) {
      out.push({ project, outcome: "skipped-no-default-branch" });
      touchSentinel(sentinel, opts.now);
      continue;
    }

    if (!worktreeClean(path, opts.runGit)) {
      out.push({ project, outcome: "skipped-dirty-worktree" });
      // Don't touch the sentinel — dirty tree is a transient user-controlled
      // state; we want the job to try again on the next tick after the user
      // commits/stashes.
      continue;
    }

    const priorBranch = currentBranch(path, opts.runGit);
    const needCheckout = priorBranch !== null && priorBranch !== branches.origin;
    if (needCheckout) {
      const co = opts.runGit(["checkout", branches.origin], path);
      if (co.exitCode !== 0) {
        out.push({ project, outcome: "error", detail: `checkout failed: ${co.stdout.trim().slice(0, 200)}` });
        touchSentinel(sentinel, opts.now);
        continue;
      }
    }

    try {
      const merge = opts.runGit(
        ["merge", "--ff-only", `upstream/${branches.upstream}`],
        path,
      );
      if (merge.exitCode === 0) {
        // Count commits the branch advanced by (may be 0 if already up-to-date).
        const advancedBy = commitCount(
          path,
          `origin/${branches.origin}..upstream/${branches.upstream}`,
          opts.runGit,
        ) ?? 0;
        // `origin/<default>..upstream/<default>` after FF is always 0. Instead
        // measure progress via `HEAD@{1}..HEAD` would require reflog; for the
        // sake of simplicity and test-friendliness, infer from the "Already up
        // to date." vs advancing output of the merge subprocess.
        const up2date = /up[\- ]to[\- ]date/i.test(merge.stdout);
        const outcome: FastForwardOutcome = up2date ? "already-up-to-date" : "fast-forwarded";
        out.push({ project, outcome, advancedBy });
        touchSentinel(sentinel, opts.now);
        if (outcome === "fast-forwarded") {
          opts.emitEvent?.({
            type: "staging_fast_forwarded",
            project,
            message: `${project}: staging fast-forwarded from upstream/${branches.upstream}`,
          });
        }
      } else {
        out.push({ project, outcome: "diverged", detail: merge.stdout.trim().slice(0, 200) });
        opts.emitEvent?.({
          type: "staging_fast_forward_diverged",
          project,
          message: `${project}: staging and upstream have diverged — manual reconciliation needed`,
        });
        touchSentinel(sentinel, opts.now);
      }
    } finally {
      if (needCheckout && priorBranch) {
        opts.runGit(["checkout", priorBranch], path);
      }
    }
  }
  return out;
}
