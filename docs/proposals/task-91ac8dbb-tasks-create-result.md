# Proposal: Refactor tasksCreate to return a result object instead of printing to stdout

**Task:** task-91ac8dbb
**Date:** 2026-04-09

## Goal

Make `tasksCreate()` a pure data-returning function so programmatic callers get structured results and don't need stdout hacks. The CLI caller handles all user-facing output.

## Acceptance Criteria

- `tasksCreate()` returns `{ created: boolean; id: string; path: string }` instead of `void`
- `tasksCreate()` contains zero `console.log` calls
- The CLI `tasks create` subcommand in `runTasks()` prints the same output as before (file path and ID)
- The `process.stdout.write` redirect hack in `src/health.ts` (lines 131-139) is removed
- `src/health.ts` calls `tasksCreate()` directly without any stdout manipulation
- No behavior change for end users of `ludics tasks create`

## Context

`tasksCreate()` in `src/tasks/index.ts` (lines 72-132) currently prints to stdout via four `console.log` calls. This forces `src/health.ts` (lines 131-139) to use a brittle `process.stdout.write` redirect to prevent contaminating the hook's stdout protocol during programmatic task creation. The redirect is unsafe under concurrency since it mutates a global.

Two callers exist:
1. **CLI** (`runTasks`, line 626): should keep printing to stdout -- moved there
2. **health.ts** (line 136): programmatic caller that wants silent operation -- redirect removed

Related task: task-d0b61b6b (source retrospective).

## Approach

### 1. Change `tasksCreate` return type and remove prints (`src/tasks/index.ts`)

- Change signature from `void` to `{ created: boolean; id: string; path: string }`
- In the "already exists" branch (line 85-89): remove both `console.log` calls, return `{ created: false, id, path: file }`
- In the "created" branch (lines 128-131): remove both `console.log` calls, return `{ created: true, id, path: file }`

### 2. Update CLI caller (`src/tasks/index.ts`, `runTasks` case "create", line 626)

Replace the bare `tasksCreate(...)` call with:
```typescript
const result = tasksCreate(title, project, priority, usesBrowser);
if (result.created) {
  console.log(`Created task: ${result.path}`);
} else {
  console.log(`Task already exists: ${result.path}`);
}
console.log(`ID: ${result.id}`);
```

### 3. Remove stdout redirect hack (`src/health.ts`, lines 130-139)

Replace the `origWrite` / try-finally block with a direct call:
```typescript
tasksCreate(`Fix broken test suite: ${project.name}`, project.name, "A");
```
