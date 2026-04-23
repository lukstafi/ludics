# Preventive comment on `reviewerOnlyFlag` naming the flag-name-keyed-rejection pattern

## Goal

After the `parseT3CodeAdapterArgs` fix in task-da8b6dff round 2, the
`reviewerOnlyFlag: string | null` variable in `src/adapters/t3code.ts` is the
only in-repo enforcement of the "reject by which flag was provided, not by
whether a variable ended up set" discipline. A future contributor extending
this parser (or writing a new role-specific parser) has nothing near the code
site naming that discipline — so the anti-pattern can quietly return.

Add a short comment block near the `reviewerOnlyFlag` declaration that

1. Names the anti-pattern ("recorded but discarded" / flag-name-keyed-rejection).
2. States the rule: rejection must be keyed on the flag name seen during
   parsing, not on whether the target variable is `undefined` after parsing
   (because shared flags and role-specific flags may assign the same target).
3. Links to the `flag-name-keyed-rejection` anchor in
   `docs/orchestration-patterns.md` for the full pattern entry.

This is the "Option B (small preventive)" outcome of task-8f5a78a1's audit.
The audit (2026-04-22) enumerated 12 CLI parsers in `src/`; only
`parseT3CodeAdapterArgs` has role-specific flags, and the `reviewerOnlyFlag`
fix already covers it. See the Tentative Design of `tasks/task-8f5a78a1.md`
for the enumeration.

## Acceptance Criteria

1. **Comment block present.** A comment immediately above (or immediately
   adjacent to) the `reviewerOnlyFlag` declaration in `src/adapters/t3code.ts`
   names the anti-pattern and states the flag-name-keyed-rejection rule in
   one or two sentences. The existing explanatory comment on lines 227–229
   ("Track the first reviewer-only override flag seen …") is kept, extended,
   or folded into the new block — whichever reads best.

2. **Anchor reference.** The comment cites the pattern entry by the anchor
   `flag-name-keyed-rejection` in `docs/orchestration-patterns.md` so a reader
   can jump to the full write-up. Format is up to the implementer (e.g.
   `// See docs/orchestration-patterns.md#flag-name-keyed-rejection` or a
   prose reference that mentions both the doc and the anchor).

3. **Sequencing gate — anchor must exist at implementation time.** Before
   committing, verify that `docs/orchestration-patterns.md` contains an
   anchor that resolves to `flag-name-keyed-rejection` (i.e. a heading
   whose GitHub slug is exactly that string — typically
   `### Flag-name-keyed rejection` or similar). The
   `task-ba243220` bundle PR
   (`docs/proposals/orchestration-patterns-bundle-2026-04.md`, acceptance
   criterion A item 10) adds this anchor. If the anchor is not present when
   this task's coder begins, stop and report that the prerequisite PR has
   not merged yet — do not ship a forward reference. Cross-check:
   `grep -n 'flag-name-keyed' docs/orchestration-patterns.md` should return
   at least one heading-line match.

4. **Scope.** Exactly one comment block change inside
   `src/adapters/t3code.ts`, near the `reviewerOnlyFlag` declaration. No
   code behaviour change. No new helpers. No test changes. No touches to
   other files.

5. **Build + lint still pass.** `bun run lint` and `bun test` do not
   regress from the base branch.

## Context

### Code site (by symbol, not line number)

`src/adapters/t3code.ts`, inside `export function parseT3CodeAdapterArgs`,
at the declaration:

```ts
// Track the first reviewer-only override flag seen (excluding the shared
// --effort / --thinking-effort flags). Used to reject reviewer-specific
// overrides in --solo mode, where no reviewer agent exists.
let reviewerOnlyFlag: string | null = null;
```

The two assignment sites are in the `case "--reviewer-model":` and
`case "--reviewer-effort":` / `case "--reviewer-thinking-effort":` arms:

```ts
if (!reviewerOnlyFlag) reviewerOnlyFlag = arg;
```

The enforcement site is near the end of the function:

```ts
if (reviewerOnlyFlag) {
  throw new Error(`t3code adapter args: --solo is incompatible with ${reviewerOnlyFlag} (no reviewer exists in solo mode)`);
}
```

The new comment block belongs adjacent to the declaration so the three
sites read together.

### Why flag-name-keyed instead of variable-state-keyed

Both shared and role-specific flags assign the same underlying variable
(`reviewerThinkingEffort`):

