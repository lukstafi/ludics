import { describe, expect, test } from "bun:test";
import { stripModeAndRoleFlags, expandDuoSlots } from "./duo-expand.ts";

describe("stripModeAndRoleFlags", () => {
  test("strips --coder and its value", () => {
    expect(stripModeAndRoleFlags("--coder claude-code:opus --plan")).toBe("--plan");
  });

  test("strips --reviewer and its value", () => {
    expect(stripModeAndRoleFlags("--reviewer codex:o3 --gather")).toBe("--gather");
  });

  test("strips --agent and its value", () => {
    expect(stripModeAndRoleFlags("--agent foo --effort high")).toBe("--effort high");
  });

  test("strips standalone --pair and --duo", () => {
    expect(stripModeAndRoleFlags("--pair --duo --plan")).toBe("--plan");
  });

  test("preserves unrelated flags and tokens", () => {
    expect(stripModeAndRoleFlags("--effort high --plan")).toBe("--effort high --plan");
  });

  test("mixed valued + standalone + unrelated flags", () => {
    expect(stripModeAndRoleFlags("--plan --coder claude-code:opus --gather")).toBe("--plan --gather");
  });

  test("multiple stripped flags of mixed types", () => {
    expect(stripModeAndRoleFlags("--duo --reviewer codex:o3 --gather --agent foo")).toBe("--gather");
  });

  test("all valued flags stripped yields empty string", () => {
    expect(stripModeAndRoleFlags("--coder a --reviewer b --agent c")).toBe("");
  });

  test("valued flag at end with missing value does not crash", () => {
    expect(stripModeAndRoleFlags("--plan --coder")).toBe("--plan");
  });

  test("empty string input returns empty string", () => {
    expect(stripModeAndRoleFlags("")).toBe("");
  });
});

describe("expandDuoSlots — no stray positional leak", () => {
  test("--coder value does not leak as stray positional in expanded args", () => {
    const result = expandDuoSlots(1, 2, "--coder claude-code:opus --plan");
    const argsA = result.slotA.args;
    const argsB = result.slotB.args;

    // Both slots should have --pair, --duo-peer-slot, --plan, and structured --coder/--reviewer
    for (const args of [argsA, argsB]) {
      expect(args).toContain("--pair");
      expect(args).toContain("--duo-peer-slot=");
      expect(args).toContain("--plan");

      // Verify claude-code:opus only appears immediately after --coder or --reviewer
      const tokens = args.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === "claude-code:opus") {
          const prev = tokens[i - 1];
          expect(prev === "--coder" || prev === "--reviewer").toBe(true);
        }
      }
    }
  });
});
