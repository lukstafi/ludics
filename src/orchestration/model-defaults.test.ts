import { describe, expect, test } from "bun:test";
import {
  TRACKED_MODEL_CLASSES,
  HIGH_END_CLAUDE_CLASSES,
  classForProvider,
  dispatchWithFableContext,
  fableUnavailableMessage,
  isFableModel,
  normalizeHighEndClass,
  resolveModelClass,
  type HighEndClass,
  type ModelClass,
} from "./model-defaults.ts";

// A fully-populated table — the positive control for each per-class throw test.
const FULL_TABLE: Record<string, string> = {
  codex: "gpt-5.5",
  "claude-opus": "claude-opus-4-8",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-fable": "claude-fable-5",
};

describe("resolveModelClass — returns the configured value", () => {
  test("returns the table value for each tracked class", () => {
    expect(resolveModelClass(FULL_TABLE, "codex")).toBe("gpt-5.5");
    expect(resolveModelClass(FULL_TABLE, "claude-opus")).toBe("claude-opus-4-8");
    expect(resolveModelClass(FULL_TABLE, "claude-sonnet")).toBe("claude-sonnet-4-6");
    // task-13dee93b: claude-fable is a tracked class resolving to claude-fable-5 (AC1).
    expect(resolveModelClass(FULL_TABLE, "claude-fable")).toBe("claude-fable-5");
  });

  test("claude-fable is enumerated in TRACKED_MODEL_CLASSES (AC1)", () => {
    expect(TRACKED_MODEL_CLASSES).toContain("claude-fable");
  });

  test("trims surrounding whitespace from a configured value", () => {
    expect(resolveModelClass({ codex: "  gpt-5.5  " }, "codex")).toBe("gpt-5.5");
  });
});

describe("resolveModelClass — fails loudly when a tracked class is unset (AC3)", () => {
  // AC3: a test fails loudly if a tracked class has no resolved model in the
  // config table. Harness condition: the table is constructed to OMIT exactly
  // the class under test (or set it blank/non-string), so the assertion only
  // passes because the throw fired for THAT class — not because some other key
  // is missing. Mutation: deleting the `throw` in resolveModelClass makes it
  // return undefined, so every `toThrow` below flips to a failure.

  test("throws when the whole table is undefined", () => {
    expect(() => resolveModelClass(undefined, "codex")).toThrow(
      /mag\.orchestration\.model_classes\.codex is required/,
    );
  });

  test("throws when the whole table is empty", () => {
    expect(() => resolveModelClass({}, "claude-opus")).toThrow(
      /mag\.orchestration\.model_classes\.claude-opus is required/,
    );
  });

  // Per-class enumeration (AC names three tracked classes): each must throw
  // when ITS OWN key is the one missing, with the other two present.
  for (const cls of TRACKED_MODEL_CLASSES) {
    test(`throws for missing key "${cls}" with the other classes present`, () => {
      const partial: Record<string, string> = { ...FULL_TABLE };
      delete partial[cls];
      // Positive control: the present classes still resolve.
      for (const other of TRACKED_MODEL_CLASSES) {
        if (other === cls) continue;
        expect(resolveModelClass(partial, other)).toBe(FULL_TABLE[other]);
      }
      // The omitted class throws, naming its own full key.
      expect(() => resolveModelClass(partial, cls)).toThrow(
        new RegExp(`mag\\.orchestration\\.model_classes\\.${cls} is required`),
      );
    });
  }

  test("throws for a blank value", () => {
    expect(() => resolveModelClass({ codex: "" }, "codex")).toThrow(/is required/);
  });

  test("throws for a whitespace-only value", () => {
    expect(() => resolveModelClass({ codex: "   " }, "codex")).toThrow(/is required/);
  });

  test("throws for a non-string value", () => {
    expect(() => resolveModelClass({ codex: 123 as unknown as string }, "codex")).toThrow(
      /is required/,
    );
    expect(() => resolveModelClass({ codex: null as unknown as string }, "codex")).toThrow(
      /is required/,
    );
  });
});

describe("classForProvider", () => {
  test("codex provider → codex class", () => {
    expect(classForProvider("codex")).toBe<ModelClass>("codex");
  });

  test("claude-code provider → claude-sonnet class (generic claude default)", () => {
    expect(classForProvider("claude-code")).toBe<ModelClass>("claude-sonnet");
  });

  test("unknown provider falls to claude-sonnet (non-codex default)", () => {
    expect(classForProvider("whatever")).toBe<ModelClass>("claude-sonnet");
  });
});

// ---------------------------------------------------------------------------
// task-13dee93b — per-role high-end class + Fable-unavailable handling
// ---------------------------------------------------------------------------

