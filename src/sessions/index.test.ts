import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { discoverAll } from "./index.ts";
import { discoverT3code } from "./discover-t3code.ts";
import * as serverMod from "../t3code/server.ts";

// gh-ludics-539: session discovery is gated behind mag.t3code_integration_enabled.
// Flag off → t3code discovery is skipped entirely (no server probe, no fallback
// log line); the legacy codex/claude scanners run directly.

let TMP: string;
const ORIGINAL = {
  HOME: process.env.HOME,
  CONFIG: process.env.LUDICS_CONFIG,
  HARNESS: process.env.LUDICS_HARNESS_DIR,
};

/** Write a config.yaml with the t3code flag on or off; point LUDICS_CONFIG at it. */
function writeConfig(t3codeEnabled: boolean): void {
  const dir = join(TMP, ".config", "ludics");
  mkdirSync(dir, { recursive: true });
  const magBlock = t3codeEnabled ? "mag:\n  t3code_integration_enabled: true\n" : "";
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state\nstate_path: harness\n${magBlock}`);
  process.env.LUDICS_CONFIG = configPath;
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-sessions-index-"));
  process.env.HOME = TMP;
  process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
});

afterEach(() => {
  if (ORIGINAL.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL.HOME;
  if (ORIGINAL.CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL.CONFIG;
  if (ORIGINAL.HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL.HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("discoverAll — t3code integration gate (gh-ludics-539)", () => {
  test("flag off: no serverStatus probe and no legacy-fallback log line", async () => {
    writeConfig(false);
    const statusSpy = spyOn(serverMod, "serverStatus");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await discoverAll(86_400);
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      // Invariant: with the flag off, discoverAll must not reach discoverT3code
      // — so serverStatus is never probed and the "falling back to legacy
      // scanners" line is never emitted. If the gate were removed, the flag-on
      // path below shows both would fire.
      expect(statusSpy).not.toHaveBeenCalled();
      expect(calls.some((l) => l.includes("falling back to legacy scanners"))).toBe(false);
    } finally {
      errSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("flag on: probes t3code then emits the legacy-fallback line (positive control)", async () => {
    writeConfig(true);
    const statusSpy = spyOn(serverMod, "serverStatus").mockResolvedValue({
      running: false,
    } as Awaited<ReturnType<typeof serverMod.serverStatus>>);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await discoverAll(86_400);
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      // Mutation evidence for the flag-off test: with the flag on, the t3code
      // path IS taken — serverStatus is probed and the fallback line fires.
      expect(statusSpy).toHaveBeenCalled();
      expect(calls.some((l) => l.includes("falling back to legacy scanners"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });
});

describe("discoverT3code — defense-in-depth gate (gh-ludics-539)", () => {
  test("flag off: returns [] without probing serverStatus or logging", async () => {
    writeConfig(false);
    const statusSpy = spyOn(serverMod, "serverStatus");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await discoverT3code();
      // Invariant: the early return fires before the serverStatus() probe and
      // before any console.error — a direct caller of discoverT3code never
      // touches the deliberately-down server while paused.
      expect(result).toEqual([]);
      expect(statusSpy).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.length).toBe(0);
    } finally {
      errSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("flag on: reaches the serverStatus probe (positive control)", async () => {
    writeConfig(true);
    const statusSpy = spyOn(serverMod, "serverStatus").mockResolvedValue({
      running: false,
    } as Awaited<ReturnType<typeof serverMod.serverStatus>>);
    try {
      const result = await discoverT3code();
      expect(result).toEqual([]);
      expect(statusSpy).toHaveBeenCalled();
    } finally {
      statusSpy.mockRestore();
    }
  });
});
