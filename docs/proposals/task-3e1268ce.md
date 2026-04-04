# Make queueRequest type-safe for action-specific fields

## Goal

Replace the raw JSON fragment `extra` parameter in `queueRequest` with a discriminated union type, so that action-specific fields (like `repo` for `feedback-digest`, `task` for `elaborate`, etc.) are enforced at compile time. This prevents the class of bug where required fields are silently omitted.

## Acceptance Criteria

1. `queueRequest` accepts a single typed object argument instead of `(action: string, extra?: string)`. Each action's required and optional fields are enforced by TypeScript's type system.
2. All existing call sites (~30 across `mag.ts`, `notify.ts`, `tasks/sync.ts`, `retrospective.ts`) are migrated to the new signature.
3. The serialized JSONL output format is unchanged: each line is a JSON object with `id`, `action`, `timestamp`, and any action-specific fields at the top level.
4. Tests in `queue.test.ts` are updated to use the new call signature and continue to pass.
5. The project compiles cleanly with `bun run build` (no type errors).
6. No double-encoding: fields like `content` in `message` actions are passed as raw strings; `JSON.stringify` of the whole record handles escaping.

## Context

**Current implementation** (`src/queue.ts`, line 37-54):
`queueRequest(action: string, extra?: string)` splices a raw JSON fragment into a template string. This is fragile -- typos, missing fields, and malformed JSON are invisible to the compiler.

**Root cause**: The `feedback-digest` action requires a `repo` field, but nothing in the type system enforces this. A prior bug (`task-f027845e`) was caused by a call site omitting `repo`.

**Action inventory** (from all call sites):

| Action | Required fields | Optional fields |
|--------|----------------|-----------------|
| `briefing`, `suggest`, `health-check` | (none) | |
| `elaborate`, `draft-proposal`, `split-task`, `verify-completion`, `complete-task`, `process-suggestions` | `task` | |
| `revise-proposal` | `task` | `feedback` |
| `preempt` | `task`, `autonomy` | |
| `feedback-digest` | `repo` | |
| `message` | `content` | |
| `adapter-followup` | `task`, `adapter` | `followup_msg` |
| `adopt-sessions` | (none) | |

**Files to modify**:
- `src/queue.ts` -- define `QueueAction` discriminated union type, rewrite `queueRequest` to use `JSON.stringify`
- `src/mag.ts` -- ~18 call sites
- `src/notify.ts` -- ~10 call sites
- `src/tasks/sync.ts` -- 2 call sites
- `src/retrospective.ts` -- 1 call site
- `src/queue.test.ts` -- update test calls

**Edge case -- escaping**: Some call sites currently pre-escape strings with `JSON.stringify` before embedding in the fragment (e.g., `"content":${JSON.stringify(text)}`). With the new approach, `JSON.stringify` of the whole record handles escaping, so call sites should pass raw strings. No consumer of `queuePop` expects double-encoded values since the current output is already valid JSON with properly escaped strings.

## Approach

1. Define a `QueueAction` discriminated union type in `src/queue.ts` covering all actions listed above.
2. Rewrite `queueRequest` to accept `QueueAction`, construct the record as a plain object, and serialize with `JSON.stringify`.
3. Migrate each call site mechanically: replace `queueRequest("action", '"key":"value"')` with `queueRequest({ action: "action", key: value })`. Remove any `JSON.stringify` wrapping on individual field values (the whole-record stringify handles it).
4. Update `queue.test.ts` to use the new signature.
5. Run `bun run build` to verify no type errors, run tests.
