#!/usr/bin/env bash
# Runs the working tree's version of ONE suite against the base code: the negative control every
# issue-wave brief asks for ("show the new fixtures FAIL on the base"). A detached worktree of
# origin/main (or --base <ref>) is made under $TMPDIR, the current working tree's copy of
# <suite-path> -- that file, and only the files named with --also -- is copied over the base's,
# and the suite runs from the base worktree, so everything else it reaches through its own
# directory is the base's. The
# worktree is a real checkout, not a `git archive` export, so a suite that asks git about its
# checkout gets an answer. It is removed on every exit path, INT and TERM included.
#
# Before 2026-09-28 each worker did this by hand, each differently: a detached worktree with the
# test copied in, a `git archive` of the base (which broke a case, since an export is not a git
# checkout), the edited script stashed back to base, temporary worktrees.
#
# It is a suite run like any other, so callers take the box's correctness slot around it:
#   ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot -- \
#     scripts/run-against-base.sh <suite-path> [options] [suite args...]
# (`execution slot --cpu -- ...` for a suite that holds no GPU).
#
# The base ref is used as it stands locally: fetch first if origin/main may be stale.
#
# Usage: run-against-base.sh <suite-path> [options] [suite args...]
#   <suite-path>     a file in the current checkout's working tree (relative to the cwd, or
#                    absolute)
# The options come right after the suite path, in any order; the first word that is not one of
# them, and every word after it, goes to the suite (`--` included: it is the suite's), so a suite
# whose own first argument is one of these names cannot take it through the helper. A repeated
# --base or --timeout: the later one wins.
#   --base <ref>     the base to run against (default origin/main; with --mutate, the working tree)
#   --also <path>    carry this working-tree file into the base too, at the same path: a fixture
#                    library the suite changed with (ludics-lite#501). Repeatable. Everything not
#                    named is still the base's.
#   --mutate <file> <sed-expr>
#                    a MUTANT run: after the copies, apply `sed -e <sed-expr>` to <file> inside
#                    the throwaway worktree -- never to the live tree, so an interrupted run
#                    leaves nothing to restore. Without --base the worktree is a snapshot of the
#                    working tree (`git stash create`: tracked files, staged or not; untracked
#                    ones are not in it -- name a new file with --also too to mutate it), since a
#                    mutant is of the change, not of the base. An expression that changes nothing
#                    is refused: that is not a mutant. Repeatable, applied in order. A tests-only change takes this control instead of the
#                    base's: its new cases pass on the base too (ludics-lite#501).
#   --timeout <s>    stop the suite after <s> whole seconds (default RUN_AGAINST_BASE_TIMEOUT, or
#                    0: none). On expiry its process group gets TERM, then KILL after the grace,
#                    and the run is reported as the base FAILING, exit 124: a hang is a valid
#                    negative control for a fix that ends one, not a refusal (ludics-lite#501).
# A suite that is not a `*.py` file runs as itself (it must be executable). A `*.py` suite is run
# the way CI runs it, so the base run is the one CI would make:
#   - a file under lib/ (a `lib/ludics/tests/test_*.py` unit file) runs through the BASE's
#     scripts/py as `scripts/py -m unittest <module>`, the module named from its path under lib/
#     (`lib/ludics/tests/test_x.py` is `ludics.tests.test_x`): lib/ is on the path, the >= 3.12
#     gate applies, and the module is imported under the name CI's `unittest discover -s lib -t
#     lib` gives it, so its package and relative imports resolve. The suite args follow the module
#     name on unittest's own command line: `-v`, `-k <pattern>` to pick cases (a bare `Class.test`
#     is not relative to the module there; spell it `ludics.tests.test_x.Class.test`). A path
#     under lib/ that discovery never runs (not an importable name, not `test_*.py`, or below a
#     directory with no `__init__.py`) is refused. When scripts/py finds no Python >= 3.12 (or
#     does not find one inside --timeout) the suite never runs, and that is this helper's 125,
#     not the base's result;
#   - a base older than scripts/py (before 2026-10-05) has none: the file then runs under plain
#     `python3 <file>`, as it did before, and the run says so;
#   - a `*.py` file outside lib/ (issue-wave/scripts/test-fleet-execution.py, say) runs under plain
#     `python3 <file>`, as CI's steps run it: its own directory on sys.path and its environment
#     unchanged, where scripts/py's `-P` would drop the one and its PYTHONPATH reach every program
#     the suite starts.
# Exit: the suite's own exit status; 124 when the timeout expired; 125 when the helper could not
# run it at all, could not start it (exec failed: it never ran), or could not clean up after it
# (the `git bisect run` convention for "cannot test"), so a refusal is never read as the suite's
# failure -- and a suite's own 125 is reported as 1, as is its own 124 when a timeout is armed.
# Whatever the suite left running is stopped with it: its process group gets TERM, then KILL
# after RUN_AGAINST_BASE_GRACE whole seconds (default 5).

