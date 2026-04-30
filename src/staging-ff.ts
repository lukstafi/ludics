// Once-per-day autonomous staging-fork fast-forward from upstream.
//
// For each project with `upstream_repo`, attempts a fast-forward-only merge
// from `upstream/<default>` into the staging fork's default branch on the
// canonical project checkout. Never pushes, never creates branches or PRs,
// never operates inside slot worktrees, and aborts if the working tree is
// dirty. Throttled per-project via a sentinel file so each project runs at
// most once every 24 hours.

import { existsSync } from "fs";
import { join } from "path";
import {
  detectDefaultBranches,
  expandHome,
  hasRemote,
  withCheckout,
  type RunGit,
} from "./git-runner.ts";
import { sentinelFresh, touchSentinel } from "./sentinel.ts";
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

function sentinelFile(dir: string, project: string): string {
  return join(dir, `last-fast-forward-${project}.epoch`);
}

function worktreeClean(cwd: string, runGit: RunGit): boolean {
  const r = runGit(["status", "--porcelain"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.trim() === "";
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
export function syncStagingMainWithUpstream(
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

    // After `git fetch upstream` above, network connectivity + credentials
    // are warm — opt into the `ls-remote --symref` tier so non-main/master
    // defaults (e.g. `develop`, `trunk`) are detected correctly.
    const branches = detectDefaultBranches(path, opts.runGit, { authoritativeIO: true });
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

    // Always target `branches.origin` for the merge, even on detached HEAD.
    // withCheckout() handles the prior-branch / detached-HEAD-SHA capture and
    // restore; it throws on checkout failure, which we classify as `error`.
    try {
      withCheckout(path, branches.origin, opts.runGit, () => {
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
          const up2date = /up[- ]to[- ]date/i.test(merge.stdout);
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
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      out.push({ project, outcome: "error", detail: detail.slice(0, 200) });
      touchSentinel(sentinel, opts.now);
    }
  }
  return out;
}
