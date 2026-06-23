# Lint `src/**` for unsafe ssh/remote-command construction

## Goal

`gh-ludics-578` introduced `src/remote.ts` — the **first SSH dependency in the
codebase's `src/` tree** — which composes a remote shell script by **unquoted
string interpolation** (`buildRemoteScript(cwd, cmd)` →
`` `cd ${cwd} || exit 255; ${cmd}` ``) and passes it as the last argv element of
an `ssh` invocation. That string is evaluated by the remote login shell, so it is
a genuine shell-injection surface. Today nothing lints it: `lint:template-safety`
only scans orchestration Markdown templates, never `src/`. The only guard is a
hand-written comment in `src/remote.ts`. Future unsafe ssh/remote-command
construction in `src/` would ship uncaught.

This task adds a sibling lint that scans `src/**` for unsafe ssh/remote-command
construction, with `src/remote.ts` as the single vetted, allowlisted chokepoint.

Relates to `gh-ludics-578` (the PR that introduced the gap, durable-learning #6).
No standalone GitHub issue.

## Acceptance Criteria

- [ ] A new lint script `scripts/lint-src-command-safety.ts` exists. It exports
      pure functions (scan logic separable from I/O) and has an
      `if (import.meta.main)` CLI block that calls `process.exit(0|1)`, matching
      the structure of the existing `scripts/lint-*.ts` family.
- [ ] **Path rule:** the lint flags any `src/**` file (excluding the allowlist)
      whose real (non-comment, non-string-literal) source contains an `ssh`,
      `scp`, or `rsync` argv-array literal — i.e. an array whose first element is
      the string `"ssh"` / `"scp"` / `"rsync"`. The single vetted file
      `src/remote.ts` is exempt via a path allowlist.
- [ ] **Interpolation-shape rule:** the lint flags an ssh/scp/rsync argv literal
      in `src/**` (allowlist included for this rule, OR scoped so the genuine
      injection shape is caught even at allowlisted sites — see Approach) whose
      remote-script argument is a **template literal containing a `${…}`
      substitution** — the unquoted-shell-built-by-interpolation injection shape.
      The proposal author/coder decides whether `remote.ts`'s own vetted
      interpolation is exempted by the path allowlist or kept visible; the
      load-bearing requirement is that a *new* interpolated ssh script elsewhere
      in `src/**` is flagged.
- [ ] The scan reuses the masked-source state machine `computeCodeMask` exported
      from `scripts/lint-test-spawn-coverage.ts` (do not reimplement) so token
      matches do not fire inside comments or string literals.
- [ ] The exemption is a **path allowlist**:
      `SRC_COMMAND_SAFETY_ALLOWLIST = new Set(["src/remote.ts"])` (or equivalent
      named constant), with a comment recording why `remote.ts` is the single
      vetted ssh chokepoint. Not an inline pragma.
- [ ] The lint passes on the current `src/**` tree (real-corpus assertion): with
      `src/remote.ts` allowlisted, `bun run lint:src-command-safety` exits 0
      against the repository as it stands.
- [ ] A co-located `scripts/lint-src-command-safety.test.ts` exists covering, at
      minimum:
      - positive case — a synthetic source with an interpolated ssh remote script
        is flagged;
      - positive case — a bare `ssh`/`scp`/`rsync` argv literal in a non-allowlisted
        path is flagged;
      - negative control — an argv array with no ssh/scp/rsync and no interpolated
        remote script is clean;
      - exemption — the `src/remote.ts` path (or a fixture standing in for it) is
        clean under the allowlist;
      - mask correctness — an `"ssh"` token inside a comment or string literal does
        not trigger a flag;
      - real-corpus — the actual `src/**` tree is clean under the rule.
- [ ] If the test file names a CLI-contract test (`test("exits 0 …")` /
      `test("exits 1 …")`), that test **spawns the actual lint binary** and
      asserts its exit code, satisfying `lint:test-spawn-coverage`. (Following the
      convention in `scripts/lint-no-shadow-util.test.ts` and
      `scripts/lint-test-spawn-coverage.test.ts`.)
- [ ] `package.json` has a `lint:src-command-safety` script entry
      (`bun run scripts/lint-src-command-safety.ts`).
- [ ] `.github/workflows/ci.yml` has a new named lint step running
      `bun run lint:src-command-safety`, slotted alongside the other bespoke lint
      steps (next to `Lint template variable safety` is natural).
- [ ] The stale note in `src/remote.ts` (the comment stating the `ssh` token in
      `lint-template-safety.ts` is template-markdown-only and never scans `src/`)
      is updated to point at the new lint and its allowlist exemption.

### AC verification reachability

All AC paths (`scripts/`, `package.json`, `.github/workflows/ci.yml`,
`src/remote.ts`) live inside `git -C /Users/lukstafi/ludics`'s introspection
reach, so a commit-SHA from the project worktree is valid primary evidence. No
out-of-tree (cache/memory/symlink) paths are involved.

## Context

How the relevant pieces work today:

- **`src/remote.ts`** — sole ssh call site in `src/`. `runRemoteCommand` builds
  `safeSyncOutput(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
  machine.host, buildRemoteScript(opts.cwd, cmd)], …)`. `buildRemoteScript(cwd,
  cmd)` returns `` `cd ${cwd} || exit 255; ${cmd}` `` — the unquoted-interpolation
  injection surface. A JSDoc comment on `runRemoteCommand` currently notes that
  the `ssh` token in `lint-template-safety.ts` is "template-markdown-only (that
  lint never scans `src/`)" — this is the stale note an AC updates.

