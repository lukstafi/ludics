#!/usr/bin/env bash
# CI's lint job, runnable before you push. Every assertion the `lint` job of
# .github/workflows/skill-scripts.yml makes lives here, and the job runs it by calling this script
# rather than by restating it -- so what a push is judged by and what the local loop runs are one
# command, and a change to either is a change to both (ludics-lite#221, #123).
#
# Usage: preflight.sh [--root DIR] [--require-tools] [--as-ci] [--guards all|changed|none]
#                     [--base REF] [STEP|GUARD...]
#        preflight.sh steps | globs | files | guards
#
# With no STEP it runs them all, each one whether or not an earlier one failed -- the workflow's
# `if: !cancelled()` shape -- and prints a summary. Exit 0 when nothing failed, 1 when something
# did, 2 on a usage error or a scope that describes nothing.
#
#   - syntax           bash -n over every tracked script (THE FILE LIST below; inside a git work
#                      tree the scope is what git holds, which is what a push carries)
#   - modes            the two-way mode rule: a script is executable, an *.example.sh is not
#   - shellcheck       shellcheck --severity=error --external-sources over the same list
#   - powershell       pwsh parses scripts/*.ps1, and refuses to judge zero of them
#   - parse-guard      scripts/check-parse-guards.sh (every suite's brace group, ludics-lite#247)
#   - parse-fixtures   scripts/test-check-parse-guards.sh
#   - prompts          scripts/check-prompts.sh (the prompt-hygiene job's check, not lint's:
#                      a missing register line for a new suite is the other thing a push goes red
#                      for, and it is free to run here)
#   - jq-shapes        scripts/check-jq-shapes.sh
#   - jq-fixtures      scripts/test-check-jq-shapes.sh
#   - scratch-dirs     scripts/check-scratch-dirs.sh
#   - scratch-fixtures scripts/test-check-scratch-dirs.sh
#   - preflight-fixtures scripts/test-preflight.sh (this script's own controls; the lint job runs
#                      them too, so leaving them out here made the local command a subset of CI)
#   - jq-version       the jq on PATH is the fleet's minor, 1.8 (ludics-lite#508), and says which
#                      jq it found and where
#
# THE GUARDS are the other half of a push's verdict: the suites of CI's `small guards (ubuntu)`
# job (`prompts` in the workflow) that the steps above do not already run. A prose edit to a skill
# can pass every step here and still fail one of them -- PR #544 dropped a literal that the
# prompt checker's suite needs ship-pr/SKILL.md to carry, and went red in CI after a clean
# preflight (ludics-lite#553). They are not steps, because they take minutes rather than seconds
# and most pushes cannot break them; which of them run is --guards MODE:
#   - changed  (the default when no STEP is named) each guard with a file trigger runs when a
#              tracked file matching it differs from the merge base of --base REF (default
#              origin/main) and HEAD -- committed, staged or only edited, since that is what the
#              push will carry. A checkout where that cannot be told (no such REF, not a git
#              work tree) runs them: a guard skipped on a guess is the miss this exists to end.
#   - all      every guard, which is what the small-guards job runs on every head.
#   - none     no guard (the default when a STEP is named, so `preflight.sh syntax` stays one
#              step and CI's lint job, which names its steps, runs none).
# A GUARD named on the command line runs whatever the mode. The table (`preflight.sh guards`):
#   - prompt-fixtures      lib/ludics/tests/test_checkprompts_cli.py, run through scripts/py, on any
#                          *.md: check-prompts.sh reads every SKILL.md, both index READMEs and
#                          (its slot count) every *.md, and its suite reads the live
#                          ship-pr/SKILL.md's shape -- wider than the
#                          ship-pr/, issue-wave/ and routines/ the issue named, which miss the
#                          root README and the other skills. Also on the checker's code and the
#                          live scripts the suite reads: fleet-worker.sh's SLOTS, sync-routines.sh's
#                          LOCAL_ROUTINES, post-merge-cleanup's usage (the table names them)
#   - routines-fixtures    scripts/test-sync-routines.sh, on routines/*.md: its pin compares the
#                          routines table with sync-routines.sh; and on that script and the checker
#   - reporters            scripts/test-workflow-reporters.py   } no file trigger: a Markdown
#   - nudge-fixtures       ship-pr/hooks/test-ship-pr-nudge.py  } edit cannot break them, so they
#   - base-helper-fixtures scripts/test-run-against-base.sh     } run under --guards all or by
#   - py-wrapper           scripts/test-py.sh                   } name, and CI runs them always
# scripts/test-preflight.sh pins the table to the job: every guard is a step of it, and every
# step of it is a guard or one of the steps above.
#
# MISSING TOOLS. Without --require-tools a step whose interpreter is absent is SKIPped by name and
# does not fail the run: pwsh is on neither fleet mac, and a preflight that goes red for a tool
# the reader cannot install is a preflight the reader stops running. CI passes --require-tools, so
# an image that loses pwsh or shellcheck is a red step there rather than a quiet pass. A step named
# on the command line is still only skipped under that rule -- the flag, not the form, decides.
#
# A WRONG jq IS A WARNING HERE AND A FAILURE IN CI, by the same flag. jq 1.7.1 and 1.8 parse
# `A and X as $b | B` differently, and macos-latest's 1.8 turned a PR red that no fleet box could
# reproduce on its 1.7.1 (ludics-lite#508), so the fleet and CI run 1.8. Locally another minor is
# a named WARN that leaves the exit status alone: no step here evaluates a jq program, so the
# box's jq changes none of this script's verdicts, and a red the push will not have is what teaches
# the reader to stop running the preflight. The warning is for the suites, which do run jq, and it
# names the jq it found and where -- on mac-studio a clean `bash -l` puts /usr/bin (Apple's 1.7.1)
# before Homebrew's. Under --require-tools, which is where CI pins the binary, it is red.
#
# --root DIR judges DIR instead of this script's own checkout. It is how scripts/test-preflight.sh
# puts a defective tree in front of each assertion; nothing else needs it.
#
# --as-ci exports GITHUB_ACTIONS=true for the run, so a refusal takes the `::error file=` annotation
# form the lint job prints instead of the sentence, and every step script inherits the variable
# the way it does on a hosted runner. It exists because a control can read that variable by
# accident and pass everywhere but CI: PR #275's `preflight fixtures` step went red on exactly
# that, and no local run could reproduce it until the fixture was rewritten. It does not imply
# --require-tools; pass both to run what CI runs.
#
# `steps` prints "name<TAB>command<TAB>tool" per step (`-` for one implemented here, an empty tool
# for one that needs nothing beyond this shell), `globs` the file-list
# patterns, `files` the paths they expand to in the judged checkout, `guards`
# "name<TAB>command<TAB>trigger" per guard (an empty trigger for one with none). They are the read-only half of
# "one place": scripts/test-preflight.sh pins the step table against the lint job's steps, and
# issue-wave/scripts/test-fleet-worker.sh reads `globs` for its lint-coverage guard rather than
# re-deriving the list from the YAML the way it did while the list lived there.

