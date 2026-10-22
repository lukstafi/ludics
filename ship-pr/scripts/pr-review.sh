#!/usr/bin/env bash
# Review-loop helpers for the ship-pr skill: poll a PR for NEW reviewer activity, reply to an
# inline comment, resolve its thread, and check the approval reaction.
#
# Every subcommand is served by Python since ludics-lite#403: lib/ludics/prreview/<subcommand>.py,
# run through scripts/py. This file is the command line in front of it -- the usage below, the
# source-time knobs and their validation, and the forward (see "the forward" at the foot). The
# notes that follow are the design the Python implements; each module there carries the incident
# history of its own rules. The shell implementation they were ported from is this file as of
# c66d06b (`git show c66d06b:ship-pr/scripts/pr-review.sh`).
#
# The point of the script is that the polling traps live in code instead of in prose:
#   - app reviewers appear as "<name>[bot]", so the login is matched by PREFIX, never equality;
#   - your own replies bump review and comment counts, so "new" means id > watermark, not a delta;
#   - the comment APIs paginate at 30, so every list call paginates with per_page=100;
#   - a just-submitted review shows up in pulls/<n>/reviews BEFORE its inline comments reach the
#     flat pulls/<n>/comments listing (2026-08-20, #396 review 4985620117: three findings readable
#     under the review's own comments endpoint while the flat list still omitted them, and the
#     round printed "(no new inline comments)" beside the review it had just detected) — so a
#     round that sees a new review re-reads pulls/<n>/reviews/<id>/comments and merges by comment
#     id, and a failure of THAT read fails the whole round rather than dropping the findings;
#   - the reviewer ANNOUNCES a round by posting a placeholder comment the moment it starts (the
#     machine-tagged codex-pull-request-review-summary table, "🔄 Running"), so a new id above the
#     watermark is not yet something to act on — it is dropped from the rendering while the
#     watermark still advances past it, or every PR's watch wakes once for a round that has not
#     finished (one wasted wake + re-arm per PR, observed landing self-improve#10 and #13);
#   - empty/non-numeric API output makes [ "$n" -gt 0 ] abort, so no count is compared as an int;
#   - the three feeds number their items in SEPARATE id spaces (a review id is ~4.9e9 while an
#     inline-comment id is ~3.8e9), so one shared watermark takes the max from reviews and then
#     hides every inline finding — the watermark is per feed, an opaque comma-joined triple;
#   - reviewThreads paginates at 100 too, so a long-running PR's later threads are unaddressable
#     ("no review thread starts at comment N") unless the resolve lookup pages to the end;
#   - a PR number names one PR in EVERY repository, so a repo that was not spelled out in the
#     invocation is a guess about intent that no read can check — the repo travels in the PR
#     argument (owner/name#number), and a bare number with no repo named is refused;
#   - an API failure and a genuinely empty feed both render as `[]`, so a read that failed must
#     report UNKNOWN and never "no approval yet" — that is a silent false negative on the merge
#     gate, and it fired for real during the 2026-08-17 GitHub outage on an approved PR;
#   - during an incident GitHub does not fail cleanly, it fails HALF the time: on 2026-08-17 about
#     one call in two came back "503 No server is currently available to service your request" for
#     an hour, so a single attempt is a coin flip and every call goes through the retry (core.py) — which
#     retries 5xx and that body text, and never a 4xx (a 4xx is the API answering);
#   - a call that exhausted its retries is a TRANSPORT failure, and reporting it as a fact about
#     the PR is the worst thing this script can do: "no review thread starts at comment N" was
#     printed during that outage for three threads that all existed, because the paginated GraphQL
#     lookup 503'd — it reads as a finding ("someone resolved it", "the id is wrong") and sends the
#     caller hunting. So every claim (no new activity, no such thread, not approved, wrong repo) is
#     printed ONLY on a call that succeeded; otherwise the message and the exit code say transport;
#   - a reaction is a LEVEL, not an event, and the app does not always take its 👀 back: on
#     2026-08-17 (#364) a 👀 added at 18:13:51Z outlived the review it announced (18:26:06Z), and
#     three consecutive 15-minute `watch` windows then reported "reviewing — wait it out" over a PR
#     nothing was reading. 45 minutes went to a signal carrying no information, and the loop only
#     moved after a hand-posted "@codex review". So a 👀 counts as in flight only while it is NEWER
#     than the reviewer's last word (a review OR its summary comment); once the reviewer has spoken,
#     the 👀 describes a round that has already landed and is spent;
#   - the reviewer posts one finding as several inline threads often enough to matter (round 11 of
#     ludics-lite#66: nine threads for four findings), and each duplicate then costs its own
#     composed reply and its own resolve — and it duplicates by RE-WRITING, so the copies share
#     their anchor exactly and share no byte of their text. So threads at the SAME anchor (path,
#     commit, author and every location field the row carries) fold into one entry listing every
#     thread id and printing every distinct body, and `reply`/`resolve` take that list, so a
#     duplicate costs one answer (ludics-lite#76);
#   - the reviewer's own utterances are that clock, NOT the head commit: a 👀 raised just before
#     your next push is a round that is genuinely running (seen live on #358 the same evening — 👀
#     at 20:34:13Z, head committed 20:35:01Z), so "older than the head commit" would declare an
#     in-flight round spent and nudge on top of it;
#   - whether the reviewer has SEEN the head is a SHA equality, not a time comparison: every review
#     records the commit_id it was submitted against, so comparing that to .head.sha answers the
#     question exactly — no guessing at a push time, and immune to a commit whose author date long
#     predates the push that delivered it;
#   - the same equality decides what ENDS a wait, and `watch` used to skip it: a new id above the
#     watermark is not the round you are waiting for unless it is about the head you are watching.
#     A round's watch exits on the inline findings and takes its watermark from that poll; the
#     reviewer's separate summary review lands seconds later with a higher id; and the next
#     window returns 0 on it immediately, with nothing about the new head to act on (ludics-lite
#     #72). So every item poll renders carries the commit it is about (a review's commit_id, an
#     inline comment's original_commit_id — commit_id MIGRATES to the current head as the branch
#     advances — and a comment's "Reviewed commit:" stamp), and one about another commit is
#     printed for the record while the watermark advances past it and the wait goes on;
#   - patience is bounded on BOTH sides, because a stall reads the same from either: a review
#     that never starts and a 👀 that never lands both end with a verdict to nudge rather than with
#     another silent hold. "Wait it out" is only honest while something is actually running — and
#     the verdict that nothing is coming polls ONE more time before it says so, because a nudge
#     recommended over a round that landed while the state was being read re-requests a review
#     and clears the 👍 it was about to get;
#   - how late a due review is cannot be read off the head commit's date alone: that date is
#     commit metadata, and a force-push to an older commit or a first push of a morning's work
#     predates the push it arrived in. The push time is not an API field, so the clock starts at
#     the newest of that date and the PR's created_at — a floor that cannot be wrong, since
#     nothing about a PR is due before the PR exists (ludics-lite#72, where a PR opened seconds
#     earlier reported its review "due for 22m" and recommended a nudge);
#   - the reviewer can fail at INITIALIZATION and say so in a plain summary comment, which is its
#     newest word without being a round at all: "Codex Review: Something went wrong. Try again
#     later by commenting “@codex review”." with "Provided git ref <sha> does not exist" in a
#     code block under it — no review, no findings, and no machine tag to tell it apart from a
#     verdict. On lukstafi/ocannl-staging#677 (2026-09-09) it landed twice, naming two heads that
#     `git ls-remote` and the PR's own head.sha both served: the reviewer's clone was behind, not
#     the push. Counted as the reviewer's last word it spends the 👀, and with no review of the
#     head the state fell to `expected`, so three consecutive windows recommended waiting out a
#     grace for a round that had already ended, while `rounds` counted the failed attempt as a
#     round with findings. Hence the `failed` state (prreview/state.py, ludics-lite#78), which
#     also covers the connector's "To use Codex here, create an environment for this repo"
#     (ludics-lite#421);
#   - and a round is only worth its cost on a head CI can test: GitHub creates no pull_request
#     workflow run for a PR whose merge commit it cannot build (mergeable_state `dirty`), while
#     the reviewer reviews it regardless. On ludics-lite#39 (2026-09-04) a sibling landed on main
#     during round 6 and rounds 6 through 12 each got findings, a "the next move is yours" from
#     `status`, and NO CI, over eight pushes and 80 minutes, until `merge` failed on it — one of
#     those pushes landed a broken test suite CI would have caught (ludics-lite#44). So `status`
#     reads mergeable_state off the same PR read as the head and says CONFLICTS on every state,
#     and `watch` prints the base-drift read the moment a round lands, not only at merge time.
#
# The `merge` command exists for the same reason as the rest of this file: what the merge step has
# to READ before it acts does not survive as prose. It reads the head commit's check-runs and
# REFUSES on a build check that concluded failure (ahrefs/ocannl#694 — seven merges onto a master
# that did not compile, each PR carrying its own red run), and it absorbs the merge traps: GitHub
# recomputes a PR's mergeability asynchronously after every push, and until that finishes `gh pr
# merge` fails with "Pull request is not mergeable: the merge commit cannot be cleanly created" —
# byte-identical to a genuine conflict. On ocannl-staging#373 (2026-08-18) that fired seconds after
# pushing the conflict-RESOLUTION merge commit; re-reading .mergeable moments later gave true and
# the retried merge landed. So it polls .mergeable over REST until it is non-null before calling
# that failure base drift (null = still computing; only a persisting false is a conflict), and it
# confirms `merged` over REST afterwards, because `gh pr merge` exits 0 having merely ENABLED
# auto-merge when the base carries required checks.
#
# The last thing `merge` reads before acting is how far the branch has fallen BEHIND its base and
# whether the base's advance touched any path changed by the PR, because a review is only ever
# about the code it was run against. On 2026-08-28
# (ocannl-staging#488) a merge was one keystroke away over a base 136 commits stale after SIXTEEN
# review rounds; master had meanwhile edited the very file the PR changed, and what caught it was a
# hand-run `git diff origin/master..HEAD --stat` whose 258 files and 14k deletions were visibly not
# the two-file branch. Nothing on the merge path had a reason to notice: the checks were green (on
# the stale head), the reviewer had approved (the stale diff), and `mergeable` was true (no textual
# conflict — semantic drift does not produce one). So the count is read from the compare API and
# WARNED about. It does not refuse — for one day (2026-08-29) it did, and the ahrefs/ocannl#861
# decision (2026-08-30) reverted that to the roll-forward policy: a clean merge proceeds on the
# head's green run, verification does not restart per sibling merge (the gate's cost was
# structural — #533 ran three full CI cycles over an unchanged diff), and what owns semantic
# drift after the fact is the wave coordinator's integration loop (issue-wave skill), which runs
# the full suites on merged master and stops the world on a regression. The overlap is exact or
# UNKNOWN: compare responses cap their file list at 300, so a capped list is never reported as
# "none". Both compare directions use the head SHA from one PR read and the base branch's tip
# from one read of the branch — NOT the PR's `.base.sha`, which is the base as of the last time
# GitHub could build the merge commit and so stands still on exactly the conflicted PR that is
# furthest behind (#39 read "0 behind" off it, 7 commits and 4 overlapping files behind) — and
# rename entries contribute both their current and previous filenames.
#
# REST vs GraphQL: everything on the polling and merge-gate path is REST, deliberately — GitHub's
# GraphQL endpoint 503s independently of REST, so a GraphQL-borne "no reaction yet" is a lie the
# merge gate would act on. `gh repo view` rides GraphQL, hence the local git-remote fallback.
# Thread resolution has no REST equivalent and stays on GraphQL, but reports transport failure as
# such instead of as "no such thread".
#
# Usage (<pr> is owner/name#number, or a number with the repo named by --repo/REPO=; see the repo
# note at prreview/core.py's resolve_repo — a bare number with no repo named anywhere is refused,
# never taken from the cwd):
#   pr-review.sh [--repo owner/name] poll <pr> [watermark]
#                                          # new comments/reviews above the watermark, each stamped
#                                          # with the commit it is about; ends with one machine
#                                          # line naming those items (kind:id:commit:author:state)
#                                          # and the next watermark. Inline threads at the SAME
#                                          # anchor (path, commit, author and every location field
#                                          # the row carries) render as ONE entry whose id field
#                                          # lists them all, anchor first — `id=900+901`, the token
#                                          # `reply` and `resolve` take — with every distinct body
#                                          # under the id of the thread carrying it
#   pr-review.sh watch <pr> [watermark] [--no-nudge]
#                                          # poll on a timer until a round lands ON THE HEAD being
#                                          # watched; 0 = act, 1 = quiet. Reviewer activity about
#                                          # another commit is printed on stderr for the record and
#                                          # the wait continues; every exit names what it ends on,
#                                          # and one on reviewer activity carries a `watch-rounds:`
#                                          # line above the watermark (see prreview/rounds.py). A
#                                          # head due a review with nothing standing for it gets
#                                          # one '@codex review' from the watch itself, once per
#                                          # head (prreview/watch.py); --no-nudge posts nothing
#   pr-review.sh status <pr>               # merge gate + who owes what: approved / unresolved
#                                          # (approved over open review threads) / reviewing /
#                                          # stalled / failed / expected / idle / unknown — and
#                                          # the round count against the threshold (see `rounds`);
#                                          # says CONFLICTS when GitHub cannot build the merge
#                                          # commit (nothing tests the head merged with the base,
#                                          # and a push gets no run at all, until the base is in)
#   pr-review.sh rounds <pr>               # how many review rounds carried findings, read off the
#                                          # PR (heads the reviewer left comments on), against
#                                          # SHIP_PR_ROUND_THRESHOLD; exit 1 past it; ends with a
#                                          # `rounds: n=… threshold=… first=…` trailer (see prreview/rounds.py)
#   pr-review.sh checks <pr> [--wait] [--check <ERE>]
#                                          # the BUILD signal on the head commit: green / red /
#                                          # no verdict yet / absent; ends with a
#                                          # `checks: verdict=…` trailer (see prreview/rounds.py).
#                                          # --check judges only the checks the ERE names
#                                          # (see prreview/checks.py)
#   pr-review.sh merge <pr> [--override "<why this red is unrelated>"] [--wait]
#                           [--allow-no-verdict] [--require-green] [-C <clone>]
#                                          # checks, then merge; refuses on an open review thread
#                                          # (no flag bypasses that), on red without --override,
#                                          # on NO verdict without --allow-no-verdict, and — with
#                                          # --require-green (a close-out merge) — on ABSENT, on
#                                          # green-by-skips-only, on --auto, on a base with a
#                                          # merge queue, and on a deferred auto-merge (which it
#                                          # disables again); and WARNS
#                                          # loudly when the branch is far behind its base.
#                                          # --override waives exactly the reds of the gate's
#                                          # FIRST read (by check suite and name), never a check
#                                          # with no verdict yet: that one is waited for under
#                                          # --wait and refused with 4 without it, and a check
#                                          # that turns red during the wait was never waived, so
#                                          # it refuses with 1 (ludics-lite#392). Where the
#                                          # repository's default branch has a
#                                          # .github/ship-pr-merge-build and its trigger holds
#                                          # (by default: a path both sides changed is one of
#                                          # its build inputs), it first BUILDS
#                                          # the head merged with the base's tip in a scratch
#                                          # repository borrowing the objects of the local
#                                          # clone it runs in (or the one -C names, checked
#                                          # first: ludics-lite#730), and refuses
#                                          # (1) when that build fails, with its output
#                                          # (ludics-lite#611; see prreview/mergebuild.py).
#                                          # Under --wait it waits behind a measurement on the
#                                          # box for what is left of its ceiling (at least
#                                          # 30 min), the slot naming the hold at once
#                                          # (ludics-lite#764). A PR that changes that config
#                                          # gets a NOTE: the default branch's copy judged it.
#                                          # A build job that never got a runner (NO RUNNER,
#                                          # NEVER STARTED, which `checks` names too) gets ONE
#                                          # rerun per head run under --wait; then, or without
#                                          # --wait, it refuses with 6 naming the commands
#                                          # (ludics-lite#560/#728; see prreview/runners.py)
#   pr-review.sh merge-build --base <rev> --head <rev> [--config <file>] [-C <dir>]
#                                          # the merge build alone, a DRY RUN in a local checkout
#                                          # (no PR read, no fetch, no merge): a config's
#                                          # negative control, the PR's own copy included
#                                          # (ludics-lite#751; see prreview/mergedry.py). Exit as
#                                          # merge's build step: 0 would proceed, 1 refused.
#   pr-review.sh base [owner/name] [branch] [--wait[=seconds]] [--interim]
#                                          # is the branch you are about to work off CI-green?
#                                          # --wait holds until the CURRENT tip has its verdict —
#                                          # the post-merge integration read (see prreview/base.py).
#                                          # A red names the failing JOB and how far back the red
#                                          # runs go, so the report is an owner's starting point
#                                          # and not just a workflow name (see prreview/base.py);
#                                          # `.github/workflows/base-watch.yml` runs it daily on
#                                          # this repository's own main and files what it finds.
#                                          # A workflow that no longer runs on push is judged at
#                                          # the tip by a NAMED source or not at all (ludics-lite
#                                          # #401): the merged PR's head run, or a coordinator's
#                                          # [--integration-records <file>] (fleet-worker gate)
#                                          # [--advisory-red <file>] (the gate's): a workflow red
#                                          # only in jobs .github/ship-pr-advisory-checks names
#                                          # is not red; those jobs are written to <file>; and
#                                          # the interim judges by that list too (#659)
#                                          # --interim: a tip whose own push run is in flight is
#                                          # green by a NAMED source meanwhile (the merged PR's
#                                          # head run), never the tip's own verdict; opt-in, for
#                                          # the gate and the base watch (ludics-lite#308)
#   pr-review.sh reply <pr> <comment-id>[+<comment-id>...] <body> [--allow-mention]
#                                          # the id token poll rendered. A FOLDED entry names
#                                          # several: the body goes to the first thread and each
#                                          # duplicate gets a one-line pointer to that reply, from
#                                          # this one invocation. A body mentioning '@codex' is
#                                          # refused unless --allow-mention (see prreview/reply.py)
#   pr-review.sh reply <pr> <comment-id>[+...] --body-file <path> [--allow-mention]
#                                          # the body read from a file instead: exactly one of
#                                          # the two; the file's text is posted verbatim and
#                                          # mention-checked as an argument is. An unreadable or
#                                          # empty file is refused before anything is posted
#   pr-review.sh reply <pr> <comment-id>[+...] --anchor <comment-id>
#                                          # no body: the answer already stands in <comment-id>'s
#                                          # thread, and every id in the token is pointed at it.
#                                          # What a batch that failed part-way is retried with
#   pr-review.sh resolve <pr> <comment-id>[+<comment-id>...]
#                                          # the same token; every thread it names is closed
#   pr-review.sh comment <pr> <body>|--body-file <path> [--allow-mention]
#                                          # a plain PR comment, for what has no thread to reply in:
#                                          # a review SUMMARY's findings, or a '@codex review' nudge
#                                          # (the one body that may mention '@codex' without the
#                                          # flag; see prreview/reply.py). --body-file as `reply`'s
#   pr-review.sh body <pr> <file>          # replace the PR's description with the file's content,
#                                          # over REST: `gh pr edit --body-file` rides GraphQL and
#                                          # fails on a repo whose PRs trip the classic-Projects
#                                          # deprecation (see prreview/body.py). Prints the PR's URL.
#                                          # Retried like a read, ambiguous failures included: the
#                                          # PATCH sets the body whole, so a repeat is harmless
#   pr-review.sh retry [--read] <gh args...>
#                                          # any other gh call (pr merge, api) with the same retry
#                                          # policy, instead of a hand-rolled loop. gh refusing
#                                          # the arguments itself (an unknown flag or --json
#                                          # field) sent nothing: exit 2, never retried. So
#                                          # is gh WITHHOLDING an answer for its terminal
#                                          # escape sequences (a job's log): pass gh's
#                                          # --allow-escape-sequences on such a read
#   pr-review.sh retry [--read] run watch owner/name#<run-id>
#                                          # NOT forwarded to gh: executed as a QUIET await of that
#                                          # run — one verdict line instead of a stream of redraws,
#                                          # and a FAILED run is a verdict (exit 1), never retried
#                                          # as transport. The repo travels in the argument, like
#                                          # every other subcommand's (a bare id still works with
#                                          # -R owner/name or REPO=, and is REFUSED without one —
#                                          # never taken from the cwd). For a PR, prefer
#                                          # `checks <pr> --wait`.
#
# Exit codes: 0 the command did what it says (and any fact it printed came from a call that
#             answered); 1 the fact does not hold (the window stayed quiet, no such thread, the API
#             rejected the request, a build check or a checkless workflow run is RED, the merge was
#             refused); 2
#             usage/configuration error; 3 TRANSPORT failure — nothing was learned, so retry rather
#             than concluding anything, which for `watch` includes a verdict WITHHELD because the
#             final poll or the state re-read behind it did not answer. 1 and 3 are kept apart
#             everywhere. `checks`, `base` and
#             `merge` add 4: no verdict yet — the build has not finished, every finished job was
#             cancelled, or a workflow run for the head is queued, running, stopped without a
#             verdict, or still to be created. 4 is not a pass and not a failure, and it is kept
#             apart from 0 for the same reason 3 is: "nothing has failed" and "everything passed"
#             are different facts.
#             From `merge`, 4 means the merge was REFUSED for want of a verdict (see
#             --allow-no-verdict). `checks` and `merge` add 5: SUPERSEDED — the PR head
#             moved from the observed SHA. Re-run to judge the successor; no override bypasses 5.
#             `merge` adds 6: no verdict because a build job never got a runner, and the one
#             rerun `--wait` makes per head run is spent or failed, or there was no wait to make
#             it in (`checks` names the same jobs and stays 4). --allow-no-verdict still merges.
#
# Env: REPO=owner/name, overridden by a repo spelled out in the <pr> argument or by --repo; those
#      three are the ONLY sources, for every subcommand including `retry run watch` (`base`, which
#      resolves a repo and a branch rather than a bare number, still reads the cwd's checkout),
#      REVIEWER=login-prefix (default: codex app), WATCH_INTERVAL=seconds between polls (default
#      90), WATCH_TIMEOUT=seconds to watch (900), SHIP_PR_REVIEW_POLL_CAP and
#      SHIP_PR_BUILD_POLL_CAP=seconds the pause between unchanged polls doubles up to (300 for
#      `watch`, 600 for a `--wait`), SHIP_PR_STATE_DIR=where the quota hold and the observer locks
#      live (default ${XDG_STATE_HOME:-~/.local/state}/ship-pr; see prreview/budget.py), and
#      the runs pages of a `base --wait` that settled on absence (base-pages/, the newest 20),
#      SHIP_PR_API_ATTEMPTS=tries per gh call (4), SHIP_PR_API_BACKOFF=first pause in seconds (5,
#      doubling to a 20s cap: ~35s of retrying before a call is declared dead),
#      SHIP_PR_REVIEW_GRACE=seconds a due-but-unstarted review is waited for before `watch` returns
#      saying so (1200), SHIP_PR_REVIEW_STALL=seconds a live 👀 or Running row may run before it
#      reads STALLED, which `watch` nudges once per head (1.5×GRACE; prreview/knobs.py says
#      why). Both are measured from the PR's own timestamps, not from when the watch started, so
#      they are reached ACROSS windows — a 900s window cannot outrun a 1200s grace.
#      SHIP_PR_ADVISORY_CHECKS=ERE of check, job and workflow names the build gate ignores
#      (default: the review app's check and the github-pages deploys) — a run whose red is
#      explained entirely by advisory JOBS is not a red build signal either, and a run still in
#      flight whose every unfinished job is advisory does not hold a `--wait` once its finished
#      non-advisory jobs are all green and its job list has been still for a minute
#      (ludics-lite#500; prreview/gate.py). BOUNDARY: GitHub creates a
#      `needs:`-blocked job only once its dependencies finish, so a required job that `needs:` an
#      advisory one is not visible while that advisory job runs — such a workflow is released
#      early. A required job must not `needs:` an advisory one. A value REPLACES the default list,
#      so a caller that adds names spells the default's in too. A repository can set its own list
#      for `checks` and `merge` instead: one ERE per line in .github/ship-pr-advisory-checks on
#      its default branch, read before the gate (ludics-lite#530; prreview/gate.py). That keeps the
#      merge command bare. The variable, when set, still wins over the file, and `base` reads
#      only the variable and the default.
#      SHIP_PR_CHECKS_WAIT=seconds `--wait` holds
#      out for a build verdict (7200 — the runner queue alone ran ~2h deep on 2026-08-23),
#      SHIP_PR_CHECKS_INTERVAL=seconds between re-reads (60), SHIP_PR_CHECKS_HEARTBEAT=seconds
#      between the one-line "still waiting" progress notes a `--wait` prints (600),
#      SHIP_PR_BASE_ABSENT_GRACE=seconds a commit with no workflow run yet is allowed before its
#      absence is read as a fact (300; paths-ignore pushes never get one). `base --wait` applies
#      it to the tip — from the first READ of it, not from that round's last answer — and then
#      SETTLES for the older verdict the plain read settles for, once nothing is in flight on the
#      branch and no run for the tip exists to judge it. It settles at once, without the grace,
#      when every commit on the first-parent path from the judged one up to the tip changes only
#      paths within the workflow's own paths-ignore (ludics-lite#156). A `base --wait=N` in the
#      band (grace, grace+SHIP_PR_CHECKS_INTERVAL) is WARNED about: it reaches the settle only on
#      the single round the ceiling cap schedules, and only if the tip has not moved
#      (ludics-lite#175). `checks`/`merge` apply the
#      grace to the head before calling a build signal ABSENT rather than not-created-yet
#      (ludics-lite#24), and settle a run-less head at once on the same paths-ignore recognition,
#      walking the PR's own commits from its merge base (ludics-lite#176),
#      SHIP_PR_NEVER_STARTED=seconds a build job may sit queued while a newer run of its
#      workflow has started a job on the same runner labels, before `checks` and `merge` read it as
#      NEVER STARTED (1200; `off` reads none),
#      SHIP_PR_STALE_BASE=commits behind the base at which `merge` warns loudly (20; `off`
#      silences the commit-count warning). A nonempty file overlap still warns at any count; no
#      base-drift warning blocks the merge. SHIP_PR_ROUND_THRESHOLD=review rounds with findings
#      after which only BLOCKING findings are fixed and the rest go to one follow-up issue (12;
#      ship-pr's "When the loop ends" — `rounds` and `status` report the count against it,
#      nothing here enforces it; `off` reports the count alone; anything else is refused).
#      SHIP_PR_ROUND_GAP=seconds between two of the reviewer's reviews on the same head beyond
#      which they are separate rounds (900; a round's reviews land within seconds).

