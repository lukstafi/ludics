import { describe, expect, test } from "bun:test";
import { normalizeLaunchAdapter } from "./mag.ts";

describe("normalizeLaunchAdapter", () => {
  test("t3code passes through unchanged", () => {
    expect(normalizeLaunchAdapter("t3code")).toBe("t3code");
  });

  test("legacy agent-claude maps to t3code", () => {
    expect(normalizeLaunchAdapter("agent-claude")).toBe("t3code");
  });

  test("legacy agent-codex maps to t3code", () => {
    expect(normalizeLaunchAdapter("agent-codex")).toBe("t3code");
  });

  test("legacy agent-session maps to t3code", () => {
    expect(normalizeLaunchAdapter("agent-session")).toBe("t3code");
  });

  test("unknown adapter maps to t3code", () => {
    expect(normalizeLaunchAdapter("some-unknown")).toBe("t3code");
  });

  test("empty string maps to t3code", () => {
    expect(normalizeLaunchAdapter("")).toBe("t3code");
  });

  test("whitespace-padded adapter is trimmed and normalized", () => {
    expect(normalizeLaunchAdapter("  agent-claude  ")).toBe("t3code");
    expect(normalizeLaunchAdapter("  t3code  ")).toBe("t3code");
  });
});
