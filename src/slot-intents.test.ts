import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { writeSlotIntent, readSlotIntent, intentIsFresh, clearSlotIntent } from "./slot-intents.ts";
import type { SlotIntent } from "./slot-intents.ts";

const testHarnessDir = join(import.meta.dir, "__test-harness-intents__");
let originalHarnessDir: string | undefined;

beforeEach(() => {
  originalHarnessDir = process.env.LUDICS_HARNESS_DIR;
  process.env.LUDICS_HARNESS_DIR = testHarnessDir;
  mkdirSync(testHarnessDir, { recursive: true });
});

afterEach(() => {
  if (originalHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = originalHarnessDir;
  else delete process.env.LUDICS_HARNESS_DIR;
  rmSync(testHarnessDir, { recursive: true, force: true });
});

describe("slot-intents", () => {
  test("writeSlotIntent + readSlotIntent round-trip", () => {
    const intent: SlotIntent = {
      action: "start",
      epoch: Math.floor(Date.now() / 1000),
      machine: "worker-a",
    };
    writeSlotIntent(1, intent);
    const result = readSlotIntent(1);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("start");
    expect(result!.machine).toBe("worker-a");
    expect(result!.epoch).toBe(intent.epoch);
  });

  test("readSlotIntent returns null for missing file", () => {
    expect(readSlotIntent(99)).toBeNull();
  });

  test("intentIsFresh returns true for recent intent", () => {
    const intent: SlotIntent = {
      action: "stop",
      epoch: Math.floor(Date.now() / 1000) - 60,
      machine: "worker-a",
    };
    expect(intentIsFresh(intent)).toBe(true);
  });

  test("intentIsFresh returns false for stale intent", () => {
    const intent: SlotIntent = {
      action: "stop",
      epoch: Math.floor(Date.now() / 1000) - 700,
      machine: "worker-a",
    };
    expect(intentIsFresh(intent)).toBe(false);
  });

  test("clearSlotIntent removes file", () => {
    writeSlotIntent(2, {
      action: "resume",
      epoch: Math.floor(Date.now() / 1000),
      machine: "worker-b",
    });
    expect(readSlotIntent(2)).not.toBeNull();
    clearSlotIntent(2);
    expect(readSlotIntent(2)).toBeNull();
  });

  test("clearSlotIntent is no-op for missing file", () => {
    clearSlotIntent(99);
  });

  test("writeSlotIntent with preserveState", () => {
    writeSlotIntent(3, {
      action: "stop",
      epoch: Math.floor(Date.now() / 1000),
      machine: "worker-a",
      preserveState: true,
    });
    const result = readSlotIntent(3);
    expect(result!.preserveState).toBe(true);
  });

  test("last-writer-wins: new intent overwrites old", () => {
    writeSlotIntent(1, {
      action: "start",
      epoch: Math.floor(Date.now() / 1000) - 30,
      machine: "worker-a",
    });
    writeSlotIntent(1, {
      action: "stop",
      epoch: Math.floor(Date.now() / 1000),
      machine: "worker-a",
    });
    const result = readSlotIntent(1);
    expect(result!.action).toBe("stop");
  });
});
