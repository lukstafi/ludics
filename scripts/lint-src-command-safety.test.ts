import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  SRC_COMMAND_SAFETY_ALLOWLIST,
  scanFile,
  runCli,
} from "./lint-src-command-safety.ts";

const repoRoot = join(import.meta.dir, "..");
const scriptPath = join(import.meta.dir, "lint-src-command-safety.ts");

// ---------------------------------------------------------------------------
// SRC_COMMAND_SAFETY_ALLOWLIST — allowlist shape
// ---------------------------------------------------------------------------

describe("SRC_COMMAND_SAFETY_ALLOWLIST", () => {
  test("contains exactly src/remote.ts as the sole vetted ssh chokepoint", () => {
    expect(SRC_COMMAND_SAFETY_ALLOWLIST).toEqual(new Set(["src/remote.ts"]));
    expect(SRC_COMMAND_SAFETY_ALLOWLIST.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanFile — path rule
// Positive cases: ssh/scp/rsync argv literals in non-allowlisted src/ files
// ---------------------------------------------------------------------------

describe("scanFile — path rule", () => {
  test("ssh argv literal in non-allowlisted path is flagged", () => {
    const source =
      'const r = safeSyncOutput(["ssh", "-o", "BatchMode=yes", host, script], {});';
    const issues = scanFile(source, "src/danger.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "src/danger.ts",
      line: 1,
      command: "ssh",
      kind: "path",
    });
  });

  test("scp argv literal in non-allowlisted path is flagged", () => {
    const source =
      'safeSyncOutput(["scp", "-r", "file.txt", "remote:/path/"], {});';
    const issues = scanFile(source, "src/uploader.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "scp", kind: "path" });
  });

  test("rsync argv literal in non-allowlisted path is flagged", () => {
    const source =
      'safeSyncOutput(["rsync", "-av", "src/", "remote:/dst/"], {});';
    const issues = scanFile(source, "src/syncer.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "rsync", kind: "path" });
  });

  test("reports correct 1-based line number", () => {
    const source =
      "// header comment\nconst r = safeSyncOutput([\"scp\", \"file\", \"remote:path\"], {});\n";
    const issues = scanFile(source, "src/foo.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(2);
  });

  test("flags multiple argv literals in the same file", () => {
    const source = [
      'safeSyncOutput(["ssh", host, cmd], {});',
      'safeSyncOutput(["scp", src, dst], {});',
    ].join("\n");
    const issues = scanFile(source, "src/multi.ts");
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.command).sort()).toEqual(["scp", "ssh"]);
  });

  test("single-quoted 'ssh' argv literal is flagged (not only double-quoted)", () => {
    // Regression: the original regex only matched "ssh" (double-quoted).
    // A single-quoted ['ssh', host, script] must also be caught.
    const source = "safeSyncOutput(['ssh', host, script], {});";
    const issues = scanFile(source, "src/danger.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "ssh", kind: "path" });
  });

  test("single-quoted 'scp' argv literal is flagged", () => {
    const source = "safeSyncOutput(['scp', 'file.txt', 'remote:/path/'], {});";
    const issues = scanFile(source, "src/upload.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "scp", kind: "path" });
  });

  test("block comment between [ and \"ssh\" does not bypass detection", () => {
    // Regression: `[/* vetted? */ "ssh", host, script]` must be flagged.
    // The original regex's `\\s*` did not match comment text, so the pattern
    // silently passed. The mask-aware firstStringArg skips masked comment
    // bytes and still finds "ssh" as the first real source element.
    const source = 'safeSyncOutput([/* vetted? */ "ssh", host, script], {});';
    const issues = scanFile(source, "src/danger.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "ssh", kind: "path" });
  });

  test("line comment on previous line does not affect detection", () => {
    // The comment is on a line by itself before the array — should not mask the [.
    const source = "// see also safe patterns\nsafeSyncOutput([\"ssh\", host, script], {});";
    const issues = scanFile(source, "src/danger.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "ssh", kind: "path" });
  });
});

// ---------------------------------------------------------------------------
// scanFile — interpolation rule
// Higher-severity injection shape: template literal with ${…} in the array
// ---------------------------------------------------------------------------

describe("scanFile — interpolation rule", () => {
  test("ssh array with template-literal remote-script is flagged as interpolation", () => {
    // Harness: source contains ["ssh", host, `cd ${cwd} || exit 255; ${cmd}`]
    // The template literal carries ${cwd} and ${cmd} substitutions — the
    // unquoted-shell-interpolation injection shape.
    const source =
      "const r = safeSyncOutput([\"ssh\", host, `cd ${cwd} || exit 255; ${cmd}`], {});";
    const issues = scanFile(source, "src/danger.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "ssh", kind: "interpolation" });
  });

  test("scp array with interpolated destination is flagged as interpolation", () => {
    const source = "safeSyncOutput([\"scp\", \"file\", `${host}:/remote/path`], {});";
    const issues = scanFile(source, "src/sync.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "scp", kind: "interpolation" });
  });

  test("rsync array with interpolated destination is flagged as interpolation", () => {
    const source = "safeSyncOutput([\"rsync\", \"-av\", `${srcDir}/`, `${host}:/dst/`], {});";
    const issues = scanFile(source, "src/sync.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ command: "rsync", kind: "interpolation" });
  });

  test("ssh array with plain string arguments (no template) is flagged as path, not interpolation", () => {
    // buildRemoteScript() call — not a template literal inline in the array.
    const source =
      'const r = safeSyncOutput(["ssh", "-o", "BatchMode=yes", host, buildRemoteScript(cwd, cmd)], {});';
    const issues = scanFile(source, "src/danger.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("path");
  });
});

// ---------------------------------------------------------------------------
// scanFile — negative controls
// ---------------------------------------------------------------------------

describe("scanFile — negative controls", () => {
  test("array with no ssh/scp/rsync is clean", () => {
    const source = 'const r = safeSyncOutput(["ls", "-la", "/tmp"], {});';
    expect(scanFile(source, "src/local.ts")).toHaveLength(0);
  });

  test('"ssh" token inside a line comment is not flagged', () => {
    const source = '// ["ssh", "-o", "BatchMode=yes", host, script]\nconst x = 1;';
    expect(scanFile(source, "src/foo.ts")).toHaveLength(0);
  });

  test('"ssh" token inside a block comment is not flagged', () => {
    const source = '/* Use ["ssh", host, script] for remote exec */ const x = 1;';
    expect(scanFile(source, "src/foo.ts")).toHaveLength(0);
  });

  test('"ssh" token inside a string literal is not flagged', () => {
    const source = "const doc = 'call [\"ssh\", host, script] directly';\nconst x = 1;";
    expect(scanFile(source, "src/foo.ts")).toHaveLength(0);
  });

  test('"ssh" token inside a template literal body is not flagged', () => {
    const source = "const doc = `Pass [\"ssh\", host, script] to spawn`;\nconst x = 1;";
    expect(scanFile(source, "src/foo.ts")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanFile — allowlist exemption
// ---------------------------------------------------------------------------

describe("scanFile — allowlist exemption", () => {
  test("src/remote.ts returns no issues regardless of content (path allowlist)", () => {
    // Harness: inject the exact injection shape that would be flagged in any
    // other file. The allowlist short-circuit must fire before any scanning.
    const source =
      "safeSyncOutput([\"ssh\", host, `cd ${cwd} || exit 255; ${cmd}`], {});";
    const issues = scanFile(source, "src/remote.ts");
    expect(issues).toHaveLength(0);
  });

  test("src/remote.ts (real file) passes the allowlist check", () => {
    // Pre-assertion harness probe: read the actual src/remote.ts and confirm
    // it contains the ssh call so the exemption is non-vacuous (it would be
    // flagged in any other file).
    const remoteSource = readFileSync(join(repoRoot, "src/remote.ts"), "utf-8");
    expect(remoteSource).toContain('"ssh"'); // pre-condition: the call exists
    const issues = scanFile(remoteSource, "src/remote.ts");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// real-corpus — actual src/** tree is clean
// ---------------------------------------------------------------------------

describe("real corpus", () => {
  test("actual src/ tree is clean under the rule (src/remote.ts allowlisted)", () => {
    const errs: string[] = [];
    const result = runCli({
      writeErr: (m) => errs.push(m),
      writeOut: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(errs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLI entrypoint — binary spawn tests
// These test names begin "exits 0/1" so lint:test-spawn-coverage requires
// that the enclosing describe block contains a Bun.spawnSync call.
// ---------------------------------------------------------------------------

describe("CLI entrypoint", () => {
  test("exits 0 against the real src/ corpus", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("✅");
  });

  test("exits 1 on a directory with a planted ssh violation", () => {
    const tmpDir = mkdtempSync("/tmp/lint-src-command-safety-");
    try {
      writeFileSync(
        join(tmpDir, "rogue.ts"),
        'safeSyncOutput(["ssh", host, script], {});\n',
      );
      const proc = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath, tmpDir],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(1);
      const stderr = proc.stderr.toString();
      expect(stderr).toContain("❌");
      expect(stderr).toContain('"ssh"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
