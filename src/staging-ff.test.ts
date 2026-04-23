import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  maybeFastForwardStagingFromUpstream,
  type FastForwardProjectResult,
} from "./staging-ff.ts";
import type { RunGit } from "./briefing-lag.ts";
import type { ProjectConfig } from "./config.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Record git calls so tests can assert the helper is running the right
 * commands (e.g. --ff-only merge, never a push). Handlers key on the first
 * arg by default; use the `symbolicRef` escape hatch to dispatch on which
 * remote is being queried (origin vs upstream).
 */
function recordingGit(
  handlers: Record<string, { stdout: string; exitCode?: number }>,
  symbolicRef?: (ref: string) => { stdout: string; exitCode?: number },
): { run: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args.slice());
      const key = args[0] ?? "";
      if (key === "symbolic-ref" && symbolicRef) {
        const r = symbolicRef(args[1] ?? "");
        return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
      }
      if (key in handlers) return { stdout: handlers[key]!.stdout, exitCode: handlers[key]!.exitCode ?? 0 };
      // default OK with empty stdout (for checkout etc.)
      return { stdout: "", exitCode: 0 };
    },
  };
}

const defaultSymbolicRef = (ref: string) => {
  if (ref.endsWith("/origin/HEAD")) return { stdout: "refs/remotes/origin/master\n" };
  if (ref.endsWith("/upstream/HEAD")) return { stdout: "refs/remotes/upstream/master\n" };
  return { stdout: "", exitCode: 128 };
};

function project(name: string, path: string, upstream = "upstream/bar"): ProjectConfig {
  return { name, repo: "o/foo", upstream_repo: upstream, path } as ProjectConfig;
}

