import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { PEER_SYNC_DIRNAME, peerSyncPath, resolvePeerSyncDir } from "./peer-sync.ts";

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
