import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { startDashboardServer } from "./dashboard-server.ts";
import { withSyntheticHarness } from "./test-utils.ts";

// Regression for task-7c3ec5c9: startDashboardServer must validate the port
// BEFORE calling Bun.serve. On Bun 1.3.11 / macOS Bun.serve silently coerces
// out-of-range / non-integer ports to a listenable one (99999 → 65535, -1/NaN
// → a random free port, 1.5 → 1) instead of rejecting, so the server would
// listen on a port different from the one requested — and the dev mirror's
// spawnSync would hang forever waiting on the never-exiting listener.

const TTL = 3600;

describe("startDashboardServer port validation", () => {
  withSyntheticHarness(beforeEach, afterEach);
  const servers: Array<ReturnType<typeof startDashboardServer>> = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) void s.stop(true);
    // Tests may call makeDir() more than once (e.g. the boundary test creates
    // one dir per startDashboardServer call), so clean up every created dir,
    // not just the latest.
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeDir(): string {
    const dir = mkdtempSync("/tmp/ludics-dashsrv-test-");
    dirs.push(dir);
    return dir;
  }

  // Each value below is coerced (not rejected) by Bun.serve on this host; the
  // guard must reject every one of them. If the guard were removed, the call
  // would bind a real listener (leaking a server / a coerced port) instead of
  // throwing — that is the invariant these assertions enforce.
  for (const bad of [99999, 70000, 65536, -1, 1.5, NaN, Infinity]) {
    test(`rejects out-of-range / non-integer port ${bad}`, () => {
      expect(() => startDashboardServer(bad, makeDir(), TTL)).toThrow(RangeError);
    });
  }

  test("inclusive upper bound: guard admits 65535 (uses > not >=), rejects 65536", () => {
    // Mutation guard for `port > 65535`: flipping it to `>= 65535` would make
    // 65535 throw a RangeError, which this test would catch. Binding 65535 may
    // fail with EADDRINUSE on a busy host — that is NOT a guard rejection — so
    // the guard assertion checks only that no RangeError is raised for 65535
    // (honoring AC6: the test must not depend on any specific port being free).
    let server: ReturnType<typeof startDashboardServer> | undefined;
    let raised: unknown;
    try {
      server = startDashboardServer(65535, makeDir(), TTL);
    } catch (e) {
      raised = e;
    }
    if (server) {
      servers.push(server);
      // When binding succeeds, the valid port is honored verbatim (no coercion).
      expect(server.port).toBe(65535);
    }
    expect(raised).not.toBeInstanceOf(RangeError);
    expect(() => startDashboardServer(65536, makeDir(), TTL)).toThrow(RangeError);
  });

  test("error names the offending port value and the valid range", () => {
    let err: unknown;
    try {
      startDashboardServer(99999, makeDir(), TTL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    const msg = (err as Error).message;
    expect(msg).toContain("99999");
    expect(msg).toContain("65535");
  });

  test("port 0 stays valid and auto-selects a free OS port", () => {
    const server = startDashboardServer(0, makeDir(), TTL);
    servers.push(server);
    // 0 means "pick a free port"; Bun reports the actual bound port (> 0).
    expect(server.port).toBeGreaterThan(0);
  });

});