set -uo pipefail

# Every pathspec this script hands git -- the file list's `*.sh`, the guard triggers -- means git's
# default reading, a `*` that crosses `/`. These variables change that reading for every git call:
# under GIT_LITERAL_PATHSPECS `*.md` is a file named `*.md`, so a guard trigger matched nothing and
# the guard was reported not run while Markdown had changed. Unset, not checked: no caller means
# them for this script, and the suites it runs inherit the same reading.
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS

FILES=()

# THE FILE LIST, once. It was spelled three times in the lint job's YAML -- by the syntax step,
# the mode-bit step and the one that runs shellcheck -- and hand-copied a fourth time into a
# scratch buffer by anyone pre-flighting a push (ludics-lite#123). scripts/check-jq-shapes.sh and scripts/check-scratch-dirs.sh still restate it
# for their own default sweeps, which is ludics-lite#246 and not fixed here; they can read `globs`
# the day that is taken. Unquoted below on purpose: these are patterns for the shell to expand,
# with the same rules the workflow's own `for f in */scripts/*.sh ...` had -- a leading `.` is not
# matched, so a script under .github/scripts/ is genuinely outside CI's lint and reported as such
# rather than quietly covered.
GLOBS=('*/scripts/*.sh' 'ship-pr/hooks/*.sh' 'scripts/*.sh')

