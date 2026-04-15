import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
