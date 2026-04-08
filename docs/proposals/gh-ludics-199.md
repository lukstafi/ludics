# Bun mock.module() leaks globally across test files — document safe mocking pattern

## Goal

Document and enforce the safe mocking pattern for Bun test suites: always use `spyOn()` paired with `mockRestore()` in `afterEach`, never use top-level `mock.module()`. Add a CI lint check to prevent regressions.

## Acceptance Criteria

1. A new `docs/testing-patterns.md` file documents the safe mocking pattern: import the module namespace, use `spyOn(module, 'fn').mockImplementation(...)`, restore in `afterEach(() => { spy.mockRestore(); })`. Explains *why*: Bun's `mock.module()` replaces modules globally for the entire test runner process, causing cross-file pollution when tests run together.

2. The document includes a concrete "before/after" code example contrasting the unsafe `mock.module()` pattern with the safe `spyOn` pattern, drawn from the actual codebase (e.g., `runner.test.ts` or `federation-http.test.ts`).

3. An ESLint `no-restricted-syntax` rule is added to `eslint.config.js` in a separate config block targeting `src/**/*.test.ts` files. The rule bans `CallExpression[callee.object.name='mock'][callee.property.name='module']` with the message: "Use spyOn() + mockRestore() instead of mock.module() — it leaks globally across all test files in the Bun test runner."

4. A new npm script `lint:no-mock-module` is added to `package.json` that runs the ESLint check scoped to test files (or equivalently a `grep -r 'mock\.module(' src/ --include='*.test.ts'` guard script). The script exits nonzero if any `mock.module(` call is found.

5. The `lint:no-mock-module` script is wired into `ci.yml` as a new CI step after the existing `Lint CLI/README drift` step.

6. All existing test files in `src/**/*.test.ts` pass the new check (currently zero uses of `mock.module()` — this is a preventive measure, not a fix).

7. A comment block is added near the top of `src/orchestration/runner.test.ts` (the largest test file and canonical reference for the codebase) pointing to `docs/testing-patterns.md` and summarising the rule in one line.

## Context

### Problem

`mock.module()` in Bun replaces a module's exports globally within the test runner process. When `bun test` runs multiple files in the same process (the default), a `mock.module()` call in file A remains active when file B executes — even if file B never called it. This caused a production incident in task-5d813109: tests for `refreshAgentStatuses` that expected real event journal writes were silently receiving mocked implementations from an unrelated test file. It took two extra rounds to diagnose.

### Current State

- **Zero remaining `mock.module()` calls** in `src/**/*.test.ts`. The codebase is already clean; this task is preventive.
- **5 test files** already use the correct `spyOn` pattern: `runner.test.ts`, `federation-http.test.ts`, `transport-tmux.test.ts`, `phases.test.ts`, `skills.test.ts`.
- **4 of those 5** pair `spyOn` with `mockRestore()` in `afterEach`. `skills.test.ts` is the exception — it uses `spyOn` without `afterEach`/`mockRestore()`, which is acceptable only because those tests mock Bun built-ins (`Bun.file`) within individual test blocks.
- **No testing guide** exists in `docs/` or as a `CONTRIBUTING.md`.
- **ESLint** runs on `src/**/*.ts` with type-checked rules; test files are included in coverage but have no mock-specific rule.
- **CI** runs typecheck, build, and `lint:cli-readme`; no `bun test` step and no mock-module guard.

### Reference Implementations

`src/orchestration/runner.test.ts` is the canonical example. A representative pattern:

```typescript
// Safe: spy is declared in describe scope, set in beforeEach, restored in afterEach
let eventSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
});

afterEach(() => {
  eventSpy.mockRestore();
});
```

`src/federation-http.test.ts` shows per-test inline spies that are restored at the end of each test:

```typescript
const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(() => {});
// ... test body ...
slotClearSpy.mockRestore();
```

Both patterns are acceptable. The key invariant is that every spy is restored before the test or test group exits.

### Why Not ESLint Alone

ESLint's `no-restricted-syntax` provides IDE-time feedback and integrates with existing `bun run lint` workflow. However, ESLint only processes files listed in its config. The separate `lint:no-mock-module` grep script is a fast, zero-config backstop for CI that does not depend on ESLint's file-matching configuration being exactly right.

## Approach

### Step 1: Write `docs/testing-patterns.md`

Create the document with:
- A brief explanation of Bun's test runner process model and why `mock.module()` is dangerous
- The safe pattern (import namespace → spyOn → mockImplementation → mockRestore in afterEach)
- A "do not do this" section showing `mock.module()` with an explanation of the failure mode
- A note on when per-test inline spies are appropriate vs. describe-level beforeEach/afterEach

### Step 2: Add ESLint rule

Add a second config block in `eslint.config.js` targeting `src/**/*.test.ts`:

```javascript
{
  files: ["src/**/*.test.ts"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.object.name='mock'][callee.property.name='module']",
        message:
          "Use spyOn() + mockRestore() instead of mock.module() — it leaks globally across all test files in the Bun test runner. See docs/testing-patterns.md.",
      },
    ],
  },
},
```

Note: this block does not need `languageOptions.parserOptions` (no type-checking needed for a syntax rule), so it is lightweight.

### Step 3: Add `lint:no-mock-module` script

In `package.json`, add:

```json
"lint:no-mock-module": "! grep -r 'mock\\.module(' src/ --include='*.test.ts' -l"
```

The `!` inverts the exit code: grep succeeds (exit 0) when matches are found, which the `!` turns into failure. If no matches exist, grep exits 1, `!` turns it into 0 (success).

### Step 4: Wire into CI

Add after the `Lint CLI/README drift` step in `ci.yml`:

```yaml
- name: Lint — no mock.module() in tests
  run: bun run lint:no-mock-module
```

### Step 5: Add comment in `runner.test.ts`

After the existing import block, add:

```typescript
// Testing pattern: always use spyOn(module, 'fn').mockImplementation(...)
// and restore in afterEach(() => { spy.mockRestore(); }).
// Never use mock.module() — it leaks globally across test files.
// See docs/testing-patterns.md for the full guide.
```

## Scope

- **In scope**: `docs/testing-patterns.md` (new), `eslint.config.js` (new block), `package.json` (one new script), `.github/workflows/ci.yml` (one new step), `src/orchestration/runner.test.ts` (comment only).
- **Out of scope**: Modifying any test logic, adding/removing spies, changing CI test execution (no `bun test` step added here — that is a separate concern).
- **No existing test changes required**: the codebase has zero `mock.module()` calls in test files today.
