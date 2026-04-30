# Thread other frontmatter writers through `renderFrontmatterValue` helper

## Goal

Eliminate the parallel `null` literal in `formatYamlScalar`
(`src/tasks/sync.ts`) by routing the `string | null` subcase through
`renderFrontmatterValue` (`src/tasks/markdown.ts`). After this task, the
canonical YAML-null token `"null"` should appear as a string literal in
exactly one place in `src/` (inside `renderFrontmatterValue` itself).

This is the follow-up cleanup surfaced by `task-138eb60b`'s retrospective:
"`renderFrontmatterValue` is now a shared seam — other writers in the repo
that splice user-supplied scalars into a YAML-frontmatter line can route
through this helper for a uniform null/empty-string shape without
restating the rule."

The audit during elaboration established that `formatYamlScalar` is the
only remaining writer that genuinely matches the hint. Templates in
`tasksCreate`, `tasksSamples`, and `writeTaskFile` splice hardcoded
`null` literals at template-author time and have no runtime scalar to
normalize, so they stay out of scope.

## Acceptance Criteria

- After the change, `formatYamlScalar(null)` returns `"null"`. The on-disk
  shape for a sync writing `null` (e.g. `setFrontmatterScalar(file,
  "github_state_reason", null)`) is unchanged: the line is still
  `github_state_reason: null`. Mutation check: if `renderFrontmatterValue`
  is replaced with a stub that returns `"NULL"`, the new helper test for
  `formatYamlScalar(null)` must fail (proving the helper is actually wired
  in, not coincidentally producing the same byte sequence via the legacy
  `if (value === null) return "null"` branch).
- After the change, `formatYamlScalar("")` returns `"null"` (NOT `'""'`,
  the quoted-empty-string shape it returns today). This is a deliberate
  alignment with `renderFrontmatterValue`'s contract — see the **Known
  Behavioral Change** section below. Mutation check: if the empty-string
  branch is reverted (i.e. `""` falls through to the identifier-regex /
  quoted-string branch), the helper test for `formatYamlScalar("")` must
  fail.
- `formatYamlScalar(true)` returns `"true"` and `formatYamlScalar(false)`
  returns `"false"` (boolean branch unchanged). Mutation check: if the
  boolean branch is removed and `true` falls through to
  `renderFrontmatterValue` (which would coerce it to a string), the test
  must fail. (Concretely: `renderFrontmatterValue` only accepts
  `string | null`; passing a boolean would either type-error or, if the
  signature were widened, change the output. Either way the boolean test
  pins the layered structure.)
- `formatYamlScalar(42)` returns `"42"` and `formatYamlScalar(0)` returns
  `"0"` (number branch unchanged). Mutation check: if the number branch is
  removed, the test for `formatYamlScalar(0)` must fail (since `0` is
  falsy and a careless `if (!value)` short-circuit could route it through
  the null path).
- `formatYamlScalar("hello-world")` returns `"hello-world"` (no quotes —
  identifier branch preserved). Mutation check: if the identifier regex
  is removed and `"hello-world"` falls through to the quoted-string
  branch, the test must fail (it would return `'"hello-world"'` with
  surrounding quotes).
- `formatYamlScalar("hello world")` returns `'"hello world"'` (quoted —
  free-string branch preserved, with `yamlEscape` applied). Mutation
  check: if the quoted-string branch is removed and `"hello world"`
  returns unquoted, the test must fail.
- `setFrontmatterScalar`'s `desiredLine` short-circuit
  (`if (existingLine === desiredLine) return false`) continues to work:
  writing the same value twice in a row still returns `false` on the
  second call. The double-application of `renderFrontmatterValue` (once
  inside `formatYamlScalar`, once inside `updateFrontmatterField` /
  `addFrontmatterField` when the rendered string is passed back through)
  remains a no-op — `renderFrontmatterValue("null") === "null"` and
  `renderFrontmatterValue('"hello world"') === '"hello world"'` (both
  non-empty, so they pass through verbatim).
