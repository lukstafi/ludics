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
import { parseLeftRightCount } from "./briefing-lag.ts";
import { OUTBOUND_EVENT_CAUSE_REMEDY } from "./staging-event-meta.ts";
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
  /** Callback for emitting events (decoupled from ./events.ts to keep this module pure).
   *
   *  `extra` carries structured payload fields the caller should forward
   *  verbatim into the harness event record (e.g. `divergedBy` on
   *  `staging_outbound_fast_forward_diverged`). Per AC 4, these extra
   *  fields are part of the event payload contract, not just the
   *  human-readable `message`. The Mag wrapper in `runStagingOutboundPushTick`
   *  spreads `extra` into the `emitEvent` call from `./events.ts`,
   *  whose `LudicsEvent` shape already allows arbitrary string-keyed
   *  payload (`[key: string]: unknown`). */
  emitEvent?: (ev: { type: string; project: string; message: string; extra?: Record<string, unknown> }) => void;
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

// =============================================================================
// gh-ludics-540: outbound staging→upstream fast-forward push.
//
// Mirror of the inbound flow above. For each project with
// `upstream_repo` AND `outbound_sync_enabled: true`, the keepalive tick
// pushes `origin/<default>` to `upstream/<default>` when origin is
// strictly ahead. Fast-forward-only by construction:
//   - client-side: `git merge-base --is-ancestor upstream/<u> origin/<o>` pre-check
//   - server-side: git rejects non-ff refspec pushes by default
// We never pass `--force` / `--force-with-lease` / `+refspec`.
//
// Note on `--ff-only`: git 2.50.1 (Apple Git-155) does not accept that
// flag on `git push` (the flag exists only on `git merge`/`git pull`).
// The two guards above are the implementable equivalent of AC 5's
// literal flag — the proposal's intent ("strict fast-forward") is
// preserved.
// =============================================================================

export type OutboundPushOutcome =
  | "throttled"
  | "skipped-no-path"
  | "skipped-no-upstream-remote"
  | "skipped-no-default-branch"
  | "skipped-dirty-worktree"
  | "skipped-no-staging-commits"
  | "skipped-not-fast-forward"
  | "skipped-no-push-credentials"
  | "skipped-no-workflow-scope"
  | "skipped-local-staging-behind"
  | "pushed"
  | "error";

export interface OutboundPushProjectResult {
  project: string;
  outcome: OutboundPushOutcome;
  detail?: string;
  /** Commits the upstream ref advanced by on a successful push. */
  advancedBy?: number;
  /** Upstream-side commits not in origin, on `skipped-not-fast-forward`. */
  divergedBy?: number;
}

/** Same shape as the inbound options; aliased for documentation clarity. */
export type OutboundPushOptions = FastForwardOptions;

export function outboundSentinelFile(dir: string, project: string): string {
  return join(dir, `last-outbound-fast-forward-${project}.epoch`);
}

/**
 * Classify a `git push` (or `git fetch`) failure by inspecting stdout
 * and stderr. Auth gaps must surface fast via the stale-sentinel
 * channel; transient network errors should touch the sentinel (same
 * policy as the inbound `error` branch) to avoid keepalive-tick spam.
 */
