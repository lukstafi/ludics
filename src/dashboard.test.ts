import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
  return configPath;
}

function harnessDir(): string {
  return join(TMP, "harness");
}

function writeT3codeSlotState(slot: number, state: object): void {
  const dir = join(harnessDir(), "t3code");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `slot-${slot}.json`), JSON.stringify(state));
}

function writeTmuxSlotState(slot: number, state: object): void {
  const dir = join(harnessDir(), "orchestration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `tmux-slot-${slot}.json`), JSON.stringify(state));
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-dashboard-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(harnessDir(), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_CONFIG === undefined) {
    delete process.env.LUDICS_CONFIG;
  } else {
    process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  }
  if (ORIGINAL_HARNESS_DIR === undefined) {
    delete process.env.LUDICS_HARNESS_DIR;
  } else {
    process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("computeSlotLiveness", () => {
  // Dynamic import to pick up env changes
  async function getLiveness(slot: number, mode: string | null) {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    return computeSlotLiveness({ slotNum: slot, mode });
  }

  test("t3code slot with alive PID returns 'alive'", async () => {
    writeT3codeSlotState(1, {
      slot: 1,
      threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair", pid: process.pid },
    });
    expect(await getLiveness(1, "t3code")).toBe("alive");
  });

  test("t3code slot with dead PID returns 'interrupted'", async () => {
    writeT3codeSlotState(1, {
      slot: 1,
      threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair", pid: 99999999 },
    });
    expect(await getLiveness(1, "t3code")).toBe("interrupted");
  });

  test("tmux slot with alive PID returns 'alive'", async () => {
    writeTmuxSlotState(1, {
      slot: 1,
      ttydPids: {},
      orchestration: { stateFile: "orch.json", mode: "duo", pid: process.pid },
    });
    expect(await getLiveness(1, "tmux")).toBe("alive");
  });

  test("tmux slot with dead PID returns 'interrupted'", async () => {
    writeTmuxSlotState(1, {
      slot: 1,
      ttydPids: {},
      orchestration: { stateFile: "orch.json", mode: "duo", pid: 99999999 },
    });
    expect(await getLiveness(1, "tmux")).toBe("interrupted");
  });

  test("no slot state file returns null", async () => {
    expect(await getLiveness(1, "t3code")).toBe(null);
  });

  test("orchestration present but no pid returns null", async () => {
    writeT3codeSlotState(1, {
      slot: 1,
      threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair" },
    });
    expect(await getLiveness(1, "t3code")).toBe(null);
  });

  test("null mode returns null", async () => {
    expect(await getLiveness(1, null)).toBe(null);
  });

  test("unknown mode returns null", async () => {
    expect(await getLiveness(1, "manual")).toBe(null);
  });

  test("explicit Liveness field 'interrupted' in slot block returns 'interrupted'", async () => {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    const block = `## Slot 1\n\n**Process:** test\n**Liveness:** interrupted\n`;
    expect(computeSlotLiveness({ slotNum: 1, mode: null, slotBlock: block })).toBe("interrupted");
  });

  test("explicit Liveness field 'null' in slot block falls through to PID check", async () => {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    const block = `## Slot 1\n\n**Process:** test\n**Liveness:** null\n`;
    expect(computeSlotLiveness({ slotNum: 1, mode: null, slotBlock: block })).toBe(null);
  });
});

// Note: /api/slot-resume follows the exact same pattern as /api/slot-start
// (validate slot 1-6, spawnSync `ludics slot N resume`, return OK/error).
// slotResume() itself is already tested in src/slots/index.test.ts.