- `bun run lint`, `bun run typecheck`, `bun run build`, and `bun test` are
  all clean. The existing `src/tasks/sync.test.ts` and
  `src/tasks/markdown.test.ts` suites pass without modification (other
  than the new helper-level tests added for the falsifiers above).
- `grep -n '"null"' src/tasks/sync.ts` no longer matches the
  `formatYamlScalar` body. (After the change, the only `"null"` literal
  in `src/` outside of test files is in `renderFrontmatterValue`'s body.)

## Context

### The seam under audit

`renderFrontmatterValue(value: string | null): string` lives in
`src/tasks/markdown.ts` (just above `updateFrontmatterField`). The body
is a one-liner:

```ts
return (value === null || value === "") ? "null" : value;
```

The rule: collapse JS `null` *and* the empty string to the canonical YAML
null token; pass through non-empty strings verbatim. Already-callers:
`updateFrontmatterField`, `addFrontmatterField` (delegates),
`transitionStatus` (delegates), and `taskUpdateFrontmatterFields` in
`src/slots/index.ts` (threaded explicitly during `task-138eb60b`).

### The remaining parallel renderer

`src/tasks/sync.ts` defines its own scalar renderer at line 213:

```ts
function formatYamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) return value;
  return `"${yamlEscape(value)}"`;
}
```

The contract is *richer* than `renderFrontmatterValue`: it also handles
booleans, numbers, identifier-vs-quoted strings, and YAML escaping.
`renderFrontmatterValue` only handles the `string | null` subcase, so it
cannot subsume `formatYamlScalar` outright — but the `null` branch and
the empty-string handling can be delegated.

`setFrontmatterScalar` at line 222 calls `formatYamlScalar`, then routes
through `updateFrontmatterField` / `addFrontmatterField` — which means
the rendered string is passed through `renderFrontmatterValue` a second
time. That double-application is harmless today (any non-empty rendered
string passes through `renderFrontmatterValue` unchanged) and remains
harmless after this task.

### `setFrontmatterScalar` callers and empty-string risk

`setFrontmatterScalar` is used at ~14 sites in `src/tasks/sync.ts` (lines
545, 561, 572–580, 613, 619, 827, 832) for syncing GitHub-issue state
into task frontmatter. Per-callsite empty-string risk:

| Field                  | Source                                | Empty-string possible? |
|------------------------|---------------------------------------|------------------------|
| `title`                | `issue.title`                         | No (GitHub-required).  |
| `milestone`            | `issue.milestone?.title`              | Only via `null` (different branch). |
| `github_title`         | `issue.title`                         | No.                    |
| `url`                  | `issue.url`                           | No.                    |
| `github_repo`          | `parseRepoFromGitHubUrl` result       | No (would be `null`, different branch). |
| `github_issue`         | `issue.number`                        | Number (different branch). |
| `github_labels`        | `labels.map(l=>l.name).join(",")`     | **Yes** when an issue has zero labels. |
| `github_state`         | `state \|\| "open"`                   | No (`\|\|` fallback).  |
| `github_state_reason`  | `stateReason \|\| null`               | No (`\|\|` fallback to null). |
| `github_updated_at`    | `issue.updatedAt ?? null`             | No.                    |
| `github_closed_at`     | `issue.closedAt ?? null`              | No.                    |
| `status`               | constants (`"blocked"`, `"ready"`, `closureStatus`) | No. |
| `completed`            | ISO timestamp                          | No.                    |

The single field that can receive an empty string today is
`github_labels`, when an issue has no labels. Today
`formatYamlScalar("")` returns `'""'`, so that issue's task file gets the
on-disk line `github_labels: ""`. After this task, the same issue gets
`github_labels: null`. The sole reader is `parseTaskFrontmatterUncached`
in `src/tasks/markdown.ts` line 130:

```ts
github_labels: d.github_labels ? String(d.github_labels) : undefined,
```

Both `null` (parsed YAML null → JS null, falsy) and `""` (also falsy)
collapse to `undefined` here, so the in-memory `ParsedTaskFrontmatter`
shape is unchanged. No other reader inspects `github_labels`. The
behavioral shift is purely cosmetic at the on-disk byte level.

### Known Behavioral Change

`formatYamlScalar("")` shifts from returning `'""'` (a quoted empty
string, on-disk shape `<field>: ""`) to returning `"null"` (on-disk
shape `<field>: null`).

This is the same rule already enforced by the field-update API
(`updateFrontmatterField`, `addFrontmatterField`,
`taskUpdateFrontmatterFields`), via `renderFrontmatterValue`. The shift
brings `formatYamlScalar` into alignment with that rule.

The only callsite that can hit this in production is the
`github_labels` write in `tasksSync` (line 576) when a GitHub issue has
zero labels. Existing on-disk task files with `github_labels: ""` are
unaffected (they are read via the `falsy → undefined` reader path, same
as `github_labels: null`); on the next sync, those files will rewrite to
`github_labels: null`, and `setFrontmatterScalar`'s `desiredLine`
short-circuit means subsequent identical syncs are no-ops.

If a future caller depends on the quoted-empty-string shape, it must
either pass a non-empty string explicitly or use a different writer.
This is the same constraint the field-update API already imposes.

### Templates explicitly out of scope

`tasksCreate` (line 73, `src/tasks/index.ts`), `tasksSamples` (line 147,
same file), and `writeTaskFile` (line 385, `src/tasks/markdown.ts`)
build fresh frontmatter blocks as template literals with hardcoded
`null` lines:

```
deadline: null
slot: null
adapter: null
started: null
completed: null
modified: null
```

The user-supplied splices in these templates (`title`, `project`,
`priority`, `today`, `source`, etc.) are dynamic strings, but the
*null fields* are literal tokens at template-author time, never runtime
values that could be `null | ""`. So `renderFrontmatterValue` has
nothing to normalize — the canonical token is already typed in.

Conditionally-appended fields (`url`, `github_issue`) only appear when
truthy, so the empty-string/null case never reaches the splice. These
templates do not match the durable-learning hint's frame ("splice
user-supplied scalars literally") and stay out of scope.

A different concern for these templates is *quoting* of user-supplied
strings (`"${title}"` does no escaping for embedded quotes). That is a
separate rule and a separate task.

### Code pointers

- `renderFrontmatterValue` — `src/tasks/markdown.ts` line 218.
- `formatYamlScalar` — `src/tasks/sync.ts` line 213.
- `setFrontmatterScalar` — `src/tasks/sync.ts` line 222.
- `setFrontmatterScalar` callers — `src/tasks/sync.ts` lines 545, 561,
  572–580, 613, 619, 827, 832.
- Reader for `github_labels` — `src/tasks/markdown.ts` line 130.
- Templates explicitly out of scope — `src/tasks/index.ts` lines 73, 147,
  and `src/tasks/markdown.ts` line 385.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Import the helper into `sync.ts`

`src/tasks/sync.ts` already imports from `./markdown.ts` (e.g.
`updateFrontmatterField`, `addFrontmatterField`,
`removeFrontmatterField`, `parseTaskFrontmatter`). Add
`renderFrontmatterValue` to that existing import.

### 2. Refactor `formatYamlScalar`

Replace the current body with a layered version that delegates the
`string | null` subcase to `renderFrontmatterValue`:

```ts
function formatYamlScalar(value: string | number | boolean | null): string {
  if (value === null) return renderFrontmatterValue(null);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // string from here: empty-string also collapses to "null" via the helper
  if (value === "") return renderFrontmatterValue("");
  // identifier-shaped strings pass through unquoted
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) return value;
  return `"${yamlEscape(value)}"`;
}
```

The `if (value === "")` clause is technically redundant with the helper
(`renderFrontmatterValue("") === "null"`), but writing it explicitly
makes the layering self-documenting and prevents an empty string from
silently flowing into the identifier-regex branch (which would
short-circuit on `""` not matching `^[a-zA-Z]...` and fall through to
the quoted branch — restoring the legacy `'""'` shape).

A more compact alternative:

```ts
function formatYamlScalar(value: string | number | boolean | null): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // value is string | null here
  if (value === null || value === "") return renderFrontmatterValue(value);
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) return value;
  return `"${yamlEscape(value)}"`;
}
```

Either is acceptable; pick whichever reads cleaner.

### 3. Add helper-level tests

`formatYamlScalar` and `setFrontmatterScalar` are currently unexported.
For the falsifier ACs above (mutation-testable per-branch), the cleanest
path is to **export `formatYamlScalar`** (the renderer is pure, no
mutable state, no I/O — exporting it for testing is harmless) and add a
new `describe("formatYamlScalar", ...)` block to `src/tasks/sync.test.ts`
covering:

- `formatYamlScalar(null)` → `"null"`
- `formatYamlScalar("")` → `"null"` (the deliberate shift)
- `formatYamlScalar(true)` → `"true"`, `formatYamlScalar(false)` → `"false"`
- `formatYamlScalar(0)` → `"0"`, `formatYamlScalar(42)` → `"42"`
- `formatYamlScalar("hello-world")` → `"hello-world"` (identifier, no quotes)
- `formatYamlScalar("hello world")` → `'"hello world"'` (quoted)

If exporting `formatYamlScalar` feels like API leakage, the alternative
is to test the behavior end-to-end via `setFrontmatterScalar` and
file-on-disk inspection — but that's heavier and the per-branch
mutation-testability gets noisier (each assertion would have to set up
a temp file and compare the rewritten content). Exporting the pure
helper is cheaper and the per-branch falsifiers stay precise.

### 4. Verify

From `~/ludics`:

- `bun run lint` — must exit 0.
- `bun run typecheck` — must exit 0 (no signature changes; only the
  helper is exported).
- `bun run build` — must succeed.
- `bun test` — all existing tests pass; new helper-level tests pass.
- `grep -n '"null"' src/tasks/sync.ts` — must show no matches inside
  `formatYamlScalar`. (Other matches in `sync.ts` related to YAML-string
  parsing or fixture data, if any, can stay.)
- `grep -rn '"null"' src/ --include='*.ts' | grep -v '\.test\.ts'` —
  `src/tasks/markdown.ts` (`renderFrontmatterValue` body) and any
  read-side normalizers (`normalizeOptionalString`,
  `parseTaskFrontmatterLineFallback`) remain. The `formatYamlScalar`
  match should be gone.

## Scope

**In scope:**

- Refactor `formatYamlScalar` in `src/tasks/sync.ts` to delegate the
  `string | null` subcase to `renderFrontmatterValue`.
- Export `formatYamlScalar` (or arrange equivalent test access) so the
  falsifier ACs can be tested per-branch.
- Add helper-level tests to `src/tasks/sync.test.ts` covering the six
  branches enumerated in Acceptance Criteria.
- Verification (lint/typecheck/build/test).

**Out of scope:**

- The fresh-file templates in `tasksCreate`, `tasksSamples`
  (`src/tasks/index.ts`) and `writeTaskFile` (`src/tasks/markdown.ts`).
  These splice hardcoded `null` literals at compile time and have no
  runtime scalar to normalize.
- Quoting of user-supplied strings in those templates (`"${title}"`
  with no escape handling) — separate concern, separate task.
- The double-application of `renderFrontmatterValue` inside
  `setFrontmatterScalar` → `updateFrontmatterField`. Harmless today,
  harmless after this task.
- Reader-side normalization (already centralized in
  `normalizeOptionalString` / `parseTaskFrontmatterLineFallback`).
- The four `"null"` write sites in `src/slots/index.ts` — already
  cleaned up by `task-138eb60b` and the
  `cleanup-null-string-sentinels-in-slots-index.md` proposal.

**Dependencies:** none. The retrospective from `task-138eb60b` is
already merged; this task is independent of any other open work.
