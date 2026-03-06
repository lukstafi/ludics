import { describe, expect, test } from "bun:test";
import { buildProposalNotificationActions, chunkNotificationActions } from "./notify.ts";

describe("buildProposalNotificationActions", () => {
  test("includes duo, pair, and single-agent launch buttons", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "project-x",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    expect(actions.map((action) => String(action.label))).toEqual([
      "agent-duo",
      "pair-claude",
      "pair-codex",
      "agent-claude",
      "agent-codex",
      "revise",
      "abandon",
    ]);
    expect(String(actions[3]!.body)).toBe("Launch agent-claude for task-042 in project project-x");
    expect(String(actions[4]!.body)).toBe("Launch agent-codex for task-042 in project project-x");
  });
});

describe("chunkNotificationActions", () => {
  test("splits proposal actions across three ntfy notifications", () => {
    const actions = buildProposalNotificationActions("task-042", "project-x", "incoming-topic", {});
    const chunks = chunkNotificationActions(actions, 3);

    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 3, 1]);
    expect(chunks.flat().map((action) => String(action.label))).toEqual(
      actions.map((action) => String(action.label)),
    );
  });
});
