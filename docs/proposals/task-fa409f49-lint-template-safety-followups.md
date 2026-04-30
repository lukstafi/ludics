# lint-template-safety follow-ups: empty-default convention doc, env-stripper unification, drop dead `fencedLines` parameter

## Goal

Three small, tightly-coupled cleanups carried over from the `task-b435e58d`
retrospective (PR #398, "lint-template-safety hardening"). Each cleanup is a
single-paragraph improvement to the same module pair
(`scripts/lint-template-safety.{ts,test.ts}` + neighboring
`src/orchestration/skills.ts`). Bundled per the neighbor-suggestions rule —
shipping them as separate PRs would triple the review overhead for ~50 lines
of net change. None requires creative design; all three sites and decisions
were resolved during elaboration.

The improvements:

1. **Document the empty-default-marker convention** at the source of truth —
   the JSDoc above `ALWAYS_POPULATED_KEYS` — so future maintainers can add
   a new key without re-deriving the rule from a drift-test failure.
2. **Lift the smarter `$(...)`-aware env-prefix stripper** out of the test
   file into the production lint module, replacing the brittle
   `ENV_ASSIGNMENT_PREFIX` regex (whose `\S*` alternative halts mid-`$(...)`
   on values containing whitespace, e.g.
   `PR_URL=$(cat "..." 2>/dev/null) gh pr view`).
3. **Drop the dead `fencedLines` parameter** from
   `findInlineShellSpans(lines, fencedLines?)`. No production caller passes
   it after the PR #398 cleanup; the parameter is a footgun (it lets a
   caller hand in a stale `Set<number>` that disagrees with the
   `classifyLines` partition).

## Acceptance Criteria

- The JSDoc block immediately above
  `ALWAYS_POPULATED_KEYS` in `src/orchestration/skills.ts` frames the
  empty-default-marker rule (`?? ""` / `: ""` / `|| ""` on the assignment
  line) as a *project-wide convention for template-context builders*, not
  just a hack to satisfy the drift test. The new wording explicitly scopes
  the convention to assignments whose RHS *may legitimately produce an
  empty string* — it must not invite a maintainer to mechanically suffix
  `|| ""` to assignments backed by inherently non-empty sources.
- The convention text remains co-located with `ALWAYS_POPULATED_KEYS`
  (same JSDoc, no separate doc file). Maintainers reading the set will see
  the rule.
- A private helper named `stripLeadingEnvAssignments` lives in
  `scripts/lint-template-safety.ts` (placed near `ENV_ASSIGNMENT_PREFIX`).
  Signature: `(line: string) => string | null`. Returns `null` when the
  entire line is a pure assignment (no command after); otherwise returns
  the remainder starting at the first command token. It correctly handles
  `$(...)` values containing whitespace, double-quoted values, and
  single-quoted values with escapes — i.e., it matches the semantics of
  the helper currently inlined in `scripts/lint-template-safety.test.ts`'s
  `collectFailures` closure.
- The helper is exported (or otherwise accessible) so the meta-test in
  `scripts/lint-template-safety.test.ts` consumes it directly instead of
  carrying its own copy. After the lift, the test file no longer defines
  a duplicate `stripLeadingEnvAssignments` body.
- `looksLikeShell` in `scripts/lint-template-safety.ts` uses the new
  helper instead of `ENV_ASSIGNMENT_PREFIX.replace(...)`. When the helper
  returns `null` (pure-assignment input like `"FOO=bar"`),
  `looksLikeShell` returns `false` — the same as today's behavior on the
  same input. When the helper returns a non-null remainder,
  `looksLikeShell` continues with that remainder through the existing
  `SHELL_COMMAND_PREFIX` / `$(/${` / `SHELL_CHAIN` checks.
- After the lift, `looksLikeShell` correctly classifies pure-assignment
  lines whose RHS is `$(...)` as **not** shell. Concretely:
  `looksLikeShell("PR_URL=$(cat \"x\" 2>/dev/null)")` returns `false`
  (today: `true`, because `body.replace(ENV_ASSIGNMENT_PREFIX, "")` halts
  mid-`$(...)` and leaves the residual `$(` to be picked up by the
  independent `/\$\(|\$\{/` recognizer, falsely flagging the assignment as
  a shell command). The same input with a real command appended —
  `looksLikeShell("PR_URL=$(cat \"x\" 2>/dev/null) gh pr view")` — keeps
  its existing `true` classification, but now via `SHELL_COMMAND_PREFIX`
  matching the post-strip remainder rather than via the `$(` fallback;
  i.e., the helper correctly identifies the *command* (`gh pr view`) as
  the shell signal instead of relying on the `$(` artefact inside the
  assignment value. Both directions of this gap-closure are exercised by
  new unit tests.

  > **AC drafting note (added during coder verification on 2026-04-30):**
  > the original AC bullet claimed today's behavior on the
  > "`PR_URL=$(...) gh pr view`" input is `false`. Empirical probe shows
  > today's behavior is `true` (the `$(/${` recognizer fires). The AC has
  > been revised to the actually-load-bearing case (pure-assignment
  > `PR_URL=$(...)` without a trailing command, where today's `true`
  > result is incorrect and the new helper produces the correct `false`).
