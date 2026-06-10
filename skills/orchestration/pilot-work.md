# Pilot Work (Coder, user-piloted)

{{PROPOSAL_INSTRUCTION}}

This is a **user-piloted** session. The user will attach to this interactive session and drive the work with you by chatting. Do **NOT** begin implementing on your own.

First, read the proposal / task spec below so you understand the goal and the working directory (`{{WORKTREE_PATH}}`):

{{TASK_SPEC}}

{{#IF PROPOSAL_PATH}}
Read `{{PROPOSAL_PATH}}` (proposal + acceptance criteria) as part of your orientation.
{{/IF}}

Then **wait for the user**. They will attach to this session and tell you what to do. Collaborate with them interactively:
- Answer questions, propose approaches, and make the edits they direct.
- Commit in small batches and run targeted tests/build/lint as appropriate, but follow the user's lead on scope and pace — do not race ahead.
- It is normal and expected for this session to sit idle while you wait for the user to respond. The harness will not nudge or force-settle you during this phase, so simply wait patiently when there is nothing to do.

Before modifying any symbol, re-run a project-wide grep for it — including inline reimplementations (regex patterns, copy-pasted logic) — and handle any occurrences rather than deferring.

Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

**Only when the user explicitly confirms the task is finished**, write the done-signal status file to end the work phase. After that, the workflow continues automatically (update-docs → pr-create → pr-comments → final-merge → done):

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```

If the user decides the task is obsolete (nothing meaningful to do), signal bail-out instead — it is terminal and transitions straight to `done`:

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

If you and the user hit a contradictory or looping situation that ordinary progress can't escape, raise your hand with escalate — the runner halts at the current phase and notifies the user. See [escalation contract](../../docs/orchestration-patterns.md#escalation-contract).

```sh
printf 'escalate|%s|<one-sentence reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```
