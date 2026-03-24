import { harnessDir } from "../config.ts";
import { readOrchestrationState } from "../orchestration/state.ts";
import type { AgentConfig } from "../orchestration/state.ts";
import { T3CodeClient } from "./client.ts";
import { doctorServer, ensureServer, readServerRecord, readSlotState, serverStatus, stopServer, t3codeServerPath } from "./server.ts";
import type { T3ThreadMessage } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withClient<T>(
  fn: (client: T3CodeClient) => Promise<T>,
  harness: string,
): Promise<T> {
  const record = readServerRecord(harness);
  if (!record) throw new Error("t3code server is not running (use: ludics t3code start)");
  const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatMessages(messages: T3ThreadMessage[]): void {
  if (messages.length === 0) {
    console.log("(no messages)");
    return;
  }

  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    const ts = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "";
    const separator = ts ? `=== ${role} [${ts}] ===` : `=== ${role} ===`;
    console.log(separator);
    console.log(msg.text.trimEnd());
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Thread lookup helpers
// ---------------------------------------------------------------------------

function resolveAgentName(
  agents: AgentConfig[],
  agentFlag: string | undefined,
): string | null {
  if (!agentFlag) {
    // Default: prefer the coder role, then first agent
    const coder = agents.find((a) => a.role === "coder");
    if (coder) return coder.name;
    return agents[0]?.name ?? null;
  }

  // Match by role first, then by name
  const byRole = agents.find((a) => a.role === agentFlag);
  if (byRole) return byRole.name;
  const byName = agents.find((a) => a.name === agentFlag || a.name.includes(agentFlag));
  if (byName) return byName.name;
  return null;
}

function resolveThreadId(slot: number, agentFlag: string | undefined): string {
  const state = readOrchestrationState(slot);
  if (!state) throw new Error(`no orchestration state found for slot ${slot}`);

  const agentName = resolveAgentName(state.agents, agentFlag);
  if (!agentName) {
    throw new Error(
      `no matching agent in slot ${slot}` +
        (agentFlag ? ` for --agent ${agentFlag}` : "") +
        ` (agents: ${state.agents.map((a) => a.name).join(", ")})`,
    );
  }

  const threadId = state.threadIds[agentName];
  if (!threadId) {
    throw new Error(
      `agent "${agentName}" in slot ${slot} has no associated t3code thread`,
    );
  }

  return threadId;
}

// ---------------------------------------------------------------------------
// Thread subcommands
// ---------------------------------------------------------------------------

async function threadLog(
  threadId: string,
  lastN: number | undefined,
  harness: string,
): Promise<void> {
  const messages = await withClient(
    (client) => client.getThreadMessages(threadId, lastN),
    harness,
  );
  formatMessages(messages);
}

async function threadSend(
  threadId: string,
  message: string,
  harness: string,
  waitForResponse: boolean,
): Promise<void> {
  const record = readServerRecord(harness);
  if (!record) throw new Error("t3code server is not running (use: ludics t3code start)");

  // Fetch current thread metadata for runtimeMode / interactionMode
  const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
  try {
    const snapshot = await client.getSnapshot();
    const thread = snapshot.threads.find((t) => t.id === threadId);
    const runtimeMode = thread?.runtimeMode ?? "full-access";
    const interactionMode = thread?.interactionMode ?? "default";

    await client.dispatchCommand({
      type: "thread.turn.start",
      commandId: makeId("cmd"),
      threadId,
      message: {
        messageId: makeId("msg"),
        role: "user",
        text: message,
        attachments: [],
      },
      runtimeMode,
      interactionMode,
      createdAt: isoNow(),
    });

    if (!waitForResponse) {
      console.log(`turn dispatched to thread ${threadId}`);
      return;
    }

    // Poll snapshot until the turn completes
    console.log("waiting for agent response...");
    const POLL_INTERVAL_MS = 1_500;
    const MAX_WAIT_MS = 30 * 60 * 1_000; // 30 minutes
    const deadline = Date.now() + MAX_WAIT_MS;
    let lastTurnId: string | null = null;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const snap = await client.getSnapshot();
        const t = snap.threads.find((x) => x.id === threadId);
        if (!t) break;

        const lt = t.latestTurn;
        if (!lt) continue;

        if (lastTurnId === null && (lt.state === "running" || lt.state === "completed")) {
          lastTurnId = lt.turnId;
        }

        if (lastTurnId && lt.turnId === lastTurnId && lt.state === "completed") {
          // Turn finished — fetch and show the last assistant message
          try {
            const msgs = await client.getThreadMessages(threadId, 1);
            const last = msgs.at(-1);
            if (last?.role === "assistant") {
              console.log();
              formatMessages(msgs);
            } else {
              console.log(`turn ${lastTurnId} completed`);
            }
          } catch {
            console.log(`turn ${lastTurnId} completed`);
          }
          return;
        }

        if (lastTurnId && lt.turnId === lastTurnId && lt.state === "error") {
          console.error(`turn ${lastTurnId} ended with error`);
          return;
        }

        if (lastTurnId && lt.turnId === lastTurnId && lt.state === "interrupted") {
          console.log(`turn ${lastTurnId} was interrupted`);
          return;
        }
      } catch {
        // transient error — keep polling
      }
    }

    console.log("timed out waiting for agent response (turn may still be running)");
  } finally {
    client.close();
  }
}

