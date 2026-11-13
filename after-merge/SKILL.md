---
name: after-merge
description: After a PR is reviewed and merged, brainstorm what about the project could be improved, grounded in the experience of implementing that PR, and route each idea to an issue, a task chip, or the bin. Use right after merging, or when asked what a piece of work suggests about the codebase.
---

# After-merge brainstorm

Runs as the last step of: implement -> review -> merge -> **brainstorm**. The ideas it produces
become the issues and chips that start the next cycle, which is what makes the loop
self-propelling; no scheduler is involved.

## Inputs (all already at hand — do not reconstruct them from logs)

- The merged diff: `gh pr diff <n> -R <owner>/<repo>`, or `git diff <base>...<head>`.
- The review threads on the PR, including anything you pushed back on and why:
  `gh api repos/<owner>/<repo>/pulls/<n>/comments --jq '.[] | {path,line,body}'`
  (inline review comments are a different surface from `gh pr view --comments`; read both).
- **The session transcript** — the friction that never reached an artifact: dead ends, greps you
  had to run three times, a test that was awkward to express, a fact you had to rediscover. This
  is the richest input, and it is only available while the working session is still in context.
- The commit series (`git log --oneline <base>..<head>`), which shows where the work resisted its
  own decomposition.

## The grounding rule

**Every item must name the concrete thing in THIS implementation that precipitated it.** If you
could have written the item without doing the work, it is not grounded — drop it. Generic
codebase advice is the failure mode: it reads plausible, costs attention, and would have been
just as writable before the work started.

Two or three well-grounded items beat ten. This is a brainstorm, not an audit.

## Dispositions

Sort each idea into exactly one, and say which:

- **File it** — a real improvement with evidence behind it. `gh issue create -R <owner>/<repo>`.
  Match the tracker's existing title style; prefer a specific claim over a topic ("gradients are
  silently wrong for overlapping windows" beats "gradient issues"). Body: what the work ran into,
  why it is worth fixing, and what a fix would touch.
- **Chip it** — small, immediately actionable, no open design question. Spawn a background task
  with a self-contained prompt (file paths and enough context to act without this conversation)
  through the harness's task tool, such as `spawn_task` under Claude Code or `create_thread` in
  Codex Desktop, not an in-session subagent, which is neither persistent nor user-visible. If the
  harness has no such tool, do not improvise a substitute: surface the item in your report as a
  **chip candidate**, prompt included.
- **Drop it, with the reason** — state the reason in the report so the same idea is not re-raised
  next cycle. Dropping is the common case.

## Hand-back mode (delegated workers)

A worker running under a coordinator — a wave agent, a Codex worker — runs the brainstorm but
hands the dispositions back instead of executing them. Tracker mutations (issues, comments,
chips) belong to the coordinator, which sees every worker's hand-back at once and can revise
drafts, combine overlapping proposals into one issue, and spot recurrence across workers that
no single worker can see. In this mode:

- The grounding rule and the dedup read below still apply in full — the brainstorm itself is
  the part only the worker can do, since the friction lives in its transcript.
- Per item, the close-out carries: the grounding, the *proposed* disposition, and the draft
  artifact — issue title+body in the tracker's style, chip prompt, or the existing issue
  number new evidence should be commented on.
- A fourth disposition exists in this mode: a **checklist item**, for polish with no behaviour
  change (a comment, a test's name, a helper worth sharing). Propose it as one line, the claim
  and where it is, in place of an issue draft or a chip. The coordinator keeps one checklist
  issue for a wave's items and batches what is worth doing. An item that could change a result
  is never one: it is an issue.
- File nothing, comment nothing, spawn nothing. Drops are still stated with their reason, so
  the coordinator does not re-raise what the worker already binned.

The default — no coordinator, working directly with the user — is **completion mode**: execute
the dispositions as written above.

## Deduplicate first

Read the open issues before filing: `gh issue list -R <owner>/<repo> --state open --limit 200
--json number,title`. If this PR hit the symptom of an existing issue, add a **comment with the
new evidence** rather than opening a duplicate. Recurrence is the prioritization signal: an issue
that accumulates sightings is one that keeps costing real time.

Note that the issue tracker is not always the repo the PR landed in — a staging fork typically
carries the PRs while the upstream carries the issues. Confirm which is which before filing.
Example pairing: PRs in `lukstafi/ocannl-staging`, issues in `ahrefs/ocannl`.

## Out of scope

- Engineering lore ("always test X", "remember that Y") does not belong here. That material goes
  to the project's agent-notes or equivalent, through ordinary review, and the bar is high: most
  such candidates do not survive it.
- No state directory, no result JSON, no staging file, no scheduled run.

## Report

A short list: item, the friction that grounds it, the disposition. Then the issue URLs created or
commented on, and the chips spawned or handed up as candidates. Optionally — in completion mode
only — post the brainstorm itself as a comment on the merged PR first, so each filed issue can
cite it and the idea keeps its provenance. In hand-back mode that comment too is the
coordinator's to post after its editorial pass: an uncombined draft published early defeats the
pass.
