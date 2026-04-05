# Auto-fill adapter flags at slotStart

## Goal

Eliminate setup failures and reassignment churn caused by `slotStart()` throwing when a t3code/tmux adapter slot has empty orchestration flags. Instead of failing, `slotStart()` should auto-fill flags using `selectOrchestrationFlags()` based on the task's effort field, making the start path self-healing.

## Acceptance Criteria

1. When `slotStart()` detects a t3code or tmux adapter with empty `adapterArgs`, it calls `selectOrchestrationFlags(effort)` using the assigned task's `effort` frontmatter field (defaulting to `"small"` if missing).
2. The auto-filled flags are written back to the slot block's `Adapter Args` field in `slots.md` before proceeding with the adapter start action.
3. If the task file is missing or `selectOrchestrationFlags()` throws, `slotStart()` still throws a clear error message (no silent failures, no regression from current behavior).
4. `launchSessionFromNotification()` callers that pass empty `adapterArgs` now succeed via the auto-fill path (no empty-args setup failure).
5. Manual `slot assign` with explicit flags still works unchanged -- auto-fill only triggers when `adapterArgs` is empty/whitespace.
6. All existing tests pass.

## Context

### Root cause

Three code paths can reach `slotStart()` with empty adapter args:

1. **Mag agent manual CLI**: `ludics slot N assign <task> -a t3code` without `--pair`/`--coder`/`--reviewer` flags.
2. **`launchSessionFromNotification()`** (`src/mag.ts` line 964): receives empty `adapterArgs` default, passes it through `slotAssign()` then `slotStart()`.
3. **`maybeAutoStartSlots()`** (`src/mag.ts` line 1978): calls `slotStart(slotNum)` on slots that were assigned without flags (e.g., by task-d2155927's assign-without-adapter flow).

The automated fill path (`maybeFillEmptySlots` at `src/mag.ts` line 2364) is safe because it always calls `selectOrchestrationFlags()`. The validation at `slotStart()` line 668-675 catches the problem but doesn't fix it, leading to `markSlotSetupFailed()` and repeated retries.

### Key code locations

| File | Lines | Function | Role |
|------|-------|----------|------|
| `src/slots/index.ts` | 638-701 | `slotStart()` | Validates adapter args; will gain auto-fill logic |
| `src/slots/index.ts` | 140-252 | `slotAssign()` | Accepts adapter args, no validation (by design) |
| `src/adapters/t3code.ts` | 664-704 | `selectOrchestrationFlags()` | Auto-selects flags from task effort + config |
| `src/slots/index.ts` | 343-383 | `markSlotSetupFailed()` | Marks interrupted, resets task to ready |
| `src/mag.ts` | 964-1040 | `launchSessionFromNotification()` | Launches via `slotAssign` + `slotStart` |
| `src/mag.ts` | 1931-1979 | `maybeAutoStartSlots()` | Calls `slotStart()` on assigned-but-not-started slots |
| `src/mag.ts` | 2271-2397 | `maybeFillEmptySlots()` | Always uses `selectOrchestrationFlags()` (safe) |

### Existing infrastructure

- `selectOrchestrationFlags(effort)` in `src/adapters/t3code.ts` already encapsulates the full flag-selection logic: reads orchestration config, selects mode/coder/reviewer/phase flags based on effort size.
- `parseTaskFrontmatter` is already imported in `src/slots/index.ts` (line 14).
- `setField()` and `writeSlotFile()` are already used in `slotStart()` to update slot fields (lines 692-697).
- `taskFilePath()` is available for resolving the task file from `ctx.taskId`.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### 1. Auto-fill in `slotStart()` (src/slots/index.ts, around line 668)

Replace the current throw block:

```typescript
if ((ctx.mode === "t3code" || ctx.mode === "tmux") && !ctx.adapterArgs.trim()) {
  throw new Error(`slot ${slotNum}: ${ctx.mode} adapter requires orchestration flags...`);
}
```

With auto-fill logic:

```typescript
if ((ctx.mode === "t3code" || ctx.mode === "tmux") && !ctx.adapterArgs.trim()) {
  // Auto-fill orchestration flags from task effort
  const taskId = ctx.taskId;
  if (!taskId || taskId === "null") {
    throw new Error(`slot ${slotNum}: ${ctx.mode} adapter requires orchestration flags but no task is assigned`);
  }
  const tf = taskFilePath(taskId);
  if (!existsSync(tf)) {
    throw new Error(`slot ${slotNum}: ${ctx.mode} adapter requires orchestration flags but task file not found: ${tf}`);
  }
  const content = readFileSync(tf, "utf-8");
  const fm = parseTaskFrontmatter(content);
  const effort = String(fm.effort ?? "small").trim();

  const { selectOrchestrationFlags } = await import("../adapters/t3code.ts");
  const { args: autoArgs } = selectOrchestrationFlags(effort);

  if (!autoArgs.trim()) {
    throw new Error(`slot ${slotNum}: selectOrchestrationFlags returned empty args for effort="${effort}"`);
  }

  // Write back to slot block
  let updated = setField(block, "Adapter Args", autoArgs);
  if (updated !== block) {
    blocks.set(slotNum, updated);
    writeSlotFile(file, blocks, count);
    block = updated;  // refresh for subsequent reads
  }
  ctx.adapterArgs = autoArgs;

  console.error(`ludics: slot ${slotNum}: auto-filled adapter args from task effort="${effort}": ${autoArgs}`);
  journalAppend("slot", `Slot ${slotNum} auto-filled adapter args: ${autoArgs} (effort=${effort})`);
}
```

Note: `slotStart` must become `async` if not already (it is -- line 638). The dynamic import of `selectOrchestrationFlags` avoids a circular dependency between `slots/index.ts` and `adapters/t3code.ts`; if no circular dependency exists, a static import is cleaner.

### 2. Verify `launchSessionFromNotification` path

No changes needed in `launchSessionFromNotification` itself. It calls `slotAssign(slotNum, taskId, adapter, "", path, launchArgs)` with potentially empty `launchArgs`, then `slotStart(slotNum)`. The auto-fill in `slotStart` handles this case.

### 3. Verify `maybeAutoStartSlots` path

No changes needed. It calls `slotStart(slotNum)` which will now auto-fill.

## Scope

**In scope:**
- `src/slots/index.ts`: Replace throw with auto-fill logic in `slotStart()`
- Import or dynamic-import `selectOrchestrationFlags` from `src/adapters/t3code.ts`
- Journal/event logging for auto-fill actions

**Out of scope:**
- Changes to `slotAssign()` (by design, it accepts empty args)
- Changes to `maybeFillEmptySlots()` (already safe)
- Fallback adapter switching on repeated failure (deferred to follow-up if needed)
- CLI validation at assignment time (rejected per task-d2155927 design decision)
