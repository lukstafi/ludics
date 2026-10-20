---
name: ship-pr
description: Land finished work — decide whether it goes straight to master or through a PR, then carry the PR through automated review to merge. Use whenever a coding task is complete and its changes are not yet landed, when asked to monitor or babysit a PR, and for multi-PR arcs where each phase lands separately. Do not use to land work that looks like it went down a wrong path — raise that with the user instead.
---

# Ship a PR through review

Covers: open -> monitor -> address -> merge. The step after merging is the `after-merge`
brainstorm, which turns the experience into the next cycle's issues; hand off to it rather than
ending at the merge.

Scoping (one goal per PR, one design move per commit) is the project's own convention — check
CLAUDE.md/AGENTS.md before splitting work differently.

`master` below stands for the repository's base branch. Where that is `main` (this repository,
for one), substitute it in the commands, and pass `--base main` to the cleanup helper at the end.

## Fire when the work is done, not when a PR is asked for

Reaching a finished goal with unlanded changes is itself the trigger; landing does not wait for
the user to ask for a PR. These are single-maintainer projects where churn is cheap and history is
not a museum, so the default at completion is to land and let review catch the rest — fail
forward.

Three things are not "done" in this sense: work that changed nothing (an investigation, a
question answered), a move that is one commit of a goal still in progress, and a goal the user has
already said how to land.

The exception that outranks fail-forward: when the work looks like it went **down a wrong path** —
the approach did not pan out, the fix papers over the design problem rather than solving it, tests
were bent to make it pass, or the goal drifted from what was asked — do not ship it and leave the
reviewer to find that out. Say what went wrong and what you would do differently, and let the user
redirect. Shipping is for work you would defend; a wrong path is a conversation.

## PR or direct commit?

Every PR here draws an automated review, so opening one and then skipping the monitor forfeits a
review rather than saving time — a PR opened for its review is never the "light" option. The light
option is landing on master directly, where the harness permits it (auto mode, below, does not),
and it is the right one when there is nothing to review: a typo, a comment, re-promoting a golden.
It waits for the user no more than a PR does — merging a PR into master is the larger act of the
two, however much the merge commit makes it the more visible one:

```bash
git fetch origin && git rebase origin/master   # a direct push has to fast-forward
git push origin HEAD:master
```

From a linked worktree push `HEAD:master` rather than checking master out — some checkout
holds that branch ("already used by worktree"). That is checked-out-branch protection, not `git
worktree lock`, and it does not reach the remote ref: `push HEAD:master` goes through. It does
leave the local `master` behind, and which command advances it depends on who has it checked out,
so look first (`git -C <main> worktree list --porcelain`, grep `branch refs/heads/master`). If NO
worktree has it out, the primary form is `git -C <main> fetch origin master:master`. If one does,
that fetch is refused, and the exact complement is `git -C <master-owner> merge --ff-only
origin/master` run in whichever worktree owns it — the main checkout only when the main checkout
is the owner. Either update it, or give every later branch an explicit start point (`git checkout
-b next origin/master`, `git worktree add -b next <path> origin/master`) — an omitted start point
takes the current HEAD, which from a stale checkout drops the commits just landed.

The trade is explicit: a direct commit gets no review at all. Anything carrying a design decision
goes through the full loop below.

**Under Claude Code's auto permission mode, a landing needs the user's cover.** The classifier's
`Merge Without Review` rule blocks merging before a human has approved (a bot's 👍 is not one),
and a refusal is dead time. The user's `autoMode.allow` settings cover one path, standing:
`pr-review.sh merge` (bare, `--wait[=<s>]` or `--require-green`) in lukstafi/ludics-lite and
lukstafi/ocannl-staging, for a PR whose head this session pushed — run it as in any mode.
Anything else — a direct push, `--override` or `--allow-no-verdict`, a bare `gh pr merge`, any
other repository — needs the user's go-ahead naming it: ask once, in the message that proposes
the landing, never after a refusal. For a change with nothing to review the cheapest form under
auto mode is a PR that merges on CI alone, with no `watch` round, run backgrounded:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh merge <owner>/<repo>#<pr> --wait
```

It reads the build signal and never the 👍 (where a go-ahead is needed, CI runs while the question
waits). It keeps the build gate the direct push skips; the push stays the lighter act where the user names that instead.

The `gh` recipes below are packaged as `~/.claude/skills/ship-pr/scripts/pr-review.sh` (`poll`,
`watch`, `status`, `checks`, `merge`, `base`, `reply`, `resolve`, `comment`, `body`, `retry`), which
encodes the traps in code — including the pagination that a PR running to many rounds walks into —
so prefer it to hand-rolled API calls. The commands below spell that path out in full because they
are run from a repo checkout, not from the skill directory.

**GitHub fails half the time, not none of the time.** During an incident (2026-08-17: an hour of
roughly every other call returning `503 No server is currently available`) a single attempt is a
coin flip, so the script retries every call — 4 tries, 5s doubling to 20s, on 5xx and that body,
never on a 4xx, on a GraphQL error no retry can change (a node or page limit, an unknown field, a
parse error, a `Could not resolve to …` NOT_FOUND), or on gh refusing a `retry` call's own arguments (an unknown flag or `--json` field:
exit 2, since nothing was sent). gh withholding an answer for its terminal escape sequences — a job's
log read without `--allow-escape-sequences` — is exit 2 too: re-sending it is withheld again, so add
the flag (and keep the raw log in a file). gh refusing an argument the script itself sends (a field or flag
a gh upgrade renamed) stops the command with exit 2 too: re-running cannot change it, so do not
re-arm; update gh or the script. Two rules follow, and they are worth holding even when you step outside the script.
Read its **exit codes**: `0` did it, `1` the fact does not hold, `2` your invocation is wrong (or
the installed gh refused the script's own), `3` the API never answered. And never restate a `3` as a finding — "no such thread", "no new activity",
"not approved" are claims about the PR, and an unanswered call supports none of them. That
conflation is not hypothetical: the pre-retry script reported `no review thread starts at comment
N` for three threads that existed, because its paginated GraphQL lookup had 503'd.

For the `gh` calls this skill makes outside the script — an ad-hoc `api` read, say — use
`pr-review.sh retry [--read] <gh args…>` rather than hand-rolling a
`for i in 1 2 3; do … && break; sleep; done` loop (which one outage session wrote five times).
Writes are retried only on gateway refusals, so a merge or a comment cannot be sent twice. Do not
route `gh pr comment` through `retry`, though: it is the one call that cannot take the
`owner/name#<pr>` argument this skill standardizes on (it wants a bare number plus `--repo`, or a
full URL), so it fails on the argument and invites hand-building a PR URL. Use `comment` below.

