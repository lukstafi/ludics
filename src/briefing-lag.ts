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

export interface RunGitResult {
  stdout: string;
  exitCode: number;
}

/** A minimal git runner: takes argv and a cwd, returns stdout + exit code. */
export type RunGit = (args: string[], cwd: string) => RunGitResult;

export interface FormatLagOptions {
  now: Date;
  runGit: RunGit;
  /** If set, treat `.git/FETCH_HEAD` mtime older than this many seconds as stale. Default 6h. */
  fetchStaleSeconds?: number;
}

interface DetectedBranches {
  origin: string | null;
  upstream: string | null;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return path;
}

/**
 * Detect the default branch name for each of origin and upstream via
 * `git symbolic-ref refs/remotes/<remote>/HEAD`. Returns null when the
 * remote is absent or the symbolic ref is not set.
 */
export function detectDefaultBranches(cwd: string, runGit: RunGit): DetectedBranches {
  const read = (remote: string): string | null => {
    const r = runGit(["symbolic-ref", `refs/remotes/${remote}/HEAD`], cwd);
    if (r.exitCode !== 0) return null;
    const line = r.stdout.trim();
    // line looks like "refs/remotes/<remote>/<branch>"
    const prefix = `refs/remotes/${remote}/`;
    if (!line.startsWith(prefix)) return null;
    return line.slice(prefix.length) || null;
  };
  return { origin: read("origin"), upstream: read("upstream") };
}

function hasRemote(cwd: string, name: string, runGit: RunGit): boolean {
  const r = runGit(["remote"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(name);
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
    lines.push("");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n");
}

/** Production git runner — wraps Bun.spawnSync. */
export const defaultRunGit: RunGit = (args, cwd) => {
  const res = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
  return {
    stdout: res.stdout ? new TextDecoder().decode(res.stdout) : "",
    exitCode: res.exitCode ?? -1,
  };
};
