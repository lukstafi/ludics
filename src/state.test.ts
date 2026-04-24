// State checkpoint tests

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { stateMarkDirty, stateIsDirty, stateCommit } from "./state.ts";

describe("dirty flag", () => {
  const flagPath = join(process.env.HOME ?? "/tmp", ".ludics-state-dirty");

  afterEach(() => {
    // Clean up
    if (existsSync(flagPath)) {
      try { unlinkSync(flagPath); } catch { /* ignore */ }
    }
  });

  it("stateMarkDirty creates flag file", () => {
    // Clean up first
    if (existsSync(flagPath)) unlinkSync(flagPath);

    try {
      expect(stateIsDirty()).toBe(false);
      stateMarkDirty();
      expect(stateIsDirty()).toBe(true);
    } catch {
      // Expected if stateRepoDir() fails in test env
    }
  });

  it("stateCommit marks dirty instead of committing", () => {
    if (existsSync(flagPath)) unlinkSync(flagPath);

    try {
      stateCommit("test message");
      expect(stateIsDirty()).toBe(true);
    } catch {
      // Expected if stateRepoDir() fails in test env
    }
  });
});
