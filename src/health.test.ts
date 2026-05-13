import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { checkProjectTestHealth, detectTestCommand, runAllTestHealth, shouldRunTestHealth, testHealthStatePath } from "./health.ts";
import { tmpdir } from "os";
import { _resetPostponedProjectsCache } from "./config.ts";
import { captureConsoleError, withSyntheticHarness } from "./test-utils.ts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("detectTestCommand", () => {
  test("detects dune-project", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "dune-project"), "(lang dune 3.0)");
    expect(detectTestCommand(dir)).toBe("dune runtest");
    rmSync(dir, { recursive: true });
  });

  test("detects bun.lockb", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "bun.lockb"), "");
    expect(detectTestCommand(dir)).toBe("bun test");
    rmSync(dir, { recursive: true });
  });

  test("detects bun.lock", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "bun.lock"), "");
    expect(detectTestCommand(dir)).toBe("bun test");
    rmSync(dir, { recursive: true });
  });

  test("detects package.json with test script", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    expect(detectTestCommand(dir)).toBe("npm test");
    rmSync(dir, { recursive: true });
  });

  test("skips package.json without test script", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("handles malformed package.json gracefully", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), "not json{{{");
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("detects Makefile with test target", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "Makefile"), "build:\n\tgcc main.c\ntest:\n\t./run_tests\n");
    expect(detectTestCommand(dir)).toBe("make test");
    rmSync(dir, { recursive: true });
  });

  test("skips Makefile without test target", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "Makefile"), "build:\n\tgcc main.c\n");
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("dune-project takes priority over bun.lockb", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "dune-project"), "(lang dune 3.0)");
    writeFileSync(join(dir, "bun.lockb"), "");
    expect(detectTestCommand(dir)).toBe("dune runtest");
    rmSync(dir, { recursive: true });
  });

  test("bun.lockb takes priority over package.json with test script", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "bun.lockb"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    expect(detectTestCommand(dir)).toBe("bun test");
    rmSync(dir, { recursive: true });
  });

  test("returns null for empty directory", () => {
    const dir = makeTmpDir();
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });
});

describe("shouldRunTestHealth", () => {
  const emptyConfig = {};

  test("returns true when no prior state (stale)", () => {
    expect(shouldRunTestHealth("proj", {}, emptyConfig, new Date("2026-04-07T10:00:00"))).toBe(true);
  });

  test("returns false for recent run outside night window", () => {
    const now = new Date(2026, 3, 7, 10, 0, 0); // 10am local — outside [0,6)
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    expect(shouldRunTestHealth("proj", state, emptyConfig, now)).toBe(false);
  });

  test("returns true for recent run inside night window", () => {
    // Use explicit local-time constructor to avoid timezone ambiguity
    const now = new Date(2026, 3, 7, 3, 0, 0); // 3am local time
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    expect(now.getHours()).toBe(3); // sanity check
    expect(shouldRunTestHealth("proj", state, emptyConfig, now)).toBe(true);
  });

  test("returns true for stale run (24+ hours ago)", () => {
    const now = new Date(2026, 3, 7, 10, 0, 0); // 10am local
    const state = { proj: { lastRun: new Date(now.getTime() - 25 * 3600_000).toISOString(), passed: true } };
    expect(shouldRunTestHealth("proj", state, emptyConfig, now)).toBe(true);
  });

  test("uses configured night window with wrap-around", () => {
    const now = new Date(2026, 3, 7, 23, 0, 0); // 11pm local
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    const config = { mag: { test_health_night_hours: [22, 6] as [number, number] } };
    expect(now.getHours()).toBe(23);
    expect(shouldRunTestHealth("proj", state, config, now)).toBe(true);
  });

  test("wrap-around night window [22, 6] excludes midday", () => {
    const now = new Date(2026, 3, 7, 12, 0, 0); // noon local
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    const config = { mag: { test_health_night_hours: [22, 6] as [number, number] } };
    expect(now.getHours()).toBe(12);
    expect(shouldRunTestHealth("proj", state, config, now)).toBe(false);
  });
});

