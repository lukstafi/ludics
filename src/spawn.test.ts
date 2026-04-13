import { describe, expect, test } from "bun:test";
import { safeSyncOutput } from "./spawn.ts";

describe("safeSyncOutput", () => {
  test("returns ok:false without throwing on nonexistent command", () => {
    const r = safeSyncOutput(["nonexistent-cmd-xyz-abc"]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(-1);
  });

  test("returns ok:false without throwing on nonexistent cwd (deleted-directory scenario)", () => {
    const r = safeSyncOutput(["git", "status"], { cwd: "/tmp/nonexistent-dir-xyz-abc-123" });
    expect(r.ok).toBe(false);
  });

  test("returns ok:true with trimmed stdout on successful command", () => {
    const r = safeSyncOutput(["echo", "hello"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("hello");
  });

  test("returns untrimmed stdout when trim:false", () => {
    const r = safeSyncOutput(["echo", "hello"], { trim: false });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("hello\n");
  });

  test("returns timedOut:true when process exceeds timeout", () => {
    const r = safeSyncOutput(["sleep", "10"], { timeout: 200 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  test("returns timedOut:false on normal success", () => {
    const r = safeSyncOutput(["echo", "hi"]);
    expect(r.timedOut).toBe(false);
  });
});
