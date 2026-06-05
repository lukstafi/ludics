import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatUpstreamLagSection,
  parseLeftRightCount,
} from "./briefing-lag.ts";
import { detectDefaultBranches, type RunGit } from "./git-runner.ts";
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

  test("detectDefaultBranches: returns null when neither symbolic-ref nor main/master ref exists", () => {
    const rg = fakeGit([]);
    const branches = detectDefaultBranches("/tmp/any", rg);
    expect(branches.origin).toBeNull();
    expect(branches.upstream).toBeNull();
  });

  test("detectDefaultBranches: falls back to main/master ref for manually-added remote without symbolic HEAD", () => {
    // Regression (PR #331 comment): git does NOT create `refs/remotes/<remote>/HEAD`
    // for remotes added via `git remote add upstream … && git fetch upstream` unless
    // the user explicitly runs `git remote set-head upstream -a`. Without this
    // fallback the lag section reports "could not detect default branch" and the
    // fast-forward job skips silently, which is the common-case failure mode the
    // review flagged.
    const rg = fakeGit([
      // origin has a symbolic ref (typical for cloned repos)
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      // upstream was added manually — no symbolic ref, but refs/remotes/upstream/main exists
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "abcdef1234\n" },
    ]);
    const branches = detectDefaultBranches("/tmp/any", rg);
    expect(branches.origin).toBe("master");
    expect(branches.upstream).toBe("main");
  });

  test("detectDefaultBranches: fallback picks master when main is absent", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "", exitCode: 128 },
      // main probe fails, master probe succeeds
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/master"], stdout: "deadbeef\n" },
    ]);
    const branches = detectDefaultBranches("/tmp/any", rg);
    expect(branches.upstream).toBe("master");
  });

  test("detectDefaultBranches: fallback prefers main over master when both exist", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "feedface\n" },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/master"], stdout: "deadbeef\n" },
    ]);
    const branches = detectDefaultBranches("/tmp/any", rg);
    expect(branches.upstream).toBe("main");
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

  // gh-ludics-540: outbound sentinel staleness annotation.
  // formatUpstreamLagSection reads
  // `<sentinelDir>/last-outbound-fast-forward-<project>.epoch` (same
  // file the staging-ff writer touches and the health-check skill
  // reads). The annotation surfaces when age >= outboundSentinelStaleSeconds.
  test("formatUpstreamLagSection: emits outbound-stale note when sentinel > 48h", () => {
    const dir = tmp();
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    mkdirSync(join(dir, ".git"), { recursive: true });
    // Create the outbound sentinel and age it 50h.
    const sentinel = join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch");
    writeFileSync(sentinel, "");
    const fiftyHoursAgo = new Date(Date.now() - 50 * 3600 * 1000);
    utimesSync(sentinel, fiftyHoursAgo, fiftyHoursAgo);

    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\nupstream\n" },
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/master\n" },
      { match: ["rev-list"], stdout: "0\t0\n" },
      { match: ["log"], stdout: "abc 2026-01-01 hi\n" },
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg, sentinelDir },
    );
    expect(out).toContain("outbound sentinel is");
    expect(out).toMatch(/outbound sentinel is ~5[0-1]h old/);
    expect(out).toContain("upstream push may be overdue");
  });

  test("formatUpstreamLagSection: omits outbound-stale note when sentinel is fresh (< 48h)", () => {
    const dir = tmp();
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    mkdirSync(join(dir, ".git"), { recursive: true });
    const sentinel = join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch");
    writeFileSync(sentinel, "");
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);
    utimesSync(sentinel, oneHourAgo, oneHourAgo);

    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\nupstream\n" },
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/master\n" },
      { match: ["rev-list"], stdout: "0\t0\n" },
      { match: ["log"], stdout: "abc 2026-01-01 hi\n" },
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg, sentinelDir },
    );
    expect(out).not.toContain("outbound sentinel is");
  });

  test("formatUpstreamLagSection: omits outbound-stale note when sentinelDir is missing or sentinel absent", () => {
    // Two arms in one test: (1) caller omits sentinelDir entirely
    // (back-compat with existing callers), (2) caller passes
    // sentinelDir but the project has no sentinel file (opted out).
    const dir = tmp();
    mkdirSync(join(dir, ".git"), { recursive: true });
    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\nupstream\n" },
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/master\n" },
      { match: ["rev-list"], stdout: "0\t0\n" },
      { match: ["log"], stdout: "abc 2026-01-01 hi\n" },
    ]);
    const noSentinelDir = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg },
    );
    expect(noSentinelDir).not.toContain("outbound sentinel is");

    const emptySentinelDir = mkdtempSync("/tmp/outbound-sentinel-empty-");
    const sentinelDirNoFile = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg, sentinelDir: emptySentinelDir },
    );
    expect(sentinelDirNoFile).not.toContain("outbound sentinel is");
  });

  // task-35e74651: stale outbound-sentinel note carries a cause + remedy
  // annotation read from the latest outbound push-auth event for the project.
  function staleOutboundSetup(): { dir: string; sentinelDir: string; rg: RunGit } {
    const dir = tmp();
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    mkdirSync(join(dir, ".git"), { recursive: true });
    const sentinel = join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch");
    writeFileSync(sentinel, "");
    const fiftyHoursAgo = new Date(Date.now() - 50 * 3600 * 1000);
    utimesSync(sentinel, fiftyHoursAgo, fiftyHoursAgo);
    const rg = fakeGit([
      { match: ["remote"], stdout: "origin\nupstream\n" },
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/master\n" },
      { match: ["rev-list"], stdout: "0\t0\n" },
      { match: ["log"], stdout: "abc 2026-01-01 hi\n" },
    ]);
    return { dir, sentinelDir, rg };
  }

  function writeEvents(lines: Record<string, unknown>[]): string {
    const evDir = mkdtempSync("/tmp/outbound-events-");
    const file = join(evDir, "events.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  test("formatUpstreamLagSection: stale outbound note includes workflow-scope cause/remedy", () => {
    const { dir, sentinelDir, rg } = staleOutboundSetup();
    const eventsFile = writeEvents([
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 100, message: "ocannl: x" },
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg, sentinelDir, eventsFile },
    );
    expect(out).toContain("outbound sentinel is");
    expect(out).toContain("cause: push token lacks `workflow` scope");
    expect(out).toContain("remedy: gh auth refresh -h github.com -s workflow");
  });

  test("formatUpstreamLagSection: stale outbound note includes credentials cause/remedy", () => {
    const { dir, sentinelDir, rg } = staleOutboundSetup();
    const eventsFile = writeEvents([
      { event_type: "staging_outbound_credentials_missing", project: "ocannl", epoch: 100, message: "ocannl: x" },
    ]);
    const out = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: dir } as ProjectConfig],
      { now: new Date(), runGit: rg, sentinelDir, eventsFile },
    );
    expect(out).toContain("cause: missing/invalid push credentials");
    expect(out).toContain("remedy:");
  });

  test("formatUpstreamLagSection: stale outbound note is unannotated when no relevant event / no eventsFile", () => {
    // Arm 1: eventsFile present but no matching event → base note only.
    const a = staleOutboundSetup();
    const eventsFile = writeEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 100, message: "ocannl: pushed" },
    ]);
    const out1 = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: a.dir } as ProjectConfig],
      { now: new Date(), runGit: a.rg, sentinelDir: a.sentinelDir, eventsFile },
    );
    expect(out1).toContain("outbound sentinel is");
    expect(out1).not.toContain("cause:");
    expect(out1).not.toContain("remedy:");

    // Arm 2: eventsFile omitted entirely → base note only (back-compat).
    const b = staleOutboundSetup();
    const out2 = formatUpstreamLagSection(
      [{ name: "ocannl", repo: "o/r", upstream_repo: "u/r", path: b.dir } as ProjectConfig],
      { now: new Date(), runGit: b.rg, sentinelDir: b.sentinelDir },
    );
    expect(out2).toContain("outbound sentinel is");
    expect(out2).not.toContain("cause:");
  });
});