set -uo pipefail

# --- the source-time knobs ----------------------------------------------------------------------
# Every constant the Python reads is resolved here, once, from the environment, and validated here,
# so a bad value is refused before anything runs; the forward then hands the Python the VALUE this
# shell holds (PY_FORWARD_VARS, below), because a sourcing suite's `retune` and main's --repo change
# the variable and not the environment. What each knob means is the usage text above; the Python
# module that reads it carries why it is what it is (prreview/core.py, knobs.py, budget.py).

REPO="${REPO:-}"
REVIEWER="${REVIEWER:-chatgpt-codex-connector}"
ROUND_THRESHOLD="${SHIP_PR_ROUND_THRESHOLD:-12}"
# Reviews of one round land within seconds of each other; a re-requested round on the SAME head
# lands minutes or hours later. This gap is what tells them apart (seconds).
ROUND_GAP="${SHIP_PR_ROUND_GAP:-900}"
API_ATTEMPTS="${SHIP_PR_API_ATTEMPTS:-4}"
API_BACKOFF="${SHIP_PR_API_BACKOFF:-5}"

# The exit code carries the difference the messages carry: 1 = the fact does not hold, 2 = the
# caller or the environment is wrong, 3 = the API never answered so nothing is known. Here, before
# the forward, only 2 is ever said: a knob or a command line this file refuses.
fail() {
  local rc="$1"
  shift
  echo "pr-review.sh: $*" >&2
  exit "$rc"
}