- `--effort max` → sets `coderThinkingEffort` **and** `reviewerThinkingEffort`.
- `--reviewer-effort max` → sets **only** `reviewerThinkingEffort`.

A naive check like `if (mode === "solo" && reviewerThinkingEffort !== undefined)
throw …` is wrong: it mis-fires on legitimate `--effort` + `--solo` combos,
and mis-*passes* when `--reviewer-effort` was given without a mode flag
(the variable state after parsing is indistinguishable from the shared case).
Recording the *flag name* on the role-specific branches is the only
signal that survives mode-gate evaluation.

### Sequencing constraint

The `flag-name-keyed-rejection` anchor in `docs/orchestration-patterns.md`
is added by the bundle PR for `task-ba243220`. At proposal-writing time
(2026-04-23) that anchor is **not yet** present in the repo
(`grep flag-name-keyed docs/orchestration-patterns.md` returns nothing).
This proposal therefore requires the bundle PR to merge first. The
verification step in Acceptance Criterion 3 is the gate.

### Related tasks

- `task-da8b6dff` — originally introduced `reviewerOnlyFlag` in round 2.
  Done. See retrospective for the pattern provenance.
- `task-ba243220` — bundle PR that adds the `flag-name-keyed-rejection`
  anchor to `docs/orchestration-patterns.md`. **Must merge before this task
  is implemented.** Referenced in this task's `blocked_by` linkage
  (conceptually — they are listed as `relates_to` but the anchor must
  exist at implementation time).
- `task-67853321` — proposed rename of `parseT3CodeAdapterArgs` to
  `parseOrchestrationAdapterArgs`. **Independent.** If that rename lands
  before this task's implementation, the comment still belongs at the same
  site (just inside a renamed function); no content change, no anchor
  change. Adjust the surrounding function-name mention in the comment if
  and only if the rename has landed.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Extend the existing 3-line comment above `let reviewerOnlyFlag: string | null = null;`
to something like:

```ts
// Anti-pattern being prevented: "recorded but discarded" — accepting
// --reviewer-* flags into a target variable that a later mode branch
// (here, --solo) silently overwrites or ignores, so the flag parses
// successfully but has no effect. The fix is to key rejection on the
// flag NAME recorded during parsing, not on whether the target variable
// is set afterwards (shared flags like --effort assign the same target
// as role-specific flags like --reviewer-effort, so post-parse variable
// state cannot distinguish the two cases).
//
// See docs/orchestration-patterns.md#flag-name-keyed-rejection for the
// full pattern entry, worked example, and the reusable recipe for
// future adapter parsers that gain role-specific flags.
//
// reviewerOnlyFlag records the first --reviewer-* flag seen (excluding
// the shared --effort / --thinking-effort flags). Checked at the --solo
// mode gate to throw with a specific error naming the offending flag.
let reviewerOnlyFlag: string | null = null;
```

Exact wording is the implementer's call; the acceptance criteria fix the
intent, not the prose. Keep it tight — the pattern doc carries the long
form; this comment's job is to put the anchor within one file-jump of
the code site.

## Scope

**In scope:**

- Single comment block adjustment in `src/adapters/t3code.ts` adjacent to
  `reviewerOnlyFlag`.

**Out of scope:**

- Any code behaviour change (the existing `reviewerOnlyFlag` logic is
  correct; this task only documents it).
- New helpers, refactors, or extraction of a `recordRoleFlag()` utility
  (mentioned as a "maybe if a second adapter ever gains role-specific
  flags" in the Tentative Design — deferred until that actually happens).
- Test additions or changes. The existing `t3code.test.ts` coverage for
  the `--solo` + `--reviewer-*` rejection continues to gate the behaviour.
- Other CLI parsers. The audit confirmed zero additional hits.
- Tightening `runEvents` / `runSlot` silent-unknown-flag behaviour
  (different anti-pattern, explicitly out of scope per the task).

**Dependencies:**

- Hard: `task-ba243220` bundle PR must merge first so the
  `flag-name-keyed-rejection` anchor exists in
  `docs/orchestration-patterns.md`. The coder verifies this at the start
  of implementation (Acceptance Criterion 3); if the anchor is absent,
  the task waits.
- Soft: `task-67853321` (parser rename) is independent; either ordering
  works. If the rename lands first, adjust any function-name mention in
  the new comment accordingly — no other change.
