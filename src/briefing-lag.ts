// Upstream-vs-staging lag reporting for the briefing context.
//
// For each project declaring `upstream_repo`, renders a block showing how many
// commits the staging (origin) default branch is ahead of / behind upstream,
// plus the last-merge commit line on each side. The primary signal is
// `ahead_of_upstream` — those are merges that landed on staging and still need
// to be forwarded upstream manually by the user. "Behind" is kept secondary;
// the once-daily keepalive fast-forward job (see mag.ts) normally keeps it at 0.
//
// This module is pure w.r.t. git: all subprocess calls go through the injected
// RunGit callable, which makes unit tests deterministic.

import { existsSync, statSync } from "fs";
import { join } from "path";
import type { ProjectConfig } from "./config.ts";
import { detectDefaultBranches, expandHome, hasRemote, type RunGit } from "./git-runner.ts";
import { latestOutboundCauseRemedy } from "./staging-event-meta.ts";

export interface FormatLagOptions {
  now: Date;
  runGit: RunGit;
  /** If set, treat `.git/FETCH_HEAD` mtime older than this many seconds as stale. Default 6h. */
  fetchStaleSeconds?: number;
  /**
   * Directory holding the outbound staging-ff sentinel files
   * (`last-outbound-fast-forward-<project>.epoch`). When omitted, the
   * outbound-stale annotation is suppressed — backward-compatible
   * with callers/tests that don't surface the outbound sentinel.
   * gh-ludics-540.
   */
  sentinelDir?: string;
  /** Outbound sentinel age threshold for the stale annotation. Default 48h. gh-ludics-540. */
  outboundSentinelStaleSeconds?: number;
  /**
   * Path to the JSONL events file (`journal/events.jsonl`). When set, a stale
   * outbound-sentinel note is annotated with the cause + remedy of the most
   * recent outbound push-auth event for the project (workflow-scope /
   * credentials). When omitted, the note is emitted without the annotation —
   * backward-compatible with callers/tests that don't surface event data.
   * task-35e74651.
   */
  eventsFile?: string;
}

/**
 * Parse `git rev-list --left-right --count A...B` output.
 * Output format is `<left>\t<right>` where:
 *   - left  = commits reachable from A (upstream) but not B
 *   - right = commits reachable from B (origin)  but not A
 * So when invoked with `upstream/<u>...origin/<o>`:
 *   - left  = commits behind upstream (upstream has, staging doesn't)
 *   - right = commits ahead of upstream (staging has, upstream doesn't)
 */