# THE STEP TABLE: `name:command`, with `-` where the assertion is implemented in this file. The
# commands are the scripts CI's lint job already invokes by path; running them from here too is
# what makes one command cover the whole job. test-preflight.sh reads this table and the workflow
# and refuses a step that is in one and not the other.
STEPS=(
  'syntax:-'
  'modes:-'
  'shellcheck:-'
  'powershell:-'
  'parse-guard:scripts/check-parse-guards.sh'
  'parse-fixtures:scripts/test-check-parse-guards.sh'
  'prompts:scripts/check-prompts.sh'
  'jq-shapes:scripts/check-jq-shapes.sh'
  'jq-fixtures:scripts/test-check-jq-shapes.sh'
  'scratch-dirs:scripts/check-scratch-dirs.sh'
  'scratch-fixtures:scripts/test-check-scratch-dirs.sh'
  'preflight-fixtures:scripts/test-preflight.sh'
  'jq-version:-'
)

# THE GUARD TABLE: `name:command:trigger`, the trigger space-separated git pathspecs (a `*`
# crosses `/`) or empty. A `.py` command runs under python3, as the job runs it, and one under lib/
# runs as the job runs it too: `scripts/py -m unittest <module>`, named from its path. A suite's
# trigger is every input that can turn it red, not only its subject: its own file, the code it
# runs, and whatever it reads from the live checkout.
# CHECKER: what check-prompts.sh runs, which both prompt suites run.
CHECKER='scripts/check-prompts.sh scripts/py lib/ludics/__init__.py lib/ludics/proc.py lib/ludics/checkprompts/*'
GUARDS=(
  "prompt-fixtures:lib/ludics/tests/test_checkprompts_cli.py:*.md lib/ludics/tests/test_checkprompts_cli.py $CHECKER issue-wave/scripts/fleet-worker.sh scripts/sync-routines.sh ship-pr/scripts/post-merge-cleanup.sh lib/ludics/postmergecleanup/*"
  "routines-fixtures:scripts/test-sync-routines.sh:routines/*.md scripts/test-sync-routines.sh scripts/sync-routines.sh $CHECKER"
  'reporters:scripts/test-workflow-reporters.py:'
  'nudge-fixtures:ship-pr/hooks/test-ship-pr-nudge.py:'
  'base-helper-fixtures:scripts/test-run-against-base.sh:'
  'py-wrapper:scripts/test-py.sh:'
)

# The jq minor the fleet and CI run (ludics-lite#508). CI pins the patch in
# .github/actions/setup-jq/action.yml and the Linux installer in scripts/install-linux.sh;
# scripts/test-preflight.sh holds both to this minor.
JQ_MINOR=1.8

# The read-only words `steps`, `globs` and `files` are dispatched before any step is, so a step
# that took one of those names would be answered by the query and never run -- and the workflow
# pin would still read it as a step CI invokes (round 10). A name used twice is the same failure
# from the other end: the lookup answers with the first entry, so the default run would run one
# command twice and the other never, with both paths still in `steps` for the pin to accept. Both
# are refused here, before anything is judged, because a table that does not mean what it says is
# not something to run a check from.
QUERY_WORDS='steps globs files guards'

# The guards share the steps' namespace, since either may be named on the command line, and are
# validated with them.
validate_table() {
  local entry name seen=' '
  for entry in "${STEPS[@]}" "${GUARDS[@]}"; do
    name=${entry%%:*}
    case "$seen" in
    *" $name "*) die "the step table names '$name' twice: the lookup would answer with the first entry and the second would never run" ;;
    esac
    case " $QUERY_WORDS " in
    *" $name "*) die "the step table names '$name', which is a read-only query word ($QUERY_WORDS): the query would answer and the assertion would never run" ;;
    esac
    seen="$seen$name "
  done
}

usage() { # the leading comment block, which is this script's manual
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

die() { # die <message>: a usage error or a scope that describes nothing
  printf 'preflight.sh: %s\n' "$1" >&2
  exit 2
}

# A refusal about a file in the checkout. Under GitHub Actions it is an annotation on that file's
# line of the diff, which is what the inline steps printed and is worth keeping; anywhere else the
# annotation syntax is noise in front of the sentence, so the sentence is printed on its own.
fail_file() { # fail_file <path> <message>
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::error file=%s::%s\n' "$1" "$2"
  else
    printf 'preflight: %s: %s\n' "$1" "$2"
  fi
}

step_command() { # step_command <name>: the external command, `-`, or empty when there is no such step
  local entry
  for entry in "${STEPS[@]}"; do
    if [ "${entry%%:*}" = "$1" ]; then
      printf '%s' "${entry#*:}"
      return 0
    fi
  done
  return 1
}

guard_field() { # guard_field <name> <2|3>: the guard's command or trigger; 1 when there is no such guard
  local entry rest
  for entry in "${GUARDS[@]}"; do
    if [ "${entry%%:*}" = "$1" ]; then
      rest=${entry#*:}
      case "$2" in
      2) printf '%s' "${rest%%:*}" ;;
      3) printf '%s' "${rest#*:}" ;;
      esac
      return 0
    fi
  done
  return 1
}

