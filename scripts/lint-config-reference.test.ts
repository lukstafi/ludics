import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLint } from "./lint-config-reference.ts";

function makeFixture(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-config-reference-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TS_INTERFACE = [
  "export interface LudicsFullConfig {",
  "  state_repo: string;",
  "  state_path: string;",
  "  staleThresholdSeconds: number;",
  "  slots?: { count?: number };",
  "}",
  "",
].join("\n");

const REFERENCE_YAML_SYNCED = [
  "state_repo: org/repo",
  "state_path: harness",
  "slots:",
  "  count: 6",
  "",
].join("\n");

const HARNESS_YAML_SUBSET = [
  "state_repo: x/y",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// runLint — pure helper exit-code paths against tmp fixtures
// ---------------------------------------------------------------------------

describe("runLint", () => {
  test("happy path: TS interface, reference YAML, and harness YAML in sync → exit 0", () => {
    const { root, cleanup } = makeFixture({
      "src/config.ts": TS_INTERFACE,
      "templates/config.reference.yaml": REFERENCE_YAML_SYNCED,
      "templates/harness/config.yaml": HARNESS_YAML_SUBSET,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.missingFromYaml).toEqual([]);
      expect(result.missingFromTs).toEqual([]);
      expect(result.harnessExtras).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("drift: YAML key absent from TS interface → exit 1 with missingFromTs", () => {
    const yamlWithExtra = [
      "state_repo: org/repo",
      "state_path: harness",
      "slots:",
      "  count: 6",
      "rogue_key: oops",
      "",
    ].join("\n");
    const { root, cleanup } = makeFixture({
      "src/config.ts": TS_INTERFACE,
      "templates/config.reference.yaml": yamlWithExtra,
      "templates/harness/config.yaml": HARNESS_YAML_SUBSET,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.missingFromTs).toContain("rogue_key");
    } finally {
      cleanup();
    }
  });

  test("drift: TS interface declares a field absent from YAML → exit 1 with missingFromYaml", () => {
    const tsWithExtra = [
      "export interface LudicsFullConfig {",
      "  state_repo: string;",
      "  state_path: string;",
      "  staleThresholdSeconds: number;",
      "  slots?: { count?: number };",
      "  new_ts_only_field?: string;",
      "}",
      "",
    ].join("\n");
    const { root, cleanup } = makeFixture({
      "src/config.ts": tsWithExtra,
      "templates/config.reference.yaml": REFERENCE_YAML_SYNCED,
      "templates/harness/config.yaml": HARNESS_YAML_SUBSET,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.missingFromYaml).toContain("new_ts_only_field");
    } finally {
      cleanup();
    }
  });

  test("drift: harness YAML cites key absent from reference → exit 1 with harnessExtras", () => {
    const harnessWithExtra = [
      "state_repo: x/y",
      "harness_only_key: oops",
      "",
    ].join("\n");
    const { root, cleanup } = makeFixture({
      "src/config.ts": TS_INTERFACE,
      "templates/config.reference.yaml": REFERENCE_YAML_SYNCED,
      "templates/harness/config.yaml": harnessWithExtra,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.harnessExtras).toContain("harness_only_key");
    } finally {
      cleanup();
    }
  });

  test("staleThresholdSeconds carve-out: TS-only env-var-derived field doesn't drift", () => {
    // The TS interface declares staleThresholdSeconds (computed from env var,
    // not config YAML). The reference YAML omits it. Must remain in sync.
    const { root, cleanup } = makeFixture({
      "src/config.ts": TS_INTERFACE,
      "templates/config.reference.yaml": REFERENCE_YAML_SYNCED,
      "templates/harness/config.yaml": HARNESS_YAML_SUBSET,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      // Specifically: staleThresholdSeconds must NOT be reported missing from YAML.
      expect(result.missingFromYaml).not.toContain("staleThresholdSeconds");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive the real script against tmp-fixture roots so the
// `import.meta.main` exit-code branches are observable.
// ---------------------------------------------------------------------------

/** Run the CLI with LUDICS_HARNESS_CONFIG_PATH cleared so the harness lookup
 *  uses the fixture's path, not whatever the parent shell happens to set. */
function spawnLint(root: string) {
  return spawnSync({
    cmd: ["bun", "run", join(import.meta.dir, "lint-config-reference.ts"), root],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LUDICS_HARNESS_CONFIG_PATH: "",
    },
  });
}

describe("CLI integration", () => {
  test("exits 0 against a tmp fixture in sync (drives import.meta.main)", () => {
    const { root, cleanup } = makeFixture({
      "src/config.ts": TS_INTERFACE,
      "templates/config.reference.yaml": REFERENCE_YAML_SYNCED,
      "templates/harness/config.yaml": HARNESS_YAML_SUBSET,
    });
    try {
      const result = spawnLint(root);
      if (result.exitCode !== 0) {
        console.error(result.stderr.toString());
        console.error(result.stdout.toString());
      }
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("exits non-zero against a tmp fixture with YAML/TS drift", () => {
    const yamlWithExtra = [
      "state_repo: org/repo",
      "state_path: harness",
      "slots:",
      "  count: 6",
      "rogue_key: oops",
      "",
    ].join("\n");
    const { root, cleanup } = makeFixture({
      "src/config.ts": TS_INTERFACE,
      "templates/config.reference.yaml": yamlWithExtra,
      "templates/harness/config.yaml": HARNESS_YAML_SUBSET,
    });
    try {
      const result = spawnLint(root);
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  test("exits 0 against the real repo (drives the live source)", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-config-reference.ts")],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error(result.stderr.toString());
      console.error(result.stdout.toString());
    }
    expect(result.exitCode).toBe(0);
  });
});