set -uo pipefail

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a (minutes-long) suite run is in flight cannot resume the shell at a shifted offset
# (ludics-lite#10, #247).
{
say() { printf '%s\n' "run-against-base: $*"; }
die() {
  printf '%s\n' "run-against-base: $*" >&2
  exit 125
}

[ $# -ge 1 ] || die "usage: run-against-base.sh <suite-path> [--base <ref>] [--also <path>]... [--mutate <file> <sed-expr>]... [--timeout <s>] [suite args...]"
case "$1" in -h | --help)
  sed -n '2,/^$/s/^# \{0,1\}//p' "$0"
  exit 0
  ;;
esac
# Git's repository-local variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ... as `git rev-parse
# --local-env-vars` lists them; a hook or staged-file tool exports them) are cleared before any
# git command here, for the helper and the suite alike: this checkout is found from the cwd, the
# base worktree's own git state is the suite's, and an inherited GIT_INDEX_FILE would otherwise
# be overwritten by `git worktree add`, losing whatever was staged in it.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
suite_arg=$1
shift
base=
TIMEOUT=${RUN_AGAINST_BASE_TIMEOUT:-0}
ALSO_ARGS=()
MUT_ARGS=()
MUT_EXPRS=()
# The helper's options, up to the first word that is not one: that word and the rest are the
# suite's. No `--` terminator, because a suite may take `--` itself and always could.
while [ $# -gt 0 ]; do
  case "$1" in
  --base)
    [ $# -ge 2 ] || die "--base needs a ref"
    base=$2
    shift 2
    ;;
  --also)
    [ $# -ge 2 ] || die "--also needs a path"
    ALSO_ARGS+=("$2")
    shift 2
    ;;
  --mutate)
    [ $# -ge 3 ] || die "--mutate needs a file and a sed expression"
    MUT_ARGS+=("$2")
    MUT_EXPRS+=("$3")
    shift 3
    ;;
  --timeout)
    [ $# -ge 2 ] || die "--timeout needs whole seconds"
    TIMEOUT=$2
    shift 2
    ;;
  *) break ;;
  esac
done

# Whole seconds, checked before anything is allocated, like the grace below; 0 is no timeout.
case "$TIMEOUT" in '' | *[!0-9]*) die "the timeout must be whole seconds (--timeout, RUN_AGAINST_BASE_TIMEOUT): $TIMEOUT" ;; esac
TIMEOUT=$((10#$TIMEOUT))

TOP=
# resolve <path>: sets R_ABS and R_REL for a regular working-tree file of this checkout, or dies.
# The suite, an --also file and a --mutate file are all named this way, and all refused the same
# ways.
resolve() {
  local arg=$1 dir top
  # A relative path gets a `./`, so a name like `-check.sh` is never read as an option by
  # dirname, basename or cd.
  case "$arg" in /*) ;; *) arg="./$arg" ;; esac
  [ -f "$arg" ] || die "no such file in the working tree: $arg"
  # A symlink is refused rather than resolved: what it points at may be outside git, and the
  # negative control must be the working tree's committed-or-edited file, not something it
  # reaches.
  [ -L "$arg" ] && die "$arg is a symlink; name the file it points at"
  if [ -z "$TOP" ]; then
    TOP=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout: $PWD"
    TOP=$(CDPATH= cd "$TOP" && pwd -P) || die "cannot resolve the checkout root: $TOP"
  fi
  # Split with parameter expansion, and read the resolved directory back through a trailing `x`:
  # a command substitution strips trailing newlines, which a git filename may end in, and would
  # then name a different file than the one checked above.
  dir=$(CDPATH= cd "${arg%/*}/" && pwd -P && printf x) || die "cannot resolve: $arg"
  dir=${dir%x}
  dir=${dir%$'\n'}
  R_ABS="$dir/${arg##*/}"
  # A file inside a nested repository (a submodule, say) belongs to that repository: the base
  # worktree of this one would hold an empty directory there, and the suite would fail on the
  # base for want of its neighbours -- a negative control that proves nothing. Run it from inside.
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) \
    && top=$(CDPATH= cd "$top" && pwd -P) || top=
  if [ -n "$top" ] && [ "$top" != "$TOP" ]; then
    die "$arg is inside the nested repository $top (a submodule?); run the helper from inside it"
  fi
  case "$R_ABS" in
  "$TOP"/*) R_REL=${R_ABS#"$TOP"/} ;;
  *) die "$arg is not inside this checkout ($TOP)" ;;
  esac
  # Git's own directory is not the working tree: installing a path through `.git` would replace
  # the base worktree's `.git` file and leave a checkout git no longer recognizes.
  case "/$R_REL/" in */.git/*) die "$R_REL is inside a .git directory, not the working tree" ;; esac
}
resolve "$suite_arg"
suite_abs=$R_ABS
rel=$R_REL
ALSO_ABS=()
ALSO_REL=()
i=0
while [ "$i" -lt "${#ALSO_ARGS[@]}" ]; do
  resolve "${ALSO_ARGS[$i]}"
  ALSO_ABS+=("$R_ABS")
  ALSO_REL+=("$R_REL")
  i=$((i + 1))
done
MUT_REL=()
i=0
while [ "$i" -lt "${#MUT_ARGS[@]}" ]; do
  resolve "${MUT_ARGS[$i]}"
  MUT_REL+=("$R_REL")
  i=$((i + 1))
done
# RUN: the words before the suite's own arguments (RUN_SHOWN, when set, how the run names them).
# A `lib/` module's runner is settled once the base worktree exists (it is the base's scripts/py,
# when the base has one), so `interp` is left empty for it and its shebang is not read.
module=
RUN_SHOWN=
case "$rel" in
lib/*.py)
  module=${rel#lib/}
  module=${module%.py}
  # Every dotted component an identifier: anything else is a name `-m unittest` cannot import
  # (nor `unittest discover` find), and would fail on the base for that reason alone.
  case "/$module/" in
  *[!A-Za-z0-9_/]* | *//* | */[0-9]*)
    die "$rel is not an importable module path under lib/, so unittest cannot run it"
    ;;
  esac
  # ...and a file CI's `unittest discover -s lib -t lib -p 'test_*.py'` reaches: a `test_*.py`
  # name, in packages all the way down (discovery does not enter a directory without an
  # `__init__.py`). A file it never reaches is no CI suite, and its result on the base would be
  # about a test CI never runs. The shape is the working tree's: that is the tree CI will judge.
  case "${rel##*/}" in
  test_*.py) ;;
  *) die "$rel is not named test_*.py, so CI's unittest discovery never runs it" ;;
  esac
  pkg=${rel%/*}
  while [ "$pkg" != lib ]; do
    [ -f "$TOP/$pkg/__init__.py" ] \
      || die "$pkg has no __init__.py, so CI's unittest discovery never reaches $rel"
    pkg=${pkg%/*}
  done
  module=${module//\//.}
  runner=
  ;;
*.py)
  runner=python3
  RUN=(python3 "./$rel")
  ;;
*)
  [ -x "$suite_abs" ] || die "$rel is not executable (chmod +x it, as the mode rule asks)"
  runner=
  RUN=("./$rel")
  ;;
esac
# An interpreter that is missing means the suite never runs, and its 126/127 must not read as a
# base result. A missing first program is caught at the exec (execfail, below); what the exec
# cannot see is an env shebang whose program is not on PATH, since env itself starts fine -- so
# env's arguments are walked the way env reads them (options, `-u NAME`, `-S`'s split string,
# NAME=value assignments) to the first program word, and that is looked up here.
interp=$runner
if [ -z "$interp" ] && [ -z "$module" ]; then
  IFS= read -r shebang <"$suite_abs" || true
  case "$shebang" in
  '#!'*)
    # An array, not the positional parameters: those are the suite's arguments.
    set -f
    read -r -a sb <<<"${shebang#??}"
    set +f
    if [ "${#sb[@]}" -gt 0 ] && [ "${sb[0]##*/}" = env ]; then
      i=1
      while [ "$i" -lt "${#sb[@]}" ]; do
        w=${sb[$i]}
        case "$w" in
        -u | --unset) i=$((i + 1)) ;;
        -i | --ignore-environment | -) sb_clear=1 ;;
        -S?*) w=${w#-S}; interp=$w; break ;;
        PATH=*) sb_path=${w#PATH=} ;;
        -* | *=*) ;;
        *) interp=$w; break ;;
        esac
        i=$((i + 1))
      done
    fi
    ;;
  esac
