## This project: ludics, the skills repo

`@@CHECKOUT@@` is the served skills checkout: every session's skills are read from it, so a branch
switch there breaks every wave launch.

## Project conventions (read before editing)

- `README.md` in the worktree, especially its `## Tests` section: the fixture register and its
  conventions (`test-*` names promise a run; scratch directories have one house shape, with
  `CDPATH= cd "$VAR" && pwd -P` next to `mktemp -d`; the text guards are scanners).
- `.github/workflows/skill-scripts.yml`: the `lint` job and the suite steps. The Git Bash leg is
  `.github/workflows/windows-git-bash.yml` (nightly plus `workflow_dispatch`).
  **Before every push, run `scripts/preflight.sh`** (CI's lint job, locally) slot-wrapped. A red CI
  after approval is the failure this repo keeps paying for.
- A new or changed `test-*` suite needs its register line in README's Tests section and its CI
  steps; `check-prompts.sh` enforces this. Prompt text (SKILL.md, references, the brief template
  under `issue-wave/templates/`, this file) is prompt-checked: run `scripts/check-prompts.sh` on
  any change to it.
- Diagnostic and refusal writers: shell-quote repository-controlled names, and write through
  `printf '%s\n'`, not `echo`. Read path listings from git/ls/find NUL-delimited.
- Facts about a particular project (OCANNL's env var names, its runner's flags) do not get
  hard-coded into this repository's mechanisms: a mechanism here takes them as input (a flag, a
  per-repository config file) and the project states them.
- `issue-wave/scripts/fleet-worker.sh` and `ship-pr/scripts/pr-review.sh` are thin shims over the
  package `lib/ludics` (`fleetworker/`, `prreview/`, ...), run through `scripts/py` (Python >= 3.12).
  `lib/ludics/README.md` maps the package. CI's `python package, pyright and unit tests (ubuntu)`
  job runs strict pyright (`npx --yes pyright@1.1.414` from the checkout root) and
  `scripts/py -m unittest discover -s lib -t lib -p 'test_*.py' -v`; run both, slot-wrapped, before
  every push that touches `lib/`. The shell suites drive the shims end to end: run the ones your
  change reaches. New behaviour gets unit cases in `lib/ludics/tests/` and, where the issue names a
  suite case, a case in the matching shell or Python suite.
- Which suites a `lib/ludics` change reaches: `lib/ludics/README.md`, *Which suites drive each
  module* (check-prompts keeps it naming only modules, suites and sections that exist).
- `issue-wave/scripts/test-fleet-worker.sh` in full is about 1000 assertions and 13-15 minutes on
  the coordinator's box. Run only the sections your change reaches: `test-fleet-worker.sh --list`,
  then `test-fleet-worker.sh <section substring> ...`. The full run is CI's. The same goes for the
  big `ship-pr/scripts/test-pr-review*.sh` suites: run the ones your change reaches (their
  `run_tests` takes exact case names only, never substrings, and refuses anything else with exit
  180).
- This repository merges with `--merge`, so every commit message reaches the main branch: a closing
  keyword with an issue number in one closes that issue.

## Project tests and traps

- This repository has no GPU work: every batch takes `--cpu`. Run only what your change reaches
  (plus the guards), and set `SHIP_PR_TEST_JOBS=4` for `test-post-merge-cleanup.sh`.
- `scripts/test-wake-lab.sh` is special: two concurrent runs on one box reap each other's control
  naps. Run it ONLY under the wave's lock, which serializes it across workers, and under
  `bg-run.sh spawn`, since it can outlast the cap:

      cd "@@WT@@" && ~/.claude/skills/issue-wave/scripts/bg-run.sh spawn "@@SCR@@/runs" -- /usr/bin/lockf -k "@@WAVE_DIR@@/scratch/test-wake-lab.lock" ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot --cpu --wait 3600 -- bash scripts/test-wake-lab.sh

- **Your `/bin/bash` runs are the macOS coverage per merge.** The macOS suites run weekly and on
  dispatch in `.github/workflows/macos-weekly.yml`, not on PR heads or pushes (#974). So before
  merging, run under `/bin/bash` (3.2, the macOS runner's shell), slot-wrapped, every suite your
  change reaches: the suites whose files you change, the suites `lib/ludics/README.md` maps to each
  module you change, and the `test-fleet-worker.sh` sections the change reaches. Report those runs.
  A change only macOS exercises dispatches `gh workflow run macos-weekly.yml --ref @@BR@@` and
  cites the run.
