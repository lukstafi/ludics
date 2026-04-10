import { describe, expect, test } from "bun:test";
import { AGENT_NAME_RE, validateAgentName, parseCanonicalInt } from "./filename-utils";

describe("AGENT_NAME_RE", () => {
  test("matches valid agent names", () => {
    expect(AGENT_NAME_RE.test("coder-1")).toBe(true);
    expect(AGENT_NAME_RE.test("agent_a")).toBe(true);
    expect(AGENT_NAME_RE.test("abc")).toBe(true);
  });
  test("rejects invalid agent names", () => {
    expect(AGENT_NAME_RE.test("")).toBe(false);
    expect(AGENT_NAME_RE.test("a b")).toBe(false);
    expect(AGENT_NAME_RE.test("a/b")).toBe(false);
  });
});

describe("validateAgentName", () => {
  test("accepts valid names", () => {
    expect(() => validateAgentName("coder-1", "test")).not.toThrow();
    expect(() => validateAgentName("agent_a", "test")).not.toThrow();
  });
  test("throws on invalid names with context", () => {
    expect(() => validateAgentName("", "plan filename")).toThrow("plan filename");
    expect(() => validateAgentName("a b", "review filename")).toThrow("review filename");
    expect(() => validateAgentName("a/b", "merge vote filename")).toThrow("merge vote filename");
  });
});

describe("parseCanonicalInt", () => {
  test("returns the number for canonical strings", () => {
    expect(parseCanonicalInt("0")).toBe(0);
    expect(parseCanonicalInt("1")).toBe(1);
    expect(parseCanonicalInt("42")).toBe(42);
  });
  test("returns null for non-canonical representations", () => {
    expect(parseCanonicalInt("01")).toBeNull();
    expect(parseCanonicalInt("abc")).toBeNull();
    expect(parseCanonicalInt("")).toBeNull();
  });
});
