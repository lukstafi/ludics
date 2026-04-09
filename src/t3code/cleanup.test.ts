import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { extractTaskId, cleanupStaleItems } from "./index.ts";
import type { Server, ServerWebSocket } from "bun";
import { ORCHESTRATION_WS_METHODS } from "./types.ts";
import type { T3Snapshot, T3Thread, T3Project } from "./types.ts";

// ---------------------------------------------------------------------------
// extractTaskId unit tests
// ---------------------------------------------------------------------------

describe("extractTaskId", () => {
  test("extracts task-<hex> from thread title", () => {
    expect(extractTaskId("task-abc123 (coder)")).toBe("task-abc123");
  });

  test("extracts gh-<project>-<num> from thread title", () => {
    expect(extractTaskId("gh-ludics-153 review")).toBe("gh-ludics-153");
  });

  test("returns null for titles without task IDs", () => {
    expect(extractTaskId("some random thread")).toBeNull();
  });

  test("extracts first match when multiple IDs present", () => {
    expect(extractTaskId("task-aaa111 blocks task-bbb222")).toBe("task-aaa111");
  });
});

// ---------------------------------------------------------------------------
// cleanupStaleItems integration tests
// ---------------------------------------------------------------------------

// Probe whether we can bind a loopback socket — skip integration tests if not.
let canBind = true;
try {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() { return new Response("ok"); },
  });
  probe.stop(true);
} catch {
  canBind = false;
}

const TMP = join(import.meta.dir, "../../.test-tmp-cleanup-" + process.pid);

type RequestEnvelope = {
  id: string;
  body: { _tag: string; [key: string]: unknown };
};

const servers: Server<undefined>[] = [];

function makeThread(overrides: Partial<T3Thread>): T3Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    title: "test thread",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5-20250514" },
    runtimeMode: "full-access",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<T3Project>): T3Project {
  return {
    id: "proj-1",
    title: "Test Project",
    workspaceRoot: "/nonexistent/path",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function startMockServer(snapshot: T3Snapshot, commands: { type: string; threadId?: string }[]) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open() {},
      message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        const req = msg as RequestEnvelope;
        if (req.body?._tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
          ws.send(JSON.stringify({ id: req.id, result: snapshot }));
        } else if (req.body?._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          const cmd = req.body.command as { type: string; threadId?: string };
          commands.push({ type: cmd.type, threadId: cmd.threadId });
          ws.send(JSON.stringify({ id: req.id, result: { sequence: 1 } }));
        }
      },
    },
  });
  servers.push(server);
  return server;
}

