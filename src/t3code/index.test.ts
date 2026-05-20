import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runT3Code } from "./index.ts";
import * as serverMod from "./server.ts";

// gh-ludics-539: `ludics t3code integration-status` is a cheap flag probe for
// the ludics-health-check skill — it prints enabled/paused and never touches
// the (deliberately-down) t3code server.

let TMP = "";
const ORIGINAL = {
  HOME: process.env.HOME,
  CONFIG: process.env.LUDICS_CONFIG,
  HARNESS: process.env.LUDICS_HARNESS_DIR,
};

function writeConfig(t3codeEnabled: boolean): void {
  const cfgPath = join(TMP, "config.yaml");
  const mag = t3codeEnabled ? "mag:\n  t3code_integration_enabled: true\n" : "";
  writeFileSync(cfgPath, `state_repo: test/state\nstate_path: harness\n${mag}`);
  process.env.LUDICS_CONFIG = cfgPath;
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-t3code-cli-"));
  process.env.HOME = TMP;
  process.env.LUDICS_HARNESS_DIR = TMP;
});

afterEach(() => {
  if (ORIGINAL.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL.HOME;
  if (ORIGINAL.CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL.CONFIG;
  if (ORIGINAL.HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL.HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("t3code integration-status subcommand (gh-ludics-539, AC 9)", () => {
  test("prints 'paused' when the flag is off, without probing the server", async () => {
    writeConfig(false);
    const statusSpy = spyOn(serverMod, "serverStatus");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runT3Code(["integration-status"]);
      const out = logSpy.mock.calls.map((c) => String(c[0]));
      // Invariant: the subcommand reports the flag state and never calls
      // serverStatus — the skill can probe it even while the server is down.
      expect(out).toContain("paused");
      expect(statusSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      statusSpy.mockRestore();
    }
  });

  test("prints 'enabled' when the flag is on (positive control)", async () => {
    writeConfig(true);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runT3Code(["integration-status"]);
      const out = logSpy.mock.calls.map((c) => String(c[0]));
      expect(out).toContain("enabled");
    } finally {
      logSpy.mockRestore();
    }
  });
});
