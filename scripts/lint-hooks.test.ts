import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHookScripts } from "./lint-hooks.ts";

describe("listHookScripts", () => {
  let TMP = "";

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-lint-hooks-"));
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test("returns empty list when root directory is missing", () => {
    expect(listHookScripts(join(TMP, "missing"))).toEqual([]);
  });

  test("returns empty list when root has no .sh files", () => {
    writeFileSync(join(TMP, "README.md"), "");
    expect(listHookScripts(TMP)).toEqual([]);
  });

  test("finds .sh files in nested subdirectories (regression: codex P2)", () => {
    // Invariant: walker mirrors `find <root> -name '*.sh'` semantics. Reverting
    // to a flat `readdirSync` would skip the nested file and flip this assertion.
    // Harness condition: a single .sh file lives only inside a nested dir; the
    // root contains no .sh files of its own.
    const sub = join(TMP, "pre-commit");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "foo.sh"), "#!/usr/bin/env bash\n");
    expect(listHookScripts(TMP)).toEqual([join(sub, "foo.sh")]);
  });

  test("finds top-level and nested .sh files together; result is sorted", () => {
    const sub = join(TMP, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(TMP, "b.sh"), "");
    writeFileSync(join(TMP, "a.sh"), "");
    writeFileSync(join(sub, "c.sh"), "");
    const result = listHookScripts(TMP);
    expect(result).toEqual([
      join(TMP, "a.sh"),
      join(TMP, "b.sh"),
      join(sub, "c.sh"),
    ]);
  });

  test("ignores non-.sh files at all depths", () => {
    const sub = join(TMP, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(TMP, "ok.sh"), "");
    writeFileSync(join(TMP, "skip.txt"), "");
    writeFileSync(join(sub, "nested-ok.sh"), "");
    writeFileSync(join(sub, "nested-skip.md"), "");
    expect(listHookScripts(TMP)).toEqual([
      join(TMP, "ok.sh"),
      join(sub, "nested-ok.sh"),
    ]);
  });
});

// gh-ludics-589 (Part C / AC6): ludics-on-stop.sh must never exec `orch on-stop`
// with a blank first positional (which produced the `usage: ...` error that
// blocked phase advancement). When the stop-event cwd is blank, the hook defaults
// it to $PWD before the exec. End-to-end bash smoke test.
describe("ludics-on-stop.sh blank-cwd default (gh-ludics-589)", () => {
  let TMP = "";
  const hookPath = join(import.meta.dir, "..", "templates", "hooks", "ludics-on-stop.sh");

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-onstop-hook-"));
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test("blank stop-event cwd is replaced by $PWD before exec orch on-stop", () => {
    // Sandbox HOME + PATH so the hook resolves OUR stub ludics (not the real
    // ~/.local/bin one) and finds jq via /usr/bin. The stub records its argv.
    const home = join(TMP, "home");
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const argvOut = join(TMP, "argv.txt");
    const stub = join(binDir, "ludics");
    writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argvOut}"\n`);
    chmodSync(stub, 0o755);

    // A live orchestration peer-sync dir (env-var routing requires a phase file).
    const psDir = join(TMP, "peer-sync");
    mkdirSync(psDir, { recursive: true });
    writeFileSync(join(psDir, "phase"), "work\n");

    // The agent's real working directory — what a blank cwd must default to.
    const workDir = join(TMP, "worktree");
    mkdirSync(workDir, { recursive: true });

    const proc = Bun.spawnSync(["/bin/bash", hookPath], {
      cwd: workDir,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        LUDICS_PEER_SYNC_DIR: psDir,
      },
      // Claude Code Stop-hook JSON with an EMPTY cwd — the gh-ludics-589 trigger.
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", cwd: "" })),
    });

    expect(proc.exitCode).toBe(0);
    // Split WITHOUT filtering empties — the empty cwd positional must remain
    // observable. Drop only the single trailing newline from `printf '%s\n'`.
    const argv = readFileSync(argvOut, "utf-8").split("\n");
    if (argv.length && argv[argv.length - 1] === "") argv.pop();
    // Invariant: the exec is exactly `orch on-stop <cwd> <peer-sync> <event>` with
    // a NON-EMPTY <cwd>. Mutation: removing the `cwd="${cwd:-$PWD}"` default leaves
    // argv[2] === "" (jq's `.cwd // ""`), flipping argv[2]/argv[3]/argv[4] — caught
    // by both the non-empty check and the exact peer-sync/event slot assertions.
    expect(argv).toHaveLength(5);
    expect(argv[0]).toBe("orch");
    expect(argv[1]).toBe("on-stop");
    expect(argv[2]).not.toBe(""); // the cwd positional — defaulted to $PWD
    expect(argv[3]).toBe(psDir);  // peer-sync dir stays in its own slot
    expect(argv[4]).toBe("Stop");
  });
});
