import { describe, expect, test } from "bun:test";
import { setsidWrap } from "./util.ts";

describe("setsidWrap", () => {
  const cmd = ["ludics", "orch", "run-internal", "1"];

  test("prepends setsid binary when resolved path is provided", () => {
    const wrapped = setsidWrap(cmd, "/usr/bin/setsid");
    expect(wrapped).toEqual(["/usr/bin/setsid", ...cmd]);
  });

  test("uses perl POSIX fallback when resolved path is null", () => {
    const wrapped = setsidWrap(cmd, null);
    expect(wrapped[0]).toBe("perl");
    expect(wrapped[1]).toBe("-e");
    expect(wrapped[2]).toBe("use POSIX qw(setsid); setsid(); exec @ARGV");
    expect(wrapped[3]).toBe("--");
    expect(wrapped.slice(4)).toEqual(cmd);
  });

  test("uses perl POSIX fallback when resolved path is empty string", () => {
    const wrapped = setsidWrap(cmd, "");
    expect(wrapped[0]).toBe("perl");
  });

  test("default (no resolvedSetsid arg) picks platform-appropriate wrapper", () => {
    const wrapped = setsidWrap(cmd);
    expect(wrapped.length).toBeGreaterThan(cmd.length);
    // Original command args always appear at the tail
    expect(wrapped.slice(-cmd.length)).toEqual(cmd);
  });
});
