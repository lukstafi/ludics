import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractCleanPaneOutput, parseCaptureHeader, readTmuxCaptures } from "./tmux-capture.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ludics-tmux-capture-test-"));
}

describe("extractCleanPaneOutput", () => {
  test("extracts content between ⏺ marker and ❯ prompt", () => {
    const raw = [
      "some old output",
      "more old output",
      "⏺ Reading file src/index.ts",
      "  Line 1 of output",
      "  Line 2 of output",
      "  Line 3 of output",
      "  Line 4 of output",
      "  Line 5 of output",
      "❯ claude --help",
      "some stuff after prompt",
    ].join("\n");

    const result = extractCleanPaneOutput(raw);
    expect(result).not.toBeNull();
    expect(result).toContain("⏺ Reading file");
    expect(result).toContain("Line 5 of output");
    expect(result).not.toContain("❯ claude");
    expect(result).not.toContain("some old output");
  });

  test("strips separator lines", () => {
    const raw = [
      "⏺ Working on task",
      "──────────────────",
      "  Output line 1",
      "  Output line 2",
      "  Output line 3",
      "  Output line 4",
      "  Output line 5",
      "❯ ",
    ].join("\n");

    const result = extractCleanPaneOutput(raw);
    expect(result).not.toBeNull();
    expect(result).not.toContain("──────");
  });

  test("returns null for empty input", () => {
    expect(extractCleanPaneOutput("")).toBeNull();
    expect(extractCleanPaneOutput("\n\n\n")).toBeNull();
  });

  test("returns null for trivially short content", () => {
    const raw = [
      "⏺ Short",
      "  one line",
      "❯ ",
    ].join("\n");

    expect(extractCleanPaneOutput(raw)).toBeNull();
  });

  test("handles $ prompt for codex-style output", () => {
    const raw = [
      "⏺ Running codex task",
      "  Line 1",
      "  Line 2",
      "  Line 3",
      "  Line 4",
      "  Line 5",
      "$ npm test",
    ].join("\n");

    const result = extractCleanPaneOutput(raw);
    expect(result).not.toBeNull();
    expect(result).not.toContain("$ npm test");
  });
});

describe("readTmuxCaptures", () => {
  let tmp: string;

  afterEach(() => {
    try { rmSync(tmp, { recursive: true }); } catch { /* ignore */ }
  });

  test("reads and parses capture files", () => {
    tmp = makeTmpDir();
    const capturesDir = join(tmp, "captures");
    mkdirSync(capturesDir, { recursive: true });

    writeFileSync(join(capturesDir, "round-001-work-coder.txt"), [
      "agent: coder",
      "phase: work",
      "round: 1",
      "timestamp: 2026-04-04T20:00:00Z",
      "hash: abc123",
      "---",
      "⏺ Working on feature",
      "  Some output here",
    ].join("\n"));

    writeFileSync(join(capturesDir, "round-002-work-coder.txt"), [
      "agent: coder",
      "phase: work",
      "round: 2",
      "timestamp: 2026-04-04T21:00:00Z",
      "hash: def456",
      "---",
      "⏺ Continuing work",
      "  More output here",
    ].join("\n"));

    const entries = readTmuxCaptures(tmp);
    expect(entries).toHaveLength(2);

    expect(entries[0]!.agentName).toBe("coder");
    expect(entries[0]!.phase).toBe("work");
    expect(entries[0]!.round).toBe(1);
    expect(entries[0]!.hash).toBe("abc123");
    expect(entries[0]!.content).toContain("Working on feature");

    expect(entries[1]!.round).toBe(2);
    expect(entries[1]!.hash).toBe("def456");
  });

  test("sorts by round then agent name", () => {
    tmp = makeTmpDir();
    const capturesDir = join(tmp, "captures");
    mkdirSync(capturesDir, { recursive: true });

    const makeFile = (round: number, agent: string) =>
      writeFileSync(join(capturesDir, `round-${String(round).padStart(3, '0')}-work-${agent}.txt`), [
        `agent: ${agent}`,
        "phase: work",
        `round: ${round}`,
        "timestamp: 2026-04-04T20:00:00Z",
        "hash: h1",
        "---",
        "content",
      ].join("\n"));

    makeFile(2, "reviewer");
    makeFile(1, "reviewer");
    makeFile(1, "coder");

    const entries = readTmuxCaptures(tmp);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.round).toBe(1);
    expect(entries[0]!.agentName).toBe("coder");
    expect(entries[1]!.round).toBe(1);
    expect(entries[1]!.agentName).toBe("reviewer");
    expect(entries[2]!.round).toBe(2);
  });

  test("returns empty for missing directory", () => {
    tmp = makeTmpDir();
    expect(readTmuxCaptures(tmp)).toEqual([]);
  });

  test("skips malformed files", () => {
    tmp = makeTmpDir();
    const capturesDir = join(tmp, "captures");
    mkdirSync(capturesDir, { recursive: true });

    writeFileSync(join(capturesDir, "round-001-work-coder.txt"), "no header separator here");

    const entries = readTmuxCaptures(tmp);
    expect(entries).toHaveLength(0);
  });

  test("sorts correctly with round >= 10", () => {
    tmp = makeTmpDir();
    const capturesDir = join(tmp, "captures");
    mkdirSync(capturesDir, { recursive: true });

    const makeFile = (round: number, agent: string) =>
      writeFileSync(join(capturesDir, `round-${String(round).padStart(3, '0')}-work-${agent}.txt`), [
        `agent: ${agent}`,
        "phase: work",
        `round: ${round}`,
        "timestamp: 2026-04-04T20:00:00Z",
        "hash: h1",
        "---",
        "content",
      ].join("\n"));

    makeFile(12, "coder");
    makeFile(2, "coder");
    makeFile(1, "coder");

    const entries = readTmuxCaptures(tmp);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.round).toBe(1);
    expect(entries[1]!.round).toBe(2);
    expect(entries[2]!.round).toBe(12);
  });
});

describe("parseCaptureHeader", () => {
  test("parses valid header", () => {
    const raw = [
      "agent: coder",
      "phase: work",
      "round: 3",
      "timestamp: 2026-04-04T20:00:00Z",
      "hash: abc123",
      "---",
      "some content here",
    ].join("\n");

    const result = parseCaptureHeader(raw);
    expect(result).not.toBeNull();
    expect(result!.header.agentName).toBe("coder");
    expect(result!.header.phase).toBe("work");
    expect(result!.header.round).toBe(3);
    expect(result!.header.timestamp).toBe("2026-04-04T20:00:00Z");
    expect(result!.header.hash).toBe("abc123");
    expect(result!.content).toBe("some content here");
  });

  test("returns null for missing separator", () => {
    expect(parseCaptureHeader("no separator here")).toBeNull();
  });

  test("returns null for missing fields", () => {
    const raw = [
      "agent: coder",
      "phase: work",
      "---",
      "content",
    ].join("\n");

    expect(parseCaptureHeader(raw)).toBeNull();
  });
});