fi
# The lookup uses the PATH env will use: the shebang's own PATH= when it sets one; with the
# environment cleared (-i) and no PATH= the search path is env's built-in default, which is not
# ours to guess, so that one is left to the exec.
if [ -n "$interp" ] && [ -z "${sb_clear-}${sb_path+set}" ]; then
  command -v "$interp" >/dev/null 2>&1 || die "$rel needs $interp, which is not on PATH here; it would never run"
elif [ -n "$interp" ] && [ -n "${sb_path+set}" ]; then
  PATH=$sb_path command -v "$interp" >/dev/null 2>&1 \
    || die "$rel needs $interp, which is not on the PATH its shebang sets ($sb_path); it would never run"
fi
SNAPSHOT=
if [ -z "$base" ] && [ "${#MUT_REL[@]}" -gt 0 ]; then
  SNAPSHOT=1
  # A mutant is of the change: the throwaway worktree is the working tree as it stands, tracked
  # files staged or not, and HEAD when nothing differs from it. `git stash create` writes the
  # commit object and nothing else -- no ref, no reflog, no change to the tree -- and is given an
  # identity of its own, since a runner with no user.name would otherwise refuse to write it.
  sha=$(git -C "$TOP" -c user.name=run-against-base -c user.email=run-against-base@invalid \
    stash create 2>/dev/null) || die "could not snapshot the working tree"
  [ -n "$sha" ] || sha=$(git -C "$TOP" rev-parse --verify --quiet 'HEAD^{commit}') \
    || die "the working tree has no commit to snapshot"
  base="the working tree"
