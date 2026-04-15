import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(homeDir: string, magSection?: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  let yaml = `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`;
  if (magSection) yaml += magSection;
  writeFileSync(configPath, yaml);
  return configPath;
}

function harnessDir(): string {
  return join(TMP, "harness");
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-doctor-stall-"));
  process.env.HOME = TMP;
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  // Create required directories/files for doctor to not crash
  mkdirSync(join(TMP, ".claude"), { recursive: true });
  mkdirSync(join(TMP, ".local", "bin"), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("magDoctor stall config validation", () => {
  test("shows defaults when stall config not set", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP);
    const { magDoctor } = await import("./mag.ts");

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    // Prevent process.exit from actually exiting
    const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      magDoctor();
    } catch { /* ignore */ }

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("Stall detection config:");
    expect(output).toContain("stall_threshold_seconds: not set (default 120s)");
    expect(output).toContain("stall_nudge_cooldown_seconds: not set (default 120s)");
  });

  test("shows configured valid values", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, `mag:
  stall_threshold_seconds: 60
  stall_nudge_cooldown_seconds: 90
`);
    const { magDoctor } = await import("./mag.ts");

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      magDoctor();
    } catch { /* ignore */ }

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("stall_threshold_seconds: 60s");
    expect(output).toContain("stall_nudge_cooldown_seconds: 90s");
  });

  test("warns on invalid (non-positive) stall values", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, `mag:
  stall_threshold_seconds: -5
  stall_nudge_cooldown_seconds: banana
`);
    const { magDoctor } = await import("./mag.ts");

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      magDoctor();
    } catch { /* ignore */ }

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("stall_threshold_seconds: -5 — WARNING: not a positive number");
    expect(output).toContain("stall_nudge_cooldown_seconds:");
    expect(output).toContain("WARNING");
  });

  test("warns on unusually low values", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, `mag:
  stall_threshold_seconds: 10
`);
    const { magDoctor } = await import("./mag.ts");

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      magDoctor();
    } catch { /* ignore */ }

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("stall_threshold_seconds: 10s — WARNING: unusually low (< 30s)");
  });

  test("warns on unusually high values", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, `mag:
  stall_threshold_seconds: 1000
`);
    const { magDoctor } = await import("./mag.ts");

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      magDoctor();
    } catch { /* ignore */ }

    logSpy.mockRestore();
    exitSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("stall_threshold_seconds: 1000s — WARNING: unusually high (> 600s)");
  });
});