die() { fail 2 "$@"; }

# --- jq's line ending (ludics-lite#335), for the scripts that source this file ------------------
# Nothing this file runs reads jq any more: every subcommand is Python. What is kept here is for the
# two kinds of script that SOURCE it and run jq themselves -- the fixture suites (their fixture
# `gh` answers through jq, and so do their reads of what a subcommand printed) and
# pr-review-api-contract.sh -- so the line ending is decided in one place for both. A native jq.exe on Windows (winget, Chocolatey,
# Scoop; Git for Windows ships no jq) writes its stdout in text mode and ends every line CRLF, and
# every line but a `$(...)`'s last keeps its \r. So the jq on PATH is asked ONCE, at source time:
#   lf      it writes LF already (every Unix jq, an MSYS2 jq): called as is, no cost;
#   binary  it writes CRLF and `-b` (jq 1.7+ on Windows) turns that off: called with `-b`, which
#           costs no process, where a filter would cost a fork per call on the slowest-forking
#           platform there is;
#   strip   it writes CRLF and refuses `-b` (jq 1.6): its output goes through `tr -d '\r'`. That
#           takes a CRLF inside a raw string to LF as well, which nothing reads as data. It is not
#           `sed 's/\r$//'`, which keeps that CRLF on Unix but lost it on the Git Bash leg all the
#           same, where MSYS sed read the \r away: the one platform that takes this path gets the
#           same answer either way, and tr says so.
# `jq_lf` is the call and `jq` names it, so a caller that replaces `jq` can forward to `jq_lf` and
# keep the line ending. A jq that is missing or broken probes as `lf`, and the first real call then
# fails as it would have. The probe runs only when the file is sourced (SHIP_PR_TEST_SOURCE_ONLY=1):
# a command line execs the Python, which reads no jq, and should not pay a jq process for it.
JQ_EOL=lf
# The probe counts the bytes of `"x"` through a pipe (3 is x\r\n) rather than comparing a
# `$(...)`: Git Bash's command substitution drops a trailing \r with the \n, so `$(jq -rn '"x"')`
# reads `x` from the very jq.exe that writes x\r\n. There a single value read back clean all
# along; a multi-line read, a `while read` and a pipe did not.
jq_eol_probe() {
  local n
  JQ_EOL=lf
  n=$(command jq -rn '"x"' 2>/dev/null | wc -c) || return 0
  [ "$((n))" -eq 3 ] || return 0
  n=$(command jq -b -rn '"x"' 2>/dev/null | wc -c) || n=0
  if [ "$((n))" -eq 2 ]; then JQ_EOL=binary; else JQ_EOL=strip; fi
}
jq_lf() {
  case "$JQ_EOL" in
  lf) command jq "$@" ;;
  binary) command jq -b "$@" ;;
  *) jq_lf_strip "$@" ;;
  esac
}
# A subshell with its own `pipefail`, so jq's failure is the call's status whatever options the
# caller runs under. Not PIPESTATUS: a PIPESTATUS the environment exports shadows bash's own, and
# it then never moves (run-pr-review-hostile.sh exports one).
jq_lf_strip() (
  set -o pipefail
  command jq "$@" | tr -d '\r'
)
jq() { jq_lf "$@"; }
[ "${SHIP_PR_TEST_SOURCE_ONLY:-}" != 1 ] || jq_eol_probe

