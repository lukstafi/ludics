// Remote-exec classification tests (gh-ludics-578).
//
// classifyRemoteResult is the AC5 "skip-on-connectivity-failure" guarantee: it
// decides whether a routed test-health run actually executed the suite (→ may
// file a fix-task) or hit a transport failure (→ must degrade to skip-not-fail,
// never a false-positive task). The invariant under test: ssh/transport failures
// (exit 255, spawn/timeout exit -1, or timedOut) classify as `transport-error`,
// while a remote command that genuinely ran classifies as `ran` carrying its
// real pass/fail.

import { describe, test, expect } from "bun:test";
import { buildRemoteScript, classifyRemoteResult } from "./remote.ts";
import type { SyncResult } from "./spawn.ts";

function syncResult(over: Partial<SyncResult>): SyncResult {
  return { ok: false, exitCode: 1, stdout: "", stderr: "", timedOut: false, ...over };
}

describe("classifyRemoteResult", () => {
  test("ssh exit 255 (connection/auth failure) → transport-error", () => {
    const r = classifyRemoteResult(syncResult({ ok: false, exitCode: 255, stderr: "ssh: connect to host: Connection refused" }));
    expect(r.kind).toBe("transport-error");
  });

  test("exit -1 (spawn/ENOENT or local timeout) → transport-error", () => {
    const r = classifyRemoteResult(syncResult({ ok: false, exitCode: -1, stderr: "spawn ssh ENOENT" }));
    expect(r.kind).toBe("transport-error");
  });

  test("timedOut (run never completed) → transport-error, even with exitCode -1", () => {
    const r = classifyRemoteResult(syncResult({ ok: false, exitCode: -1, timedOut: true }));
    expect(r.kind).toBe("transport-error");
  });

  test("exit 1 (remote command actually ran and failed) → ran with ok:false", () => {
    // The mutation guard for AC5: a real non-zero TEST result must NOT be
    // swallowed as transport — it is the only thing that may file a fix-task.
    const r = classifyRemoteResult(syncResult({ ok: false, exitCode: 1, stdout: "FAILED 3 tests" }));
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") {
      expect(r.ok).toBe(false);
      expect(r.stdout).toBe("FAILED 3 tests");
    }
  });

  test("exit 0 (remote suite passed) → ran with ok:true", () => {
    const r = classifyRemoteResult(syncResult({ ok: true, exitCode: 0, stdout: "ok" }));
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.ok).toBe(true);
  });
});

describe("buildRemoteScript", () => {
  test("cd-failure is forced to the SSH transport sentinel (exit 255), not a test exit", () => {
    // Invariant for skip-not-fail: a missing/invalid remote checkout must NOT
    // reach the test command as a normal non-255 shell failure (which
    // classifyRemoteResult would treat as `ran`/ok:false → a false fix-task).
    // `|| exit 255` maps the cd failure onto ssh's transport sentinel, which the
    // classifier above routes to transport-error → skip. Mutation: dropping the
    // `|| exit 255` (back to `cd X && cmd`) makes a missing-checkout `cd` exit 1.
    expect(buildRemoteScript("~/ocaml-cudajit", "dune runtest")).toBe("cd ~/ocaml-cudajit || exit 255; dune runtest");
  });

  test("classifying a forced cd-failure (exit 255) yields a transport-error skip", () => {
    // End-to-end of the two-step chain: buildRemoteScript emits `|| exit 255`, a
    // failed cd produces exit 255, classifyRemoteResult → transport-error.
    expect(classifyRemoteResult(syncResult({ ok: false, exitCode: 255, stderr: "bash: cd: ~/missing: No such file or directory" })).kind).toBe("transport-error");
  });
});