function setupHarness(
  snapshot: T3Snapshot,
  opts?: {
    slotThreadIds?: string[];
    tasks?: { id: string; status: string }[];
    slotTasks?: { slot: number; task: string }[];
  },
) {
  const harness = join(TMP, `harness-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(harness, "t3code"), { recursive: true });
  mkdirSync(join(harness, "tasks"), { recursive: true });
  mkdirSync(join(harness, "slots"), { recursive: true });

  const commands: { type: string; threadId?: string }[] = [];
  const server = startMockServer(snapshot, commands);

  // Write server record
  writeFileSync(join(harness, "t3code", "server.json"), JSON.stringify({
    pid: process.pid,
    port: server.port,
    host: "127.0.0.1",
    webUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    stateDir: join(harness, "t3code", "state"),
    startedAt: "2026-01-01T00:00:00Z",
    command: ["t3"],
  }));

  // Write slot state files with active thread IDs
  if (opts?.slotThreadIds) {
    writeFileSync(join(harness, "t3code", "slot-1.json"), JSON.stringify({
      slot: 1,
      threads: opts.slotThreadIds.map(id => ({
        threadId: id,
        projectId: "proj-1",
        worktreePath: "/tmp",
        title: "active",
        model: "test",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })),
    }));
  }

  // Write task files
  if (opts?.tasks) {
    for (const t of opts.tasks) {
      writeFileSync(join(harness, "tasks", `${t.id}.md`), `---\nid: ${t.id}\ntitle: test\nstatus: ${t.status}\n---\n`);
    }
  }

  // Write slot assignment files
  if (opts?.slotTasks) {
    for (const s of opts.slotTasks) {
      writeFileSync(join(harness, "slots", `slot-${s.slot}.json`), JSON.stringify({
        slot: s.slot, process: "", task: s.task, mode: null, session: null,
        path: null, started: null, adapterArgs: null, machine: null,
        sessionStarted: null, liveness: null, terminals: "", runtime: "", git: "",
      }));
    }
  }

  return { harness, commands };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("cleanupStaleItems", () => {
  const skipUnless = canBind ? test : test.skip;

  skipUnless("deletes threads with terminal task status beyond 25h", async () => {
    const oldDate = "2026-01-01T00:00:00Z"; // well beyond 25h
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-stale", title: "task-aaa111 (coder)", updatedAt: oldDate })],
      updatedAt: oldDate,
    };
    const { harness, commands } = setupHarness(snapshot, {
      tasks: [{ id: "task-aaa111", status: "done" }],
    });

    const result = await cleanupStaleItems(harness, false);
    expect(result.threadsDeleted).toContain("t-stale");
    expect(commands.some(c => c.type === "thread.delete" && c.threadId === "t-stale")).toBe(true);
  });

  skipUnless("preserves threads with unknown/missing task status", async () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-unknown", title: "task-bbb222 (coder)", updatedAt: oldDate })],
      updatedAt: oldDate,
    };
    // No task file for task-bbb222 → status is null → should be preserved
    const { harness, commands } = setupHarness(snapshot);

    const result = await cleanupStaleItems(harness, false);
    expect(result.threadsDeleted).not.toContain("t-unknown");
    expect(commands.filter(c => c.type === "thread.delete")).toHaveLength(0);
  });

  skipUnless("preserves threads with non-terminal task status", async () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-active", title: "task-ccc333 (coder)", updatedAt: oldDate })],
      updatedAt: oldDate,
    };
    const { harness, commands } = setupHarness(snapshot, {
      tasks: [{ id: "task-ccc333", status: "in-progress" }],
    });

    const result = await cleanupStaleItems(harness, false);
    expect(result.threadsDeleted).not.toContain("t-active");
    expect(commands.filter(c => c.type === "thread.delete")).toHaveLength(0);
  });

  skipUnless("preserves threads referenced by slot state", async () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-slotted", title: "task-ddd444 (coder)", updatedAt: oldDate })],
      updatedAt: oldDate,
    };
    const { harness, commands } = setupHarness(snapshot, {
      slotThreadIds: ["t-slotted"],
      tasks: [{ id: "task-ddd444", status: "done" }],
    });

    const result = await cleanupStaleItems(harness, false);
    expect(result.threadsDeleted).not.toContain("t-slotted");
    expect(commands.filter(c => c.type === "thread.delete")).toHaveLength(0);
  });

  skipUnless("skips threads within 25h post-mortem window", async () => {
    const recentDate = new Date().toISOString(); // now — within 25h
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-recent", title: "task-eee555 (coder)", updatedAt: recentDate })],
      updatedAt: recentDate,
    };
    const { harness, commands } = setupHarness(snapshot, {
      tasks: [{ id: "task-eee555", status: "done" }],
    });

    const result = await cleanupStaleItems(harness, false);
    expect(result.threadsDeleted).not.toContain("t-recent");
    expect(result.threadsSkipped).toContain("t-recent");
  });

  skipUnless("dry-run does not dispatch commands", async () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-dry", title: "task-fff666 (coder)", updatedAt: oldDate })],
      updatedAt: oldDate,
    };
    const { harness, commands } = setupHarness(snapshot, {
      tasks: [{ id: "task-fff666", status: "abandoned" }],
    });

    const result = await cleanupStaleItems(harness, true);
    expect(result.threadsDeleted).toContain("t-dry");
    expect(commands).toHaveLength(0); // no commands dispatched
  });

  skipUnless("flags projects with missing workspace", async () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ id: "proj-gone", workspaceRoot: "/nonexistent/path/xyz", updatedAt: oldDate })],
      threads: [],
      updatedAt: oldDate,
    };
    const { harness } = setupHarness(snapshot);

    const result = await cleanupStaleItems(harness, true);
    expect(result.projectsStale).toContain("proj-gone");
  });

  skipUnless("skips already-deleted threads", async () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const snapshot: T3Snapshot = {
      snapshotSequence: 1,
      projects: [makeProject({ workspaceRoot: TMP })],
      threads: [makeThread({ id: "t-deleted", title: "task-ggg777 (coder)", updatedAt: oldDate, deletedAt: oldDate })],
      updatedAt: oldDate,
    };
    const { harness, commands } = setupHarness(snapshot, {
      tasks: [{ id: "task-ggg777", status: "done" }],
    });

    const result = await cleanupStaleItems(harness, false);
    expect(result.threadsDeleted).not.toContain("t-deleted");
    expect(commands).toHaveLength(0);
  });
});
