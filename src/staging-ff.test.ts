import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  syncStagingMainWithUpstream,
  syncUpstreamMainFromStaging,
  classifyPushFailure,
  type FastForwardProjectResult,
} from "./staging-ff.ts";
import type { RunGit } from "./git-runner.ts";
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

describe("syncStagingMainWithUpstream", () => {
  test("skips projects without upstream_repo", () => {
    const sentinelDir = tmp("ff-sentinel-");
    const { run, calls } = recordingGit({});
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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

    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res = syncStagingMainWithUpstream(
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
    const res: FastForwardProjectResult[] = syncStagingMainWithUpstream(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("error");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-fast-forward-ocannl.epoch"))).toBe(true);
  });
});

// =============================================================================
// gh-ludics-540: outbound staging→upstream fast-forward push tests.
//
// These tests use per-argv inline RunGit runners (rather than the
// arg[0]-keyed `recordingGit` helper above) because the outbound flow
// dispatches on:
//   - `fetch upstream` vs `fetch origin`
//   - `merge --ff-only origin/<o>` (local-ff) — distinct from inbound's
//     `merge --ff-only upstream/<u>`
//   - `merge-base --is-ancestor` vs `rev-list --count` vs `rev-list --left-right`
//   - `push upstream origin/<o>:<u>` — exact argv asserted
// =============================================================================

interface OutboundFakeOptions {
  /** Stdout for `fetch upstream`. Default "" + exitCode 0. */
  fetchUpstream?: { stdout?: string; stderr?: string; exitCode?: number };
  /** Stdout for `fetch origin <branch>`. Default "" + exitCode 0. */
  fetchOrigin?: { stdout?: string; stderr?: string; exitCode?: number };
  /** Stdout for the local `merge --ff-only origin/<o>`. Default "" + exitCode 0. */
  localMerge?: { stdout?: string; stderr?: string; exitCode?: number };
  /** Stdout/exitCode for `rev-list --count upstream/..origin/`. Default "5\n". */
  revListCount?: { stdout?: string; exitCode?: number };
  /** Stdout/exitCode for `merge-base --is-ancestor`. Default exitCode 0 (is-ancestor). */
  ancestry?: { stdout?: string; exitCode?: number };
  /** Stdout/exitCode for `rev-list --left-right --count`. Default "0\t5\n". */
  revListLeftRight?: { stdout?: string; exitCode?: number };
  /** Stdout/exitCode for `push upstream <refspec>`. Default exitCode 0. */
  push?: { stdout?: string; stderr?: string; exitCode?: number };
  /** Override `remote` listing. Default "origin\nupstream\n". */
  remote?: { stdout?: string; exitCode?: number };
  /** Override worktree status. Default "" (clean). */
  status?: { stdout?: string; exitCode?: number };
  /** Override origin default branch (used for refspec). Default "master". */
  originBranch?: string;
  /** Override upstream default branch. Default "master". */
  upstreamBranch?: string;
}

function outboundFakeGit(opts: OutboundFakeOptions = {}): {
  run: RunGit;
  calls: string[][];
} {
  const calls: string[][] = [];
  const originBranch = opts.originBranch ?? "master";
  const upstreamBranch = opts.upstreamBranch ?? "master";
  const run: RunGit = (args) => {
    calls.push(args.slice());
    const key = args[0] ?? "";

    if (key === "remote") {
      const r = opts.remote ?? { stdout: "origin\nupstream\n" };
      return { stdout: r.stdout ?? "", exitCode: r.exitCode ?? 0 };
    }
    if (key === "status") {
      const r = opts.status ?? { stdout: "" };
      return { stdout: r.stdout ?? "", exitCode: r.exitCode ?? 0 };
    }
    if (key === "symbolic-ref") {
      const ref = args[1] ?? "";
      if (ref.endsWith("/origin/HEAD")) {
        return { stdout: `refs/remotes/origin/${originBranch}\n`, exitCode: 0 };
      }
      if (ref.endsWith("/upstream/HEAD")) {
        return { stdout: `refs/remotes/upstream/${upstreamBranch}\n`, exitCode: 0 };
      }
      return { stdout: "", exitCode: 128 };
    }
    if (key === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
      return { stdout: `${originBranch}\n`, exitCode: 0 };
    }
    if (key === "checkout") {
      return { stdout: "", exitCode: 0 };
    }
    if (key === "fetch") {
      if (args[1] === "upstream") {
        const r = opts.fetchUpstream ?? {};
        return { stdout: r.stdout ?? "", stderr: r.stderr, exitCode: r.exitCode ?? 0 };
      }
      if (args[1] === "origin") {
        const r = opts.fetchOrigin ?? {};
        return { stdout: r.stdout ?? "", stderr: r.stderr, exitCode: r.exitCode ?? 0 };
      }
      return { stdout: "", exitCode: 0 };
    }
    if (key === "merge" && args[1] === "--ff-only") {
      const r = opts.localMerge ?? {};
      return { stdout: r.stdout ?? "", stderr: r.stderr, exitCode: r.exitCode ?? 0 };
    }
    if (key === "merge-base" && args[1] === "--is-ancestor") {
      const r = opts.ancestry ?? {};
      return { stdout: r.stdout ?? "", exitCode: r.exitCode ?? 0 };
    }
    if (key === "rev-list" && args[1] === "--count") {
      const r = opts.revListCount ?? { stdout: "5\n" };
      return { stdout: r.stdout ?? "", exitCode: r.exitCode ?? 0 };
    }
    if (key === "rev-list" && args[1] === "--left-right") {
      const r = opts.revListLeftRight ?? { stdout: "0\t5\n" };
      return { stdout: r.stdout ?? "", exitCode: r.exitCode ?? 0 };
    }
    if (key === "push") {
      const r = opts.push ?? {};
      return { stdout: r.stdout ?? "", stderr: r.stderr, exitCode: r.exitCode ?? 0 };
    }
    // Unhandled — return success with empty output. Tests assert
    // explicit calls anyway.
    return { stdout: "", exitCode: 0 };
  };
  return { run, calls };
}

describe("classifyPushFailure", () => {
  test("matches the three credential literals on stderr", () => {
    expect(classifyPushFailure("", "ERROR: Permission denied (publickey).")).toBe("credentials");
    expect(classifyPushFailure("", "fatal: could not read Username for 'https://github.com'")).toBe("credentials");
    expect(classifyPushFailure("", "remote: Authentication failed")).toBe("credentials");
  });

  test("matches the three credential literals on stdout (fallback)", () => {
    expect(classifyPushFailure("ERROR: Permission denied (publickey).", "")).toBe("credentials");
    expect(classifyPushFailure("fatal: could not read Username for 'https://github.com'", "")).toBe("credentials");
    expect(classifyPushFailure("remote: Authentication failed", "")).toBe("credentials");
  });

  test("classifies network failures distinctly from credentials", () => {
    expect(classifyPushFailure("", "fatal: unable to access 'https://github.com': Could not resolve host")).toBe("network");
    expect(classifyPushFailure("", "fatal: Network is unreachable")).toBe("network");
  });

  test("returns 'other' for unrecognized failure shapes", () => {
    expect(classifyPushFailure("", "remote: error: server-side hook failure")).toBe("other");
  });

  // Codex PR #544 review: GitHub-style 403/401 push denials must
  // classify as credentials, not as network. Real GitHub stderr for a
  // 403 push denial is a TWO-LINE blob — the first line names the
  // permission gap, the second includes "unable to access ... error: 403"
  // which previously matched the network clause. Without the credentials
  // classifier winning, the sentinel would be touched and the stale-
  // sentinel signal that AC 9 relies on would be suppressed.
  test("classifies GitHub 403 push-denial stderr as credentials, not network", () => {
    const real403Stderr = [
      "remote: Permission to lukstafi/ocannl-staging.git denied to someuser.",
      "fatal: unable to access 'https://github.com/lukstafi/ocannl-staging.git/': The requested URL returned error: 403",
    ].join("\n");
    expect(classifyPushFailure("", real403Stderr)).toBe("credentials");
  });

  test("classifies bare 'permission to <repo> denied to <user>' line as credentials", () => {
    expect(classifyPushFailure("", "remote: Permission to org/repo.git denied to bot."))
      .toBe("credentials");
  });

  test("classifies 'error: 403' (without the matching first line) as credentials", () => {
    // Belt-and-suspenders: even when only the trailing fatal line is
    // captured (e.g. truncated detail blob), the 403 itself routes to
    // credentials so the sentinel-touch policy fires correctly.
    expect(classifyPushFailure("", "fatal: unable to access '...': The requested URL returned error: 403"))
      .toBe("credentials");
  });

  test("classifies 'error: 401' as credentials", () => {
    expect(classifyPushFailure("", "fatal: unable to access '...': The requested URL returned error: 401"))
      .toBe("credentials");
  });

  test("classifies 'Write access to repository not granted' as credentials", () => {
    expect(classifyPushFailure("", "remote: Write access to repository not granted."))
      .toBe("credentials");
  });

  // task-35e74651: workflow-scope rejection is its own class, matched BEFORE
  // credentials so the more specific/actionable class wins.
  test("classifies OAuth-App workflow-scope rejection as workflow-scope", () => {
    const oauthStderr =
      "! [remote rejected] origin/master -> master (refusing to allow an OAuth App to create or update workflow `.github/workflows/gh-pages-docs.yml` without `workflow` scope)";
    expect(classifyPushFailure("", oauthStderr)).toBe("workflow-scope");
  });

  test("classifies ASCII-quote PAT variant `without 'workflow' scope` as workflow-scope", () => {
    expect(classifyPushFailure("", "remote: refusing to update workflow without 'workflow' scope"))
      .toBe("workflow-scope");
  });

  test("classifies backtick-quote variant ``without `workflow` scope`` as workflow-scope", () => {
    expect(classifyPushFailure("", "remote: refusing to update workflow without `workflow` scope"))
      .toBe("workflow-scope");
  });

  test("workflow-scope wins even when the blob also contains error: 403", () => {
    // Ordering invariant: a workflow-scope rejection that ALSO carries an
    // `error: 403` token (which the credentials regex matches) must still
    // classify as workflow-scope, not credentials. This assertion fails if
    // the workflow-scope check is moved below the credentials check.
    const mixed = [
      "remote: refusing to allow an OAuth App to create or update workflow `f.yml` without `workflow` scope",
      "fatal: unable to access '...': The requested URL returned error: 403",
    ].join("\n");
    expect(classifyPushFailure("", mixed)).toBe("workflow-scope");
  });

  test("generic non-fast-forward remote rejection stays 'other' (workflow matcher is narrow)", () => {
    expect(classifyPushFailure("", "! [remote rejected] origin/master -> master (non-fast-forward)"))
      .toBe("other");
  });

  test("network classifier still wins for legitimate transient shapes (no 403 / no denial)", () => {
    // Negative control: a generic 'unable to access' WITHOUT any
    // credentials marker (no 403, no denial, no Write access line) must
    // still classify as network — touching the sentinel here is the
    // correct policy because there's no auth-gap signal to surface.
    expect(classifyPushFailure("", "fatal: unable to access 'https://github.com/...': Could not resolve host: github.com"))
      .toBe("network");
  });
});

describe("classifyPushFailure end-to-end (Codex PR #544 review)", () => {
  // Wire the 403-stderr through syncUpstreamMainFromStaging to prove
  // the outcome and sentinel-touch policy match the AC, not just the
  // classifier's return value.
  test("403 push failure → skipped-no-push-credentials, sentinel NOT touched", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-403-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-403-");
    const real403Stderr = [
      "remote: Permission to lukstafi/ocannl-staging.git denied to someuser.",
      "fatal: unable to access 'https://github.com/lukstafi/ocannl-staging.git/': The requested URL returned error: 403",
    ].join("\n");
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "5\n" },
      push: { stdout: "", stderr: real403Stderr, exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-push-credentials");
    expect(calls.some((c) => c[0] === "push")).toBe(true);
    // The key invariant Codex flagged: sentinel must NOT exist so the
    // stale-sentinel signal fires fast.
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
  });
});

describe("workflow-scope push rejection end-to-end (task-35e74651)", () => {
  test("positive: workflow-scope rejection → skipped-no-workflow-scope, event with remedy, sentinel NOT touched", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-wfscope-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-wfscope-");
    const wfStderr =
      "! [remote rejected] origin/master -> master (refusing to allow an OAuth App to create or update workflow `.github/workflows/gh-pages-docs.yml` without `workflow` scope)";
    const events: Array<{ type: string; project: string; message: string }> = [];
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "5\n" },
      push: { stdout: "", stderr: wfStderr, exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({ type: ev.type, project: ev.project, message: ev.message }),
      },
    );
    expect(res[0]!.outcome).toBe("skipped-no-workflow-scope");
    expect(calls.some((c) => c[0] === "push")).toBe(true);
    // Event emitted, names the cause + copy-pasteable remedy.
    const ev = events.find((e) => e.type === "staging_outbound_workflow_scope_missing");
    expect(ev).toBeDefined();
    expect(ev!.project).toBe("ocannl");
    expect(ev!.message).toContain("gh auth refresh -h github.com -s workflow");
    // Core invariant: sentinel NOT touched → next tick retries + stale signal stays armed.
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
  });

  test("negative control: plain non-fast-forward rejection → error, generic event, sentinel TOUCHED", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-nff-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-nff-");
    const nffStderr = "! [remote rejected] origin/master -> master (non-fast-forward)";
    const events: Array<{ type: string; project: string }> = [];
    const { run } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "5\n" },
      push: { stdout: "", stderr: nffStderr, exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({ type: ev.type, project: ev.project }),
      },
    );
    expect(res[0]!.outcome).toBe("error");
    expect(events).toContainEqual({ type: "staging_outbound_error", project: "ocannl" });
    // Genuinely-stuck case keeps the 24h throttle: sentinel DOES exist.
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(true);
  });
});

