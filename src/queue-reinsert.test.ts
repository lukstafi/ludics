import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
  return configPath;
}

function harnessDir(): string {
  return join(TMP, "harness");
}

function queueFile(): string {
  return join(harnessDir(), "mag", "queue.jsonl");
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-queue-reinsert-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("queueReinsertHead", () => {
  test("prepends line to empty queue", async () => {
    const { queueReinsertHead } = await import("./queue.ts");
    const line = JSON.stringify({ id: "req-1", action: "briefing", _retry_count: 1 });
    queueReinsertHead(line);

    const content = readFileSync(queueFile(), "utf-8").trim();
    expect(content).toBe(line);
  });

  test("prepends line to front of existing queue", async () => {
    const { queueReinsertHead } = await import("./queue.ts");
    const existing = JSON.stringify({ id: "req-2", action: "suggest" });
    writeFileSync(queueFile(), existing + "\n");

    const newLine = JSON.stringify({ id: "req-1", action: "briefing", _retry_count: 1 });
    queueReinsertHead(newLine);

    const lines = readFileSync(queueFile(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("req-1");
    expect(JSON.parse(lines[1]!).id).toBe("req-2");
  });

  test("round-trip: reinserted line preserves all fields", async () => {
    const { queueReinsertHead } = await import("./queue.ts");
    const original = { id: "req-42", action: "elaborate", task: "task-abc", timestamp: "2026-04-15T00:00:00Z", _retry_count: 2 };
    const line = JSON.stringify(original);
    queueReinsertHead(line);

    const content = readFileSync(queueFile(), "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe(original.id);
    expect(parsed.action).toBe(original.action);
    expect(parsed.task).toBe(original.task);
    expect(parsed.timestamp).toBe(original.timestamp);
    expect(parsed._retry_count).toBe(original._retry_count);
  });
});

// gh-ludics-535: helper used by the dashboard's /api/in-flight-refire to
// mint a fresh queue id, stamp `re-fired-from` provenance, and reinsert at
// queue head. Keeps id minting owned by queue.ts (the request-id generator
// stays file-private).
describe("queueReinsertHeadWithFreshId", () => {
  test("mints a fresh req-<epoch>-<counter> id and stamps re-fired-from provenance", async () => {
    const { queueReinsertHeadWithFreshId } = await import("./queue.ts");
    // Empty queue → head must be the newly inserted line.
    writeFileSync(queueFile(), "");
    const originalId = "req-1778830000-1";
    const record = { id: originalId, action: "learn" };

    const newId = queueReinsertHeadWithFreshId(record, originalId);

    // The invariant: a fresh id is minted (not the original), matching the
    // req-<epoch>-<counter> shape — reusing the original would re-trip the
    // A6 pre-send result-file dedup check on the next pop.
    expect(newId).toMatch(/^req-\d+-\d+$/);
    expect(newId).not.toBe(originalId);
    const head = JSON.parse(readFileSync(queueFile(), "utf-8").trim());
    expect(head.id).toBe(newId);
    expect(head["re-fired-from"]).toBe(originalId);
    expect(head.action).toBe("learn");
  });

  test("preserves the original record's other fields through the round-trip", async () => {
    const { queueReinsertHeadWithFreshId } = await import("./queue.ts");
    writeFileSync(queueFile(), "");
    const record = {
      id: "req-old",
      action: "elaborate",
      task: "task-abc",
      content: "do the thing",
      timestamp: "2026-05-15T10:00:00Z",
    };

    queueReinsertHeadWithFreshId(record, "req-old");

    const head = JSON.parse(readFileSync(queueFile(), "utf-8").trim());
    expect(head.action).toBe("elaborate");
    expect(head.task).toBe("task-abc");
    expect(head.content).toBe("do the thing");
    expect(head.timestamp).toBe("2026-05-15T10:00:00Z");
  });

  test("inserts at queue head: existing entries remain behind the re-fired line", async () => {
    const { queueReinsertHeadWithFreshId } = await import("./queue.ts");
    const existing = JSON.stringify({ id: "req-existing", action: "suggest" });
    writeFileSync(queueFile(), existing + "\n");

    queueReinsertHeadWithFreshId({ id: "req-old", action: "learn" }, "req-old");

    const lines = readFileSync(queueFile(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const head = JSON.parse(lines[0]!);
    expect(head["re-fired-from"]).toBe("req-old");
    expect(JSON.parse(lines[1]!).id).toBe("req-existing");
  });
});
