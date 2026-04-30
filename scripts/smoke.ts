#!/usr/bin/env bun
// smoke.ts
//
// Compiled-binary smoke checks, replacing the equivalent section of the
// deleted tests/test.sh (gh-ludics-407). Bun-native to avoid bash pipefail /
// grep -q false-negatives. Builds the binary first, then runs three CLI
// smoke checks against bin/ludics: help, doctor, and an unknown command.
//
// Note: `doctor` is intentionally warning-capable — the bash script accepted
// either exit code as long as "Health Check" appeared in output, and we
// preserve that semantics here.

import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const binPath = join(repoRoot, "bin", "ludics");

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function runBuild(): boolean {
  console.log("smoke: bun run build");
  const r = Bun.spawnSync({
    cmd: ["bun", "run", "build"],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    console.error(`smoke: build failed with exit ${r.exitCode}`);
    return false;
  }
  if (!existsSync(binPath)) {
    console.error(`smoke: build reported success but ${binPath} is missing`);
    return false;
  }
  return true;
}

function runBin(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [binPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function checkHelp(): CheckResult {
  const r = runBin(["help"]);
  if (r.exitCode !== 0) {
    return { label: "ludics help", ok: false, detail: `expected exit 0, got ${r.exitCode}` };
  }
  if (!r.stdout.includes("Usage:")) {
    return { label: "ludics help", ok: false, detail: "expected 'Usage:' in stdout" };
  }
  return { label: "ludics help", ok: true };
}

function checkDoctor(): CheckResult {
  // Doctor is intentionally warning-capable: accept any exit code as long as
  // "Health Check" appears somewhere in the output (matches tests/test.sh:80-86).
  const r = runBin(["doctor"]);
  const combined = r.stdout + r.stderr;
  if (!combined.includes("Health Check")) {
    return { label: "ludics doctor", ok: false, detail: "expected 'Health Check' in output" };
  }
  return { label: "ludics doctor", ok: true };
}

function checkUnknown(): CheckResult {
  const r = runBin(["this-does-not-exist"]);
  if (r.exitCode === 0) {
    return { label: "ludics <unknown>", ok: false, detail: "expected non-zero exit" };
  }
  return { label: "ludics <unknown>", ok: true };
}

function main(): number {
  if (!runBuild()) return 1;
  console.log("");

  const results: CheckResult[] = [checkHelp(), checkDoctor(), checkUnknown()];
  let fail = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  PASS  ${r.label}`);
    } else {
      console.error(`  FAIL  ${r.label}: ${r.detail}`);
      fail++;
    }
  }

  if (fail > 0) {
    console.error(`smoke: ${fail} check(s) failed`);
    return 1;
  }
  console.log(`smoke: ${results.length} passed`);
  return 0;
}

process.exit(main());