# A typo in the threshold ("12x") must not read as `off`: that would turn a bounded triage into
# an unbounded one silently, so anything but a number or the literal `off` is a usage error.
case "$ROUND_THRESHOLD" in
off | 0 | [1-9]*) case "$ROUND_THRESHOLD" in *[!0-9]*) [ "$ROUND_THRESHOLD" = off ] ||
  die "SHIP_PR_ROUND_THRESHOLD must be a number of rounds or 'off', got '$ROUND_THRESHOLD'" ;; esac ;;
*) die "SHIP_PR_ROUND_THRESHOLD must be a number of rounds or 'off', got '$ROUND_THRESHOLD'" ;;
esac
# The gap is compared as a number, where a quoted "900" or a `true` would not be rejected but
# compared cross-type — every same-head re-request collapsing, or every review becoming its own
# round — so only a plain nonnegative integer passes.
case "$ROUND_GAP" in
0 | [1-9]*) case "$ROUND_GAP" in *[!0-9]*)
  die "SHIP_PR_ROUND_GAP must be a nonnegative number of seconds, got '$ROUND_GAP'" ;; esac ;;
*) die "SHIP_PR_ROUND_GAP must be a nonnegative number of seconds, got '$ROUND_GAP'" ;;
esac

# The polling budget (ludics-lite#543, #551; prreview/budget.py): the caps the pause between
# unchanged polls doubles up to, and the state directory the quota hold and the observer locks live
# in. A fixture suite (source-only mode) gets no directory unless it names one, so no suite reads or
# writes this host's real hold.
REVIEW_POLL_CAP="${SHIP_PR_REVIEW_POLL_CAP:-300}"
BUILD_POLL_CAP="${SHIP_PR_BUILD_POLL_CAP:-600}"
for budget_knob in "SHIP_PR_REVIEW_POLL_CAP=$REVIEW_POLL_CAP" "SHIP_PR_BUILD_POLL_CAP=$BUILD_POLL_CAP"; do
  case "${budget_knob#*=}" in
  '' | *[!0-9]*) die "${budget_knob%%=*} must be whole seconds, got '${budget_knob#*=}'" ;;
  esac
