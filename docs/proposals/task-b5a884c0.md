# Proposal: Convention-based skill registration for queue actions

## Summary

Replace the ~160-line `resolveQueueRequestCommand()` switch in `src/mag.ts` with a
three-tier dispatch: (1) hardcoded special cases with pre-hooks or imperative logic,
(2) auto-discovered skill commands via frontmatter metadata in `skills/*.md`,
(3) fall-through for unknown actions. Adding a new queueable skill will require only
the template file -- no code change to `mag.ts`.

## Current state

`resolveQueueRequestCommand()` (lines 1065-1222 of `src/mag.ts`) maps 16 action
strings to skill commands or programmatic handlers via a switch statement. The cases
fall into three categories:

### Pure skill dispatches (no args, no hooks)
`suggest`, `health-check`, `learn`, `sync-learnings` -- return a bare `/ludics-<name>`.

### Skill dispatches with positional args
`elaborate`, `feedback-digest`, `draft-proposal`, `revise-proposal`, `split-task`,
`preempt`, `verify-completion`, `process-suggestions` -- extract fields from the
request object and interpolate them into the command string.

### Skill dispatches with pre-hooks
`briefing` calls `briefingPrecomputeContext()` before returning the command.
`adopt-sessions` calls `adoptSessionsPrecomputeContext()`.

### Programmatic-only (no skill command returned)
`message` -- regex-matches content against Launch/Abandon/Followup/Done patterns,
calls imperative functions, returns `null` or the raw content.
`adapter-followup` -- calls `launchSessionFromNotification()`, returns `null`.
`complete-task` -- calls `completeTaskFromNotification()`, returns `null`.

## Observations from codebase exploration

1. **Mixed frontmatter state**: Of the 14 auto-discoverable skills, only 4 currently
   have YAML frontmatter blocks (`ludics-elaborate`, `ludics-revise-proposal`,
   `ludics-process-suggestions`, `ludics-draft-proposal`). The remaining 10 start
   directly with `# /ludics-...`. Adding frontmatter to all 14 is safe -- Claude Code's
   skill loader already handles arbitrary frontmatter fields (it reads `name` and
   `description`, ignoring unknown keys).

2. **YAML parsing available**: The `yaml` package is already a dependency (used in
   `src/tasks/markdown.ts` via `import YAML from "yaml"`). The same `YAML.parse()` call
   can parse skill frontmatter.

3. **Arg patterns are simple**: The most complex case is `revise-proposal` with one
   required arg (`task`) and one optional arg (`feedback`). `preempt` has a default
   value (`autonomy` defaults to `"suggest"`). No skill has more than 2 positional args.

4. **`process-suggestions`** is present in the switch (line 1211) but was not listed in
   the task elaboration's table -- it should be included in the auto-discoverable set
   (14 total, not 13).

5. **Skills directory**: Located at `ludicsRoot() + "/skills/"`. The `ludicsRoot()`
   function in `src/config.ts` resolves the ludics package root. This is the correct
   base path for scanning.

## Plan

### Phase 1: Add frontmatter to all queueable skills

Add `queue-action` and (where applicable) `queue-args` / `queue-args-defaults` fields
to these 14 skill files:

| File | `queue-action` | `queue-args` | `queue-args-defaults` | Notes |
|------|---------------|-------------|----------------------|-------|
| `ludics-briefing.md` | `briefing` | -- | -- | **pre-hook** (stays hardcoded) |
| `ludics-suggest.md` | `suggest` | -- | -- | Needs frontmatter block added |
| `ludics-health-check.md` | `health-check` | -- | -- | Needs frontmatter block added |
| `ludics-learn.md` | `learn` | -- | -- | Has frontmatter, add fields |
| `ludics-sync-learnings.md` | `sync-learnings` | -- | -- | Needs frontmatter block added |
| `ludics-adopt-sessions.md` | `adopt-sessions` | -- | -- | **pre-hook** (stays hardcoded); needs frontmatter block |
| `ludics-elaborate.md` | `elaborate` | `[task]` | -- | Has frontmatter, add fields |
| `ludics-feedback-digest.md` | `feedback-digest` | `[repo]` | -- | Needs frontmatter block added |
| `ludics-draft-proposal.md` | `draft-proposal` | `[task]` | -- | Has frontmatter, add fields |
| `ludics-revise-proposal.md` | `revise-proposal` | `[task, feedback]` | -- | Has frontmatter, add fields; `feedback` omitted when empty |
| `ludics-split-task.md` | `split-task` | `[task]` | -- | Has frontmatter, add fields |
| `ludics-preempt.md` | `preempt` | `[task, autonomy]` | `{autonomy: "suggest"}` | Needs frontmatter block added |
| `ludics-verify-completion.md` | `verify-completion` | `[task]` | -- | Needs frontmatter block added |
| `ludics-process-suggestions.md` | `process-suggestions` | `[task]` | -- | Has frontmatter, add fields |

Example frontmatter for `ludics-preempt.md`:
```yaml
---
name: ludics-preempt
description: Priority project preemption
queue-action: preempt
queue-args:
  - task
  - autonomy
queue-args-defaults:
  autonomy: suggest
---
```

Example for `ludics-suggest.md` (currently has no frontmatter):
```yaml
---
name: ludics-suggest
description: Provide intelligent task suggestions
queue-action: suggest
---
```

### Phase 2: Create `src/skill-queue-registry.ts`

New module with ~60 lines:

