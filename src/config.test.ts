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

// ---------------------------------------------------------------------------
// task-b43bd578 — writeOrchestrationDefaults round-trip + null persistence.
// ---------------------------------------------------------------------------

describe("writeOrchestrationDefaults", () => {
  test("sets both keys under mag.orchestration", async () => {
    const { readFileSync } = await import("fs");
    const { writeOrchestrationDefaults } = await import("./config.ts");
    // Overwrite the beforeEach config with a minimal fixture that
    // exercises the round-trip behaviour (already exists at LUDICS_CONFIG).
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, "state_repo: owner/ludics-state\nstate_path: harness\nmag:\n  orchestration:\n    default_mode: pair\n");
    writeOrchestrationDefaults({ coder: "codex", reviewer: "claude-code" });
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/default_coder:\s*codex/);
    expect(raw).toMatch(/default_reviewer:\s*claude-code/);
  });

  test("persists null as YAML 'null' (does NOT delete the key)", async () => {
    const { readFileSync } = await import("fs");
    const { writeOrchestrationDefaults } = await import("./config.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, "state_repo: owner/ludics-state\nstate_path: harness\nmag:\n  orchestration:\n    default_mode: pair\n    default_coder: claude-code\n    default_reviewer: codex\n");
    writeOrchestrationDefaults({ coder: null, reviewer: "codex" });
    const raw = readFileSync(configPath, "utf-8");
    // The key is still present (NOT deleted) — explicit YAML null.
    expect(raw).toMatch(/default_coder:\s*null/);
    expect(raw).toMatch(/default_reviewer:\s*codex/);
    // Cross-check via the YAML parser that key-presence holds.
    const YAML = (await import("yaml")).default;
    const parsed = YAML.parse(raw) as { mag: { orchestration: Record<string, unknown> } };
    expect("default_coder" in parsed.mag.orchestration).toBe(true);
    expect(parsed.mag.orchestration.default_coder).toBeNull();
  });

  test("preserves adjacent comment + sibling default_mode verbatim", async () => {
    const { readFileSync } = await import("fs");
    const { writeOrchestrationDefaults } = await import("./config.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    const sentinel = "# DO-NOT-REFLOW sentinel comment task-b43bd578";
    const original = `state_repo: owner/ludics-state
state_path: harness
mag:
  orchestration:
    default_mode: pair  ${sentinel}
    queue_dir: queue
`;
    writeFileSync(configPath, original);
    writeOrchestrationDefaults({ coder: "codex", reviewer: "claude-code" });
    const after = readFileSync(configPath, "utf-8");
    // Sentinel comment on the unchanged adjacent key survives.
    expect(after).toContain(sentinel);
    // Sibling key default_mode value is preserved.
    expect(after).toMatch(/default_mode:\s*pair/);
    // Unrelated sibling `queue_dir` survives.
    expect(after).toMatch(/queue_dir:\s*queue/);
  });

  test("uses atomicWriteFileSync (no partial-write window)", async () => {
    const { spyOn } = await import("bun:test");
    const jsonMod = await import("./json.ts");
    const { writeOrchestrationDefaults } = await import("./config.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, "state_repo: owner/ludics-state\nstate_path: harness\n");
    const spy = spyOn(jsonMod, "atomicWriteFileSync");
    let callsForConfig: { path: string; content: string }[] = [];
    try {
      writeOrchestrationDefaults({ coder: "codex", reviewer: "claude-code" });
      // Capture calls BEFORE mockRestore (bun:test mockRestore wipes history).
      callsForConfig = spy.mock.calls
        .filter((c) => typeof c[0] === "string" && c[0] === configPath)
        .map((c) => ({ path: c[0] as string, content: c[1] as string }));
    } finally {
      spy.mockRestore();
    }
    expect(callsForConfig.length).toBe(1);
    expect(callsForConfig[0]!.content).toMatch(/default_coder:\s*codex/);
    expect(callsForConfig[0]!.content).toMatch(/default_reviewer:\s*claude-code/);
  });

  test("round-trip fidelity: write then re-parse yields exactly the written state", async () => {
    const { readFileSync } = await import("fs");
    const { writeOrchestrationDefaults } = await import("./config.ts");
    const { effectiveDefaultsFromConfig } = await import("./orchestration-defaults.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, "state_repo: owner/ludics-state\nstate_path: harness\n");
    for (const state of [
      { coder: "claude-code" as const, reviewer: "codex" as const },
      { coder: "codex" as const, reviewer: "claude-code" as const },
      { coder: null, reviewer: "codex" as const },
      { coder: "claude-code" as const, reviewer: null },
      { coder: null, reviewer: null },
    ]) {
      writeOrchestrationDefaults(state);
      const raw = readFileSync(configPath, "utf-8");
      const YAML = (await import("yaml")).default;
      const parsed = YAML.parse(raw) as { mag?: { orchestration?: Record<string, unknown> } };
      const round = effectiveDefaultsFromConfig(parsed.mag?.orchestration);
      expect(round).toEqual(state);
    }
  });
});

describe("ProjectConfig.outbound_sync_enabled (gh-ludics-540)", () => {
  // The outbound staging→upstream push tick reads this opt-in via
  // `p.outbound_sync_enabled === true` — absent and false both map to
  // "off". These tests pin both arms of that read boundary.

  test("accepts outbound_sync_enabled: true from YAML and round-trips through loadConfigSync", async () => {
    const { loadConfigSync, findProjectConfigByName } = await import("./config.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    upstream_repo: ahrefs/ocannl
    outbound_sync_enabled: true
`);
    const cfg = loadConfigSync();
    const proj = findProjectConfigByName("ocannl", cfg);
    expect(proj).toBeDefined();
    expect(proj!.outbound_sync_enabled).toBe(true);
  });

  test("absent outbound_sync_enabled parses as undefined (so === true filter treats it as off)", async () => {
    const { loadConfigSync, findProjectConfigByName } = await import("./config.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    upstream_repo: ahrefs/ocannl
`);
    const cfg = loadConfigSync();
    const proj = findProjectConfigByName("ocannl", cfg);
    expect(proj).toBeDefined();
    expect(proj!.outbound_sync_enabled).toBeUndefined();
    // The wrapper's filter is `p.outbound_sync_enabled === true`, so
    // undefined must not be coerced to a truthy value upstream.
    expect(proj!.outbound_sync_enabled === true).toBe(false);
  });

  test("explicit outbound_sync_enabled: false also short-circuits the === true filter", async () => {
    const { loadConfigSync, findProjectConfigByName } = await import("./config.ts");
    const configPath = process.env.LUDICS_CONFIG!;
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    upstream_repo: ahrefs/ocannl
    outbound_sync_enabled: false
`);
    const cfg = loadConfigSync();
    const proj = findProjectConfigByName("ocannl", cfg);
    expect(proj).toBeDefined();
    expect(proj!.outbound_sync_enabled).toBe(false);
    expect(proj!.outbound_sync_enabled === true).toBe(false);
  });
});

describe("t3codeIntegrationEnabled (gh-ludics-539)", () => {
  // The gate helper is strict opt-in: `mag.t3code_integration_enabled === true`.
  // Every non-`true` value (absent, false, string, truthy number) must read as
  // paused, so the default-off / zero-migration invariant (AC 1, AC 10) holds.

  function writeMagConfig(flagLine: string): void {
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
mag:
${flagLine}
`);
  }

  test("absent key reads as false (zero-migration default)", async () => {
    const { t3codeIntegrationEnabled } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
`);
    expect(t3codeIntegrationEnabled()).toBe(false);
  });

  test("literal true reads as true (re-engagement)", async () => {
    const { t3codeIntegrationEnabled } = await import("./config.ts");
    writeMagConfig("  t3code_integration_enabled: true");
    expect(t3codeIntegrationEnabled()).toBe(true);
  });

  test("literal false reads as false", async () => {
    const { t3codeIntegrationEnabled } = await import("./config.ts");
    writeMagConfig("  t3code_integration_enabled: false");
    expect(t3codeIntegrationEnabled()).toBe(false);
  });

  test("non-true value (string) reads as false — strict === true", async () => {
    const { t3codeIntegrationEnabled } = await import("./config.ts");
    // YAML-quoted string "true" is NOT the boolean true; strict === must reject it.
    writeMagConfig('  t3code_integration_enabled: "yes"');
    expect(t3codeIntegrationEnabled()).toBe(false);
  });

  test("truthy non-boolean (number 1) reads as false — strict === true", async () => {
    const { t3codeIntegrationEnabled } = await import("./config.ts");
    writeMagConfig("  t3code_integration_enabled: 1");
    expect(t3codeIntegrationEnabled()).toBe(false);
  });
});

describe("ProjectConfig.requires_t3code (gh-ludics-539)", () => {
  // checkProjectTestHealth reads `project.requires_t3code === true`; absent and
  // false must both map to "not a t3code-dependent project" so only the
  // explicit opt-in (or the t3code-ludics name fallback) triggers the skip.

  test("requires_t3code: true round-trips through loadConfigSync", async () => {
    const { loadConfigSync, findProjectConfigByName } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: t3code-ludics
    repo: lukstafi/t3code-ludics
    requires_t3code: true
`);
    const proj = findProjectConfigByName("t3code-ludics", loadConfigSync());
    expect(proj).toBeDefined();
    expect(proj!.requires_t3code).toBe(true);
  });

  test("absent requires_t3code parses as undefined (=== true filter treats it as off)", async () => {
    const { loadConfigSync, findProjectConfigByName } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: alpha
    repo: owner/alpha
`);
    const proj = findProjectConfigByName("alpha", loadConfigSync());
    expect(proj).toBeDefined();
    expect(proj!.requires_t3code).toBeUndefined();
    expect(proj!.requires_t3code === true).toBe(false);
  });
});

describe("findProjectConfig: orchestration worktree resolution", () => {
  // Regression: orchestration slots run inside per-task worktrees named
  // `<projectBasename>-<feature-slug>[-s<N>]` as siblings of the configured
  // project path. Without explicit sibling matching, findProjectConfig
  // returned null for these paths, silently disabling the wrong-base-repo
  // gate in `runner.verifyPhaseOutcome` (no projectRepo → guarded skip).
  // PR #458 to ahrefs/ocannl from an `ocannl-staging-task-...-s1` worktree
  // landed on upstream instead of the fork because of this.

  test("matches the exact configured path", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: ~/ocannl-staging
`);
    const proj = findProjectConfig(join(TMP, "ocannl-staging"), loadConfigSync());
    expect(proj?.name).toBe("ocannl");
  });

  test("matches a subdirectory of the configured path", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: ~/ocannl-staging
`);
    const proj = findProjectConfig(join(TMP, "ocannl-staging", "tensor"), loadConfigSync());
    expect(proj?.name).toBe("ocannl");
  });

  test("matches an orchestration worktree sibling (the regression)", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: ~/ocannl-staging
`);
    const proj = findProjectConfig(join(TMP, "ocannl-staging-task-71e28eb1-s1"), loadConfigSync());
    expect(proj?.name).toBe("ocannl");
    expect(proj?.repo).toBe("lukstafi/ocannl-staging");
  });

  test("matches per-agent worktree sibling (duo mode: `<base>-<task>-s<N>-coder`)", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: alpha
    repo: owner/alpha
    path: ~/alpha
`);
    const proj = findProjectConfig(join(TMP, "alpha-task-deadbeef-s2-coder"), loadConfigSync());
    expect(proj?.name).toBe("alpha");
  });

  test("tolerates trailing slash on the projectDir argument", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: ~/ocannl-staging
`);
    const proj = findProjectConfig(join(TMP, "ocannl-staging-task-abc-s1") + "/", loadConfigSync());
    expect(proj?.name).toBe("ocannl");
  });

  test("does NOT match a sibling that shares a prefix without the dash separator", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: ~/ocannl-staging
`);
    // No `-` between "ocannl-staging" and the suffix — must not match.
    const proj = findProjectConfig(join(TMP, "ocannl-stagingextra"), loadConfigSync());
    expect(proj).toBeNull();
  });

  test("does NOT match a directory in a different parent", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: ~/ocannl-staging
`);
    // Different parent directory — sibling-match guard requires identical parents.
    mkdirSync(join(TMP, "elsewhere"), { recursive: true });
    const proj = findProjectConfig(join(TMP, "elsewhere", "ocannl-staging-task-abc-s1"), loadConfigSync());
    expect(proj).toBeNull();
  });

  test("falls back to basename match when no path is configured", async () => {
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
`);
    const proj = findProjectConfig("/tmp/ocannl-staging", loadConfigSync());
    expect(proj?.name).toBe("ocannl");
  });

  test("worktree-sibling match does not depend on the configured path existing on disk", async () => {
    // Defensive: lookup should be purely lexical so that lookups in tests
    // and in production environments without checkouts still resolve.
    const { loadConfigSync, findProjectConfig } = await import("./config.ts");
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
projects:
  - name: ocannl
    repo: lukstafi/ocannl-staging
    path: /nonexistent/ocannl-staging
`);
    const proj = findProjectConfig("/nonexistent/ocannl-staging-task-71e28eb1-s1", loadConfigSync());
    expect(proj?.name).toBe("ocannl");
  });
});