done
unset budget_knob
if [ -n "${SHIP_PR_STATE_DIR:-}" ]; then
  BUDGET_DIR="$SHIP_PR_STATE_DIR"
elif [ "${SHIP_PR_TEST_SOURCE_ONLY:-}" = 1 ]; then
  BUDGET_DIR=""
else
  BUDGET_DIR="${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/ship-pr"
fi

# The review clock (prreview/state.py): how long a due-but-unstarted review, and a live 👀 or
# Running row, are waited for before `watch` nudges (prreview/watch.py).
GRACE="${SHIP_PR_REVIEW_GRACE:-1200}"
case "$GRACE" in
'' | *[!0-9]*) die "SHIP_PR_REVIEW_GRACE must be a number of seconds, got '$GRACE'" ;;
esac
STALL="${SHIP_PR_REVIEW_STALL:-$((GRACE * 3 / 2))}"
case "$STALL" in
'' | *[!0-9]*) die "SHIP_PR_REVIEW_STALL must be a number of seconds, got '$STALL'" ;;
esac

# How many pages of 100 the review-threads read follows before it refuses the read as unread
# (prreview/threads.py): one cap for the open-thread gate and `resolve`'s lookup alike.
THREADS_PAGE_CAP=50

# The build gate (prreview/gate.py, checks.py, base.py). The advisory list is a deny-list of check,
# job and workflow names; the interval, wait and heartbeat pace a `--wait`; the absence grace is
# how long a push may go without a run before absence becomes a fact (named for `base --wait`, which
# asked first; the shell variable drops the prefix, the ENV name keeps it).
BUILD_ADVISORY="${SHIP_PR_ADVISORY_CHECKS:-^(claude|Claude Code|github pages docs)$}"
CHECKS_INTERVAL="${SHIP_PR_CHECKS_INTERVAL:-60}"
CHECKS_WAIT="${SHIP_PR_CHECKS_WAIT:-7200}"
CHECKS_HEARTBEAT="${SHIP_PR_CHECKS_HEARTBEAT:-600}"
ABSENT_GRACE="${SHIP_PR_BASE_ABSENT_GRACE:-300}"
# Whole seconds, validated up front: these are deadlines, heartbeats and sleep caps, where a
# fractional value does not degrade gracefully, and a zero interval would busy-loop the API instead
# of pacing it.
case "$ABSENT_GRACE" in
'' | *[!0-9]*) die "SHIP_PR_BASE_ABSENT_GRACE must be a number of seconds, got '$ABSENT_GRACE'" ;;
esac
case "$CHECKS_INTERVAL" in
'' | *[!0-9]*) die "SHIP_PR_CHECKS_INTERVAL must be whole seconds, got '$CHECKS_INTERVAL'" ;;
esac
[ "$CHECKS_INTERVAL" -gt 0 ] || die "SHIP_PR_CHECKS_INTERVAL must be at least 1 second, got '$CHECKS_INTERVAL'"
case "$CHECKS_WAIT" in
'' | *[!0-9]*) die "SHIP_PR_CHECKS_WAIT must be whole seconds, got '$CHECKS_WAIT'" ;;
esac
case "$CHECKS_HEARTBEAT" in
'' | *[!0-9]*) die "SHIP_PR_CHECKS_HEARTBEAT must be whole seconds, got '$CHECKS_HEARTBEAT'" ;;
esac
# Whether the CALLER set the advisory list (ludics-lite#530): a list the caller set wins over the
# repository's own .github/ship-pr-advisory-checks, and a default must never read as a caller's
# choice, so this travels to the Python under a name of its own.
ADVISORY_FROM_ENV=""
[ -z "${SHIP_PR_ADVISORY_CHECKS:-}" ] || ADVISORY_FROM_ENV=1
# How long a run's job list must have been still before a run in flight on advisory jobs alone is
# released (ludics-lite#500; prreview/gate.py, run_inflight_is_advisory_only).
ADVISORY_SETTLE=60
# How many entries the Contents API serves for a directory before it truncates: a workflows
# directory at the cap is one the paths-ignore recognition cannot read (prreview/workflows.py).
CONTENTS_DIR_CAP=1000
# How many commits the paths-ignore recognition reads one by one before it lets the grace answer
# instead (prreview/workflows.py, head_within_paths_ignore).
IGNORE_MAX_COMMITS=20

