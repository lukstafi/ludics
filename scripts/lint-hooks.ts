#!/usr/bin/env bun
// lint-hooks.ts
//
// Shellcheck wrapper over templates/hooks/*.sh, replacing the equivalent
// section of the deleted bash test script (gh-ludics-407). Bun-native to
// avoid bash 3.2 / 4+ portability traps.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const hooksDir = join(repoRoot, "templates", "hooks");

function shellcheckPath(): string | null {
  const probe = Bun.spawnSync({ cmd: ["sh", "-c", "command -v shellcheck"] });
  if (probe.exitCode !== 0) return null;
  const path = probe.stdout.toString().trim();
  return path || null;
}

function listHookScripts(): string[] {
  if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) return [];
  return readdirSync(hooksDir)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => join(hooksDir, name))
    .sort();
}

function main(): number {
  const sc = shellcheckPath();
  if (sc === null) {
    console.log("lint:hooks: shellcheck not installed — skipped");
    return 0;
  }

  const scripts = listHookScripts();
  if (scripts.length === 0) {
    console.log("lint:hooks: no templates/hooks/*.sh found — skipped");
    return 0;
  }

  let fail = 0;
  for (const script of scripts) {
    const label = script.replace(repoRoot + "/", "");
    const r = Bun.spawnSync({
      cmd: [sc, "-P", repoRoot, "-x", "-S", "warning", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode === 0) {
      console.log(`  PASS  ${label}`);
    } else {
      console.error(`  FAIL  ${label}`);
      const out = r.stdout.toString().trim();
      const err = r.stderr.toString().trim();
      if (out) console.error(out);
      if (err) console.error(err);
      fail++;
    }
  }

  if (fail > 0) {
    console.error(`lint:hooks: ${fail} script(s) failed`);
    return 1;
  }
  console.log(`lint:hooks: ${scripts.length} passed`);
  return 0;
}

process.exit(main());
