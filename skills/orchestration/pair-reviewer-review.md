# Pair Review (Reviewer) — Round {{ROUND}}

Review the coder's implementation for `{{TASK_ID}}`. {{PROPOSAL_INSTRUCTION}}

If the PR touches documented-interface code (config types, CLI commands), check that the paired reference (`templates/config.reference.yaml`, README CLI Reference) was updated alongside — CI catches drift post-merge, but this round is the cheap place to catch it. See [CI drift files](../../docs/orchestration-patterns.md#ci-drift-files) for the known pairs.

Write your review to `{{REVIEW_FILE}}` — don't write it to a different filename, the orchestrator checks this path exactly. The first line is either `APPROVE` or `REQUEST_CHANGES`, followed by action items, then non-blocking observations.

If the implementation changes data shapes, check that helpers consuming the changed data were updated — shape changes break consumers silently (see [data-shape consumer sweep](../../docs/orchestration-patterns.md#data-shape-consumer-sweep)). For format-compat serializers, look for a round-trip fidelity test — see [round-trip serialization fidelity](../../docs/orchestration-patterns.md#round-trip-serialization-fidelity). Missing consumer updates or missing round-trip tests are blocking action items.

Before treating a failing test as blocking, cross-check the merged plan's `## Pre-existing test failures (baseline)` section — the point is to separate pre-existing noise from regressions introduced this round. See [pre-existing failures baseline](../../docs/orchestration-patterns.md#pre-existing-failures-baseline) for how to handle the cases where the baseline is absent, incomplete, or notes planning was skipped.

**Acceptance criteria verification.** Walk through each acceptance criterion and verify the implementation satisfies it. Treat any unmet criterion as a blocking action item listed explicitly in the review. Cross-check against the coder's `## AC Verification` entries in `{{PEER_SYNC_DIR}}/workflow-feedback-{{PEER_NAME}}.md`; a missing or hand-wavy entry is itself a blocker. Flag AC lines whose cited evidence exercises the capability but does not enforce the stated invariant (e.g. a CLI-path AC cited by an in-process call, or a serialization-handoff AC cited by a mere existence check) as blocking — this applies to non-test evidence too (a doc AC is satisfied by the structural property named, not by the file's mere existence). For each AC entry, also ask "what harness condition would I have to remove for this test to fail?" — if the answer is "none" or "the assertion itself," the test is vacuous on that AC line; flag as blocking. The check is verifying the harness condition the coder named in their AC verification line, not re-deriving it from scratch. See [harness instantiation](../../docs/orchestration-patterns.md#harness-instantiation).

{{#IF PROPOSAL_PATH}}
Re-read `{{PROPOSAL_PATH}}` for the authoritative acceptance criteria.
{{/IF}}
{{#IF TASK_AC}}
Task acceptance criteria from the task file:

{{TASK_AC}}
{{/IF}}

{{#IF PROPOSAL_PATH}}
**Scope review (discretion)**: AC is a floor, not a ceiling — see [scope: floor, not ceiling](../../docs/orchestration-patterns.md#scope-floor-not-ceiling) for the absorb/declare/reject boundary. Cross-reference the coder's changes against the proposal's `## Scope` section at `{{PROPOSAL_PATH}}`. Scope expansions are not automatic blockers — decide per-expansion using three tiers, not two:

- **Absorb silently** — small adjacent fixes that the change made obvious (typo, one-line type tightening, stale comment, dead-code drop in a file already being edited): a few lines, same file or sibling test, no new abstractions or imports, no new public surface. Accept without comment, or with a single acknowledgement line. Do not request a revert; one-line follow-up tasks for incidentals are exactly the proliferation we are avoiding.
- **Accept with note** — borderline expansions (roughly 10–20 lines, still same module, directly supports the goal). Note "scope: accepted" in the review body so the trail is visible.
- **Reject and ask for salvage** — only when the expansion is substantive enough that it would have warranted its own plan, or when it materially broadens the PR's review surface. In the review body, explicitly ask the coder to salvage the rejected diff into a needs-confirmation follow-up (capture patch → revert → new task with `relates_to`) before continuing. Do not just tell them to revert — that throws away useful work.

Before flagging apparent deletions as scope violations, cross-check with `git log main..HEAD --stat` (per-commit summary) and `git diff <commit>^..<commit> --stat`. Deletions that appear in `main..HEAD` but not in any per-commit diff are main-side drift from a stale branch; the remedy is rebase, not scope pushback. If you have already drafted `REQUEST_CHANGES` naming a file as a deletion or out-of-scope addition, run `git cat-file -e main:<path>` first — the file's continued presence on `main` is the smoking gun for stale-base drift, not for scope violation.

A missing `scope-expansion:` trailer is a discipline note, not a blocker — call it out in the review body when the expansion warranted declaration (declare-tier or reject-tier), but do not flag it for absorb-tier fixes. See [scope declaration and salvage](../../docs/orchestration-patterns.md#scope-declaration-and-salvage).
{{/IF}}

If the coder wrote a `bail-out` status and you agree the task is already resolved or obsolete (verify against the base branch), confirm the bail-out (see [bail-out contract](../../docs/orchestration-patterns.md#bail-out-contract)):

```sh
printf 'bail-out-confirmed|%s|<describe why you agree task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

If you disagree with the bail-out, write `REQUEST_CHANGES` in the review file and explain what's still needed.

If you believe the pair is stuck in a contradictory or looping situation that ordinary feedback can't break — e.g., the coder keeps reproducing a misread of your review, or the review contents haven't meaningfully changed across rounds on unchanged coder output — raise your hand with `bail-out: escalate`. Reviewer-side escalation is unilateral: the runner halts immediately without waiting for the coder to confirm. See [escalation contract](../../docs/orchestration-patterns.md#escalation-contract) for when to use it.

```sh
printf 'escalate|%s|<one-sentence reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