# How far behind its base the branch may fall before `merge` warns loudly (prreview/drift.py).
STALE_BASE="${SHIP_PR_STALE_BASE:-20}"
case "$STALE_BASE" in
off) ;;
'' | *[!0-9]*) die "SHIP_PR_STALE_BASE must be a number of commits or 'off', got '$STALE_BASE'" ;;
esac
# How long a build job may sit queued, while a newer run's job on the same labels has started,
# before `checks` and `merge` read it as NEVER STARTED (prreview/runners.py).
NEVER_STARTED="${SHIP_PR_NEVER_STARTED:-1200}"
case "$NEVER_STARTED" in
off) ;;
'' | *[!0-9]*) die "SHIP_PR_NEVER_STARTED must be whole seconds or 'off', got '$NEVER_STARTED'" ;;
esac

# --- the forward (ludics-lite#403) ----------------------------------------------------------------
# Every subcommand is served by lib/ludics/prreview/<name>.py, run through scripts/py (which picks a
# Python >= 3.12), with the same arguments. main() EXECs it, so the Python's exit status, stdout and
# stderr are the command's own. The cmd_<name> stubs below serve callers that SOURCE this file (the
# fixture suites): a stub returns 0 when the Python did and exits with its status otherwise.
#
# The source-time constants the Python side reads, as <shell variable>=<environment name>. The
# VALUE handed over is the shell's own, not the caller's environment: a suite that `retune`s
# API_ATTEMPTS, or main's --repo, has changed the variable and not the environment. Name a constant
# here only when its environment name means "the caller set this" in the Python as well -- a
# constant whose being SET is itself read (SHIP_PR_ADVISORY_CHECKS, ADVISORY_FROM_ENV) needs its own
# name for the forward, or the Python would read every default as a caller's choice. So does one no
# caller's environment sets at all (THREADS_PAGE_CAP): its LUDICS_ name is the forward's alone.
PY_FORWARD_VARS=(REPO=REPO REVIEWER=REVIEWER ROUND_THRESHOLD=SHIP_PR_ROUND_THRESHOLD
  ROUND_GAP=SHIP_PR_ROUND_GAP API_ATTEMPTS=SHIP_PR_API_ATTEMPTS API_BACKOFF=SHIP_PR_API_BACKOFF
  GRACE=SHIP_PR_REVIEW_GRACE STALL=SHIP_PR_REVIEW_STALL STALE_BASE=SHIP_PR_STALE_BASE
  CHECKS_INTERVAL=SHIP_PR_CHECKS_INTERVAL CHECKS_WAIT=SHIP_PR_CHECKS_WAIT
  CHECKS_HEARTBEAT=SHIP_PR_CHECKS_HEARTBEAT ABSENT_GRACE=SHIP_PR_BASE_ABSENT_GRACE
  NEVER_STARTED=SHIP_PR_NEVER_STARTED
  BUILD_ADVISORY=LUDICS_BUILD_ADVISORY ADVISORY_FROM_ENV=LUDICS_PR_ADVISORY_FROM_ENV
  ADVISORY_SETTLE=LUDICS_PR_ADVISORY_SETTLE CONTENTS_DIR_CAP=LUDICS_PR_CONTENTS_DIR_CAP
  IGNORE_MAX_COMMITS=LUDICS_PR_IGNORE_MAX_COMMITS THREADS_PAGE_CAP=LUDICS_THREADS_PAGE_CAP
  REVIEW_POLL_CAP=SHIP_PR_REVIEW_POLL_CAP BUILD_POLL_CAP=SHIP_PR_BUILD_POLL_CAP
  BUDGET_DIR=LUDICS_PR_BUDGET_DIR)
