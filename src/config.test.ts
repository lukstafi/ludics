import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  postponedProjectSet,
  effectivePriority,
  _resetPostponedProjectsCache,
  _resetPriorityProjectsCache,
  _peekPriorityProjectsCache,
} from "./config.ts";

const TMP = join(import.meta.dir, ".test-tmp-config");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
projects:
  - name: alpha
    repo: owner/alpha
    priority: true
  - name: beta
    repo: owner/beta
    postponed: true
  - name: gamma
    repo: owner/gamma
    postponed: true
`);
  return configPath;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");
  _resetPostponedProjectsCache();
  _resetPriorityProjectsCache();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  _resetPostponedProjectsCache();
  _resetPriorityProjectsCache();
  rmSync(TMP, { recursive: true, force: true });
});

describe("postponedProjectSet cache", () => {
  test("returns the same singleton reference across calls (cache identity)", () => {
    const first = postponedProjectSet();
    const second = postponedProjectSet();
    expect(first).toBe(second);
    expect(first.has("beta")).toBe(true);
    expect(first.has("gamma")).toBe(true);
  });

  test("mutator methods (add/delete/clear) throw via the Proxy trap", () => {
    const set = postponedProjectSet();
    // TypeScript's ReadonlySet blocks these at compile time; we cast through
    // `unknown` to a mutable Set to drive the runtime trap.
    const mutable = set as unknown as Set<string>;
    expect(() => mutable.add("evil")).toThrow(TypeError);
    expect(() => mutable.delete("beta")).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    // Cache is not polluted: the original membership still holds, identity
    // unchanged.
    expect(postponedProjectSet()).toBe(set);
    expect(postponedProjectSet().has("beta")).toBe(true);
    expect(postponedProjectSet().has("gamma")).toBe(true);
    expect(postponedProjectSet().has("evil")).toBe(false);
  });

  test("read methods (has, size, iteration) still work", () => {
    const set = postponedProjectSet();
    expect(set.size).toBe(2);
    expect(set.has("beta")).toBe(true);
    expect(set.has("alpha")).toBe(false);
    const collected: string[] = [];
    for (const p of set) collected.push(p);
    expect(collected.sort()).toEqual(["beta", "gamma"]);
  });

  test("eviction (cache reset) replaces the singleton — post-reset reference is not the pre-reset one", () => {
    const beforeReset = postponedProjectSet();
    // Mid-call identity is preserved while the cache is live.
    expect(postponedProjectSet()).toBe(beforeReset);

    _resetPostponedProjectsCache();

    const afterReset = postponedProjectSet();
    expect(afterReset).not.toBe(beforeReset);
    // Both reflect the same on-disk config state (no config rewrite).
    expect(afterReset.has("beta")).toBe(true);
    expect(afterReset.has("gamma")).toBe(true);
  });
});

describe("priorityProjectSet cache", () => {
  test("returns the same singleton reference across calls (cache identity)", () => {
    // Pre-eviction reference: first effectivePriority call materializes the
    // cache; capture via the test-only peek helper.
    expect(_peekPriorityProjectsCache()).toBeNull();
    expect(effectivePriority("C", "alpha")).toBe("B");
    const beforeReset = _peekPriorityProjectsCache();
    expect(beforeReset).not.toBeNull();
    // Mid-fill identity: a subsequent effectivePriority call must hit the
    // same cached set, not allocate a fresh one. If priorityProjectSet()
    // started returning a fresh ReadonlySet each call (while preserving
    // .has() semantics) this assertion would fail.
    expect(effectivePriority("C", "alpha")).toBe("B");
    expect(_peekPriorityProjectsCache()).toBe(beforeReset);
    expect(effectivePriority("C", "beta")).toBe("C");
    expect(_peekPriorityProjectsCache()).toBe(beforeReset);
  });

  test("eviction (cache reset) replaces the singleton — post-reset reference is not the pre-reset one", () => {
    expect(effectivePriority("C", "alpha")).toBe("B");
    const beforeReset = _peekPriorityProjectsCache();
    expect(beforeReset).not.toBeNull();

    _resetPriorityProjectsCache();
    // Reset clears the singleton — peek must return null until next call.
    expect(_peekPriorityProjectsCache()).toBeNull();

    // Rewrite config to make beta (not alpha) the priority project, so the
    // post-reset re-read both materialises a *different* ReadonlySet
    // reference AND reflects the new on-disk state.
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: alpha
    repo: owner/alpha
  - name: beta
    repo: owner/beta
    priority: true
`);

    expect(effectivePriority("C", "alpha")).toBe("C");
    const afterReset = _peekPriorityProjectsCache();
    expect(afterReset).not.toBeNull();
    expect(afterReset).not.toBe(beforeReset);
    // Behaviour cross-check: fresh load reflects new config.
    expect(effectivePriority("C", "beta")).toBe("B");
  });

  test("stale cache (no reset) ignores config rewrite — proves the cache served by identity, not re-read", () => {
    expect(effectivePriority("C", "alpha")).toBe("B");
    const beforeRewrite = _peekPriorityProjectsCache();

    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: alpha
    repo: owner/alpha
  - name: beta
    repo: owner/beta
    priority: true
`);

    // Without reset: same singleton reference, same stale boost.
    expect(effectivePriority("C", "alpha")).toBe("B");
    expect(_peekPriorityProjectsCache()).toBe(beforeRewrite);
  });
});
