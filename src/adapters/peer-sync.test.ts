import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import {
  readBasicState,
  readPorts,
  readWorktrees,
  readAgentSessionFile,
  listSessions,
  getPhaseStatus,
  findSessionByPrefixOrTask,
} from "./peer-sync.ts";

const TMP = join(import.meta.dir, ".test-tmp-peer-sync");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readBasicState
// ---------------------------------------------------------------------------

describe("readBasicState", () => {
  test("reads individual files", () => {
    const syncDir = join(TMP, "sync1");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "phase"), "work");
    writeFileSync(join(syncDir, "round"), "2");
    writeFileSync(join(syncDir, "session"), "test-session");
    writeFileSync(join(syncDir, "feature"), "my-feature");
    writeFileSync(join(syncDir, "mode"), "duo");

    const state = readBasicState(syncDir);
    expect(state.phase).toBe("work");
    expect(state.round).toBe("2");
    expect(state.session).toBe("test-session");
    expect(state.taskId).toBe("my-feature");
    expect(state.mode).toBe("duo");
  });

  test("reads task-id file when present (new canonical name)", () => {
    const syncDir = join(TMP, "sync-new-taskid");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "phase"), "work");
    writeFileSync(join(syncDir, "round"), "1");
    writeFileSync(join(syncDir, "session"), "s1");
    writeFileSync(join(syncDir, "task-id"), "task-abc123");
    writeFileSync(join(syncDir, "mode"), "duo");

    const state = readBasicState(syncDir);
    expect(state.taskId).toBe("task-abc123");
  });

  test("prefers task-id over legacy feature file", () => {
    const syncDir = join(TMP, "sync-both");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "phase"), "work");
    writeFileSync(join(syncDir, "round"), "1");
    writeFileSync(join(syncDir, "session"), "s1");
    writeFileSync(join(syncDir, "task-id"), "new-value");
    writeFileSync(join(syncDir, "feature"), "old-value");
    writeFileSync(join(syncDir, "mode"), "duo");

    const state = readBasicState(syncDir);
    expect(state.taskId).toBe("new-value");
  });

  test("falls back to state.json when individual files missing", () => {
    const syncDir = join(TMP, "sync-json");
    mkdirSync(syncDir);
    writeFileSync(
      join(syncDir, "state.json"),
      JSON.stringify({
        phase: "review",
        round: 3,
        session: "json-session",
        feature: "json-feat",
        mode: "pair",
      }),
    );

    const state = readBasicState(syncDir);
    expect(state.phase).toBe("review");
    expect(state.round).toBe("3");
    expect(state.session).toBe("json-session");
    expect(state.taskId).toBe("json-feat");
    expect(state.mode).toBe("pair");
  });

  test("returns empty strings for missing directory", () => {
    const state = readBasicState(join(TMP, "nonexistent"));
    expect(state.phase).toBe("");
    expect(state.round).toBe("");
  });

  test("individual files take priority over state.json", () => {
    const syncDir = join(TMP, "sync-both");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "phase"), "work");
    writeFileSync(join(syncDir, "session"), "file-session");
    writeFileSync(
      join(syncDir, "state.json"),
      JSON.stringify({ phase: "review", session: "json-session" }),
    );

    const state = readBasicState(syncDir);
    // Individual files are primary; JSON fallback only triggers when phase+session both empty
    expect(state.phase).toBe("work");
    expect(state.session).toBe("file-session");
  });
});

// ---------------------------------------------------------------------------
// readPorts
// ---------------------------------------------------------------------------