else
  base=${base:-origin/main}
  sha=$(git -C "$TOP" rev-parse --verify --quiet "$base^{commit}") || die "no such commit: $base"
fi

# Whole seconds, checked before anything is allocated: the cleanup does integer arithmetic on it,
# and an expansion error inside the EXIT trap would leave the suite and its worktree behind.
GRACE=${RUN_AGAINST_BASE_GRACE:-5}
case "$GRACE" in '' | *[!0-9]*) die "RUN_AGAINST_BASE_GRACE must be whole seconds: $GRACE" ;; esac
GRACE=$((10#$GRACE))

# The cleanup is armed before the scratch directory exists, so no signal can land between the
# allocation and the trap; until SCRATCH is set it has nothing to do.
SCRATCH=
WT=
ADMIN=
child=
teepid=
# live PID | live -PGID: whether that process, or any member of that process group, is still
# running. An exited child of this shell stays a zombie until it is waited for, and kill -0
# still reaches a zombie, so the state is read instead.
live() {
  case "$1" in
  -*) ps -eo pgid=,stat= 2>/dev/null | awk -v g="${1#-}" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }' ;;
  *) case $(ps -o stat= -p "$1" 2>/dev/null) in '' | Z*) return 1 ;; esac ;;
  esac
}
# gone PID|-PGID [SECONDS]: true once it is no longer live, polling for at most SECONDS (default
# $GRACE) -- no wait here is unbounded, since a process that ignores TERM or an orphan holding the
# fifo would otherwise hold the helper, and the worktree, forever.
gone() {
  local i=0 limit=${2:-$GRACE}
  while live "$1"; do
    [ "$i" -ge $((limit * 10)) ] && return 1
    sleep 0.1
    i=$((i + 1))
  done
}
# TEE_DRAIN: how long tee gets to see EOF once the suite's group is stopped. Not the suite's
# grace, which may be 0 or 1: a tee that needs a moment on a loaded box is not a failed capture
# (a macOS CI runner took over a second), and past this only a process that escaped the group can
# still be holding the fifo.
TEE_DRAIN=30
# stop_group: the suite runs as the leader of its own process group, so this reaches whatever it
# left behind in that group as well -- a background child that outlived it, one that ignores
# TERM -- and none of it keeps running in (or writing to) a worktree about to be removed. The
# grace is the GROUP's, not the leader's: a leader that has already exited must not cut short a
# background child's own TERM cleanup. A descendant that leaves the group (`setsid`, its own
# `set -m` job) has left what this helper owns; the suite that starts one stops it.
stop_group() {
  kill -TERM -- "-$child" 2>/dev/null
  gone "-$child" || kill -KILL -- "-$child" 2>/dev/null
  wait "$child" 2>/dev/null
  return 0
}
cleanup() {
  # A second INT/TERM/HUP while this runs must not cut it short: the trap's `exit` would leave
  # the EXIT trap before the worktree is removed.
  trap '' INT TERM HUP
  [ -n "$SCRATCH" ] || return 0
  [ -n "$child" ] && stop_group
  if [ -n "$teepid" ] && ! gone "$teepid" "$TEE_DRAIN"; then kill "$teepid" 2>/dev/null; fi
  if [ -d "$WT" ]; then
    # --force twice: once for the copied suite (the checkout is dirty), again for a worktree the
    # suite locked, which a single --force refuses.
    git -C "$TOP" worktree remove --force --force "$WT" >/dev/null 2>&1
  fi
  # A suite can leave a directory it made unreadable; give the tree back its owner's permissions
  # and try again rather than leak it.
  rm -rf "$SCRATCH" 2>/dev/null || { chmod -R u+rwx "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"; }
  # No `git worktree prune`: it has no path argument, and would also drop the registration of any
  # other worktree of this repository whose directory is missing just now. When `worktree remove`
  # did not take this one, its own administrative directory is removed, and nothing else.
  if [ -n "$ADMIN" ] && [ -d "$ADMIN" ] \
    && git -C "$TOP" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $WT"; then
    rm -rf "$ADMIN"
  fi
  local leaked=
  if git -C "$TOP" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $WT"; then
    printf '%s\n' "run-against-base: the worktree $WT is still registered; remove it by hand" >&2
    leaked=1
  fi
  if [ -e "$SCRATCH" ]; then
    printf '%s\n' "run-against-base: could not remove $SCRATCH; remove it by hand" >&2
    leaked=1
  fi
  [ -z "$leaked" ] || exit 125
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The root is resolved first and the scratch directory made under it, so SCRATCH is physical
# from its first assignment (a child of a physical path is physical) and no later line can
# overwrite it with an empty value the cleanup would then not know to remove.
TMP_ROOT=$(CDPATH= cd "${TMPDIR:-/tmp}" && pwd -P) || die "cannot resolve ${TMPDIR:-/tmp}"
SCRATCH=$(mktemp -d "$TMP_ROOT/run-against-base.$$.XXXXXX") || die "mktemp failed"
WT="$SCRATCH/base"

git -C "$TOP" worktree add --quiet --detach "$WT" "$sha" >/dev/null 2>&1 \
  || die "git worktree add failed for $base ($sha)"
ADMIN=$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null) || ADMIN=
case "$ADMIN" in "$(git -C "$TOP" rev-parse --path-format=absolute --git-common-dir)"/worktrees/?*) ;; *) ADMIN= ;; esac
# A sparse checkout is copied into the new worktree, and files outside its patterns would be
# missing from the base -- a suite failing on one of them is not a base failure. The skip-worktree
# bits are cleared in this worktree's own index and every file written; no config is touched, so
# the source checkout stays as sparse as it was.
if [ "$(git -C "$WT" config --bool core.sparseCheckout 2>/dev/null)" = true ]; then
  git -C "$WT" -c index.sparse=false ls-files -z -t \
    | while IFS= read -r -d '' entry; do case "$entry" in 'S '*) printf '%s\0' "${entry#S }" ;; esac; done \
    | git -C "$WT" -c core.sparseCheckout=false update-index --no-skip-worktree -z --stdin \
    && git -C "$WT" -c core.sparseCheckout=false checkout-index -a -f \
    || die "could not fill in the sparse checkout of the base worktree"