# The commands the Python runs that a sourcing suite may have replaced with a shell FUNCTION (its
# fixture `gh`). The Python cannot call a function of this shell, so when one of these is a function
# here the forward hands its definitions over through the shell bridge (lib/ludics/proc.py): a file
# of this shell's functions and variables that each bridged call sources in a fresh bash, which is
# what the shell's own `$(gh ...)` subshell saw. In a plain run none is a function, and nothing is
# written. `sleep` is one of them because a suite's `sleep` OBSERVES the wait (the pauses it logs,
# what it lets happen meanwhile), which only a call can carry; a suite that defines one under
# SHIP_PR_TEST_CLOCK advances that clock in it. The clock itself is never bridged: the Python reads
# SHIP_PR_TEST_CLOCK (lib/ludics/README.md, "the shell bridge").
PY_BRIDGE_COMMANDS=(gh git sleep)

# The stubs, one per subcommand, for a caller that sources this file and calls the function.
cmd_poll() { py_forward call poll "$@"; }
cmd_status() { py_forward call status "$@"; }
cmd_rounds() { py_forward call rounds "$@"; }
cmd_checks() { py_forward call checks "$@"; }
cmd_merge() { py_forward call merge "$@"; }
cmd_merge_build() { py_forward call merge-build "$@"; }
cmd_base() { py_forward call base "$@"; }
cmd_reply() { py_forward call reply "$@"; }
cmd_resolve() { py_forward call resolve "$@"; }
cmd_comment() { py_forward call comment "$@"; }
cmd_body() { py_forward call body "$@"; }
cmd_retry() { py_forward call retry "$@"; }
# In a subshell, unlike the other stubs: `watch` RETURNS its status (1 is a quiet window, not a
# failure), and `py_forward call` exits on any nonzero one, which would end a sourcing caller.
cmd_watch() { (py_forward call watch "$@"); }

# The usage refusal of a reader with no PR, made HERE: bash's own `${1:?}` message names this
# script, the line and the parameter ("<script>: line N: 1: usage: status <pr>"), which the Python
# cannot spell. Exit 1, as before the port; any other argument goes to the Python.
py_usage() { # <subcommand> <its args...>
  local sub="${1:-}"
  shift
  case "$sub" in
  poll) : "${1:?usage: poll <pr> [watermark]}" ;;
  status) : "${1:?usage: status <pr>}" ;;
  rounds) : "${1:?usage: rounds <pr>}" ;;
  esac
}

# This shell's state for the bridge: every function, every variable bash lets a script assign
# (its own read-only and dynamic ones are left out; a declaration the source refuses anyway is
# silenced there), and the two options a command substitution inherits, -u and pipefail. errexit is
# not one of them: bash clears it inside `$(...)`, where the shell's every gh call ran.
py_bridge_state() {
  local __name
  declare -f
  for __name in $(compgen -v); do
    case "$__name" in
    BASH* | FUNCNAME | GROUPS | DIRSTACK | PIPESTATUS | RANDOM | SRANDOM | SECONDS | LINENO | \
      HISTCMD | EPOCHREALTIME | EPOCHSECONDS | PPID | UID | EUID | SHELLOPTS | PWD | OLDPWD | \
      COMP_WORDBREAKS | _ | __name) continue ;;
    esac
    declare -p "$__name" 2>/dev/null
  done
  case "$-" in *u*) echo 'set -u' ;; esac
  case ":${SHELLOPTS:-}:" in *:pipefail:*) echo 'set -o pipefail' ;; esac
}

# A path as the interpreter scripts/py runs will read it: on Git Bash that is a native Windows
# Python, which knows nothing of /usr/bin or /tmp.
py_native_path() {
  case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) command -v cygpath >/dev/null 2>&1 && { cygpath -m "$1"; return; } ;;
  esac
  printf '%s\n' "$1"
}