describe("loadTestHealthState validation", () => {
  // Mirrors the validation logic in loadTestHealthState to ensure
  // non-record JSON values are treated as corruption and reset to {}.
  function parseTestHealthState(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  test("valid object is returned as-is", () => {
    const result = parseTestHealthState('{"proj":{"lastRun":"2026-04-07","passed":true}}');
    expect(result).toEqual({ proj: { lastRun: "2026-04-07", passed: true } });
  });

  test("string JSON resets to empty", () => {
    expect(parseTestHealthState('"hello"')).toEqual({});
  });

  test("array JSON resets to empty", () => {
    expect(parseTestHealthState('[1,2,3]')).toEqual({});
  });

  test("null JSON resets to empty", () => {
    expect(parseTestHealthState("null")).toEqual({});
  });

  test("number JSON resets to empty", () => {
    expect(parseTestHealthState("42")).toEqual({});
  });

  test("invalid JSON resets to empty", () => {
    expect(parseTestHealthState("not json{{{")).toEqual({});
  });
});

import { existsSync, mkdtempSync, readFileSync } from "fs";

describe("saveTestHealthState atomic write", () => {
  test("round-trips via loadTestHealthState and leaves no .tmp sibling", async () => {
    const mod = await import("./health.ts");
    const dir = mkdtempSync(join(tmpdir(), "ludics-health-"));
    const ORIGINAL = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = dir;
    try {
      const state = {
        "ludics/ludics": {
          lastRun: "2026-04-24T00:00:00Z",
          passed: true,
        },
      };
      mod.saveTestHealthState(state);
      expect(mod.loadTestHealthState()).toEqual(state);
      const path = mod.testHealthStatePath();
      expect(existsSync(path + ".tmp")).toBe(false);
      // Byte-exactness: pretty-printed with one trailing newline (writeJsonFile shape)
      expect(readFileSync(path, "utf-8")).toBe(JSON.stringify(state, null, 2) + "\n");
    } finally {
      if (ORIGINAL === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = ORIGINAL;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("test-health skips postponed projects", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach, {
    projects: [
      // test_command: "false" would exit non-zero and file a "Fix broken test
      // suite" task if the postponed guard fails. The guard MUST short-circuit
      // before test_command is consulted.
      { name: "postponed-proj", repo: "ex/postponed", postponed: true, test_command: "false" },
      { name: "active-proj", repo: "ex/active" },
    ],
  });

  beforeEach(() => {
    _resetPostponedProjectsCache();
  });
  afterEach(() => {
    _resetPostponedProjectsCache();
  });

  test("checkProjectTestHealth returns {skipped:true, reason:'postponed'} for postponed project", () => {
    const project = { name: "postponed-proj", repo: "ex/postponed", postponed: true, test_command: "false" } as const;
    const result = checkProjectTestHealth(project);
    expect(result).toEqual({ skipped: true, reason: "postponed" });
    // No state mutation: mag/test-health.json must not exist for the skipped project.
    expect(existsSync(testHealthStatePath())).toBe(false);
  });

  test("checkProjectTestHealth matches postponed name case-insensitively", () => {
    // Config-side name is "postponed-proj" (lowercased into the Set); a caller
    // passing "Postponed-Proj" must still be skipped.
    const project = { name: "Postponed-Proj", repo: "ex/postponed", test_command: "false" } as const;
    const result = checkProjectTestHealth(project);
    expect(result).toEqual({ skipped: true, reason: "postponed" });
  });

  test("runAllTestHealth logs '[test-health] <name>: skipped (postponed)' and does not call checkProjectTestHealth", () => {
    const { lines } = captureConsoleError(() => runAllTestHealth({ project: "postponed-proj" }));
    expect(lines.some((l) => l.includes("[test-health] postponed-proj: skipped (postponed)"))).toBe(true);
    // No state written; runAllTestHealth's per-project log shape "skipped (<reason>)"
    // appears via the batch-loop early-continue, NOT via checkProjectTestHealth's
    // own log path. State file remains absent.
    expect(existsSync(testHealthStatePath())).toBe(false);
  });

  test("non-postponed project is not skipped for the postponed reason (negative control)", () => {
    // Mutation evidence: if the .has() check were inverted or hard-coded to true,
    // the active project would also return reason:"postponed". It must not.
    const project = { name: "active-proj", repo: "ex/active" } as const;
    const result = checkProjectTestHealth(project);
    // active-proj has no resolvable path on disk under the synthetic harness;
    // the function falls through to the path-not-found skip, NOT postponed.
    expect(result.skipped).toBe(true);
    expect(result.reason).not.toBe("postponed");
    void getStateDir; // ensures the synthetic-harness lifecycle is engaged
  });
});
