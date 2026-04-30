import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import YAML from "yaml";
import {
  captureConsoleError,
  captureConsoleLog,
  silenceConsoleError,
  silenceConsoleWarn,
  withSyntheticHarness,
  withTestHarness,
} from "./test-utils.ts";

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

describe("withSyntheticHarness", () => {
  function snapshotEnv(): { harness: string | undefined; config: string | undefined; cluster: string | undefined } {
    return {
      harness: process.env.LUDICS_HARNESS_DIR,
      config: process.env.LUDICS_CONFIG,
      cluster: process.env.LUDICS_CLUSTER_MACHINE_NAME,
    };
  }
  function restoreEnv(s: { harness: string | undefined; config: string | undefined; cluster: string | undefined }): void {
    if (s.harness === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = s.harness;
    if (s.config === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = s.config;
    if (s.cluster === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
    else process.env.LUDICS_CLUSTER_MACHINE_NAME = s.cluster;
  }

  test("sets all three env vars correctly during a before/after cycle", () => {
    const pre = snapshotEnv();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "before-helper";
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getDir();
      expect(dir).not.toBe("");
      expect(existsSync(dir)).toBe(true);
      expect(process.env.LUDICS_HARNESS_DIR).toBe(dir);
      expect(process.env.LUDICS_CONFIG).toBe(`${dir}/config.yaml`);
      // LUDICS_CLUSTER_MACHINE_NAME must be cleared, not set to "undefined".
      expect(process.env.LUDICS_CLUSTER_MACHINE_NAME).toBeUndefined();
    } finally {
      hooks.runAfter();
      restoreEnv(pre);
    }
  });

  test("restores captured sentinel values after teardown", () => {
    const pre = snapshotEnv();
    process.env.LUDICS_HARNESS_DIR = "/sentinel-harness";
    process.env.LUDICS_CONFIG = "/sentinel-config";
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "sentinel-cluster";
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getDir();
      expect(existsSync(dir)).toBe(true);
      hooks.runAfter();
      expect(process.env.LUDICS_HARNESS_DIR).toBe("/sentinel-harness");
      expect(process.env.LUDICS_CONFIG).toBe("/sentinel-config");
      expect(process.env.LUDICS_CLUSTER_MACHINE_NAME).toBe("sentinel-cluster");
      expect(existsSync(dir)).toBe(false);
    } finally {
      restoreEnv(pre);
    }
  });

  test("restores undefined when originals were unset (not the literal 'undefined')", () => {
    const pre = snapshotEnv();
    delete process.env.LUDICS_HARNESS_DIR;
    delete process.env.LUDICS_CONFIG;
    delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getDir();
      expect(existsSync(dir)).toBe(true);
      hooks.runAfter();
      expect(process.env.LUDICS_HARNESS_DIR).toBeUndefined();
      expect(process.env.LUDICS_HARNESS_DIR).not.toBe("undefined");
      expect(process.env.LUDICS_CONFIG).toBeUndefined();
      expect(process.env.LUDICS_CONFIG).not.toBe("undefined");
      expect(process.env.LUDICS_CLUSTER_MACHINE_NAME).toBeUndefined();
      expect(process.env.LUDICS_CLUSTER_MACHINE_NAME).not.toBe("undefined");
      expect(existsSync(dir)).toBe(false);
    } finally {
      restoreEnv(pre);
    }
  });

  test("config.yaml is written with projects: [] by default", () => {
    const pre = snapshotEnv();
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getDir();
      const cfgPath = `${dir}/config.yaml`;
      expect(existsSync(cfgPath)).toBe(true);
      const parsed = YAML.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
      expect(parsed.state_repo).toBe("test/state");
      expect(parsed.state_path).toBe("harness");
      expect(parsed.projects).toEqual([]);
    } finally {
      hooks.runAfter();
      restoreEnv(pre);
    }
  });

  test("config.yaml reflects an explicit projects override when provided", () => {
    const pre = snapshotEnv();
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after, {
      projects: [
        { name: "alpha", repo: "user/alpha" },
        { name: "beta", repo: "user/beta", issues: true },
      ],
    });
    try {
      hooks.runBefore();
      const dir = getDir();
      const cfgPath = `${dir}/config.yaml`;
      const parsed = YAML.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
      expect(parsed.projects).toEqual([
        { name: "alpha", repo: "user/alpha" },
        { name: "beta", repo: "user/beta", issues: true },
      ]);
    } finally {
      hooks.runAfter();
      restoreEnv(pre);
    }
  });

  test("tmpdir is removed after teardown", () => {
    const pre = snapshotEnv();
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const dir = getDir();
      expect(existsSync(dir)).toBe(true);
      hooks.runAfter();
      expect(existsSync(dir)).toBe(false);
    } finally {
      restoreEnv(pre);
    }
  });

  test("returns a fresh tmpdir on each before/after cycle", () => {
    const pre = snapshotEnv();
    const hooks = captureHooks();
    const getDir = withSyntheticHarness(hooks.before, hooks.after);
    try {
      hooks.runBefore();
      const first = getDir();
      hooks.runAfter();
      hooks.runBefore();
      const second = getDir();
      hooks.runAfter();
      expect(first).not.toBe(second);
    } finally {
      restoreEnv(pre);
    }
  });

  test("double registration: each helper restores the real original, not a sibling's tmpdir or config path", () => {
    const pre = snapshotEnv();
    process.env.LUDICS_HARNESS_DIR = "/real-harness";
    process.env.LUDICS_CONFIG = "/real-config";
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "real-cluster";
    const hooksA = captureHooks();
    const hooksB = captureHooks();
    try {
      // Both helpers register at the same "real original" — i.e. before any before() runs.
      withSyntheticHarness(hooksA.before, hooksA.after);
      withSyntheticHarness(hooksB.before, hooksB.after);

      // Simulate per-test lifecycle with both helpers active.
      hooksA.runBefore();
      hooksB.runBefore();
      expect(process.env.LUDICS_HARNESS_DIR).not.toBe("/real-harness");
      expect(process.env.LUDICS_CONFIG).not.toBe("/real-config");
      expect(process.env.LUDICS_CLUSTER_MACHINE_NAME).toBeUndefined();
      // Teardown in either order must land back on the real originals.
      hooksA.runAfter();
      hooksB.runAfter();
      expect(process.env.LUDICS_HARNESS_DIR).toBe("/real-harness");
      expect(process.env.LUDICS_CONFIG).toBe("/real-config");
      expect(process.env.LUDICS_CLUSTER_MACHINE_NAME).toBe("real-cluster");
    } finally {
      restoreEnv(pre);
    }
  });
});

