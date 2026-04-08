# Proposal: Post @codex review on PRs to trigger GitHub-native Codex PR review

## Summary

After PR creation, the orchestration runner posts `@codex review` as a PR comment to trigger the GitHub-native Codex review integration. This is additive to the existing t3code reviewer thread -- the Codex PR review provides a fresh-eyes pass focused on bugs and correctness, while the t3code reviewer handles spec adherence. No changes to skill templates, state schema, or the pr-comments polling logic are needed.

## Current state

### PR creation flow

When a PR is created during `pr-create` phase, `validateAgentPrFiles()` (runner.ts line 468) auto-detects the PR URL and stores it in `runtime.prUrl`. The phase then transitions to either `update-docs` or `pr-comments` depending on learning schedules and project configuration.

### pr-comments phase

`enterPhase()` initializes `pr-comments` with a 10-minute lookback (`state.phaseStartedAt - 600`) so comments posted during preceding phases are detected. `checkAndRedispatchPrComments()` polls GitHub every `prCommentsCheckInterval` seconds for new issue comments, review comments, and reviews. When new comments are found, agents are re-dispatched to address them. The phase transitions to `final-merge` after a quiet period (or immediately when the coder has responded to PR comments and all agents are done).

### Transitions to pr-comments

Three paths lead to `pr-comments`:
1. `pr-create` -> `pr-comments` (normal flow, `phases.ts` line 390)
2. `update-docs` -> `pr-comments` (when `hasAnyPr(state)`, `phases.ts` line 397)
3. `review` -> `pr-comments` (via `maybeOverrideTransition` when `update-docs` is skipped and `hasAnyPr`, runner.ts line 652)

### Project config auto-injection

`buildSkillContext()` in `skills.ts` (lines 288-296) auto-injects string fields from the project's `config.yaml` entry as `PROJECT_<FIELD>` template variables. Adding `codex_review_prompt` to a project entry would make `PROJECT_CODEX_REVIEW_PROMPT` available, but for this feature the prompt is used programmatically in the runner, not in templates.

### github.ts helpers

All GitHub interactions use `Bun.spawnSync` with `gh` CLI commands. Existing helpers: `fetchNewPrCommentCount`, `isPrMerged`, `validateAndFixPrFile`. The new `postCodexReviewComment` follows the same pattern.

## Plan

### 1. Add `postCodexReviewComment()` in `src/orchestration/github.ts`

```ts
export function postCodexReviewComment(
  prUrl: string,
  prompt?: string,
): boolean {
  const body = prompt
    ? `@codex review ${prompt}`
    : `@codex review Focus on bugs, correctness issues, and edge cases. Do not check adherence to a spec or plan.`;
  try {
    const result = Bun.spawnSync(
      ["gh", "pr", "comment", prUrl, "--body", body],
      { stdout: "ignore", stderr: "ignore", env: process.env as Record<string, string> },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
```

Returns `true` on success, `false` on failure. Follows the same `Bun.spawnSync` + `gh` pattern as all other helpers. The `try/catch` handles cases where `gh` is unavailable.

### 2. Call from `applyPhaseSideEffects()` in `src/orchestration/runner.ts`

Add a block that posts the review comment on any transition to `pr-comments`:

```ts
if (next === "pr-comments") {
  for (const agent of state.agents) {
    const prUrl = state.agentStates[agent.name]?.prUrl;
    if (prUrl) {
      // Read optional custom prompt from project config
      const cfg = loadConfigSync();
      const projectEntry = (cfg.projects ?? []).find((p: any) => {
        if (p.path) {
          const expanded = String(p.path).startsWith("~/")
            ? join(process.env.HOME ?? "", String(p.path).slice(2))
            : String(p.path);
          return state.projectDir.startsWith(expanded.replace(/\/+$/, ""));
        }
        return false;
      });
      const customPrompt = projectEntry?.codex_review_prompt ?? undefined;
      postCodexReviewComment(prUrl, customPrompt);
    }
  }
}
```

This fires on all three transition paths to `pr-comments` (from `pr-create`, `update-docs`, or `review`), because `applyPhaseSideEffects` is called for every transition. The comment posts before `pr-comments` phase entry, and the 10-minute lookback in `enterPhase` ensures the Codex review response is detected even if it arrives very quickly.

Import additions in runner.ts:
- Add `postCodexReviewComment` to the existing import from `./github.ts`
- Add `loadConfigSync` import from `../config.ts` (check if already imported)

### 3. Optional per-project prompt via `config.yaml`

Projects can override the default review prompt by adding a `codex_review_prompt` field:

```yaml
projects:
  - name: ocannl
    repo: ahrefs/ocannl
    codex_review_prompt: "Focus on memory safety and tensor shape mismatches."
```

No schema changes needed -- the field is read directly from the config object. Projects without this field get the default prompt.

### 4. No guard needed for missing Codex integration

The `@codex review` comment is harmless if no Codex GitHub app is installed -- it just appears as a regular PR comment. No feature flag or guard is required.

## Files changed

| File | Change |
|------|--------|
| `src/orchestration/github.ts` | Add `postCodexReviewComment()` function |
| `src/orchestration/runner.ts` | Add call in `applyPhaseSideEffects()`, add imports |

## Files unchanged (confirmed)

- `src/orchestration/state.ts` -- no new state fields
- `src/orchestration/phases.ts` -- no transition logic changes
- `skills/orchestration/pr-create.md` -- not a template change
- `skills/orchestration/pair-coder-pr-create.md` -- not a template change
- `skills/orchestration/pr-comments.md` -- pr-comments polling already handles Codex reviews

## Risks and mitigations

1. **Duplicate comments on re-runs**: If orchestration crashes and restarts, `applyPhaseSideEffects` could post a second `@codex review` comment. This is benign -- Codex would run a second review pass or ignore the duplicate. If this becomes noisy, a future improvement could check for an existing `@codex review` comment before posting.

2. **Rate limits**: Posting one comment per PR per orchestration run is well within GitHub API rate limits.

3. **Config lookup duplication**: The project config lookup in `applyPhaseSideEffects` duplicates logic from `buildSkillContext()`. This is a few lines and avoids adding a new shared utility for a single use site. If more call sites emerge, extract a `findProjectEntry(projectDir)` helper.

## Estimated effort

Small -- two functions, one import, no state changes. Roughly 30 lines of new code across two files.
