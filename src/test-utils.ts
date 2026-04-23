// Shared test utilities for the ludics test suite.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Whether this environment can bind a loopback socket.
 * Use with `describe.if(canBindSocket)(...)` to skip network tests
 * in environments where socket binding is restricted.
 */
export let canBindSocket = true;
try {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() { return new Response("ok"); },
  });
  probe.stop(true);
} catch {
  canBindSocket = false;
}

/** Isolate LUDICS_HARNESS_DIR to a fresh tmpdir per test; returns a getter for the current path. */
export function withTestHarness(
  before: (fn: () => void) => void,
  after: (fn: () => void) => void,
): () => string {
  // Capture the real original at registration time, not inside `before`. If a file
  // registers the helper twice, capturing inside `before` would let the second
  // registration save the first helper's temp path and leak a stale (deleted) dir
  // into later tests.
  const saved = process.env.LUDICS_HARNESS_DIR;
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ludics-test-harness-"));
    process.env.LUDICS_HARNESS_DIR = dir;
  });
  after(() => {
    if (saved === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}
