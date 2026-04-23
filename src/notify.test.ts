import { describe, expect, test } from "bun:test";
import { buildProposalNotificationActions, chunkNotificationActions } from "./notify.ts";

describe("buildProposalNotificationActions", () => {
  test("includes approve, revise, and abandon buttons", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "project-x",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    expect(actions.map((action) => String(action.label))).toEqual([
      "approve",
      "revise",
      "abandon",
    ]);
    expect(String(actions[0]!.body)).toBe("Approve task task-042");
    expect(String(actions[1]!.body)).toBe("Revise proposal for task-042");
    expect(String(actions[2]!.body)).toBe("Abandon task task-042");
  });
});

describe("chunkNotificationActions", () => {
  test("proposal actions fit in one chunk", () => {
    const actions = buildProposalNotificationActions("task-042", "project-x", "incoming-topic", {});
    const chunks = chunkNotificationActions(actions, 3);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(3);
    expect(chunks.flat().map((action) => String(action.label))).toEqual(
      actions.map((action) => String(action.label)),
    );
  });
});

describe("buildProposalNotificationActions — t3code-only format", () => {
  test("action bodies contain no adapter or project references", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "some-project",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    for (const action of actions) {
      const body = String(action.body);
      // Must not contain adapter-specific launch patterns
      expect(body).not.toMatch(/Launch \w+ for/);
      // Must not contain "in project" suffix
      expect(body).not.toContain("in project");
    }

    // Verify exact modern format
    expect(String(actions[0]!.body)).toBe("Approve task task-042");
  });
});

import { afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("notify state-file atomic writes", () => {
  let tmpDir: string;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-notify-state-"));
    mkdirSync(join(tmpDir, "mag"), { recursive: true });
    process.env.LUDICS_HARNESS_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  });

  test("saveSessionConclusionState round-trips via loadSessionConclusionState, no .tmp leftover", async () => {
    const { saveSessionConclusionState, loadSessionConclusionState, sessionConclusionStateFile } = await import("./notify.ts");
    const state = { "task-a": "2026-04-24T00:00:00Z", "task-b": "2026-04-24T01:00:00Z" };
    saveSessionConclusionState(state);
    expect(loadSessionConclusionState()).toEqual(state);
    expect(existsSync(sessionConclusionStateFile() + ".tmp")).toBe(false);
  });

  test("saveSubscriberState round-trips via loadSubscriberState and preserves compact JSON shape", async () => {
    const { saveSubscriberState, loadSubscriberState, subscriberStateFile } = await import("./notify.ts");
    saveSubscriberState("msg-42");
    const state = loadSubscriberState();
    expect(state.last_id).toBe("msg-42");
    expect(typeof state.last_time).toBe("string");
    // Compact JSON — no pretty-print indentation
    const raw = readFileSync(subscriberStateFile(), "utf-8");
    expect(raw).not.toContain("\n  \"");
    expect(existsSync(subscriberStateFile() + ".tmp")).toBe(false);
  });

  test("setPendingFollowupRevise writes compact JSON payload with no .tmp leftover", async () => {
    const { setPendingFollowupRevise, pendingFollowupReviseFile } = await import("./notify.ts");
    setPendingFollowupRevise("task-xyz", "t3code");
    const file = pendingFollowupReviseFile("task-xyz", "t3code");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".tmp")).toBe(false);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.task).toBe("task-xyz");
    expect(parsed.adapter).toBe("t3code");
    expect(typeof parsed.created).toBe("number");
  });
});
