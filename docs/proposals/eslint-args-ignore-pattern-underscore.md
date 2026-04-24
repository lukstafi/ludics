# ESLint `no-unused-vars`: honor `^_` prefix convention

## Goal

Relax `@typescript-eslint/no-unused-vars` so identifiers prefixed with `_` are
exempt, then remove the two `void <param>;` workaround sites that exist solely
to silence the rule on intentionally-unused params.

This follows up on a coder retrospective from
[gh-ludics-376](https://github.com/lukstafi/ludics/issues/376) where the
inline `void x` workaround was used as a scope-safe stopgap. Honoring the
`_foo` convention is the cleaner long-term fix.

Related: task `task-f84148cc`.

## Acceptance Criteria

- `eslint.config.js` configures `@typescript-eslint/no-unused-vars` with
  `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"` (no
  `caughtErrorsIgnorePattern` leg — out of scope per resolved Q2).
- The rule override is added inside the existing `files: ["src/**/*.ts"]`
  block, alongside the other `@typescript-eslint/*` rule entries.
- `src/sessions/enrich.ts` `enrichSessions` param is renamed to `_sessions`
  and the `void sessions;` line is removed.
- `src/orchestration/transport-t3code.ts` `sendEnter` params are renamed to
  `_state` and `_agent` and the `void state; void agent;` line is removed.
  The interface signature (`Transport.sendEnter`) is unchanged.
- `src/slots/index.test.ts` site that currently has `void stateFile;` is
  cleaned up (see Approach for the chosen form).
- `bun run lint` exits 0.
- `bun run typecheck && bun run build && bun test` are all clean — no
  regressions.

## Context

### Current ESLint configuration

`eslint.config.js` does not explicitly configure
`@typescript-eslint/no-unused-vars`. The rule comes in via
`tseslint.configs.recommendedTypeChecked` at `error` severity with default
options (`args: "after-used"`, no ignore patterns), so a `_`-prefix on a
final/only param does not exempt it.

The custom rules block is scoped to `files: ["src/**/*.ts"]`. A second block
`files: ["src/**/*.test.ts", "templates/**/*.test.ts"]` only relaxes
`no-unsafe-*` and `no-explicit-any` for tests; it does not override
`no-unused-vars`, so the new pattern flows through to test files (desired —
test mocks already use `_target`, `_state`, etc. via `after-used`).

### Sites changed by this task

Two `void <bare-param>;` workaround sites in `src/`, each silencing
`no-unused-vars` on an interface-mandated param:

- `src/sessions/enrich.ts`, `enrichSessions(sessions: DiscoveredSession[])` —
  body is `void sessions; return enrichFromT3codeSlots();`. The `sessions`
  arg is the only/last arg.
- `src/orchestration/transport-t3code.ts`, `sendEnter(state, agent)` — body
  is `void state; void agent;` with comment "No-op for t3code — turns are
  dispatched via WebSocket". Signature must match the `Transport` interface.

One discard-local site in tests:

- `src/slots/index.test.ts` (~line 1537), inside the test "empty-slot assign
  with stale state file does not hit adapter.stop":

  ```ts
  const stateFile = seedTmuxSlotState(harness, 1);
  await slotAssign(1, "task-fresh", "tmux");
  expect(readSlotJson(1, harness).task).toBe("task-fresh");
  // Silence unused-var lint on stateFile
  void stateFile;
  ```

  `seedTmuxSlotState` returns the state file path but the test never reads
  it; only the side effect (seeding the file on disk) matters. Defined
  locally in the same file (two definitions inside nested `describe` blocks).

### Sites NOT in scope (different purpose)

The following `void X;` usages silence `no-floating-promises`, not
`no-unused-vars`, and are unaffected by this change:

- `src/test-utils.ts`: `void probe.stop(true);`
- `src/t3code/client.ts`: `void this.handleMessage(...)`, `void this.connect().catch(...)`
- `src/t3code/client.test.ts`: `void server.stop(true)`
- `src/slots/index.ts`: `void cleanupStaleItems(...).catch(...)`
- `src/slots/index.test.ts` (~30 occurrences): `void slotAssign(…)`
- `scripts/lint-contracts.ts:333`: `void basename;` — unused-import; lives
  outside the `src/**/*.ts` rule block scope anyway.

### `_`-prefixed identifiers in `src/orchestration/skills.ts`

Per user side-observation: `_projectEntry`, `_taskPath`, `_taskContent`,
`_proposalPath` in this file are actually USED — the prefix there is an
informal "raw/intermediate value" marker, not the standard unused-prefix
convention. They pass lint today only because they're referenced. This is
**out of scope** for this task; flagged as a future cleanup rename pass.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Add the rule override

In `eslint.config.js`, inside the `files: ["src/**/*.ts"]` block's `rules`
object (alongside the existing `@typescript-eslint/*` entries), add:

```js
"@typescript-eslint/no-unused-vars": [
  "error",
  {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
  },
],
```

### 2. `src/sessions/enrich.ts`

Rename the param and drop the workaround:

```ts
export async function enrichSessions(
  _sessions: DiscoveredSession[],
): Promise<Map<string, Orchestration>> {
  return enrichFromT3codeSlots();
}
```

### 3. `src/orchestration/transport-t3code.ts`

Rename both params and drop the workaround. The interface signature stays
the same (param names in the implementation don't have to match the
interface):

```ts
async sendEnter(_state: OrchestrationState, _agent: AgentConfig): Promise<void> {
  // No-op for t3code — turns are dispatched via WebSocket, not terminal input.
}
```

### 4. `src/slots/index.test.ts:~1537`

`seedTmuxSlotState` has side effects (seeds the slot state file on disk),
so the call must remain. The cleanest fix is to drop the assignment
entirely, keeping just the side-effecting call and removing the
`void stateFile;` line:

```ts
seedTmuxSlotState(harness, 1);

await slotAssign(1, "task-fresh", "tmux");
```

Equivalently acceptable (matches the user's explicitly-mentioned form):
rename to `const _stateFile = seedTmuxSlotState(harness, 1);` and drop the
`void` line. Coder may pick either; the bare-call form is preferred because
it's the most honest description of what the test actually wants (just the
side effect).

### 5. Verify

Run in order from the project root:

- `bun run lint` — must exit 0.
- `bun run typecheck`
- `bun run build`
- `bun test`

## Scope

**In scope:**

- `eslint.config.js` rule override (`argsIgnorePattern` + `varsIgnorePattern`).
- The four file edits enumerated above.
- Verification that lint/typecheck/build/test all stay green.

**Out of scope:**

- `caughtErrorsIgnorePattern: "^_"` — omitted (no `catch (_err)` exists yet;
  add the leg later if/when it's needed).
- Renaming `_projectEntry` / `_taskPath` / `_taskContent` / `_proposalPath`
  in `src/orchestration/skills.ts` — separate cleanup task, the underscore
  there is a different convention.
- Broader ESLint rule philosophy changes.
- Touching `src/test-utils.ts` `void probe.stop(true)` or any other
  `no-floating-promises` workaround.
- Extending the rule override to `scripts/`, `templates/`, etc. — current
  block scope (`src/**/*.ts`) is preserved.

**Dependencies:** none. This is a self-contained mechanical change derived
from the gh-ludics-376 retrospective.
