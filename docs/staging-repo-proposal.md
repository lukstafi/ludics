# Proposal: Add `staging_repo` config field

## Summary

Add an optional `staging_repo` field to `ProjectConfig` so that projects whose PRs target a staging fork (rather than the upstream repo used for issue syncing) can make this explicit. The field is surfaced in PR creation skill templates so agents know where to push.

## Motivation

OCANNL uses `ahrefs/ocannl` as the upstream repo (for issue syncing via `tasks sync`), but PRs must target `lukstafi/ocannl-staging` where the Codex reviewer connector is configured. The local checkout is cloned from the staging fork, so `git remote -v` shows `lukstafi/ocannl-staging` while task files reference `ahrefs/ocannl`. This causes agent confusion. A `staging_repo` config field makes the relationship explicit and injects guidance into PR creation prompts.

## Implementation Plan

### 1. `src/config.ts` -- Add `staging_repo` to `ProjectConfig`

Add the optional field to the interface:

```ts
export interface ProjectConfig {
  name: string;
  repo: string;
  staging_repo?: string;   // <-- new
  path?: string;
  issues?: boolean;
  // ... rest unchanged
}
```

### 2. `src/orchestration/skills.ts` -- Plumb `staging_repo` into template substitution

**a) Add `stagingRepo` to `SkillContext`:**

```ts
export interface SkillContext {
  // ... existing fields ...
  stagingRepo: string | null;   // <-- new
}
```

**b) Resolve it in `buildSkillContext`:**

Look up the project config entry whose resolved path matches `state.projectDir` (or whose repo tail matches the directory name). Import `loadConfigSync` and `resolveProjectPath` from `../config.ts`.

```ts
import { harnessDir, ludicsRoot, loadConfigSync, resolveProjectPath } from "../config.ts";

// Inside buildSkillContext, after existing setup:
const cfg = loadConfigSync();
const projectEntry = (cfg.projects ?? []).find(p => {
  const resolved = resolveProjectPath(p.name);
  return resolved && state.projectDir.endsWith(resolved.replace(/^.*\//, ""));
});
const stagingRepo = projectEntry?.staging_repo ?? null;
```

Add to the returned `SkillContext`:

```ts
return {
  // ... existing fields ...
  stagingRepo,
};
```

**c) Add `STAGING_REPO` to the substitution map in `substituteTemplate`:**

```ts
STAGING_REPO: ctx.stagingRepo ?? "",
```

### 3. `skills/orchestration/pr-create.md` -- Mention staging fork

Add a conditional paragraph (the template engine replaces `{{STAGING_REPO}}` with empty string when unset, so the paragraph is inert for non-staging projects):

```md
# Create PR

{{#STAGING_REPO}}
> **Staging fork**: This project uses a staging fork (`{{STAGING_REPO}}`). Push and create the PR against the staging fork, not the upstream repo.
{{/STAGING_REPO}}

Push and create a PR from `{{WORKTREE_PATH}}`. Write **only the bare PR URL** to `{{PR_FILE}}`.
```

**However**, the current template engine (`substituteTemplate`) does not support conditional blocks (`{{#VAR}}...{{/VAR}}`). Rather than adding a mini-template engine, use a simpler approach: always include the staging note but make it empty when `STAGING_REPO` is blank. The cleanest minimal change:

Just prepend a line that naturally reads as a no-op when `STAGING_REPO` is empty:

```md
# Create PR

Push and create a PR from `{{WORKTREE_PATH}}`. Write **only the bare PR URL** to `{{PR_FILE}}`.
{{STAGING_REPO_NOTE}}
```

Where `STAGING_REPO_NOTE` is computed in `substituteTemplate`:

```ts
STAGING_REPO_NOTE: ctx.stagingRepo
  ? `> **Staging fork**: This project uses a staging fork (\`${ctx.stagingRepo}\`). Create the PR against the staging fork, not the upstream repo.`
  : "",
```

This keeps the template simple and avoids adding conditional block syntax.

### 4. `skills/orchestration/pair-coder-pr-create.md` -- Same change

Apply the identical `{{STAGING_REPO_NOTE}}` insertion.

### 5. `config.yaml` (harness) -- Add `staging_repo` to OCANNL entry

```yaml
projects:
  - name: OCANNL
    repo: ahrefs/ocannl
    staging_repo: lukstafi/ocannl-staging   # <-- new
    path: ~/ocannl
    issues: true
    milestones: true
```

### 6. `templates/config.reference.yaml` (if it exists) -- Add field for validation

Add `staging_repo` to the project entry in the reference config so that the config validator does not emit warnings. (The reference config file was not found in the current build, but if it exists at deploy time it needs this field.)

## Edge Cases and Considerations

- **No conditional template syntax needed**: Using a computed `STAGING_REPO_NOTE` variable avoids adding template engine complexity. The note is simply empty for projects without a staging fork.
- **Project lookup by path**: `resolveProjectPath` already handles `~/` expansion and fallback paths. Matching `state.projectDir` against resolved paths should work reliably.
- **No changes to issue syncing**: `repo` continues to be the authority for `tasks sync` and GitHub issue operations.
- **No changes to GitHub helpers**: `isPrMerged`, `fetchNewPrCommentCount`, `hasPrApprovalReaction` already parse the repo from the PR URL itself, so they naturally work with staging fork PRs.
- **`gh pr create` default remote**: When the local checkout is cloned from `lukstafi/ocannl-staging`, `gh pr create` will default to that fork -- so the agent just needs to not override it with `--repo ahrefs/ocannl`. The template note makes this explicit.

## Scope

Small change: ~15 lines of TypeScript, 2 template edits, 1 config line. No new dependencies. No migration needed.
