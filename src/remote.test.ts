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
import { classifyRemoteResult } from "./remote.ts";
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