is_tracked() { # is_tracked <path>: is it one of the paths git carries?
  local tracked
  for tracked in ${TRACKED_FILES[@]+"${TRACKED_FILES[@]}"}; do
    [ "$tracked" = "$1" ] && return 0
  done
  return 1
}

collect_files() { # fills FILES with the paths the globs expand to, relative to the judged checkout
  local pattern path matched
  [ "${#FILES[@]}" -eq 0 ] || return 0
  # THE SCOPE IS WHAT A PUSH CARRIES. Inside a git work tree the expansion is intersected with the
  # paths git holds -- the index included, so a `git add`ed file is judged before it is committed.
  # `actions/checkout` contains no untracked file, so a scratch `scripts/probe.sh` an agent left
  # in a worktree is not something CI will ever open, and going red over it would make the local
  # command and the CI command disagree in the one direction that matters: a red the push does not
  # have is what teaches the reader to stop running the preflight (round 5).
  # The scope is which PATHS are judged; the bytes judged are the ones on disk, which is what a
  # commit of this tree will carry and what every other check in this repository reads. Staging a
  # file and then editing it without staging the edit is therefore judged as the edit, not as the
  # index -- reading index bytes would mean judging content no path holds, leaving the
  # diagnostics of bash and of the linter pointing at lines the reader cannot open (round 6,
  # rebutted).
  # issue-wave/scripts/test-fleet-worker.sh's coverage guard reads tracked paths for this reason
  # and said so first. Outside a work tree -- the scratch checkouts scripts/test-preflight.sh
  # builds, and any unpacked copy -- the filesystem is the list, which is also the fixtures' way
  # of judging trees git knows nothing about.
  TRACKED_FILES=()
  TRACKED_SCOPE=
  # The judged root must BE the work tree root, not merely sit inside one: a scratch tree created
  # under a checkout (`--root ./tmp-fixture`, or a TMPDIR that lives there) is inside a work tree
  # that tracks none of it, so asking git about it would filter every file away and refuse a tree
  # the filesystem mode judges perfectly well (round 9).
  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) &&
    toplevel=$(CDPATH= cd "$toplevel" 2>/dev/null && pwd -P)
  if [ -n "${toplevel:-}" ] && [ "$toplevel" = "$ROOT" ]; then
    TRACKED_SCOPE=1
    # NUL-delimited, since a tracked path may hold anything but a NUL. The pathspec's `*` crosses
    # `/`, so one pattern reaches every depth.
    while IFS= read -r -d '' path; do
      TRACKED_FILES+=("$path")
    done < <(git ls-files -z -- '*.sh')
  fi
  for pattern in "${GLOBS[@]}"; do
    matched=0
    # Unquoted: this is pathname expansion, the workflow's own. An unmatched pattern arrives as
    # itself, which the existence test drops. A BROKEN SYMLINK is kept, which `-f` would not have
    # been: `-f` follows the link, so a dangling one read as "no such path" and was dropped from
    # every sweep in silence -- while the inline `for f in */scripts/*.sh; do bash -n "$f"; done`
    # this replaced handed it to bash and went red. A path that exists as a link is a path this
    # list owes a verdict on, and bash and shellcheck both refuse it loudly (round 1).
    for path in $pattern; do
      { [ -e "$path" ] || [ -L "$path" ]; } || continue
      [ -z "$TRACKED_SCOPE" ] || is_tracked "$path" || continue
      FILES+=("$path")
      matched=1
    done
    # Fail closed per PATTERN, not merely when the whole sweep is empty: the inline loops this
    # replaced handed an unmatched pattern to bash and shellcheck as the literal it arrives as,
    # and went red. Dropping it silently would let the last ship-pr/hooks script move away while
    # the other two patterns keep FILES nonempty and every step green over a scope that has
    # stopped describing the checkout (round 2). A pattern that should no longer match is an edit
    # to this list, which is the whole point of the list being here.
    [ "$matched" -eq 1 ] ||
      die "no ${TRACKED_SCOPE:+tracked }file matched $pattern under $ROOT -- the file list has stopped describing the checkout"
  done
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- the assertions --------------------------------------------------------------------------