- **`src/spawn.ts`** — `safeSyncOutput(cmd: string[], …)` runs `Bun.spawnSync`
  with an argv array and **no shell**, so the *local* argv is injection-safe by
  construction. The injection risk is entirely in the *remote-script string*
  composed into the last ssh argv element.

- **`scripts/lint-template-safety.ts`** — does NOT have an "ssh blocklist" of the
  kind the retro implied. `ssh` is one entry in its `SHELL_COMMANDS` token list,
  used only to recognize that a Markdown span is shell so it can hunt for
  empty-`{{VAR}}` interpolation in orchestration templates. Its default scan dir
  is `skills/orchestration`, never `src/`. Folding `src/**` into it is the wrong
  shape (template vocabulary vs `.ts` source) — hence the sibling-lint decision.

- **`scripts/lint-no-shadow-util.ts`** — model for "recursively walk `src/` and
  flag a per-file pattern, with a path-relative allowlist." Note its
  `listSourceFiles` / `runCli` structure (pure functions + `import.meta.main`
  exit), its repo-relative path normalization (`relative(root, abs).split(sep)
  .join("/")`), and its `*.test.ts` exclusion + path-skip pattern — the exemption
  mechanism mirrors `if (rel === utilRel) continue;`.

- **`scripts/lint-test-spawn-coverage.ts`** — exports `computeCodeMask(source):
  Uint8Array`, the masked-source state machine (1 = string/comment/template-body
  byte, 0 = real code) the new lint reuses so regex token-scans don't false-fire
  inside comments/strings. Also demonstrates the CLI-spawn test convention and
  (for reference) the `hasPragmaAbove` escape-hatch pattern — though this task
  uses a path allowlist, not a pragma.

- **`.github/workflows/ci.yml`** — ~14 bespoke `Lint …` steps run each PR. The
  new step joins them. `package.json` lines 11-25 hold the `lint:*` script
  entries.

The three design decisions were resolved by the user (2026-06-23), all matching
the tentative-design recommendation:
1. **Sibling lint**, not an extension of `lint:template-safety`.
2. **Medium scope** = path rule + interpolation-shape rule (reuse
   `computeCodeMask`); raw `Bun.spawn*`/`execSync` bypass policing is out of scope.
3. **Path allowlist** (`{"src/remote.ts"}`), encoding the "only `remote.ts` may
   construct ssh" chokepoint invariant; not an inline pragma.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Model the new `scripts/lint-src-command-safety.ts` on `lint-no-shadow-util.ts`
(file discovery + `runCli` + path allowlist) and import `computeCodeMask` from
`lint-test-spawn-coverage.ts` for the masked scan:

1. `listSourceFiles(srcDir)` — reuse the recursive `*.ts` walk pattern (skip
   dotfiles; optionally skip `*.test.ts`, since test fixtures may legitimately
   contain ssh argv literals — decide and document).
2. Per file: compute `mask = computeCodeMask(source)`. Scan for an argv-array
   literal whose first string element is `"ssh"` / `"scp"` / `"rsync"`, ignoring
   matches whose bytes are masked (inside a comment/string). A pragmatic
   recognizer: locate masked-out-clean occurrences of `"ssh"` / `"scp"` /
   `"rsync"` as the first quoted element after a `[`, then inspect the argv
   elements for a template-literal-with-`${…}` argument.
3. **Path rule:** any such argv literal in a non-allowlisted file is a violation.
4. **Interpolation-shape rule:** an argv literal (anywhere in `src/**`) whose
   remote-script element is a `` `…${…}…` `` template literal is the
   higher-severity injection shape. Decide whether the `remote.ts` allowlist
   entry suppresses this for its own vetted line, or whether the interpolation
   rule still reports it at allowlisted sites as informational — the binding
   requirement (AC) is that a *new* interpolated ssh script outside the allowlist
   is flagged.
5. Emit `path:line` violations to stderr, a success summary to stdout, and
   `exit(0|1)`.

Keep the recognizer mechanical and conservative — a few false negatives on exotic
argv shapes are acceptable; the goal is to force every new ssh user to land in the
vetted `remote.ts` chokepoint (where the path allowlist makes the exemption
explicit and reviewable), not to prove injection-freedom in general.

## Scope

**In scope:**
- New sibling lint `scripts/lint-src-command-safety.ts` + co-located test.
- Path-allowlist exemption for `src/remote.ts`.
- `package.json` script + `.github/workflows/ci.yml` step.
- Updating the stale note in `src/remote.ts`.

**Out of scope:**
- Policing raw `Bun.spawn*` / `execSync` / `execFileSync` bypasses of
  `safeSyncOutput` in production code — a broader "all spawns route through the
  wrapper" policy is its own task.
- Any change to `lint-template-safety.ts` (deliberately left untouched — sibling,
  not extension).
- Refactoring `src/remote.ts`'s interpolation itself — it stays the vetted
  chokepoint.

**Dependencies:** none blocking. Relates to `gh-ludics-578`. No `bun run build;
ludics init` needed (pure scripts/CI change, no CLI surface added).