**Always name the repo in the PR argument: `owner/name#<pr>`, not a bare number.** This is not
advice any more: a bare number with no repo named is refused (exit 2). The script used to infer the
repo from the cwd, and a *background* shell does not reliably start in the checkout — `watch`, the
one invocation this skill tells you to background, is exactly where that bit. Worse, the failure
was not loud: every active repository has a PR 7, so the wrong checkout resolved to an unrelated
PR of that number and `reply`/`resolve`/`comment` wrote onto it (ludics-lite#92). Verifying the
guess does not help, which is why it is refused instead — `repos/<repo>/pulls/7` answers "this
repository has a seventh PR", not "this is the PR you meant". The refusal also bites evenly, where
the old inference did not: three `reply` calls in one message, the first two landing and the third
dying, was a partial success that read as success.

There is no per-PR repo cache any more either, and for the same reason: it remembered a repo by
*number*, across checkouts and across sessions, so once anything had named `repo-a#7`, a later bare
`reply 7` meant for repo B resolved to repo A — and verifying it passed, because repo A does still
have a PR 7. Name the repo in every call; nothing remembers it for you.

## Read the base before you branch

A branch inherits its base's breakage. When a `master` does not build, every later "is this my
change?" question gets expensive, and the answer is usually no — that is where the cost of a red
base actually lands, not in the ten hours it stays red. So read it before taking a branch off it:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh base <owner>/<repo> [branch]   # default branch if omitted
```

Exit **0** green, **1** RED (it says so in three shouted lines and names the run, the job that
failed and how far back the red runs go — the first red commit when a green run stands under the
streak, and otherwise that the red may start further back than the window shows), **3** the API did
not answer — which is not "green" — and **4** no verdict: no build workflow has ever completed on
that branch, or nothing has judged its tip (below).

On a **1**, do not start by branching and hoping. Open the run it names and decide which you are in:
the break is someone else's and already known (say so before you start, so the session's first
confusing build failure is not re-diagnosed from scratch), the break is *yours* from a previous
landing (fix that first — it is one commit and it unblocks everyone), or nobody has looked yet (this
is the case that costs the most, and reporting it is worth more than the task you were about to
start). What you must not do is spend the session bisecting a break you inherited.

A repository can give that third case an owner: a post-merge watch or triage routine that turns
a red into one claimed issue, named in the repository's agent notes. ludics-lite's
`.github/workflows/base-watch.yml` is one, running this same read after the base's push CI
completes and daily as a backstop, and other repositories call it as `base-watch-reusable.yml`.
Where an owner exists, a red found here is often already filed — check the open issues before
writing it up, and add what you know to the one that exists.

If this skill fires at the *end* of a task, as it usually does, this section is the one part of it
to have run at the beginning. A session that did not is still better off running `base` before it
branches for the follow-up work.

The verdict is about the last **completed** run that judged the branch, and `base` prints which
commit that run tested. It reads ten push runs per workflow, and a hundred when none of those ten
judged anything (ludics-lite#535); a hundred that judged nothing reads **no verdict**, exit 4, and
says the read stopped there. A
push a path filter skips produces no run at all, so the newest verdict can legitimately trail the
tip by several commits — a gap in coverage, not a stale reading, and the printed SHA tells them
apart.

A workflow whose file at the tip **no longer declares `push`** is the exception (ludics-lite#401).
Its last push run stands forever, so its verdict would be a stale reading, and `base` prints it as
`retired` history instead. The tip's verdict for such a workflow comes only
from a source the report names: an integration record concluded at exactly the tip (the wave gate
hands those in), or the head run of the PR the tip merged, under the roll-forward rule, when the
tip is GitHub's own merge commit of that head and the workflow itself ran green on it. A direct push, a squash or rebase merge, or a merge
made outside GitHub has neither, and reads **no verdict** (exit 4), never an older green. What
counts as "no longer runs on push" is narrow on purpose: its file at the tip was read and names no
`push` trigger. A workflow that still declares `push`, or whose file the reader refuses, reads as
it always did.

A tip whose own run is **in flight** over a window with no judged run reads **pending** — `NO
VERDICT YET`, exit 4 — not "never judged": the run that will judge it is running (ludics-lite#308).
A merge burst makes that window, and where push CI does not cancel a running run, it also leaves
runs at older merges going: one, with the tip's run pending behind it, where pushes share one group
(this repository's `main` since ludics-lite#597: a newer push replaces only a pending run, which
concludes `cancelled` and judges nothing, so a verdict covers a span of merges); several beside
the tip's where each push has its own. With `--interim` such a tip is green meanwhile when it is GitHub's clean merge of
a PR whose head built that workflow green and no run at an older commit is still in flight (that
run judges base changes the PR head may never have met); the verdict line says `green, interim`
and names its source. An integration record at the tip, which the wave gate hands in, is read
before the PR head (a `pass` is the interim's source, a `fail` the tip's red), and under the
gate's `--advisory-red` a merged head or older run going only on advisory jobs holds nothing
(issue-wave's *Base gate*). That is the wave gate's opt-in and the base watch's; it is never the tip's own verdict, so a
read that needs that (`base --wait` after a merge) does not pass it.

## Open

Look at the working tree first: commit what belongs to this goal, and say explicitly what you did
with anything that doesn't.

Whether to branch is a judgment call — reuse the topic branch you are already on. When you do need
a new one, take it from a *freshly fetched* base:

```bash
git fetch origin && git checkout -b claude/<topic> origin/master
```

In a worktree setup `git checkout master` fails whenever another worktree owns that branch
("already used by worktree"), and a stale local base silently reopens problems the base already
fixed. The `-b … origin/<base>` form
sidesteps both.

If the branch already has a PR, push to it and reuse it — never open a second one for the same
branch.

Before **every** push that touches code, run the gates the repository's CI judges the head by:
the formatter check if it has one — its AGENTS.md or CLAUDE.md names it — and in this repository, the skills repo, `scripts/preflight.sh`, which *is* CI's `lint`
job rather than a reconstruction of it (shell syntax, the mode bits, shellcheck at error
severity, the PowerShell parse, the parse guard and the prompt, jq-shape and scratch-directory
guards). Run with no step named, it also runs the small-guards suites a Markdown edit can break
(`test-check-prompts.sh`, and `test-sync-routines.sh` for `routines/`) whenever Markdown differs
from the merge base with `origin/main` (`--base <ref>` for another); `--guards all` runs every
suite of CI's small-guards job (ludics-lite#553). A push that CI reds on a syntax error or a lost mode bit costs a CI round and, since
automated reviews fire on every push, a review round — and after the reviewer has approved it
costs the approval too, which is the round ludics-lite#221 was filed for. A round's fixes are
exactly as able to break a gate as the first commit was, so the habit belongs on the push and not
on the branch.

Before the push that opens the PR, and only that one, review the branch locally: commit, then run
`codex exec review` once, with the transcript going to a log and only the verdict to a file:

```bash
d=$(mktemp -d); mb=$(git merge-base HEAD origin/<base>)
codex exec review -o "$d/verdict.md" "Review the code changes against the base branch origin/<base>, merge base $mb: inspect them with git diff $mb and give prioritized, actionable findings. Do not run tests, builds or suites: the author runs them, and a run in this sandbox proves nothing." >"$d/run.log" 2>&1; echo "$d"
```

The prompt names the base itself because `--base` refuses a custom prompt (`cannot be used with
'[PROMPT]'`, codex-cli 0.159), and the no-tests line has to be in it: left to itself the review
runs suites, in a sandbox that lacks tools (`ps`) and takes no run-time slot, so their failures
are not real and their load lands on your own runs (ludics-lite#609). Read `verdict.md`, not the
output: the transcript is the whole agent run, about a thousand lines, and the verdict is only
its last message. Open `run.log` only when `verdict.md` is empty. It runs for minutes, so give it
a long timeout or a background run. Fix the findings you agree with and commit, then run the
gates above on that commit — they gate the head you push, so they come after the local review, not before it. Name
each finding you dismiss, with the reason, in the PR body so the reviewer's first round does not
raise it again. Do not re-run it to a clean pass, and do not run it on later rounds: it gates
nothing, the reviewer's 👍 stays the review gate, and its job is to spend the first round's
findings before the reviewer sees the code. Where `codex` is missing or not logged in, skip it and
say so in the body.

Write the body as the reviewer's map, not a changelog: what is now true that was not, what the
tests pin, what changes for existing users, and where the risky corner is. Reviewers — human and
automated — spend their attention where the body sends it.

When the PR fully resolves a tracked issue, include `Closes #N` in its body. If the tracker
lives in another repository, use `Closes owner/repo#N`. For a partial phase of a multi-PR arc,
use a non-closing reference (`Refs #N` or `Refs owner/repo#N`); reserve the closing keyword for
the final PR that completes the issue. A closing keyword binds to every `#N` in the same
sentence, so "Resolves #194 and #205 §1" closed #205 too (PR #210, 2026-09-17; #205 had to be
reopened). A PR that only partially addresses a second issue references it in a separate
sentence with no keyword: "Addresses part 1 of #205". `pr-review.sh merge` reads the body
twice — once up front for lead time and once more immediately before the merge call, since a
body stays editable through a `--wait` and editing it moves no head — and warns on both streams, naming the sentence and every issue, when one
sentence carries a closing keyword and more than one `#N` or when a closing keyword sits in a
quoted (`> …`) or fenced line, where an example closes exactly as a statement does (that is how
#226's own body closed #205 a second time) — a warning and not a refusal, because one sentence
closing two issues is sometimes what was meant. Its two findings carry different weight on
purpose. A sentence where two or more `#N` FOLLOW the keyword is read off the text alone and says
outright what the merge closes — GitHub binds a keyword forward, to the references after it, so
"Issues #1 and #2 are now fixed." closes neither, while the advice above to keep any other
reference out of that sentence is the conservative form of the same rule; a quoted or fenced line is flagged to be READ and claims nothing about closing,
because telling an example from prose means classifying Markdown blocks and this is a best-effort
reading rather than a CommonMark parser — a list-relative fence, lazy blockquote continuation or an
unusual list marker can be misread in either direction. Its silence is likewise not a clean body:
an issue closed through a full URL, a four-space-indented code block, a sentence wrapped across a
line break with its references split over it, and a sentence split at an abbreviation period such
as `e.g.` are all unread by design.

The same holds for COMMIT MESSAGES: this repository merges with `--merge`, so the series lands on
the default branch, and a keyword in a message closes exactly as one in the body does — PR #274's
first commit quoted the incident sentence above as an illustration and would have closed both
issues again. Never quote a closing keyword with an issue number in a commit message. `merge` reads
the series after the build gate and before every merge attempt, for the head the merge is bound
to, since the series is relative to a base that can move without moving the head (the commits endpoint,
whole or not at all: over its 250-commit cap, or with rows that disagree with the PR's stated count
and head, it says the scan did NOT run), and applies the
body's rule to each message, naming the commit and the line. A message is not Markdown but plain
text GitHub reads whole, so a quoted, fenced or indented line is read there too and is reported as
closing, not as an example; a lone `Closes #N` stays silent, since that is how a commit really
closes the PR's own issue. It runs whatever the PR's base, because a commit keyword binds whenever
the commit reaches the default branch, and whatever the merge method: a `--squash` that replaces
the messages draws a warning about messages that will not land, since reading which squash does is
parsing `gh`'s flags. It warns and does not refuse: the fix is rewording the commit and
force-pushing, which moves the head, and a refusal would charge that on every deliberate close too.

Report the URL on its own line, wrapped as below. The Claude Desktop client renders a live status
card from the tag; other harnesses ignore it:

```
<pr-created>https://github.com/owner/repo/pull/123</pr-created>
```

When the tracker lives in a different repo from the PRs (a staging fork carrying PRs, upstream
carrying issues is a common pairing), comment on the tracking issue with what this PR does. On a
multi-PR arc that comment is what makes the phases legible later.

## Monitor

Poll for the review yourself. A repository with automatic reviews on starts its review
unrequested when a PR opens for review (a draft, once it is marked ready); what never arms on its
own is an observer. In the Claude Desktop
client, the `<pr-created>` tag renders a PR card, and the review-event feed behind that card is its
"Auto-fix CI & address comments" switch. Do not assume it is off: on ludics-lite#653
(2026-10-16) `mcp__ccd_pr__get_status` read `auto_fix: true` right after `gh pr create`, in a
session whose app setting "Auto-fix pull requests" was on; elsewhere a PR opened with the tag and
no other setup drew a review no event announced. `get_status` reports the switch. A PR an
issue wave owns (a worker's, or its coordinator's) follows issue-wave's
[native-claude.md](../issue-wave/references/native-claude.md#auto-fix-events-on-worker-prs),
which says whose word turns it off and who makes the call. If
review events do arrive and carry the comment bodies and ids inline, take them as they come and
stop polling for what they delivered.

Never end a turn with a PR in flight and nothing that will wake you. Under Claude Code, run `watch`
with Bash `run_in_background: true` and yield; the completion notification is the wake. Under Codex
a finished background command does not resume the agent: keep the turn open and poll the command
session until `watch` exits, or, for a wait too long to hold open, schedule a heartbeat that
re-runs both `status` and watermark-aware `poll` (or a bounded `watch`). A backgrounded shell
nobody is polling is not an observer. A Claude Code session that the notification does not wake
(a native issue-wave worker, whose turn must stay open, or a one-shot headless `claude -p` one,
whose turn's end kills its background tasks) runs `watch` and `merge --wait` under issue-wave's
`bg-run.sh spawn` and blocks on `bg-run.sh wait` in the same turn, as
[Blocking on a run](../issue-wave/references/native-claude.md#blocking-on-a-run) says. To stop a
spawned `merge --wait` (a pause, or "do not merge"), run
`~/.claude/skills/issue-wave/scripts/bg-run.sh stop <dir>`; a `wait` there then reads `STOPPED`,
which is never re-armed. A merge already inside its merge call may still land, so re-read the PR's
state after (that section is the verb's contract).

`watch` *is* the polling loop — don't hand-roll a sleep loop around `poll`, which is what a long
review otherwise turns into. It returns the moment a round lands (printing exactly what `poll`
would), the approval arrives, or it can tell that no review is coming; exits 1 having stayed quiet;
and ends on a watermark either way:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh watch <owner>/<repo>#<pr> [watermark]  # background it
~/.claude/skills/ship-pr/scripts/pr-review.sh poll <owner>/<repo>#<pr> [watermark]   # one shot
```

A live 👀 at the quiet-window deadline extends the watch until at most
`SHIP_PR_REVIEW_GRACE` after that reaction started. The first extension fixes the deadline;
more reactions cannot renew it. When you post a plain `@codex review` nudge, arm the next
watch with the last watch's watermark. That newly observed comment buys one bounded grace
window measured from its creation time (the `comment` helper's automation footer is accepted).
That window also extends past the ordinary timeout until the nudge's grace expires, including
when the nudge follows a failed or stalled review. A temporary unreadable status retains the
last healthy deadline; it cannot renew it. When pickup becomes an active review, the deadline
hands off once to that review's eyes-start grace, then stays fixed. Quiet exits report the
extended elapsed duration. The observer treats older review results as preceding that explicit
request. An approval newer than the nudge settles the status immediately; queued actionable
findings are still surfaced with that approved status. Unreadable status reads
leave newly seen nudge identities pending instead of consuming their grace.
The outgoing watermark consumes the nudge identity, so carrying it into another watch does
not buy fresh grace. Comments arriving after the extension was fixed remain pending for the
next observer, so a later request cannot renew this window or lose its own opportunity to be
observed. Ordinary replies and edits reset nothing.

Its default window (15 min; `WATCH_INTERVAL`/`WATCH_TIMEOUT` retune it; the polling budget below
sets its pause) outlasts a foreground tool's timeout, which is why it is backgrounded. Spell the repo out, as above: a background shell
does not reliably start in the checkout.

**Never pipe a gate command** — `watch`, `poll`, `checks`, `base`, `merge` — through `tail`, `head`
or anything else: the pipeline reports the LAST command's status, so the script's exit code (2 for
a usage error, 1 for red, 3 transport, 4 no verdict) is replaced by the pager's 0, and the harness
then reports a clean exit for a call that never ran. On 2026-09-01 a `checks 587 --repo …` — wrong
option, `checks` takes the repo through `REPO=` — died on stderr and the run was recorded as
exit 0, which reads exactly like a passing build gate. Let these commands write straight to the
output file, where the message is anyway.

Read its exit code, which is three-valued: **0** = act on what it printed; **1** = the window
passed quietly, so hand the watermark it printed to the next `watch` and keep working meanwhile;
**3** = it did not read the PR (API trouble), which is *not* quiet — nothing was observed, so
re-arm rather than concluding the reviewer is silent. A window whose *last* polls failed exits 3
too, even after healthy rounds earlier: the round you are waiting for could be sitting in the part
of the window that was never read.

**What ends the wait is a round about the head you are watching**, and nothing else. Every item
`poll` renders is stamped with the commit it is about — `commit=<sha7>`, from a review's
`commit_id`, an inline comment's `original_commit_id` (GitHub migrates `commit_id` forward as the
branch advances, so it would name your current head for a finding written against the last one) or
a comment's `Reviewed commit:` stamp, taken from the FOOTER a body may quote another commit above
— and `watch` compares that to the head it reads after each poll. It compares the machine-readable
`items:` line `poll` ends with, never the rendered headers: a reviewer body can carry a line that
looks exactly like one (a review quoting this script's output does), and a watch that scanned the
rendering would take the quotation for an item. **Inline threads at one anchor render as one entry.** The connector posts one finding as several
threads often enough to matter — round 11 of #66 posted nine threads for four findings — and it
duplicates by RE-WRITING, so the copies share their location exactly and share no byte of their
text. So threads at the same anchor (path, commit, author, and every location field the row
carries) fold into a single entry whose id field lists every thread, with every *distinct* body
under the id of the thread carrying it:

```
--- inline id=900+901+902 a.sh:447 commit=252e336 by codex[bot] (3 threads at one location, 3 findings as written; one reply answers all)
[thread 900]
…
```

Read every body — a folded entry can carry more than one finding — and answer once: that id token
is what `reply` and `resolve` take. The `path:line` after the id is the anchor as the feed served
it: a line number when there is one, `@12` when the row carries only a diff *position* (the rows
poll reads from the per-review endpoint while the flat feed lags carry no line at all), and `?`
when it names no place in the file. Two entries showing `@12` and `@40` are two places, the same
as `:12` and `:40` would be. The anchor is the WHOLE anchor: `a.sh:36-40` is a multi-line comment,
`side=LEFT` after it is the deletion side of the diff (`RIGHT` is where every other finding is and
prints nothing), `start_side=LEFT` is a range that starts on the deletion side and ends on the
addition side, and `was=30-34` is where the reviewer wrote a finding GitHub has since migrated
forward (`was=@9` on a row anchored by a diff position rather than by a line). Those fields are what keeps two entries apart in the fold, so two entries that differ
only by one of them say so on the line rather than reading as one finding posted twice — a
correct non-fold must not look like a broken one. A folded entry is still one finding for the loop: the round
count and the watch's act/quiet decision are unchanged, and every folded id is still advanced past
by the watermark.

Reviewer activity about some other commit is a *previous* round scrolling past above the
watermark: it is printed on stderr for the record, the watermark advances past it so it never
comes back, and the window keeps waiting. That is the shape this repository hit — one window
exited on a round's inline findings, the reviewer's separate summary review landed seconds later
with a higher id, and the next window woke on it at once with nothing to do. Moving past a finding
is not closing it, though: a scrolled-past finding whose thread is still open keeps an approval
from reading clean (`unresolved`, below) and keeps `merge` refusing.

So read the line each exit ends on, which now says what it ended *on*: the item's own descriptor
(`ending the wait on review id=… state=… commit=… by … — this window opened round 3 of 12`,
by the count `rounds` reports, so cite that number rather than one you kept) when a round ended
it, and the head the
silence was about plus how much scrolled past (`no reviewer activity about head abc1234 in 900s;
2 item(s) about another commit scrolled past …`) when nothing did. "The reviewer answered this
head" and "an old review went by" are different windows and read differently.

**The watch's printout is not the record of the round.** A long round's output is cut by the Bash
tool's display (the head goes, the tail stays), and on 2026-08-22 two agents answered half a round
that way, both times dropping real findings. After any exit 0, enumerate the round's findings
yourself from the feeds, by id above the watermark you PASSED IN — `watch` prints the advanced one
back, and ids above that are the next round's (`status`, or the comment APIs) — and address
THAT list; cross-check the count against what the watch claimed before replying/resolving.
`poll` folds the connector's fixed "About Codex in GitHub" block at a body's tail into one
`[Codex "About Codex in GitHub" boilerplate folded]` line; nothing else is folded.

On every exit 0 but an approval, `watch` also prints (on stderr, so a round's stdout stays
poll's) the base-drift read that `merge` otherwise makes last: how many commits behind its base
the branch is, the file overlap with the base's advance — split into paths whose hunks MEET
(the same regions edited on both sides) and paths changed in DISJOINT hunks only (a sibling's
appended stanza; nothing to act on) — and whether the PR CONFLICTS. That is the moment it is
cheap to act on — the round's fixes are about to be written. "CONFLICTS" means merge the base in
*first*, so the next push is one CI can test; an overlap, same-region or not, is information only.
*How stale the base has grown* (below) is the rule for both. Read only at merge time, the same
information arrives after every round has been paid for.

An exit 0 is not always a round: `watch` also returns when it can tell that **nothing is coming** —
the 👀 went spent without a review of the head, or never landed, or a push has been sitting
unreviewed past the grace (20 min, `SHIP_PR_REVIEW_GRACE`), or the reviewer said outright that it
could not start (`failed`, below, which exits at once rather than holding the grace — except on a
first Failed summary row, which `watch` re-requests itself and waits on).

**The watch nudges for you, once per head** (ludics-lite#570). When the head is `expected` — a 👀
round ended without reviewing it (a push landed during the round, so the round was the old head's),
or it has no 👀 past the grace — and nothing stands for it (no review, no verdict, no 👍, no
Completed row, and no `@codex review` on the PR since the head arrived, a hand nudge included),
`watch` posts a plain top-level `@codex review` itself and keeps watching that request's grace, so
the window ends on the head's round. It holds the nudge until it has itself seen the head for five
minutes with nothing started (a commit's date is not its push, so an old-dated push reads as
overdue the moment it lands), and while a request on the head is younger than its grace; it never
nudges a draft or a PR that conflicts with its base. The request on the PR is the once-per-head
record: a re-armed watch reads it and posts no second one. If the nudge draws nothing, or a request
already stood past its grace, the line says so and names the next move: read the feed, then push a
new head (an amend suffices) or hand it to the maintainer. A nudge posted on a thumbs-up for the head would clear it, and these
reads are what rule that out; they are the same final poll and state re-read below. Pass
`--no-nudge` (`watch <pr> [watermark] --no-nudge`) to post nothing, the failed run's re-request
included: the line then names the remedy, a plain `pr-review.sh comment <owner>/<repo>#<pr>
'@codex review'`, and it is yours to post. Read the remedy off the line rather than from this
paragraph when the two differ: on `failed` the nudge is the first move and not the only one — if
the SAME head fails to initialize again, the next move is a new head, because the reviewer's clone
is what is behind.

Every one of those verdicts polls once more before it prints, and re-reads the state behind that
poll. A round found by the last look wins; a 👍 that landed in the same gap is reported as the
approval it is (`poll` reads comments and reviews, and the 👍 is on neither); a state that moved
some other way makes the window a quiet **1**; and a poll or state read that did not answer
WITHHOLDS the verdict for a **3**. The seconds a state read takes are exactly when a round lands,
and a nudge posted over one re-requests the review and CLEARS the 👍 it was about to get. The grace itself is measured from
the newest of the head commit's date and the PR's *creation* — the push time is not an API field,
and a commit's date can predate by hours the push that delivered it, so on a freshly opened PR the
committer date alone once reported a review "due for 22m" and recommended a nudge at a reviewer
that had had no time at all.

Hand-rolling that query has produced seven false readings, all of which the script handles: app
reviewers' logins carry a `[bot]` suffix so an exact-match filter never fires; your own replies
bump both counts — and are themselves recorded as `COMMENTED` reviews — so "new" must mean an id
above a watermark, not a delta; the three feeds number their items in SEPARATE id spaces, so one
shared watermark takes the max from the reviews feed and then hides every inline finding — the
dangerous one, because it looks exactly like the reviewer going quiet; the comment APIs paginate
at 30; `[ "$n" -gt 0 ]` on empty output aborts the watcher mid-run; a failed request renders
as the same empty list as a quiet feed, so an outage reads as "no findings, no approval" unless
the two are kept apart; and a 👀 reaction is a LEVEL that the app does not always take back, so
reading it as "a review is running" waits on a round that already finished.

## Address a round

Read *every* finding before changing anything. Rounds have shape: the early ones tend to hit
analysis and correctness, the later ones robustness and reproducibility, and treating a late
finding as if it were isolated is what makes review loops long.

Judge each finding on the merits. Most are right; some are not, and a wrong one deserves a
reasoned reply rather than a compliance edit — a design boundary you hold deliberately (what a
component is *not* responsible for) is worth defending in the thread, in the terms of the design. A
round you answer entirely with reasoning needs no push: reply, then merge — that is one of the
loop's two exits (*When the loop ends*, below).

Before a review fix broadens the design or removes supported behavior, reread the original
issue's acceptance goal. Separate defects the change introduces or materially worsens from
pre-existing defects the work merely exposes. Do not turn a bounded correction into a promise of
complete coverage, then disable working paths to make that stronger promise true. Preserve the requested behavior,
narrow an overstated contract, and record a justified out-of-scope limitation in a focused
follow-up with a reply linking the evidence. Apply the blocking criteria in *When the loop ends*
after round twelve; discovering a severe existing defect does not itself meet them. In a wave,
surface the scope decision to the coordinator before implementing it, rather than waiting for
the late-round threshold.

**When findings arrive in a family, fix the genre, not the instance.** This is the single biggest
lever on how long the loop runs. If round N says "pin knob X" and round N+1 says "pin knob Y", a
third knob exists; close the whole class instead — sweep the ambient variables categorically,
delete a duplicated command so it cannot drift from its source, derive a value instead of
restating it. Then say in the reply that the class is closed and why, so the reviewer can check the
reasoning rather than re-find members.

Land each round as one commit whose message names the findings it answers and their severity, in
the reviewer's own terms:

```
Review fixes round 3: repro commands pinned, keep-fraction pin, exact provenance

- P1: <the finding, then what changed and why that is the right fix>
- P2: <…>
```

The history then reads as a dialogue, which is what a reviewer (or a future archaeologist) needs.

Run the formatter check (*Open*, above) if this round touched code, push, then close out each
thread — silent fixes leave the reviewer re-deriving what you did:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh reply <owner>/<repo>#<pr> <comment-id> "Fixed in round N (<sha>, \"<commit subject>\"): <substance>"
~/.claude/skills/ship-pr/scripts/pr-review.sh resolve <owner>/<repo>#<pr> <comment-id>
```

The comment id is the token `poll` rendered. Where that was a folded entry — `id=900+901+902`,
one location the reviewer posted several threads at — paste it back whole: one `reply` posts your
answer to the first thread and a one-line pointer to it into each duplicate, and one `resolve`
closes them all. Compose the answer once, covering every body the entry printed.

If such a `reply` fails part-way, the refusal names the retry, and it is not the plain remainder:
`reply <pr> 901+902 --anchor 900` posts no body at all and points those threads at the answer
already standing in 900. Handing back the bare suffix would promote 901 to anchor, post your
answer there a second time and point 902 at the copy.

Cite the round and the commit's subject, not the sha alone. A branch rebased before it merges —
onto a base that moved, or to resolve a conflict — rewrites every commit, and a reply that says
only `Fixed in d2bacbc7c` then resolves nowhere in the merged history (staging#633: 27 rounds of
replies, every sha dead after the rebase, and the next session mapped them back by subject with
`git log --grep='Review fixes round N:'`). The `Review fixes round N: <subject>` convention
survives the rebase, so the round and the subject are the durable citation and the sha is the
convenience. If you do rebase after replies were posted, one PR comment mapping the old ids to
the merged ones (`comment`, below) keeps the threads readable as the audit trail the record
paragraph points the maintainer at.

Check every call in such a batch, not just the last: these are independent invocations, and one
failing while its neighbours succeed leaves a thread silently unanswered. A `reply` that exits 3
posted nothing (the gateway refused it) — repeat it; a `resolve` that exits 3 found the thread and
failed to close it, so repeating that is safe too. Only exit 1 from `resolve` means the thread is
really not there. A `reply` over a *folded* token is the one batch the script makes itself, and it
is the one place that rule needs care: if it fails after the anchor's reply landed, the refusal
says so and names the ids that did not get one — retry with **those**, not with the whole token,
or the answer is posted twice.

**A finding without a comment id has no thread to reply in — answer it with `comment`.** A review's
summary body (the `--- review id=… state=…` block a round prints, and the `--- summary id=…` one)
carries findings that were never attached to a line, so there is nothing to `reply` to and nothing
to `resolve`; the same is true of the `@codex review` nudge the watch verdicts recommend. Both are
plain PR comments:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh comment <owner>/<repo>#<pr> "Round 3, on the summary: <substance>"
```

Do not reach for `gh pr comment` here, with or without `retry` — it rejects the `owner/repo#<pr>`
form, and the workaround it invites (hand-building the PR's URL) is how a release-prep session on
`lukstafi/ocannl-staging#475` spent its retries on argument parsing. `comment` takes the same
argument as every other subcommand and posts through the same write policy: exit 0 posted (it
prints the comment's URL), 1 the API rejected it, 2 your invocation is wrong — note the body is
**one** argument, so quote it — and 3 nothing was posted, or nothing is known, so re-read the PR
before repeating it.

**Never write the connector's handle in a `reply` or `comment` body.** Any `@codex` in a body is an
instruction to the connector, quoted or not: a rebuttal on ludics-lite#465 that quoted the nudge
summoned it into the thread, where it answered with its environment reply. Both commands refuse
such a body with exit 2 and post nothing. The bare `comment <pr> '@codex review'` nudge is the one
body that passes. Rephrase the rest ("the codex review nudge"). `--allow-mention` is for a mention
you really mean.

**Edit the PR body with `body`, not `gh pr edit`.** Rewriting the description — the review-record
paragraph of a close-out, a closing sentence `merge` warned about — goes through REST from a file:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh body <owner>/<repo>#<pr> <file>
```

`gh pr edit --body-file` rides GraphQL and fails on `lukstafi/ocannl-staging` with the classic
Projects deprecation error whatever is edited. `body` replaces the description whole, with the
same exits as `comment`. Because the PATCH sets the body rather than adding to anything, `body`
repeats an ambiguous failure itself on the backoff (a 5xx, or gh's bare `unexpected end of JSON
input` when GitHub's answer has no readable body), and an exit 3 that outlives the attempts is
safe to re-run as is.

If a finding changes what a measurement *means* (not just how it is run), redo the affected
measurement rather than editing the prose around it; and if a result rests on a premise the
review invalidated, say so in the artifact instead of quietly dropping it.

## Converge and merge

Two gates stand between a finished round and `master`: the reviewer's approval and the build
signal. This section is the first; the build gate is below, and neither substitutes for the other.
The review gate has one narrowly scoped alternative to the approval itself — the close-out record
of *When the loop ends* (below), at one of the loop's two exits — and nothing stands in for the
build gate.

The review gate is the reviewer's approval — for the Codex integration, a 👍 reaction on the PR,
not a review state. The two channels are disjoint: a round WITH findings posts `COMMENTED` reviews
— one carrying each inline comment, plus one summary — and no reaction, while a clean round posts no
review at all and only the reaction. So a string of `COMMENTED` reviews is neither rejection nor
sign-off, and their absence after a push is the approval, not silence. The app does not always
put the 👍 up (ludics-lite#439: ocannl-staging#828's clean round left only its 👀, and `status`
read `stalled` and recommended the nudge that clears approvals), so `status` also reads a clean
round off the summary comment: its newest Code Review row, in exactly the `✅ **Completed**` shape
the app writes, naming the head, newer than the 👀, with the reviewer silent since that 👀. A
findings round submits its review seconds before that row flips, which is why the test is "nothing
since the 👀" and not "nothing since the row"; any other row shape, or no 👀 to bound the round,
reads as it did without the row. A clean round can also leave neither 👍 nor 👀 (ludics-lite#702:
PRs #677 and #690 read EXPECTED, and `watch` advised the nudge). Then the summary's hidden
`<!-- codex-review-state:v1 {...} -->` record decides. It is read whole, fail-closed on any other
shape. It approves when its `code_review` names the head's full SHA, is `completed` with
`has_unresolved_findings: false`, and agrees with the Completed row above, which dates it (the
comment's own edit time moves with any edit). Anything posted after that time outranks it,
including a 👀, and so does any finding about this head, whenever it was posted.

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh status <owner>/<repo>#<pr>
```

The 👀 reaction is the one signal you cannot read on its own. It is a level, not an event, and the
app does not reliably take it back: on #364 a 👀 outlived the review it announced by an hour, and
three consecutive 15-minute windows reported "reviewing — wait it out" over a PR nothing was
reading. So `status` crosses the reactions with what the reviewer has actually posted and with the
head SHA, and answers with one of eight:

| state | means | what to do |
| --- | --- | --- |
| `approved` | 👍 is on the PR and was given for this head, with no newer current-head running review or findings — or, with no 👍, a no-findings verdict comment naming this head, or the summary's Code Review row marking this head Completed after the 👀 with nothing posted since that 👀, or the summary's state record marking this head completed with no unresolved findings, with nothing posted since and no finding about this head — and no review thread left unresolved | merge |
| `unresolved` | that same 👍, over review threads still open — whatever head they cite | answer each thread and `resolve` it; `merge` refuses until none is open |
| `reviewing` | the 👀 is newer than the reviewer's last word — a round really is in flight | wait it out |
| `stalled` | that 👀 has been up longer than a round takes and nothing was posted | `@codex review` |
| `failed` | the reviewer's newest word is an initialization failure — "Something went wrong", over "Provided git ref `<sha>` does not exist" — naming this head, or "To use Codex here, create an environment for this repo" newer than the head's commit — or the summary's Code Review row marks this head's run "⚠️ Failed" with no review, no 👍 and nothing said inside the run: the round never ran | `@codex review` once; if the same head fails again, push a new head (an amend is enough) — or, for the environment one, hand it to the maintainer, since no push reaches it. On the Failed row `watch` posts that one request itself |
| `expected` | no live 👀, and no review of the head SHA: a round is due and has not started — including a 👍 left from before a push, until the app takes it down | wait out the grace, then `@codex review` |
| `idle` | the reviewer has reviewed this exact head and left no 👍 | the next move is yours: address the round and push — or, at one of the loop's exits (below), close out and merge |
| `unknown` (exit 3) | a read failed | retry — this is *not* "not approved yet" |

`unresolved` is the approval over findings nobody closed (ludics-lite#289). On PR #277's round 6
the reviewer left two findings on the previous head and put its 👍 on the base-merge commit above
it; `watch` printed the findings as NOT about head, moved past them, and reported `approved`. The
merge had changed neither line, so both were live in the head about to be merged. An open thread
is therefore read as a live finding whatever head it cites — `status`, and `watch` when an
approval ends its wait, read every review thread (GraphQL, paged to the end) before reporting the
👍, and `merge` refuses while any is open, with no flag to bypass it. Clearing it needs no push:
answer each thread named on the line (a fix or a rebuttal, `reply`) and close it (`resolve`). A
thread read that fails is `unknown`, never a clean approval. Whether the head changed a finding's
lines is not checked: every open thread counts, an outdated one or a human's included.

`failed` is the reviewer telling you its own clone is behind: the ref it says does not exist is
one the PR's `head.sha` and `git ls-remote` both serve, so nothing about your push is wrong and
nothing you wait for fixes it (on lukstafi/ocannl-staging#677 it fired on two consecutive heads,
and the third reviewed normally after one nudge). It ranks below the 👍 and below a 👀 raised
after it — a round that started later is a round to wait out — and above `idle` and `expected`,
which is what it used to read as: three `watch` windows recommending the grace for a round that
had already ended. A failure naming a head you have since replaced is not it; that is `expected`
again, correctly — and so is a "Something went wrong" that names no ref at all, which is
attributed to no head. Nudge once, and if the same head fails again, amend and push; the line
states both moves in order, because no feed records a reaction-only success reliably enough for
the script to say which of the two you are due. The one ref-less exception is the connector's
"To use Codex here, create an environment for this repo" (ludics-lite#421), which never names a
ref: it is attributed to the head by the clock — newer than both the head's commit date and the
PR's creation, neither unread nor in the future, else `expected` — and its second move is the
maintainer's, since no push reaches it. The failed attempt is not a round, so it does not count
against the convergence threshold.

The third shape is a run the app started and could not finish (ludics-lite#453): the summary's
Code Review row reads "⚠️ **Failed**" on the head (once in 621 rows, ocannl-staging#633), with no
review and no 👍. A re-request cannot cost an approval there, so `watch`
makes it — it posts `@codex review` and keeps watching the request's grace — as it does for an
`expected` head with nothing standing (above); the rule against re-requesting as stall recovery
stands everywhere else. The reading is fail-closed: only the
observed row shape, only on the head, with no 👍 on the PR, nothing from the reviewer inside the
run (since its 👀, or about this head at all once the 👀 is down), and no request since the row.
It fires once per head (two watches on one PR at the same moment could each post one, which is a
duplicate request and never a cleared 👍): the request is its own record, so a second Failed row
on a head that already had a `@codex review` reads `reviewer's run FAILED AGAIN`, and `watch` exits on it for
you — read the feed, then push a new head or hand it over. `status` states the same move and
posts nothing.

An empty `COMMENTED` review counts as no completed review unless its own inline-comments
endpoint contains findings. This also excludes it from the convergence count; comments on another
review cannot make it substantive, and an unread endpoint yields `unknown`. Existing reactions,
verdicts and genuine findings still decide status; otherwise the ordinary `expected`/grace path
applies. This structural check does not classify plain, unstamped setup messages by their prose,
with one verbatim exception: the connector's fixed reply posted INTO a review thread ("To use Codex
here, create an environment for this repo", which a mention of its handle draws there,
ludics-lite#472) is not a finding, so an envelope holding only that reply is no review and no round.

Every one of those lines also says **`CONFLICTS with the base (mergeable_state=dirty)`** when
GitHub cannot build the PR's merge commit, and on `idle` that replaces "the next move is yours".
It is not another state — the reviewer keeps reviewing a conflicted PR — but it changes what a
round is worth: GitHub creates no `pull_request` workflow run for a head whose merge commit it
cannot build, so every push made after the conflict is one CI does not test against the base (a
run that completed before the base moved still stands, but it tested an older merge). On
ludics-lite#39 (2026-09-04) a sibling landed on `main` during round 6, and rounds 6–12 each got
findings, "the next move is yours", and no CI at all, over eight pushes and 80 minutes; one of
them landed a broken test suite, and two of them built machinery the sibling had already
superseded. The first thing that noticed was `merge`. When the line says CONFLICTS, the next
move is `git merge origin/<base>`, resolve, push (once the head's own run has finished, *How
stale the base has grown*) — before addressing anything else. Commit and push that merge on its
own *before* writing the round's fixes, because a merge left uncommitted
absorbs whatever you edit next: on ludics-lite#102 (2026-09-10) the resolved merge sat
uncommitted while the round's fixes were written on top of it, and one `git add -A && git
commit` swept both in, so the round's commit — the one that names its findings and their
severity — hid inside a merge commit, where `git show` renders it against two parents instead of
as its own readable diff, and had to be recovered by resetting to the pre-merge SHA and redoing
the merge alone. GitHub recomputes the mergeability after every push, so for the seconds it
reports `unknown` the line says so as **not yet computed** — a conflict the push just caused would
not show yet — and, unlike `dirty`, that caveat rides alongside "the next move is yours" rather
than replacing it.

Two comparisons carry that, and both are easy to get wrong by hand. Whether the reviewer has *seen*
the head is a SHA equality (each review records the `commit_id` it was submitted against), never a
time comparison — a commit's date can long predate the push that delivered it. Whether a 👀 is live
is judged against the reviewer's own last word, never against the head commit: a 👀 raised just
before your next push is a round that is genuinely running, and #358 had exactly that shape (👀 at
20:34:13Z, head committed 20:35:01Z) twenty minutes after #364 had the stale one. A 👍 carries no
commit at all, and the app takes it down only when it raises the 👀 for the next head, minutes after
the push, so it is matched to the head through the reviewer's summary comment, whose newest Code
Review row names the commit the app last took up: a 👍 under a row naming another commit is a
previous head's, and the head reads `expected` (ludics-lite#418). Only where no row is read does a
clock stand in, and only in the direction a clock can prove: a 👍 older than the head's commit
date cannot be about it.

The whole polling and merge-gate path is REST: GitHub's GraphQL endpoint 503s independently of REST,
and a GraphQL-borne silence is indistinguishable from a reviewer's. Review threads are the one
GraphQL-only subject left, having no REST field for resolution: `resolve` reports a transport
failure as a retry rather than as a missing thread, and the open-thread read an approval and
`merge` make (above) reports it as `unknown` and exit 3, never as "none are open".

### When the loop ends

An automated reviewer does not stop on its own. It keeps finding members of any open-ended
surface, and the surface it finds the most in is the one the review itself built. On
lukstafi/self-improve#27 (2026-09-02) rounds 1–4 were substantive — input validation, the lease
and halt moving onto the anchor, orphan detection, the live auth probe — and from round 5 to round
22 every finding but two was a member of machinery those rounds had introduced: lock races,
rollback windows, backup ordering, lock-holder identity. Each was a real silent-class defect, each
was cheap, and each spawned one or two successors in the next round. The reviewer approved at
round 23, four hours in, most of them spent hardening concurrency paths a single coordinator per
fleet never exercises. A long review is welcome when it makes the code better, and the loop has
no round limit. The first twelve rounds give worthwhile improvements a generous exploration
budget, not an obligation to implement every suggestion or proof that all defects have been found.
After that, distinguish work worth doing from work required before this PR lands. The loop has
two exits, and deferred improvements remain recorded for follow-up.

**A round rebutted in full ends the loop.** Judging on the merits (above) already means some
findings are wrong, and a wrong one is answered with reasoning, not a compliance edit. A finding
rebutted with evidence — the code path that makes it unreachable, the invariant that makes it
harmless, the design boundary that puts it out of scope — is *closed*, not deferred. When every
finding in a round is closed that way, the loop is over: reply in each thread, and merge. There is
no push, so the reviewer gets no further turn; the judgement is yours, and the threads are its
audit trail. So a rebuttal is about the code and never about the budget — "this is round 11" is
not a reason a finding is wrong — and it cites what it rests on, so the maintainer can check it
after the merge.

**From the thirteenth round with findings on, only blocking findings are fixed.** Every other
finding is handed to ONE follow-up issue for the whole residual set — never one issue per finding
— and its thread answered with the deferral. The loop then ends the first time a round yields
nothing to push: every finding rebutted or deferred, reply in each thread, and merge. Read the
round off the PR; do not remember it — a session that has been compacted twice does not know what
round it is in:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh rounds <owner>/<repo>#<pr>   # status prints it too
```

It counts bursts of the reviewer's reviews — a round's reviews land within seconds of each other,
and a new round starts on a different head or after a gap (`SHIP_PR_ROUND_GAP`, 15 min) since the
previous review, so a re-requested round on the same head counts on its own. It exits 1 past the
threshold (`SHIP_PR_ROUND_THRESHOLD`, 12) and enforces nothing: the threshold is a policy, and the
merge is still the build gate's to allow.

A program reads the machine-readable trailer, never the prose above it, which gets reworded
(ludics-lite#423). `rounds` ends with `rounds: n=<N|unknown> threshold=<T|off> first=<K|unknown>`,
`first` being round 1's inline findings (ludics-lite#650). `checks` ends with
`checks: verdict=<green|absent|red|runred|waived|pending|mixed|unjudged|superseded|unknown>`.
A `watch` that ends on reviewer activity puts `watch-rounds: from=<b> to=<n> threshold=<T|off>`
just above its watermark: the window opened rounds b+1 to n, or none when n ≤ b.
`fleet-worker.sh prs` reads a missing or malformed trailer as unknown, never as green.

*Blocking* after round twelve requires one of these conditions:

- The PR introduces or materially worsens a defect that materially prevents the intended use,
  causes a consequential regression in supported behavior, or creates a substantial risk of data
  loss, corruption or unauthorized access during intended use, reasonably foreseeable mistakes
  or abuse, including adversarial inputs.
- The finding invalidates the PR's central claim or its supporting evidence. Correct the claim
  or evidence before merging; fixing an underlying pre-existing defect can remain separate. A
  minor discrepancy with the description normally calls for correcting the description, not
  expanding the implementation. Do not relabel failure to deliver the agreed goal as a minor
  discrepancy.
- Build-relevant checks on the final head fail: the merge gate includes every non-advisory
  check, not just checks required by branch protection. That gate still applies independently
  of which change caused the failure, save a coordinated wave's owned base red (*The override*).

Severity alone is insufficient: a high-priority pre-existing defect that the PR merely exposes
gets a bug report with the appropriate urgency, not a merge block. Record it in the consolidated
residual issue or link its existing report there, and explain the disposition in the thread.
Other valid findings are deferred too, including silent defects and defects in machinery an earlier review round added,
unless they meet the conditions above. This narrows issue-wave's silent-vs-loud policy after the
first twelve rounds; being quiet or review-requested does not itself make a defect blocking.

The findings that arrive past the threshold have a recognisable shape: their subject exists
only because an earlier round asked for it — the lock added in round
3, the rollback added in round 5 — and each spawns a successor. When one of those does block,
removing the machinery is as good an answer as fixing it, and the one a loop never takes on its
own: a lock with three rounds of races is often better answered by no lock and a documented
single-writer assumption; a rollback with a window, by no rollback and an idempotent retry.
Simpler and correct beats elaborate and nearly correct, and a reviewer accepts the removal when
the reply names the invariant that now carries the load. Blocking findings in the PR's own
substance that keep arriving past the threshold are a different signal: the approach may need
reconsidering — stop and raise it with the user.

**Closing out** at either exit is the same act, and the record it leaves is what makes a merge
the reviewer never 👍'd defensible:

- the build gate has READ a green on the final head: merge with `--require-green`, which refuses
  `absent` as well as red and no-verdict — a run that does not exist yet is not a green, and a
  merge the reviewer never 👍'd does not get the path-filter allowance the ordinary gate gives
  (over a coordinated wave's owned base red, with `--override` too, *The override*);
- every thread is answered with its disposition — fixed / removed / deferred / rebutted — and
  resolved;
- the PR body carries a review-record paragraph (edited in with `body`, above): how many rounds,
  each rebuttal in one line, and — when anything was deferred — the follow-up issue's number;
- the residuals, when there are any, are filed as one issue before the merge rather than after
  it. A round rebutted in full leaves none, and no empty issue is filed to say so.

Then merge:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh merge <owner>/<repo>#<pr> --require-green --wait
```

`merge` (below) reads the build signal and the open review threads, not the 👍 — so the
"resolved" in the second bullet is one it checks. The maintainer reads in the record what was
not done and why, instead of finding it in the next PR's review.

Both exits have an incentive problem: past the threshold, deferring is cheaper than fixing, and
rebutting is cheaper than either at any round. The threads and the record paragraph are the only
check on that in a standalone session, which is why a rebuttal cites its evidence and a deferral
names why the finding does not meet the blocking criteria — a reviewer who was right and got
argued with is visible there. Under a wave coordinator none of this changes; the coordinator's
pre-authorization (issue-wave's convergence policy) can only move close-out earlier, never later.

### The approval is one gate; the build is the other

Approval says a human-or-bot read the diff. It says nothing about whether the tree compiles, and
those two gates fail independently. On ocannl-staging they failed independently for ten hours: seven
consecutive merges landed on a `master` that did not build on the only compiler CI builds, and every
one of those PRs was carrying its own red `ci` run at the moment it merged — the same error, both
platforms, named file and line. Six of them were reviewed and approved on top of it
(ahrefs/ocannl#694). Nothing was undetected; nothing read the result.

So merge through the script, which reads the head commit's checks and then merges:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh merge <owner>/<repo>#<pr>
```

It merges with `--merge`, preserving the commit series (the repo convention for topical commits);
other `gh pr merge` flags go after a `--` — `--auto` included, and the gate still runs ahead of it.
That matters on a base with no required checks, where `--auto` is not a queue at all: it merges on
the spot, which is exactly how six red builds got past a merge step that read nothing.

**It refuses when a build check on the head commit concluded `failure`**, printing which ones with
their run URLs, and exits 1 without calling the merge API at all. That refusal is the whole point:
open the run, fix the build, push, merge.

It refuses on an unreadable signal too (exit 3). An unread check list is not a green one — that
distinction is why these reads are REST while `gh pr checks` is GraphQL, which 503s independently
and answers an outage with an empty list indistinguishable from a PR whose CI never ran.

**It refuses while any review thread is unresolved** (exit 1, naming each by the id `resolve`
takes; exit 3 when the threads could not be read), whatever head the thread cites and whatever
the build says — the `unresolved` state above, read before every merge attempt (after any
`--wait`), since a thread opened meanwhile moves no head for `--match-head-commit` to catch. No flag bypasses it:
answer and resolve the threads, then re-run `merge`.

The other verdicts are not refusals, and none of them is a green light either:

| exit | verdict | what it is |
| --- | --- | --- |
| 0 | green | every build check on the head passed |
| 0 | absent | no build check ran on this commit, and the run list confirms none is coming — path filters (a workflow that ignores `docs/**`), or CI never started |
| 1 | RED | a build check concluded `failure`, or a workflow run for the head concluded red without producing one — refused |
| 3 | unknown | the checks or the head's runs could not be read — refused |
| 5 | superseded | the PR head moved from the observed SHA — refused; re-run to judge the successor |
| 4 | no verdict | still running, every finished job was `cancelled`, or a run for the head is queued, stopped without a verdict, or has yet to create its checks — refused without `--allow-no-verdict` |
| 6 | no verdict (`merge` only) | a build job never got a runner, and the one rerun below is spent or failed (or `merge` ran without `--wait`) — refused without `--allow-no-verdict`, naming the commands |

**A job that never got a runner** is named on its own line by `checks` and `merge`, with the
command that recovers it: `NO RUNNER` (cancelled with no step run and no runner, GitHub's "not
acquired by Runner") and `NEVER STARTED` (queued past `SHIP_PR_NEVER_STARTED`, 20 min, while a
newer run of its workflow has a job on the same runner labels that started). `checks --wait` ends
at once on one (exit 4: nothing moves until the run is re-run). `merge --wait` recovers once per
head run: `gh run rerun <id> --failed` (after `gh run cancel <id>` for a never-started job), and
its wait gets a fresh `--wait` budget from the rerun. A second one on that run ends it with 6. A
run you cancelled yourself while its jobs were queued has the NO RUNNER shape too, and is rerun.

**Exit 4 refuses too, by default.** Nothing has failed, but nothing has passed, and a merge that
waits for neither read nothing — it was a warning until 2026-08-23, when a day-long runner queue
outran the 30-minute wait and a PR merged unread with a stale test claim (ahrefs/ocannl#745),
leaving `master` red for two hours. So:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh merge <owner>/<repo>#<pr> --wait
```

`--wait` holds for the verdict up to 120 min (`SHIP_PR_CHECKS_WAIT` seconds, or `--wait=<seconds>`)
with a one-line heartbeat every 10 min (`SHIP_PR_CHECKS_HEARTBEAT`), so background it and let it
hold. Each observation re-reads the PR head, including before returning a terminal verdict.
If it moved, `checks` and `merge` return **5 (SUPERSEDED)** with both SHAs; neither follows
the successor automatically, and neither merge override bypasses this refusal. An unreadable
head returns 3, never superseded or green. Detection occurs on the next poll (after any active
API calls), not through a push notification. If the ceiling runs out it exits 4 naming `--allow-no-verdict`; for anything a compiler sees,
wait again instead.

**A conflict is refused before the wait, not after it** (ludics-lite#729: on ocannl-staging#1259 it
surfaced at the merge call, 120 min in). `--wait` first reads the PR's `mergeable` and
`mergeable_state`: `false` or `dirty` exits 1 at once with the rebase hint, so merge or rebase the
base in, push, and run `merge --wait` again. GitHub computes the answer lazily, so `null` or
`unknown` is read again (up to eight reads 5 s apart, inside the wait's ceiling) and never taken as
clean or as conflicting; still uncomputed, or unread, it is said on stderr and the wait goes on. A
conflict that arises during the wait is the merge call's to refuse (*What `merge` absorbs*, below).

**The polling budget** (ludics-lite#543) is shared by every observer: `watch`, `checks --wait`,
`merge --wait` and `base --wait`. Each one reads at once, then pauses for its interval (`WATCH_INTERVAL`,
`SHIP_PR_CHECKS_INTERVAL`). While nothing moves, the pause doubles up to 300 s for a review and
600 s for a build (`SHIP_PR_REVIEW_POLL_CAP`, `SHIP_PR_BUILD_POLL_CAP`). A PR has ONE observer of each
kind (and `base --wait` one per branch): a second `watch`, or a second `--wait` on a PR, exits 2
naming the first's pid, so wait on that one rather than arming another. A call GitHub refuses on quota is exit 3, never a verdict, and
it sets a hold for every `pr-review.sh` on the host. The hold ends where the failing endpoint's own
headers say (never `/rate_limit`), and it lifts only when that endpoint answers a probe. An
observer waits the hold out within its ceiling before a read (never before a write, which would act
on stale reads). Any other command exits 3 at once without calling.
So a quota exit 3 is not a reason to re-arm sooner: the next call waits for the same hold. The
budget covers github.com alone, so a `GH_HOST` (or a run's `-R`) naming another host is refused
with exit 2 before anything is sent. The mechanism and its boundary are in
`lib/ludics/prreview/budget.py`.

**`ABSENT` seconds after a push used to be the trap here** — a push (a rebase before merging, or
any other) creates a head whose checks do not EXIST yet, and a wait armed in that window saw
nothing to wait for and passed the gate having read nothing (ocannl staging#491 merged that way).
The gate now reads that window itself (ludics-lite#24). The check list is only half the signal —
a run row exists from the moment a run is queued, before any of its check runs — so whenever the
checks leave nothing to wait for (green as well as absent), the gate reads
`actions/runs?head_sha=` and lets it overrule them:

- a run that concluded red without producing a check (a broken workflow file's `startup_failure`,
  say) is exit 1 — nothing in the check list can carry that failure, and it outranks a green,
  pending or stopped check on the same head;
- a queued or running non-advisory run is exit 4, **including under a green check** — one
  workflow's green says nothing about a sibling that has not judged the head. A run whose every
  unfinished job is advisory does not hold (ludics-lite#500); `SHIP_PR_ADVISORY_CHECKS` in
  `pr-review.sh`'s usage text says when, and the `needs:` boundary that comes with it;
- a run that completed `cancelled`/`stale`/`action_required` with nothing behind it is exit 4,
  stopped-not-judged like everywhere else, as is one reported `completed` with no conclusion
  recorded yet;
- a head with no Actions run to back its checks holds too: the gate reads every provider's
  check runs, so an early Codecov green is not evidence that Actions has created its rows;
- a **checkless** head holds while it is inside `SHIP_PR_BASE_ABSENT_GRACE` (300s, measured from
  the fresher of the head's commit date and the PR's own `updated_at` — each validated on its own,
  so a long-local commit pushed just now counts as fresh and a future commit date does not blind
  the gate), and only past that is `ABSENT` the verdict — with the evidence on the line. A head
  with **no run at all** skips that wait when no workflow of the repository can create one for it
  (ludics-lite#176). Every `pull_request` trigger's `paths-ignore` must cover every commit from the
  PR's merge base up to the head; a declared `push` trigger REFUSES, whatever it says, because nothing
  about a push event is establishable from these feeds — its files are computed between its own
  before and after, which a force-push puts off the walked path, and a tag or another branch
  carries the same SHA; and every other trigger must be one whose run can NEVER carry this commit as
  its head — `merge_group`, created at the queue's own ref, and `workflow_call`, which produces no
  run of its own. Everything else refuses, `pull_request_target`, the review events, `schedule` and
  `workflow_dispatch` among them: each of those CAN put a run on this head, and an empty run list
  is the not-created-yet window rather than evidence that none is coming. The workflow file is read
  at the head *and* at the base tip and the two must be identical, since a `pull_request` run uses
  the merge context's copy; any path under `.github/workflows/` anywhere in the range refuses; and
  every workflow file at *either* end of the merge must be one the repository's list carries,
  because that list is built from the default branch plus whatever has run and so is not an
  inventory of the files a `pull_request` run will see (a directory response at the Contents API's
  cap is not one either, and refuses). Every listed workflow is explained, the advisory ones
  included: the list's names have no ref, so they describe the default branch's copies rather than
  the ones that run here. The recognition is admitted at all only where the
  newest merged PR's head shows non-advisory check runs from Actions alone: it reads workflows, so
  it cannot speak for a third-party provider. That last one is a filter and not an inventory — no
  endpoint enumerates a repository's providers — so the residual is a provider absent from that
  sample, and `--require-green`, which refuses `ABSENT` outright, is the hatch for a merge that
  must have READ a green. The head SHA, the base SHA and the head ref are all re-read before the
  verdict is accepted: a retarget, or a base that advances, moves the evidence all of this rests on
  without moving the head, and `--match-head-commit` binds only the head — so `merge` re-reads the
  base last before each merge call and, if it moved since the `absent` read, gates the head again
  without waiting and refuses unless that read passes (ludics-lite#523). Anything less than certain — an unparseable workflow, a pattern the
  translation does not carry, a trigger with no filter, a list longer than its page on any read, a
  range past the cap, a base-side edit to the workflow, a second provider — refuses and costs the
  grace, exactly as `base --wait` does. **The `push` refusal is most of that**: a repository whose
  CI workflow declares `on: push` at all, which is most of them, gets no fast path here, and its
  docs-only PR heads wait the grace out as they did before. What the recognition reaches is the
  workflow triggered on `pull_request` alone. The same grace is what
  `base --wait`'s ceiling is sized against, and a `--wait` in the band between the grace and one
  poll interval past it draws a loud line: it reaches the settle only on the single round the
  ceiling cap schedules, and a tip that moves restamps the grace out from under it
  (ludics-lite#175).

Only the newest **completed** run of each workflow and event is judged, the same `filter=latest`
semantics the check lookup asks for: a re-triggered invocation supersedes its own cancelled
predecessor, while one file triggered on both `push` and `pull_request` produces two independent
runs that are both judged — and a queued run is never folded away at all, since supersession is
something that happens to a run that stopped. The advisory list is a deny-list of check, job and workflow names in all directions — a run
whose red is explained entirely by advisory jobs is not a red build signal, since the gate
already dropped those checks on purpose. A run list that cannot be read is exit 3 even under a
pending check: an unread run list cannot rule out a red that no check run will ever carry.

No hand re-check, and no `--wait` needed for any of it: without one the same window is exit 4, not
0. The knob is there for a repo whose runs take longer than five minutes to appear.

The trap that remains is at the other end of the hold: **the harness can kill a backgrounded
`merge --wait` well before its ceiling** (observed twice at ~40 min). The correct response is to
re-read merge state over REST (`gh pr view --json state,mergedAt,headRefOid`) and re-arm the wait
(`bg-run.sh wait` reads that kill as `DIED`) — never to conclude the merge failed, and never to
reach for `--allow-no-verdict` because the waiter died.

`--allow-no-verdict` merges unread, loudly on stdout and stderr. It is acceptable only when the
verdict could tell you nothing you have not established yourself: a doc-only diff, or a shell-only
one whose script you ran locally on the **exact rebased tree** you are merging — a rebase is a new
tree, and "I tested it earlier" is the stale test claim of #745. It is not for "CI is slow today";
that is the day it exists to refuse.

`cancelled` is deliberately neither red nor green — a cancel is a job that was stopped, not one
that found something. A matrix left at GitHub's default `fail-fast: true` cancels its siblings when
one leg fails; that leg's failure is the red the gate reports (exit 1), and the cancelled siblings
are the information `fail-fast: false` keeps. Any other cancel comes from a superseding push or a
manual stop, and re-running is what turns it into an answer; it is exit 4 like a running job, and
`--allow-no-verdict` is no more acceptable for it.

`--require-green` is the opposite hatch: it makes `absent` a refusal too (exit 4), and so is a
green made only of `skipped` and `neutral` checks — nothing failed, but no build ran — for the
close-out merges of *When the loop ends*, which rest on the record rather than on a 👍 and so must
have READ a passing build rather than found nothing red. It also refuses `--auto` and a base
with a merge queue (where `gh pr merge` is an enqueue, landing later on whatever head the PR has
then; read before the wait and again right before the merge call), and when required checks turn
the call into a deferred auto-merge anyway it disables that again and exits 1: a close-out merge
lands the gated head now or not at all. With `--wait` it holds, like the ordinary gate, through
the run-creation grace and then for the verdict. Its refusals have no "drop the flag" way out: a
head that genuinely runs no build (path filters) gets one dispatched onto it (`gh workflow run
<workflow> --ref <branch>`), or the merge goes to the maintainer with the record on the PR — the
path-filter allowance the ordinary gate gives is exactly what a merge without a 👍 does not get.

Whatever the verdict, the merge is bound to the head it was read for: `merge` passes
`--match-head-commit` with that SHA, so a push after the last head re-read makes the
merge refuse (exit 1, naming the SHA it read) instead of landing a head nothing has read. Re-run
`merge`; it reads the gate again.

Run `checks` on its own — same verdicts, same exit codes, no merge — whenever you want the build
signal without acting on it, such as before asking the reviewer for another round.

**Awaiting CI is `checks --wait`'s job, never `gh run watch`'s.** Raw `gh run watch` streamed
~168k tokens of progress redraws into one session, and its nonzero exit on a run that concluded
FAILURE carries no HTTP status, so a retry loop reads a workflow verdict as transport — the
2026-08-29 wave re-watched a completed FAILED run four times and then reported "the API never
answered". Use `checks <pr> --wait` for a PR's build signal (it reads every check on the head,
with a heartbeat that names the checks still running instead of redraws). To wait on one job's
verdict while a slower one runs, add `--check '<ERE>'`: only the check runs whose name the ERE
matches are judged, advisory ones included, with the same budget and exit statuses. A selection
that matches nothing is held while a run is in flight and refused with exit 2 after, never green;
`merge` takes no `--check`, since its gate is never a subset. For a single run, `retry run watch
<owner>/<repo>#<run-id>` is safe: the script does not forward it to gh but executes a quiet await
— one verdict line; run FAILED is exit 1, transport exit 3, no verdict exit 4. Name the repo in
the argument here for the same reason as everywhere else; this await was simply the first place
the cwd stopped being a source (ludics-lite#74 — a background shell that had started in another
project's worktree awaited a run id from this one, and the 404 came back as a verdict about the
run). A bare id is accepted only with `-R owner/name` or `REPO=`, and refused with exit 2
otherwise; a run/repo pair the API rejects is exit 2 too, never the exit 1 that reads as red.

A platform the PR matrix skips is its scheduled run's to cover: a PR neither waits on that run
nor dispatches it by default. Dispatch it on the head, and cite the run, only when the change
needs that platform's evidence — it fixes a failure the platform reported, or changes behavior
only that platform exercises. A dispatched run puts its check runs on the head, so `checks` and
`merge` then wait on it: close to an hour for a Windows leg (ludics-lite#337).

### How stale the base has grown

Both gates above read the *head commit*, and both are satisfied by a branch whose base has moved on
without it. `merge` therefore also prints how many commits behind its base the branch is and the
exact intersection between paths changed by the PR and paths changed by the base since their merge
base (and `watch` prints the same read, on stderr, whenever a round lands). It says so loudly —
`!!! … COMMITS BEHIND`, on stdout and stderr — past 20 (`SHIP_PR_STALE_BASE`, or `off`), warns at
any count when that intersection is nonempty, and says `!!! … CONFLICTS` when GitHub reports the
PR's `mergeable_state` as `dirty`: nothing has tested that head merged with the *current* base — a
`pull_request` run from before the base moved tested it against an older base, a branch-push run
tested it alone, and a push made after the conflict gets no `pull_request` run at all — and the
merge call would fail on it.

It warns and merges anyway. That is the **roll-forward policy** (ahrefs/ocannl#861, decided
2026-08-30 after a wave where every sibling merge invalidated every open PR's verification —
staging#533 ran three clean rebases and three full CI cycles over an unchanged topic diff): a PR
merges on one build verdict for its own head, the one *The approval is one gate* (above) reads. It
never waits on the base branch's tip; the base enters only an `absent` verdict, whose workflow-file
recognition reads it. GitHub merging a green head cleanly into a base that has moved on restarts
nothing: `merge` merges with `--merge`, whose merge commit combines the head with the newer base,
and the PR's `pull_request` run already built `refs/pull/N/merge`, the head merged with the base as
it stood then. A push that moves the head to a commit no run has built restarts the wait, a clean
rebase included (until #496), which is why the head moves only for a conflict (below). What owns
semantic drift instead is the wave coordinator's post-merge **integration loop** (issue-wave skill):
the repository's full suite on merged master, on a quiet, strong fleet machine, with
stop-the-world triage on a regression.

**When a wave coordinator is actively running that integration loop**, the division is strict
on the landing side too: after `merge` confirms `merged`, the worker's verification is over.
Do not run the `base --wait` tail below and do not watch master's subsequent workflows — under
concurrent sibling merges "the current tip" is a moving target and the wait never terminates
(on 2026-08-30 seven wave workers each chased it for 100–120 minutes; every one ended unjudged
or had to be killed). If a wave worker checks anything post-merge, it is the single run for its
OWN merge commit, read once — a run superseded or cancelled by a later sibling merge is the
integration loop's business. In standalone use — no coordinator, no loop — trailing CI is
likewise not the merger's to watch: it belongs to the repository's post-merge owner (below).

**Still read the intersection before letting the merge stand.** On staging#488 (2026-08-28) sixteen review
rounds ran against a base that had gone 136 commits stale, `master` had meanwhile edited the very
file the PR changed, and every signal on the merge path was clean: green checks (on the stale
head), an approval (of the stale diff), `mergeable=true` (semantic drift produces no textual
conflict). What caught it was a hand-run endpoint diff whose 258 files were visibly not the
two-file branch. Endpoint diffs are eyeball tools, not the answer: they include the PR's own edits,
so every nonempty PR looks drifted by them. Read `merge`'s `base-drift file overlap` line instead.
It reads the PR's head SHA and the base *branch's* current tip and compares those two exact SHAs in
both directions — not the PR's own `base.sha`, which is the base as of the last merge commit
GitHub could build and so stands still on precisely the conflicted PR that is furthest behind
(#39 read "0 behind" off it while `main` was 7 commits and 4 overlapping files ahead); renames
contribute both the old and new path, and paths remain JSON strings so spaces and unusual
characters are not split. `none` is an exact empty intersection. `UNKNOWN` means an API call failed
or GitHub's 300-file compare cap made a list potentially incomplete; it never means none, so retry
the read.

**A green head merges as it is.** An overlap with the base, same-region or not, is information, not
a reason to rebase: read those files for semantic drift, then merge. Interactions with the siblings
merged meanwhile, past the merge build below, are the integration loop's to catch on the merged tip (standalone, the post-merge
owner's, below), as for any clean merge. Rebase, or merge the base in where the branch is shared,
only for a textual conflict: `CONFLICTS`, or `merge` refusing the PR as not mergeable. Push that
resolution once the head's own run has finished, never while it is in flight: a CI with
`cancel-in-progress` cancels that run, and its verdict on the change itself with it. A count the
compare API could not answer prints `UNKNOWN`, which is not "not behind": check it by hand.

**Where the repository asks, `merge` builds the merge commit first** (ludics-lite#611). On
2026-10-15 ocannl-staging#1142 and #1139 merged minutes apart, each green on its own head, their
five shared paths changed "all in DISJOINT hunks" — and the merge did not compile, leaving master
red for an hour. A repository that names a build in `.github/ship-pr-merge-build` on its default
branch (read like the advisory list: only a 404 the listing confirms is "no file") gets one local
check before the merge call. When the file's trigger holds (by default, a path in the drift read's
intersection matches one of its `input` globs) or the two sides are UNKNOWN, `merge` builds the
gated head merged with the base's tip in a scratch repository that borrows the objects of the clone
it runs in (nothing is registered in the clone, and nothing of the build outlives it), inside the
box's run-time slot where it has slots, bounded by the file's timeout, and refuses with exit 1 and
the build's output when it fails:

```
# pr-review.sh merge's build of the would-be merge commit (ludics-lite#611). A path is a build
# input when an `input` glob matches the whole repository path (fnmatch: `*` crosses `/`).
# The command is trusted as a developer's build is: its scratch repository is a place to build,
# not a sandbox. timeout: 1 to 86400 seconds. trigger: same-input (default) or any-input.
# The command runs at the merged tree's root; HEAD^1 is the base's tip and HEAD^2 the PR's head,
# also named by $SHIP_PR_MERGE_BASE_SHA and $SHIP_PR_MERGE_HEAD_SHA.
command dune build @check
input *.ml
input *.mli
input dune
input */dune
input dune-project
input *.opam
timeout 1200
```

Any other line refuses the merge with exit 2. The merge still waits only on the head's own verdict,
never on the base tip's CI, so roll-forward stands, and a repository without the file merges as
before. A shared path renamed on either side counts by its other name too. Run such a merge on a
POSIX host (the fleet's macOS and Linux boxes; Windows is refused) from a full clone of the
repository: one with no remote naming it, a shallow one (which may lack the merge base) or a
partial one (a promisor remote) is exit 2. A
build that does not finish is exit 4, one that could not run (the fetch, the slot) exit 3, a head
that moved exit 5, a textual conflict exit 1. Nothing waives a failed build: merge the base in, fix
the clash, push. By default the boundary is the intersection: a clash across paths only one side
changed (a caller in a file the base never touched) is still the integration loop's. `trigger
any-input` widens it to a build whenever EACH side changed some build input, which catches that
clash at about three times the builds (ludics-lite#635), so it suits a cheap command. A base that
moves again between the build and the call is the integration loop's either way
(`prreview/mergebuild.py` states both).

**Standalone use does not watch CI at all** (since 2026-08-31): trailing failures on the merged
base belong to the repository's **post-merge owner**, the watch or triage routine its agent notes
name, which claims a red with one issue and may open a fix PR. So after `merge` confirms
`merged`, this session's verification is over: do not run `base --wait`, do not watch the base's
subsequent workflows. (Briefly that day the rule was the opposite — every merger blocked on its
own `base --wait` — which stacked N sessions on the same remote CI cycle; a single owner
replaced it.) A repository with no owner is no exception: its trailing red is the next session's
pre-branch `base` read, above.

Two local touchpoints remain. Where the repository has an owner, a red you happen to see — in
the pre-branch `base` read, or anywhere else — is presumptively CLAIMED work: find the claiming
issue and any linked PR before touching anything, and take over only when the issue shows
triage stopped short and nobody else picked it up (say so there first). And a fix PR the owner
opened is finished work like any other: land it through this skill.

### The override

The gate has two escape hatches, for two different facts. `--allow-no-verdict` (above) is for a
verdict that has not arrived; `--override` is for one that has arrived and is red. They do not
substitute for each other: a red is never "no verdict", and a queue is never "an unrelated red".

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh merge <owner>/<repo>#<pr> \
  --override "the red is the pages Deps step, failing on master since before this branch existed"
```

`--override` takes a reason in **words** — a bare token like `yes` is rejected — because what makes
an override legitimate is being able to say why *this* red is unrelated to *this* PR, and that
sentence is what the next reader finds in the log. It prints on both stdout and stderr, loudly,
just before the merge call: a merge refused first, by `--require-green` say, says nothing of it.

It waives **exactly the reds the gate read when it was given** — the checks (and checkless
workflow runs) that were red at the gate's first read, marked `WAIVED` in the report, each keyed
by its check suite and name (a run by its run id), so one workflow's red never waives a
same-named job of another, nor one dispatch's red a later dispatch (two same-named jobs of one
suite are not told apart by anything, so a red among them is never waived) —
and nothing else (ludics-lite#392: ocannl-staging#776 merged over an unrelated ubuntu red while
its macOS leg was still running, and nothing had read that leg). A check with no verdict yet is
not a red, so it keeps the ordinary semantics: `--wait` holds for it, and without `--wait` the
merge refuses with exit 4 naming it. A check that turns red *during* the wait is a red nobody gave
the override for, so the merge refuses on it with exit 1; open it, and if it is just as unrelated,
run `merge` again with a reason that covers it (the new run's first read is the new set). A waived
check that is re-run is waited for while it runs and stays waived if it fails again (a re-run
keeps its suite).

It is legitimate when you have **established** that the failure is neither about your change nor
about the tree you are merging into: the identical red is on `master` from before your branch
existed; the failing step is infrastructure no source change can reach (an opam solve, a runner
image, a registry timeout, a rate limit); or you can point at another PR whose build fails the same
way. In each of those you have opened the run and read it.

**In a coordinated wave, an owned base red is established for you** (ludics-lite#623, the
maintainer's decision). When your head's red is the base's own — the same check failing the same
test at the base's tip — and the wave coordinator has halted launches on it and named its owner,
the triage issue (issue-wave's stop-the-world notice names all three), merge over it without
waiting for the fix, and do not chase it: its attribution is the owner's. It covers a test that
fails, never a build that breaks; where the repository has a merge build (*How stale the base has
grown*), `merge` refuses a clash in the merge itself. The reason cites the check and test, the base
SHA and the owner, so every merge in the red span names the red it rode over:

```bash
~/.claude/skills/ship-pr/scripts/pr-review.sh merge <owner>/<repo>#<pr> --wait \
  --override "base red, not this PR: <check>, test <test>, red at <base sha>; owned by <owner>/<repo>#<issue>"
```

At the loop's close-out exit (*When the loop ends*) it keeps `--require-green`, which takes a red
the override waived as read and keeps its other refusals. Under auto permission mode it still
needs the user's go-ahead (*PR or direct commit?*): the standing merge rule there does not cover
`--override`.

It is not legitimate for "the error looks unrelated", for a red you have not opened, or for a flake
you are assuming rather than confirming — re-run the job instead. A re-run costs minutes; an
override costs whoever branches next their afternoon. And an override is never the way to handle a
red you caused: an unrelated red is a fact about the world, and a related one is your commit.

Which checks the gate reads is a deny-list, not an allow-list: every check on the commit counts
unless it is named advisory (`SHIP_PR_ADVISORY_CHECKS`, or for `checks` and `merge` the
repository's own `.github/ship-pr-advisory-checks` on its default branch), so a renamed job or a
new matrix leg keeps gating instead of silently falling out of it. Advisory by default: the review
app's own permanently-skipped check, and a publishing workflow that compiles none of the tree
(ocannl's `github pages docs` runs slipshow, pandoc and latexmk over `docs/**`, so its red is about
a font package, never about the code).

Exclude by name only what **cannot carry a build verdict** — not merely what is red today. ocannl's
`github pages api` was excluded on the latter reasoning, being red on every master push, and the
exclusion promptly hid a real `dune build @doc` compile break behind the apt failure that was
masking it (ahrefs/ocannl#698). A workflow that is always red wants fixing, not deny-listing; once
it is fixed, take it back off the list.

### What `merge` absorbs, and what a nonzero exit therefore means

`gh pr merge` exits 0 having only *enabled* auto-merge when the base carries required checks or a
merge queue, so the exit code is not the answer; `merge` confirms `merged` over REST and reports
`merged=false` as a failure to land. REST, not `gh pr view --json` — those ride GraphQL, and a
nonzero merge whose state query then 503s is exactly the shape of a merge that DID land.

A merge failing with "Pull request is not mergeable: the merge commit cannot be cleanly created" is
ambiguous, and the two readings demand opposite moves. GitHub recomputes a PR's mergeability
asynchronously after every push; until that finishes the API serves the cached verdict, so for some
seconds after a push — including the very push that just resolved a real conflict — the merge fails
with a message byte-identical to a genuine conflict. Seen back to back on ocannl-staging#373
(2026-08-18): first real base drift, then the stale cache over the freshly pushed
conflict-resolution merge. `merge` re-reads `.mergeable` over REST until it is non-null and retries
on `true`, so a nonzero exit from it already means the recompute settled: `mergeable=false` is base
drift needing a merge or rebase of the base branch, and only a repeated failure after that is a
conflict you must resolve.

### After it lands

Then clean up, but not with `gh pr merge --delete-branch`: from a worktree its cleanup fails *after*
the merge has landed ("fatal: 'master' is already used by worktree"), leaving the branch behind and
the failure looking like a failed merge. Run the executable sequence instead:

```bash
~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh <main-checkout> <session-worktree> <branch>
```

The helper defaults to a `master` base for compatibility. Pass `--base main` (or another branch)
when the repository uses a different base:

```bash
~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh <main-checkout> <session-worktree> <branch> \
  --base main
```

A build tree is neither of the session gate's two exempt classes: it is not harness-owned
`.claude/`, and it is build output, so never matching the base checkout's copy is the whole point
of it. It therefore refused every OCaml worktree that had ever built — 92M on one sighting — and
archiving it would be worse than refusing, since the sibling archive is the "out of sight" the
gate exists to prevent and one would accumulate per landed PR. Name such a directory instead, and
cleanup removes it rather than refusing over it:

```bash
~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh <main-checkout> <session-worktree> <branch> \
  --base main --regenerable _build
```

Which directories `--regenerable` names is the project's to say, in its AGENTS.md (OCANNL's
names `_build`); `_opam` and `node_modules` are the same shape. The
flag is repeatable and has no default, and the helper learns no build system from it — it names a
class of paths, not a command to run inside a checkout it is about to judge. Each value must be
ONE top-level directory of the SESSION worktree: a value carrying a separator — `/`, and `\` too,
which is one under Git Bash — is refused rather than resolved, which is what keeps an absolute
path, a nested path and every `..` out; `.` and `..` are refused by name; the worktree root must
hold an entry spelled exactly that way, so a value a case-folding or Unicode-normalizing
filesystem resolves to a *different* entry (`SRC` for `src`) is refused rather than removed, since
Git's pathspecs are byte-exact and would report that alias as holding nothing tracked; a symbolic
link is never followed, since `rm -rf` through one would remove a tree the worktree does not hold;
and a tracked path is repository content whatever was typed. A name
the worktree does not carry is a no-op, so the same command line works for a worktree that never
built. The removal happens before either gate reads the worktree and therefore before the
merge-ancestry proof: a cleanup that then refuses still leaves the named directories gone, which
is exactly what the flag asserts about them. The base owner is never touched this way. Its build tree is
ordinarily ignored data, which already passes its gate; an unignored one is refused there by name,
and the remedy for that is an ignore rule rather than this helper deleting a tree in the operator's
primary checkout to clean up an unrelated topic branch.

It fetches and proves the ordinary topic is an ancestor of `origin/<base>` before deleting
anything, advances the local base according to which worktree owns it, detaches and unregisters
the session worktree into a sibling recovery archive, rechecks ancestry against the updated local
base, deletes the local branch independently of its configured upstream, and deletes the remote
branch last: only once the local deletion has committed and been read back, so a cleanup that
stops part-way leaves the public branch in place rather than gone beside a surviving local one. Its scratch-repository test
covers an unchecked-out base, a base owned by the primary checkout, a base owned by another
worktree, safe deletion while the primary checkout is off the base, an explicit `main` base, and
refusal of an unmerged topic:

```bash
~/.claude/skills/ship-pr/scripts/test-post-merge-cleanup.sh
```

Naming one or more cases exactly — as `--list` spells them — runs only those, which is how to
iterate on a single failure; an unrecognized name is refused before any case runs.

```bash
~/.claude/skills/ship-pr/scripts/test-post-merge-cleanup.sh test_safe_topic_deletion
```

The cases are independent, so they run concurrently, one per processor by default (`-j N` or
`SHIP_PR_TEST_JOBS` changes that; `-j 1` is serial): the full suite finishes in about a minute and
a half on a 4-core CI runner, where the serial run took eight, and in well under a minute on a
desktop. Each case's output is buffered and printed whole when it completes, so a failure report
never interleaves with another case; passing cases print only their `PASS <case>:` line unless `-v` asks
for everything. Failures do not stop the other cases — the closing `FAIL:` line names every case
that failed. A case that cannot be expressed on the platform it runs on states that as a `SKIP
<case>:` line naming the mechanism (under Git Bash: a control character in a file name, a
directory held as a live process's working directory), and the closing line counts and names
those cases, so a boundary is never read as a pass. Each case runs in its own process group under a deadline
(`SHIP_PR_TEST_CASE_TIMEOUT`, five minutes by default): a case still running at its deadline is
killed as a group and reported with its log, so one stalled case cannot hold a CI job to the
job's own timeout, which one did for six hours. The runner tests itself as well, from patched
scratch copies — refused arguments, `--help` with an inherited pid list, the deadline, and an
in-place rewrite of both scripts while a case runs, which the brace group each script is wrapped
in makes harmless (the negative control strips it and must resume at the rewritten offset).

A squash or rebase merge does not preserve ancestry. After independently confirming that merge,
make the exception explicit and leave its reason in the transcript:

```bash
~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh <main-checkout> <session-worktree> <branch> \
  --force-integrated "GitHub reports the PR squash-merged at <sha>"
```

Every path the helper reads back from Git is classified before it is joined to the checkout it
came from: a leading slash, and a Windows drive root (`C:/Users/...`), count as already rooted.
Git for Windows reports a path it read from a `.git` file's gitdir line, from `core.worktree` or
from `--git-common-dir` in that native form even under Git Bash, whose own other outputs are
`/c/...`, and joining one to the checkout refused a clean, merged session with a path that cannot
exist anywhere. Its interactive `update-ref --stdin` transactions reach Git through an
anonymous pipe and a regular response file rather than a pair of FIFOs, for the same platform: a
native Git for Windows reads nothing from an MSYS2 FIFO and exits 0 having done nothing.

The helper requires Git's transactional `update-ref` symbolic-ref commands, a Python 3.12 or newer
(it runs through `scripts/py` since ludics-lite#403), the exact session-worktree root, a clean and unlocked session, and one shared
fetch/push endpoint for `origin`. The session must also carry no ignored local data, since cleanup
archives the session by renaming it: two classes are exempt because archiving them loses nothing —
harness-owned state under a top-level `.claude/` directory, which the agent harness writes into
every worktree it opens and whose lock may belong to another live session, and an ignored regular
file byte-identical to the base checkout's copy — or an ignored directory, which Git reports as one
entry with nothing inside it shown, every file beneath which is such a copy. Neither exemption follows a symbolic link — at
the leaf or at any component of either side's path, so a base checkout reaching the path through a
symlinked ancestor holds no copy of it — and a path the base checkout does not have is never
exempt. The gate reads the status NUL-delimited, so a name Git would quote is judged as itself, and
shell-quotes each refused path on the way out, so a pathname cannot forge a diagnostic line. A refusal names the ignored paths it tripped on, and suggests no stash: session
worktrees share one stash stack with the primary checkout. It treats an already absent topic as a safe retry state and
refuses an unreadable ref, a symbolic local/tracking ref, or a remote tip newer than the local
branch; an absent remote topic sends no deletion, while present remote and local deletions carry
exact-OID leases. It also fetches the selected base
explicitly, independent of the remote's configured fetch map, and proves the local ref can
fast-forward before any remote deletion. A clean worktree keeps the base continuously reserved
while the named ref is conditionally updated and its tree refreshed; when no worktree owns it, the
helper creates a temporary owner for that same critical section. The remote topic is observed
before any topic mutation and deleted last, leased on that observed OID, so every earlier refusal
leaves it untouched; a fresh base read precedes the first topic deletion and follows the remote one. A changed base is
fetched by its exact advertised OID and accepted only if it descends from the validated base;
local and tracking base refs retain their already prepared tip. If that verification fails or
the base becomes unreadable, the remote topic is restored before refusal. The
validated tip also remains reachable under a direct `refs/ship-pr/recovery/` ref because no finite
remote read can rule out a later base rollback; a divergent remote-tracking tip is retained
separately under `refs/ship-pr/tracking-recovery/` before pruning. The base-owner refresh uses a non-destructive porcelain
fast-forward through a helper-only reservation and a conditional named-ref update. A checked-out
base owner must contain no tracked change and no untracked file, with one exemption and one
deliberate omission. IGNORED data passes: the primary checkout owns the base on the standard
layout and always carries build caches and ignored config, and ignored data is only at risk on
the paths the fast-forward touches, which the changed-path collision scan refuses and
`--no-overwrite-ignore` protects. UNTRACKED harness-owned state under a top-level `.claude/`
directory passes too, on the same terms as the session gate — a real directory, no symbolic link
at any component — because the agent harness writes it into every checkout it opens, the primary
one included, and a repository whose ignore rules do not carry the name met it here rather than at
the session gate and refused cleanup unconditionally. The read is NUL-delimited and the refusal
names the shell-quoted paths, and the two rechecks after the locked refresh use the same scanner,
so a `.claude/` that passed the preflight cannot come back as data the owner "gained" once the
fast-forward has already landed. After the update the owner is prepared
at the new tree and reattached with a detached-HEAD compare-and-swap before the reservation is
removed. The helper probes that compare-and-swap capability before any branch mutation and refuses
older Git versions cleanly. The helper also checks ignored descendants when a directory is
replaced, refuses a topic owned by any other worktree, and transfers
topic ownership to a temporary reservation through local ref deletion, and removes matching
remote-tracking and only the standard keys from repository-local upstream configuration. Included, global,
per-worktree, and custom branch configuration is inherited policy and is deliberately not edited.
Rather than recursively deleting a directory that can receive a last-moment ignored write, it
refuses initialized submodules and session-local worktree refs before mutation, preallocates sibling archives before ref mutation,
reserves the session-recovery ref namespace, atomically renames the session into one without
directory-nesting semantics,
retains the archived session's final HEAD under `refs/ship-pr/session-recovery/`, and unregisters
the now-missing worktree while holding the linked-worktree HEAD and pseudoref locks. Objects named
by session pseudorefs or its HEAD reflog, plus the final index tree, are retained beneath the
reserved `refs/ship-pr/session-recovery/` namespace; resolve-undo blobs receive direct recovery
refs, and per-worktree configuration is copied into the archive. Remote-tracking reflog objects are
retained under the topic recovery namespace before pruning, as are local-topic reflog objects before
branch deletion; both sides of every retained reflog entry are covered. Late files or links at the vacated path are moved to the second archive
before unregistering is retried. Do not reconstruct its state
machine in prose or
replace the ancestry guard with `git branch -d`: `-d` may test a configured upstream unrelated to
the base, making deletion either tautological or a false refusal after the worktree is already gone.

If the harness blocks the merge itself, that is a permission gate, not a failure: explain what you
were doing, give the command, and let the user decide. Never work around it.

After merging: run the `after-merge` brainstorm FIRST, while the session's friction is still in
context. Then refresh the base for the next branch (`git fetch origin`, then branch off
the selected `origin/<base>` again) and tear down any scratch worktrees the work created on remote
machines.
Nothing further is owed: trailing CI on the new tip is the repository's post-merge owner's business
(the stale-base section owns the division of responsibilities and the takeover protocol) — and
a plain `base` read seconds after a merge would only report the previous tip's green anyway,
so do not treat one as a post-merge verdict.

Close the tracked issue out in two commands, comment first — never as one `gh issue close
--comment`. A PR body with the closing keyword prescribed in *Open* normally closes the issue
at merge time, and `gh issue close N --repo O/R --comment "…"` on an
issue that is already closed prints `! Issue … is already closed`, posts NOTHING, and exits 0:
the summary is lost silently, with the close-out reading as done (ludics-lite#70 and #76 both,
2026-09-10). So post the summary unconditionally, then close only if the merge did not:

```bash
gh issue comment N --repo O/R --body-file <summary-file>
gh issue view N --repo O/R --json state --jq .state   # CLOSED → done; OPEN → close it
gh issue close N --repo O/R
```

`--body-file` rather than `--body "…"`: a summary worth posting is multi-paragraph and carries
backticks, which a shell argument mangles.

## Multi-PR arcs

When several PRs implement one tracked issue, comment on the issue as each phase lands — what the
phase delivered, in the issue's own vocabulary. At the end, close the issue with a waypoint
summary mapping each waypoint to the PR that landed it (comment-then-close, as *After it lands*
spells out — the last PR of an arc closes the issue too), and state the honest outcome including
where the work did *not* pay off; file the follow-ups that the arc's own evidence justifies
(that is `after-merge`'s job). An arc that closes with only its wins recorded costs the next
person the same discovery twice.
