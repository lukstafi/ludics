import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatUpstreamLagSection,
  parseLeftRightCount,
  detectDefaultBranches,
  type RunGit,
} from "./briefing-lag.ts";
import type { ProjectConfig } from "./config.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ludics-lag-test-"));
}

/**
 * Build a fake runGit that dispatches on args[0] (+ optional args[1]).
 * Each entry in `rules` matches a prefix of argv.
 */
function fakeGit(rules: Array<{ match: string[]; stdout: string; exitCode?: number }>): RunGit {
  return (args) => {
    for (const r of rules) {
      if (r.match.every((m, i) => args[i] === m)) {
        return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
      }
    }
    return { stdout: "", exitCode: 128 };
  };
}

describe("briefing-lag", () => {
  test("parseLeftRightCount: parses <behind>\\t<ahead>", () => {
    // `git rev-list --left-right --count upstream/X...origin/X` prints
    // <left>\t<right> where left = commits only in upstream (staging is behind)
    // and right = commits only in origin (staging is ahead). The known ocannl
    // snapshot of 0-ahead / 59-behind corresponds to stdout "59\t0".
    expect(parseLeftRightCount("59\t0\n")).toEqual({ behind: 59, ahead: 0 });
    expect(parseLeftRightCount("12\t3\n")).toEqual({ behind: 12, ahead: 3 });
    expect(parseLeftRightCount("0 59")).toEqual({ behind: 0, ahead: 59 });
    expect(parseLeftRightCount("garbage")).toBeNull();
  });

  test("detectDefaultBranches: strips refs/remotes/<remote>/ prefix", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/main\n" },
    ]);
    const branches = detectDefaultBranches("/tmp/any", rg);
    expect(branches.origin).toBe("master");
    expect(branches.upstream).toBe("main");
  });

  test("detectDefaultBranches: returns null when remote HEAD is unset", () => {
    const rg = fakeGit([]);
    const branches = detectDefaultBranches("/tmp/any", rg);
    expect(branches.origin).toBeNull();
    expect(branches.upstream).toBeNull();
  });

  test("formatUpstreamLagSection: empty projects list returns empty string", () => {
    const out = formatUpstreamLagSection([], { now: new Date(), runGit: fakeGit([]) });
    expect(out).toBe("");
  });

  test("formatUpstreamLagSection: projects without upstream_repo are skipped entirely", () => {
    const projects: ProjectConfig[] = [{ name: "plain", repo: "o/r" } as unknown as ProjectConfig];
    const out = formatUpstreamLagSection(projects, { now: new Date(), runGit: fakeGit([]) });
    expect(out).toBe("");
  });

  test("formatUpstreamLagSection: renders AHEAD/behind and last-merge lines", () => {
    const dir = tmp();
    // Make .git/ so fetch-freshness check path exists (but no FETCH_HEAD → no note)
    mkdirSync(join(dir, ".git"), { recursive: true });

    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\nupstream\n" },
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/master\n" },
      {
        match: ["rev-list", "--left-right", "--count", "upstream/master...origin/master"],
        stdout: "59\t3\n",
      },
      {
        match: ["log", "-1", "--format=%h %ad %s", "--date=short", "origin/master"],
        stdout: "cdc14726 2026-04-17 Merge: Cross-statement CSE\n",
      },
      {
        match: ["log", "-1", "--format=%h %ad %s", "--date=short", "upstream/master"],
        stdout: "0587b16b 2026-04-05 Merge pull request #446\n",
      },
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "lukstafi/ocannl-staging", upstream_repo: "ahrefs/ocannl", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg },
    );
    expect(out).toContain("### ocannl (upstream: ahrefs/ocannl)");
    expect(out).toContain("**staging is 3 commits AHEAD of upstream**");
    expect(out).toContain("staging is 59 commits behind upstream");
    expect(out).toContain("cdc14726 2026-04-17 Merge: Cross-statement CSE");
    expect(out).toContain("0587b16b 2026-04-05 Merge pull request #446");
  });

  test("formatUpstreamLagSection: missing upstream remote emits note and skips counts", () => {
    const dir = tmp();
    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\n" }, // no upstream
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "foo", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg },
    );
    expect(out).toContain("### foo");
    expect(out).toContain("upstream remote not configured");
    expect(out).not.toContain("AHEAD");
  });

  test("formatUpstreamLagSection: missing checkout path emits a clear note", () => {
    const rg = fakeGit([]);
    const out = formatUpstreamLagSection(
      [{ name: "gone", repo: "o/r", upstream_repo: "u/r", path: "/nope/does/not/exist-xyz" } as ProjectConfig],
      { now: new Date(), runGit: rg },
    );
    expect(out).toContain("### gone");
    expect(out).toContain("checkout path not found");
  });

  test("formatUpstreamLagSection: emits freshness note when FETCH_HEAD is stale", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"), { recursive: true });
    const fetchHead = join(dir, ".git", "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    // Set mtime to 12h ago
    const twelveHoursAgo = new Date(Date.now() - 12 * 3600 * 1000);
    utimesSync(fetchHead, twelveHoursAgo, twelveHoursAgo);

    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\nupstream\n" },
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/master\n" },
      { match: ["rev-list"], stdout: "0\t0\n" },
      { match: ["log"], stdout: "abc 2026-01-01 hi\n" },
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg, fetchStaleSeconds: 6 * 3600 },
    );
    expect(out).toContain("upstream fetch data is");
    expect(out).toContain("h old");
  });
});
