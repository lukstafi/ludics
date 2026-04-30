import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
