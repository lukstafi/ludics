import { describe, expect, test } from "bun:test";
import { mergeVoteFilename, mergeVoteFilePath, parseMergeVoteFilename } from "./merge-vote-files.ts";

describe("mergeVoteFilename", () => {
  test("builds merge vote filename", () => {
    expect(mergeVoteFilename(3, "coder")).toBe("round-3-coder.txt");
  });

  test("handles hyphenated agent names", () => {
    expect(mergeVoteFilename(1, "codex-reviews-claude")).toBe("round-1-codex-reviews-claude.txt");
  });

  test("handles underscore agent names", () => {
    expect(mergeVoteFilename(2, "my_agent")).toBe("round-2-my_agent.txt");
  });

  test("throws on invalid agent names", () => {
    expect(() => mergeVoteFilename(1, "bad.name")).toThrow("invalid agent name");
    expect(() => mergeVoteFilename(1, "has space")).toThrow("invalid agent name");
    expect(() => mergeVoteFilename(1, "a/b")).toThrow("invalid agent name");
  });
});

describe("mergeVoteFilePath", () => {
  test("joins peerSyncDir with merge-votes/ and filename", () => {
    const result = mergeVoteFilePath("/tmp/peer-sync", 2, "coder");
    expect(result).toBe("/tmp/peer-sync/merge-votes/round-2-coder.txt");
  });
});

describe("parseMergeVoteFilename", () => {
  test("parses valid merge vote filename", () => {
    expect(parseMergeVoteFilename("round-3-coder.txt")).toEqual({
      round: 3,
      agentName: "coder",
    });
  });

  test("parses hyphenated agent names", () => {
    expect(parseMergeVoteFilename("round-1-my-agent.txt")).toEqual({
      round: 1,
      agentName: "my-agent",
    });
  });

  test("returns null for non-matching strings", () => {
    expect(parseMergeVoteFilename("")).toBeNull();
    expect(parseMergeVoteFilename("random.txt")).toBeNull();
    expect(parseMergeVoteFilename("round-abc-coder.txt")).toBeNull();
    expect(parseMergeVoteFilename("merge-votes/round-1-x.txt")).toBeNull();
  });

  test("returns null for wrong extension", () => {
    expect(parseMergeVoteFilename("round-1-coder.md")).toBeNull();
  });

  test("rejects zero-padded rounds", () => {
    expect(parseMergeVoteFilename("round-01-coder.txt")).toBeNull();
  });

  test("rejects agent names with dots or spaces", () => {
    expect(parseMergeVoteFilename("round-1-bad.agent.txt")).toBeNull();
    expect(parseMergeVoteFilename("round-1-bad agent.txt")).toBeNull();
  });

  test("round-trips with mergeVoteFilename", () => {
    expect(parseMergeVoteFilename(mergeVoteFilename(5, "alice"))).toEqual({
      round: 5,
      agentName: "alice",
    });
  });
});
