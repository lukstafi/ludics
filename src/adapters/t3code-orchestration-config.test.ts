// task-a670cdbf — adapter wiring regression: mag.orchestration.substantive_stall.*
// YAML keys reach orchestration.config.substantiveStall via the
// parser+merge pattern in src/adapters/t3code.ts and tmux-adapter.ts.
//
// We exercise the parser directly (the adapter call sites are 5 lines
// of merging that tsc covers; the testable invariant is the
// YAML→Partial<SubstantiveStallConfig> mapping that both adapters
// share through `parseSubstantiveStallOverrides`). Plus an end-to-end
// merge test that shows a partial YAML override survives
// `defaultOrchestrationConfig` exactly the way the adapter uses it.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  defaultOrchestrationConfig,
  DEFAULT_SUBSTANTIVE_STALL_CONFIG,
  parseSubstantiveStallOverrides,
} from "../orchestration/state.ts";
import { withSyntheticHarness } from "../test-utils.ts";

// Pure unit-test surface, but the transitive import of state.ts pulls in
// config.ts; isolate via a synthetic harness so the test-isolation lint
// stays at its pinned warning count.
withSyntheticHarness(beforeEach, afterEach);

describe("adapter substantive_stall wiring (task-a670cdbf)", () => {
  test("adapter merge pattern: YAML overrides flow through to state.config.substantiveStall", () => {
    // Mirrors the merge in src/adapters/t3code.ts:888-896 and
    // tmux-adapter.ts (same shape): orchestration.config.substantiveStall
    // = { ...DEFAULTS, ...prior, ...parsed-YAML }.
    const yamlOrchSection = {
      substantive_stall: {
        threshold_seconds: 900,
        min_chars: 50,
        // intentionally omit nudge_cooldown_seconds / max_nudge_attempts
      },
    };
    const overrides = parseSubstantiveStallOverrides(yamlOrchSection.substantive_stall);
    const adapterConfig: { substantiveStall?: typeof DEFAULT_SUBSTANTIVE_STALL_CONFIG } = {};
    if (Object.keys(overrides).length > 0) {
      adapterConfig.substantiveStall = {
        ...DEFAULT_SUBSTANTIVE_STALL_CONFIG,
        ...(adapterConfig.substantiveStall ?? {}),
        ...overrides,
      };
    }
    const finalConfig = defaultOrchestrationConfig(adapterConfig as never);

    // Overridden leaves from YAML.
    expect(finalConfig.substantiveStall.thresholdSeconds).toBe(900);
    expect(finalConfig.substantiveStall.minChars).toBe(50);
    // Unspecified leaves keep defaults (no clobber by undefined).
    expect(finalConfig.substantiveStall.minPct).toBe(DEFAULT_SUBSTANTIVE_STALL_CONFIG.minPct);
    expect(finalConfig.substantiveStall.nudgeCooldownSeconds)
      .toBe(DEFAULT_SUBSTANTIVE_STALL_CONFIG.nudgeCooldownSeconds);
    expect(finalConfig.substantiveStall.maxNudgeAttempts)
      .toBe(DEFAULT_SUBSTANTIVE_STALL_CONFIG.maxNudgeAttempts);
  });

  test("adapter merge pattern: missing YAML block leaves defaults intact", () => {
    // No mag.orchestration.substantive_stall key → orchCfg?.substantive_stall
    // is undefined → parseSubstantiveStallOverrides returns {} → adapter
    // skips the override branch. defaultOrchestrationConfig fills all
    // five default leaves.
    const overrides = parseSubstantiveStallOverrides(undefined);
    expect(overrides).toEqual({});
    const finalConfig = defaultOrchestrationConfig({} as never);
    expect(finalConfig.substantiveStall).toEqual(DEFAULT_SUBSTANTIVE_STALL_CONFIG);
  });

  test("adapter merge pattern: malformed YAML key types are dropped, valid keys survive", () => {
    // typo-resilience invariant — a hand-edited config.yaml typo on one
    // leaf must not poison the other leaves. Mirrors
    // feedback_narrowing_needs_boundary_validators.
    const yaml = {
      threshold_seconds: "twenty minutes", // string — dropped
      min_chars: 25,                       // valid — kept
      min_pct: true,                       // bool — dropped
    };
    const overrides = parseSubstantiveStallOverrides(yaml);
    expect(overrides).toEqual({ minChars: 25 });

    const finalConfig = defaultOrchestrationConfig({
      substantiveStall: overrides as never,
    });
    expect(finalConfig.substantiveStall.minChars).toBe(25);
    expect(finalConfig.substantiveStall.thresholdSeconds)
      .toBe(DEFAULT_SUBSTANTIVE_STALL_CONFIG.thresholdSeconds);
    expect(finalConfig.substantiveStall.minPct)
      .toBe(DEFAULT_SUBSTANTIVE_STALL_CONFIG.minPct);
  });
});