describe("maybeFastForwardStagingFromUpstream", () => {
  test("skips projects without upstream_repo", () => {
    const sentinelDir = tmp("ff-sentinel-");
    const { run, calls } = recordingGit({});
    const res = maybeFastForwardStagingFromUpstream(
      [{ name: "plain", repo: "o/r" } as ProjectConfig],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("honors the sentinel throttle within 24h", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    // Pre-touch the sentinel at 10 minutes ago.
    const sentinel = join(sentinelDir, "last-fast-forward-ocannl.epoch");
    writeFileSync(sentinel, "");
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(sentinel, recent, recent);
    const { run, calls } = recordingGit({});
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("throttled");
    expect(calls).toHaveLength(0); // No git calls while throttled
  });

  test("successful fast-forward: touches sentinel, emits event, restores prior branch", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const events: Array<{ type: string; project: string }> = [];
    const handlers: Record<string, { stdout: string; exitCode?: number }> = {
      remote: { stdout: "origin\nupstream\n" },
      status: { stdout: "" },
      "rev-parse": { stdout: "some-topic\n" }, // currently on topic branch
      checkout: { stdout: "" },
      fetch: { stdout: "" },
      merge: { stdout: "Updating aaa..bbb\nFast-forward\n file | 1 +\n" },
      "rev-list": { stdout: "0\n" },
    };
    const { run, calls } = recordingGit(handlers, defaultSymbolicRef);
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir, "upstream/bar")],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({ type: ev.type, project: ev.project }),
      },
    );
    expect(res[0]!.outcome).toBe("fast-forwarded");
    expect(events).toContainEqual({ type: "staging_fast_forwarded", project: "ocannl" });
    // Sentinel touched
    expect(existsSync(join(sentinelDir, "last-fast-forward-ocannl.epoch"))).toBe(true);
    // The helper must use --ff-only, never --rebase or plain merge
    const mergeCall = calls.find((c) => c[0] === "merge");
    expect(mergeCall).toBeDefined();
    expect(mergeCall!.includes("--ff-only")).toBe(true);
    expect(mergeCall!.includes("--rebase")).toBe(false);
    // Never pushes
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    // Restored to prior branch
    const checkouts = calls.filter((c) => c[0] === "checkout");
    expect(checkouts[checkouts.length - 1]![1]).toBe("some-topic");
  });

  test("detached HEAD: still checks out the default branch before merging and restores the detached SHA", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const events: Array<{ type: string }> = [];
    // Fake runGit that differentiates rev-parse by second arg, simulating a
    // detached-HEAD state on a specific commit SHA.
    const calls: string[][] = [];
    const DETACHED_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    const run: RunGit = (args) => {
      calls.push(args.slice());
      const key = args[0] ?? "";
      if (key === "remote") return { stdout: "origin\nupstream\n", exitCode: 0 };
      if (key === "symbolic-ref" && args[1]?.endsWith("/origin/HEAD")) {
        return { stdout: "refs/remotes/origin/master\n", exitCode: 0 };
      }
      if (key === "symbolic-ref" && args[1]?.endsWith("/upstream/HEAD")) {
        return { stdout: "refs/remotes/upstream/master\n", exitCode: 0 };
      }
      if (key === "fetch") return { stdout: "", exitCode: 0 };
      if (key === "status") return { stdout: "", exitCode: 0 };
      if (key === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        // Detached HEAD signal: git prints "HEAD"
        return { stdout: "HEAD\n", exitCode: 0 };
      }
      if (key === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${DETACHED_SHA}\n`, exitCode: 0 };
      }
      if (key === "checkout") return { stdout: "", exitCode: 0 };
      if (key === "merge") return { stdout: "Updating aaa..bbb\nFast-forward\n", exitCode: 0 };
      if (key === "rev-list") return { stdout: "5\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };

    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({ type: ev.type }),
      },
    );

    expect(res[0]!.outcome).toBe("fast-forwarded");
    // 1. The helper MUST have checked out the default branch before merging.
    const checkouts = calls.filter((c) => c[0] === "checkout");
    const mergeCallIdx = calls.findIndex((c) => c[0] === "merge");
    const checkoutBeforeMerge = calls
      .slice(0, mergeCallIdx)
      .filter((c) => c[0] === "checkout");
    expect(checkoutBeforeMerge.length).toBeGreaterThanOrEqual(1);
    expect(checkoutBeforeMerge[0]![1]).toBe("master");
    // 2. After the merge, the helper MUST restore the detached SHA via
    //    `git checkout --detach <sha>` — preserves the user's position.
    expect(checkouts[checkouts.length - 1]).toEqual(["checkout", "--detach", DETACHED_SHA]);
    // 3. Never pushes.
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    // 4. Event was emitted for successful fast-forward.
    expect(events).toContainEqual({ type: "staging_fast_forwarded" });
  });

  test("already up-to-date is distinguished from fast-forwarded and does not emit", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const events: Array<{ type: string }> = [];
    const { run } = recordingGit({
      remote: { stdout: "origin\nupstream\n" },
      status: { stdout: "" },
      "rev-parse": { stdout: "master\n" }, // already on master
      fetch: { stdout: "" },
      merge: { stdout: "Already up to date.\n" },
      "rev-list": { stdout: "0\n" },
    }, defaultSymbolicRef);
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir, emitEvent: (ev) => events.push({ type: ev.type }) },
    );
    expect(res[0]!.outcome).toBe("already-up-to-date");
    expect(events).toHaveLength(0);
  });

  test("diverged: emits staging_fast_forward_diverged; never pushes or force-resets", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const events: Array<{ type: string }> = [];
    const { run, calls } = recordingGit({
      remote: { stdout: "origin\nupstream\n" },
      status: { stdout: "" },
      "rev-parse": { stdout: "master\n" },
      fetch: { stdout: "" },
      merge: { stdout: "fatal: Not possible to fast-forward, aborting.\n", exitCode: 128 },
    }, defaultSymbolicRef);
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir, emitEvent: (ev) => events.push({ type: ev.type }) },
    );
    expect(res[0]!.outcome).toBe("diverged");
    expect(events).toContainEqual({ type: "staging_fast_forward_diverged" });
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(calls.some((c) => c[0] === "reset")).toBe(false);
    // Sentinel touched to avoid spamming on every tick while user resolves.
    expect(existsSync(join(sentinelDir, "last-fast-forward-ocannl.epoch"))).toBe(true);
  });

  test("dirty working tree aborts the fast-forward without touching sentinel", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const { run, calls } = recordingGit({
      remote: { stdout: "origin\nupstream\n" },
      fetch: { stdout: "" },
      status: { stdout: " M path/to/file\n" }, // dirty
    }, defaultSymbolicRef);
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-dirty-worktree");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-fast-forward-ocannl.epoch"))).toBe(false);
  });

  test("missing upstream remote is skipped cleanly", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const { run, calls } = recordingGit({ remote: { stdout: "origin\n" } });
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-upstream-remote");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(calls.some((c) => c[0] === "fetch")).toBe(false);
  });

  test("non-existent checkout path is reported, not thrown", () => {
    const sentinelDir = tmp("ff-sentinel-");
    const { run } = recordingGit({});
    const res = maybeFastForwardStagingFromUpstream(
      [project("ghost", "/does/not/exist/xyz-ludics-test")],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-path");
  });

  test("default-branch detection uses ls-remote --symref after fetch (authoritative tier)", () => {
    // Regression for task-b0d4f45b item 3: when symbolic-ref is absent (common
    // for manually-added remotes), the fast-forward path must consult
    // `ls-remote --symref` so non-main/master defaults (e.g. `develop`) are
    // detected correctly. The briefing path still stays local-only.
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const calls: string[][] = [];
    const run: RunGit = (args) => {
      calls.push(args.slice());
      const key = args[0] ?? "";
      if (key === "remote") return { stdout: "origin\nupstream\n", exitCode: 0 };
      if (key === "fetch") return { stdout: "", exitCode: 0 };
      if (key === "status") return { stdout: "", exitCode: 0 };
      if (key === "symbolic-ref") return { stdout: "", exitCode: 128 };
      if (key === "ls-remote" && args[2] === "upstream") {
        return { stdout: "ref: refs/heads/develop\tHEAD\n0123abc\tHEAD\n", exitCode: 0 };
      }
      if (key === "ls-remote" && args[2] === "origin") {
        return { stdout: "ref: refs/heads/develop\tHEAD\n0123abc\tHEAD\n", exitCode: 0 };
      }
      if (key === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "develop\n", exitCode: 0 };
      }
      if (key === "merge") return { stdout: "Already up to date.\n", exitCode: 0 };
      if (key === "rev-list") return { stdout: "0\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };
    const res = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("already-up-to-date");
    // ls-remote --symref was consulted (proof of authoritative path engaging).
    expect(calls.some((c) => c[0] === "ls-remote" && c[1] === "--symref")).toBe(true);
    // Merge target used the `develop` branch name from ls-remote output.
    const merge = calls.find((c) => c[0] === "merge");
    expect(merge).toBeDefined();
    expect(merge!.includes("upstream/develop")).toBe(true);
  });

  test("fetch failure: records error, touches sentinel, does not attempt merge", () => {
    const dir = tmp("ff-checkout-");
    const sentinelDir = tmp("ff-sentinel-");
    mkdirSync(dir, { recursive: true });
    const { run, calls } = recordingGit({
      remote: { stdout: "origin\nupstream\n" },
      fetch: { stdout: "fatal: unable to reach upstream\n", exitCode: 128 },
    });
    const res: FastForwardProjectResult[] = maybeFastForwardStagingFromUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("error");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-fast-forward-ocannl.epoch"))).toBe(true);
  });
});
