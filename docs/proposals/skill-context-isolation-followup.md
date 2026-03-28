Remove the skill techdebt , implement refactoring suggestion (1) , implement the follow-up task: passing broader context

This is a follow-up to feature: skill-context-isolation

## Create a shared worker preamble instead of repeating boilerplate across 6 workers.

Every worker file repeats the same patterns: "Parse `$ARGUMENTS` to extract...", "Your final response MUST be a structured summary", the `STATUS:` / field format, and error handling conventions. A shared `skills/worker-conventions.md` supporting file (referenced via relative path from each worker's `SKILL.md`) would DRY this up and make the response contract enforceable from one place. Currently, if we want to change the structured response format (e.g., switch from `STATUS: completed` to JSON), we'd need to edit all 6 workers.

## Remove the techdebt skill

It is not triggered by any automation currently, and it would be polluting too much: risk of busy-work style tasks.

## Combine the ludics-sync-learnings and ludics-sync-learnings-worker back into a single skill

This orchestrator essentially just invokes the worker and writes result JSON — it doesn't read a task file or make strategic decisions. For these, Approach A from docs/proposals/skill-context-isolation.md (direct `context: fork` on the skill itself) might have been more appropriate than Approach B. The orchestrator/worker split adds value for `draft-proposal` (proceed/bail/split decision), `verify-completion` (slot clearing, follow-up creation), and `elaborate` (notification routing), but for techdebt and sync-learnings the orchestrator is ceremony without substance. Worth revisiting if the pattern feels heavy.

## Implement follow-up: passing broader context from Mag to workers

The forked workers are blind to Mag's conversation history, and for some that's a real loss. Analysis of which workers would benefit from a free-form "context brief" passed by the orchestrator:

### Workers that would benefit most — judgment-heavy

- **draft-proposal-worker**: Mag may know "the user prefers approach X for this project", "this task was discussed yesterday and the user wants a narrow scope", or "this relates to work just completed in slot 2". That context directly shapes the proposal's Motivation and Scope sections, and whether to flag something as stale or split-worthy.
- **elaborate-worker**: Cross-task awareness matters — Mag knows what other tasks exist, which are in-progress, and what recent decisions were made. Without that, the elaboration might suggest approaches that conflict with parallel work or repeat already-resolved questions.
- **verify-completion-worker**: Mag may have heard "I finished the core feature but skipped the edge cases" or "the criteria changed after we started". That shifts the verdict from uncertain to complete-with-followups.

### Workers that are largely context-free — processing-heavy

- **techdebt-worker**: Scans commits and greps for smells. The codebase is the input, not Mag's opinions.
- **feedback-digest-worker**: Clusters feedback files by theme. The feedback content drives everything.
- **sync-learnings-worker**: Groups corrections into memory files. Mostly mechanical.

### Implementation idea

The orchestrator could compose a short "context brief" (3-10 lines of free-form text) and pass it as an additional argument. The worker instructions would have a `## Broader Context` section explaining how to use it:

```
/ludics-draft-proposal-worker <task_id> <project_path> <context_brief>
```

Where `<context_brief>` might be:

> User wants narrow scope for this task. Related task-055 is in-progress in slot 3 working on the same module — avoid overlapping changes. User expressed preference for avoiding new dependencies.

The orchestrator is well-positioned to write this — it runs inline in Mag's context and can distill relevant bits. For the three context-free workers, the orchestrator would just pass an empty or minimal brief.

