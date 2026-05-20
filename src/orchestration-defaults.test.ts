import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EFFECTIVE_DEFAULTS,
  PROVIDERS,
  effectiveDefaultsFromConfig,
  isProvider,
  validatePayload,
} from "./orchestration-defaults.ts";

describe("PROVIDERS constant", () => {
  test("lists exactly claude-code and codex", () => {
    expect([...PROVIDERS]).toEqual(["claude-code", "codex"]);
  });

  test("stays in lockstep with the browser-side role-switcher copy", async () => {
    const browser = await import("../templates/dashboard/role-switcher.js");
    expect([...browser.PROVIDERS]).toEqual([...PROVIDERS]);
  });
});

describe("isProvider", () => {
  test("accepts each PROVIDERS member", () => {
    for (const p of PROVIDERS) expect(isProvider(p)).toBe(true);
  });

  test("rejects unknown strings, empty string, undefined, null, and non-strings", () => {
    expect(isProvider("cursor")).toBe(false);
    expect(isProvider("")).toBe(false);
    expect(isProvider(undefined)).toBe(false);
    expect(isProvider(null)).toBe(false);
    expect(isProvider(42)).toBe(false);
    expect(isProvider({})).toBe(false);
  });
});

describe("validatePayload", () => {
  test("accepts both providers (distinct)", () => {
    const r = validatePayload({ coder: "claude-code", reviewer: "codex" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coder).toBe("claude-code");
      expect(r.reviewer).toBe("codex");
    }
  });

  test("accepts both null", () => {
    const r = validatePayload({ coder: null, reviewer: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coder).toBeNull();
      expect(r.reviewer).toBeNull();
    }
  });

  test("accepts one null + one provider", () => {
    const r = validatePayload({ coder: null, reviewer: "codex" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coder).toBeNull();
      expect(r.reviewer).toBe("codex");
    }
  });

  test("rejects missing coder key", () => {
    const r = validatePayload({ reviewer: "codex" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing 'coder'/);
  });

  test("rejects missing reviewer key", () => {
    const r = validatePayload({ coder: "codex" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing 'reviewer'/);
  });

  test("rejects unknown provider name 'cursor'", () => {
    const r = validatePayload({ coder: "cursor", reviewer: "codex" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid 'coder'/);
  });

  test("rejects duplicate non-null coder/reviewer", () => {
    const r = validatePayload({ coder: "codex", reviewer: "codex" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must differ/);
  });

  test("rejects non-object bodies", () => {
    expect(validatePayload(null).ok).toBe(false);
    expect(validatePayload([]).ok).toBe(false);
    expect(validatePayload("string").ok).toBe(false);
  });
});

describe("effectiveDefaultsFromConfig", () => {
  test("undefined orch → hard-coded fallbacks", () => {
    expect(effectiveDefaultsFromConfig(undefined)).toEqual({
      coder: EFFECTIVE_DEFAULTS.coder,
      reviewer: EFFECTIVE_DEFAULTS.reviewer,
    });
  });

  test("empty orch → hard-coded fallbacks (both absent)", () => {
    expect(effectiveDefaultsFromConfig({})).toEqual({
      coder: "claude-code",
      reviewer: "codex",
    });
  });

  test("configured opposite values pass through literally", () => {
    expect(effectiveDefaultsFromConfig({
      default_coder: "codex",
      default_reviewer: "claude-code",
    })).toEqual({ coder: "codex", reviewer: "claude-code" });
  });

  test("present-null preserves null for that role (AC 10/11 reload contract)", () => {
    expect(effectiveDefaultsFromConfig({
      default_coder: null,
      default_reviewer: "codex",
    })).toEqual({ coder: null, reviewer: "codex" });
  });

  test("both present-null → both null", () => {
    expect(effectiveDefaultsFromConfig({
      default_coder: null,
      default_reviewer: null,
    })).toEqual({ coder: null, reviewer: null });
  });

  test("present-unknown 'cursor' falls back + console.error warning", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = effectiveDefaultsFromConfig({
        default_coder: "cursor",
        default_reviewer: "codex",
      });
      const calls = spy.mock.calls;
      expect(out).toEqual({ coder: "claude-code", reviewer: "codex" });
      expect(calls.length).toBeGreaterThan(0);
      expect(String(calls[0]?.[0])).toMatch(/orchestration-defaults.*cursor/);
    } finally {
      spy.mockRestore();
    }
  });

  test("mutation-test: absent-key fixture matches default; mutating fixture to non-default propagates", () => {
    // Guard against `?? EFFECTIVE_DEFAULTS.coder` short-circuit bugs:
    // if the implementation accidentally collapses all paths to defaults,
    // the configured opposite-values case wouldn't echo literally.
    const unset = effectiveDefaultsFromConfig({});
    const configured = effectiveDefaultsFromConfig({
      default_coder: "codex",
      default_reviewer: "claude-code",
    });
    expect(unset.coder).toBe("claude-code");
    expect(configured.coder).toBe("codex");
    expect(unset.coder).not.toBe(configured.coder);
  });
});

// ---------------------------------------------------------------------------
// AC 13a — asymmetry pin: dashboard preserves explicit `null` selections,
// but the auto-fill read sites coerce explicit YAML null to the literal
// fallback. Pinning here so a future "make null real at auto-fill" change
// touches these tests deliberately.
// ---------------------------------------------------------------------------

describe("AC 13a asymmetry pin — selectOrchestrationFlags coerces explicit null", () => {
  // gh-ludics-539: selectOrchestrationFlags reads the real config via
  // globalAdapter()/t3codeIntegrationEnabled(); write a temp config with the
  // t3code flag ON so the integration gate does not throw under these tests.
  let TMP = "";
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-asym-flags-"));
    process.env.HOME = TMP;
    const configDir = join(TMP, ".config", "ludics");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    writeFileSync(
      configPath,
      "state_repo: owner/ludics-state\nstate_path: harness\nmag:\n  t3code_integration_enabled: true\n",
    );
    process.env.LUDICS_CONFIG = configPath;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("default_coder: null in fake config → --coder claude-code", async () => {
    const { selectOrchestrationFlags } = await import("./adapters/t3code.ts");
    const fakeConfig = {
      mag: { orchestration: { default_coder: null, default_reviewer: null } },
    } as unknown as Parameters<typeof selectOrchestrationFlags>[1];
    const { args } = selectOrchestrationFlags("tiny", fakeConfig);
    // Asymmetry: null at the YAML layer collapses to the hard-coded literal.
    expect(args).toContain("--coder claude-code");
    expect(args).not.toContain("--coder null");
  });

  test("default_reviewer: null in fake config → --reviewer codex on non-tiny effort", async () => {
    const { selectOrchestrationFlags } = await import("./adapters/t3code.ts");
    const fakeConfig = {
      mag: { orchestration: { default_coder: null, default_reviewer: null, default_mode: "pair" } },
    } as unknown as Parameters<typeof selectOrchestrationFlags>[1];
    const { args } = selectOrchestrationFlags("medium", fakeConfig);
    expect(args).toContain("--reviewer codex");
    expect(args).not.toContain("--reviewer null");
  });
});

describe("AC 13a asymmetry pin — expandDuoSlots coerces explicit null", () => {
  let TMP = "";
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-asym-"));
    process.env.HOME = TMP;
    const configDir = join(TMP, ".config", "ludics");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    writeFileSync(
      configPath,
      "state_repo: owner/ludics-state\nstate_path: harness\nmag:\n  orchestration:\n    default_coder: null\n    default_reviewer: null\n",
    );
    process.env.LUDICS_CONFIG = configPath;
    process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
    mkdirSync(process.env.LUDICS_HARNESS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("expandDuoSlots with default_coder: null + default_reviewer: null → literal claude-code + codex", async () => {
    const { expandDuoSlots } = await import("./slots/duo-expand.ts");
    const result = expandDuoSlots(1, 2, "");
    // Asymmetry pin: truthy-guard in duo-expand falls back to literal
    // defaults when default_coder/default_reviewer are present-null.
    expect(result.slotA.args).toContain("--coder claude-code");
    expect(result.slotA.args).toContain("--reviewer codex");
    expect(result.slotB.args).toContain("--coder codex");
    expect(result.slotB.args).toContain("--reviewer claude-code");
  });
});
