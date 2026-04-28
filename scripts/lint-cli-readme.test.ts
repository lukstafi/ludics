import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractUsageBlock,
  extractUsageCommands,
  extractReadmeCommands,
  lintCliReadme,
} from "./lint-cli-readme.ts";

// ---------------------------------------------------------------------------
// extractUsageBlock — backtick-aware extractor
// ---------------------------------------------------------------------------

describe("extractUsageBlock", () => {
  test("captures full template literal even when body contains a semicolon", () => {
    // Reproduces the original bug: a `;` inside the template literal body
    // (here inside a parenthetical, mirroring `cluster.machines);` in the
    // real source) used to truncate the parsed block.
    const src = [
      "const USAGE = `",
      "  alpha — first command",
      "  beta — host is not in cluster.machines); in single-machine",
      "  gamma — third command",
      "`;",
      "",
      "function other() {}",
    ].join("\n");
    const block = extractUsageBlock(src);
    expect(block).toContain("alpha");
    expect(block).toContain("beta");
    // The critical assertion: content past the parenthetical `;` survives.
    expect(block).toContain("gamma");
  });

  test("returns empty string when USAGE constant is absent", () => {
    expect(extractUsageBlock("const FOO = `bar`;\n")).toBe("");
  });

  test("does not consume past the closing backtick", () => {
    const src = "const USAGE = `body`;\nconst AFTER = `should not appear`;\n";
    const block = extractUsageBlock(src);
    expect(block).toBe("body");
    expect(block).not.toContain("should not appear");
  });
});

// ---------------------------------------------------------------------------
// extractUsageCommands — top-level command extraction
// ---------------------------------------------------------------------------

describe("extractUsageCommands", () => {
  test("recognises every top-level command past a semicolon-bearing line", () => {
    // The 12 names from the original failure must all be extracted, plus a
    // couple of others, when an earlier line contains a `;` in its body.
    const src = [
      "const USAGE = `",
      "  slot <n> — host is not in cluster.machines); in single-machine",
      "  slots — list active slots",
      "  tasks ls — list tasks",
      "  flow ready — show ready tasks",
      "  orch status — orchestration status",
      "  notify outgoing — send notification",
      "  mag start — start mag",
      "  status — show status",
      "  briefing — produce briefing",
      "  init — initialize",
      "  stop — stop",
      "  triggers install — install triggers",
      "  doctor — diagnose",
      "  help — show help",
      "`;",
    ].join("\n");
    const cmds = extractUsageCommands(src);
    for (const name of [
      "slot",
      "slots",
      "tasks",
      "flow",
      "orch",
      "notify",
      "mag",
      "status",
      "briefing",
      "init",
      "stop",
      "triggers",
      "doctor",
      "help",
    ]) {
      expect(cmds.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// extractReadmeCommands — slice CLI Reference, then collect `ludics <cmd>`
// ---------------------------------------------------------------------------

describe("extractReadmeCommands", () => {
  test("collects commands inside the CLI Reference section only", () => {
    const md = [
      "## Intro",
      "",
      "ludics outside-section",
      "",
      "## CLI Reference",
      "",
      "ludics tasks ls",
      "ludics flow ready",
      "",
      "## Other",
      "",
      "ludics also-outside",
    ].join("\n");
    const cmds = extractReadmeCommands(md);
    expect(cmds.has("tasks")).toBe(true);
    expect(cmds.has("flow")).toBe(true);
    expect(cmds.has("outside-section")).toBe(false);
    expect(cmds.has("also-outside")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lintCliReadme — drift detection still works after the fix
// ---------------------------------------------------------------------------

describe("lintCliReadme", () => {
  test("reports a README command missing from USAGE as stale", () => {
    const indexSrc = "const USAGE = `\n  alpha — first\n`;\n";
    const readmeSrc = "## CLI Reference\n\nludics alpha\nludics ghost\n";
    const { stale, undocumented } = lintCliReadme(indexSrc, readmeSrc);
    expect(stale).toEqual(["ghost"]);
    expect(undocumented).toEqual([]);
  });

  test("reports nothing stale when README ⊆ USAGE", () => {
    const indexSrc = "const USAGE = `\n  alpha — first\n  beta — second\n`;\n";
    const readmeSrc = "## CLI Reference\n\nludics alpha\n";
    const { stale, undocumented } = lintCliReadme(indexSrc, readmeSrc);
    expect(stale).toEqual([]);
    expect(undocumented).toEqual(["beta"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against the real repo: the gate currently passes
// ---------------------------------------------------------------------------

describe("real repository", () => {
  const root = join(import.meta.dir, "..");

  test("USAGE includes the 12 commands previously falsely flagged as stale", () => {
    // Pre-assertion harness probe: confirm the world (real src/index.ts
    // contents) actually instantiates the AC's case — i.e. these 12 commands
    // really do appear in USAGE. If not, the test would pass vacuously.
    const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
    const cmds = extractUsageCommands(indexSrc);
    const previouslyFlagged = [
      "tasks",
      "flow",
      "orch",
      "notify",
      "mag",
      "status",
      "briefing",
      "init",
      "stop",
      "triggers",
      "doctor",
      "help",
    ];
    for (const name of previouslyFlagged) {
      expect(cmds.has(name)).toBe(true);
    }
  });

  test("lintCliReadme returns no stale entries against the real README + USAGE", () => {
    const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
    const readmeSrc = readFileSync(join(root, "README.md"), "utf-8");
    const { stale } = lintCliReadme(indexSrc, readmeSrc);
    expect(stale).toEqual([]);
  });
});
