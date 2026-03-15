import { describe, expect, test } from "bun:test";
import { buildProposalNotificationActions, chunkNotificationActions } from "./notify.ts";

describe("buildProposalNotificationActions", () => {
  test("includes t3code, agent-claude, agent-codex, revise, and abandon buttons", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "project-x",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    expect(actions.map((action) => String(action.label))).toEqual([
      "t3code",
      "agent-claude",
      "agent-codex",
      "revise",
      "abandon",
    ]);
    expect(String(actions[0]!.body)).toBe("Launch t3code for task-042 in project project-x");
    expect(String(actions[1]!.body)).toBe("Launch agent-claude for task-042 in project project-x");
    expect(String(actions[2]!.body)).toBe("Launch agent-codex for task-042 in project project-x");
    expect(String(actions[3]!.body)).toBe("Revise proposal for task-042");
    expect(String(actions[4]!.body)).toBe("Abandon task task-042");
  });
});

describe("chunkNotificationActions", () => {
  test("splits proposal actions across two ntfy notifications", () => {
    const actions = buildProposalNotificationActions("task-042", "project-x", "incoming-topic", {});
    const chunks = chunkNotificationActions(actions, 3);

    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 2]);
    expect(chunks.flat().map((action) => String(action.label))).toEqual(
      actions.map((action) => String(action.label)),
    );
  });
});
