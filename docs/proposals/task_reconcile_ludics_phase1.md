# Task: Reconcile for Ludics (Phase 1, Detection Only)

## Goal
Add `ludics reconcile --check` to detect drift between slots/tasks/sessions/Mag/federation state surfaces, without applying repairs.

## Scope
- New CLI command: `ludics reconcile --check`.
- Scoped checks via `--scope`.
- Human-readable report + `--json` output.
- Exit code semantics for non-interactive usage.

## Deliverables
- `ludics reconcile --check` command implemented.
- `ludics reconcile --check --scope <list>` support.
- `ludics reconcile --check --json` machine-readable output.
- Exit codes:
  - `0` no issues
  - `1` issues found
  - `64` invalid usage
- Deterministic issue keys and severities.

## Scopes and Checks (Phase 1)

### `slots`
1. `slots.active_path_missing`
   - slot marked active but directory path missing.
2. `slots.task_missing`
   - slot references non-existent task file.
3. `slots.task_status_mismatch`
   - slot/task status mismatch (`in-progress` vs task frontmatter).

### `tasks`
1. `tasks.duplicate_id`
   - duplicate task IDs in task files.
2. `tasks.blocked_by_missing`
   - dependency references non-existent task.
3. `tasks.frontmatter_parse_error`
   - task file parse failure.

### `sessions`
1. `sessions.slot_session_missing`
   - slot references session that discovery cannot find.
2. `sessions.unassigned_running_session`
   - running discovered session not mapped to any slot.
3. `sessions.registry_dangling`
   - dangling `.agent-sessions` links.

### `mag`
1. `mag.queue_invalid_jsonl`
   - malformed JSONL in `mag/queue.jsonl`.
2. `mag.queue_duplicate_request_id`
   - duplicate queue IDs.
3. `mag.result_orphaned`
   - result file with no matching request.

### `federation`
1. `federation.leader_stale`
   - leader references stale/missing heartbeat node.
2. `federation.heartbeat_stale`
   - heartbeat older than timeout.

## Files to Touch
- `src/index.ts` (register `reconcile` command + usage text)
- `src/reconcile.ts` (new module with checks/reporting)
- `docs/ARCHITECTURE.md` (CLI section update)
- `tests/` (new reconcile tests)

## Suggested Approach
1) Add `runReconcile(args)` in a new `src/reconcile.ts`.
2) Implement scope runners with shared `Issue` model.
3) Reuse existing readers:
   - slots/task frontmatter parsing
   - session discovery pipeline
   - Mag queue/result path conventions
   - federation state readers.
4) Implement report writers:
   - human summary + details
   - JSON schema-stable output.
5) Wire command in `src/index.ts` and update usage/docs.

## Dependencies
- Existing task parsing and flow utilities.
- Existing session discovery module (`src/sessions/`).
- Existing Mag queue layout (`mag/queue.jsonl`, `mag/results/`).
- Existing federation data layout.

## Validation
- Type/lint:
  - `bun run typecheck`
- Manual sanity:
  - Baseline clean run: `ludics reconcile --check`
  - Inject malformed queue line, verify `mag.queue_invalid_jsonl`
  - Create fake dangling `.agent-sessions` entry, verify detection
  - Break task dependency, verify `tasks.blocked_by_missing`
  - `--scope` and `--json` output checks.
- Exit codes:
  - Clean: `0`
  - Issues found: `1`
  - Bad flags: `64`

## Out of Scope
- `--fix-safe` and `--fix-aggressive`.
- Scheduled/triggered reconcile.
- Mutating state or auto-repair actions.

## Risks
- False positives from intentionally partial local state.
- Performance overhead on large task/session sets.

## Success Criteria
- Reconcile identifies common drift classes with low noise.
- Output is actionable for humans and script-friendly for automation.