# <subcommand> <args...>: PY_ARGS, the same words with the ones the Python opens as files in
# native form -- `body`'s file (but `-`), `base --integration-records` and `--advisory-red`, and
# `reply`'s and `comment`'s `--body-file` -- which MSYS would have rewritten had py_forward not
# turned its rewriting off.
py_native_args() {
  local sub="$1" a n=0 next=""
  PY_ARGS=("$1")
  shift
  for a in "$@"; do
    n=$((n + 1))
    if [ -n "$next" ]; then
      next=""
      a=$(py_native_path "$a")
    else
      case "$sub:$a" in
      base:--integration-records) next=1 ;;
      base:--integration-records=*) a="--integration-records=$(py_native_path "${a#--integration-records=}")" ;;
      base:--advisory-red) next=1 ;;
      base:--advisory-red=*) a="--advisory-red=$(py_native_path "${a#--advisory-red=}")" ;;
      reply:--body-file | comment:--body-file) next=1 ;;
      merge:-C | merge-build:-C | merge-build:--config) next=1 ;;
      merge-build:--config=*) a="--config=$(py_native_path "${a#--config=}")" ;;
      reply:--body-file=* | comment:--body-file=*) a="--body-file=$(py_native_path "${a#--body-file=}")" ;;
      body:-) ;;
      body:*) [ "$n" -ne 2 ] || a=$(py_native_path "$a") ;;
      esac
    fi
    PY_ARGS+=("$a")
  done
}

py_forward() { # <exec|call> <subcommand> <args...>
  local how="$1" py pair name state rc fn bridged=""
  local -a env_args=()
  shift
  # Physically, BEFORE going up: the skills call this file through a symlinked skill directory
  # (~/.claude/skills/ship-pr -> <checkout>/ship-pr), and a logical `cd .../../..` would climb out
  # of the link into ~/.claude/skills instead of into the checkout.
  py="$(CDPATH= cd -P "$(dirname "${BASH_SOURCE[0]}")" && cd -P ../.. && pwd -P)/scripts/py"
  [ -x "$py" ] || die "$1 is served by Python since ludics-lite#403, and its runner $py is missing" \
    "or not executable: this copy of pr-review.sh is not inside a ludics-lite checkout. Run the" \
    "checkout's ship-pr/scripts/pr-review.sh. Nothing was read or written."
  for pair in "${PY_FORWARD_VARS[@]}"; do
    name=${pair%%=*}
    env_args+=("${pair#*=}=${!name-}")
  done
  # Under Git Bash, two hand-overs. This bash: the native Python asks it `kill -0` about the MSYS
  # pids in a leftover's name (tmp_sweep_stale), which a Windows process cannot ask about itself.
  # And the words as typed: MSYS rewrites a native program's argument that looks like a POSIX path,
  # so `/repo#1` arrived as `C:/Program Files/Git/repo#1`, and a reply body starting with a slash
  # would be posted rewritten -- words no function of this shell ever saw rewritten. The file
  # arguments are converted here instead (py_native_args). `retry` keeps the rewrite: its words go
  # on to gh, which the shell started directly, rewrite included.
  local -a py_args=("$@")
  case "${OSTYPE:-}" in
  msys* | cygwin*)
    env_args+=("LUDICS_CALLER_SHELL=$(py_native_path "$BASH")")
    if [ "${1:-}" != retry ]; then
      env_args+=("LUDICS_CALLER_ARG_CONV_EXCL=${MSYS2_ARG_CONV_EXCL+=$MSYS2_ARG_CONV_EXCL}")
      env_args+=("MSYS2_ARG_CONV_EXCL=*")
      py_native_args "$@"
      py_args=("${PY_ARGS[@]}")
    fi
    ;;
  esac
  for fn in "${PY_BRIDGE_COMMANDS[@]}"; do
    if declare -F "$fn" >/dev/null; then bridged="$bridged $fn"; fi
  done
  if [ -z "$bridged" ]; then
    [ "$how" != exec ] || exec env "${env_args[@]}" "$py" -m ludics.prreview "${py_args[@]}"
    env "${env_args[@]}" "$py" -m ludics.prreview "${py_args[@]}"
    rc=$?
  else
    # Keyed by the owning pid, like every temporary path pr-review.sh makes, and removed before
    # this returns.
    state=$(mktemp "${TMPDIR:-/tmp}/pr-review-bridge.$$.XXXXXX") ||
      die "could not create the shell bridge's file under ${TMPDIR:-/tmp}; nothing was run"
    py_bridge_state >"$state"
    env "${env_args[@]}" LUDICS_BRIDGE_FUNCS="${bridged# }" \
      LUDICS_BRIDGE_STATE="$(py_native_path "$state")" \
      LUDICS_BRIDGE_SHELL="$(py_native_path "$BASH")" "$py" -m ludics.prreview "${py_args[@]}"
    rc=$?
    rm -f "$state"
  fi
  [ "$rc" -eq 0 ] || exit "$rc"
  return 0
}

# --repo mirrors gh's own flag, so reaching for it out of gh habit works instead of hitting usage.
main() {
  case "${1:-}" in
  --repo) REPO="${2:?--repo owner/name}" && shift 2 ;;
  --repo=*) REPO="${1#--repo=}" && shift ;;
  esac
  case "${1:-}" in
  poll | watch | status | rounds | checks | merge | merge-build | base | reply | resolve | comment | body | retry)
    py_usage "$@"
    py_forward exec "$@"
    ;;
  *) die "usage: pr-review.sh [--repo owner/name] {poll|watch|status|rounds|checks|merge|reply|resolve} <pr> ...
  pr-review.sh [--repo owner/name] merge-build --base <rev> --head <rev> [--config <file>] [-C <dir>]
                                             # merge's build of the would-be merge commit alone,
                                             # a dry run: no PR read, no fetch, no merge
  pr-review.sh comment <pr> <body>           # a plain PR comment (a summary round, a review nudge)
  pr-review.sh reply|comment ... --body-file <path>  # the body from a file, instead of an argument
  pr-review.sh body <pr> <file>              # replace the PR's description from a file, over REST
  pr-review.sh base [owner/name] [branch] [--wait]  # is the base branch's CI green? (start of
                                             # work; --wait = post-merge integration read;
                                             # --integration-records <file>: fleet-worker gate's;
                                             # --advisory-red <file>: the gate's too — a run red
                                             # only in jobs the repository's advisory file names
                                             # is not red, and its jobs go to <file>; the
                                             # interim judges by that file too;
                                             # --interim: a named green while the tip's run is in
                                             # flight — the gate's and the base watch's, never
                                             # the integration loop's)
  pr-review.sh retry [--read] <gh args...>   # any other gh call, same retry policy
  pr-review.sh retry run watch owner/name#<run-id>  # quiet await of ONE run (never forwarded
                                             # to gh); for a PR prefer: checks <pr> --wait
  <pr> is owner/name#number, or a number with --repo/REPO= naming the repo; a bare number with
  no repo named is REFUSED, never resolved from the cwd (a PR number names one PR in every repo).
  The run argument takes the same form, and a bare run id without -R/REPO is refused." ;;
  esac
}

# Focused tests source the functions and replace gh with a fixture transport; do not expose a
# user-facing testing subcommand or make them pass through the unrelated build and merge gates.
[ "${SHIP_PR_TEST_SOURCE_ONLY:-}" = 1 ] || main "$@"