async function threadResponse(threadId: string, harness: string): Promise<void> {
  const messages = await withClient(
    (client) => client.getThreadMessages(threadId),
    harness,
  );

  // Show only the last assistant message
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) {
    console.log("(no assistant response found)");
    return;
  }

  formatMessages([last]);
}

// ---------------------------------------------------------------------------
// Argument parsing utilities
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseIntFlag(args: string[], flag: string): number | undefined {
  const val = parseFlag(args, flag);
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Strip known flags (--flag value / --flag) and return remaining positional args. */
function stripFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[],
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (valueFlags.includes(a)) {
      i += 2; // skip flag and its value
    } else if (boolFlags.includes(a)) {
      i += 1;
    } else {
      out.push(a);
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runT3Code(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const harness = harnessDir();

  switch (sub) {
    case "":
    case "status": {
      const status = await serverStatus({ harnessDir: harness });
      if (!status.record) {
        console.log("t3code: stopped");
        return;
      }

      console.log(status.running ? "t3code: running" : "t3code: unavailable");
      console.log(`pid: ${status.record.pid}`);
      console.log(`web: ${status.record.webUrl}`);
      console.log(`ws: ${status.record.wsUrl}`);
      console.log(`state: ${status.record.stateDir}`);
      console.log(`record: ${t3codeServerPath(harness)}`);
      if (status.reason) console.log(`reason: ${status.reason}`);
      if (status.snapshot) {
        console.log(`projects: ${status.snapshot.projects.length}`);
        console.log(`threads: ${status.snapshot.threads.length}`);
      }
      return;
    }

    case "start": {
      const record = await ensureServer({ harnessDir: harness });
      console.log(record.webUrl);
      return;
    }

    case "stop": {
      const stopped = await stopServer({ harnessDir: harness });
      console.log(stopped ? "t3code: stopped" : "t3code: not running");
      return;
    }

    case "doctor": {
      const result = await doctorServer({ harnessDir: harness });
      console.log(result.ok ? "t3code: healthy" : "t3code: unhealthy");
      for (const check of result.checks) {
        const icon = check.passed ? "✓" : "✗";
        console.log(`  ${icon} ${check.name}: ${check.detail}`);
      }
      if (!result.ok) process.exit(1);
      return;
    }

    // -----------------------------------------------------------------------
    // t3code thread <id> <subcmd> [flags]
    // -----------------------------------------------------------------------
    case "thread": {
      const threadId = args[1];
      if (!threadId) throw new Error("usage: ludics t3code thread <thread-id> <log|send|response>");

      const subcmd = args[2];
      const rest = args.slice(3);

      switch (subcmd) {
        case "log": {
          const lastN = parseIntFlag(rest, "--last");
          await threadLog(threadId, lastN, harness);
          return;
        }

        case "send": {
          const positional = stripFlags(rest, [], ["--wait"]);
          const message = positional[0];
          if (!message) throw new Error('usage: ludics t3code thread <id> send "<message>"');
          const wait = hasFlag(rest, "--wait");
          await threadSend(threadId, message, harness, wait);
          return;
        }

        case "response": {
          await threadResponse(threadId, harness);
          return;
        }

        default:
          throw new Error(
            `unknown thread subcommand: ${subcmd ?? "(none)"} (use: log, send, response)`,
          );
      }
    }

    // -----------------------------------------------------------------------
    // t3code slot <N> <subcmd> [flags]
    // -----------------------------------------------------------------------
    case "slot": {
      const slotArg = args[1];
      if (!slotArg) throw new Error("usage: ludics t3code slot <N> <log|send|response>");

      const slot = parseInt(slotArg, 10);
      if (isNaN(slot)) throw new Error(`invalid slot number: ${slotArg}`);

      const subcmd = args[2];
      const rest = args.slice(3);

      // Validate slot has state
      const slotState = readSlotState(slot, harness);
      if (!slotState && subcmd !== "log" && subcmd !== "send" && subcmd !== "response") {
        throw new Error(`no t3code slot state found for slot ${slot}`);
      }

      switch (subcmd) {
        case "log": {
          const agentFlag = parseFlag(rest, "--agent");
          const lastN = parseIntFlag(rest, "--last");
          const threadId = resolveThreadId(slot, agentFlag);
          await threadLog(threadId, lastN, harness);
          return;
        }

        case "send": {
          const agentFlag = parseFlag(rest, "--agent");
          const positional = stripFlags(rest, ["--agent"], ["--wait"]);
          const message = positional[0];
          if (!message) throw new Error('usage: ludics t3code slot <N> send [--agent <role>] "<message>"');
          const wait = hasFlag(rest, "--wait");
          const threadId = resolveThreadId(slot, agentFlag);
          await threadSend(threadId, message, harness, wait);
          return;
        }

        case "response": {
          const agentFlag = parseFlag(rest, "--agent");
          const threadId = resolveThreadId(slot, agentFlag);
          await threadResponse(threadId, harness);
          return;
        }

        default:
          throw new Error(
            `unknown slot subcommand: ${subcmd ?? "(none)"} (use: log, send, response)`,
          );
      }
    }

    default:
      throw new Error(
        `unknown t3code subcommand: ${sub} (use: status, start, stop, doctor, thread, slot)`,
      );
  }
}
