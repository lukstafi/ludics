import { describe, expect, test } from "bun:test";
import { commandLineMatchesServerRecord } from "./server.ts";
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
    command: ["t3", "--state-dir", "/tmp/ludics/harness/t3code/state"],
    ...overrides,
  };
}

describe("commandLineMatchesServerRecord", () => {
  test("matches installed t3 command lines that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "t3 --mode desktop --port 3773 --state-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun source launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun --cwd /Users/lukstafi/t3code/apps/server src/index.ts --mode desktop --state-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("rejects unrelated processes even when the pid is alive", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "node /Users/lukstafi/project/server.js --state-dir /tmp/other-state",
        record,
      ),
    ).toBe(false);
    expect(commandLineMatchesServerRecord("python worker.py", record)).toBe(false);
  });
});
