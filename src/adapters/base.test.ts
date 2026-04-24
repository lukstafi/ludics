import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  adapterStateDir,
  ensureAdapterStateDir,
  readStateFile,
  writeStateFile,
  readStateKey,
  updateStateKey,
  removeStateKey,
  readStatusFile,
  writeStatusFile,
  formatAgentStatus,
  timeAgo,
  readSingleFile,
  isGitWorktree,
  resolveProjectDir,
} from "./base.ts";

const TMP = join(import.meta.dir, ".test-tmp-base");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readStateFile / writeStateFile roundtrip
// ---------------------------------------------------------------------------

describe("readStateFile / writeStateFile", () => {
  test("roundtrip preserves key-value pairs", () => {
    const path = join(TMP, "state.kv");
    const data = new Map<string, string>([
      ["foo", "bar"],
      ["baz", "42"],
      ["empty", ""],
    ]);
    writeStateFile(path, data);
    const read = readStateFile(path);
    expect(read.get("foo")).toBe("bar");
    expect(read.get("baz")).toBe("42");
    expect(read.get("empty")).toBe("");
  });

  test("returns empty map for missing file", () => {
    const read = readStateFile(join(TMP, "nonexistent"));
    expect(read.size).toBe(0);
  });

  test("skips comment lines and blank lines", () => {
    const path = join(TMP, "comments.kv");
    writeFileSync(path, "# comment\nkey=val\n\n# another\nkey2=val2\n");
    const read = readStateFile(path);
    expect(read.size).toBe(2);
    expect(read.get("key")).toBe("val");
    expect(read.get("key2")).toBe("val2");
  });

  test("handles values containing = signs", () => {
    const path = join(TMP, "eq.kv");
    writeFileSync(path, "url=https://example.com?a=1&b=2\n");
    const read = readStateFile(path);
    expect(read.get("url")).toBe("https://example.com?a=1&b=2");
  });
});

// ---------------------------------------------------------------------------
// readStateKey / updateStateKey / removeStateKey
// ---------------------------------------------------------------------------

