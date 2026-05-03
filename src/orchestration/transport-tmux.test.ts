import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { ttydPort, TmuxTransport } from "./transport-tmux.ts";
import * as tmux from "../adapters/tmux.ts";
import * as fs from "fs";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState, type AgentConfig } from "./state.ts";

describe("ttydPort fixed-port mapping", () => {
  test("slot 1 coder → 7681", () => {
    expect(ttydPort(1, "coder")).toBe(7681);
  });

  test("slot 1 reviewer → 7682", () => {
    expect(ttydPort(1, "reviewer")).toBe(7682);
  });

  test("slot 2 coder → 7683", () => {
    expect(ttydPort(2, "coder")).toBe(7683);
  });

  test("slot 2 reviewer → 7684", () => {
    expect(ttydPort(2, "reviewer")).toBe(7684);
  });

  test("slot 3 coder → 7685", () => {
    expect(ttydPort(3, "coder")).toBe(7685);
  });

  test("slot 6 coder → 7691", () => {
    expect(ttydPort(6, "coder")).toBe(7691);
  });

  test("slot 6 reviewer → 7692", () => {
    expect(ttydPort(6, "reviewer")).toBe(7692);
  });

  test("all 12 ports are unique", () => {
    const ports = new Set<number>();
    for (let slot = 1; slot <= 6; slot++) {
      for (const role of ["coder", "reviewer"] as const) {
        ports.add(ttydPort(slot, role));
      }
    }
    expect(ports.size).toBe(12);
  });

  test("no port conflicts with reserved port 7680", () => {
    for (let slot = 1; slot <= 6; slot++) {
      for (const role of ["coder", "reviewer"] as const) {
        expect(ttydPort(slot, role)).not.toBe(7680);
      }
    }
  });

  test("all ports are in range 7681-7692", () => {
    for (let slot = 1; slot <= 6; slot++) {
      for (const role of ["coder", "reviewer"] as const) {
        const port = ttydPort(slot, role);
        expect(port).toBeGreaterThanOrEqual(7681);
        expect(port).toBeLessThanOrEqual(7692);
      }
    }
  });
});