- `ENV_ASSIGNMENT_PREFIX` may be retained as an exported constant for the
  one residual fallback consumer (the per-segment stripper in the
  meta-test's `splitOnShellChain` segment loop) or removed entirely if
  that consumer also adopts the new helper. The choice is at the coder's
  discretion as long as the meta-test still passes; the load-bearing path
  (`looksLikeShell` → runtime lint) goes through the new helper either way.
- `findInlineShellSpans` in `scripts/lint-template-safety.ts` has signature
  `(lines: string[]) => ShellSpan[]` — the `fencedLines?: Set<number>`
  parameter is gone. The function body's ternary collapses to the
  `classifyLines(lines)`-derived skip predicate.
- The JSDoc above `findInlineShellSpans` no longer mentions the
  back-compat `fencedLines` parameter. (The current paragraph beginning
  "The optional `fencedLines` parameter is preserved for back-compat
  callers..." is removed.)
- All existing call sites of `findInlineShellSpans` (the single in-tree
  caller in `lintTemplate` plus the seven call sites in
  `lint-template-safety.test.ts`) compile and pass without edits — they
  already use the single-argument form.
- All 60+ existing tests in `scripts/lint-template-safety.test.ts`
  continue to pass. New unit tests cover (at minimum) the
  `stripLeadingEnvAssignments` `null`-return on pure-assignment input and
  the previously-broken `$(...)`-with-whitespace case in `looksLikeShell`.
- `bun test scripts/lint-template-safety.test.ts && bun run lint:template-safety && bun run typecheck && bun run lint && bun run build`
  is green. Runtime lint exit code on clean templates is unchanged
  (still `0`).
- No edits outside the three files touched. No new dependencies. No
  changes to other `Record<string, string>` builders elsewhere in `src/`
  — none of them carry the drift-test invariant (verified during
  elaboration: the matches in `dashboard-server.ts`, `cluster-http.ts`,
  `skill-queue-registry.ts`, `dashboard.ts`, `spawn.ts` are header /
  config / env maps, not template-substitution sources).

## Context

All three improvements live in two files plus one neighbor:

- **`src/orchestration/skills.ts`** — `ALWAYS_POPULATED_KEYS` is a
  `ReadonlySet<string>` exported near the top of the file. The JSDoc above
  it already documents the empty-default-marker rule, but frames it as
  *"the drift test needs this"* rather than as the canonical way to
  declare an empty-capable string at any template-context builder. The
  drift-test partner lives at the "ALWAYS_POPULATED_KEYS drift" describe
  block in `scripts/lint-template-safety.test.ts`. The single populating
  call site is `buildSkillContext`'s `result: Record<string, string>`
  literal — bare-identifier RHS values like `proposalPath`,
  `proposalInstruction`, `proposalFreshnessWarningText`, and
  `extractAcceptanceCriteria(...)` already carry the `|| ""` suffix
  introduced in the original retro fix.
- **`scripts/lint-template-safety.ts`**:
  - `ENV_ASSIGNMENT_PREFIX` — exported regex
    `/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/`. The `\S*`
    alternative is the weakness called out in Item 2: it halts at the
    first space inside `$(...)` values. Used today only by
    `looksLikeShell`, plus one fallback consumer in the meta-test.
  - `looksLikeShell(body)` — single in-tree caller of
    `ENV_ASSIGNMENT_PREFIX`. Strips a leading whitespace chunk and
    leading env assignments, then runs the `SHELL_COMMAND_PREFIX`,
    `$(/${`, and `SHELL_CHAIN` recognizers. After the lift, the leading
    `body.replace(/^\s+/, "").replace(ENV_ASSIGNMENT_PREFIX, "")` becomes
    a `stripLeadingEnvAssignments(body)` call with `null` early-return.
  - `findInlineShellSpans(lines, fencedLines?)` — second-pass scanner.
    Today's body branches on `fencedLines ?? classifyLines(lines)`-derived
    skip set. Removing the parameter collapses the ternary to the IIFE
    `() => { const classes = classifyLines(lines); return (i) => classes[i]!.kind !== "prose"; }`.
  - `lintTemplate` — only in-tree caller, already passes
    `findInlineShellSpans(lines)` (one argument).
- **`scripts/lint-template-safety.test.ts`**:
  - `stripLeadingEnvAssignments(line: string): string | null` — private
    helper inside the `collectFailures(dir)` closure of the
    "ALWAYS_POPULATED_KEYS drift" / template-shell-token meta-test
    (preceded by the comment *"Strip leading env-var assignments,
    including those with `$(...)`"*). Returns `null` for pure-assignment
    lines, otherwise the remainder. Pure string parsing — no module
    dependencies. This is the function to lift verbatim.
  - All seven `findInlineShellSpans(lines)` describe-block call sites
    use the single-argument form; dropping the parameter requires no
    test edits.
  - One residual `ENV_ASSIGNMENT_PREFIX` consumer at
    `const segBody = trimmed.replace(ENV_ASSIGNMENT_PREFIX, "")` in the
    `splitOnShellChain` segment loop — segment-level fallback for env
    prefixes after a `&&` / `;` chain split.

## Approach (suggested)

*Suggested approach — agents may deviate if they find a better path.*

1. **Item 1 (JSDoc rephrase).** Edit the JSDoc block above
   `ALWAYS_POPULATED_KEYS` in `src/orchestration/skills.ts`. Reframe the
   "empty-default markers" sentence as a project-wide convention for
   template-context builders (not "the drift test needs this"). Add an
   explicit scoping clause: the marker applies to assignments whose RHS
   *may legitimately produce an empty string*, not to all string
   assignments. Keep the existing CI-drift-pair pointer to the test.
   Possible wording (final form at coder's discretion):

   > **Convention.** Inside `buildSkillContext`'s `result` literal — and
   > inside any analogous template-context builder — every assignment
   > whose RHS may legitimately produce an empty string must carry a
   > visible `?? ""`, `: ""`, or `|| ""` marker on the assignment line.
   > This hoists the "may be empty" signal from the upstream `const`
   > definition into the assignment site, where the drift test parses it.
   > Assignments backed by inherently non-empty sources (e.g.
   > `agent.provider`) must not carry the marker — it would be
   > misleading.

2. **Item 2 (lift the smart stripper).** Move
   `stripLeadingEnvAssignments` from
   `scripts/lint-template-safety.test.ts`'s `collectFailures` closure
   into `scripts/lint-template-safety.ts`, placed near
   `ENV_ASSIGNMENT_PREFIX`. Export it (private to the repo, but the test
   needs it). Rewrite `looksLikeShell`:

   ```ts
   export function looksLikeShell(body: string): boolean {
     const stripped = stripLeadingEnvAssignments(body.replace(/^\s+/, ""));
     if (stripped === null) return false;
     if (SHELL_COMMAND_PREFIX.test(stripped)) return true;
     if (/\$\(|\$\{/.test(body)) return true;
     if (SHELL_CHAIN.test(body)) return true;
     return false;
   }
   ```

   In the test file, delete the duplicate body and import from the
   production module. The residual `ENV_ASSIGNMENT_PREFIX` consumer in
   the segment loop may stay as-is (segments rarely contain `$(...)`) or
   migrate to the new helper — coder's call.

   Add unit tests for the gap-closure (`PR_URL=$(cat "..." 2>/dev/null) gh pr view`)
   and the `null` early-return path (`FOO=bar`, `FOO="bar baz"`).

3. **Item 3 (drop `fencedLines`).** Change the signature to
   `findInlineShellSpans(lines: string[]): ShellSpan[]`. Replace the
   ternary `skip` initializer with a single call to `classifyLines`.
   Update the JSDoc above the function — drop the paragraph about the
   back-compat parameter; the remaining text already documents the
   one-source-of-truth flow correctly.

4. **Verification.** Run
   `bun test scripts/lint-template-safety.test.ts && bun run lint:template-safety && bun run typecheck && bun run lint && bun run build`.

## Scope

**In scope:** the three items above, in the three files named.

**Out of scope:**

- Item 4 from the retrospective ("AC-author process guidance about 'or
  equivalent' wording") — workflow lesson, not a code change.
- Item 5 from the retrospective ("docs note for 'probe the world before
  writing the assertion' pattern") — separately tracked as a docs-only
  task.
- Adopting the empty-default-marker convention for other
  `Record<string, string>` builders elsewhere in `src/` — they don't
  carry the drift-test invariant (verified during elaboration), so
  blanket adoption would be cargo-culting.

**Dependencies:** None. `task-b435e58d` (PR #398) has long since merged.
The three sites were re-verified to still apply against `ludics` `main`
during elaboration on 2026-04-30.
