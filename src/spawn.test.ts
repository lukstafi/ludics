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

  // Regression guard: service-manager commands (launchctl/systemctl) address
  // the live launchd/systemd domain by uid and ignore the HOME sandbox, so
  // running them for real in a test would mutate the developer/controller's
  // actual jobs (e.g. bootout com.ludics.dashboard). They must be skipped under
  // LUDICS_TEST_MODE — set by the src/test-setup.ts preload for every test run.
  describe("service-manager isolation under LUDICS_TEST_MODE", () => {
    test("preload set LUDICS_TEST_MODE for this test run", () => {
      expect(process.env.LUDICS_TEST_MODE).toBe("1");
    });

    test("launchctl is skipped, never spawned (no live-domain mutation)", () => {
      const r = safeSyncOutput(["launchctl", "bootout", "gui/0/com.ludics.dashboard"]);
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(-1);
      expect(r.stderr).toBe("skipped under LUDICS_TEST_MODE");
    });

    test("systemctl is skipped, never spawned", () => {
      const r = safeSyncOutput(["systemctl", "--user", "disable", "--now", "ludics-dashboard.service"]);
      expect(r.ok).toBe(false);
      expect(r.stderr).toBe("skipped under LUDICS_TEST_MODE");
    });

    test("guard is targeted — unrelated commands still run in test mode", () => {
      const r = safeSyncOutput(["echo", "still-runs"]);
      expect(r.ok).toBe(true);
      expect(r.stdout).toBe("still-runs");
    });
  });
});