describe("readPorts", () => {
  test("parses key=value ports file", () => {
    const syncDir = join(TMP, "ports-test");
    mkdirSync(syncDir);
    writeFileSync(
      join(syncDir, "ports"),
      "ORCHESTRATOR_PORT=8080\nCLAUDE_PORT=8081\nCODEX_PORT=8082\n",
    );

    const ports = readPorts(syncDir);
    expect(ports.get("ORCHESTRATOR_PORT")).toBe("8080");
    expect(ports.get("CLAUDE_PORT")).toBe("8081");
    expect(ports.get("CODEX_PORT")).toBe("8082");
  });

  test("returns empty map for missing file", () => {
    const ports = readPorts(join(TMP, "no-ports"));
    expect(ports.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readWorktrees
// ---------------------------------------------------------------------------

describe("readWorktrees", () => {
  test("parses JSON worktrees file", () => {
    const syncDir = join(TMP, "wt-test");
    mkdirSync(syncDir);
    writeFileSync(
      join(syncDir, "worktrees.json"),
      JSON.stringify({ claude: "/path/a", codex: "/path/b" }),
    );

    const wt = readWorktrees(syncDir);
    expect(wt.claude).toBe("/path/a");
    expect(wt.codex).toBe("/path/b");
  });

  test("returns empty object for missing file", () => {
    const wt = readWorktrees(join(TMP, "no-wt"));
    expect(Object.keys(wt).length).toBe(0);
  });

  test("returns empty object for invalid JSON", () => {
    const syncDir = join(TMP, "bad-json");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "worktrees.json"), "not json");
    const wt = readWorktrees(syncDir);
    expect(Object.keys(wt).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readAgentSessionFile
// ---------------------------------------------------------------------------

describe("readAgentSessionFile", () => {
  test("reads key=value session file", () => {
    const path = join(TMP, "test.session");
    writeFileSync(
      path,
      [
        "agent=claude",
        "task=my-task",
        "tmux=session-1",
        "mode=agent-claude",
        "workdir=/home/user/project",
        "worktree=/home/user/wt",
        "ttyd_port=7681",
        "ttyd_pid=12345",
        "started=2025-01-01T00:00:00Z",
      ].join("\n") + "\n",
    );

    const info = readAgentSessionFile(path);
    expect(info).not.toBeNull();
    expect(info!.agent).toBe("claude");
    expect(info!.task).toBe("my-task");
    expect(info!.tmux).toBe("session-1");
    expect(info!.ttydPort).toBe("7681");
    expect(info!.ttydPid).toBe("12345");
    expect(info!.started).toBe("2025-01-01T00:00:00Z");
  });

  test("returns null for missing file", () => {
    expect(readAgentSessionFile(join(TMP, "missing.session"))).toBeNull();
  });

  test("returns null for directory target", () => {
    const dir = join(TMP, "dir-session");
    mkdirSync(dir);
    expect(readAgentSessionFile(dir)).toBeNull();
  });

  test("skips comment lines", () => {
    const path = join(TMP, "comments.session");
    writeFileSync(path, "# This is a comment\nagent=codex\n# another\ntask=t1\n");
    const info = readAgentSessionFile(path);
    expect(info!.agent).toBe("codex");
    expect(info!.task).toBe("t1");
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("listSessions", () => {
  test("returns empty for missing .agent-sessions", () => {
    expect(listSessions(TMP)).toEqual([]);
  });

  test("discovers symlinked .session files", () => {
    const sessionsDir = join(TMP, ".agent-sessions");
    mkdirSync(sessionsDir);

    // Create a target peer-sync directory
    const peerSync = join(TMP, "worktree", ".peer-sync");
    mkdirSync(peerSync, { recursive: true });
    writeFileSync(join(peerSync, "feature"), "test-feature");

    // Create symlink
    symlinkSync(peerSync, join(sessionsDir, "my-feature.session"));

    const sessions = listSessions(TMP);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.taskId).toBe("my-feature");
  });
});

// ---------------------------------------------------------------------------
// findSessionByPrefixOrTask
// ---------------------------------------------------------------------------

describe("findSessionByPrefixOrTask", () => {
  test("returns null for missing .agent-sessions", () => {
    expect(findSessionByPrefixOrTask(TMP, "task-1", ["claude-"])).toBeNull();
  });

  test("finds session file matching taskId", () => {
    const sessionsDir = join(TMP, ".agent-sessions");
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, "claude-task-123.session"), "agent=claude\n");
    writeFileSync(join(sessionsDir, "codex-other.session"), "agent=codex\n");

    const result = findSessionByPrefixOrTask(TMP, "task-123", ["codex-"]);
    expect(result).toBe(join(sessionsDir, "claude-task-123.session"));
  });

  test("falls back to prefix match when no taskId match", () => {
    const sessionsDir = join(TMP, ".agent-sessions");
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, "claude-something.session"), "agent=claude\n");

    const result = findSessionByPrefixOrTask(TMP, "nonexistent", ["claude-"]);
    expect(result).toBe(join(sessionsDir, "claude-something.session"));
  });

  test("returns null when no match", () => {
    const sessionsDir = join(TMP, ".agent-sessions");
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, "codex-task.session"), "agent=codex\n");

    const result = findSessionByPrefixOrTask(TMP, "other", ["claude-"]);
    expect(result).toBeNull();
  });

  test("ignores non-.session files", () => {
    const sessionsDir = join(TMP, ".agent-sessions");
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, "claude-task.txt"), "not a session\n");

    const result = findSessionByPrefixOrTask(TMP, "task", ["claude-"]);
    expect(result).toBeNull();
  });

  test("taskId match takes precedence over prefix match even when prefix appears first alphabetically", () => {
    const sessionsDir = join(TMP, ".agent-sessions");
    mkdirSync(sessionsDir);
    // "aaa-prefix-only.session" sorts before "zzz-task-123.session"
    writeFileSync(join(sessionsDir, "aaa-prefix-only.session"), "agent=claude\n");
    writeFileSync(join(sessionsDir, "zzz-task-123.session"), "agent=claude\n");

    const result = findSessionByPrefixOrTask(TMP, "task-123", ["aaa-"]);
    expect(result).toBe(join(sessionsDir, "zzz-task-123.session"));
  });
});

// ---------------------------------------------------------------------------
// getPhaseStatus
// ---------------------------------------------------------------------------

describe("getPhaseStatus", () => {
  test("returns phase with round", () => {
    const syncDir = join(TMP, "phase-test");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "phase"), "work");
    writeFileSync(join(syncDir, "round"), "3");
    expect(getPhaseStatus(syncDir)).toBe("work (round 3)");
  });

  test("returns phase without round", () => {
    const syncDir = join(TMP, "phase-only");
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, "phase"), "review");
    expect(getPhaseStatus(syncDir)).toBe("review");
  });

  test("returns 'active' when no phase", () => {
    const syncDir = join(TMP, "no-phase");
    mkdirSync(syncDir);
    expect(getPhaseStatus(syncDir)).toBe("active");
  });
});
