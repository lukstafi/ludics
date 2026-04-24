# Dedup `isoNow` in `src/t3code/server.ts`

## Goal

Eliminate the file-private `isoNow` helper in `src/t3code/server.ts` that
shadows the canonical `isoNow` exported from `src/orchestration/util.ts`.
This is a natural follow-up to `task-d1ab1125` (`sleep` → `sleepMs` dedup),
deferred from that task to keep its rename focused.

## Acceptance Criteria

- [ ] `src/t3code/server.ts` no longer defines a file-private `isoNow`
      function.
- [ ] The existing import from `../orchestration/util.ts` in
      `src/t3code/server.ts` includes `isoNow` alongside `setsidWrap` and
      `sleepMs`.
- [ ] All four existing `isoNow()` call sites inside `server.ts` continue
      to compile and behave identically (resolving to the canonical export).
- [ ] `bun run build` succeeds; existing tests pass with no other changes.
- [ ] No edits to `src/t3code/index.ts`, `src/sessions/sweep.ts`, or
      `src/sessions/sweep-state.ts` — those shadows are out of scope and
      tracked separately.

## Context

- Canonical symbol: `isoNow` exported from `src/orchestration/util.ts`:
  ```ts
  export function isoNow(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  ```
- `src/t3code/server.ts` currently:
  - Imports from the same module:
    `import { setsidWrap, sleepMs } from "../orchestration/util.ts";`
    (top of file, line 5).
  - Defines a file-private `function isoNow(): string` near the bottom of
    the file (anchor by body — line numbers drift). Its body is
    byte-identical to the canonical version.
  - Calls `isoNow()` from 4 sites: lock-content `acquiredAt`, the
    `t3codeStartingPath` write, the crash-log append, and the `startedAt`
    record field.
- Byte-identity of all five `isoNow` bodies in the repo was verified during
  elaboration; behavior is preserved by construction.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Extend the existing import in `src/t3code/server.ts`:
   ```ts
   import { isoNow, setsidWrap, sleepMs } from "../orchestration/util.ts";
   ```
   (Final ordering depends on the repo's import sorter; alphabetical is
   fine.)
2. Delete the file-private `function isoNow(): string { … }` definition
   near the bottom of `server.ts`.
3. Leave the 4 call sites untouched — they resolve transparently to the
   imported symbol.
4. Run `bun run build` and the existing test suite to confirm no
   regressions.

## Scope

**In scope:** `src/t3code/server.ts` only.

**Out of scope** (separate follow-up tasks):
- `src/t3code/index.ts` (also shadows `makeId`).
- `src/sessions/sweep.ts`.
- `src/sessions/sweep-state.ts`.

This narrow scope matches the retrospective recommendation that produced
this task and keeps the diff bisectable.

**Dependencies:** Relates to `task-d1ab1125` (already merged); no hard
ordering required.