fi
# Submodules are not checked out in the base worktree. One on the suite's own path is refused
# below; one elsewhere cannot be judged from here, so the result line names them instead.
uninit_subs=$(git -C "$WT" ls-files -s 2>/dev/null | awk '$1 == "160000" { n++ } END { print n + 0 }')
# install <abs> <rel>: the working tree's file at <rel>, written into the base worktree. The path
# is installed one component at a time, and at each one whatever the base has there -- a symlink,
# a file, a directory where the file now is -- is replaced, never followed: the working tree's
# shape wins, so nothing is created or written outside the worktree. (`rel` came from a `pwd -P`,
# so every component above the file is a real directory in the working tree too.)
install() {
  local dest=$WT rest=$2
  while case "$rest" in */*) true ;; *) false ;; esac do
    dest="$dest/${rest%%/*}"
    rest=${rest#*/}
    # A submodule in the base is checked out as an empty directory: the suite would fail there
    # for want of neighbours the base does have, which is a false result, not a negative control.
    case "$(git -C "$TOP" ls-tree "$sha" -- "${dest#"$WT"/}" 2>/dev/null)" in
    160000\ *) die "${dest#"$WT"/} is a submodule in $base; run the helper inside that repository" ;;
    esac
    if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -d "$dest" ]; }; then
      rm -f "$dest" || die "cannot replace ${dest#"$WT"/} in the base worktree"
    fi
    [ -d "$dest" ] || mkdir "$dest" || die "cannot create ${dest#"$WT"/} in the base worktree"
  done
  dest="$dest/$rest"
  if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf "$dest" || die "cannot replace $2 in the base worktree"; fi
  cp -p "$1" "$dest" || die "cannot copy $2 into the base worktree"
}
install "$suite_abs" "$rel"
i=0
while [ "$i" -lt "${#ALSO_REL[@]}" ]; do
  install "${ALSO_ABS[$i]}" "${ALSO_REL[$i]}"
  i=$((i + 1))
