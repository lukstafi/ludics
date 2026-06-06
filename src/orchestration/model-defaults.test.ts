import { describe, expect, test } from "bun:test";
import {
  TRACKED_MODEL_CLASSES,
  classForProvider,
  resolveModelClass,
  type ModelClass,
} from "./model-defaults.ts";

// A fully-populated table — the positive control for each per-class throw test.
const FULL_TABLE: Record<string, string> = {
  codex: "gpt-5.5",
  "claude-opus": "claude-opus-4-8",
  "claude-sonnet": "claude-sonnet-4-6",
};

describe("resolveModelClass — returns the configured value", () => {
  test("returns the table value for each tracked class", () => {
    expect(resolveModelClass(FULL_TABLE, "codex")).toBe("gpt-5.5");
    expect(resolveModelClass(FULL_TABLE, "claude-opus")).toBe("claude-opus-4-8");
    expect(resolveModelClass(FULL_TABLE, "claude-sonnet")).toBe("claude-sonnet-4-6");
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