describe("captureConsoleLog", () => {
  test("returns lines and restores console.log", () => {
    const orig = console.log;
    const { lines } = captureConsoleLog(() => {
      console.log("hello");
      console.log("world", 42);
    });
    expect(lines).toEqual(["hello", "world 42"]);
    expect(console.log).toBe(orig);
  });

  test("restores console.log when fn throws and propagates", () => {
    const orig = console.log;
    expect(() => {
      captureConsoleLog(() => {
        console.log("before throw");
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(console.log).toBe(orig);
  });

  test("stringifies null arg as empty string (not 'null')", () => {
    const { lines } = captureConsoleLog(() => {
      console.log(null);
    });
    expect(lines).toEqual([""]);
  });

  test("returns fn's value alongside captured lines (T = number)", () => {
    const result = captureConsoleLog(() => {
      console.log("side-effect");
      return 42;
    });
    expect(result.value).toBe(42);
    expect(result.lines).toEqual(["side-effect"]);
  });

  test("infers T = void when fn returns nothing (caller-compat)", () => {
    const result = captureConsoleLog(() => {
      console.log("just side effects");
    });
    expect(result.lines).toEqual(["just side effects"]);
    expect(result.value).toBeUndefined();
  });
});

describe("captureConsoleError", () => {
  test("returns lines and restores console.error", () => {
    const orig = console.error;
    const { lines } = captureConsoleError(() => {
      console.error("a", "b");
      console.error("c");
    });
    expect(lines).toEqual(["a b", "c"]);
    expect(console.error).toBe(orig);
  });

  test("restores console.error when fn throws and propagates", () => {
    const orig = console.error;
    expect(() => {
      captureConsoleError(() => {
        console.error("oops");
        throw new Error("kaboom");
      });
    }).toThrow("kaboom");
    expect(console.error).toBe(orig);
  });

  test("returns fn's value alongside captured lines (T = string)", () => {
    const result = captureConsoleError(() => {
      console.error("warn-1");
      return "the-return";
    });
    expect(result.value).toBe("the-return");
    expect(result.lines).toEqual(["warn-1"]);
  });
});

describe("silenceConsoleError", () => {
  test("suppresses output and restores console.error", () => {
    const orig = console.error;
    const seen: unknown[] = [];
    console.error = (...args: unknown[]) => { seen.push(args); };
    try {
      silenceConsoleError(() => {
        console.error("must not be seen");
      });
      expect(seen).toEqual([]);
      console.error("seen-after");
      expect(seen).toEqual([["seen-after"]]);
    } finally {
      console.error = orig;
    }
  });

  test("restores console.error when fn throws and propagates", () => {
    const orig = console.error;
    expect(() => {
      silenceConsoleError(() => {
        throw new Error("silence-err");
      });
    }).toThrow("silence-err");
    expect(console.error).toBe(orig);
  });

  test("returns fn's value (T = number)", () => {
    const value = silenceConsoleError(() => {
      console.error("muted");
      return 7;
    });
    expect(value).toBe(7);
  });

  test("returns fn's value (T = object identity)", () => {
    const sentinel = { id: "sentinel" };
    const value = silenceConsoleError(() => sentinel);
    expect(value).toBe(sentinel);
  });
});

describe("silenceConsoleWarn", () => {
  test("suppresses output and restores console.warn", () => {
    const orig = console.warn;
    const seen: unknown[] = [];
    console.warn = (...args: unknown[]) => { seen.push(args); };
    try {
      silenceConsoleWarn(() => {
        console.warn("must not be seen");
      });
      expect(seen).toEqual([]);
      console.warn("seen-after");
      expect(seen).toEqual([["seen-after"]]);
    } finally {
      console.warn = orig;
    }
  });

  test("restores console.warn when fn throws and propagates", () => {
    const orig = console.warn;
    expect(() => {
      silenceConsoleWarn(() => {
        throw new Error("silence-warn");
      });
    }).toThrow("silence-warn");
    expect(console.warn).toBe(orig);
  });

  test("returns fn's value (T = string)", () => {
    const value = silenceConsoleWarn(() => {
      console.warn("muted");
      return "warn-return";
    });
    expect(value).toBe("warn-return");
  });
});