export function parseLeftRightCount(stdout: string): { behind: number; ahead: number } | null {
  const m = stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

function lastMergeLine(cwd: string, ref: string, runGit: RunGit): string | null {
  const r = runGit(["log", "-1", "--format=%h %ad %s", "--date=short", ref], cwd);
  if (r.exitCode !== 0) return null;
  const line = r.stdout.trim();
  return line || null;
}

function fetchFreshnessNote(cwd: string, now: Date, stale: number): string | null {
  const fetchHead = join(cwd, ".git", "FETCH_HEAD");
  if (!existsSync(fetchHead)) return null;
  try {
    const mtime = statSync(fetchHead).mtimeMs;
    const ageSec = Math.max(0, Math.floor((now.getTime() - mtime) / 1000));
    if (ageSec < stale) return null;
    const hours = Math.round(ageSec / 3600);
    return `(upstream fetch data is ~${hours}h old; keepalive fast-forward may be overdue)`;
  } catch {
    return null;
  }
}

/**
 * gh-ludics-540: annotation for the outbound staging→upstream push
 * sentinel. Reads the same file that `src/staging-ff.ts` writes and
 * `skills/ludics-health-check.md` reads — so a stale sentinel here
 * matches the stale-sentinel finding in the health-check skill.
 */
function outboundSentinelStaleNote(
  sentinelDir: string,
  project: string,
  now: Date,
  stale: number,
  eventsFile?: string,
): string | null {
  const sentinel = join(sentinelDir, `last-outbound-fast-forward-${project}.epoch`);
  if (!existsSync(sentinel)) return null;
  try {
    const mtime = statSync(sentinel).mtimeMs;
    const ageSec = Math.max(0, Math.floor((now.getTime() - mtime) / 1000));
    if (ageSec < stale) return null;
    const hours = Math.round(ageSec / 3600);
    let note = `(outbound sentinel is ~${hours}h old; upstream push may be overdue)`;
    // task-35e74651: when the latest outbound push-auth event names a cause +
    // remedy (workflow-scope / credentials), append it so the operator sees
    // the copy-pasteable fix next to the stale-sentinel warning.
    if (eventsFile) {
      const annotation = latestOutboundCauseRemedy(eventsFile, project);
      if (annotation) {
        note += ` — cause: ${annotation.cause}; remedy: ${annotation.remedy}`;
      }
    }
    return note;
  } catch {
    return null;
  }
}

/**
 * Render the "Upstream vs Staging Lag" block for every project in `projects`
 * whose `upstream_repo` is configured. Returns an empty string when no project
 * qualifies — the caller can use this signal to omit the section header.
 */
export function formatUpstreamLagSection(
  projects: ProjectConfig[],
  opts: FormatLagOptions,
): string {
  const relevant = projects.filter((p) => !!p.upstream_repo);
  if (relevant.length === 0) return "";

  const stale = opts.fetchStaleSeconds ?? 6 * 3600;
  const blocks: string[] = [];
  for (const p of relevant) {
    const name = p.name || p.repo || "(unnamed)";
    const path = p.path ? expandHome(String(p.path)) : null;
    if (!path || !existsSync(path)) {
      blocks.push(`### ${name}\n\n- checkout path not found (configured: ${p.path ?? "none"})\n`);
      continue;
    }
    if (!hasRemote(path, "upstream", opts.runGit)) {
      blocks.push(`### ${name}\n\n- upstream remote not configured in checkout ${path}\n`);
      continue;
    }
    const branches = detectDefaultBranches(path, opts.runGit);
    if (!branches.origin || !branches.upstream) {
      blocks.push(
        `### ${name}\n\n- could not detect default branch (origin=${branches.origin ?? "?"} upstream=${branches.upstream ?? "?"})\n`,
      );
      continue;
    }

    const lr = opts.runGit(
      [
        "rev-list", "--left-right", "--count",
        `upstream/${branches.upstream}...origin/${branches.origin}`,
      ],
      path,
    );
    const counts = lr.exitCode === 0 ? parseLeftRightCount(lr.stdout) : null;
    const stagingLast = lastMergeLine(path, `origin/${branches.origin}`, opts.runGit);
    const upstreamLast = lastMergeLine(path, `upstream/${branches.upstream}`, opts.runGit);
    const freshnessNote = fetchFreshnessNote(path, opts.now, stale);

    const lines: string[] = [`### ${name} (upstream: ${p.upstream_repo})`, ""];
    if (counts) {
      lines.push(
        `- **staging is ${counts.ahead} commits AHEAD of upstream** (primary — merges on staging not yet forwarded upstream)`,
        `- staging is ${counts.behind} commits behind upstream`,
      );
    } else {
      lines.push(`- could not compute ahead/behind counts (rev-list exit=${lr.exitCode})`);
    }
    if (stagingLast) lines.push(`- last staging merge: ${stagingLast}`);
    if (upstreamLast) lines.push(`- last upstream merge: ${upstreamLast}`);
    if (freshnessNote) lines.push(`- ${freshnessNote}`);
    // gh-ludics-540: outbound sentinel stale annotation. Only fires
    // when the caller passed a sentinelDir AND the project has the
    // sentinel file (writer in src/staging-ff.ts:syncUpstreamMainFromStaging
    // only creates it for opt-in projects).
    if (opts.sentinelDir) {
      const outboundStale = opts.outboundSentinelStaleSeconds ?? 48 * 3600;
      const outboundNote = outboundSentinelStaleNote(opts.sentinelDir, name, opts.now, outboundStale, opts.eventsFile);
      if (outboundNote) lines.push(`- ${outboundNote}`);
    }
    lines.push("");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n");
}