describe("syncUpstreamMainFromStaging", () => {
  test("(a) happy push path: pushed, sentinel touched, exact argv, no force flags, event emitted", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const events: Array<{ type: string; project: string }> = [];
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "5\n" },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({ type: ev.type, project: ev.project }),
      },
    );
    expect(res[0]!.outcome).toBe("pushed");
    expect(res[0]!.advancedBy).toBe(5);
    // Exact argv assertion — closes reviewer finding 4. No --ff-only
    // (unsupported by git 2.50.1), no force flags, no `+` refspec.
    const pushCall = calls.find((c) => c[0] === "push");
    expect(pushCall).toEqual(["push", "upstream", "origin/master:master"]);
    // Negative-control assertions: future maintainers must not re-add
    // the unsupported --ff-only flag or any force variant.
    expect(pushCall!.includes("--ff-only")).toBe(false);
    expect(pushCall!.includes("--force")).toBe(false);
    expect(pushCall!.includes("--force-with-lease")).toBe(false);
    expect(pushCall!.some((a) => a.startsWith("+"))).toBe(false);
    // Sentinel touched.
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(true);
    // Event emitted.
    expect(events).toContainEqual({ type: "staging_outbound_fast_forwarded", project: "ocannl" });
    // No `reset`.
    expect(calls.some((c) => c[0] === "reset")).toBe(false);
  });

  test("(b) zero staging-only commits: skipped-no-staging-commits, sentinel touched, no push", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "0\n" },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-staging-commits");
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    // Sentinel TOUCHED — tick completed successfully.
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(true);
  });

  test("(c) ancestry check fails: skipped-not-fast-forward, divergedBy populated, no push, sentinel NOT touched", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    // AC 4: capture the FULL event object (not just { type }) so the
    // regression catches a future edit that drops the structured
    // divergence count from the payload. Reviewer round-2 (2026-05-19):
    // the prior `{ type }`-only capture would have let the count
    // disappear silently.
    const events: Array<{ type: string; project: string; message: string; extra?: Record<string, unknown> }> = [];
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 1 },
      revListLeftRight: { stdout: "3\t5\n" },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({
          type: ev.type,
          project: ev.project,
          message: ev.message,
          extra: ev.extra,
        }),
      },
    );
    expect(res[0]!.outcome).toBe("skipped-not-fast-forward");
    expect(res[0]!.divergedBy).toBe(3);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    // Sentinel NOT touched — divergence must stay visible.
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
    // AC 4: the structured divergence count is in the event PAYLOAD,
    // not only the formatted message or the result. The reviewer
    // round-2 invariant: a future edit that drops `extra.divergedBy`
    // from the event must fail this assertion. Mutation test: replace
    // `extra: parsed ? { divergedBy: parsed.behind, ... } : {...}`
    // with `extra: {}` in src/staging-ff.ts and this assertion fails.
    const divergedEvent = events.find((e) => e.type === "staging_outbound_fast_forward_diverged");
    expect(divergedEvent).toBeDefined();
    expect(divergedEvent!.extra).toBeDefined();
    expect(divergedEvent!.extra!.divergedBy).toBe(3);
    expect(divergedEvent!.extra!.aheadBy).toBe(5);
    // Message also includes the count for human-readable surfaces.
    expect(divergedEvent!.message).toContain("3 commits");
  });

  // (d) Credentials-missing on push — three sub-tests through stderr,
  // three through stdout fallback. Each asserts sentinel NOT touched
  // and outcome === "skipped-no-push-credentials". The
  // `Authentication failed` literal is the AC's named stderr surface
  // (memory feedback_lint_syntactic_variants: enumerate variants).
  for (const literal of ["Permission denied (publickey).", "fatal: could not read Username for 'https://github.com'", "remote: Authentication failed"]) {
    test(`(d) push credentials missing via stderr: "${literal}"`, () => {
      const dir = mkdtempSync("/tmp/outbound-checkout-");
      const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
      const { run, calls } = outboundFakeGit({
        ancestry: { exitCode: 0 },
        revListCount: { stdout: "5\n" },
        push: { stdout: "", stderr: literal, exitCode: 128 },
      });
      const res = syncUpstreamMainFromStaging(
        [project("ocannl", dir)],
        { now: new Date(), runGit: run, sentinelDir },
      );
      expect(res[0]!.outcome).toBe("skipped-no-push-credentials");
      // Push WAS attempted, but classified.
      expect(calls.some((c) => c[0] === "push")).toBe(true);
      // Sentinel NOT touched.
      expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
    });
    test(`(d) push credentials missing via stdout fallback: "${literal}"`, () => {
      const dir = mkdtempSync("/tmp/outbound-checkout-");
      const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
      const { run } = outboundFakeGit({
        ancestry: { exitCode: 0 },
        revListCount: { stdout: "5\n" },
        push: { stdout: literal, stderr: "", exitCode: 128 },
      });
      const res = syncUpstreamMainFromStaging(
        [project("ocannl", dir)],
        { now: new Date(), runGit: run, sentinelDir },
      );
      expect(res[0]!.outcome).toBe("skipped-no-push-credentials");
      expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
    });
  }

  // Negative-control sibling — closes reviewer finding 1's invariant:
  // a non-credentials network failure on `push` must classify as
  // `error` AND touch the sentinel (matches inbound `error` policy,
  // avoids tick-spam on persistent outages).
  test("(d-neg) transient network push error: error, sentinel TOUCHED", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "5\n" },
      push: { stdout: "", stderr: "fatal: Network is unreachable", exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("error");
    expect(calls.some((c) => c[0] === "push")).toBe(true);
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(true);
  });

  test("(e) no upstream remote: skipped-no-upstream-remote, no fetch/merge/push", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      remote: { stdout: "origin\n" },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-upstream-remote");
    expect(calls.some((c) => c[0] === "fetch")).toBe(false);
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
  });

  test("(f) pull-before-push ordering: fetch upstream → fetch origin → local merge → ancestry → push", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      ancestry: { exitCode: 0 },
      revListCount: { stdout: "5\n" },
    });
    syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    const fetchUpstreamIdx = calls.findIndex((c) => c[0] === "fetch" && c[1] === "upstream");
    const fetchOriginIdx = calls.findIndex((c) => c[0] === "fetch" && c[1] === "origin");
    const localMergeIdx = calls.findIndex((c) => c[0] === "merge" && c[1] === "--ff-only" && c[2] === "origin/master");
    const ancestryIdx = calls.findIndex((c) => c[0] === "merge-base" && c[1] === "--is-ancestor");
    const pushIdx = calls.findIndex((c) => c[0] === "push");
    expect(fetchUpstreamIdx).toBeGreaterThanOrEqual(0);
    expect(fetchOriginIdx).toBeGreaterThan(fetchUpstreamIdx);
    expect(localMergeIdx).toBeGreaterThan(fetchOriginIdx);
    expect(ancestryIdx).toBeGreaterThan(localMergeIdx);
    expect(pushIdx).toBeGreaterThan(ancestryIdx);
  });

  test("(g) local cannot fast-forward to origin/<default>: skipped-local-staging-behind, no push, sentinel NOT touched", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const events: Array<{ type: string }> = [];
    const { run, calls } = outboundFakeGit({
      localMerge: { stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.", exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      {
        now: new Date(),
        runGit: run,
        sentinelDir,
        emitEvent: (ev) => events.push({ type: ev.type }),
      },
    );
    expect(res[0]!.outcome).toBe("skipped-local-staging-behind");
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
    expect(events).toContainEqual({ type: "staging_outbound_local_behind" });
  });

  test("(new) origin-fetch transient network failure: error, no push, sentinel TOUCHED (matches inbound error policy)", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      fetchOrigin: { stdout: "", stderr: "fatal: unable to access 'https://github.com/...': Could not resolve host: github.com", exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("error");
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(true);
  });

  test("(new) origin-fetch credentials failure: skipped-no-push-credentials, no merge/push, sentinel NOT touched", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      fetchOrigin: { stdout: "", stderr: "ERROR: Permission denied (publickey).", exitCode: 128 },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-push-credentials");
    // No local merge attempted after fetch-origin failed.
    expect(calls.some((c) => c[0] === "merge" && c[1] === "--ff-only")).toBe(false);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
  });

  test("dirty worktree: skipped-dirty-worktree, sentinel NOT touched, no push", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({
      status: { stdout: " M file.ts\n" },
    });
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-dirty-worktree");
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(existsSync(join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch"))).toBe(false);
  });

  test("throttled within 24h: outcome=throttled, zero git calls, independent of inbound sentinel", () => {
    const dir = mkdtempSync("/tmp/outbound-checkout-");
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    mkdirSync(dir, { recursive: true });
    // Pre-touch the OUTBOUND sentinel (not the inbound one).
    const sentinel = join(sentinelDir, "last-outbound-fast-forward-ocannl.epoch");
    writeFileSync(sentinel, "");
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(sentinel, recent, recent);
    const { run, calls } = outboundFakeGit({});
    const res = syncUpstreamMainFromStaging(
      [project("ocannl", dir)],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("throttled");
    expect(calls).toHaveLength(0);
    // Inbound sentinel was NOT created (proves the throttle keys on
    // the outbound filename, not the inbound one).
    expect(existsSync(join(sentinelDir, "last-fast-forward-ocannl.epoch"))).toBe(false);
  });

  test("non-existent checkout path: skipped-no-path, no git calls", () => {
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({});
    const res = syncUpstreamMainFromStaging(
      [project("ghost", "/does/not/exist/xyz-ludics-540-test")],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res[0]!.outcome).toBe("skipped-no-path");
    expect(calls).toHaveLength(0);
  });

  test("skips projects without upstream_repo", () => {
    const sentinelDir = mkdtempSync("/tmp/outbound-sentinel-");
    const { run, calls } = outboundFakeGit({});
    const res = syncUpstreamMainFromStaging(
      [{ name: "plain", repo: "o/r" } as ProjectConfig],
      { now: new Date(), runGit: run, sentinelDir },
    );
    expect(res).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