export function classifyPushFailure(
  stdout: string,
  stderr?: string,
): "workflow-scope" | "credentials" | "network" | "other" {
  const blob = `${stdout}\n${stderr ?? ""}`.toLowerCase();
  // Workflow-scope rejection MUST be checked before credentials: GitHub's
  // refusal is technically a 403/permission event and could partially match
  // the credentials regex below, but this class is more specific and more
  // actionable (the remedy is `gh auth refresh -s workflow`, not a full
  // credential reset). The literal is:
  //   ! [remote rejected] origin/master -> master (refusing to allow an
  //   OAuth App to create or update workflow `…` without `workflow` scope)
  // Lowercasing handles case; the char class tolerates ASCII single-quote vs
  // backtick around `workflow`; `create or update workflow` is a
  // quote-agnostic anchor that also covers the fine-grained-PAT phrasing.
  // The bare word `workflow` alone is deliberately NOT matched (too broad —
  // a generic remote hook failure mentioning "workflow" must stay `other`).
  if (/create or update workflow|without ['`]?workflow['`]? scope/.test(blob)) {
    return "workflow-scope";
  }
  // Credentials patterns. The first three are the AC-named SSH /
  // HTTPS-credential shapes. The remaining four catch GitHub's
  // 403/401 push-denial shapes — which would otherwise fall through to
  // the `unable to access` clause of the network classifier below and
  // suppress the stale-sentinel signal:
  //   remote: Permission to <repo>.git denied to <user>.
  //   fatal: unable to access '<url>': The requested URL returned error: 403
  //   remote: Write access to repository not granted.
  // The check runs before the network classifier so a stderr blob
  // that matches BOTH (typical GitHub 403 — two-line stderr) is
  // classified as credentials.
  if (
    /permission denied|could not read username|authentication failed|permission to .*denied|\berror: 40[13]\b|write access (to repository )?not granted/.test(blob)
  ) {
    return "credentials";
  }
  if (/could not resolve|network is unreachable|timed out|connection refused|temporary failure|unable to access/.test(blob)) {
    return "network";
  }
  return "other";
}

/**
 * Fast-forward upstream from the staging fork's default branch.
 * Mirror of `syncStagingMainWithUpstream` with the three deltas
 * documented at the top of this section. Callers filter `projects` so
 * only opt-in entries reach this function.
 */
export function syncUpstreamMainFromStaging(
  projects: ProjectConfig[],
  opts: OutboundPushOptions,
): OutboundPushProjectResult[] {
  const throttle = opts.throttleSeconds ?? 24 * 3600;
  const out: OutboundPushProjectResult[] = [];
  for (const p of projects) {
    if (!p.upstream_repo) continue;
    const project = p.name || p.repo || "(unnamed)";

    const sentinel = outboundSentinelFile(opts.sentinelDir, project);
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

    // Fetch upstream (read-only — credentials shape is rare but route
    // through the classifier anyway so auth gaps surface via stale
    // sentinel rather than as transient).
    const fetchedUpstream = opts.runGit(["fetch", "upstream", "--quiet"], path);
    if (fetchedUpstream.exitCode !== 0) {
      const kind = classifyPushFailure(fetchedUpstream.stdout, fetchedUpstream.stderr);
      if (kind === "credentials") {
        out.push({
          project,
          outcome: "skipped-no-push-credentials",
          detail: `fetch upstream: ${(fetchedUpstream.stderr ?? fetchedUpstream.stdout).trim().slice(0, 200)}`,
        });
        opts.emitEvent?.({
          type: "staging_outbound_credentials_missing",
          project,
          message: `${project}: outbound fetch upstream failed (credentials)`,
        });
        // NO sentinel touch — health-check stale-sentinel signal must fire.
      } else {
        out.push({
          project,
          outcome: "error",
          detail: `fetch upstream: ${(fetchedUpstream.stderr ?? fetchedUpstream.stdout).trim().slice(0, 200)}`,
        });
        opts.emitEvent?.({
          type: "staging_outbound_error",
          project,
          message: `${project}: outbound fetch upstream failed`,
        });
        touchSentinel(sentinel, opts.now);
      }
      continue;
    }

    const branches = detectDefaultBranches(path, opts.runGit, { authoritativeIO: true });
    if (!branches.origin || !branches.upstream) {
      out.push({ project, outcome: "skipped-no-default-branch" });
      touchSentinel(sentinel, opts.now);
      continue;
    }

    if (!worktreeClean(path, opts.runGit)) {
      out.push({ project, outcome: "skipped-dirty-worktree" });
      // No sentinel touch — same policy as inbound (transient user state).
      continue;
    }

    try {
      withCheckout(path, branches.origin, opts.runGit, () => {
        // (A) Pull-before-push: fetch origin <branches.origin>. Workers
        // may have pushed commits to origin since the controller's last
        // checkout; without this, the push would silently drop their
        // commits or fail when the local branch is behind.
        const fetchOrigin = opts.runGit(
          ["fetch", "origin", branches.origin!, "--quiet"],
          path,
        );
        if (fetchOrigin.exitCode !== 0) {
          const kind = classifyPushFailure(fetchOrigin.stdout, fetchOrigin.stderr);
          if (kind === "credentials") {
            out.push({
              project,
              outcome: "skipped-no-push-credentials",
              detail: `fetch origin: ${(fetchOrigin.stderr ?? fetchOrigin.stdout).trim().slice(0, 200)}`,
            });
            opts.emitEvent?.({
              type: "staging_outbound_credentials_missing",
              project,
              message: `${project}: outbound fetch origin failed (credentials)`,
            });
            // NO sentinel touch.
          } else {
            out.push({
              project,
              outcome: "error",
              detail: `fetch origin: ${(fetchOrigin.stderr ?? fetchOrigin.stdout).trim().slice(0, 200)}`,
            });
            opts.emitEvent?.({
              type: "staging_outbound_error",
              project,
              message: `${project}: outbound fetch origin failed`,
            });
            touchSentinel(sentinel, opts.now);
          }
          return;
        }

        // (B) Local fast-forward of <branches.origin> to origin/<branches.origin>.
        // Failure here means worker pushed a non-ff to origin (or some
        // other local-state issue); classify as local-behind and let
        // the stale sentinel surface the gap.
        const localMerge = opts.runGit(
          ["merge", "--ff-only", `origin/${branches.origin!}`],
          path,
        );
        if (localMerge.exitCode !== 0) {
          out.push({
            project,
            outcome: "skipped-local-staging-behind",
            detail: `local ff: ${(localMerge.stderr ?? localMerge.stdout).trim().slice(0, 200)}`,
          });
          opts.emitEvent?.({
            type: "staging_outbound_local_behind",
            project,
            message: `${project}: local checkout cannot fast-forward to origin/${branches.origin}`,
          });
          // NO sentinel touch.
          return;
        }

        // (C) Staging-only commits count via fetched refs.
        const stagingAheadRaw = opts.runGit(
          [
            "rev-list", "--count",
            `upstream/${branches.upstream}..origin/${branches.origin}`,
          ],
          path,
        );
        const stagingAhead = stagingAheadRaw.exitCode === 0
          ? (Number.isFinite(Number(stagingAheadRaw.stdout.trim())) ? Number(stagingAheadRaw.stdout.trim()) : null)
          : null;
        if (stagingAhead === 0) {
          out.push({ project, outcome: "skipped-no-staging-commits" });
          // Touch sentinel — tick completed successfully, no point
          // recomputing ancestry every keepalive.
          touchSentinel(sentinel, opts.now);
          return;
        }

        // (D) Ancestry pre-check. Non-zero exit means upstream has
        // commits not in origin — a non-ff push would be required.
        const ancestry = opts.runGit(
          [
            "merge-base", "--is-ancestor",
            `upstream/${branches.upstream}`, `origin/${branches.origin}`,
          ],
          path,
        );
        if (ancestry.exitCode !== 0) {
          const lr = opts.runGit(
            [
              "rev-list", "--left-right", "--count",
              `upstream/${branches.upstream}...origin/${branches.origin}`,
            ],
            path,
          );
          const parsed = lr.exitCode === 0 ? parseLeftRightCount(lr.stdout) : null;
          out.push({
            project,
            outcome: "skipped-not-fast-forward",
            detail: parsed
              ? `upstream has ${parsed.behind} commits not in staging`
              : undefined,
            divergedBy: parsed?.behind,
          });
          // AC 4: the divergence count must be in the event PAYLOAD,
          // not just the formatted message. `extra` is forwarded
          // verbatim by `runStagingOutboundPushTick` into LudicsEvent's
          // open-shape `[key: string]: unknown` slot.
          opts.emitEvent?.({
            type: "staging_outbound_fast_forward_diverged",
            project,
            message: parsed
              ? `${project}: upstream has ${parsed.behind} commits not in staging — manual reconciliation needed`
              : `${project}: upstream not an ancestor of staging — manual reconciliation needed`,
            extra: parsed
              ? { divergedBy: parsed.behind, aheadBy: parsed.ahead }
              : { divergedBy: undefined },
          });
          // NO sentinel touch — divergence must stay visible to next tick + briefing-lag.
          return;
        }

        // (E) Push. No --ff-only flag (unsupported in git 2.50.1); the
        // client-side ancestry pre-check above plus git's server-side
        // non-ff rejection are the fast-forward guard.
        const pushed = opts.runGit(
          [
            "push", "upstream",
            `origin/${branches.origin}:${branches.upstream}`,
          ],
          path,
        );
        if (pushed.exitCode === 0) {
          out.push({
            project,
            outcome: "pushed",
            advancedBy: stagingAhead ?? undefined,
          });
          opts.emitEvent?.({
            type: "staging_outbound_fast_forwarded",
            project,
            message: stagingAhead
              ? `${project}: pushed ${stagingAhead} commits to upstream/${branches.upstream}`
              : `${project}: outbound fast-forwarded`,
          });
          touchSentinel(sentinel, opts.now);
          return;
        }

        const kind = classifyPushFailure(pushed.stdout, pushed.stderr);
        const detailBlob = `push: ${(pushed.stderr ?? pushed.stdout).trim().slice(0, 200)}`;
        if (kind === "workflow-scope") {
          // Workflow-scope rejection: a commit in the FF range edited a
          // .github/workflows/ file and the push token lacks the `workflow`
          // scope. Fixable in seconds (gh auth refresh -s workflow), so we do
          // NOT touch the sentinel — the next tick retries and the
          // stale-sentinel health signal stays armed. The event message names
          // the cause + remedy so the events log / briefing surfaces carry the
          // copy-pasteable fix.
          const meta = OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!;
          out.push({ project, outcome: "skipped-no-workflow-scope", detail: detailBlob });
          opts.emitEvent?.({
            type: "staging_outbound_workflow_scope_missing",
            project,
            message: `${project}: outbound push failed — ${meta.cause}; remedy: ${meta.remedy}`,
          });
          // NO sentinel touch.
        } else if (kind === "credentials") {
          out.push({ project, outcome: "skipped-no-push-credentials", detail: detailBlob });
          opts.emitEvent?.({
            type: "staging_outbound_credentials_missing",
            project,
            message: `${project}: outbound push failed (credentials)`,
          });
          // NO sentinel touch.
        } else {
          out.push({ project, outcome: "error", detail: detailBlob });
          opts.emitEvent?.({
            type: "staging_outbound_error",
            project,
            message: `${project}: outbound push failed`,
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
