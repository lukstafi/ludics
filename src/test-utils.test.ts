import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { withTestHarness } from "./test-utils.ts";

function captureHooks(): {
  before: (fn: () => void) => void;
  after: (fn: () => void) => void;
  runBefore: () => void;
  runAfter: () => void;
} {
  const beforeFns: Array<() => void> = [];
  const afterFns: Array<() => void> = [];
  return {
    before: (fn) => { beforeFns.push(fn); },
    after: (fn) => { afterFns.push(fn); },
    runBefore: () => { for (const fn of beforeFns) fn(); },
    runAfter: () => { for (const fn of afterFns) fn(); },
  };
}

describe("withTestHarness", () => {
  test("sets LUDICS_HARNESS_DIR to a fresh tmpdir matching the getter", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    const hooks = captureHooks();
    const getHarness = withTestHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getHarness();
      expect(dir).not.toBe("");
      expect(existsSync(dir)).toBe(true);
      expect(process.env.LUDICS_HARNESS_DIR).toBe(dir);
    } finally {
      hooks.runAfter();
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });

  test("restores a captured sentinel value and removes the tmpdir", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = "/sentinel";
    const hooks = captureHooks();
    const getHarness = withTestHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getHarness();
      expect(existsSync(dir)).toBe(true);
      hooks.runAfter();
      expect(process.env.LUDICS_HARNESS_DIR).toBe("/sentinel");
      expect(existsSync(dir)).toBe(false);
    } finally {
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });

  test("restores undefined when original was unset (not the literal 'undefined')", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    delete process.env.LUDICS_HARNESS_DIR;
    const hooks = captureHooks();
    const getHarness = withTestHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getHarness();
      expect(existsSync(dir)).toBe(true);
      hooks.runAfter();
      expect(process.env.LUDICS_HARNESS_DIR).toBeUndefined();
      expect(process.env.LUDICS_HARNESS_DIR).not.toBe("undefined");
      expect(existsSync(dir)).toBe(false);
    } finally {
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });

  test("returns a fresh tmpdir on each before/after cycle", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    const hooks = captureHooks();
    const getHarness = withTestHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const first = getHarness();
      hooks.runAfter();
      hooks.runBefore();
      const second = getHarness();
      hooks.runAfter();
      expect(first).not.toBe(second);
    } finally {
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });

  test("double registration: each helper restores the real original, not a sibling's temp dir", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = "/real-original";
    const hooksA = captureHooks();
    const hooksB = captureHooks();
    try {
      // Both helpers register at the same "real original" — i.e. before any before() runs.
      withTestHarness(hooksA.before, hooksA.after);
      withTestHarness(hooksB.before, hooksB.after);

      // Simulate per-test lifecycle with both helpers active.
      hooksA.runBefore();
      hooksB.runBefore();
      expect(process.env.LUDICS_HARNESS_DIR).not.toBe("/real-original");
      // Teardown in either order must land back on the real original, never a sibling's tmpdir.
      hooksA.runAfter();
      hooksB.runAfter();
      expect(process.env.LUDICS_HARNESS_DIR).toBe("/real-original");
    } finally {
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });
});
