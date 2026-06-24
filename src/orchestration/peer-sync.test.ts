import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { initPeerSync, PEER_SYNC_DIRNAME, peerSyncPath, resolvePeerSyncDir } from "./peer-sync.ts";

const TMP = join(import.meta.dir, ".test-tmp-peer-sync");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.LUDICS_PEER_SYNC_DIR;
});

describe("PEER_SYNC_DIRNAME", () => {
  test("equals .peer-sync", () => {
    expect(PEER_SYNC_DIRNAME).toBe(".peer-sync");
  });
});

describe("initPeerSync provider markers (gh-ludics-597)", () => {
  test("writes per-name provider markers for custom-named agents (and keeps role-based ones)", () => {
    const peerSyncDir = join(TMP, "ps");
    const projectDir = join(TMP, "proj");
    const wt = join(TMP, "wt");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(wt, { recursive: true });

    const agents = [
      { name: "alice", provider: "claude-code", role: "coder", model: "m", branch: "b1", worktreePath: wt },
      { name: "bob", provider: "codex", role: "reviewer", model: "m", branch: "b2", worktreePath: wt },
    ] as unknown as Parameters<typeof initPeerSync>[4];

    initPeerSync(peerSyncDir, "task-x", "pair", projectDir, agents, { root: wt, alice: wt, bob: wt });

    // Per-name markers (the gh-597 fix) — let orchOnStop resolve custom names.
    expect(readFileSync(join(peerSyncDir, "alice-agent"), "utf-8").trim()).toBe("claude-code");
    expect(readFileSync(join(peerSyncDir, "bob-agent"), "utf-8").trim()).toBe("codex");
    // Role-based markers still present for back-compat.
    expect(readFileSync(join(peerSyncDir, "coder-agent"), "utf-8").trim()).toBe("claude-code");
    expect(readFileSync(join(peerSyncDir, "reviewer-agent"), "utf-8").trim()).toBe("codex");
  });
});

describe("peerSyncPath", () => {
  test("joins root with dirname", () => {
    expect(peerSyncPath("/some/root")).toBe("/some/root/.peer-sync");
  });
});

describe("resolvePeerSyncDir", () => {
  function makePeerSync(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase"), "coding");
  }

  test("returns cliArg when it has a phase file", () => {
    const dir = join(TMP, "cli");
    makePeerSync(dir);
    expect(resolvePeerSyncDir({ cliArg: dir })).toBe(dir);
  });

  test("falls back to env var when cliArg is invalid", () => {
    const envDir = join(TMP, "env");
    makePeerSync(envDir);
    process.env.LUDICS_PEER_SYNC_DIR = envDir;
    expect(resolvePeerSyncDir({ cliArg: join(TMP, "nonexistent") })).toBe(envDir);
  });

  test("falls back to env var when cliArg is missing", () => {
    const envDir = join(TMP, "env2");
    makePeerSync(envDir);
    process.env.LUDICS_PEER_SYNC_DIR = envDir;
    expect(resolvePeerSyncDir({})).toBe(envDir);
  });

  test("returns null when both are missing", () => {
    expect(resolvePeerSyncDir({})).toBeNull();
  });

  test("returns null when cliArg exists but has no phase file", () => {
    const dir = join(TMP, "no-phase");
    mkdirSync(dir, { recursive: true });
    expect(resolvePeerSyncDir({ cliArg: dir })).toBeNull();
  });

  test("prefers cliArg over env var when both valid", () => {
    const cliDir = join(TMP, "cli2");
    const envDir = join(TMP, "env3");
    makePeerSync(cliDir);
    makePeerSync(envDir);
    process.env.LUDICS_PEER_SYNC_DIR = envDir;
    expect(resolvePeerSyncDir({ cliArg: cliDir })).toBe(cliDir);
  });
});