step_syntax() {
  local f rc=0
  collect_files
  for f in "${FILES[@]}"; do
    bash -n "$f" || {
      fail_file "$f" "$f does not parse: 'bash -n' refused it"
      rc=1
    }
  done
  return "$rc"
}

# The two-way mode rule. A `> tmp && mv` rewrite of a script drops its mode bit and git tracks the
# mode, so the drop commits; without this the first symptom is an `exit 126` from a suite in some
# other job, which reads as that suite failing rather than as a lost mode bit. The suffix names the
# sourced template: an `*.example.sh` is `.`-ed by the script that reads it
# (scripts/wake-lab-hosts.example.sh, sourced by wake-lab.sh) and is never executed, so it is
# tracked 100644 on purpose. That half is asserted rather than merely exempted, because the pass
# the suffix buys is sound only while the class really is the sourced one: a future `*.example.sh`
# written to be run would otherwise skip the mode check in silence, and a stray `chmod +x` on a
# template would void the convention. The PowerShell scripts are outside the list entirely -- they
# are `.ps1`, and the powershell step parses them rather than running them.
step_modes() {
  local f rc=0
  collect_files
  for f in "${FILES[@]}"; do
    case "$f" in
    *.example.sh)
      if [ -x "$f" ]; then
        fail_file "$f" "$f is an .example.sh: it is sourced, never executed, so it must NOT be executable (the mode check gives the suffix a pass on that assertion, and the pass is only sound if the class is really the sourced one); run 'chmod -x $f' and commit it"
        rc=1
      fi
      ;;
    *)
      if [ ! -x "$f" ]; then
        fail_file "$f" "$f is not executable; restore the mode bit with 'chmod +x $f' and commit it"
        rc=1
      fi
      ;;
    esac
  done
  return "$rc"
}

# Errors only: the warning tier is style and a few false positives on deliberately unquoted globs;
# the error tier is what breaks a script.
step_shellcheck() {
  collect_files
  shellcheck --severity=error --external-sources "${FILES[@]}"
}

# Parse the Windows repair scripts without executing their Windows-only networking and registry
# commands. The glob is what keeps this honest: enable-active-hours-windows.ps1 joined
# enable-wol-windows.ps1 there, and a third repair script must not need an edit here to be judged.
# Only `scripts/*.ps1` -- the PowerShell under a skill directory
# (issue-wave/scripts/test-windows-driver.ps1) is really EXECUTED by the windows-driver job, which
# is a stronger check than parsing it twice. A glob matching nothing is a refusal, not a pass: a
# parse check judging zero files should be red.
step_powershell() {
  pwsh -NoProfile -Command '
    $rc = 0
    $files = @(Get-ChildItem -Path "scripts" -Filter "*.ps1" | Sort-Object Name)
    if ($files.Count -eq 0) {
      Write-Error "no scripts/*.ps1 found: the parse check is judging nothing"
      exit 1
    }
    foreach ($f in $files) {
      $tokens = $null
      $errors = $null
      [System.Management.Automation.Language.Parser]::ParseFile(
        $f.FullName,
        [ref] $tokens,
        [ref] $errors
      ) > $null
      if ($errors.Count -ne 0) {
        $errors | ForEach-Object { Write-Error "$($f.Name): $_" }
        $rc = 1
      } else {
        Write-Host "$($f.Name): parsed"
      }
    }
    exit $rc
  '
}

