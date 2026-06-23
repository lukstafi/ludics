import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// gh-ludics-590: the hook must resolve jq to an absolute path (mirroring ludics_bin),
// adding $HOME/.local/bin to PATH, and FAIL LOUD when jq is genuinely unresolvable
// rather than swallowing the 127 → empty cwd → confusing downstream `usage:` error.
describe("ludics-on-stop.sh jq resolution (gh-ludics-590)", () => {
  let TMP = "";
  const hookPath = join(import.meta.dir, "..", "templates", "hooks", "ludics-on-stop.sh");
  // Resolve the real jq dynamically rather than hard-coding /usr/bin/jq — on Homebrew
  // macOS jq lives in /opt/homebrew/bin (or /usr/local/bin), so a hard-coded
  // /usr/bin/jq symlink would dangle and make the positive test platform-dependent.
  const realJq = Bun.which("jq");
  // Coreutils for the sandbox PATH, resolved dynamically (POSIX paths differ across
  // distros); fall back to the conventional location when `which` can't find them.
  const realCat = Bun.which("cat") ?? "/bin/cat";
  const realDirname = Bun.which("dirname") ?? "/usr/bin/dirname";

  // The hook unconditionally prepends /opt/homebrew/bin and we cannot strip jq from
  // those dirs; if jq is reachable there, the jq-absent assertion below is not
  // exercisable. (Env-dependent-CLI rule — see worker-conventions baseline guidance.)
  const jqReachableViaHardcodedPrepend =
    existsSync("/opt/homebrew/bin/jq") || existsSync("/usr/local/bin/jq");

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-onstop-jq-"));
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // A PATH dir holding ONLY the coreutils the hook needs (cat for stdin, dirname for
  // the marker walk-up) — deliberately WITHOUT jq, so the only jq the hook can find is
  // one we place under the sandbox HOME. Proves PATH/fallback resolution, not a leak
  // from the real system PATH.
  function makeCoreutilsOnlyBin(): string {
    const bin = join(TMP, "sysbin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(realCat, join(bin, "cat"));
    symlinkSync(realDirname, join(bin, "dirname"));
    return bin;
  }

  function stubLudics(home: string, argvOut: string): void {
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, "ludics");
    writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argvOut}"\n`);
    chmodSync(stub, 0o755);
  }

  test.skipIf(!realJq)("resolves jq present only at $HOME/.local/bin/jq (not on PATH) and execs orch on-stop", () => {
    const home = join(TMP, "home");
    const argvOut = join(TMP, "argv.txt");
    stubLudics(home, argvOut);
    // jq lives ONLY under the sandbox HOME's local bin — not on the sandbox PATH.
    // The hook's `$HOME/.local/bin` prepend + `command -v jq` resolves it (absolute).
    // Symlink (not copy): copying a macOS system binary breaks its dyld/codesign load.
    symlinkSync(realJq!, join(home, ".local", "bin", "jq"));

    const psDir = join(TMP, "peer-sync");
    mkdirSync(psDir, { recursive: true });
    writeFileSync(join(psDir, "phase"), "work\n");
    const workDir = join(TMP, "worktree");
    mkdirSync(workDir, { recursive: true });

    const proc = Bun.spawnSync(["/bin/bash", hookPath], {
      cwd: workDir,
      env: { HOME: home, PATH: makeCoreutilsOnlyBin(), LUDICS_PEER_SYNC_DIR: psDir },
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", cwd: workDir })),
    });

    // Invariant: with jq findable only via $HOME/.local/bin, the hook still parses the
    // cwd and execs `orch on-stop <cwd> <peer-sync> Stop`. Mutation — reverting the
    // PATH prepend + fallback loop (back to bare `jq`) leaves jq unresolvable here →
    // exit 1 and no exec, flipping every assertion below.
    expect(proc.exitCode).toBe(0);
    const argv = readFileSync(argvOut, "utf-8").split("\n");
    if (argv.length && argv[argv.length - 1] === "") argv.pop();
    expect(argv).toEqual(["orch", "on-stop", workDir, psDir, "Stop"]);
  });

  test.skipIf(jqReachableViaHardcodedPrepend)(
    "jq unresolvable → exits non-zero, stderr names jq, ludics never invoked",
    () => {
      const home = join(TMP, "home"); // no $HOME/.local/bin/jq created
      const argvOut = join(TMP, "argv.txt");
      stubLudics(home, argvOut);

      const psDir = join(TMP, "peer-sync");
      mkdirSync(psDir, { recursive: true });
      writeFileSync(join(psDir, "phase"), "work\n");
      const workDir = join(TMP, "worktree");
      mkdirSync(workDir, { recursive: true });

      const proc = Bun.spawnSync(["/bin/bash", hookPath], {
        cwd: workDir,
        env: { HOME: home, PATH: makeCoreutilsOnlyBin(), LUDICS_PEER_SYNC_DIR: psDir },
        stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", cwd: workDir })),
      });

      // Invariant: an unresolvable jq fails LOUD (exit≠0, stderr names jq) and the hook
      // never hands a positional to `ludics orch on-stop`. Mutation — dropping the
      // `[[ -z "$jq_bin" ]] && exit 1` guard lets the bare-jq path produce an empty cwd
      // and (after the gh-589 $PWD default) silently exec ludics, so argvOut would
      // exist and exitCode would be 0.
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("jq");
      expect(existsSync(argvOut)).toBe(false);
    },
  );
});
