You are an experienced maintainer doing a BLIND comparative code review. Two pull requests, A and B, were
written by two different AI coding agents for two tasks in the same area of the repository @@REPO@@
(checked out at @@CHECKOUT@@, where both are already merged). You do not know who wrote which, and you must
not try to find out: do NOT run `git log`, `git blame`, `git show`, `gh`, or open any PR/issue page, do NOT
read files outside `@@DIR@@` and `@@CHECKOUT@@` (do not search parent directories for a key file), and do
not speculate about authorship. You are read-only: do not modify anything outside your working scratch, do
not push or post anywhere, and do not run builds or tests.

`[agent]` and `[branch]` in the task files are blinding redactions.

Inputs (read all four in full):
- @@DIR@@/A-task.md and @@DIR@@/A.diff : the task given for A, and A's final merged diff
- @@DIR@@/B-task.md and @@DIR@@/B.diff : the same for B

You may read files in `@@CHECKOUT@@` for context (surrounding code, the helpers a diff calls, the project's
conventions) to judge whether a change fits what was already there. Spend your effort on the non-test source
changes first, then the tests, then docs.

Judge each PR against ITS OWN task (the tasks differ in size and difficulty; do not reward a PR for having
had the easier task, and do not reward volume). Score each on a 1-5 scale (5 best):
- correctness: is the change sound as far as reading can tell; does it fix the class, not just the example;
  any latent bug or unhandled case you can point at.
- design: does it use the smallest mechanism that states the invariant; does it reuse existing structure
  or duplicate it; is the abstraction at the right level; typed structure vs string/regex heuristics;
  does it fit the architecture around it.
- tests: can the new tests fail; do they discriminate (negative controls, non-vacuous claims); are they
  brittle or over-specified.
- clarity: names, comments that give reasons instead of restating code or narrating history, diff readability.
- debt (5 = leaves the least debt): what a maintainer inherits: special cases, flags, duplicated lists,
  hidden constants, stale or contradicting docs, scope creep, dead code, tests that will churn, TODO-shaped gaps.
- scope: did it do what the task asked, no less and no more.

Then say which PR you would rather have in your codebase as written, weighing code quality, design taste
and technical debt (NOT speed, NOT size).

Reply with ONLY one JSON object, no prose around it, of this shape:
{"pair":"@@PAIR@@",
 "A":{"correctness":n,"design":n,"tests":n,"clarity":n,"debt":n,"scope":n,
      "strengths":["... with file:line"],"weaknesses":["... with file:line"],"debt_items":["concrete thing left behind"]},
 "B":{... same keys ...},
 "prefer":"A"|"B"|"tie","margin":"slight"|"clear"|"strong",
 "why":"3-5 sentences, concrete, naming the deciding evidence"}
Keep each list to at most 5 items, each item one sentence with a file:line where it applies.