describe("state key helpers", () => {
  test("readStateKey returns undefined for missing key", () => {
    const path = join(TMP, "key.kv");
    writeFileSync(path, "a=1\n");
    expect(readStateKey(path, "b")).toBeUndefined();
    expect(readStateKey(path, "a")).toBe("1");
  });

  test("updateStateKey creates and updates", () => {
    const path = join(TMP, "update.kv");
    updateStateKey(path, "x", "10");
    expect(readStateKey(path, "x")).toBe("10");
    updateStateKey(path, "x", "20");
    expect(readStateKey(path, "x")).toBe("20");
  });

  test("removeStateKey deletes key", () => {
    const path = join(TMP, "remove.kv");
    const data = new Map([["a", "1"], ["b", "2"]]);
    writeStateFile(path, data);
    removeStateKey(path, "a");
    const read = readStateFile(path);
    expect(read.has("a")).toBe(false);
    expect(read.get("b")).toBe("2");
  });

  test("removeStateKey is no-op for missing key", () => {
    const path = join(TMP, "noop.kv");
    writeFileSync(path, "a=1\n");
    removeStateKey(path, "missing");
    expect(readStateKey(path, "a")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// readStatusFile / writeStatusFile
// ---------------------------------------------------------------------------

describe("readStatusFile / writeStatusFile", () => {
  test("roundtrip preserves status and message", () => {
    const path = join(TMP, "status");
    writeStatusFile(path, "working", "doing stuff");
    const s = readStatusFile(path);
    expect(s).not.toBeNull();
    expect(s!.status).toBe("working");
    expect(s!.message).toBe("doing stuff");
    expect(s!.epoch).toBeGreaterThan(0);
  });

  test("returns null for missing file", () => {
    expect(readStatusFile(join(TMP, "missing"))).toBeNull();
  });

  test("returns null for empty file", () => {
    const path = join(TMP, "empty-status");
    writeFileSync(path, "");
    expect(readStatusFile(path)).toBeNull();
  });

  test("returns null for whitespace-only file", () => {
    const path = join(TMP, "ws-status");
    writeFileSync(path, "  \n  ");
    expect(readStatusFile(path)).toBeNull();
  });

  test("handles status with no message", () => {
    const path = join(TMP, "no-msg");
    writeFileSync(path, "paused|1700000000|\n");
    const s = readStatusFile(path);
    expect(s!.status).toBe("paused");
    expect(s!.epoch).toBe(1700000000);
    expect(s!.message).toBe("");
  });

  test("handles message containing pipes", () => {
    const path = join(TMP, "pipes");
    writeFileSync(path, "error|1700000000|reason|extra|detail\n");
    const s = readStatusFile(path);
    expect(s!.status).toBe("error");
    expect(s!.message).toBe("reason|extra|detail");
  });

  test("handles malformed single-field line", () => {
    const path = join(TMP, "malformed");
    writeFileSync(path, "justastatus\n");
    const s = readStatusFile(path);
    expect(s!.status).toBe("justastatus");
    expect(s!.epoch).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatAgentStatus
// ---------------------------------------------------------------------------

describe("formatAgentStatus", () => {
  test("formats status with message", () => {
    expect(formatAgentStatus({ status: "working", epoch: 0, message: "on task" })).toBe(
      "working - on task",
    );
  });

  test("formats status without message", () => {
    expect(formatAgentStatus({ status: "idle", epoch: 0, message: "" })).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// timeAgo
// ---------------------------------------------------------------------------

describe("timeAgo", () => {
  test("seconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 30)).toBe("30s ago");
  });

  test("minutes", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 120)).toBe("2m ago");
  });

  test("hours", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 7200)).toBe("2h ago");
  });

  test("days", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 172800)).toBe("2d ago");
  });
});

// ---------------------------------------------------------------------------
// readSingleFile
// ---------------------------------------------------------------------------

describe("readSingleFile", () => {
  test("reads and trims", () => {
    const path = join(TMP, "single");
    writeFileSync(path, "  hello world  \n");
    expect(readSingleFile(path)).toBe("hello world");
  });

  test("returns null for missing file", () => {
    expect(readSingleFile(join(TMP, "missing"))).toBeNull();
  });

  test("returns null for empty file", () => {
    const path = join(TMP, "empty");
    writeFileSync(path, "");
    expect(readSingleFile(path)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isGitWorktree
// ---------------------------------------------------------------------------

describe("isGitWorktree", () => {
  test("returns false if no .git", () => {
    expect(isGitWorktree(TMP)).toBe(false);
  });

  test("returns false if .git is a directory", () => {
    mkdirSync(join(TMP, ".git"), { recursive: true });
    expect(isGitWorktree(TMP)).toBe(false);
  });

  test("returns true if .git is a file", () => {
    writeFileSync(join(TMP, ".git"), "gitdir: /some/path");
    expect(isGitWorktree(TMP)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectDir
// ---------------------------------------------------------------------------

describe("resolveProjectDir", () => {
  test("returns cwd for empty session", () => {
    expect(resolveProjectDir("")).toBe(process.cwd());
    expect(resolveProjectDir("null")).toBe(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// adapterStateDir / ensureAdapterStateDir — harnessDir parametrization
// ---------------------------------------------------------------------------

describe("adapterStateDir (harnessDir parametrization)", () => {
  const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
  let ISO_TMP = "";
  let DECOY = "";

  beforeEach(() => {
    ISO_TMP = mkdtempSync(join(tmpdir(), "ludics-adapterStateDir-"));
    DECOY = mkdtempSync(join(tmpdir(), "ludics-adapterStateDir-decoy-"));
    process.env.LUDICS_HARNESS_DIR = DECOY;
  });

  afterEach(() => {
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    rmSync(ISO_TMP, { recursive: true, force: true });
    rmSync(DECOY, { recursive: true, force: true });
  });

  test("explicit harnessDir arg is authoritative over LUDICS_HARNESS_DIR", () => {
    expect(adapterStateDir("manual", ISO_TMP)).toBe(join(ISO_TMP, "manual"));
  });

  test("default arg falls back to LUDICS_HARNESS_DIR", () => {
    expect(adapterStateDir("manual")).toBe(join(DECOY, "manual"));
  });

  test("ensureAdapterStateDir creates under explicit harnessDir, not the decoy", () => {
    const dir = ensureAdapterStateDir("manual", ISO_TMP);
    expect(dir).toBe(join(ISO_TMP, "manual"));
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(DECOY, "manual"))).toBe(false);
  });

  test("ensureAdapterStateDir default arg creates under LUDICS_HARNESS_DIR", () => {
    const dir = ensureAdapterStateDir("manual");
    expect(dir).toBe(join(DECOY, "manual"));
    expect(existsSync(dir)).toBe(true);
  });
});