# The jq on PATH, by its own `--version`: 0 when it is JQ_MINOR, 4 (a warning) when it is not and
# --require-tools was not given, 1 when it was. A native jq.exe ends the line CRLF, hence the `tr`.
# The match is the minor and then a `.`, a `-` or the end, so `jq-1.80` is not 1.8.
step_jq_version() {
  local path version why
  path=$(command -v jq)
  version=$(jq --version 2>&1 | tr -d '\r')
  case "$version" in
  "jq-$JQ_MINOR" | "jq-$JQ_MINOR."* | "jq-$JQ_MINOR-"*)
    printf 'preflight: jq-version: %s at %s\n' "$version" "$path"
    return 0
    ;;
  esac
  why="$path says '$version', not jq $JQ_MINOR.x, which the fleet and CI run (ludics-lite#508). On a mac: brew install jq; on Linux or WSL: scripts/install-linux.sh --jq"
  if [ -n "$REQUIRE_TOOLS" ]; then
    printf 'preflight: jq-version: %s\n' "$why"
    return 1
  fi
  printf 'preflight: jq-version: WARN (%s)\n' "$why"
  return 4
}

# --- running them ----------------------------------------------------------------------------

# The interpreter each step needs, empty when it needs nothing beyond this shell.
step_tool() { # step_tool <name>
  case "$1" in
  syntax) printf 'bash' ;;
  shellcheck) printf 'shellcheck' ;;
  powershell) printf 'pwsh' ;;
  jq-version) printf 'jq' ;;
  # A lib/ unit file runs through scripts/py, which finds its own interpreter or fails the step.
  *) case "$(guard_field "$1" 2)" in lib/*) ;; *.py) printf 'python3' ;; esac ;;
  esac
}

run_step() { # run_step <name>: 0 pass, 1 fail, 3 skipped, 4 passed with a warning
  local name="$1" cmd tool
  cmd=$(step_command "$name") || cmd=$(guard_field "$name" 2) ||
    die "no such step: $name (run 'preflight.sh steps' or 'preflight.sh guards')"
  tool=$(step_tool "$name")
  if [ -n "$tool" ] && ! have "$tool"; then
    if [ -n "$REQUIRE_TOOLS" ]; then
      printf 'preflight: %s: FAIL (%s not found, and --require-tools was given)\n' "$name" "$tool"
      return 1
    fi
    printf 'preflight: %s: SKIP (%s not found; CI runs this step with --require-tools)\n' "$name" "$tool"
    return 3
  fi
  # The fixture suite runs this script, so this script running it must not start a third copy.
  # The suite's default-mode calls (no STEP named) judge scratch trees that hold no
  # scripts/test-preflight.sh, so the loop does not form today; under a preflight run the suite
  # carries PREFLIGHT_IN_FIXTURES (set below), and this guard is what stops a later call that
  # reaches a real copy of the suite, which would otherwise fork until the box gave out (round 7).
  if [ "$name" = preflight-fixtures ] && [ -n "${PREFLIGHT_IN_FIXTURES:-}" ]; then
    printf 'preflight: %s: FAIL (already running inside %s; a suite that runs this script must not be run by it again)\n' \
      "$name" "$cmd"
    return 1
  fi
  if [ "$cmd" != '-' ]; then
    # Fail closed on a step whose script is not there: CI's own step would be a red `No such file`,
    # and a local pass over a check that did not run is the failure this script exists to end.
    case "$cmd" in
    lib/*.py)
      if [ ! -f "$cmd" ]; then
        printf 'preflight: %s: FAIL (%s is not there)\n' "$name" "$cmd"
        return 1
      fi
      local module=${cmd#lib/}
      module=${module%.py}
      scripts/py -m unittest "$(printf '%s' "$module" | tr / .)"
      ;;
    *.py)
      if [ ! -f "$cmd" ]; then
        printf 'preflight: %s: FAIL (%s is not there)\n' "$name" "$cmd"
        return 1
      fi
      python3 "./$cmd"
      ;;
    *)
      if [ ! -x "$cmd" ]; then
        printf 'preflight: %s: FAIL (%s is not there or not executable)\n' "$name" "$cmd"
        return 1
      fi
      if [ "$name" = preflight-fixtures ]; then
        PREFLIGHT_IN_FIXTURES=1 "./$cmd"
      else
        "./$cmd"
      fi
      ;;
    esac
  else
    case "$name" in
    syntax) step_syntax ;;
    modes) step_modes ;;
    shellcheck) step_shellcheck ;;
    powershell) step_powershell ;;
    jq-version) step_jq_version ;;
    # A `case` that matches nothing exits 0, so an entry added to the table as `name:-` whose arm
    # was never written would print PASS having run nothing -- a claim that cannot fail, and
    # exactly the registration drift this file exists to refuse (round 3). The table is the
    # registration; this arm is what makes it mean something.
    *)
      printf 'preflight: %s: FAIL (the step table names it and no assertion here implements it)\n' "$name"
      return 1
      ;;
    esac
  fi
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'preflight: %s: PASS\n' "$name"
    return 0
  fi
  # Only the jq-version step warns; a 4 from any step's script is that script failing.
  if [ "$rc" -eq 4 ] && [ "$name" = jq-version ]; then
    return 4
  fi
  printf 'preflight: %s: FAIL (exit %s)\n' "$name" "$rc"
  return 1
}

# --- arguments -------------------------------------------------------------------------------

ROOT=
REQUIRE_TOOLS=
AS_CI=
GUARDS_MODE=
BASE_REF=origin/main
WANTED=()
while [ "$#" -gt 0 ]; do
  case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  --root)
    [ "$#" -ge 2 ] || die "--root needs a directory"
    ROOT=$2
    shift 2
    ;;
  --require-tools)
    REQUIRE_TOOLS=1
    shift
    ;;
  --as-ci)
    AS_CI=1
    shift
    ;;
  --guards)
    [ "$#" -ge 2 ] || die "--guards needs a mode: all, changed or none"
    case "$2" in
    all | changed | none) GUARDS_MODE=$2 ;;
    *) die "--guards takes all, changed or none, not '$2'" ;;
    esac
    shift 2
    ;;
  --base)
    [ "$#" -ge 2 ] || die "--base needs a ref"
    BASE_REF=$2
    shift 2
    ;;
  -*) die "unknown option: $1" ;;
  *)
    WANTED+=("$1")
    shift
    ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/.." && pwd -P) || die "cannot resolve this script's checkout"
else
  [ -d "$ROOT" ] || die "no such directory: $ROOT"
  ROOT=$(CDPATH= cd "$ROOT" && pwd -P) || die "cannot resolve --root"
fi
# Every glob, every step's script and every annotation path is relative to the checkout, so the
# expansion and the run happen there and nowhere else.
CDPATH= cd "$ROOT" || die "cannot enter $ROOT"

# Exported, not merely set: the annotation branch of fail_file reads it here, and the step
# scripts run as children read it in their own environment, as they do under Actions.
[ -z "$AS_CI" ] || export GITHUB_ACTIONS=true

validate_table

# The read-only queries, before anything is judged.
if [ "${#WANTED[@]}" -eq 1 ]; then
  case "${WANTED[0]}" in
  steps)
    # The tool column is what lets scripts/test-preflight.sh ask which of these steps CI must
    # invoke with --require-tools: a step with an interpreter is one whose absence would
    # otherwise be a SKIP on a hosted runner (round 4).
    for entry in "${STEPS[@]}"; do
      printf '%s\t%s\t%s\n' "${entry%%:*}" "${entry#*:}" "$(step_tool "${entry%%:*}")"
    done
    exit 0
    ;;
  globs)
    printf '%s\n' "${GLOBS[@]}"
    exit 0
    ;;
  files)
    collect_files
    printf '%s\n' "${FILES[@]}"
    exit 0
    ;;
  guards)
    for entry in "${GUARDS[@]}"; do
      printf '%s\t%s\t%s\n' "${entry%%:*}" "$(guard_field "${entry%%:*}" 2)" "$(guard_field "${entry%%:*}" 3)"
    done
    exit 0
    ;;
  esac
fi

for name in ${WANTED[@]+"${WANTED[@]}"}; do
  step_command "$name" >/dev/null || guard_field "$name" 2 >/dev/null ||
    die "no such step: $name (run 'preflight.sh steps' or 'preflight.sh guards')"
done

if [ "${#WANTED[@]}" -eq 0 ]; then
  for entry in "${STEPS[@]}"; do WANTED+=("${entry%%:*}"); done
  printf 'preflight: judging %s\n' "$ROOT"
  [ -n "$GUARDS_MODE" ] || GUARDS_MODE=changed
fi
[ -n "$GUARDS_MODE" ] || GUARDS_MODE=none

is_wanted() { # is_wanted <name>
  local w
  for w in "${WANTED[@]}"; do [ "$w" = "$1" ] && return 0; done
  return 1
}

# CHANGE_BASE: the merge base the `changed` mode compares against, or empty with CHANGE_WHY
# saying why it cannot be told -- which runs every triggered guard rather than none.
CHANGE_BASE=
CHANGE_WHY=
change_base() {
  local toplevel
  [ -z "$CHANGE_BASE$CHANGE_WHY" ] || return 0
  # The judged root must BE the work tree root, as for the file list: a scratch tree under a
  # checkout would otherwise be compared through the repository above it.
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) &&
    toplevel=$(CDPATH= cd "$toplevel" 2>/dev/null && pwd -P)
  if [ -z "${toplevel:-}" ] || [ "$toplevel" != "$ROOT" ]; then
    CHANGE_WHY="$ROOT is not the root of a git work tree"
  elif ! git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null; then
    CHANGE_WHY="no such commit: $BASE_REF (fetch it, or name another with --base)"
  elif ! CHANGE_BASE=$(git merge-base "$BASE_REF" HEAD 2>/dev/null) || [ -z "$CHANGE_BASE" ]; then
    CHANGE_BASE=
    CHANGE_WHY="no merge base of $BASE_REF and HEAD"
  fi
}

# Decide the guards before anything runs, so the reasons print above the verdicts they explain.
case "$GUARDS_MODE" in
all)
  for entry in "${GUARDS[@]}"; do
    is_wanted "${entry%%:*}" || WANTED+=("${entry%%:*}")
  done
  ;;
changed)
  untriggered=
  for entry in "${GUARDS[@]}"; do
    name=${entry%%:*}
    is_wanted "$name" && continue
    trigger=$(guard_field "$name" 3)
    if [ -z "$trigger" ]; then
      untriggered="$untriggered $name"
      continue
    fi
    change_base
    if [ -z "$CHANGE_BASE" ]; then
      printf 'preflight: %s: due (cannot tell what changed: %s; running it rather than guessing)\n' "$name" "$CHANGE_WHY"
      WANTED+=("$name")
      continue
    fi
    # The working tree against the merge base: committed, staged and unstaged edits to tracked
    # files alike, and nothing untracked, which is the scope the steps judge. `read -a` splits the
    # pathspecs without pathname expansion, which would turn `*.md` into this directory's files.
    read -r -a specs <<<"$trigger"
    # The verdict names the first file that fired, since a trigger of many pathspecs would not
    # tell the reader which edit made the guard due.
    if ! hit=$(git diff --name-only --no-ext-diff "$CHANGE_BASE" -- "${specs[@]}" 2>/dev/null); then
      printf "preflight: %s: due (git could not compare its trigger with the merge base; running it rather than guessing)\n" \
        "$name"
      WANTED+=("$name")
    elif [ -z "$hit" ]; then
      printf "preflight: %s: not run (no tracked file its trigger matches differs from the merge base with %s, %s; 'preflight.sh guards' lists the trigger; --guards all runs it)\n" \
        "$name" "$BASE_REF" "$(git rev-parse --short "$CHANGE_BASE")"
    else
      printf "preflight: %s: due (%s, which its trigger matches, differs from the merge base with %s, %s)\n" \
        "$name" "${hit%%$'\n'*}" "$BASE_REF" "$(git rev-parse --short "$CHANGE_BASE")"
      WANTED+=("$name")
    fi
  done
  [ -z "$untriggered" ] ||
    printf 'preflight: not run here:%s (no file trigger; --guards all runs them, as CI always does)\n' "$untriggered"
  ;;
esac

passed=0
failed=0
skipped=0
skipped_names=
warned_names=
for name in "${WANTED[@]}"; do
  run_step "$name"
  case $? in
  0) passed=$((passed + 1)) ;;
  3)
    skipped=$((skipped + 1))
    skipped_names="$skipped_names $name"
    ;;
  4)
    # Passed, and counted so, but named again in the summary: the warning is the step's verdict.
    passed=$((passed + 1))
    warned_names="$warned_names $name"
    ;;
  *) failed=$((failed + 1)) ;;
  esac
done

if [ -n "$skipped_names" ]; then
  summary=$(printf '%d passed, %d failed, %d skipped (%s)' "$passed" "$failed" "$skipped" "${skipped_names# }")
else
  summary=$(printf '%d passed, %d failed, %d skipped' "$passed" "$failed" "$skipped")
fi
[ -z "$warned_names" ] || summary="$summary; warned: ${warned_names# }"
printf 'preflight: %s\n' "$summary"
[ "$failed" -eq 0 ] || exit 1
exit 0
