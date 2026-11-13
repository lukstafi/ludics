## Landing: ship-pr

Load and follow the ship-pr skill, reading its SKILL.md in stages as its preamble's **What to read
when** paragraph says, never the whole file. Its script is
`~/.claude/skills/ship-pr/scripts/pr-review.sh` (`poll`, `watch`, `status`, `checks`, `merge`,
`reply`, `resolve`, `comment`, `rounds`, `base`). This is PR work to `@@REPO@@`, never a direct push
to `@@MAIN@@`.

- Commit early and often; commits survive every failure mode. Commit messages end with the
  project's `Co-Authored-By:` trailer crediting YOUR OWN model, not the coordinator's.
- **Local review before opening:** `~/.claude/skills/ship-pr/scripts/pr-review.sh local-review
  origin/@@MAIN@@` from your worktree, as ship-pr's *Open* says (it finds the merge base itself,
  refuses with nothing launched when it cannot, and carries the no-tests line in the review's own
  prompt), as a long run (*Blocking rule*; it can take several minutes). Fix each finding or rebut it, and
  list them in a "Local Codex review" section of the PR body. Never run it while a batch of yours is
  in flight.
- Before opening, run `gh pr list --repo @@REPO@@ --state open` and search for your issue numbers or
  topic. On a hit, adopt that PR instead of opening a competitor, and say so in your report.
- Rebase onto `origin/@@MAIN@@` before opening (siblings are landing all day), and again if `merge`
  reports conflicts. Sibling workers edit nearby files (your task section names them); expect it.
- PR body: what and why, the verification you ran with its evidence (run directories, and each
  leg's box), the decisions you made, and a `Closes @@ISSUE_REPO@@#<N>` line for each issue this PR
  fully resolves, ON ITS OWN LINE, never inside a sentence (GitHub binds a closing keyword to every
  issue reference in its sentence). Never write a closing keyword with an issue number in a commit
  message. Reference an issue you do not close with no keyword.
- CI wait: to wait for a PR's CI, use `pr-review.sh checks @@REPO@@#<pr> --wait` as a long run:
  it settles on the required checks and leaves the advisory jobs out. Never use `gh run watch`,
  which waits for the whole workflow, advisory jobs included; use `--check '<ERE>'` only to wait on
  one named job (ludics#1026). Add `--settle` when you will fix every red before re-pushing: it keeps
  waiting past the first red until every required check settles, then reports all reds at once
  (ludics#1039). Never write a polling loop of your own around `gh run view` or `gh pr checks`
  either: the script's waits share one request budget across the fleet, and a loop outside it
  drains the fleet's quota (ludics#1111).
- A red you judge a flake: `pr-review.sh rerun @@REPO@@#<pr>` lists the head's runs, and
  `pr-review.sh rerun @@REPO@@#<pr> <run id>...` re-runs the failed jobs of the ones you name,
  inside that budget. Then wait with `checks --wait` again. Never call `gh run rerun` yourself.
- Review loop: `pr-review.sh watch` (a long run) waits for the reviewer's round. Answer every
  thread with a fix or a rebuttal, `reply` and `resolve` per thread, and push once per CI cycle. If
  the watch goes quiet suspiciously long, read the feed directly (`gh pr view <pr> --repo @@REPO@@
  --comments`) rather than re-arming it.
- **A stalled round**: `watch` nudges a STALLED round itself, once per head, when no 👍, no verdict
  and no request stands for the head, and keeps watching. If `status` or a watch's exit still reads
  STALLED, FIRST read the full PR feed yourself: the reviewer's no-findings verdict can arrive as a
  plain comment ("Didn't find any major issues ... Reviewed commit: <sha>"), and a re-request CLEARS
  an existing 👍. If the feed holds no verdict and no 👍 for the current head, post ONE nudge
  yourself, `pr-review.sh comment @@REPO@@#<pr> '@codex review'`, and re-arm the watch. No
  coordinator permission is needed. Never re-request while an approval may stand.
- Convergence (from round 3 if round 1 had five or more findings, else from round 5): classify
  findings as silent or loud.
  - A silent defect (a claim that cannot fail, a sweep deleting what it should not, an oracle an
    accident satisfies) is must-fix through round twelve.
  - A loud one (a false refusal on a valid-but-absent shape) defers to ONE follow-up issue proposed
    in your hand-back and named in the PR. A silent finding reachable only by code nobody has
    written defers too.
  - Defects in machinery the review itself introduced are yours to fix through round 12.
  - From the thirteenth round with findings, fix only blocking findings (ship-pr's *When the loop
    ends*) and defer the rest to that one issue.

  Consider REMOVING a hardening the review introduced rather than hardening it a fourth time. When
  the reviewer approves only by finding nothing, and the last rounds are confined to machinery the
  review introduced, merge on substance: CI green on the final head, every thread answered with its
  classification, and a review-record paragraph in the body.
- `merge`: the plain `~/.claude/skills/ship-pr/scripts/pr-review.sh merge @@REPO@@#<pr> --wait`,
  as a long run. Set no `SHIP_PR_ADVISORY_CHECKS`. If it cannot get a verdict because the CI
  queue is deep, raise `SHIP_PR_CHECKS_WAIT` and keep waiting inside the turn. Do not use
  `--allow-no-verdict`.
- **Your verification ends at your own merge.** Do not watch the main branch's later CI; that is
  the coordinator's integration loop. At most, read the run for your own merge commit once.
