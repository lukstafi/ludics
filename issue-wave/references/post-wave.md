# Post-wave coordination

Read this at wave close-out when task chips use the default **post-wave coordination loop**.
This is a continuation under the same coordinator, not a new coordinator or a background task
chip. Preserve the selected provider/model, transport and execution constraints.

## Build the next task list

Finish the current wave's merges, integration checks, hand-backs and editorial pass first.
Deduplicate the proposals, file the ones that merit issues, and add evidence to existing issues
as usual. Then put every remaining chip through two gates, in this order, before it joins the
list. Run them against the issue tracker, which is not always the repository the PRs landed in
(`ahrefs/ocannl` for `lukstafi/ocannl-staging` PRs). After an interruption, re-read the target
issue or checklist and compare by content before writing to it; the reconciliation of SKILL.md's
*Stay alive, but design for dying* covers the rest.

1. **The tracker search.** Search the chip's title words and its key terms (the script,
   function or file it acts on, and the symptom's own wording). Open issues and recently closed
   ones are separate searches, so closed history cannot crowd an open match out of a capped
   list, and each runs once with the title words and once with the key terms (GitHub ANDs the
   words of one query); `<chain start>` is the date the wave chain's first wave began:

       gh issue list -R <tracker> --state open --limit 200 --json number,title \
         --search '<terms> in:title,body'
       gh issue list -R <tracker> --state closed --limit 200 --json number,title,stateReason \
         --search '<terms> in:title,body closed:>=<chain start>'

   A hit is a match only once its own record bears it out, read before acting on it:

       gh issue view <n> -R <tracker> \
         --json title,state,stateReason,body,comments,closedByPullRequestsReferences

   An open match turns the chip into "work this issue": the chip leaves the list, and its
   evidence goes onto that issue, `gh issue comment <n> -R <tracker> --body-file <file>`. A
   closed match whose record shows the chip's change landed (`stateReason` `COMPLETED`, with
   the closing PR or a closing comment naming it) drops the chip as done, unless the chip's
   evidence shows that change regressed or fell short: then it stays a chip and cites the
   issue. One closed `NOT_PLANNED` drops it too, unless the chip brings evidence its body and
   comments lack, which goes onto it as a comment the same way. (Wave 2026-10-14's third post-wave
   re-specified the open ludics-lite#568 as a chip; its worker noticed only after merging,
   and #568 was closed by hand.)
2. **The value floor.** A chip is below the floor when all three hold: it is test or tooling
   polish with no behaviour change; only one worker raised it (no recurrence across workers);
   and no hand-back reports worker time it would have saved. A chip below the floor gets no
   worker. It becomes a `- [ ] **<claim>** <one-line spec> (<source worker>, <source PR>)`
   item on the wave's follow-up checklist issue, one per wave and its post-waves, titled
   `<wave ID> small follow-ups` (the ahrefs/ocannl#1160 shape). The wave ID is the `wave` field
   every execution request of the wave already carries ([executions.md](executions.md), such
   as `wave-20261015`); a second wave started on the same day gives its requests a suffixed one
   (`wave-20261015b`). Reuse the exact-title hit whatever its state, reopening it if closed:

       gh issue list -R <tracker> --state all --json number,title,state \
         --search '"<wave ID> small follow-ups" in:title'
       gh issue create -R <tracker> --label wave-followup --title '<wave ID> small follow-ups' \
         --body-file <file>      # only when no hit has the exact title
       gh issue reopen <n> -R <tracker>   # only when the exact-title hit is closed
       gh issue view <n> -R <tracker> --json body --jq .body > <file>   # then append the items
       gh issue edit <n> -R <tracker> --body-file <file>

   The label is the one SKILL.md's *Close out* creates. (Wave 2026-10-14 ran five post-waves,
   17 -> 11 -> 8 -> 2 -> 3 tasks, the last ones mostly such polish, and filed about 47 follow-up
   issues.)

The next post-wave contains exactly the chips that passed both gates: the remaining
non-discarded follow-ups without their own issue. An item covered by a new or existing issue,
the checklist included, stays with that issue; do not pull it into the post-wave. Keep reasoned
drops out too. Do not reread the sequencing plan to refill this list, select unrelated backlog
work, or file placeholder issues merely to run these tasks.

Persist the task list and dispositions on the existing board before dispatch. Give each task
a stable local ID (for example `post-1-task-2`), repository, source worker/PR, grounding,
self-contained prompt and acceptance criteria. Preserve completed, issued (to a new or a
matched issue), checklisted and discarded dispositions across iterations and recovery so the
loop does not rediscover the same work.

The prompt is the spec itself, pasted from the draft with the source lines it acts on quoted,
never a pointer to a draft section: reaching a one-paragraph spec that way took workers three or
four file reads (2026-10-06). Check its premise against the tree before dispatch. A chip that
names a golden, a duplicate or a code path quotes the line it expects to change and says whether
that line exists today or only after the change (one worker hunted for a duplicate record that
only the change would create; two chips rested on a vectorized loop and golden lines the tree
did not have). A cause the source never reproduced is marked suspected, and a quoted word says
whether it is a name in the code or a description.

## Run another wave

Apply the regular scope, decision gate, launch, brief, supervision, integration and close-out
workflow to this explicit task list, with these adaptations for tasks without issues:

- Derive dependencies and execution placement from the task's actual requirements and its
  source hand-back. Summarize the next wave and proceed under the selected mode; use the
  existing decision gate for unresolved user-owned choices.
- Use one worker and worktree per task. The coordinator continues to sequence and supervise;
  it does not implement the chips itself. All lease, base, reservation and single-writer gates
  still apply, including the rival-PR check by topic before launch.
- Put the local task ID and full task text in the brief and board where an issue number and
  body would normally go. Record decision-gate recommendations and decisions there too; do
  not send `gh issue` calls or fabricate closing keywords for these tasks. Use the task ID in
  worker names and scratch paths; omit optional issue metadata in tools that provide it.
- Workers ship through `ship-pr` and report the result against their board task. A merged PR
  and verified hand-back close the task without an issue-closing comment. For non-code tasks,
  verify the specified deliverable instead. Workers run `after-merge` in hand-back mode for
  landed work, returning proposals to this coordinator without filing, spawning chips, or
  starting another wave themselves.

After each post-wave, perform the same editorial close-out and build the next list from its
eligible follow-ups. Continue recursively until that list is empty. There is no fixed number
of post-waves and no automatic sweep of the issues filed along the way.

## Close the loop

Keep the coordinator lease across post-waves; persist each completed wave and clean up its
workers/worktrees under the transport's normal ownership checks before the next wave starts.
Recovery reconciles the board, workers, reservations and PRs before resuming the recorded
iteration, just as for a regular wave.

If remaining work needs user input, an external dependency or unavailable execution capacity,
record that gate and continue independent tasks. If none can proceed, report the explicit
residuals and stop instead of repeatedly launching the same blocked work. Honor a user stop
or scope limit. The final report covers all iterations, landed work, filed issues, drops and
residuals; release the lease only after the usual accounting and cleanup are complete.
