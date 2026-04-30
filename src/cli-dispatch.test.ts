import { describe, test, expect } from "bun:test";
import { formatUnknownTopLevel, TOP_LEVEL_ALIAS_NAMES } from "./cli-dispatch.ts";

describe("formatUnknownTopLevel", () => {
  test("emits the canonical 'unknown ludics command: ${cmd} (use: ...)' shape", () => {
    const out = formatUnknownTopLevel("bogus", ["foo", "bar", "baz"]);
    expect(out).toBe("unknown ludics command: bogus (use: bar, baz, foo)");
  });

  test("listing is alphabetically sorted regardless of input order", () => {
    const out = formatUnknownTopLevel("x", ["zeta", "alpha", "mu"]);
    expect(out).toBe("unknown ludics command: x (use: alpha, mu, zeta)");
  });

  test("filters out the 'orchestration' alias of 'orch'", () => {
    const out = formatUnknownTopLevel("bogus", ["orch", "orchestration", "tasks"]);
    expect(out).toBe("unknown ludics command: bogus (use: orch, tasks)");
    expect(out).not.toContain("orchestration");
  });

  test("does not emit the legacy 'not yet migrated' wording", () => {
    const out = formatUnknownTopLevel("bogus", ["tasks", "flow"]);
    expect(out).not.toContain("not yet migrated");
  });

  test("does not mutate the input array", () => {
    const input: ReadonlyArray<string> = ["zeta", "alpha"];
    const before = [...input];
    formatUnknownTopLevel("x", input);
    expect([...input]).toEqual(before);
  });
});

describe("TOP_LEVEL_ALIAS_NAMES", () => {
  test("contains the documented top-level aliases", () => {
    expect(TOP_LEVEL_ALIAS_NAMES.has("orchestration")).toBe(true);
  });
});
