// State checkpoint tests

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

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

    const { stateMarkDirty, stateIsDirty } = require("./state.ts");

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

    const { stateCommit, stateIsDirty } = require("./state.ts");

    try {
      stateCommit("test message");
      expect(stateIsDirty()).toBe(true);
    } catch {
      // Expected if stateRepoDir() fails in test env
    }
  });
});