```typescript
import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { ludicsRoot } from "./config.ts";
import YAML from "yaml";

interface SkillQueueEntry {
  command: string;          // e.g. "/ludics-elaborate"
  args: string[];           // e.g. ["task"]
  defaults: Record<string, string>;  // e.g. { autonomy: "suggest" }
}

let cache: Map<string, SkillQueueEntry> | null = null;

function buildRegistry(): Map<string, SkillQueueEntry> {
  const registry = new Map<string, SkillQueueEntry>();
  const skillsDir = join(ludicsRoot(), "skills");
  for (const file of readdirSync(skillsDir)) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(skillsDir, file), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const data = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
    const action = data["queue-action"];
    if (typeof action !== "string") continue;
    const name = String(data.name ?? basename(file, ".md"));
    const args = Array.isArray(data["queue-args"])
      ? (data["queue-args"] as string[])
      : [];
    const defaults: Record<string, string> = {};
    if (data["queue-args-defaults"] && typeof data["queue-args-defaults"] === "object") {
      for (const [k, v] of Object.entries(data["queue-args-defaults"] as Record<string, unknown>)) {
        defaults[k] = String(v);
      }
    }
    registry.set(action, { command: `/${name}`, args, defaults });
  }
  return registry;
}

export function resolveSkillCommand(
  action: string,
  request: Record<string, unknown>,
): string | null {
  if (!cache) cache = buildRegistry();
  const entry = cache.get(action);
  if (!entry) return null;
  const parts = [entry.command];
  for (const arg of entry.args) {
    const value = String(request[arg] ?? entry.defaults[arg] ?? "");
    if (value) parts.push(value);
  }
  return parts.join(" ");
}

export function clearSkillQueueCache(): void {
  cache = null;
}
```

Key design decisions:
- **Lazy singleton**: `buildRegistry()` runs once on first call, cached for process
  lifetime. Process restarts (which happen regularly) pick up new skills automatically.
- **Skip empty args**: When a request field is absent and has no default, it is omitted
  from the command string. This handles the `revise-proposal` optional `feedback` arg.
- **`clearSkillQueueCache()`**: Exported for tests only.

### Phase 3: Refactor `resolveQueueRequestCommand()`

The switch shrinks to ~40 lines:

```typescript
export async function resolveQueueRequestCommand(
  request: Record<string, unknown>,
  executeProgrammatic: boolean,
): Promise<string | null> {
  const action = String(request.action ?? "");

  // Tier 1: Special cases with pre-hooks or programmatic logic
  switch (action) {
    case "briefing":
      if (executeProgrammatic) await briefingPrecomputeContext();
      return resolveSkillCommand(action, request) ?? "/ludics-briefing";
    case "adopt-sessions":
      if (executeProgrammatic) adoptSessionsPrecomputeContext();
      return resolveSkillCommand(action, request) ?? "/ludics-adopt-sessions";
    case "message":
      // ... existing regex routing (unchanged) ...
    case "adapter-followup":
      // ... existing programmatic handler (unchanged) ...
    case "complete-task":
      // ... existing programmatic handler (unchanged) ...
  }

  // Tier 2: Auto-discovered skill commands
  const skillCommand = resolveSkillCommand(action, request);
  if (skillCommand) return skillCommand;

  // Tier 3: Unknown action
  if (executeProgrammatic) {
    console.error(`ludics: mag queue-pop: unknown action: ${action}`);
  }
  return null;
}
```

The `briefing` and `adopt-sessions` cases use `resolveSkillCommand()` for the command
string but keep the pre-hook calls inline. This means the frontmatter is the source of
truth for the command format, while the special imperative behavior stays in code.

### Phase 4: Tests in `src/skill-queue-registry.test.ts`

- **Frontmatter parsing**: Verify that skills with various arg configurations parse
  correctly.
- **Backward compatibility**: All 14 existing actions resolve to the same command
  strings as the current switch. Use the existing test structure from `mag.test.ts`
  (lines 108-190) as a reference.
- **Unknown actions**: Return `null`.
- **Default values**: `preempt` without explicit `autonomy` gets `"suggest"`.
- **Optional args**: `revise-proposal` without `feedback` omits the trailing arg.

### Phase 5: Update `mag.test.ts`

The existing `resolveQueueRequestCommand` backward-compat tests (lines 108-190 of
`mag.test.ts`) should continue to pass unchanged, since the external behavior is
identical. No test changes needed -- they serve as regression tests.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Frontmatter parsing breaks Claude Code's skill loader | Claude Code ignores unknown frontmatter fields; `queue-*` keys are inert to it |
| Arg ordering mismatch | All current skills have at most 2 args; ordering is explicitly declared in `queue-args` array |
| Skill file missing or corrupt frontmatter | `buildRegistry()` silently skips files without valid frontmatter -- same behavior as if the skill had no `queue-action` |
| `process-suggestions` missed in elaboration | Included in this proposal (14 total actions, not 13) |
| Pre-hook functions called out of order | Pre-hooks stay inline in the hardcoded switch cases, so execution order is unchanged |

## Scope and effort

- **14 skill files** need frontmatter additions (6 already have frontmatter blocks)
- **1 new file**: `src/skill-queue-registry.ts` (~60 lines)
- **1 file modified**: `src/mag.ts` (net reduction of ~100 lines from the switch)
- **1 new test file**: `src/skill-queue-registry.test.ts`
- **Estimated effort**: Small (2-3 hours of focused work)
