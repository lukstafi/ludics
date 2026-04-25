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
  void probe.stop(true);
} catch {
  canBindSocket = false;
}

type ConsoleChannel = "log" | "error" | "warn";

function withConsoleOverride(
  channel: ConsoleChannel,
  override: (...args: unknown[]) => void,
  fn: () => void,
): void {
  const orig = console[channel];
  console[channel] = override;
  try {
    fn();
  } finally {
    console[channel] = orig;
  }
}

function captureLines(channel: ConsoleChannel, fn: () => void): string[] {
  const lines: string[] = [];
  withConsoleOverride(channel, (...args: unknown[]) => {
    lines.push(args.map((a) => String(a ?? "")).join(" "));
  }, fn);
  return lines;
}

/** Capture lines written to `console.log` while running `fn`; restores on return or throw. */
export function captureConsoleLog(fn: () => void): string[] {
  return captureLines("log", fn);
}

/** Capture lines written to `console.error` while running `fn`; restores on return or throw. */
export function captureConsoleError(fn: () => void): string[] {
  return captureLines("error", fn);
}

/** Run `fn` with `console.error` no-op'd; restores on return or throw. */
export function silenceConsoleError(fn: () => void): void {
  withConsoleOverride("error", () => {}, fn);
}

/** Run `fn` with `console.warn` no-op'd; restores on return or throw. */
export function silenceConsoleWarn(fn: () => void): void {
  withConsoleOverride("warn", () => {}, fn);
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
