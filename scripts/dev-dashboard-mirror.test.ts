import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(import.meta.dir, "dev-dashboard-mirror.ts");
const SCRIPT_PATH = SOURCE_PATH;
const SOURCE = readFileSync(SOURCE_PATH, "utf-8");

describe("dev-dashboard-mirror.ts /tmp prefix invariant", () => {
  // AC7 of gh-ludics-441 requires the mirror to land at
  // /tmp/ludics-dash-mirror-<random>/, not the platform tmpdir, which on
  // macOS resolves to /var/folders/.../T. The playbook example transcript
  // and reviewer probes both depend on this prefix.
  test("mkdtempSync uses the literal /tmp/ludics-dash-mirror- prefix", () => {
    expect(SOURCE).toContain('mkdtempSync("/tmp/ludics-dash-mirror-")');
  });

  test("does not import tmpdir from node:os", () => {
    expect(SOURCE).not.toMatch(/from\s+["']node:os["']/);
    expect(SOURCE).not.toMatch(/\btmpdir\s*\(/);
  });
});

describe("dev-dashboard-mirror.ts CLI argument validation", () => {
  // Codex P2 review (PR #452): parseArg used to accept any next token as
  // the value, so `--port --keep` made Number("--keep") = NaN and the
  // server started with garbage inputs. Each variant below would have
  // started the server with NaN under the round-2 implementation; the
  // new parseNumberArg exits non-zero before reaching startDashboardServer.

  function runScript(args: string[]): { exitCode: number; stderr: string } {
    const proc = Bun.spawnSync(["bun", "run", SCRIPT_PATH, ...args], {
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  test("rejects --port followed by another flag", () => {
    const { exitCode, stderr } = runScript(["--port", "--keep"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--port requires a numeric value");
  });

  test("rejects --ttl with non-numeric value", () => {
    const { exitCode, stderr } = runScript(["--ttl", "soon"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--ttl");
    expect(stderr).toContain("not a finite number");
  });

  test("rejects --port at end of argv", () => {
    const { exitCode, stderr } = runScript(["--port"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--port requires a numeric value");
  });
});

describe("dev-dashboard-mirror.ts startup-failure cleanup", () => {
  // Codex P3 review (PR #452): if startDashboardServer throws before
  // SIGINT/SIGTERM handlers are registered/run, the mirror dir leaks.
  // We force a startup failure by invoking the script with an invalid
  // numeric port literal that Bun.serve rejects ("99999" is out of range
  // for TCP). The argv validator above only catches non-finite Number();
  // 99999 is finite, so it reaches startDashboardServer and throws.
  test("removes mirror dir when server start throws", () => {
    const before = existsSync("/tmp")
      ? new Set(readdirSync("/tmp").filter((n) => n.startsWith("ludics-dash-mirror-")))
      : new Set();
    const proc = Bun.spawnSync(["bun", "run", SCRIPT_PATH, "--port", "99999"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    const after = readdirSync("/tmp").filter((n) => n.startsWith("ludics-dash-mirror-"));
    const leaked = after.filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  });
});