done
# The mutations, after every copy, so one may name a carried file. Each rewrites the file through
# its own inode (mode kept) and must change it: an expression that matched nothing would leave a
# "mutant" identical to the code it claims to break, and its passing suite would read as the
# cases being blind to the mutation -- a verdict about nothing.
i=0
while [ "$i" -lt "${#MUT_REL[@]}" ]; do
  target="$WT/${MUT_REL[$i]}"
  # resolve() found the file in the live tree, so a run's tree without it is a snapshot that
  # leaves untracked files out, or a base that predates the file: either way --also is the cure.
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    if [ -n "$SNAPSHOT" ]; then
      die "${MUT_REL[$i]} is untracked, and the working-tree snapshot holds tracked files only: there is nothing there to mutate (carry it with --also ${MUT_REL[$i]} as well)"
    fi
    die "${MUT_REL[$i]} is not in $base: there is nothing there to mutate (--also ${MUT_REL[$i]} carries the working tree's copy)"
  fi
  { [ -f "$target" ] && [ ! -L "$target" ]; } \
    || die "${MUT_REL[$i]} is not a regular file in $base: there is nothing there to mutate"
  sed -e "${MUT_EXPRS[$i]}" "$target" >"$SCRATCH/mutant" \
    || die "sed refused the mutation of ${MUT_REL[$i]}: ${MUT_EXPRS[$i]}"
  cmp -s "$target" "$SCRATCH/mutant" \
    && die "the mutation '${MUT_EXPRS[$i]}' changed nothing in ${MUT_REL[$i]}: that is not a mutant"
  cat "$SCRATCH/mutant" >"$target" || die "cannot write the mutant of ${MUT_REL[$i]}"
  i=$((i + 1))