describe("TmuxTransport class", () => {
  test("TmuxTransport is importable and constructable", async () => {
    const { TmuxTransport } = await import("./transport-tmux.ts");
    const transport = new TmuxTransport();
    expect(transport).toBeDefined();
    expect(typeof transport.sendTurn).toBe("function");
    expect(typeof transport.refreshAgentTransportState).toBe("function");
    expect(typeof transport.interruptAgent).toBe("function");
    // task-a670cdbf: tmux transport ships breakAndPrompt for hung recovery.
    expect(typeof transport.breakAndPrompt).toBe("function");
    // No subscribeEvents — pure polling
    const asTransport = transport as import("./transport.ts").OrchestrationTransport;
    expect(asTransport.subscribeEvents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// task-a670cdbf — breakAndPrompt: exactly one C-c, then sendTurn(message)
// ---------------------------------------------------------------------------

describe("TmuxTransport.breakAndPrompt (AC13)", () => {
  let sendKeysCalls: string[];
  let sendKeysSpy: ReturnType<typeof spyOn>;
  let spawnSyncSpy: ReturnType<typeof spyOn>;
  let sleepSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let panePidSpy: ReturnType<typeof spyOn>;
  let sendCommandSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sendKeysCalls = [];
    sendKeysSpy = spyOn(tmux, "tmuxSendKeys").mockImplementation((_target: string, keys: string) => {
      sendKeysCalls.push(keys);
      return true;
    });
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string[];
      if (cmd[0] === "pgrep") return { exitCode: 0, stdout: Buffer.from("99999\n"), stderr: Buffer.from("") } as never;
      if (cmd[0] === "ps") return { exitCode: 0, stdout: Buffer.from("claude\n"), stderr: Buffer.from("") } as never;
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as never;
    });
    sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
    sendCommandSpy = spyOn(tmux, "tmuxSendCommand").mockImplementation(() => true);
    writeFileSpy = spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    panePidSpy = spyOn(tmux, "tmuxPanePid").mockReturnValue(12345);
  });

  afterEach(() => {
    sendKeysSpy.mockRestore();
    spawnSyncSpy.mockRestore();
    sleepSpy.mockRestore();
    sendCommandSpy.mockRestore();
    writeFileSpy.mockRestore();
    panePidSpy.mockRestore();
  });

  test("sends exactly one C-c, sleeps, then sendTurn — never two C-c", async () => {
    const transport = new TmuxTransport();
    const agent: AgentConfig = {
      name: "coder",
      role: "coder",
      provider: "claude-code",
      model: "claude-opus-4-6",
      branch: "test",
      worktreePath: "/tmp/test",
    };
    const state = {
      slot: 1,
      taskId: "test-task",
      mode: "pair" as const,
      phase: "work" as const,
      round: 1,
      mergeRound: 0,
      agents: [agent],
      agentStates: initAgentRuntimeState(["coder"]),
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/p",
      rootWorktree: "/tmp/p",
      peerSyncDir: "/tmp/p/.peer-sync",
      threadIds: {},
    } satisfies OrchestrationState;

    // Capture before mockRestore (per feedback_capture_mock_calls_before_restore).
    await transport.breakAndPrompt(state, agent, "fresh prompt");

    const cCalls = sendKeysCalls.filter((k) => k === "C-c");
    expect(cCalls).toHaveLength(1);

    // sleep called at least once (the 2 s pre-sendTurn delay).
    expect(sleepSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // sendTurn fired (paste-buffer load-buffer call surfaces in spawnSync).
    const loadBuf = spawnSyncSpy.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[1] === "load-buffer",
    );
    expect(loadBuf).toBeDefined();
  });
});

describe("sendTurn prompt injection via paste-buffer", () => {
  let spawnCalls: string[][];
  let sendKeysCalls: string[];
  let writeFileCalls: { path: string; data: string }[];
  let spawnSyncSpy: ReturnType<typeof spyOn>;
  let sendKeysSpy: ReturnType<typeof spyOn>;
  let sendCommandSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let panePidSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnCalls = [];
    sendKeysCalls = [];
    writeFileCalls = [];

    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string[];
      spawnCalls.push(cmd);
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as never;
    });
    // Stub Bun.sleep to avoid actual delays
    spyOn(Bun, "sleep").mockResolvedValue(undefined as never);

    sendKeysSpy = spyOn(tmux, "tmuxSendKeys").mockImplementation((_target: string, keys: string) => {
      sendKeysCalls.push(keys);
      return true;
    });
    sendCommandSpy = spyOn(tmux, "tmuxSendCommand").mockImplementation(() => true);
    writeFileSpy = spyOn(fs, "writeFileSync").mockImplementation((path: unknown, data: unknown) => {
      writeFileCalls.push({ path: String(path), data: String(data) });
    });
    // isAgentCliAlive checks tmuxPanePid — return a pid so it thinks agent is alive
    // (avoids the boot path). We also need spawnSync to return pgrep output.
    panePidSpy = spyOn(tmux, "tmuxPanePid").mockReturnValue(12345);
    // Override spawnSync to also handle pgrep and ps for isAgentCliAlive
    spawnSyncSpy.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string[];
      spawnCalls.push(cmd);
      if (cmd[0] === "pgrep") {
        return { exitCode: 0, stdout: Buffer.from("99999\n"), stderr: Buffer.from("") } as never;
      }
      if (cmd[0] === "ps") {
        return { exitCode: 0, stdout: Buffer.from("claude\n"), stderr: Buffer.from("") } as never;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as never;
    });
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
    sendKeysSpy.mockRestore();
    sendCommandSpy.mockRestore();
    writeFileSpy.mockRestore();
    panePidSpy.mockRestore();
  });

  test("uses load-buffer and paste-buffer, not $(cat ...)", async () => {
    const transport = new TmuxTransport();
    const agent: AgentConfig = {
      name: "coder",
      role: "coder",
      provider: "claude-code",
      model: "claude-opus-4-6",
      branch: "test-branch",
      worktreePath: "/tmp/test-worktree",
    };
    const state = {
      slot: 1,
      taskId: "test-feature",
      mode: "duo" as const,
      phase: "work" as const,
      round: 1,
      mergeRound: 0,
      agents: [agent],
      agentStates: initAgentRuntimeState(["coder"]),
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/test",
      rootWorktree: "/tmp/test",
      peerSyncDir: "/tmp/test/.peer-sync",
      threadIds: {},
      currentPhaseToken: "phase-test",
    } satisfies OrchestrationState;

    const promptText = "Hello, this is a test prompt with special chars: $HOME `backticks` $(dangerous)";
    await transport.sendTurn(state, agent, promptText);

    // Claude Code uses load-buffer + paste-buffer
    const loadBufferCall = spawnCalls.find(c => c[0] === "tmux" && c[1] === "load-buffer");
    expect(loadBufferCall).toBeDefined();
    const pasteBufferCall = spawnCalls.find(c => c[0] === "tmux" && c[1] === "paste-buffer");
    expect(pasteBufferCall).toBeDefined();

    // Verify C-m was sent after the prompt
    const enterCall = spawnCalls.find(c => c[0] === "tmux" && c[1] === "send-keys" && c.includes("C-m"));
    expect(enterCall).toBeDefined();
  });
});
