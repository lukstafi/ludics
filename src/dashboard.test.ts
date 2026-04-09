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

  test("explicit Liveness field 'interrupted' in slot data returns 'interrupted'", async () => {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    const { emptySlotData } = await import("./slots/json.ts");
    const slotData = { ...emptySlotData(1), process: "test", liveness: "interrupted" };
    expect(computeSlotLiveness({ slotNum: 1, mode: null, slotData })).toBe("interrupted");
  });

  test("explicit Liveness field null in slot data falls through to PID check", async () => {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    const { emptySlotData } = await import("./slots/json.ts");
    const slotData = { ...emptySlotData(1), process: "test", liveness: null };
    expect(computeSlotLiveness({ slotNum: 1, mode: null, slotData })).toBe(null);
  });
});

describe("generateHealthData", () => {
  async function getHealthData() {
    const { generateHealthData, _resetDoctorCache } = await import("./dashboard.ts");
    _resetDoctorCache();
    return generateHealthData();
  }

  test("missing health report returns exists=false", async () => {
    const data = await getHealthData() as any;
    expect(data.healthReport.exists).toBe(false);
    expect(data.healthReport.content).toBe("");
    expect(data.healthReport.date).toBeNull();
  });

  test("present health report returns exists=true with content and date", async () => {
    const magDir = join(harnessDir(), "mag");
    mkdirSync(magDir, { recursive: true });
    const content = "# Health Check - 2026-04-09 12:00\n\nAll systems operational.\n";
    writeFileSync(join(magDir, "health-report.md"), content);

    const data = await getHealthData() as any;
    expect(data.healthReport.exists).toBe(true);
    expect(data.healthReport.content).toBe(content);
    expect(data.healthReport.date).toBe("2026-04-09 12:00");
  });

  test("health report without date header returns date=null", async () => {
    const magDir = join(harnessDir(), "mag");
    mkdirSync(magDir, { recursive: true });
    const content = "## Some other header\n\nNo date here.\n";
    writeFileSync(join(magDir, "health-report.md"), content);

    const data = await getHealthData() as any;
    expect(data.healthReport.exists).toBe(true);
    expect(data.healthReport.date).toBeNull();
    expect(data.healthReport.content).toBe(content);
  });

  test("doctor output has output and timestamp fields", async () => {
    const data = await getHealthData() as any;
    expect(typeof data.doctor.output).toBe("string");
    expect(typeof data.doctor.timestamp).toBe("string");
    // timestamp should be a valid ISO date
    expect(new Date(data.doctor.timestamp).toISOString()).toBe(data.doctor.timestamp);
  });

  test("doctor cache prevents re-spawn within TTL", async () => {
    const { generateHealthData, _resetDoctorCache } = await import("./dashboard.ts");
    _resetDoctorCache();

    const first = generateHealthData() as any;
    const second = generateHealthData() as any;

    // Same cached result
    expect(second.doctor.output).toBe(first.doctor.output);
    expect(second.doctor.timestamp).toBe(first.doctor.timestamp);
  });
});

// Note: /api/slot-resume follows the exact same pattern as /api/slot-start
// (validate slot 1-6, spawnSync `ludics slot N resume`, return OK/error).
// slotResume() itself is already tested in src/slots/index.test.ts.