done
# A lib/ module runs through the base's own scripts/py (after the copies and mutations, so one
# carried with --also or mutated is the one used). scripts/py exits 2 and runs nothing when it
# finds no Python >= 3.12, which the exit status cannot tell from the suite's own 2; so the
# interpreter itself marks that it started (the `started` file, written before unittest runs), the
# way execfail marks an exec that failed. No marker means the suite never ran: this helper's 125,
# never the base's result. The mark is made inside the suite's own run, so whatever scripts/py's
# interpreter search does (a candidate that hangs, a relative one) is bounded by --timeout and
# resolved from the base worktree, exactly as the run is.
py_note=
started=
if [ -n "$module" ]; then
  if [ -f "$WT/scripts/py" ] && [ -x "$WT/scripts/py" ]; then
    started="$SCRATCH/started"
    # `-m unittest <module>`, spelled through runpy so the mark comes first; unittest's __main__
    # then reads sys.argv[1:] (the module and the suite args) as `python -m unittest` would.
    RUN=(./scripts/py -c 'import runpy, sys
open(sys.argv.pop(1), "w").close()
runpy.run_module("unittest", run_name="__main__", alter_sys=True)' "$started" "$module")
    RUN_SHOWN="./scripts/py -m unittest $module"
  elif [ -e "$WT/scripts/py" ] || [ -L "$WT/scripts/py" ]; then
    # Only a base with no scripts/py at all predates it. One that is there but cannot run (not
    # executable, a directory, a broken link) fails CI's own `scripts/py` steps before any test,
    # so a python3 verdict here would be about a run CI could not make.
    die "the base's scripts/py is not an executable file, so it cannot run $rel; it would never run"
  else
    command -v python3 >/dev/null 2>&1 || die "$rel needs python3, which is not on PATH here; it would never run"
    RUN=(python3 "./$rel")
    py_note="note: $base has no scripts/py, so $rel runs under plain python3, without lib/ on the path or the >= 3.12 gate"
  fi
fi

say "$rel (working tree) against $base ($(git -C "$TOP" rev-parse --short "$sha"))"
i=0
while [ "$i" -lt "${#ALSO_REL[@]}" ]; do
  say "also: ${ALSO_REL[$i]} (working tree)"
  i=$((i + 1))
done
i=0
while [ "$i" -lt "${#MUT_REL[@]}" ]; do
  say "mutant: ${MUT_REL[$i]}: ${MUT_EXPRS[$i]}"
  i=$((i + 1))
done
[ "$TIMEOUT" -eq 0 ] || say "timeout: ${TIMEOUT}s"
[ -z "$runner$module" ] || say "runs as: ${RUN_SHOWN:-${RUN[*]}}"
[ -z "$py_note" ] || say "$py_note"
# The suite runs in the background so the INT/TERM traps fire at once rather than after it
# returns; its output goes through a fifo to tee, which both shows it live and keeps it for the
# pass/fail line (a `| tee` would hide the suite's exit status behind tee's under `wait`).
LOG="$SCRATCH/out"
# Signals are deferred from the launches until `teepid` and `child` are recorded: a trap taken in between would
# run the cleanup without knowing what it has to stop, and leave tee or the suite running.
pending=
trap 'pending=130' INT
trap 'pending=143' TERM HUP
mkfifo "$SCRATCH/fifo" || die "mkfifo failed"
tee "$LOG" <"$SCRATCH/fifo" &
teepid=$!
# `set -m` puts the suite in a process group of its own (its pid is the group id), which
# stop_group signals whole; it also keeps INT at its default there rather than ignored, as a
# non-interactive shell would start a background job.
set -m
# execfail: a suite that cannot be started at all (a missing interpreter, no python3) never ran,
# so it must not read as the suite's 126/127 failure on the base; the marker tells the two apart.
# A top-level `bash -c` and not a `( ... )` subshell, because bash 3.2 exits a subshell on a
# failed exec whatever execfail says. Its $0 is the marker path; the exec keeps the pid, so the
# suite is still the group leader.
# shellcheck disable=SC2016 # expanded by the inner bash
bash -c 'cd "$1" && shift && shopt -s execfail && exec "$@"
  : >"$0"
  exit 125' "$SCRATCH/execfail" "$WT" "${RUN[@]}" "$@" >"$SCRATCH/fifo" 2>&1 </dev/null &
child=$!
set +m
trap 'exit 130' INT
trap 'exit 143' TERM HUP
[ -z "$pending" ] || exit "$pending"
# The timeout polls the suite's state rather than arming a watchdog process: a watchdog's own
# sleep would outlive it when it is stopped early, and it is one more process for every exit path
# to account for. The poll counts its own sleeps, so it fires no earlier than the timeout.
timed_out=
if [ "$TIMEOUT" -gt 0 ]; then
  polls=0
  while live "$child"; do
    if [ "$polls" -ge $((TIMEOUT * 5)) ]; then
      timed_out=1
      break
    fi
    sleep 0.2
    polls=$((polls + 1))
  done
fi
if [ -n "$timed_out" ]; then
  # The hang is the result: the group goes the way the cleanup stops it, TERM then KILL after
  # the grace, and the run reports the base as failing rather than as a run that never happened.
  stop_group
  rc=124
else
  wait "$child"
  rc=$?
fi
if [ -e "$SCRATCH/execfail" ]; then
  stop_group
  child=
  die "could not start $rel on $base (exec failed, see above); it never ran"
fi
if [ -n "$started" ] && [ ! -e "$started" ]; then
  stop_group
  child=
  die "the base's scripts/py never started an interpreter for $rel (see above${timed_out:+; stopped by the ${TIMEOUT}s timeout}); it never ran"
fi
# Anything the suite left running still holds the fifo open; stop it so tee sees EOF.
stop_group
child=
# tee is reaped and judged too: a capture that failed, or that something outside the group still
# held open past the grace, would make the result line (and a SIGPIPE'd suite's status) a claim
# about output nobody read.
if gone "$teepid" "$TEE_DRAIN"; then
  wait "$teepid"
  tee_rc=$?
else
  kill "$teepid" 2>/dev/null
  wait "$teepid" 2>/dev/null
  tee_rc=timeout
fi
teepid=
[ "$tee_rc" = 0 ] || die "capturing the suite's output failed (tee: $tee_rc); its exit $rc is not a result"

tally=$(grep -E '[0-9]+ passed, [0-9]+ failed' "$LOG" | tail -n 1)
[ -n "$tally" ] || tally=$(grep -v '^[[:space:]]*$' "$LOG" | tail -n 1)
if [ -n "$timed_out" ]; then
  say "exit 124 on $base: timed out after ${TIMEOUT}s, and its process group was stopped -- a hang is a failing run, not a refusal${tally:+ (last tally: $tally)}"
else
  say "exit $rc on $base: ${tally:-(no output)}"
fi
[ "$uninit_subs" -eq 0 ] \
  || say "note: $base has $uninit_subs submodule(s), not checked out here; a failure that reaches into one is not the base's"
# 125 is this helper's own "could not run it"; a suite that returns it failed, and says so as 1.
[ "$rc" -eq 125 ] && rc=1
# ...and with a timeout armed, 124 is the helper's "it hung"; the suite's own 124 exits 1 the same way.
[ -z "$timed_out" ] && [ "$TIMEOUT" -gt 0 ] && [ "$rc" -eq 124 ] && rc=1
exit "$rc"
exit "$?"
}