describe("normalizeHighEndClass (AC3 — forgiving, default claude-opus)", () => {
  test("HIGH_END_CLAUDE_CLASSES is exactly opus + fable", () => {
    expect([...HIGH_END_CLAUDE_CLASSES]).toEqual(["claude-opus", "claude-fable"]);
  });

  test("claude-fable selects fable; claude-opus / absent / blank → claude-opus", () => {
    expect(normalizeHighEndClass("claude-fable")).toBe<HighEndClass>("claude-fable");
    expect(normalizeHighEndClass(" claude-fable ")).toBe<HighEndClass>("claude-fable");
    expect(normalizeHighEndClass("claude-opus")).toBe<HighEndClass>("claude-opus");
    expect(normalizeHighEndClass(undefined)).toBe<HighEndClass>("claude-opus");
    expect(normalizeHighEndClass("")).toBe<HighEndClass>("claude-opus");
  });

  test("unrecognised / non-string values fall back to claude-opus without throwing", () => {
    // Harness: the value is a recognisably-wrong string / wrong type — the AC's
    // forgiving branch must default it, NOT throw (throws are reserved for unset
    // tracked classes in resolveModelClass).
    expect(normalizeHighEndClass("claude-sonnet")).toBe<HighEndClass>("claude-opus");
    expect(normalizeHighEndClass("gpt-5")).toBe<HighEndClass>("claude-opus");
    expect(normalizeHighEndClass(123)).toBe<HighEndClass>("claude-opus");
    expect(normalizeHighEndClass(null)).toBe<HighEndClass>("claude-opus");
  });
});

describe("isFableModel", () => {
  const orchCfg = { model_classes: FULL_TABLE };

  test("true for the resolved fable model and the canonical literal (even without orchCfg)", () => {
    expect(isFableModel("claude-fable-5", orchCfg)).toBe(true);
    expect(isFableModel("claude-fable-5")).toBe(true); // literal fallback, no orchCfg
  });

  test("matches a config-overridden fable model string", () => {
    expect(isFableModel("fable-next", { model_classes: { "claude-fable": "fable-next" } })).toBe(true);
  });

  test("false for opus / sonnet / codex / blank", () => {
    expect(isFableModel("claude-opus-4-8", orchCfg)).toBe(false);
    expect(isFableModel("claude-sonnet-4-6", orchCfg)).toBe(false);
    expect(isFableModel("gpt-5.5", orchCfg)).toBe(false);
    expect(isFableModel("", orchCfg)).toBe(false);
  });
});

describe("fableUnavailableMessage (AC9 — names the config key + claude-opus)", () => {
  test("names the role-specific key and claude-opus", () => {
    const m = fableUnavailableMessage("claude-fable-5", "coder");
    expect(m).toContain("mag.orchestration.coder_class");
    expect(m).toContain("claude-opus");
    expect(m).toContain("claude-fable-5");
    expect(fableUnavailableMessage("claude-fable-5", "reviewer")).toContain(
      "mag.orchestration.reviewer_class",
    );
  });

  test("names BOTH keys when the role is unknown", () => {
    const m = fableUnavailableMessage("claude-fable-5");
    expect(m).toContain("mag.orchestration.coder_class");
    expect(m).toContain("mag.orchestration.reviewer_class");
  });
});

describe("dispatchWithFableContext (AC9 — annotate Fable failures, no relabel/fallback)", () => {
  const orchCfg = { model_classes: FULL_TABLE };

  test("rethrows an annotated error when a Fable dispatch fails", async () => {
    // Harness: the dispatched model IS the fable class AND fn rejects — the only
    // state in which the AC9 annotation must fire.
    const p = dispatchWithFableContext(
      () => Promise.reject(new Error("model claude-fable-5 not available")),
      "claude-fable-5",
      "coder",
      orchCfg,
    );
    await expect(p).rejects.toThrow(/mag\.orchestration\.coder_class/);
    await expect(p).rejects.toThrow(/claude-opus/);
    // Original error text is preserved, not discarded.
    await expect(p).rejects.toThrow(/not available/);
  });

  test("passes a NON-Fable failure through unchanged (mutation guard — no relabel)", async () => {
    // Harness: same rejecting fn, but the model is Opus — the annotation branch
    // must NOT fire; deleting the isFableModel guard would relabel this and fail.
    const original = new Error("transient socket hangup");
    const p = dispatchWithFableContext(() => Promise.reject(original), "claude-opus-4-8", "coder", orchCfg);
    await expect(p).rejects.toBe(original);
  });

  test("returns the value on success", async () => {
    expect(await dispatchWithFableContext(() => Promise.resolve(42), "claude-fable-5", "coder", orchCfg)).toBe(42);
  });
});
