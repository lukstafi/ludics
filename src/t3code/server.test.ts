import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { commandLineMatchesServerRecord, processAlive, readServerRecord } from "./server.ts";
import type { T3CodeServerRecord } from "./types.ts";

function makeRecord(overrides: Partial<T3CodeServerRecord> = {}): T3CodeServerRecord {
  return {
    pid: 1234,
    port: 3773,
    host: "127.0.0.1",
    webUrl: "http://127.0.0.1:3773",
    wsUrl: "ws://127.0.0.1:3773",
    stateDir: "/tmp/ludics/harness/t3code/state",
    startedAt: "2026-03-07T00:00:00Z",
    command: ["t3", "--home-dir", "/tmp/ludics/harness/t3code/state"],
    ...overrides,
  };
}

describe("commandLineMatchesServerRecord", () => {
  test("matches installed t3 command lines that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "t3 --mode desktop --port 3773 --home-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun source launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun --cwd /Users/lukstafi/t3code/apps/server src/index.ts --mode desktop --home-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun run --cwd launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun run --cwd /Users/lukstafi/t3code-ludics/apps/server start --mode desktop --home-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun --cwd (without run) launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun --cwd /Users/lukstafi/t3code-ludics/apps/server src/index.ts --home-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("matches when host is a Tailscale hostname", () => {
    const record = makeRecord({
      host: "macbook.tail12345.ts.net",
      webUrl: "http://macbook.tail12345.ts.net:3773",
      wsUrl: "ws://macbook.tail12345.ts.net:3773",
    });
    expect(
      commandLineMatchesServerRecord(
        "bun run --cwd /Users/lukstafi/t3code-ludics/apps/server start --home-dir /tmp/ludics/harness/t3code/state --host macbook.tail12345.ts.net",
        record,
      ),
    ).toBe(true);
  });

  test("matches npm exec wrapper that includes the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "npm exec t3 -- --mode desktop --port 3773 --home-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("matches npm run wrapper that includes the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "/usr/local/bin/npm run t3 -- --mode desktop --port 3773 --home-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("rejects unrelated processes even when the pid is alive", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "node /Users/lukstafi/project/server.js --home-dir /tmp/other-state",
        record,
      ),
    ).toBe(false);
    expect(commandLineMatchesServerRecord("python worker.py", record)).toBe(false);
  });
});

describe("readServerRecord", () => {
  test("returns null when server.json contains a non-object value", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ludics-t3code-test-"));
    const t3Dir = join(tmpDir, "t3code");
    mkdirSync(t3Dir, { recursive: true });

    // JSON string
    writeFileSync(join(t3Dir, "server.json"), '"hello"');
    expect(readServerRecord(tmpDir)).toBeNull();

    // JSON array
    writeFileSync(join(t3Dir, "server.json"), "[1,2,3]");
    expect(readServerRecord(tmpDir)).toBeNull();

    // JSON null
    writeFileSync(join(t3Dir, "server.json"), "null");
    expect(readServerRecord(tmpDir)).toBeNull();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("processAlive", () => {
  test("returns true for the current process", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  test("returns false for invalid pids without throwing", () => {
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
    expect(processAlive(1.5)).toBe(false);
    expect(processAlive(Number.NaN)).toBe(false);
  });

  test("returns false for a pid whose process has exited", () => {
    // Spawn a short-lived child and wait for it to exit synchronously.
    const r = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const deadPid = Number((r.stdout ?? "").trim());
    expect(Number.isInteger(deadPid)).toBe(true);
    expect(deadPid).toBeGreaterThan(0);
    // The shell has already exited by the time spawnSync returns.
    expect(processAlive(deadPid)).toBe(false);
  });
});
