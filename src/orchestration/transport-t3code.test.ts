import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { T3CodeTransport } from "./transport-t3code.ts";
import { T3CodeClient } from "../t3code/client.ts";
import * as t3server from "../t3code/server.ts";
import type { T3CodeServerRecord } from "../t3code/types.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";

// task-13dee93b AC9: T3CodeTransport.sendTurn wraps the first-turn dispatch
// (thread.turn.start) in dispatchWithFableContext, so a launch/first-message
// failure of a claude-fable session is rethrown with the actionable config-key
// remediation, while a non-Fable failure passes through unchanged.

const RECORD: T3CodeServerRecord = {
  pid: 1, port: 1234, host: "127.0.0.1",
  webUrl: "http://127.0.0.1:1234", wsUrl: "ws://127.0.0.1:1234", authToken: "t",
  stateDir: "/tmp/t3", startedAt: "2026-06-12T00:00:00Z", command: ["t3"],
};

function makeState(agentName: string): OrchestrationState {
  return { threadIds: { [agentName]: "thread-1" } } as unknown as OrchestrationState;
}

function makeAgent(model: string, role: "coder" | "reviewer"): AgentConfig {
  return { name: role, provider: "claude-code", role, model, branch: "b", worktreePath: "/tmp/wt" } as AgentConfig;
}

describe("T3CodeTransport.sendTurn — Fable-unavailable hard error (AC9)", () => {
  afterEach(() => {
    // spyOn auto-tracks; explicit restore via mock registry not needed per-call,
    // but we re-spy fresh in each test below.
  });

  test("a Fable first-turn dispatch failure rethrows naming reviewer_class + claude-opus", async () => {
    const recSpy = spyOn(t3server, "readServerRecord").mockReturnValue(RECORD);
    const closeSpy = spyOn(T3CodeClient.prototype, "close").mockImplementation(() => {});
    const dispatchSpy = spyOn(T3CodeClient.prototype, "dispatchCommand").mockImplementation(() =>
      Promise.reject(new Error("ws: model claude-fable-5 rejected")),
    );
    try {
      const t = new T3CodeTransport();
      const p = t.sendTurn(makeState("reviewer"), makeAgent("claude-fable-5", "reviewer"), "go");
      await expect(p).rejects.toThrow(/mag\.orchestration\.reviewer_class/);
      await expect(p).rejects.toThrow(/claude-opus/);
      await expect(p).rejects.toThrow(/claude-fable-5 rejected/); // original preserved
    } finally {
      recSpy.mockRestore();
      closeSpy.mockRestore();
      dispatchSpy.mockRestore();
    }
  });

  test("a non-Fable first-turn dispatch failure is NOT relabeled (mutation guard)", async () => {
    const recSpy = spyOn(t3server, "readServerRecord").mockReturnValue(RECORD);
    const closeSpy = spyOn(T3CodeClient.prototype, "close").mockImplementation(() => {});
    const dispatchSpy = spyOn(T3CodeClient.prototype, "dispatchCommand").mockImplementation(() =>
      Promise.reject(new Error("ws disconnected")),
    );
    try {
      const t = new T3CodeTransport();
      const p = t.sendTurn(makeState("coder"), makeAgent("claude-opus-4-8", "coder"), "go");
      await expect(p).rejects.toThrow(/ws disconnected/);
      await expect(p).rejects.not.toThrow(/mag\.orchestration/);
    } finally {
      recSpy.mockRestore();
      closeSpy.mockRestore();
      dispatchSpy.mockRestore();
    }
  });
});
