import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { withSyntheticHarness } from "./test-utils.ts";
import { queueRequest, queueRequestAtHead } from "./queue.ts";

function readLastEvent(stateDir: string): Record<string, unknown> {
  const evPath = join(stateDir, "journal", "events.jsonl");
  expect(existsSync(evPath)).toBe(true);
  const lines = readFileSync(evPath, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe("queue_request event payload — messageContent field (gh-ludics-538)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("queueRequest with action=message attaches messageContent verbatim", () => {
    queueRequest({ action: "message", content: "/compact" });
    const ev = readLastEvent(getStateDir());
    expect(ev.event_type).toBe("queue_request");
    expect(ev.action).toBe("message");
    expect(ev.messageContent).toBe("/compact");
  });

  test("queueRequest with action=message truncates content to 200 chars", () => {
    const long = "a".repeat(500);
    queueRequest({ action: "message", content: long });
    const ev = readLastEvent(getStateDir());
    expect(typeof ev.messageContent).toBe("string");
    expect((ev.messageContent as string).length).toBe(200);
  });

  test("queueRequest with non-message action omits messageContent", () => {
    queueRequest({ action: "briefing" });
    const ev = readLastEvent(getStateDir());
    expect(ev.event_type).toBe("queue_request");
    expect(ev.action).toBe("briefing");
    expect("messageContent" in ev).toBe(false);
  });

  test("queueRequestAtHead with action=message attaches messageContent", () => {
    queueRequestAtHead({ action: "message", content: "/compact" });
    const ev = readLastEvent(getStateDir());
    expect(ev.action).toBe("message");
    expect(ev.messageContent).toBe("/compact");
  });

  test("queueRequestAtHead with non-message action omits messageContent", () => {
    queueRequestAtHead({ action: "feedback-digest", repo: "ludics" });
    const ev = readLastEvent(getStateDir());
    expect(ev.action).toBe("feedback-digest");
    expect("messageContent" in ev).toBe(false);
  });
});
