#!/usr/bin/env bash
# End-to-end tests for post-merge-cleanup.sh. Every repository lives under one disposable /tmp tree,
# each case in its own subtree, and the cases run concurrently (-j N; see usage). Runs every case by
# default; name cases exactly to run only those, or --list to see the names.

set -euo pipefail

# Bash reads a script file by offset while it runs, so rewriting this file mid-run resumes the
# shell at a shifted offset, in the middle of whatever command now sits there — that is how two
# runs of this suite skipped their final wait loop and removed the scratch root under cases still
# running. Everything below is one brace group: it is parsed whole before its first command runs,
# and the closing exit means nothing past it is ever read. The group opens right here, above the
# first fork, so no line of this file is read after any of it has executed (ludics-lite#10). The
# body keeps its original indentation, so the guard is a two-line change. CI checks that the file
# still ends in `exit "$?"` and `}`, and test_runner_survives_midrun_rewrite exercises the
# property against a scratch copy: a command appended past the group is never read.
{
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
HELPER="$SCRIPT_DIR/post-merge-cleanup.sh"
# Git for Windows' MSYS2 bash, and Cygwin: the one platform family whose shell is not the one Git
# itself runs on (ludics-lite#318). The runner reads its processes differently there, and a few
# cases state a boundary there instead of running (`skip_boundary`, ludics-lite#338).
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*) ON_MSYS=1 ;;
*) ON_MSYS=0 ;;
esac
# MSYS2's `ln -s` copies its target unless told to link (its default is `winsymlinks:deepcopy`),
# and refuses a target that does not exist, so every symlink case would test a copy or nothing.
# Native Windows symlinks are what Git for Windows itself reads as links. `nativestrict` fails
# loudly where the account may not create one (no Developer Mode, not elevated) instead of falling
# back to a copy. Cygwin reads CYGWIN, not MSYS, and is not a platform this suite is run on.
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS*) export MSYS="${MSYS:+$MSYS }winsymlinks:nativestrict" ;;
esac
# The physical spelling of the template's own parent, whatever /tmp is a link to on this host --
# /private/tmp on macOS, itself on Linux, and neither is hardcoded: the removal guard below
# compares against THIS, so a host where /tmp points somewhere else neither leaks its scratch tree
# nor needs a new arm (ludics-lite#208, review round 1).
TEST_ROOT_PARENT=$(CDPATH= cd /tmp && pwd -P) || exit 1
TEST_ROOT=$(mktemp -d "/tmp/post-merge-cleanup-test.XXXXXX") || exit 1
# Physically resolved, and this suite needs it most: the helper under test refuses anything but
# the exact session-worktree root, and computes that root with `pwd -P` (its canonical_dir). On
# macOS /tmp is a symlink to /private/tmp, so an unresolved $TEST_ROOT is a different spelling of
# every path this suite builds, and a comparison against one stops matching in silence
# (ludics-lite#208). Resolved here, once: every $CASE_* path below is built under it and is
# therefore already physical, so no case re-resolves the session path it hands the helper.
TEST_ROOT=$(CDPATH= cd "$TEST_ROOT" && pwd -P) || exit 1
# The in-flight cases' subshell pids and names, kept by the runner at the bottom. Declared before
# the EXIT trap is installed: an exit ahead of the runner (--help, --list, a refused argument)
# must not find an inherited variable of the same name and signal whatever it lists.
RUNNING_PIDS=()
RUNNING_NAMES=()
RUNNING_STARTS=()
RUNNING=0

cleanup() {
  # Every exit path — a signal, a failed assertion in the runner, a closed output pipe — first
  # terminates and reaps the in-flight cases' process groups (see the runner below), so nothing
  # is left waiting on markers under the root this removes.
  local pid
  for pid in ${RUNNING_PIDS[@]+"${RUNNING_PIDS[@]}"}; do
    # The group, and the leader by pid as well: a case forked in the same instant as this exit
    # may not have joined its group yet, and then only the direct signal reaches it.
    kill -TERM -- "-$pid" >/dev/null 2>&1 || true
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done
  for pid in ${RUNNING_PIDS[@]+"${RUNNING_PIDS[@]}"}; do
    wait "$pid" >/dev/null 2>&1 || true
  done
  # $TEST_ROOT is now the PHYSICAL spelling of a directory the template made under /tmp, so the
  # guard compares it against the physical spelling of that same parent rather than against the
  # literal the template used. Matching `/tmp/...` alone would refuse to remove the suite's own
  # root on every macOS run -- where /tmp is a symlink to /private/tmp -- and leak a scratch tree
  # per run (ludics-lite#208). The pattern is still anchored and still carries the suite's own
  # name: it stays a guard against removing something this suite did not make.
  case "$TEST_ROOT" in
  "$TEST_ROOT_PARENT"/post-merge-cleanup-test.*) rm -rf "$TEST_ROOT" ;;
  *) echo "refusing to remove unexpected test root: $TEST_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT

# `printf '%s\n'`, not `echo`, for the reason the helper's own `fail` gives: a failure report
# quotes a refusal that can carry a shell-quoted attacker-shaped name, and `echo` under
# `xpg_echo` would unescape it on the way out.
fail() {
  printf '%s\n' "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "$3 (got $1, expected $2)"
}

# skip_boundary <reason>: what follows in this case cannot be expressed on this platform, and is
# not run (ludics-lite#338). The caller returns or skips the leg; this only states it. The reason
# names the platform mechanism, not the symptom. The line carries the case's name (`CASE_NAME`,
# set by the runner), so it reads the same in a verbose log as in the quiet output; the runner
# prints it and counts the case in the summary line, so a boundary is on the record in every run
# and is never read as a pass of the property it did not test.
skip_boundary() {
  printf '%s\n' "SKIP ${CASE_NAME:-?}: $*"
}

# The boundary every case that names a file with a control character states under MSYS. Windows
# file names cannot hold characters 1-31, so MSYS stores each as the private-use character
# U+F000 plus its code, and maps it back only for MSYS programs: Git for Windows reads, lists and
# is handed the private-use name, so the name the case built is not the one Git sees.
MSYS_CONTROL_NAME_BOUNDARY="a file name with a control character: MSYS stores it as U+F0xx on disk (Windows names cannot hold characters 1-31), and Git for Windows sees that private-use name, not the one this case built"

assert_absent() {
  [ ! -e "$1" ] || fail "expected path to be absent: $1"
}

assert_ref_absent() {
  ! git -C "$CASE_MAIN" show-ref --verify --quiet "$1" || fail "expected ref to be absent: $1"
}

assert_remote_topic_absent() {
  ! git -C "$CASE_MAIN" ls-remote --exit-code --heads origin "refs/heads/$CASE_BRANCH" >/dev/null 2>&1 ||
    fail "expected origin/$CASE_BRANCH to be absent"
}

# A refusal that keeps the topic keeps it untouched. The remote topic existing afterwards is not
# enough: a refusal that deleted it and pushed it back at the same tip leaves every ref as it was
# (ludics-lite#343). So the remote was never pushed to at all: the push log `setup_case` records
# stays empty. Refusals that legitimately restore the remote topic assert
# `assert_remote_restored_after_local_cleanup` instead. Fail-closed: a case that replaced the
# logging hook has no record, and is refused rather than passed on an empty log. So is a
# `core.hooksPath` -- global, or set in the environment -- that sends Git to another hooks
# directory: the hook is compared at the path Git resolves, not at the one it was written to, and
# must still be executable, since Git skips a hook that is not.
assert_topic_preserved() {
  local hook
  git -C "$CASE_MAIN" show-ref --verify --quiet "refs/heads/$CASE_BRANCH" || fail "local topic was deleted"
  git -C "$CASE_MAIN" ls-remote --exit-code --heads origin "refs/heads/$CASE_BRANCH" >/dev/null 2>&1 ||
    fail "remote $CASE_BRANCH was deleted"
  [ -d "$CASE_SESSION" ] || fail "topic worktree was removed"
  hook=$(git_path_of "$CASE_MAIN" hooks/pre-push) || fail "could not locate the effective pre-push hook"
  [ -x "$hook" ] && cmp -s "$CASE_PUSH_LOG_HOOK" "$hook" ||
    fail "the pre-push hook Git runs is not the push logger, so whether the remote was touched is unrecorded"
  [ ! -s "$CASE_PUSH_LOG" ] || fail "the remote was pushed to by a refusal that must not touch it: $(cat "$CASE_PUSH_LOG")"
}

assert_cleaned() {
  local archive archive_count branch_key local_master remote_master
  local_master=$(git -C "$CASE_MAIN" rev-parse "refs/heads/$CASE_BASE_BRANCH")
  remote_master=$(git -C "$CASE_MAIN" rev-parse "refs/remotes/origin/$CASE_BASE_BRANCH")
  assert_eq "$local_master" "$remote_master" \
    "local $CASE_BASE_BRANCH must match origin/$CASE_BASE_BRANCH"
  assert_absent "$CASE_SESSION"
  assert_ref_absent "refs/heads/$CASE_BRANCH"
  assert_ref_absent "refs/remotes/origin/$CASE_BRANCH"
  assert_remote_topic_absent
  for branch_key in remote merge mergeOptions pushRemote rebase description; do
    ! git -C "$CASE_MAIN" config --local --no-includes \
      --get "branch.$CASE_BRANCH.$branch_key" >/dev/null 2>&1 ||
      fail "repository-local topic branch configuration remained: $branch_key"
  done
  assert_eq "$(git -C "$CASE_MAIN" rev-parse "refs/ship-pr/recovery/$CASE_BRANCH/$CASE_TOPIC_OID")" \
    "$CASE_TOPIC_OID" "topic recovery ref must retain the cleaned tip"
  archive_count=0
  CASE_ARCHIVE=""
  for archive in "$CASE_ROOT"/.session.ship-pr-recovery.*; do
    [ -d "$archive" ] || continue
    archive_count=$((archive_count + 1))
    CASE_ARCHIVE="$archive"
  done
  assert_eq "$archive_count" 1 "cleanup must retain exactly one session archive"
  [ -f "$CASE_ARCHIVE/worktree/value" ] || fail "session archive did not retain tracked worktree files"
}

# A refusal the post-deletion base check makes: the remote topic deletion is the helper's last step
# (ludics-lite#287), so a base that changes under it is caught with the local side already cleaned
# exactly as on success, and the remote topic is put back at the cleaned tip.
assert_remote_restored_after_local_cleanup() {
  assert_ref_absent "refs/heads/$CASE_BRANCH"
  assert_absent "$CASE_SESSION"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse "refs/ship-pr/recovery/$CASE_BRANCH/$CASE_TOPIC_OID")" \
    "$CASE_TOPIC_OID" "topic recovery ref must retain the cleaned tip"
  assert_eq "$(git -C "$CASE_MAIN" ls-remote origin "refs/heads/$CASE_BRANCH" | awk '{print $1}')" \
    "$CASE_TOPIC_OID" "remote topic must be restored at the cleaned tip"
}

git_config() {
  git -C "$1" config user.name "Cleanup Test"
  git -C "$1" config user.email cleanup-test@example.invalid
}

# The path Git itself uses for <path> under the checkout's Git directory, honouring every
# relocation it applies (core.hooksPath for `hooks/...`, the common directory for `logs/...`).
git_path_of() {
  local checkout="$1" git_path="$2" path
  path=$(git -C "$checkout" rev-parse --git-path "$git_path") || return 1
  # The helper's own classification, which this suite's fixtures need for the same reason it does:
  # under Git Bash a path Git read from a `.git` file is reported drive-rooted (ludics-lite#147).
  case "$path" in
  /* | [ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]:[/\\]*) printf '%s\n' "$path" ;;
  *) printf '%s\n' "$checkout/$path" ;;
  esac
}

git_log_path() {
  git_path_of "$1" "logs/$2"
}

keep_last_reflog_entry() {
  local checkout="$1" ref="$2" path snapshot
  path=$(git_log_path "$checkout" "$ref") || fail "could not locate $ref reflog"
  snapshot="$path.ship-pr-test-last"
  tail -n 1 "$path" >"$snapshot"
  mv "$snapshot" "$path"
}

# install_push_log_hook: record every push sent from the case's repository -- its main checkout
# and every worktree of it, which share its hooks -- as an `invoked` line, then one line per ref it
# proposes, each prefixed with whether local refs/heads/topic still existed when the push was sent.
# The `invoked` line is there for a push that proposes no ref update: an up-to-date push still
# reaches the remote and runs the hook, with nothing on its input. Restores are pushes too, so an empty log
# proves the remote was never deleted and put back. Its boundary: a pre-push hook sees only pushes
# Git runs hooks for, so a push from another repository, or one sent with --no-verify, is not
# recorded; the helper sends neither. A case's own push from this repository before an
# `assert_topic_preserved` uses --no-verify, so the log holds the helper's pushes alone; one that
# does not goes red on the assertion, not green. The hook is written to the repository's own
# hooks directory and never to a relocated one, which can be a user's shared directory; a
# relocation is `assert_topic_preserved`'s to refuse. The paths are written into the hook, so the helper needs
# no environment of the case's to run it, and `CASE_PUSH_LOG_HOOK` keeps the installed text for
# `assert_topic_preserved` to check it was not replaced.
install_push_log_hook() {
  CASE_PUSH_LOG="$CASE_ROOT/pushes.log"
  CASE_PUSH_LOG_HOOK="$CASE_ROOT/push-log-hook"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf 'real_git=%q main=%q log=%q\n' "$(command -v git)" "$CASE_MAIN" "$CASE_PUSH_LOG"
    printf '%s\n' \
      'if "$real_git" -C "$main" show-ref --verify --quiet refs/heads/topic; then state=local-present; else state=local-absent; fi' \
      'printf "%s invoked\n" "$state" >>"$log"' \
      'while read -r local_ref local_oid remote_ref remote_oid; do' \
      '  printf "%s %s %s %s %s\n" "$state" "$local_ref" "$local_oid" "$remote_ref" "$remote_oid" >>"$log"' \
      'done' \
      'exit 0'
  } >"$CASE_PUSH_LOG_HOOK"
  cp "$CASE_PUSH_LOG_HOOK" "$CASE_MAIN/.git/hooks/pre-push"
  chmod +x "$CASE_MAIN/.git/hooks/pre-push"
}

setup_case() {
  local name="$1" merge_mode="$2" owner_mode="$3" base_branch="${4:-master}"
  local root="$TEST_ROOT/$name"
  CASE_ROOT="$root"
  CASE_REMOTE="$root/remote.git"
  CASE_MAIN="$root/main"
  CASE_SESSION="$root/session"
  CASE_INTEGRATOR="$root/integrator"
  CASE_MASTER_OWNER="$root/master-owner"
  CASE_BRANCH=topic
  CASE_BASE_BRANCH="$base_branch"

  mkdir -p "$root"
  git init --bare "$CASE_REMOTE" >/dev/null
  git init -b "$CASE_BASE_BRANCH" "$CASE_MAIN" >/dev/null
  git_config "$CASE_MAIN"
  echo base >"$CASE_MAIN/value"
  git -C "$CASE_MAIN" add value
  git -C "$CASE_MAIN" commit -m base >/dev/null
  git -C "$CASE_MAIN" remote add origin "$CASE_REMOTE"
  git -C "$CASE_MAIN" push -u origin "$CASE_BASE_BRANCH" >/dev/null

  git -C "$CASE_MAIN" branch topic
  git -C "$CASE_MAIN" worktree add "$CASE_SESSION" topic >/dev/null
  git_config "$CASE_SESSION"
  echo topic >>"$CASE_SESSION/value"
  git -C "$CASE_SESSION" add value
  git -C "$CASE_SESSION" commit -m topic >/dev/null
  git -C "$CASE_SESSION" push -u origin topic >/dev/null
  CASE_TOPIC_OID=$(git -C "$CASE_SESSION" rev-parse HEAD)

  git clone --branch "$CASE_BASE_BRANCH" "$CASE_REMOTE" "$CASE_INTEGRATOR" >/dev/null 2>&1
  git_config "$CASE_INTEGRATOR"
  case "$merge_mode" in
  merge)
    git -C "$CASE_INTEGRATOR" merge --no-ff origin/topic -m "merge topic" >/dev/null
    git -C "$CASE_INTEGRATOR" push origin "$CASE_BASE_BRANCH" >/dev/null
    ;;
  squash)
    git -C "$CASE_INTEGRATOR" merge --squash origin/topic >/dev/null
    git -C "$CASE_INTEGRATOR" commit -m "squash topic" >/dev/null
    git -C "$CASE_INTEGRATOR" push origin "$CASE_BASE_BRANCH" >/dev/null
    ;;
  unmerged) ;;
  *) fail "unknown merge mode: $merge_mode" ;;
  esac

  case "$owner_mode" in
  none) git -C "$CASE_MAIN" checkout --detach >/dev/null ;;
  main) ;;
  other)
    git -C "$CASE_MAIN" checkout --detach >/dev/null
    git -C "$CASE_MAIN" worktree add "$CASE_MASTER_OWNER" "$CASE_BASE_BRANCH" >/dev/null
    ;;
  main-off)
    git -C "$CASE_MAIN" checkout -b coordinator >/dev/null
    ;;
  *) fail "unknown owner mode: $owner_mode" ;;
  esac
  install_push_log_hook
}

# Land the session's current topic head in the base branch through the integrator, the way a
# follow-up commit on a merged topic would reach `origin/master`: pushes the topic, merges it under
# the given message, and pushes the base branch. Refreshes `CASE_TOPIC_OID`, which `assert_cleaned`
# reads for the recovery ref. For a commit the test made itself; `land_topic_change` makes one.
land_topic_head() {
  local merge_message="$1"
  git -C "$CASE_SESSION" push --no-verify origin topic >/dev/null
  git -C "$CASE_INTEGRATOR" fetch origin >/dev/null 2>&1
  git -C "$CASE_INTEGRATOR" merge --no-ff origin/topic -m "$merge_message" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin "$CASE_BASE_BRANCH" >/dev/null
  CASE_TOPIC_OID=$(git -C "$CASE_SESSION" rev-parse HEAD)
}

# Add tracked content to the topic after `setup_case` and land it through `land_topic_head`.
# Stages the given session paths, commits them with the first message, and merges under the second.
land_topic_change() {
  local commit_message="$1" merge_message="$2"
  shift 2
  git -C "$CASE_SESSION" add -- "$@"
  git -C "$CASE_SESSION" commit -m "$commit_message" >/dev/null
  land_topic_head "$merge_message"
}

test_unchecked_out_master() {
  setup_case unchecked-out-master merge none
  (cd "$CASE_SESSION" && "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null)
  assert_cleaned
  echo "PASS: unchecked-out master"
}

test_master_owned_by_main() {
  setup_case master-owned-by-main merge main
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref --short HEAD)" master "main checkout must still own master"
  echo "PASS: master owned by main checkout"
}

test_master_owned_by_other_worktree() {
  setup_case master-owned-by-other merge other
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master "other worktree must own master"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" rev-parse HEAD)" "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)" \
    "other worktree must be fast-forwarded"
  echo "PASS: master owned by another worktree"
}

test_main_base_support() {
  local invalid refusal
  setup_case main-base merge main main
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --base main >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref --short HEAD)" main \
    "main checkout must still own main"

  setup_case main-base-unmerged unmerged main-off main
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --base main 2>&1); then
    fail "unmerged topic cleanup unexpectedly succeeded with a main base"
  fi
  case "$refusal" in
  *"topic is not an ancestor of origin/main"*) ;;
  *) fail "main-base refusal did not name origin/main: $refusal" ;;
  esac
  assert_topic_preserved

  for invalid in HEAD -release; do
    if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --base "$invalid" 2>&1); then
      fail "invalid base shorthand unexpectedly passed: $invalid"
    fi
    case "$refusal" in
    *"invalid base branch name: $invalid"*) ;;
    *) fail "invalid base shorthand was not diagnosed: $refusal" ;;
    esac
  done
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --base '@{-1}' 2>&1); then
    fail "expanded base shorthand unexpectedly passed"
  fi
  case "$refusal" in
  *"expanded base branch shorthand is not allowed: @{-1} (use main)"*) ;;
  *) fail "expanded base shorthand was not diagnosed against the main checkout: $refusal" ;;
  esac
  assert_topic_preserved
  echo "PASS: main base cleanup and unmerged refusal"
}

test_safe_topic_deletion() {
  setup_case safe-topic-deletion merge main-off
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref --short HEAD)" coordinator \
    "main checkout must remain on its unrelated branch"

  setup_case unmerged-topic-refusal unmerged main-off
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "unmerged topic cleanup unexpectedly succeeded"
  fi
  assert_topic_preserved
  echo "PASS: safe topic deletion and unmerged refusal"
}

test_squash_rebase_override() {
  setup_case squash-override squash main-off
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "squash-merged topic cleanup succeeded without an override"
  fi
  git -C "$CASE_MAIN" show-ref --verify --quiet refs/heads/topic || fail "topic disappeared before override"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic \
    --force-integrated "scratch repository confirms the squash merge" >/dev/null
  assert_cleaned
  echo "PASS: explicit squash/rebase override"
}

# `early` pushes the newer tip before the cleanup starts, so nothing is dismantled. `late` pushes
# it from the helper's own pre-push hook, after the local side is gone: the leased deletion fails,
# and the refusal must end with the command that finishes the job, after the precondition the
# helper could not check -- run here as printed, which also proves its quoting.
# The finishing command names the push URL as Git reports it, which is not always the spelling
# the fixture configured: under Git Bash, MSYS rewrites the `/c/...` argument of `remote add` to
# `C:/...` before Git for Windows stores it (ludics-lite#338). Either spelling reaches the remote.
test_newer_remote_tip_refusal() {
  local after_tip finish hook log mode push_url real_git remote_tip
  for mode in early late rejected; do
    setup_case "newer-remote-tip-$mode" merge main-off
    real_git=$(command -v git)
    log="$CASE_ROOT/cleanup.log"
    git -C "$CASE_INTEGRATOR" checkout -b topic origin/topic >/dev/null
    echo newer >"$CASE_INTEGRATOR/newer"
    git -C "$CASE_INTEGRATOR" add newer
    git -C "$CASE_INTEGRATOR" commit -m "newer remote topic work" >/dev/null
    remote_tip=$(git -C "$CASE_INTEGRATOR" rev-parse HEAD)
    case "$mode" in
    early) git -C "$CASE_INTEGRATOR" push origin topic >/dev/null ;;
    late)
      hook="$CASE_MAIN/.git/hooks/pre-push"
      printf '%s\n' \
        '#!/usr/bin/env bash' \
        '"$REAL_GIT" -C "$RACE_INTEGRATOR" push origin topic >/dev/null 2>&1' \
        'exit 0' >"$hook"
      chmod +x "$hook"
      ;;
    rejected)
      # A push refused with the branch unmoved: the tip stays the validated one, not a race.
      remote_tip=$CASE_TOPIC_OID
      hook="$CASE_MAIN/.git/hooks/pre-push"
      printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$hook"
      chmod +x "$hook"
      ;;
    esac

    if REAL_GIT="$real_git" RACE_INTEGRATOR="$CASE_INTEGRATOR" \
      "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
      fail "cleanup deleted a newer remote topic tip ($mode)"
    fi
    after_tip=$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')
    assert_eq "$after_tip" "$remote_tip" "newer remote topic tip must be preserved ($mode)"
    case "$mode" in
    early) assert_topic_preserved ;;
    late)
      grep "origin/topic moved to $remote_tip before its leased deletion" "$log" >/dev/null ||
        { cat "$log" >&2; fail "the late refusal was not the leased deletion"; }
      grep "that tip was never validated, so only once it is confirmed integrated into origin/master, finish with: " \
        "$log" >/dev/null || { cat "$log" >&2; fail "the late refusal did not state its precondition"; }
      finish=$(sed -n 's/.*, finish with: //p' "$log")
      push_url=$(git -C "$CASE_MAIN" remote get-url --push origin)
      [ "$ON_MSYS" -eq 1 ] || assert_eq "$push_url" "$CASE_REMOTE" "origin must push to the case's remote"
      assert_eq "$finish" "git -C $(printf '%q' "$CASE_MAIN") push --force-with-lease=refs/heads/topic:$remote_tip $(printf '%q' "$push_url") :refs/heads/topic" \
        "the late refusal must end with the leased finishing command"
      rm "$hook"
      eval "$finish" >/dev/null 2>&1 || fail "the printed finishing command failed"
      assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic)" "" \
        "the printed finishing command must delete the newer remote tip"
      ;;
    rejected)
      grep "the leased deletion of origin/topic was refused while it was still at the validated tip $CASE_TOPIC_OID" \
        "$log" >/dev/null || { cat "$log" >&2; fail "the unmoved refusal did not name the validated tip"; }
      ! grep "moved to" "$log" >/dev/null ||
        { cat "$log" >&2; fail "the unmoved refusal claimed the branch moved"; }
      grep "once that cause is resolved, finish with: " "$log" >/dev/null ||
        { cat "$log" >&2; fail "the unmoved refusal did not end with its finishing command"; }
      finish=$(sed -n 's/.*, finish with: //p' "$log")
      push_url=$(git -C "$CASE_MAIN" remote get-url --push origin)
      assert_eq "$finish" "git -C $(printf '%q' "$CASE_MAIN") push --force-with-lease=refs/heads/topic:$CASE_TOPIC_OID $(printf '%q' "$push_url") :refs/heads/topic" \
        "the unmoved refusal must lease the finishing command at the validated tip"
      rm "$hook"
      eval "$finish" >/dev/null 2>&1 || fail "the printed finishing command failed (rejected)"
      assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic)" "" \
        "the printed finishing command must delete the validated remote tip"
      ;;
    esac
  done
  echo "PASS: newer remote topic tip refusal, before the cleanup and during its leased deletion; unmoved refused deletion"
}

test_ls_remote_failure_refusal() {
  local fake_bin real_git log
  setup_case ls-remote-failure merge main-off
  fake_bin="$TEST_ROOT/fake-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/ls-remote-failure.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'for arg in "$@"; do' \
    '  [ "$arg" = ls-remote ] && exit 1' \
    'done' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "ls-remote transport failure was treated as branch absence"
  fi
  grep -F "could not determine whether origin/topic exists (ls-remote exit 1)" "$log" >/dev/null ||
    fail "ls-remote failure was not diagnosed distinctly"
  assert_topic_preserved
  echo "PASS: ls-remote failure refusal"
}

test_invalid_path_refusal() {
  setup_case missing-main-path merge main
  if (cd "$CASE_SESSION" && "$HELPER" "$TEST_ROOT/missing-main" "$CASE_SESSION" topic >/dev/null 2>&1); then
    fail "missing main path did not stop cleanup"
  fi
  assert_topic_preserved

  setup_case missing-session-path merge main
  if "$HELPER" "$CASE_MAIN" "$TEST_ROOT/missing-session" topic >/dev/null 2>&1; then
    fail "missing session path did not stop cleanup"
  fi
  assert_topic_preserved

  setup_case session-subdirectory merge main
  mkdir "$CASE_SESSION/inside"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION/inside" topic >/dev/null 2>&1; then
    fail "session subdirectory was accepted as the worktree root"
  fi
  assert_topic_preserved
  echo "PASS: invalid checkout path refusal"
}

test_git_windows_drive_path_is_absolute() {
  local drive_path fake_bin real_git refusal
  # ludics-lite#147. Under Git Bash, Git reports a path it read from a `.git` file's gitdir line --
  # `--git-common-dir` here, and the whole `--git-path` family the helper calls nineteen times --
  # in NATIVE Windows form (`C:/Users/...`), even though its own other outputs on that platform
  # are `/c/...`. The helper recognized only a leading slash as absolute, so it joined the drive
  # path to the checkout it came from and refused a clean, merged session with a path that cannot
  # exist anywhere:
  #   directory does not exist: /c/.../ocannl-staging-worktrees/wave0913-974/C:/Users/.../.git
  # A drive-rooted path does not resolve on this platform either, so what this case pins is the
  # CLASSIFICATION rather than the outcome: the refusal must name the drive path as it stands and
  # never the concatenation. The native Git Bash leg is recorded in the pull request.
  setup_case windows-drive-common-dir merge main-off
  drive_path='C:/Users/ship-pr/GitHub/repo/.git'
  fake_bin="$TEST_ROOT/windows-drive-common-dir-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  # Only the SESSION's own `--git-common-dir` is answered the Windows way; every other call, the
  # main checkout's included, goes to the real Git. `$1`/`$2` are the helper's own `-C <path>`.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$#" -eq 4 ] && [ "$1" = -C ] && [ "$2" = "$WINDOWS_SESSION" ] &&' \
    '  [ "$3" = rev-parse ] && [ "$4" = --git-common-dir ]; then' \
    '  printf "%s\n" "$WINDOWS_COMMON_DIR"' \
    '  exit 0' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if refusal=$(PATH="$fake_bin:$PATH" REAL_GIT="$real_git" WINDOWS_SESSION="$CASE_SESSION" \
    WINDOWS_COMMON_DIR="$drive_path" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "a session whose common directory cannot be resolved was accepted for cleanup"
  fi
  case "$refusal" in
  *"$CASE_SESSION/$drive_path"*)
    fail "the drive-rooted path was joined to the session checkout: $refusal"
    ;;
  esac
  case "$refusal" in
  *"$drive_path"*) ;;
  *) fail "the refusal did not name the drive-rooted path: $refusal" ;;
  esac
  assert_topic_preserved

  # The other side of the classification: a genuinely relative path -- what Git reports for a
  # primary checkout -- is still joined to the checkout it was read from.
  setup_case windows-drive-relative-common-dir merge main-off
  case "$(git -C "$CASE_MAIN" rev-parse --git-common-dir)" in
  /* | ?:/*) fail "the fixture must reproduce a relative common directory" ;;
  esac
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: a Git for Windows drive-rooted path is not joined to the checkout"
}

# The runner clears the environment's Git configuration for every case (isolate_git_config), so
# the helper's own clearing of it -- `git rev-parse --local-env-vars` lists GIT_CONFIG_COUNT and
# GIT_CONFIG_PARAMETERS -- is exercised here alone, set on the helper's call. Each names an
# `origin` upload-pack program that does not exist (a single-valued key: an extra
# `remote.origin.url` would only append to the repository's own), and each is first shown to break
# the case's `ls-remote` when honoured.
test_git_local_environment_is_cleared() {
  local foreign_index nowhere
  setup_case git-local-environment merge main-off
  foreign_index="$TEST_ROOT/foreign-index"
  nowhere=ship-pr-test-no-such-upload-pack
  cp "$(git -C "$CASE_MAIN" rev-parse --absolute-git-dir)/index" "$foreign_index"
  ! GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.uploadpack GIT_CONFIG_VALUE_0="$nowhere" \
    git -C "$CASE_MAIN" ls-remote origin >/dev/null 2>&1 ||
    fail "the fixture's GIT_CONFIG_COUNT pair did not break origin, so its clearing is untested"
  ! GIT_CONFIG_PARAMETERS="'remote.origin.uploadpack'='$nowhere'" \
    git -C "$CASE_MAIN" ls-remote origin >/dev/null 2>&1 ||
    fail "the fixture's GIT_CONFIG_PARAMETERS did not break origin, so its clearing is untested"

  GIT_DIR="$TEST_ROOT/not-a-repository" GIT_INDEX_FILE="$foreign_index" \
    GIT_WORK_TREE="$TEST_ROOT/not-a-worktree" \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.uploadpack GIT_CONFIG_VALUE_0="$nowhere" \
    GIT_CONFIG_PARAMETERS="'remote.origin.uploadpack'='$nowhere'" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: repository-selection and configuration environment is cleared before path validation"
}

test_non_files_ref_backend_refusal() {
  local fake_bin local_master real_git
  setup_case non-files-ref-backend merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  fake_bin="$TEST_ROOT/non-files-ref-backend-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = rev-parse ] && [ "$4" = --show-ref-format ]; then' \
    '  printf "reftable\n"' \
    '  exit 0' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "non-files ref storage was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "ref-backend refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: non-files ref storage is refused before mutation"
}

test_replacement_refs_disabled() {
  local fake_master remote_master
  setup_case replacement-ref-history unmerged main-off
  remote_master=$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)
  fake_master=$(printf 'replacement master makes topic appear integrated\n' |
    git -C "$CASE_MAIN" commit-tree "$(git -C "$CASE_MAIN" rev-parse "$remote_master^{tree}")" \
      -p "$CASE_TOPIC_OID")
  git -C "$CASE_MAIN" replace "$remote_master" "$fake_master"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "replacement ref made an unmerged topic eligible for cleanup"
  fi
  assert_topic_preserved
  echo "PASS: replacement refs cannot affect integration proofs"
}

test_unrelated_upstream_deletion() {
  setup_case unrelated-upstream merge main
  git -C "$CASE_MAIN" branch unrelated refs/heads/master
  git -C "$CASE_SESSION" branch --set-upstream-to=unrelated topic >/dev/null
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: ancestry-verified deletion ignores unrelated upstream"
}

test_distinct_push_endpoint() {
  local push_remote fetch_tip fetch_after
  setup_case distinct-push-endpoint merge main-off
  push_remote="$CASE_ROOT/push.git"
  git clone --bare "$CASE_REMOTE" "$push_remote" >/dev/null 2>&1
  git -C "$CASE_MAIN" remote set-url --push origin "$push_remote"

  git -C "$CASE_INTEGRATOR" checkout -b topic origin/topic >/dev/null
  echo fetch-only >"$CASE_INTEGRATOR/fetch-only"
  git -C "$CASE_INTEGRATOR" add fetch-only
  git -C "$CASE_INTEGRATOR" commit -m "advance only the fetch endpoint" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin topic >/dev/null
  fetch_tip=$(git -C "$CASE_INTEGRATOR" rev-parse HEAD)

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "cleanup accepted distinct fetch and push repositories"
  fi
  assert_topic_preserved
  git -C "$CASE_MAIN" ls-remote --exit-code --heads "$push_remote" refs/heads/topic >/dev/null 2>&1 ||
    fail "topic disappeared from the refused push endpoint"
  fetch_after=$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')
  assert_eq "$fetch_after" "$fetch_tip" "refused cleanup must preserve the fetch endpoint"
  echo "PASS: distinct fetch and push endpoints are refused"
}

test_topic_tag_collision() {
  setup_case topic-tag-collision merge main-off
  git -C "$CASE_MAIN" tag topic refs/heads/master
  git -C "$CASE_MAIN" push origin refs/tags/topic >/dev/null
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  git -C "$CASE_MAIN" ls-remote --exit-code --tags origin refs/tags/topic >/dev/null 2>&1 ||
    fail "same-named topic tag was removed"
  echo "PASS: fully qualified topic branch deletion"
}

test_master_tag_collision() {
  setup_case master-tag-collision merge none
  git -C "$CASE_MAIN" tag master refs/heads/master
  git -C "$CASE_MAIN" push origin refs/tags/master >/dev/null
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  git -C "$CASE_MAIN" ls-remote --exit-code --tags origin refs/tags/master >/dev/null 2>&1 ||
    fail "same-named master tag was removed"
  echo "PASS: fully qualified master branch fetch"
}

test_excluded_master_fetch_refusal() {
  local remote_base tracked_master
  setup_case excluded-master-fetch merge main-off
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  git -C "$CASE_MAIN" config --unset-all remote.origin.fetch
  git -C "$CASE_MAIN" config --add remote.origin.fetch \
    "+refs/heads/topic:refs/remotes/origin/topic"
  remote_base=$(git -C "$CASE_INTEGRATOR" rev-list --max-parents=0 HEAD)
  git -C "$CASE_INTEGRATOR" push --force origin "$remote_base:refs/heads/master" >/dev/null

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "stale origin/master passed ancestry after master was excluded from the fetch map"
  fi
  tracked_master=$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)
  assert_eq "$tracked_master" "$remote_base" "explicit master fetch must replace stale tracking state"
  assert_topic_preserved
  echo "PASS: explicit master fetch defeats an excluding fetch map"
}

test_conditional_local_ref_deletion() {
  local fake_bin real_git old_oid new_oid tree log
  setup_case conditional-local-delete squash main-off
  fake_bin="$TEST_ROOT/update-ref-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/conditional-local-delete.log"
  old_oid=$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)
  tree=$(git -C "$CASE_MAIN" rev-parse "refs/heads/topic^{tree}")
  new_oid=$(printf '%s\n' "concurrent local topic commit" | \
    git -C "$CASE_MAIN" commit-tree "$tree" -p "$old_oid")
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '  "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/topic "$RACE_NEW_OID" "$RACE_OLD_OID"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_NEW_OID="$new_oid" RACE_OLD_OID="$old_oid" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic \
      --force-integrated "scratch repository confirms the squash merge" >"$log" 2>&1; then
    fail "conditional deletion removed a concurrently advanced local topic"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)" "$new_oid" \
    "concurrently advanced local topic must survive"
  git -C "$CASE_MAIN" cat-file -e "$new_oid^{commit}" || fail "concurrent local commit became unreachable"
  [ -d "$CASE_SESSION" ] || fail "topic worktree was removed after its branch advanced"
  assert_eq "$(git -C "$CASE_SESSION" symbolic-ref --short HEAD)" topic \
    "advanced topic worktree must remain attached"
  assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')" "$old_oid" \
    "remote topic must remain at the validated tip when the local branch advances early"
  echo "PASS: topic advancement preserves its branch and worktree"
}

test_already_absent_remote_retry() {
  setup_case already-absent-remote merge main-off
  git -C "$CASE_MAIN" push origin :refs/heads/topic >/dev/null
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: already-absent remote branch retry"
}

# The race both cases below drive: the helper's own `ls-remote` of the topic answers "absent",
# and before that answer reaches the helper, a racing push recreates origin/topic at RACE_OID from
# the repository RACE_PEER, through its remote RACE_REMOTE (git's own arguments). Which
# repository pushes is what the two cases differ in. A push from the main checkout creates its
# origin/topic tracking ref as well: by remote name under every Git, and since Git 2.56 by URL too
# when the URL uniquely matches a configured remote (its release notes). The second case pins that
# state on purpose; the first case pushed from main by URL until Git 2.56 put it there by accident
# and sent the case red on macOS (runs 38684606527 and 38686293701).
# The helper's combined output goes to $log; the caller judges its exit status.
run_absent_race_helper() {
  local peer="$1" remote="$2" new_oid="$3" log="$4" fake_bin real_git
  fake_bin="$TEST_ROOT/$(basename "$CASE_ROOT")-race-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'is_topic_query=0' \
    'for arg in "$@"; do' \
    '  [ "$arg" = refs/heads/topic ] && is_topic_query=1' \
    'done' \
    'if [ "$3" = ls-remote ] && [ "$is_topic_query" -eq 1 ]; then' \
    '  output=$("$REAL_GIT" "$@")' \
    '  status=$?' \
    '  "$REAL_GIT" -C "$RACE_PEER" push --no-verify "$RACE_REMOTE" "$RACE_OID:refs/heads/topic" >/dev/null' \
    '  printf "%s\\n" "$output"' \
    '  exit "$status"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"
  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_PEER="$peer" \
    RACE_REMOTE="$remote" RACE_OID="$new_oid" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1
}

# A branch recreated by ANOTHER repository after the helper saw it absent: the recreation reaches
# only the remote, as it would from another machine, so the helper cleans the local side and
# must leave the new remote branch alone. The integrator clone is that other repository.
test_absent_remote_recreation_race() {
  local local_oid new_oid log tree
  setup_case absent-remote-race merge main-off
  local_oid=$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)
  tree=$(git -C "$CASE_MAIN" rev-parse "refs/heads/topic^{tree}")
  new_oid=$(printf '%s\n' "concurrent remote recreation" | \
    git -C "$CASE_INTEGRATOR" commit-tree "$tree" -p "$local_oid")
  git -C "$CASE_MAIN" push origin :refs/heads/topic >/dev/null
  log="$TEST_ROOT/absent-race.log"
  run_absent_race_helper "$CASE_INTEGRATOR" origin "$new_oid" "$log" ||
    { tail -n 40 "$log" >&2; fail "cleanup after an absent advertisement failed (log tail above)"; }
  assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')" \
    "$new_oid" "branch created after an absent observation must never be deleted"
  git -C "$CASE_MAIN" push origin :refs/heads/topic >/dev/null
  assert_cleaned
  echo "PASS: branch created after absent advertisement is preserved"
}

# The same recreation pushed from the main checkout, which also creates its origin/topic
# tracking ref after the helper's snapshot of it: the helper refuses before any topic mutation,
# and the recreated remote branch, its tracking ref and the local side all survive.
test_absent_remote_tracking_ref_appears() {
  local local_oid new_oid log tree
  setup_case absent-remote-tracking-appears merge main-off
  local_oid=$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)
  tree=$(git -C "$CASE_MAIN" rev-parse "refs/heads/topic^{tree}")
  new_oid=$(printf '%s\n' "concurrent recreation from this checkout" | \
    git -C "$CASE_MAIN" commit-tree "$tree" -p "$local_oid")
  # Unlogged, like the racing push: the push log is the record of the helper's own pushes.
  git -C "$CASE_MAIN" push --no-verify origin :refs/heads/topic >/dev/null
  log="$TEST_ROOT/absent-tracking-appears.log"
  if run_absent_race_helper "$CASE_MAIN" origin "$new_oid" "$log"; then
    cat "$log" >&2
    fail "cleanup proceeded past an origin/topic tracking ref that appeared after its snapshot"
  fi
  grep -F "origin/topic tracking ref appeared during cleanup; its new tip was preserved" "$log" >/dev/null ||
    { tail -n 40 "$log" >&2; fail "the refusal did not name the appeared tracking ref (log tail above)"; }
  assert_topic_preserved
  assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')" \
    "$new_oid" "branch created after an absent observation must never be deleted"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/topic)" "$new_oid" \
    "the appeared tracking ref must be preserved"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)" "$local_oid" \
    "the local topic must be untouched"
  echo "PASS: tracking ref appearing after an absent advertisement is refused"
}

test_other_topic_owner_refusal() {
  local other_topic
  setup_case other-topic-owner merge none
  other_topic="$CASE_ROOT/other-topic-worktree"
  git -C "$CASE_SESSION" checkout --detach >/dev/null
  git -C "$CASE_MAIN" worktree add "$other_topic" topic >/dev/null
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "detached session deleted a topic owned by another worktree"
  fi
  assert_topic_preserved
  assert_eq "$(git -C "$other_topic" symbolic-ref --short HEAD)" topic \
    "other topic worktree must remain attached"
  echo "PASS: topic owned by another worktree is refused"
}

test_dirty_session_refusal() {
  setup_case dirty-session merge main-off
  echo dirty >"$CASE_SESSION/untracked"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "dirty session was accepted for destructive cleanup"
  fi
  assert_topic_preserved
  assert_eq "$(git -C "$CASE_SESSION" symbolic-ref --short HEAD)" topic \
    "dirty session must remain attached"
  echo "PASS: dirty session is refused before cleanup"
}

test_ignored_session_refusal() {
  setup_case ignored-session merge main-off
  echo local.log >>"$CASE_MAIN/.git/info/exclude"
  echo irreplaceable >"$CASE_SESSION/local.log"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "session containing ignored data was accepted for destructive cleanup"
  fi
  assert_eq "$(sed -n '1p' "$CASE_SESSION/local.log")" irreplaceable \
    "ignored session data must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: ignored session data is refused before cleanup"
}

# The session gate's two narrow exceptions (ludics-lite#194, ludics-lite#205 §1). Everything the
# rules do not clear keeps its refusal: test_ignored_session_refusal covers an ignored file with no
# counterpart in the base checkout, and the two refusal cases below cover a differing file and a
# symlink. These four fail against the pre-fix gate, which refused on any ignored path at all.
test_session_harness_ignored_data_passes() {
  # The harness-owned directory as Git collapses it: the exclude matches the directory itself.
  setup_case harness-ignored-session merge main-off
  echo '.claude/' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_SESSION/.claude"
  echo '{"sessionId":"other-session","pid":1}' >"$CASE_SESSION/.claude/scheduled_tasks.lock"
  assert_eq "$(git -C "$CASE_SESSION" status --porcelain --ignored=matching)" '!! .claude/' \
    "the fixture must reproduce the collapsed harness directory"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  [ -f "$CASE_ARCHIVE/worktree/.claude/scheduled_tasks.lock" ] ||
    fail "the archived session must still carry the harness directory"

  # And as individual files, which is what an exclude naming the files produces.
  setup_case harness-ignored-session-files merge main-off
  printf '.claude/scheduled_tasks.lock\n.claude/settings.local.json\n' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_SESSION/.claude"
  echo lock >"$CASE_SESSION/.claude/scheduled_tasks.lock"
  echo '{}' >"$CASE_SESSION/.claude/settings.local.json"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: harness-owned ignored .claude data passes the session gate"
}

test_session_ignored_identical_to_base_passes() {
  setup_case identical-ignored-session merge main-off
  echo copied.conf >>"$CASE_MAIN/.git/info/exclude"
  echo 'copied at worktree creation' >"$CASE_MAIN/copied.conf"
  cp "$CASE_MAIN/copied.conf" "$CASE_SESSION/copied.conf"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(cat "$CASE_MAIN/copied.conf")" 'copied at worktree creation' \
    "the base checkout's own copy must be untouched"
  echo "PASS: an ignored file identical to the base checkout's copy passes the session gate"
}

test_session_ignored_differing_from_base_refusal() {
  local refusal
  setup_case differing-ignored-session merge main-off
  echo copied.conf >>"$CASE_MAIN/.git/info/exclude"
  echo 'base copy' >"$CASE_MAIN/copied.conf"
  echo 'edited in the session' >"$CASE_SESSION/copied.conf"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an ignored file differing from the base checkout was accepted for destructive cleanup"
  fi
  case "$refusal" in
  *"copied.conf"*) ;;
  *) fail "the refusal did not name the ignored path it tripped on: $refusal" ;;
  esac
  case "$refusal" in
  *stash*) fail "the refusal must not advise a stash: $refusal" ;;
  esac
  assert_eq "$(cat "$CASE_SESSION/copied.conf")" 'edited in the session' \
    "differing ignored session data must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: an ignored file differing from the base checkout is refused and named"
}

test_session_ignored_symlink_refusal() {
  local refusal
  # A symlink names a target rather than holding content, so it never passes the identity rule
  # even when its target reads the same as the base checkout's regular file.
  setup_case symlink-ignored-session merge main-off
  echo copied.conf >>"$CASE_MAIN/.git/info/exclude"
  echo 'same bytes' >"$CASE_MAIN/copied.conf"
  echo 'same bytes' >"$CASE_ROOT/symlink-target"
  ln -s "$CASE_ROOT/symlink-target" "$CASE_SESSION/copied.conf"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an ignored symlink was accepted for destructive cleanup"
  fi
  case "$refusal" in
  *"copied.conf"*) ;;
  *) fail "the symlink refusal did not name the ignored path: $refusal" ;;
  esac
  [ -L "$CASE_SESSION/copied.conf" ] || fail "the ignored symlink must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: an ignored symlink is refused even when its target matches the base checkout"
}

# Neither exemption may follow a symbolic link, and neither may be decided by how Git RENDERS a
# path (review round 1 on ludics-lite#210). These three fail against round 1's gate.
test_session_bare_claude_entry_refusal() {
  local refusal
  # `.claude` as a regular file is not the harness directory, and Git reports it as `!! .claude`.
  setup_case bare-claude-file merge main-off
  echo '.claude' >>"$CASE_MAIN/.git/info/exclude"
  echo irreplaceable >"$CASE_SESSION/.claude"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an ignored regular file named .claude was accepted for destructive cleanup"
  fi
  case "$refusal" in
  *".claude"*) ;;
  *) fail "the refusal did not name the bare .claude path: $refusal" ;;
  esac
  assert_eq "$(cat "$CASE_SESSION/.claude")" irreplaceable \
    "a bare .claude file must survive refused cleanup"
  assert_topic_preserved

  # And as a symlink, whose target cleanup would leave behind entirely.
  setup_case bare-claude-symlink merge main-off
  echo '.claude' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_ROOT/elsewhere"
  ln -s "$CASE_ROOT/elsewhere" "$CASE_SESSION/.claude"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "an ignored symlink named .claude was accepted for destructive cleanup"
  fi
  assert_topic_preserved
  echo "PASS: an ignored .claude that is not a directory keeps its refusal"
}

test_session_ignored_symlinked_base_ancestor_refusal() {
  local refusal
  # The base checkout reaches the comparison path through a symlinked ancestor, so its "copy" is a
  # file outside the checkout: the session file has no in-tree counterpart and must be refused.
  setup_case symlinked-base-ancestor merge main-off
  echo 'cache/config' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_ROOT/outside"
  echo 'shared bytes' >"$CASE_ROOT/outside/config"
  ln -s "$CASE_ROOT/outside" "$CASE_MAIN/cache"
  mkdir -p "$CASE_SESSION/cache"
  echo 'shared bytes' >"$CASE_SESSION/cache/config"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an ignored file cleared through a symlinked base ancestor was accepted for cleanup"
  fi
  case "$refusal" in
  *"cache/config"*) ;;
  *) fail "the refusal did not name the path it tripped on: $refusal" ;;
  esac
  assert_eq "$(cat "$CASE_SESSION/cache/config")" 'shared bytes' \
    "the session's ignored file must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: a symlinked ancestor in the base checkout is not a base-checkout copy"
}

test_session_ignored_quoted_path_passes() {
  local name='copied config.coné'
  # Porcelain v1 C-quotes this name (whitespace, and non-ASCII under the default core.quotePath),
  # so a gate that read the rendering would refuse a file it is supposed to clear.
  setup_case quoted-ignored-session merge main-off
  printf '%s\n' "$name" >>"$CASE_MAIN/.git/info/exclude"
  echo 'copied at worktree creation' >"$CASE_MAIN/$name"
  cp "$CASE_MAIN/$name" "$CASE_SESSION/$name"
  case "$(git -C "$CASE_SESSION" status --porcelain --ignored=matching)" in
  '!! "'*) ;;
  *) fail "the fixture must produce a C-quoted porcelain path" ;;
  esac
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: a C-quoted ignored path identical to the base checkout's copy passes the session gate"
}

# Git reports an excluded DIRECTORY as one entry with nothing inside it shown, and a pathname is
# data the operator's terminal will render (review round 2 on ludics-lite#210). Both fail against
# round 2's gate.
test_session_ignored_directory_of_base_copies() {
  local refusal
  setup_case ignored-directory-of-base-copies merge main-off
  echo 'cache/' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_MAIN/cache/sub" "$CASE_SESSION/cache/sub" "$CASE_SESSION/cache/empty"
  echo 'copied' >"$CASE_MAIN/cache/config"
  echo 'copied deeper' >"$CASE_MAIN/cache/sub/deep"
  cp "$CASE_MAIN/cache/config" "$CASE_SESSION/cache/config"
  cp "$CASE_MAIN/cache/sub/deep" "$CASE_SESSION/cache/sub/deep"
  assert_eq "$(git -C "$CASE_SESSION" status --porcelain --ignored=matching)" '!! cache/' \
    "the fixture must reproduce the collapsed ignored directory"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned

  # One file beneath it that is not a base copy refuses the whole entry.
  setup_case ignored-directory-with-session-data merge main-off
  echo 'cache/' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_MAIN/cache" "$CASE_SESSION/cache"
  echo 'copied' >"$CASE_MAIN/cache/config"
  cp "$CASE_MAIN/cache/config" "$CASE_SESSION/cache/config"
  echo irreplaceable >"$CASE_SESSION/cache/session-only"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an ignored directory holding session-only data was accepted for destructive cleanup"
  fi
  case "$refusal" in
  *"cache/"*) ;;
  *) fail "the refusal did not name the ignored directory: $refusal" ;;
  esac
  assert_eq "$(cat "$CASE_SESSION/cache/session-only")" irreplaceable \
    "session-only data under an ignored directory must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: an ignored directory is cleared exactly when every file beneath it is a base copy"
}

test_session_ignored_path_control_characters_are_escaped() {
  local name refusal lines
  name=$(printf 'evil\npost-merge-cleanup.sh: forged line')
  setup_case control-character-ignored-session merge main-off
  printf '%s\n' 'evil*' >>"$CASE_MAIN/.git/info/exclude"
  echo session-only >"$CASE_SESSION/$name"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an ignored path with a newline in its name was accepted for destructive cleanup"
  fi
  lines=$(printf '%s\n' "$refusal" | wc -l | tr -d ' ')
  assert_eq "$lines" 1 "the refusal must stay one line, so a pathname cannot forge another"
  case "$refusal" in
  *'forged line'*) ;;
  *) fail "the refusal should still name the path, escaped: $refusal" ;;
  esac
  assert_topic_preserved
  echo "PASS: a refused ignored path is rendered without its control characters"
}

# A walk that did not see the whole tree cannot clear it (review round 3 on ludics-lite#210).
test_session_ignored_directory_unreadable_subtree_refusal() {
  local refusal outcome
  setup_case ignored-directory-unreadable merge main-off
  echo 'cache/' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_MAIN/cache" "$CASE_SESSION/cache/locked"
  echo 'copied' >"$CASE_MAIN/cache/config"
  cp "$CASE_MAIN/cache/config" "$CASE_SESSION/cache/config"
  echo irreplaceable >"$CASE_SESSION/cache/locked/session-only"
  chmod 000 "$CASE_SESSION/cache/locked"
  if [ -r "$CASE_SESSION/cache/locked" ]; then
    chmod 755 "$CASE_SESSION/cache/locked"
    skip_boundary "an unreadable subtree: this account reads a directory whose mode is 000 (root, or an MSYS mode bit Windows does not enforce)"
    return 0
  fi
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    outcome=accepted
  else
    outcome=refused
  fi
  # Unlock whatever the helper left, wherever it left it, and before the first assertion can exit
  # this case: a 000 directory anywhere under the scratch root defeats the suite's EXIT `rm -rf`
  # and leaks the whole tree. Naming the session copy alone is not enough -- an accepted cleanup
  # MOVES it into the archive beside it, carrying the mode, and then the chmod itself fails on the
  # path that is no longer there. `-R` over the case subtree covers both spots, and u+rwX adds
  # search permission to directories without making the file executable.
  chmod -R u+rwX "$CASE_ROOT"
  assert_eq "$outcome" refused \
    "an ignored directory whose walk failed must not be cleared as base copies"
  case "$refusal" in
  *"cache/"*) ;;
  *) fail "the refusal did not name the ignored directory: $refusal" ;;
  esac
  assert_eq "$(cat "$CASE_SESSION/cache/locked/session-only")" irreplaceable \
    "data in the unreadable subtree must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: an ignored directory with an unreadable subtree keeps its refusal"
}

# ludics-lite#205 §2. A build tree slips between both session-gate exemptions by construction: it
# is not harness-owned `.claude/`, and it is dune (or npm, or opam) output, so being different
# from the base checkout's copy is the whole point of it. That refused every ocannl-staging
# worktree that had ever been built -- 92M on the sighting recorded in ludics-lite#215 -- and
# archiving it would be worse than refusing, since the archive is exactly the "out of sight" the
# gate guards against and one would accumulate per landed PR. `--regenerable` lets the operator
# name such a directory as one the helper may REMOVE rather than archive. These two cases fail
# against the pre-flag helper, which refused the flag itself.
test_regenerable_directory_clears_the_session_gate() {
  local refusal
  setup_case regenerable-ignored-session merge main-off
  echo '_build/' >>"$CASE_MAIN/.git/info/exclude"
  mkdir -p "$CASE_SESSION/_build/default"
  echo 'dune output' >"$CASE_SESSION/_build/default/value.exe"
  # Shown first without the flag: the gate refuses and names the path.
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "a session holding a build tree was accepted for destructive cleanup"
  fi
  case "$refusal" in
  *_build*) ;;
  *) fail "the refusal did not name the build tree: $refusal" ;;
  esac
  [ -d "$CASE_SESSION/_build" ] || fail "the build tree must survive a refused cleanup"
  assert_topic_preserved

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable _build >/dev/null
  assert_cleaned
  [ ! -e "$CASE_ARCHIVE/worktree/_build" ] ||
    fail "a regenerable directory must be removed, not archived out of sight"

  # Untracked rather than ignored -- a repository that never excluded its build tree. The removal
  # happens before either gate reads the worktree, so this is the dirty-session refusal, not the
  # ignored-data one, and the same flag clears it.
  setup_case regenerable-untracked-session merge main-off
  mkdir -p "$CASE_SESSION/_build"
  echo 'dune output' >"$CASE_SESSION/_build/value.exe"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "a session holding an untracked build tree was accepted for destructive cleanup"
  fi
  assert_topic_preserved
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable _build >/dev/null
  assert_cleaned

  # A name the worktree does not carry is a no-op: a worktree that never built has no `_build`,
  # and the operator's command line does not change between one cleanup and the next.
  setup_case regenerable-absent-session merge main-off
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable _build --regenerable node_modules \
    >/dev/null
  assert_cleaned
  echo "PASS: --regenerable removes a named build tree instead of refusing over it"
}

test_regenerable_refusals() {
  local candidate refusal rc
  # The flag names ONE top-level directory of the session worktree, so a value carrying a slash
  # is refused rather than resolved: that is what keeps `..`, an absolute path and a nested path
  # out without a traversal check.
  setup_case regenerable-nested-name merge main-off
  mkdir -p "$CASE_SESSION/nested/inside"
  echo irreplaceable >"$CASE_SESSION/nested/inside/data"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable nested/inside 2>&1); then
    fail "a nested regenerable name was accepted"
  fi
  case "$refusal" in
  *'nested/inside'*) ;;
  *) fail "the refusal did not name the rejected value: $refusal" ;;
  esac
  [ -d "$CASE_SESSION/nested/inside" ] || fail "a refused name must remove nothing"
  assert_topic_preserved
  for candidate in .. . /etc "$CASE_SESSION/_build"; do
    if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable "$candidate" >/dev/null 2>&1; then
      fail "a regenerable name outside the worktree root was accepted: $candidate"
    fi
  done
  assert_topic_preserved
  rc=0
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable >/dev/null 2>&1 || rc=$?
  assert_eq "$rc" 2 "a --regenerable without a value must be a usage error"
  rc=0
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable '' >/dev/null 2>&1 || rc=$?
  assert_eq "$rc" 2 "an empty --regenerable value must be a usage error"

  # A symbolic link names a target rather than holding content, and `rm -rf` through one would
  # remove a tree the worktree does not hold. It is refused at the leaf, with its target intact.
  setup_case regenerable-symlink merge main-off
  mkdir -p "$CASE_ROOT/elsewhere"
  echo irreplaceable >"$CASE_ROOT/elsewhere/data"
  ln -s "$CASE_ROOT/elsewhere" "$CASE_SESSION/_build"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable _build 2>&1); then
    fail "a symbolic regenerable directory was accepted"
  fi
  case "$refusal" in
  *_build*) ;;
  *) fail "the symlink refusal did not name the path: $refusal" ;;
  esac
  assert_eq "$(sed -n '1p' "$CASE_ROOT/elsewhere/data")" irreplaceable \
    "the symlink's target must survive"
  [ -L "$CASE_SESSION/_build" ] || fail "the symlink itself must survive"
  assert_topic_preserved

  # A regular file of that name is not the build tree either.
  setup_case regenerable-regular-file merge main-off
  echo irreplaceable >"$CASE_SESSION/_build"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable _build >/dev/null 2>&1; then
    fail "a regular file was accepted as a regenerable directory"
  fi
  assert_eq "$(sed -n '1p' "$CASE_SESSION/_build")" irreplaceable \
    "a refused regular file must survive"
  assert_topic_preserved

  # And a TRACKED directory is repository content: `--regenerable src` must never be the operator
  # deleting their own source tree, whatever they typed.
  setup_case regenerable-tracked merge main-off
  mkdir -p "$CASE_SESSION/src"
  echo 'let () = ()' >"$CASE_SESSION/src/main.ml"
  land_topic_change "tracked source directory" "merge tracked source" src/main.ml
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable src 2>&1); then
    fail "a tracked directory was accepted as regenerable"
  fi
  case "$refusal" in
  *src*) ;;
  *) fail "the tracked refusal did not name the path: $refusal" ;;
  esac
  assert_eq "$(sed -n '1p' "$CASE_SESSION/src/main.ml")" 'let () = ()' \
    "a tracked directory must survive"
  assert_topic_preserved
  echo "PASS: a regenerable name that is not an untracked top-level directory is refused"
}

# Review round 1 on the pull request that added the flag. All three findings are about the same
# thing: a guard that decides an `rm -rf` must agree with the FILESYSTEM about which entry the
# operator named, and with the INDEX about whether that entry is repository content. These three
# legs fail against round 1's code.
test_regenerable_name_resolution_refusals() {
  local newline_dir refusal survivors
  # P2: `\` is a path separator under Git Bash, so a check that looked only for `/` let a nested
  # value through to the filesystem, where it named a path below the worktree root.
  setup_case regenerable-backslash-name merge main-off
  mkdir -p "$CASE_SESSION/nested/cache"
  echo irreplaceable >"$CASE_SESSION/nested/cache/data"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable 'nested\cache' 2>&1); then
    fail "a backslash-separated regenerable name was accepted"
  fi
  case "$refusal" in
  *'nested'*) ;;
  *) fail "the refusal did not name the rejected value: $refusal" ;;
  esac
  assert_eq "$(sed -n '1p' "$CASE_SESSION/nested/cache/data")" irreplaceable \
    "a backslash-separated name must remove nothing"
  assert_topic_preserved

  # P1: a filesystem that folds names resolves `SRC` to a tracked `src`, while Git's pathspec
  # matching is byte-exact and reports that `SRC` holds nothing tracked -- so the tracked-path
  # guard cleared an `rm -rf` of the source tree. The worktree root must hold an entry spelled
  # exactly as given, which is checked here on whichever kind of volume the suite is running on:
  # where the fold happens the alias is REFUSED, and where it does not the name is simply absent
  # and the documented no-op applies. Either way the tracked source tree survives, which is the
  # property the finding is about.
  setup_case regenerable-case-alias merge main-off
  mkdir -p "$CASE_SESSION/src"
  echo 'let () = ()' >"$CASE_SESSION/src/main.ml"
  land_topic_change "tracked source directory" "merge tracked source" src/main.ml
  if [ -d "$CASE_SESSION/SRC" ]; then
    # A name-folding volume: the alias resolves, and must be refused before the tracked-path guard
    # is asked about a spelling the index does not hold.
    if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable SRC 2>&1); then
      fail "a case-folded alias of a tracked directory was accepted as regenerable"
    fi
    case "$refusal" in
    *SRC*) ;;
    *) fail "the alias refusal did not name the value: $refusal" ;;
    esac
    assert_topic_preserved
    assert_eq "$(sed -n '1p' "$CASE_SESSION/src/main.ml")" 'let () = ()' \
      "the tracked source tree must survive the refused alias"
  else
    # A byte-exact volume: nothing is named `SRC`, so this is the absent-name no-op, and the
    # tracked source tree reaches the session archive rather than being removed.
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable SRC >/dev/null
    assert_cleaned
    assert_eq "$(sed -n '1p' "$CASE_ARCHIVE/worktree/src/main.ml")" 'let () = ()' \
      "the tracked source tree must reach the archive intact"
  fi

  # P1: the tracked-path guard read its NUL-delimited stream as lines and took the first one, so a
  # tracked directory whose name begins with a NEWLINE looked untracked -- the first line of that
  # rendering is empty -- and `rm -rf` would have run over repository content.
  if [ "$ON_MSYS" -eq 1 ]; then
    skip_boundary "the newline-named tracked directory leg: $MSYS_CONTROL_NAME_BOUNDARY"
    echo "PASS: a regenerable name the filesystem resolves differently is refused"
    return 0
  fi
  setup_case regenerable-newline-tracked merge main-off
  newline_dir=$(printf '\nbuild')
  mkdir -p "$CASE_SESSION/$newline_dir"
  echo 'tracked output' >"$CASE_SESSION/$newline_dir/kept"
  land_topic_change "tracked directory whose name starts with a newline" "merge newline directory" "$newline_dir/kept"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --regenerable "$newline_dir" 2>&1); then
    fail "a tracked directory whose name begins with a newline was accepted as regenerable"
  fi
  case "$refusal" in
  *tracked*) ;;
  *) fail "the refusal did not say the path is tracked: $refusal" ;;
  esac
  survivors=$(sed -n '1p' "$CASE_SESSION/$newline_dir/kept")
  assert_eq "$survivors" 'tracked output' "the tracked newline-named directory must survive"
  assert_topic_preserved
  echo "PASS: a regenerable name the filesystem or the index resolves differently is refused"
}

test_master_reservation() {
  local fake_bin real_git candidate remote_master checkout_status
  setup_case master-owner-switch merge other
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  candidate="$CASE_ROOT/master-candidate"
  git -C "$CASE_MAIN" worktree add --detach "$candidate" refs/heads/master >/dev/null
  fake_bin="$TEST_ROOT/master-owner-switch-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '  "$REAL_GIT" -C "$MASTER_CANDIDATE" checkout master >/dev/null 2>&1' \
    '  echo "$?" >"$SWITCH_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if ! PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_CANDIDATE="$candidate" \
    SWITCH_MARKER="$TEST_ROOT/master-owner-switch.count" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "continuously owned master update failed"
  fi
  checkout_status=$(cat "$TEST_ROOT/master-owner-switch.count")
  [ "$checkout_status" -ne 0 ] || fail "another worktree acquired master during its named update"
  assert_cleaned
  assert_eq "$(git -C "$CASE_MASTER_OWNER" rev-parse refs/heads/master)" "$remote_master" \
    "named master ref must reach the remote tip"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "master must remain continuously owned"
  ! git -C "$candidate" symbolic-ref -q HEAD >/dev/null 2>&1 ||
    fail "candidate worktree stopped being detached"
  echo "PASS: continuous master ownership blocks another checkout"
}

test_unowned_master_reservation() {
  local fake_bin real_git candidate checkout_status
  setup_case unowned-master-reservation merge none
  candidate="$CASE_ROOT/master-candidate"
  git -C "$CASE_MAIN" worktree add --detach "$candidate" refs/heads/master >/dev/null
  fake_bin="$TEST_ROOT/unowned-master-reservation-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '  "$REAL_GIT" -C "$MASTER_CANDIDATE" checkout master >/dev/null 2>&1' \
    '  echo "$?" >"$SWITCH_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if ! PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_CANDIDATE="$candidate" \
    SWITCH_MARKER="$TEST_ROOT/unowned-master-reservation.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "temporary reservation of unchecked-out master failed"
  fi
  checkout_status=$(cat "$TEST_ROOT/unowned-master-reservation.status")
  [ "$checkout_status" -ne 0 ] || fail "another worktree acquired initially unowned master"
  assert_cleaned
  ! git -C "$candidate" symbolic-ref -q HEAD >/dev/null 2>&1 ||
    fail "candidate worktree stopped being detached"
  echo "PASS: unchecked-out master is reserved during its update"
}

test_concurrent_master_edit_refusal() {
  local fake_bin real_git log remote_master
  setup_case concurrent-master-edit merge other
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  fake_bin="$TEST_ROOT/concurrent-master-edit-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/concurrent-master-edit.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = checkout ] && [ "$4" = --detach ] && [ "$5" = --no-overwrite-ignore ] && [ "$6" = "$RACE_TARGET" ]; then' \
    '  echo concurrent-edit >"$MASTER_OWNER/value"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_OWNER="$CASE_MASTER_OWNER" \
    RACE_TARGET="$remote_master" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "master fast-forward discarded a concurrent tracked edit"
  fi
  assert_eq "$(sed -n '1p' "$CASE_MASTER_OWNER/value")" concurrent-edit \
    "concurrent master edit must survive a refused fast-forward"
  assert_topic_preserved
  echo "PASS: concurrent master edit is refused without data loss"
}

test_concurrent_ignored_master_collision() {
  local fake_bin real_git log collision remote_master
  setup_case concurrent-ignored-master-collision merge other
  collision="$CASE_MASTER_OWNER/collision"
  echo remote-data >"$CASE_INTEGRATOR/collision"
  git -C "$CASE_INTEGRATOR" add collision
  git -C "$CASE_INTEGRATOR" commit -m "add incoming master path" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  echo collision >>"$CASE_MAIN/.git/info/exclude"
  fake_bin="$TEST_ROOT/concurrent-ignored-master-collision-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/concurrent-ignored-master-collision.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = checkout ] && [ "$4" = --detach ] && [ "$5" = --no-overwrite-ignore ] && [ "$6" = "$RACE_TARGET" ]; then' \
    '  echo local-data >"$MASTER_COLLISION"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_COLLISION="$collision" \
    RACE_TARGET="$remote_master" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "master fast-forward overwrote an ignored file created after collision preflight"
  fi
  assert_eq "$(sed -n '1p' "$collision")" local-data \
    "concurrently created ignored master data must survive"
  assert_topic_preserved
  echo "PASS: concurrent ignored master collision is refused"
}

# On the standard single-main-checkout layout the master owner ALWAYS carries ignored data (build
# caches, local config). Ignored files on paths the fast-forward does not touch are not at risk,
# so they must pass; ignored data on touched paths keeps its refusal
# (test_ignored_master_collision_refusal, test_ignored_master_descendant_refusal).
test_preexisting_ignored_master_data() {
  setup_case preexisting-ignored-master-data merge other
  echo unrelated.log >>"$CASE_MAIN/.git/info/exclude"
  echo local-data >"$CASE_MASTER_OWNER/unrelated.log"

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MASTER_OWNER" rev-parse HEAD)" \
    "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)" \
    "master owner with untouched ignored data must be fast-forwarded"
  assert_eq "$(sed -n '1p' "$CASE_MASTER_OWNER/unrelated.log")" local-data \
    "ignored master data on untouched paths must survive the fast-forward"
  echo "PASS: ignored master data on untouched paths passes cleanup intact"
}

# ludics-lite#215. The base-owner gate reads UNTRACKED files -- ignored data deliberately passes
# it, as the case above records. The agent harness writes `.claude/` into every checkout it opens,
# so in a repository whose ignore rules do not carry that name the primary checkout, which is
# where the desktop harness most often sits and which owns the base on the standard layout,
# refused cleanup unconditionally. The session gate's allow-list applies here too: harness-owned
# `.claude/`, a real directory, no symbolic link at any component. #240's `git ls-files` fix for
# the fleet-worker layout guard does NOT transfer -- this gate judges a checkout's contents, and
# reading the index would defeat it rather than fix it. These two fail against the pre-fix gate.
test_master_owner_harness_untracked_data_passes() {
  setup_case harness-untracked-master merge main
  mkdir -p "$CASE_MAIN/.claude"
  echo '{"sessionId":"other-session","pid":1}' >"$CASE_MAIN/.claude/scheduled_tasks.lock"
  assert_eq "$(git -C "$CASE_MAIN" status --porcelain --untracked-files=normal)" '?? .claude/' \
    "the fixture must reproduce an untracked, unignored harness directory"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(sed -n '1p' "$CASE_MAIN/.claude/scheduled_tasks.lock")" \
    '{"sessionId":"other-session","pid":1}' \
    "the base owner's harness directory must be left exactly as it was"

  # And as individual entries, which is what Git reports once the repository tracks anything under
  # `.claude/`. Here the incoming base does: the entry is collapsed at the preflight gate and
  # spelled out at the recheck after the locked refresh, so this leg covers both readings and the
  # post-refresh site, where a refusal would abandon a fast-forward that had already landed.
  setup_case harness-untracked-master-files merge main
  mkdir -p "$CASE_SESSION/.claude"
  echo 'tracked by the repository' >"$CASE_SESSION/.claude/tracked"
  land_topic_change "repository content under .claude" "merge .claude content" .claude/tracked
  mkdir -p "$CASE_MAIN/.claude"
  echo lock >"$CASE_MAIN/.claude/scheduled_tasks.lock"
  assert_eq "$(git -C "$CASE_MAIN" status --porcelain --untracked-files=normal)" '?? .claude/' \
    "the fixture must start from the collapsed entry"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" status --porcelain --untracked-files=normal)" \
    '?? .claude/scheduled_tasks.lock' \
    "the refreshed base owner must spell the harness entry out"
  assert_eq "$(sed -n '1p' "$CASE_MAIN/.claude/scheduled_tasks.lock")" lock \
    "the base owner's harness file must be left exactly as it was"
  echo "PASS: harness-owned untracked .claude data passes the base-owner gate"
}

test_master_owner_untracked_data_refusal() {
  local refusal
  # Everything the allow-list does not clear keeps its refusal, and the refusal names the paths it
  # tripped on rather than only the checkout, since the operator's decision for `.claude/` is
  # nothing like the one for a forgotten edit.
  setup_case untracked-master merge main
  echo irreplaceable >"$CASE_MAIN/notes.txt"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an untracked file in the base owner was accepted for cleanup"
  fi
  case "$refusal" in
  *notes.txt*) ;;
  *) fail "the refusal did not name the untracked path: $refusal" ;;
  esac
  assert_eq "$(sed -n '1p' "$CASE_MAIN/notes.txt")" irreplaceable \
    "untracked base-owner data must survive refused cleanup"
  assert_topic_preserved

  # A tracked change is not untracked data and keeps the refusal it always had.
  setup_case dirty-master merge main
  echo edited >"$CASE_MAIN/value"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "a tracked edit in the base owner was accepted for cleanup"
  fi
  case "$refusal" in
  *value*) ;;
  *) fail "the refusal did not name the edited path: $refusal" ;;
  esac
  assert_topic_preserved

  # `.claude` as a regular file is not the harness directory, and Git reports it as `?? .claude`.
  setup_case bare-claude-file-master merge main
  echo irreplaceable >"$CASE_MAIN/.claude"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an untracked regular file named .claude was accepted for cleanup"
  fi
  case "$refusal" in
  *.claude*) ;;
  *) fail "the refusal did not name the bare .claude path: $refusal" ;;
  esac
  assert_eq "$(cat "$CASE_MAIN/.claude")" irreplaceable \
    "a bare .claude file must survive refused cleanup"
  assert_topic_preserved

  # And as a symbolic link, whose target the gate would otherwise be judging instead.
  setup_case bare-claude-symlink-master merge main
  mkdir -p "$CASE_ROOT/elsewhere"
  ln -s "$CASE_ROOT/elsewhere" "$CASE_MAIN/.claude"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "an untracked symlink named .claude was accepted for cleanup"
  fi
  [ -L "$CASE_MAIN/.claude" ] || fail "the symlink must survive refused cleanup"
  assert_topic_preserved
  echo "PASS: base-owner data the allow-list does not clear is refused and named"
}

test_master_owner_switch_refusal() {
  local checkout_status fake_bin real_git local_master log remote_master
  setup_case master-owner-branch-switch merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" branch alternate "$local_master"
  fake_bin="$TEST_ROOT/master-owner-branch-switch-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/master-owner-branch-switch.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '  "$REAL_GIT" -C "$MASTER_OWNER" checkout alternate >/dev/null 2>&1' \
    '  echo "$?" >"$SWITCH_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_OWNER="$CASE_MASTER_OWNER" \
    SWITCH_MARKER="$TEST_ROOT/master-owner-branch-switch.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1 ||
    { tail -n 40 "$log" >&2; fail "cleanup with a concurrent master-owner branch switch failed (log tail above)"; }
  checkout_status=$(cat "$TEST_ROOT/master-owner-branch-switch.status")
  [ "$checkout_status" -ne 0 ] || fail "master-owner branch switch bypassed the held index lock"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$remote_master" \
    "master must reach the remote tip while its checkout is locked"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/alternate)" "$local_master" \
    "unrelated branch must not be advanced by the master update"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "locked master owner must remain attached throughout its refresh"
  assert_cleaned
  echo "PASS: master ownership handoff prevents update redirection"
}

test_master_initial_detach_compare_and_swap() {
  local checkout_status fake_bin local_master real_git
  setup_case master-initial-detach-cas merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" branch alternate "$local_master"
  fake_bin="$TEST_ROOT/master-initial-detach-cas-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*/master-owner)' \
    '  if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = HEAD ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    : >"$RACE_MARKER"' \
    '    if "$REAL_GIT" -C "$2" checkout alternate >/dev/null 2>&1; then status=0; else status=$?; fi' \
    '    printf "%s\n" "$status" >"$STATUS_MARKER"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    RACE_MARKER="$TEST_ROOT/master-initial-detach-cas.injected" \
    STATUS_MARKER="$TEST_ROOT/master-initial-detach-cas.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "initial master-owner detach overwrote a concurrent branch switch"
  fi
  checkout_status=$(cat "$TEST_ROOT/master-initial-detach-cas.status")
  [ "$checkout_status" -eq 0 ] || fail "test did not switch the master owner before its HEAD lease"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" alternate \
    "leased initial detach must preserve the concurrently selected branch"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "initial HEAD lease refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: initial master-owner detach uses a symbolic-HEAD compare-and-swap"
}

test_master_update_failure_reattaches_owner() {
  local candidate checkout_status fake_bin local_master real_git remote_master log
  setup_case master-update-failure merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  candidate="$CASE_ROOT/master-recovery-candidate"
  git -C "$CASE_MAIN" worktree add --detach "$candidate" "$local_master" >/dev/null
  fake_bin="$TEST_ROOT/master-update-failure-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/master-update-failure.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '  "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/master "$RACE_REMOTE" "$RACE_LOCAL"' \
    '  "$REAL_GIT" -C "$MASTER_CANDIDATE" checkout master >/dev/null 2>&1' \
    '  echo "$?" >"$CHECKOUT_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_LOCAL="$local_master" RACE_REMOTE="$remote_master" MASTER_CANDIDATE="$candidate" \
    CHECKOUT_MARKER="$TEST_ROOT/master-update-failure-checkout.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "conditional master update unexpectedly succeeded after a competing update"
  fi
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "original master owner must remain attached after update-ref failure"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" rev-parse HEAD)" "$remote_master" \
    "attached master owner must follow the concurrently updated ref"
  [ -z "$(git -C "$CASE_MASTER_OWNER" status --porcelain --untracked-files=all)" ] ||
    fail "conditional master update failure left its attached owner dirty"
  checkout_status=$(cat "$TEST_ROOT/master-update-failure-checkout.status")
  [ "$checkout_status" -ne 0 ] || fail "competitor acquired master during failure recovery"
  assert_topic_preserved
  echo "PASS: master update failure keeps the original owner attached"
}

test_master_owner_without_head_reflog() {
  setup_case master-owner-without-head-reflog merge other
  git -C "$CASE_MAIN" config core.logAllRefUpdates false

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: master owner refresh tolerates a disabled synthetic HEAD reflog"
}

test_master_handoff_stays_reserved() {
  local candidate checkout_status fake_bin real_git
  setup_case master-handoff-reserved merge other
  candidate="$CASE_ROOT/master-handoff-candidate"
  git -C "$CASE_MAIN" worktree add --detach "$candidate" refs/heads/master >/dev/null
  fake_bin="$TEST_ROOT/master-handoff-reserved-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '    "$REAL_GIT" -C "$MASTER_CANDIDATE" checkout master >/dev/null 2>&1' \
    '    echo "$?" >"$CHECKOUT_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_CANDIDATE="$candidate" \
    CHECKOUT_MARKER="$TEST_ROOT/master-handoff-reserved.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  checkout_status=$(cat "$TEST_ROOT/master-handoff-reserved.status")
  [ "$checkout_status" -ne 0 ] || fail "competitor acquired master during the locked handoff"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "original master owner must stay attached throughout the handoff"
  assert_cleaned
  echo "PASS: master remains owned throughout the locked handoff"
}

test_master_refresh_preserves_concurrent_ref() {
  local competitor_oid fake_bin real_git remote_master
  setup_case master-refresh-race merge none
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  competitor_oid=$(printf 'competing master update\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$remote_master^{tree}")" -p "$remote_master")
  fake_bin="$TEST_ROOT/master-refresh-race-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = read-tree ] && [ ! -e "$RACE_MARKER" ]; then' \
    '  : >"$RACE_MARKER"' \
    '  "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/master "$RACE_OID" "$REMOTE_MASTER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_OID="$competitor_oid" REMOTE_MASTER="$remote_master" \
    RACE_MARKER="$TEST_ROOT/master-refresh-race.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "reservation refresh overwrote a concurrent master ref update"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$competitor_oid" \
    "reservation refresh must not move a concurrently advanced master"
  assert_topic_preserved
  echo "PASS: master reservation refresh never resets the named ref"
}

test_master_reattach_compare_and_swap() {
  local alternate_oid checkout_status fake_bin local_master real_git log
  setup_case master-reattach-cas merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" branch alternate "$local_master"
  alternate_oid=$(git -C "$CASE_MAIN" rev-parse refs/heads/alternate)
  fake_bin="$TEST_ROOT/master-reattach-cas-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/master-reattach-cas.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$5" = refs/heads/master ]; then' \
    '  "$REAL_GIT" -C "$MASTER_OWNER" checkout alternate >/dev/null 2>&1' \
    '  echo "$?" >"$CHECKOUT_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_OWNER="$CASE_MASTER_OWNER" \
    CHECKOUT_MARKER="$TEST_ROOT/master-reattach-cas.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1 ||
    { tail -n 40 "$log" >&2; fail "cleanup with a concurrent master-owner switch during refresh failed (log tail above)"; }
  checkout_status=$(cat "$TEST_ROOT/master-reattach-cas.status")
  [ "$checkout_status" -ne 0 ] || fail "master-owner switch bypassed the refresh locks"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/alternate)" "$alternate_oid" \
    "locked refresh must not advance the competing branch"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "original owner must remain attached during its locked refresh"
  assert_cleaned
  echo "PASS: master refresh locks out a concurrent branch switch"
}

test_master_reattach_verifies_named_branch() {
  local competitor_oid fake_bin real_git remote_master
  setup_case master-reattach-named-ref-cas merge other
  remote_master=$(git -C "$CASE_INTEGRATOR" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  competitor_oid=$(printf 'competing master update before reattachment\n' |
    git -C "$CASE_MAIN" commit-tree "$(git -C "$CASE_MAIN" rev-parse "$remote_master^{tree}")" \
      -p "$remote_master")
  fake_bin="$TEST_ROOT/master-reattach-named-ref-cas-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*/master-owner)' \
    '  if [ "$3" = checkout ] && [ "$4" = --detach ] && [ "$5" = --no-overwrite-ignore ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    : >"$RACE_MARKER"' \
    '    env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
          "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/master "$RACE_OID" "$REMOTE_MASTER"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    RACE_MAIN="$CASE_MAIN" RACE_OID="$competitor_oid" REMOTE_MASTER="$remote_master" \
    RACE_MARKER="$TEST_ROOT/master-reattach-named-ref-cas.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "master reattachment ignored a concurrent named-branch update"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$competitor_oid" \
    "master refresh must preserve a concurrently advanced named branch"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "failure recovery must leave the original owner attached to current master"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" rev-parse HEAD)" "$competitor_oid" \
    "failure recovery must use the concurrent master tip"
  [ -z "$(git -C "$CASE_MASTER_OWNER" status --porcelain --untracked-files=all)" ] ||
    fail "failure recovery left the original master owner dirty"
  assert_topic_preserved
  echo "PASS: master refresh verifies the named branch while holding its locks"
}

test_ignored_data_during_master_detach() {
  local fake_bin local_master log real_git
  setup_case ignored-data-during-master-detach merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" branch alternate "$local_master"
  git -C "$CASE_MASTER_OWNER" checkout alternate >/dev/null
  git -C "$CASE_MASTER_OWNER" rm value >/dev/null
  git -C "$CASE_MASTER_OWNER" commit -m "alternate omits old-master path" >/dev/null
  git -C "$CASE_MASTER_OWNER" checkout master >/dev/null
  echo value >>"$CASE_MAIN/.git/info/exclude"
  fake_bin="$TEST_ROOT/ignored-data-during-master-detach-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/ignored-data-during-master-detach.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = checkout ] && [ "$4" = --detach ] && [ "$5" = --no-overwrite-ignore ] && [ ! -e "$RACE_MARKER" ]; then' \
    '  : >"$RACE_MARKER"' \
    '  env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
        "$REAL_GIT" -C "$MASTER_OWNER" checkout alternate >/dev/null 2>&1' \
    '  echo local-data >"$MASTER_OWNER/value"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" MASTER_OWNER="$CASE_MASTER_OWNER" \
    RACE_MARKER="$TEST_ROOT/ignored-data-during-master-detach.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "initial master detach overwrote ignored data"
  fi
  assert_eq "$(sed -n '1p' "$CASE_MASTER_OWNER/value")" local-data \
    "ignored data created during initial master detach must survive"
  assert_topic_preserved
  echo "PASS: initial master detach refuses ignored data"
}

test_ignored_data_during_topic_detach() {
  local fake_bin log new_topic_oid real_git remote_topic_oid
  setup_case ignored-data-during-topic-detach merge main-off
  echo /value >"$CASE_SESSION/.gitignore"
  git -C "$CASE_SESSION" add .gitignore
  git -C "$CASE_SESSION" commit -m "ignore the tracked topic path" >/dev/null
  land_topic_head "merge topic ignore rule"
  fake_bin="$TEST_ROOT/ignored-data-during-topic-detach-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/ignored-data-during-topic-detach.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$6" in' \
    '*ship-pr-topic-reserve*)' \
    '  if [ "$3" = worktree ] && [ "$4" = add ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    "$REAL_GIT" "$@" || exit $?' \
    '    : >"$RACE_MARKER"' \
    '    "$REAL_GIT" -C "$RACE_SESSION" rm value >/dev/null' \
    '    "$REAL_GIT" -C "$RACE_SESSION" commit -m "remove tracked topic path" >/dev/null' \
    '    echo irreplaceable >"$RACE_SESSION/value"' \
    '    exit 0' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_SESSION="$CASE_SESSION" \
    RACE_MARKER="$TEST_ROOT/ignored-data-during-topic-detach.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "topic detach overwrote ignored data"
  fi
  [ -e "$TEST_ROOT/ignored-data-during-topic-detach.injected" ] ||
    fail "topic detach race was not injected"
  assert_eq "$(sed -n '1p' "$CASE_SESSION/value")" irreplaceable \
    "ignored data created during topic detach must survive"
  # The remote deletion is the helper's last step (ludics-lite#287), so this refusal never reached
  # it: origin keeps the landed tip, and the concurrent advance stays local.
  new_topic_oid=$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)
  [ "$new_topic_oid" != "$CASE_TOPIC_OID" ] || fail "topic detach race did not advance the local topic"
  remote_topic_oid=$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')
  assert_eq "$remote_topic_oid" "$CASE_TOPIC_OID" \
    "topic detach refusal must leave the remote topic untouched"
  assert_topic_preserved
  echo "PASS: topic detach refuses ignored data and leaves the remote tip untouched"
}

test_ignored_data_during_topic_reattach() {
  local blob fake_bin index_file log new_topic_oid real_git remote_topic_oid tree
  setup_case ignored-data-during-topic-reattach merge main-off
  echo /ignored-collision >>"$CASE_MAIN/.git/info/exclude"
  blob=$(printf 'branch bytes\n' | git -C "$CASE_MAIN" hash-object -w --stdin)
  index_file=$(mktemp "$TEST_ROOT/topic-reattach-index.XXXXXX")
  GIT_INDEX_FILE="$index_file" git -C "$CASE_MAIN" read-tree "$CASE_TOPIC_OID"
  GIT_INDEX_FILE="$index_file" git -C "$CASE_MAIN" update-index \
    --add --cacheinfo 100644 "$blob" ignored-collision
  tree=$(GIT_INDEX_FILE="$index_file" git -C "$CASE_MAIN" write-tree)
  unlink "$index_file"
  new_topic_oid=$(printf 'advance topic during ownership handoff\n' |
    git -C "$CASE_MAIN" commit-tree "$tree" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/ignored-data-during-topic-reattach-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/ignored-data-during-topic-reattach.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*ship-pr-topic-reserve*)' \
    '  if [ "$3" = switch ] && [ "$5" = topic ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    : >"$RACE_MARKER"' \
    '    "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/topic "$RACE_OID" "$TOPIC_OID"' \
    '    printf "irreplaceable local bytes\n" >"$RACE_SESSION/ignored-collision"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_SESSION="$CASE_SESSION" RACE_OID="$new_topic_oid" TOPIC_OID="$CASE_TOPIC_OID" \
    RACE_MARKER="$TEST_ROOT/ignored-data-during-topic-reattach.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "topic ownership race unexpectedly completed cleanup"
  fi
  [ -e "$TEST_ROOT/ignored-data-during-topic-reattach.injected" ] ||
    fail "topic reattachment race was not injected"
  assert_eq "$(sed -n '1p' "$CASE_SESSION/ignored-collision")" "irreplaceable local bytes" \
    "topic reattachment must not overwrite ignored session data"
  # As in the detach case: the refusal precedes the remote deletion, so origin is untouched.
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)" "$new_topic_oid" \
    "the concurrently advanced topic must stay local"
  remote_topic_oid=$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')
  assert_eq "$remote_topic_oid" "$CASE_TOPIC_OID" \
    "topic reattachment refusal must leave the remote topic untouched"
  assert_topic_preserved
  echo "PASS: topic reattachment refuses to overwrite ignored session data"
}

test_attached_session_head_compare_and_swap() {
  local fake_bin real_git
  setup_case attached-session-head-cas merge main-off
  git -C "$CASE_MAIN" branch alternate "$CASE_TOPIC_OID"
  fake_bin="$TEST_ROOT/attached-session-head-cas-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$6" in' \
    '*ship-pr-topic-reserve*)' \
    '  if [ "$3" = worktree ] && [ "$4" = add ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    "$REAL_GIT" "$@" || exit $?' \
    '    : >"$RACE_MARKER"' \
    '    "$REAL_GIT" -C "$RACE_SESSION" switch alternate >/dev/null' \
    '    exit 0' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_SESSION="$CASE_SESSION" \
    RACE_MARKER="$TEST_ROOT/attached-session-head-cas.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "cleanup accepted an attached session that changed branches after preflight"
  fi
  [ -e "$TEST_ROOT/attached-session-head-cas.injected" ] ||
    fail "attached session HEAD race was not injected"
  assert_eq "$(git -C "$CASE_SESSION" symbolic-ref --short HEAD)" alternate \
    "session HEAD compare-and-swap must preserve the competing branch"
  assert_topic_preserved
  echo "PASS: attached session HEAD is compare-and-swapped before ownership transfer"
}

test_detached_session_head_compare_and_swap() {
  local fake_bin race_oid real_git
  setup_case detached-session-head-cas merge main-off
  git -C "$CASE_SESSION" checkout --detach >/dev/null
  race_oid=$(printf 'competing detached session commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/detached-session-head-cas-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$6" in' \
    '*ship-pr-topic-reserve*)' \
    '  if [ "$3" = worktree ] && [ "$4" = add ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    "$REAL_GIT" "$@" || exit $?' \
    '    : >"$RACE_MARKER"' \
    '    "$REAL_GIT" -C "$RACE_SESSION" checkout --detach "$RACE_OID" >/dev/null' \
    '    exit 0' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_SESSION="$CASE_SESSION" \
    RACE_OID="$race_oid" RACE_MARKER="$TEST_ROOT/detached-session-head-cas.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "cleanup accepted a detached session HEAD that changed after preflight"
  fi
  [ -e "$TEST_ROOT/detached-session-head-cas.injected" ] ||
    fail "detached session HEAD race was not injected"
  assert_eq "$(git -C "$CASE_SESSION" rev-parse HEAD)" "$race_oid" \
    "detached session HEAD compare-and-swap must preserve the competing commit"
  assert_topic_preserved
  echo "PASS: detached session HEAD is compare-and-swapped before archival"
}

test_initialized_session_submodule_refusal() {
  local local_master sub_remote sub_seed unique_submodule_oid
  setup_case initialized-session-submodule merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  sub_remote="$CASE_ROOT/submodule.git"
  sub_seed="$CASE_ROOT/submodule-seed"
  git init --bare "$sub_remote" >/dev/null
  git -C "$sub_remote" symbolic-ref HEAD refs/heads/main
  git init -b main "$sub_seed" >/dev/null
  git_config "$sub_seed"
  echo submodule-base >"$sub_seed/payload"
  git -C "$sub_seed" add payload
  git -C "$sub_seed" commit -m "submodule base" >/dev/null
  git -C "$sub_seed" remote add origin "$sub_remote"
  git -C "$sub_seed" push -u origin main >/dev/null
  git -c protocol.file.allow=always -C "$CASE_SESSION" submodule add \
    "$sub_remote" nested >/dev/null
  git -C "$CASE_SESSION" commit -m "add initialized submodule" >/dev/null
  land_topic_head "merge initialized submodule"
  git_config "$CASE_SESSION/nested"
  git -C "$CASE_SESSION" config submodule.nested.ignore all
  echo unique >>"$CASE_SESSION/nested/payload"
  git -C "$CASE_SESSION/nested" add payload
  git -C "$CASE_SESSION/nested" commit -m "unique linked-worktree submodule commit" >/dev/null
  unique_submodule_oid=$(git -C "$CASE_SESSION/nested" rev-parse HEAD)
  [ -z "$(git -C "$CASE_SESSION" status --porcelain --untracked-files=normal --ignored=matching)" ] ||
    fail "submodule ignore=all did not produce the intended clean superproject"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "initialized session submodule was accepted for cleanup"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "initialized submodule refusal must precede master advancement"
  git -C "$CASE_SESSION/nested" cat-file -e "$unique_submodule_oid^{commit}" ||
    fail "unique linked-worktree submodule commit was lost"
  assert_topic_preserved
  echo "PASS: initialized session submodule is refused before mutation"
}

test_escape_named_session_submodule_refusal() {
  local entry local_master name refusal sub_remote sub_seed submodule_oid
  if [ "$ON_MSYS" -eq 1 ]; then
    skip_boundary "the escape-named submodule checkout: $MSYS_CONTROL_NAME_BOUNDARY (its clone refuses the name outright)"
    return 0
  fi
  setup_case escape-named-session-submodule merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  sub_remote="$CASE_ROOT/submodule.git"
  sub_seed="$CASE_ROOT/submodule-seed"
  git init --bare "$sub_remote" >/dev/null
  git -C "$sub_remote" symbolic-ref HEAD refs/heads/main
  git init -b main "$sub_seed" >/dev/null
  git_config "$sub_seed"
  echo submodule-base >"$sub_seed/payload"
  git -C "$sub_seed" add payload
  git -C "$sub_seed" commit -m "submodule base" >/dev/null
  git -C "$sub_seed" remote add origin "$sub_remote"
  git -C "$sub_seed" push -u origin main >/dev/null
  # `submodule add` cannot spell this path -- the escape sequence is fine in a config *value* but
  # git refuses to write `submodule.<name>.url` for it -- so the entry is laid down by hand: the
  # checkout, the `.gitmodules` record, and the gitlink. That is the shape an attacker's
  # repository has, not a shape git's own porcelain would produce. A newline would be the other
  # half of the vector, but `git submodule status` has no NUL-delimited mode and the helper's
  # line-based read truncates the name at it; an escape sequence survives the read whole and is
  # what would reach the operator's terminal.
  name=$(printf 'na\033[31mme')
  git clone --quiet "$sub_remote" "$CASE_SESSION/$name"
  git_config "$CASE_SESSION/$name"
  submodule_oid=$(git -C "$CASE_SESSION/$name" rev-parse HEAD)
  printf '[submodule "nested"]\n\tpath = %s\n\turl = %s\n' "$name" "$sub_remote" \
    >"$CASE_SESSION/.gitmodules"
  git -C "$CASE_SESSION" update-index --add --cacheinfo "160000,$submodule_oid,$name"
  git -C "$CASE_SESSION" add .gitmodules
  git -C "$CASE_SESSION" commit -m "add escape-named submodule" >/dev/null
  land_topic_head "merge escape-named submodule"
  git -C "$CASE_SESSION" config submodule.nested.url "$sub_remote"
  git -C "$CASE_SESSION" config submodule.nested.active true
  git -C "$CASE_SESSION" config submodule.nested.ignore all
  entry=$(git -C "$CASE_SESSION" submodule status --recursive)
  case "$entry" in
  -*) fail "the fixture must present the submodule as initialized" ;;
  esac
  [ -z "$(git -C "$CASE_SESSION" status --porcelain --untracked-files=normal --ignored=matching)" ] ||
    fail "the escape-named submodule fixture must leave the session worktree clean"

  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an escape-named initialized session submodule was accepted for cleanup"
  fi
  case "$refusal" in
  *"has an initialized submodule"*) ;;
  *) fail "the escape-named submodule did not reach its refusal: $refusal" ;;
  esac
  # The entry the helper reads, shell-quoted -- the whole of it, because `printf '%q'` renders a
  # word holding both spaces and an escape sequence as one `$'...'` string rather than escaping
  # each character where it stands. This test script and the helper are the same bash, so the two
  # renderings agree.
  case "$refusal" in
  *"$(printf '%q' "${entry#?}")"*) ;;
  *) fail "the refusal did not name the submodule as it is spelled: $refusal" ;;
  esac
  # And carries it escaped, not raw: the escape sequence itself must never reach the operator's
  # terminal, which would act on it rather than print it.
  case "$refusal" in
  *"$name"*) fail "the refusal printed the submodule name's escape sequence raw: $refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "initialized submodule refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: an escape-named initialized submodule is refused and named as it is spelled"
}

test_deinitialized_session_submodule_refusal() {
  local local_master log session_git_dir status sub_remote sub_seed unique_submodule_oid
  setup_case deinitialized-session-submodule merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  sub_remote="$CASE_ROOT/submodule.git"
  sub_seed="$CASE_ROOT/submodule-seed"
  git init --bare "$sub_remote" >/dev/null
  git -C "$sub_remote" symbolic-ref HEAD refs/heads/main
  git init -b main "$sub_seed" >/dev/null
  git_config "$sub_seed"
  echo submodule-base >"$sub_seed/payload"
  git -C "$sub_seed" add payload
  git -C "$sub_seed" commit -m "submodule base" >/dev/null
  git -C "$sub_seed" remote add origin "$sub_remote"
  git -C "$sub_seed" push -u origin main >/dev/null
  git -c protocol.file.allow=always -C "$CASE_SESSION" submodule add \
    "$sub_remote" nested >/dev/null
  git -C "$CASE_SESSION" commit -m "add deinitialized submodule" >/dev/null
  land_topic_head "merge deinitialized submodule"
  git_config "$CASE_SESSION/nested"
  echo unique >>"$CASE_SESSION/nested/payload"
  git -C "$CASE_SESSION/nested" add payload
  git -C "$CASE_SESSION/nested" commit -m "unique deinitialized submodule commit" >/dev/null
  unique_submodule_oid=$(git -C "$CASE_SESSION/nested" rev-parse HEAD)
  session_git_dir=$(git -C "$CASE_SESSION" rev-parse --absolute-git-dir)
  git -C "$CASE_SESSION" submodule deinit --force nested >/dev/null
  status=$(git -C "$CASE_SESSION" submodule status nested)
  case "$status" in
  -*) ;;
  *) fail "test did not deinitialize the submodule checkout" ;;
  esac
  [ -z "$(git -C "$CASE_SESSION" status --porcelain --untracked-files=normal --ignored=matching)" ] ||
    fail "deinitialized submodule did not leave the intended clean superproject"
  git --git-dir="$session_git_dir/modules/nested" cat-file -e "$unique_submodule_oid^{commit}" ||
    fail "test residual submodule repository lost its unique commit before cleanup"
  log="$TEST_ROOT/deinitialized-session-submodule.log"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "deinitialized session submodule repository was accepted for cleanup"
  fi
  case "$(cat "$log")" in
  *"session has a residual submodule repository"*) ;;
  *) fail "deinitialized submodule test did not reach the residual-repository refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "residual submodule refusal must precede master advancement"
  git --git-dir="$session_git_dir/modules/nested" cat-file -e "$unique_submodule_oid^{commit}" ||
    fail "unique deinitialized submodule commit was lost"
  assert_topic_preserved
  echo "PASS: residual deinitialized submodule repository is refused before mutation"
}

test_session_module_gitdir_newline_name_refusal() {
  local local_master refusal residual session_git_dir
  setup_case session-module-gitdir-newline merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  session_git_dir=$(git -C "$CASE_SESSION" rev-parse --absolute-git-dir)
  # A residual repository's directory under `.git/modules` is named for the submodule name in
  # `.gitmodules`, which is config data and can hold a newline. The refusal reads whatever that
  # directory holds, so a bare directory is fixture enough -- and unlike `submodule add`, plain
  # `mkdir` will spell a name Git would not.
  residual=$(printf 'nes\nted')
  mkdir "$session_git_dir/modules"
  mkdir "$session_git_dir/modules/$residual"
  [ -z "$(git -C "$CASE_SESSION" status --porcelain --untracked-files=normal --ignored=matching)" ] ||
    fail "the residual-repository fixture must leave the session worktree clean"

  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "a newline-named residual submodule repository was accepted for cleanup"
  fi
  case "$refusal" in
  *"session has a residual submodule repository"*) ;;
  *) fail "the newline-named residual repository did not reach its refusal: $refusal" ;;
  esac
  # The name the directory has, shell-quoted.
  case "$refusal" in
  *"$(printf '%q' "$session_git_dir/modules/$residual")"*) ;;
  *) fail "the refusal did not name the residual repository as it is spelled: $refusal" ;;
  esac
  # And carries it escaped, not raw: the newline itself must never reach the operator's terminal,
  # where it would forge a second diagnostic line out of the tail of a directory name.
  case "$refusal" in
  *"$residual"*) fail "the refusal printed the residual repository's newline raw: $refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "residual submodule refusal must precede master advancement"
  [ -d "$session_git_dir/modules/$residual" ] ||
    fail "the newline-named residual submodule repository was removed"
  assert_topic_preserved
  echo "PASS: a newline-named residual submodule repository is refused and named as it is spelled"
}

test_refusal_escaping_survives_xpg_echo() {
  local local_master refusal residual session_git_dir xpg_env
  setup_case refusal-escaping-xpg-echo merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  session_git_dir=$(git -C "$CASE_SESSION" rev-parse --absolute-git-dir)
  residual=$(printf 'nes\nted')
  mkdir "$session_git_dir/modules"
  mkdir "$session_git_dir/modules/$residual"
  # Shell-quoting a name only withholds its newline if what writes the diagnostic does not
  # interpret the escape again. Bash's `echo` does exactly that whenever `xpg_echo` is on -- a
  # build configured with `--enable-xpg-echo-default`, or, as here, a `BASH_ENV` file that sets
  # it -- turning `%q`'s `\n` back into the real newline it was there to withhold. `BASH_ENV` is
  # this test's way of reaching that shell; the property under test is the helper's, and the
  # helper satisfies it by writing every diagnostic with `printf '%s\n'`.
  xpg_env="$CASE_ROOT/enable-xpg-echo.bash"
  printf 'shopt -s xpg_echo\n' >"$xpg_env"
  case "$(BASH_ENV="$xpg_env" bash -c 'shopt xpg_echo')" in
  *on*) ;;
  *) fail "this bash does not take xpg_echo from BASH_ENV, so the case would prove nothing" ;;
  esac

  if refusal=$(BASH_ENV="$xpg_env" "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "a newline-named residual submodule repository was accepted for cleanup"
  fi
  case "$refusal" in
  *"$(printf '%q' "$session_git_dir/modules/$residual")"*) ;;
  *) fail "the refusal did not name the residual repository as it is spelled: $refusal" ;;
  esac
  # The escaping must survive the write: under `echo` the quoted `\n` comes back out as the
  # newline itself, which is the forged second diagnostic line the quoting exists to prevent.
  case "$refusal" in
  *"$residual"*) fail "xpg_echo unescaped the residual repository's newline: $refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "residual submodule refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: a refusal's shell-quoting survives a shell whose echo would reinterpret it"
}

test_initialized_master_submodule_refusal() {
  local local_master next_submodule_oid sub_remote sub_seed
  setup_case initialized-master-submodule merge other
  git -C "$CASE_MASTER_OWNER" fetch origin \
    refs/heads/master:refs/remotes/origin/master >/dev/null
  git -C "$CASE_MASTER_OWNER" merge --ff-only refs/remotes/origin/master >/dev/null
  sub_remote="$CASE_ROOT/master-submodule.git"
  sub_seed="$CASE_ROOT/master-submodule-seed"
  git init --bare "$sub_remote" >/dev/null
  git -C "$sub_remote" symbolic-ref HEAD refs/heads/main
  git init -b main "$sub_seed" >/dev/null
  git_config "$sub_seed"
  echo submodule-base >"$sub_seed/payload"
  git -C "$sub_seed" add payload
  git -C "$sub_seed" commit -m "master submodule base" >/dev/null
  git -C "$sub_seed" remote add origin "$sub_remote"
  git -C "$sub_seed" push -u origin main >/dev/null
  git -c protocol.file.allow=always -C "$CASE_MASTER_OWNER" submodule add \
    "$sub_remote" nested >/dev/null
  git -C "$CASE_MASTER_OWNER" commit -m "add initialized master submodule" >/dev/null
  git -C "$CASE_MASTER_OWNER" push --no-verify origin master >/dev/null
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_INTEGRATOR" pull --ff-only origin master >/dev/null
  echo next >>"$sub_seed/payload"
  git -C "$sub_seed" add payload
  git -C "$sub_seed" commit -m "advance master submodule" >/dev/null
  git -C "$sub_seed" push origin main >/dev/null
  next_submodule_oid=$(git -C "$sub_seed" rev-parse HEAD)
  git -c protocol.file.allow=always -C "$CASE_INTEGRATOR" submodule update --init nested >/dev/null
  git -C "$CASE_INTEGRATOR/nested" fetch origin >/dev/null
  git -C "$CASE_INTEGRATOR/nested" checkout "$next_submodule_oid" >/dev/null
  git -C "$CASE_INTEGRATOR" add nested
  git -C "$CASE_INTEGRATOR" commit -m "update master submodule gitlink" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "initialized master-owner submodule was accepted for refresh"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "initialized master-owner submodule refusal must precede master advancement"
  assert_eq "$(git -C "$CASE_MASTER_OWNER/nested" rev-parse HEAD)" \
    "$(git -C "$CASE_MASTER_OWNER" rev-parse HEAD:nested)" \
    "master-owner submodule checkout must remain aligned with its old gitlink"
  assert_topic_preserved
  echo "PASS: initialized master-owner submodule is refused before gitlink advancement"
}

test_master_resolve_undo_refusal() {
  local first_blob head_blob index_info local_master second_blob
  setup_case master-resolve-undo merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  head_blob=$(git -C "$CASE_MASTER_OWNER" rev-parse HEAD:value)
  first_blob=$(printf 'master resolve-undo first\n' |
    git -C "$CASE_MAIN" hash-object -w --stdin)
  second_blob=$(printf 'master resolve-undo second\n' |
    git -C "$CASE_MAIN" hash-object -w --stdin)
  index_info="$TEST_ROOT/master-resolve-undo.index-info"
  printf '0 0000000000000000000000000000000000000000\tvalue\0' >"$index_info"
  printf '100644 %s 1\tvalue\0' "$head_blob" >>"$index_info"
  printf '100644 %s 2\tvalue\0' "$first_blob" >>"$index_info"
  printf '100644 %s 3\tvalue\0' "$second_blob" >>"$index_info"
  git -C "$CASE_MASTER_OWNER" update-index -z --index-info <"$index_info"
  git -C "$CASE_MASTER_OWNER" update-index --add --cacheinfo 100644 "$head_blob" value
  [ -z "$(git -C "$CASE_MASTER_OWNER" status --porcelain --untracked-files=all)" ] ||
    fail "master resolve-undo test did not leave a clean worktree"
  [ -n "$(git -C "$CASE_MASTER_OWNER" ls-files --resolve-undo)" ] ||
    fail "master resolve-undo test created no REUC entries"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "master-owner resolve-undo metadata was accepted for cleanup"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "master resolve-undo refusal must precede master advancement"
  [ -n "$(git -C "$CASE_MASTER_OWNER" ls-files --resolve-undo)" ] ||
    fail "master resolve-undo entries were lost"
  git -C "$CASE_MAIN" cat-file -e "$first_blob^{blob}" || fail "first REUC blob was lost"
  git -C "$CASE_MAIN" cat-file -e "$second_blob^{blob}" || fail "second REUC blob was lost"
  assert_topic_preserved
  echo "PASS: master-owner resolve-undo state is refused before ownership handoff"
}

test_assume_unchanged_master_refusal() {
  local local_master
  setup_case assume-unchanged-master merge main
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" update-index --assume-unchanged value
  printf 'hidden local master edit\n' >"$CASE_MAIN/value"
  [ -z "$(git -C "$CASE_MAIN" status --porcelain)" ] ||
    fail "assume-unchanged setup did not hide the master-owner edit"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "assume-unchanged master-owner edit was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "hidden master-owner edit refusal must precede master advancement"
  assert_eq "$(sed -n '1p' "$CASE_MAIN/value")" "hidden local master edit" \
    "hidden master-owner data must survive refusal"
  assert_topic_preserved
  echo "PASS: assume-unchanged master-owner edits are refused before ownership handoff"
}

test_skip_worktree_master_refusal() {
  local local_master
  setup_case skip-worktree-master merge main
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" update-index --skip-worktree value
  printf 'hidden skip-worktree edit\n' >"$CASE_MAIN/value"
  [ -z "$(git -C "$CASE_MAIN" status --porcelain)" ] ||
    fail "skip-worktree setup did not hide the master-owner edit"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "skip-worktree master-owner edit was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "skip-worktree edit refusal must precede master advancement"
  assert_eq "$(sed -n '1p' "$CASE_MAIN/value")" "hidden skip-worktree edit" \
    "skip-worktree master-owner data must survive refusal"
  assert_topic_preserved
  echo "PASS: skip-worktree master-owner edits are refused before ownership handoff"
}

# Shared topology for the sparse-checkout master-owner cases: a base with a materialized file and
# a docs/ directory, a topic editing both, and a cone-sparse (root-only) master-owner worktree in
# which docs/manual is intentionally absent. Exposes SPARSE_MAIN, SPARSE_SESSION, SPARSE_OWNER.
setup_sparse_case() {
  local name="$1" root remote integrator
  root="$TEST_ROOT/$name"
  remote="$root/remote.git"
  SPARSE_MAIN="$root/main"
  SPARSE_SESSION="$root/session"
  SPARSE_OWNER="$root/master-owner"
  integrator="$root/integrator"
  mkdir -p "$root"
  git init --bare "$remote" >/dev/null
  git init -b master "$SPARSE_MAIN" >/dev/null
  git_config "$SPARSE_MAIN"
  echo base >"$SPARSE_MAIN/value"
  mkdir "$SPARSE_MAIN/docs"
  echo manual >"$SPARSE_MAIN/docs/manual"
  git -C "$SPARSE_MAIN" add value docs/manual
  git -C "$SPARSE_MAIN" commit -m base >/dev/null
  git -C "$SPARSE_MAIN" remote add origin "$remote"
  git -C "$SPARSE_MAIN" push -u origin master >/dev/null
  git -C "$SPARSE_MAIN" branch topic
  git -C "$SPARSE_MAIN" worktree add "$SPARSE_SESSION" topic >/dev/null
  git_config "$SPARSE_SESSION"
  echo topic >>"$SPARSE_SESSION/value"
  echo updated >>"$SPARSE_SESSION/docs/manual"
  git -C "$SPARSE_SESSION" add value docs/manual
  git -C "$SPARSE_SESSION" commit -m topic >/dev/null
  git -C "$SPARSE_SESSION" push -u origin topic >/dev/null
  git clone --branch master "$remote" "$integrator" >/dev/null 2>&1
  git_config "$integrator"
  git -C "$integrator" merge --no-ff origin/topic -m "merge topic" >/dev/null
  git -C "$integrator" push origin master >/dev/null
  git -C "$SPARSE_MAIN" checkout --detach >/dev/null
  git -C "$SPARSE_MAIN" worktree add "$SPARSE_OWNER" master >/dev/null
  git -C "$SPARSE_OWNER" sparse-checkout set >/dev/null 2>&1
  [ ! -e "$SPARSE_OWNER/docs/manual" ] || fail "sparse setup did not de-materialize docs/manual"
  assert_eq "$(git -C "$SPARSE_OWNER" ls-files -t -- docs/manual)" "S docs/manual" \
    "sparse setup must mark docs/manual skip-worktree"
}

# A clean sparse-checkout master owner: its skip-worktree entries with no file on disk are
# intentional absence, not hidden deletions, so the hidden-change probe must pass it — while
# test_skip_worktree_master_refusal above keeps proving an EDITED materialized skip-worktree
# file is still refused. The fast-forward changes BOTH the materialized file and the
# sparse-absent one, so the locked refresh must advance the owner — index entry included —
# without materializing the absent path or dropping its flag (its sparse metadata rides into
# the refresh's temporary GIT_DIR for exactly this case).
test_sparse_master_owner() {
  setup_sparse_case sparse-master-owner

  "$HELPER" "$SPARSE_MAIN" "$SPARSE_SESSION" topic >/dev/null
  assert_eq "$(git -C "$SPARSE_OWNER" rev-parse HEAD)" \
    "$(git -C "$SPARSE_MAIN" rev-parse refs/remotes/origin/master)" \
    "sparse master owner must be fast-forwarded"
  assert_eq "$(sed -n '2p' "$SPARSE_OWNER/value")" topic \
    "materialized files must follow the fast-forward in a sparse owner"
  [ ! -e "$SPARSE_OWNER/docs/manual" ] || fail "sparse-absent path must not be materialized by the refresh"
  assert_eq "$(git -C "$SPARSE_OWNER" ls-files -t -- docs/manual)" "S docs/manual" \
    "sparse-absent path must keep its skip-worktree flag through the refresh"
  assert_eq "$(git -C "$SPARSE_OWNER" ls-files --format='%(objectname)' -- docs/manual)" \
    "$(git -C "$SPARSE_MAIN" rev-parse "refs/remotes/origin/master:docs/manual")" \
    "the changed sparse-absent path's index entry must reach the new tip's blob"
  ! git -C "$SPARSE_MAIN" show-ref --verify --quiet refs/heads/topic || fail "local topic must be deleted"
  echo "PASS: clean sparse-checkout master owner is advanced without losing sparseness"
}

# The other side of the sparse exemption: an absent skip-worktree entry that the active sparse
# rules WOULD materialize is a deletion hidden behind the flag, not sparse absence, and must
# still be refused before any branch mutation.
test_sparse_hidden_deletion_refusal() {
  local local_master
  setup_sparse_case sparse-hidden-deletion
  local_master=$(git -C "$SPARSE_MAIN" rev-parse refs/heads/master)
  git -C "$SPARSE_OWNER" update-index --skip-worktree value
  rm "$SPARSE_OWNER/value"
  [ -z "$(git -C "$SPARSE_OWNER" status --porcelain)" ] ||
    fail "skip-worktree setup did not hide the sparse-owner deletion"

  if "$HELPER" "$SPARSE_MAIN" "$SPARSE_SESSION" topic >/dev/null 2>&1; then
    fail "deletion hidden behind skip-worktree in a sparse owner was accepted"
  fi
  assert_eq "$(git -C "$SPARSE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "sparse hidden-deletion refusal must precede master advancement"
  git -C "$SPARSE_MAIN" show-ref --verify --quiet refs/heads/topic || fail "local topic was deleted"
  [ -d "$SPARSE_SESSION" ] || fail "topic worktree was removed"
  echo "PASS: in-cone deletion hidden behind skip-worktree is refused in a sparse owner"
}

# And with no sparse checkout at all, EVERY absent skip-worktree entry is a hidden deletion —
# the exemption must not blanket-trust absence.
test_skip_worktree_deleted_master_refusal() {
  local local_master
  setup_case skip-worktree-deleted-master merge main
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" update-index --skip-worktree value
  rm "$CASE_MAIN/value"
  [ -z "$(git -C "$CASE_MAIN" status --porcelain)" ] ||
    fail "skip-worktree setup did not hide the master-owner deletion"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "deletion hidden behind skip-worktree was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "hidden-deletion refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: deletion hidden behind skip-worktree is refused in a non-sparse owner"
}

# Worktree pathnames can contain a newline; the line-based `worktree list --porcelain` truncates
# them, so ownership validation must read the NUL-delimited listing. Both the session worktree
# and the checked-out master owner live at newline-bearing paths here.
test_newline_worktree_paths() {
  local root remote main session owner integrator archive archive_count
  if [ "$ON_MSYS" -eq 1 ]; then
    skip_boundary "newline-bearing worktree paths: $MSYS_CONTROL_NAME_BOUNDARY (its worktree add refuses the path outright)"
    return 0
  fi
  root="$TEST_ROOT/newline-worktree-paths"
  remote="$root/remote.git"
  main="$root/main"
  session="$root/session"$'\n'"wt"
  owner="$root/master"$'\n'"owner"
  integrator="$root/integrator"
  mkdir -p "$root"
  git init --bare "$remote" >/dev/null
  git init -b master "$main" >/dev/null
  git_config "$main"
  echo base >"$main/value"
  git -C "$main" add value
  git -C "$main" commit -m base >/dev/null
  git -C "$main" remote add origin "$remote"
  git -C "$main" push -u origin master >/dev/null
  git -C "$main" branch topic
  git -C "$main" worktree add "$session" topic >/dev/null
  git_config "$session"
  echo topic >>"$session/value"
  git -C "$session" add value
  git -C "$session" commit -m topic >/dev/null
  git -C "$session" push -u origin topic >/dev/null
  git clone --branch master "$remote" "$integrator" >/dev/null 2>&1
  git_config "$integrator"
  git -C "$integrator" merge --no-ff origin/topic -m "merge topic" >/dev/null
  git -C "$integrator" push origin master >/dev/null
  git -C "$main" checkout --detach >/dev/null
  git -C "$main" worktree add "$owner" master >/dev/null

  "$HELPER" "$main" "$session" topic >/dev/null
  [ ! -e "$session" ] || fail "newline session worktree was not removed"
  assert_eq "$(git -C "$owner" rev-parse HEAD)" "$(git -C "$main" rev-parse refs/remotes/origin/master)" \
    "newline-path master owner must be fast-forwarded"
  assert_eq "$(git -C "$owner" symbolic-ref --short HEAD)" master \
    "newline-path master owner must still own master"
  ! git -C "$main" show-ref --verify --quiet refs/heads/topic || fail "local topic must be deleted"
  archive_count=0
  for archive in "$root"/.session*.ship-pr-recovery.*; do
    [ -d "$archive" ] || continue
    archive_count=$((archive_count + 1))
    [ -f "$archive/worktree/value" ] || fail "newline session archive must retain tracked files"
  done
  assert_eq "$archive_count" 1 "cleanup must retain exactly one newline session archive"
  echo "PASS: newline-bearing worktree paths are scanned and cleaned correctly"
}

test_master_active_operation_refusal() {
  local local_master merge_head side_oid
  setup_case master-active-operation merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  side_oid=$(printf 'clean pending merge\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$local_master^{tree}")" -p "$local_master")
  git -C "$CASE_MAIN" update-ref refs/heads/pending-merge "$side_oid"
  git -C "$CASE_MASTER_OWNER" merge --no-commit --no-ff pending-merge >/dev/null
  [ -z "$(git -C "$CASE_MASTER_OWNER" status --porcelain)" ] ||
    fail "pending clean merge unexpectedly changed master-owner files"
  merge_head=$(git -C "$CASE_MASTER_OWNER" rev-parse --git-path MERGE_HEAD)
  [ -f "$merge_head" ] || fail "pending clean merge created no MERGE_HEAD"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "clean active operation in the master owner was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "master active-operation refusal must precede master advancement"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "active-operation refusal must leave the master owner attached"
  [ -f "$merge_head" ] || fail "master-owner merge state was removed"
  assert_topic_preserved
  echo "PASS: clean active operations in the master owner are refused before handoff"
}

test_master_index_lock_refusal() {
  local index_path local_master
  setup_case master-index-lock merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  index_path=$(git -C "$CASE_MASTER_OWNER" rev-parse --git-path index)
  : >"$index_path.lock"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "locked master-owner index was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "master index-lock refusal must precede master advancement"
  [ -f "$index_path.lock" ] || fail "master-owner index lock was removed"
  assert_eq "$(git -C "$CASE_MASTER_OWNER" symbolic-ref --short HEAD)" master \
    "index-lock refusal must leave the master owner attached"
  assert_topic_preserved
  echo "PASS: locked master-owner indexes are refused before ownership handoff"
}

test_master_changed_path_failure_refusal() {
  local fake_bin local_master real_git
  setup_case master-changed-path-failure merge other
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  fake_bin="$TEST_ROOT/master-changed-path-failure-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = diff ] && [ "$4" = --name-only ]; then exit 1; fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "failed master changed-path enumeration was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "changed-path failure must precede master advancement"
  assert_topic_preserved
  echo "PASS: master changed-path enumeration failures propagate before mutation"
}

test_diverged_master_refusal() {
  local master_owner="$TEST_ROOT/diverged-master-owner"
  setup_case diverged-master merge none
  git -C "$CASE_MAIN" worktree add "$master_owner" master >/dev/null
  git_config "$master_owner"
  echo divergent >"$master_owner/divergent"
  git -C "$master_owner" add divergent
  git -C "$master_owner" commit -m "diverge local master" >/dev/null
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "non-fast-forward local master was accepted"
  fi
  assert_topic_preserved
  assert_eq "$(git -C "$master_owner" symbolic-ref --short HEAD)" master \
    "diverged master owner must remain attached"
  echo "PASS: divergent local master is refused before remote deletion"
}

test_locked_session_refusal() {
  setup_case locked-session merge main-off
  git -C "$CASE_MAIN" worktree lock --reason "scratch lock" "$CASE_SESSION"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "locked session was accepted for cleanup"
  fi
  assert_topic_preserved
  echo "PASS: locked session is refused before cleanup"
}

test_active_session_operation_refusal() {
  local local_master sequencer session_git_dir
  setup_case active-session-operation merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  session_git_dir=$(git -C "$CASE_SESSION" rev-parse --absolute-git-dir)
  sequencer="$session_git_dir/sequencer"
  mkdir -p "$sequencer"
  printf 'pick %s pending cleanup test\n' "$CASE_TOPIC_OID" >"$sequencer/todo"
  [ -z "$(git -C "$CASE_SESSION" status --porcelain --untracked-files=all)" ] ||
    fail "active-operation test did not leave a clean worktree"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "active session sequencer state was accepted for cleanup"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "active-operation refusal must precede master advancement"
  [ -f "$sequencer/todo" ] || fail "active session sequencer state was lost"
  assert_topic_preserved
  echo "PASS: active session operation state is refused before mutation"
}

test_active_session_bisect_refusal() {
  local bisect_start local_master
  setup_case active-session-bisect merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_SESSION" bisect start >/dev/null
  bisect_start=$(git -C "$CASE_SESSION" rev-parse --git-path BISECT_START)
  [ -f "$bisect_start" ] || fail "bisect start created no retained state"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "active session bisect without BISECT_HEAD was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "active bisect refusal must precede master advancement"
  [ -f "$bisect_start" ] || fail "active bisect state was removed"
  assert_topic_preserved
  echo "PASS: active session bisect metadata is refused before mutation"
}

test_symbolic_session_pseudoref_refusal() {
  local local_master
  setup_case symbolic-session-pseudoref merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_SESSION" symbolic-ref ORIG_HEAD refs/heads/master

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic session pseudoref was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "symbolic pseudoref refusal must precede master advancement"
  assert_eq "$(git -C "$CASE_SESSION" symbolic-ref ORIG_HEAD)" refs/heads/master \
    "symbolic session pseudoref must survive refusal"
  assert_topic_preserved
  echo "PASS: symbolic session pseudorefs are refused before mutation"
}

test_private_worktree_ref_refusal() {
  local local_master private_oid
  setup_case private-worktree-ref merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  private_oid=$(printf 'private worktree commit\n' | git -C "$CASE_SESSION" commit-tree \
    "$(git -C "$CASE_SESSION" rev-parse HEAD^{tree})" -p "$CASE_TOPIC_OID")
  git -C "$CASE_SESSION" update-ref refs/worktree/private "$private_oid"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "session-local worktree ref was accepted for cleanup"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "private worktree ref refusal must precede master advancement"
  assert_eq "$(git -C "$CASE_SESSION" rev-parse refs/worktree/private)" "$private_oid" \
    "session-local worktree ref must remain intact"
  git -C "$CASE_SESSION" cat-file -e "$private_oid^{commit}" ||
    fail "commit unique to session-local worktree ref was lost"
  assert_topic_preserved
  echo "PASS: session-local worktree ref is refused before unregistering"
}

test_rewritten_worktree_ref_refusal() {
  local local_master private_oid
  setup_case rewritten-worktree-ref merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  private_oid=$(printf 'rewritten worktree commit\n' | git -C "$CASE_SESSION" commit-tree \
    "$(git -C "$CASE_SESSION" rev-parse HEAD^{tree})" -p "$CASE_TOPIC_OID")
  git -C "$CASE_SESSION" update-ref refs/rewritten/private "$private_oid"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "session-local rewritten ref was accepted for cleanup"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "rewritten worktree ref refusal must precede master advancement"
  assert_eq "$(git -C "$CASE_SESSION" rev-parse refs/rewritten/private)" "$private_oid" \
    "session-local rewritten ref must remain intact"
  assert_topic_preserved
  echo "PASS: session-local rewritten ref is refused before unregistering"
}

test_session_pseudoref_recovery() {
  local fake_bin real_git reflog_oid unique_oid
  setup_case session-pseudoref-recovery merge main-off
  reflog_oid=$(printf 'unique ORIG_HEAD reflog commit\n' | git -C "$CASE_SESSION" commit-tree \
    "$(git -C "$CASE_SESSION" rev-parse HEAD^{tree})" -p "$CASE_TOPIC_OID")
  unique_oid=$(printf 'unique ORIG_HEAD commit\n' | git -C "$CASE_SESSION" commit-tree \
    "$(git -C "$CASE_SESSION" rev-parse HEAD^{tree})" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/session-pseudoref-recovery-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = ORIG_HEAD ] && [ ! -e "$PSEUDOREF_MARKER" ]; then' \
    '    : >"$PSEUDOREF_MARKER"' \
    '    "$REAL_GIT" -C "$2" update-ref --create-reflog ORIG_HEAD "$REFLOG_OID"' \
    '    "$REAL_GIT" -C "$2" update-ref ORIG_HEAD "$UNIQUE_OID" "$REFLOG_OID"' \
    '    git_dir=$("$REAL_GIT" -C "$2" rev-parse --absolute-git-dir)' \
    '    reflog="$git_dir/logs/ORIG_HEAD"' \
    '    tail -n 1 "$reflog" >"$reflog.last"' \
    '    mv "$reflog.last" "$reflog"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" REFLOG_OID="$reflog_oid" UNIQUE_OID="$unique_oid" \
    PSEUDOREF_MARKER="$TEST_ROOT/session-pseudoref-recovery.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/pseudoref-ORIG_HEAD-$unique_oid")" \
    "$unique_oid" "session ORIG_HEAD object must remain directly reachable"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/pseudoref-reflog-ORIG_HEAD-$reflog_oid")" \
    "$reflog_oid" "session ORIG_HEAD reflog object must remain directly reachable"
  echo "PASS: session pseudoref tips and reflogs receive recovery refs before unregistering"
}

test_session_reflog_recovery() {
  local orig_head reflog_path unique_oid
  setup_case session-reflog-recovery merge main-off
  git -C "$CASE_SESSION" checkout --detach >/dev/null
  git -C "$CASE_SESSION" commit --allow-empty -m "unique detached reflog commit" >/dev/null
  unique_oid=$(git -C "$CASE_SESSION" rev-parse HEAD)
  git -C "$CASE_SESSION" reset --hard "$CASE_TOPIC_OID" >/dev/null
  git -C "$CASE_SESSION" reset --hard "$CASE_TOPIC_OID" >/dev/null
  orig_head=$(git -C "$CASE_SESSION" rev-parse ORIG_HEAD)
  [ "$orig_head" != "$unique_oid" ] || fail "test did not evict the unique commit from ORIG_HEAD"
  reflog_path=$(git_log_path "$CASE_SESSION" HEAD)
  printf '%s %s Cleanup\ Test cleanup-test@example.invalid 0 +0000\told-side-only\n' \
    "$unique_oid" "$CASE_TOPIC_OID" >"$reflog_path"

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/reflog-HEAD-$unique_oid")" \
    "$unique_oid" "session HEAD reflog object must remain directly reachable"
  echo "PASS: session HEAD reflog objects receive recovery refs before unregistering"
}

test_session_index_recovery() {
  local blob_oid fake_bin index_ref index_tree real_git retained_blob
  setup_case session-index-recovery merge main-off
  fake_bin="$TEST_ROOT/session-index-recovery-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = ORIG_HEAD ] && [ ! -e "$INDEX_MARKER" ]; then' \
    '    blob=$(printf "staged-only bytes\n" | "$REAL_GIT" -C "$RACE_MAIN" hash-object -w --stdin)' \
    '    "$REAL_GIT" -C "$2" update-index --add --cacheinfo 100644 "$blob" staged-only' \
    '    printf "%s\n" "$blob" >"$INDEX_MARKER"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    INDEX_MARKER="$TEST_ROOT/session-index-recovery.blob" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  blob_oid=$(cat "$TEST_ROOT/session-index-recovery.blob")
  index_ref=$(git -C "$CASE_MAIN" for-each-ref --format='%(refname)' \
    refs/ship-pr/session-recovery/topic | awk '/\/index-tree-/ && !found { print; found = 1 }')
  [ -n "$index_ref" ] || fail "archived session index tree received no recovery ref"
  index_tree=$(git -C "$CASE_MAIN" rev-parse "$index_ref")
  retained_blob=$(git -C "$CASE_MAIN" ls-tree "$index_tree" -- staged-only | awk '{print $3}')
  assert_eq "$retained_blob" "$blob_oid" "staged-only blob must remain reachable from index tree"
  assert_cleaned
  echo "PASS: final session index tree receives a recovery ref before unregistering"
}

test_session_split_index_recovery() {
  local file index_snapshot shared_basename shared_count shared_index
  setup_case session-split-index-recovery merge main-off
  git -C "$CASE_SESSION" update-index --split-index
  shared_index=$(git -C "$CASE_SESSION" rev-parse --shared-index-path)
  [ -n "$shared_index" ] || fail "test did not create a shared index"
  case "$shared_index" in
  /*) ;;
  *) shared_index="$CASE_SESSION/$shared_index" ;;
  esac
  [ -f "$shared_index" ] || fail "test shared index is missing"
  shared_basename=$(basename "$shared_index")

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  [ -f "$CASE_ARCHIVE/$shared_basename" ] ||
    fail "session archive did not retain the split-index base"
  shared_count=0
  for file in "$CASE_ARCHIVE"/sharedindex.*; do
    [ -f "$file" ] || continue
    shared_count=$((shared_count + 1))
  done
  assert_eq "$shared_count" 1 "session archive must retain exactly one split-index base"
  index_snapshot=""
  for file in "$CASE_ARCHIVE"/index.snapshot.*; do
    [ -f "$file" ] || continue
    [ -z "$index_snapshot" ] || fail "session archive retained multiple index snapshots"
    index_snapshot="$file"
  done
  [ -n "$index_snapshot" ] || fail "session archive retained no index snapshot"
  GIT_INDEX_FILE="$index_snapshot" git -C "$CASE_MAIN" ls-files --error-unmatch value >/dev/null ||
    fail "archived split index cannot be read with its retained base"
  echo "PASS: split-index snapshots retain their shared base beside the archived index"
}

test_session_resolve_undo_recovery() {
  local fake_bin first_blob real_git second_blob
  setup_case session-resolve-undo-recovery merge main-off
  fake_bin="$TEST_ROOT/session-resolve-undo-recovery-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = ORIG_HEAD ] && [ ! -e "$REUC_MARKER" ]; then' \
    '    head_blob=$("$REAL_GIT" -C "$2" rev-parse HEAD:value)' \
    '    first=$(printf "resolve-undo first\n" | "$REAL_GIT" -C "$RACE_MAIN" hash-object -w --stdin)' \
    '    second=$(printf "resolve-undo second\n" | "$REAL_GIT" -C "$RACE_MAIN" hash-object -w --stdin)' \
    '    printf "0 0000000000000000000000000000000000000000\tvalue\0" >"$INDEX_INFO"' \
    '    printf "100644 %s 1\tvalue\0" "$head_blob" >>"$INDEX_INFO"' \
    '    printf "100644 %s 2\tvalue\0" "$first" >>"$INDEX_INFO"' \
    '    printf "100644 %s 3\tvalue\0" "$second" >>"$INDEX_INFO"' \
    '    "$REAL_GIT" -C "$2" update-index -z --index-info <"$INDEX_INFO"' \
    '    "$REAL_GIT" -C "$2" update-index --add --cacheinfo 100644 "$head_blob" value' \
    '    printf "%s\n%s\n" "$first" "$second" >"$REUC_MARKER"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    REUC_MARKER="$TEST_ROOT/session-resolve-undo-recovery.oids" \
    INDEX_INFO="$TEST_ROOT/session-resolve-undo-recovery.index-info" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  first_blob=$(sed -n '1p' "$TEST_ROOT/session-resolve-undo-recovery.oids")
  second_blob=$(sed -n '2p' "$TEST_ROOT/session-resolve-undo-recovery.oids")
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/index-reuc-$first_blob")" "$first_blob" \
    "first resolve-undo blob must remain directly reachable"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/index-reuc-$second_blob")" "$second_blob" \
    "second resolve-undo blob must remain directly reachable"
  assert_cleaned
  echo "PASS: session resolve-undo blobs receive recovery refs before unregistering"
}

test_worktree_config_archive() {
  local config_count config_snapshot file
  setup_case worktree-config-archive merge main-off
  git -C "$CASE_MAIN" config extensions.worktreeConfig true
  git -C "$CASE_SESSION" config --worktree cleanup.secret retain-me

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  config_count=0
  config_snapshot=""
  for file in "$CASE_ARCHIVE"/config.worktree.*; do
    [ -f "$file" ] || continue
    config_count=$((config_count + 1))
    config_snapshot="$file"
  done
  assert_eq "$config_count" 1 "cleanup must archive exactly one per-worktree config snapshot"
  assert_eq "$(git config --file "$config_snapshot" --get cleanup.secret)" retain-me \
    "per-worktree configuration must survive unregistering"
  echo "PASS: per-worktree configuration is copied into the recovery archive"
}

test_commit_message_archive() {
  local file hook message message_count message_snapshot
  setup_case commit-message-archive merge main-off
  hook="$CASE_MAIN/.git/hooks/commit-msg"
  printf '#!/bin/sh\nexit 1\n' >"$hook"
  chmod +x "$hook"
  message="retain rejected commit proposal"
  if git -C "$CASE_SESSION" commit --allow-empty -m "$message" >/dev/null 2>&1; then
    fail "commit-msg hook did not reject the scratch commit"
  fi
  unlink "$hook"
  [ -z "$(git -C "$CASE_SESSION" status --porcelain)" ] ||
    fail "rejected commit left the session worktree dirty"

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  message_count=0
  message_snapshot=""
  for file in "$CASE_ARCHIVE"/COMMIT_EDITMSG.*; do
    [ -f "$file" ] || continue
    message_count=$((message_count + 1))
    message_snapshot="$file"
  done
  assert_eq "$message_count" 1 "cleanup must archive exactly one commit-message snapshot"
  assert_eq "$(sed -n '1p' "$message_snapshot")" "$message" \
    "rejected commit message must survive unregistering"
  echo "PASS: rejected commit messages are copied into the recovery archive"
}

# handshake_deadline <case-start-epoch>: the absolute instant, in epoch seconds, past which the
# concurrent-commit fixture stops waiting for either side of its handshakes. Both waits used a
# bare 50 polls -- a fixed five seconds with no relation to anything the suite promises. When a
# loaded box needed longer than that to resume the paused commit and run its commit-msg hook, the
# fake git gave up and returned 91, the helper's `worktree remove` failed, and the case reported
# the helper's genuine-lock message: a fixture stall wearing the helper's failure, which cost
# several PRs a day of proving their diff innocent (ludics-lite#216).
#
# One ABSOLUTE instant, shared by both handshakes and compared against `date +%s` on both sides.
# Neither of the two obvious alternatives survives, and the review found both in turn. A count of
# `sleep 0.1` polls is not a clock: on the loaded host this case is being fixed for each sleep
# resumes late, so N polls run well past N/10 s. And a DURATION computed here is measured from the
# wrong origin for the second handshake, which does not begin here -- it begins inside the helper,
# after its remote and archival work -- so the fake git would spend its full duration from a much
# later start, and the two waits could sum past the case's deadline. An absolute instant is immune
# to both: however late a wait starts, and however far its sleeps drift, neither can run past it,
# so the fixture always reports its own stall before the runner kills the case group and reports a
# generic timeout instead.
handshake_deadline() {
  local budget="${CASE_TIMEOUT:-300}"
  case "$budget" in
  '' | 0 | *[!0-9]*) budget=300 ;;
  esac
  # Reserve a few seconds of the case's deadline so the stall REPORT still runs before the
  # runner's kill. Deliberately unfloored: a deadline already in the past makes the waits give up
  # at once, which is right. Flooring it at `now + 5` would push it PAST the runner's own deadline
  # whenever the case has less than that left -- `SHIP_PR_TEST_CASE_TIMEOUT=2` is a supported
  # value, and the suite's own deadline self-test uses it -- and the runner's generic timeout
  # would then replace this fixture's diagnosis again. Honouring a short deadline beats honouring
  # the 5 s this replaced.
  printf '%s\n' "$(($1 + budget - 5))"
}

test_concurrent_commit_message_archive() {
  local case_started commit_pid deadline done fake_bin file late_message message_count
  local message_snapshot pre_commit ready real_git release stall
  if [ "$ON_MSYS" -eq 1 ]; then
    # Not a hook that fails to fire: the commit does pause in its hook, and the helper then fails
    # loudly ("could not archive session worktree atomically"), as it would for any process whose
    # working directory is the session -- a Windows limit of the helper, not of this fixture.
    skip_boundary "a commit paused inside the session worktree: Windows will not rename a directory that a live process holds as its working directory (EBUSY), and Git runs hooks from the worktree root, so the helper's atomic archive refuses rather than races the commit"
    return 0
  fi
  case_started=$(date +%s)
  setup_case concurrent-commit-message-archive merge main-off
  ready="$TEST_ROOT/concurrent-commit-message.ready"
  release="$TEST_ROOT/concurrent-commit-message.release"
  done="$TEST_ROOT/concurrent-commit-message.done"
  stall="$TEST_ROOT/concurrent-commit-message.stalled"
  deadline=$(handshake_deadline "$case_started")
  pre_commit="$CASE_MAIN/.git/hooks/pre-commit"
  # The paused hook polls at the same 0.1 s the other side does. At `sleep 1` it spent up to a
  # whole second merely noticing its release, which on a quiet box was already the whole of the
  # handshake's measured cost -- the budget was being consumed by the fixture's own granularity.
  printf '#!/bin/sh\ntouch "%s"\nwhile [ ! -e "%s" ]; do sleep 0.1; done\n' \
    "$ready" "$release" >"$pre_commit"
  chmod +x "$pre_commit"
  printf '#!/bin/sh\ntouch "%s"\nexit 1\n' "$done" >"$CASE_MAIN/.git/hooks/commit-msg"
  chmod +x "$CASE_MAIN/.git/hooks/commit-msg"
  late_message="late rejected commit proposal"
  git -C "$CASE_SESSION" commit --allow-empty -m "$late_message" >/dev/null 2>&1 &
  commit_pid=$!
  while [ ! -e "$ready" ] && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.1
  done
  if [ ! -e "$ready" ]; then
    # Report without joining, for the reason the stall branch below gives: a commit that never
    # reached its pre-commit hook is not unblocked by the release marker, so waiting on it would
    # block until the runner killed the case and printed its generic timeout over this message.
    # Touch the marker anyway -- it costs nothing and frees the hook if it starts late -- and
    # leave the outstanding commit to the runner's process-group cleanup.
    touch "$release"
    fail "concurrent commit did not pause in its pre-commit hook within $(($(date +%s) - case_started))s"
  fi

  fake_bin="$TEST_ROOT/concurrent-commit-message-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = worktree ] && [ "$4" = remove ] && [ ! -e "$RELEASE_MARKER" ]; then' \
    '  case "$*" in' \
    '  */session*)' \
    '    : >"$RELEASE_MARKER"' \
    '    touch "$COMMIT_RELEASE"' \
    '    handshake_started=$(date +%s)' \
    '    while [ ! -e "$COMMIT_DONE" ] && [ "$(date +%s)" -lt "$HANDSHAKE_DEADLINE" ]; do sleep 0.1; done' \
    '    if [ ! -e "$COMMIT_DONE" ]; then' \
    '      printf "%s\\n" "$(($(date +%s) - handshake_started))" >"$HANDSHAKE_STALL"' \
    '      exit 91' \
    '    fi' \
    '    ;;' \
    '  esac' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if ! PATH="$fake_bin:$PATH" REAL_GIT="$real_git" COMMIT_RELEASE="$release" \
    COMMIT_DONE="$done" RELEASE_MARKER="$TEST_ROOT/concurrent-commit-message.released" \
    HANDSHAKE_DEADLINE="$deadline" HANDSHAKE_STALL="$stall" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null; then
    # Read the stall marker BEFORE joining the commit. Waiting first would block the diagnosis
    # behind the stall it describes, until the harness killed the case at its deadline and
    # reported a generic timeout -- burying the diagnosis and holding a -j slot for the full
    # deadline.
    if [ -e "$stall" ]; then
      # Report without touching that commit at all -- neither joining it nor signalling it.
      # The marker is written only AFTER the fake git has touched COMMIT_RELEASE, so a stall
      # records a commit that was released and is merely slow, never one that is wedged: it
      # finishes on its own, and there is nothing here to clean up. Joining it would block the
      # diagnosis behind the very stall it describes, and signalling its PID is unsafe once Bash
      # may have reaped the job, because the number can by then belong to another case's process.
      fail "fixture stall, not a helper failure: the released commit did not reach its commit-msg hook in the $(cat "$stall")s it had before the case's handshake deadline, so the fake git failed the helper's worktree removal"
    fi
    # Not a stall: the commit may still be paused in its pre-commit hook, so release it and reap.
    # The helper's own failure is the finding here -- a genuine registration it could not unlock
    # is indistinguishable at the helper from the stall above, which is what four sightings in
    # ludics-lite#216 were filed as.
    touch "$release"
    wait "$commit_pid" >/dev/null 2>&1 || true
    fail "cleanup failed while retaining a concurrent rejected commit message"
  fi
  if wait "$commit_pid"; then
    fail "commit-msg hook unexpectedly accepted the concurrent commit"
  fi
  assert_cleaned
  message_count=0
  message_snapshot=""
  for file in "$CASE_ARCHIVE"/COMMIT_EDITMSG.*; do
    [ -f "$file" ] || continue
    message_count=$((message_count + 1))
    message_snapshot="$file"
  done
  assert_eq "$message_count" 1 "concurrent cleanup must retain one commit-message snapshot"
  assert_eq "$(sed -n '1p' "$message_snapshot")" "$late_message" \
    "commit message written after retention began must survive unregistering"
  echo "PASS: concurrent rejected commit messages remain linked into the recovery archive"
}

test_squash_message_archive() {
  local file message_count message_snapshot side_oid squash_message squash_path
  setup_case squash-message-archive merge main-off
  side_oid=$(printf 'pending squash source\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_SESSION" rev-parse "HEAD^{tree}")" -p "$CASE_TOPIC_OID")
  git -C "$CASE_MAIN" update-ref refs/heads/pending-squash "$side_oid"
  git -C "$CASE_SESSION" merge --squash pending-squash >/dev/null
  [ -z "$(git -C "$CASE_SESSION" status --porcelain)" ] ||
    fail "identical-tree squash unexpectedly dirtied the session"
  squash_path=$(git -C "$CASE_SESSION" rev-parse --git-path SQUASH_MSG)
  [ -f "$squash_path" ] || fail "squash merge created no pending message"
  squash_message=$(cat "$squash_path")

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  message_count=0
  message_snapshot=""
  for file in "$CASE_ARCHIVE"/SQUASH_MSG.*; do
    [ -f "$file" ] || continue
    message_count=$((message_count + 1))
    message_snapshot="$file"
  done
  assert_eq "$message_count" 1 "cleanup must archive exactly one squash-message snapshot"
  assert_eq "$(cat "$message_snapshot")" "$squash_message" \
    "pending squash message must survive unregistering"
  echo "PASS: pending squash messages are copied into the recovery archive"
}

test_tag_and_notes_messages_archive() {
  local editor file name snapshot snapshot_count text
  setup_case tag-notes-messages-archive merge main-off
  editor="$TEST_ROOT/rejecting-message-editor"
  printf '#!/bin/sh\nprintf "%%s\\n" "$EDIT_TEXT" >"$1"\nexit 1\n' >"$editor"
  chmod +x "$editor"

  if GIT_EDITOR="$editor" EDIT_TEXT="retain failed tag proposal" \
    git -C "$CASE_SESSION" tag -a pending-tag >/dev/null 2>&1; then
    fail "tag editor unexpectedly accepted the scratch message"
  fi
  if GIT_EDITOR="$editor" EDIT_TEXT="retain failed notes proposal" \
    git -C "$CASE_SESSION" notes add HEAD >/dev/null 2>&1; then
    fail "notes editor unexpectedly accepted the scratch message"
  fi
  [ -z "$(git -C "$CASE_SESSION" status --porcelain)" ] ||
    fail "failed tag or notes edit dirtied the session"

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  for name in TAG_EDITMSG NOTES_EDITMSG; do
    case "$name" in
    TAG_EDITMSG) text="retain failed tag proposal" ;;
    NOTES_EDITMSG) text="retain failed notes proposal" ;;
    esac
    snapshot_count=0
    snapshot=""
    for file in "$CASE_ARCHIVE/$name".*; do
      [ -f "$file" ] || continue
      snapshot_count=$((snapshot_count + 1))
      snapshot="$file"
    done
    assert_eq "$snapshot_count" 1 "cleanup must archive one $name snapshot"
    assert_eq "$(sed -n '1p' "$snapshot")" "$text" "$name proposal must survive unregistering"
  done
  echo "PASS: failed tag and notes edit messages are copied into the recovery archive"
}

test_sparse_checkout_archive() {
  local file pattern_count pattern_snapshot patterns sparse_path
  setup_case sparse-checkout-archive merge main-off
  git -C "$CASE_SESSION" sparse-checkout init --no-cone
  git -C "$CASE_SESSION" sparse-checkout set --no-cone value
  sparse_path=$(git_path_of "$CASE_SESSION" info/sparse-checkout) || fail "could not locate the sparse-checkout file"
  [ -f "$sparse_path" ] || fail "test created no sparse-checkout pattern file"
  patterns=$(cat "$sparse_path")

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  pattern_count=0
  pattern_snapshot=""
  for file in "$CASE_ARCHIVE"/sparse-checkout.*; do
    [ -f "$file" ] || continue
    pattern_count=$((pattern_count + 1))
    pattern_snapshot="$file"
  done
  assert_eq "$pattern_count" 1 "cleanup must archive exactly one sparse-checkout pattern file"
  assert_eq "$(cat "$pattern_snapshot")" "$patterns" \
    "sparse-checkout patterns must survive unregistering"
  echo "PASS: sparse-checkout patterns are copied into the recovery archive"
}

test_session_metadata_lock_preflight() {
  local local_master lock_path
  setup_case session-metadata-lock-preflight merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  lock_path="$(git -C "$CASE_SESSION" rev-parse --git-path ORIG_HEAD).lock"
  printf 'another Git operation\n' >"$lock_path"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "pre-existing session pseudoref lock was discovered only after mutation"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "session pseudoref lock refusal must precede master advancement"
  assert_eq "$(sed -n '1p' "$lock_path")" "another Git operation" \
    "session pseudoref lock must be preserved"
  assert_topic_preserved
  echo "PASS: session pseudoref locks are preflighted before mutation"
}

test_late_private_worktree_ref_recovery() {
  local fake_bin private_oid private_reflog_oid real_git
  setup_case late-private-worktree-ref merge main-off
  private_oid=$(printf 'late private worktree commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  private_reflog_oid=$(printf 'late private reflog commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/late-private-worktree-ref-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = for-each-ref ] && [ ! -e "$PRIVATE_MARKER" ]; then' \
    '    : >"$PRIVATE_MARKER"' \
    '    "$REAL_GIT" -C "$2" update-ref --create-reflog refs/worktree/late "$PRIVATE_REFLOG_OID"' \
    '    "$REAL_GIT" -C "$2" update-ref refs/worktree/late "$PRIVATE_OID" "$PRIVATE_REFLOG_OID"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" PRIVATE_OID="$private_oid" \
    PRIVATE_REFLOG_OID="$private_reflog_oid" \
    PRIVATE_MARKER="$TEST_ROOT/late-private-worktree-ref.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/private-ref-$private_oid")" "$private_oid" \
    "late session-private ref object must remain directly reachable"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/private-reflog-$private_reflog_oid")" \
    "$private_reflog_oid" "late session-private reflog object must remain directly reachable"
  assert_cleaned
  echo "PASS: late session-private ref tips and reflogs receive recovery refs"
}

test_shared_private_namespace_roots_preserved() {
  local fake_bin real_git real_git_version shared_oid
  setup_case shared-private-namespace-roots merge main-off
  shared_oid=$(printf 'shared namespace root commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/shared-private-namespace-roots-bin"
  real_git=$(command -v git)
  real_git_version=$("$real_git" --version) || fail "could not read the git version used by the private-root race"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'trace() {' \
    '  phase="$1"' \
    '  shift' \
    '  printf "TRACE shared-private pid=%s git=%s phase=%s" "$$" "$REAL_GIT_VERSION" "$phase" >&2' \
    '  for arg in "$@"; do printf " <%s>" "$arg" >&2; done' \
    '  printf "\n" >&2' \
    '}' \
    'trace invoke "$@"' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = for-each-ref ] && [ ! -e "$SHARED_MARKER" ]; then' \
    '    trace injection-begin "$@"' \
    '    : >"$SHARED_MARKER"' \
    '    trace update-ref-begin refs/worktree' \
    '    "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/worktree "$SHARED_OID"' \
    '    trace update-ref-end refs/worktree' \
    '    trace update-ref-begin refs/bisect' \
    '    "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/bisect "$SHARED_OID"' \
    '    trace update-ref-end refs/bisect' \
    '    trace update-ref-begin refs/rewritten' \
    '    "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/rewritten "$SHARED_OID"' \
    '    trace update-ref-end refs/rewritten' \
    '    trace injection-end "$@"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'trace exec-real "$@"' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" REAL_GIT_VERSION="$real_git_version" RACE_MAIN="$CASE_MAIN" \
    SHARED_OID="$shared_oid" SHARED_MARKER="$TEST_ROOT/shared-private-roots.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -e "$TEST_ROOT/shared-private-roots.injected" ] || fail "shared roots were not injected"
  for ref in refs/worktree refs/bisect refs/rewritten; do
    assert_eq "$(git -C "$CASE_MAIN" rev-parse "$ref")" "$shared_oid" \
      "shared namespace root must survive session-private cleanup: $ref"
  done
  assert_cleaned
  echo "PASS: exact shared namespace roots are excluded from private-ref deletion"
}

test_private_namespace_locked_through_unregister() {
  local fake_bin race_oid real_git status
  setup_case private-namespace-lock merge main-off
  race_oid=$(printf 'too-late private ref commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/private-namespace-lock-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = worktree ] && [ "$4" = remove ]; then' \
    '  case "$*" in' \
    '  */session*)' \
    '    for archive in "$RACE_ROOT"/.session.ship-pr-recovery.*/worktree; do' \
    '      [ -d "$archive" ] || continue' \
    '      if "$REAL_GIT" -C "$archive" update-ref refs/worktree/too-late "$RACE_OID" >/dev/null 2>&1; then status=0; else status=$?; fi' \
    '      printf "%s\n" "$status" >"$STATUS_MARKER"' \
    '    done' \
    '    ;;' \
    '  esac' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_ROOT="$CASE_ROOT" RACE_OID="$race_oid" \
    STATUS_MARKER="$TEST_ROOT/private-namespace-lock.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -f "$TEST_ROOT/private-namespace-lock.status" ] ||
    fail "private namespace race was not attempted during unregister"
  status=$(cat "$TEST_ROOT/private-namespace-lock.status")
  [ "$status" -ne 0 ] || fail "a private ref was created during unregister"
  assert_cleaned
  echo "PASS: private ref namespaces stay reserved and locked through unregistering"
}

test_late_active_session_operation_refusal() {
  local archive fake_bin real_git sequencer
  setup_case late-active-session-operation merge main-off
  fake_bin="$TEST_ROOT/late-active-session-operation-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = for-each-ref ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    : >"$RACE_MARKER"' \
    '    git_dir=$("$REAL_GIT" -C "$2" rev-parse --absolute-git-dir)' \
    '    mkdir -p "$git_dir/sequencer"' \
    '    printf "pick %s pending\n" "$TOPIC_OID" >"$git_dir/sequencer/todo"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" TOPIC_OID="$CASE_TOPIC_OID" \
    RACE_MARKER="$TEST_ROOT/late-active-session-operation.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "late active session operation was accepted before unregistering"
  fi
  archive=""
  for archive in "$CASE_ROOT"/.session.ship-pr-recovery.*/worktree; do
    [ -d "$archive" ] && break
  done
  [ -d "$archive" ] || fail "late active-operation refusal lost the session archive"
  sequencer="$(git -C "$archive" rev-parse --absolute-git-dir)/sequencer/todo"
  [ -f "$sequencer" ] || fail "late active session operation state was lost"
  git -C "$CASE_MAIN" show-ref --verify --quiet refs/heads/topic || fail "local topic was lost"
  echo "PASS: late active session operation state is refused before unregistering"
}

test_late_session_module_refusal() {
  local archive fake_bin late_module module_seed real_git session_git_dir unique_oid
  setup_case late-session-module merge main-off
  module_seed="$TEST_ROOT/late-module-seed"
  late_module="$TEST_ROOT/late-module.git"
  git init -b main "$module_seed" >/dev/null
  git_config "$module_seed"
  echo unique >"$module_seed/payload"
  git -C "$module_seed" add payload
  git -C "$module_seed" commit -m "unique late module commit" >/dev/null
  unique_oid=$(git -C "$module_seed" rev-parse HEAD)
  git clone --bare "$module_seed" "$late_module" >/dev/null 2>&1
  fake_bin="$TEST_ROOT/late-session-module-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = for-each-ref ] && [ ! -e "$RACE_MARKER" ]; then' \
    '    : >"$RACE_MARKER"' \
    '    git_dir=$("$REAL_GIT" -C "$2" rev-parse --absolute-git-dir)' \
    '    mkdir -p "$git_dir/modules"' \
    '    mv "$LATE_MODULE" "$git_dir/modules/late"' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" LATE_MODULE="$late_module" \
    RACE_MARKER="$TEST_ROOT/late-session-module.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "late session module repository was accepted before unregistering"
  fi
  archive=""
  for archive in "$CASE_ROOT"/.session.ship-pr-recovery.*/worktree; do
    [ -d "$archive" ] && break
  done
  [ -d "$archive" ] || fail "late module refusal lost the session archive"
  session_git_dir=$(git -C "$archive" rev-parse --absolute-git-dir)
  git --git-dir="$session_git_dir/modules/late" cat-file -e "$unique_oid^{commit}" ||
    fail "late session module unique commit was lost"
  git -C "$CASE_MAIN" show-ref --verify --quiet refs/heads/topic || fail "local topic was lost"
  echo "PASS: late session module repository is refused before unregistering"
}

test_symbolic_ref_refusal() {
  local tracked_master
  setup_case symbolic-local-topic merge main-off
  git -C "$CASE_MAIN" branch topic-target refs/heads/topic
  git -C "$CASE_MAIN" symbolic-ref refs/heads/topic refs/heads/topic-target
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic local topic ref was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref refs/heads/topic)" refs/heads/topic-target \
    "symbolic local topic must remain intact"
  git -C "$CASE_MAIN" ls-remote --exit-code --heads origin refs/heads/topic >/dev/null 2>&1 ||
    fail "remote topic was deleted after symbolic local ref refusal"

  setup_case symbolic-tracking-topic merge main-off
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  tracked_master=$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)
  git -C "$CASE_MAIN" symbolic-ref refs/remotes/origin/topic refs/remotes/origin/master
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic remote-tracking topic ref was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)" "$tracked_master" \
    "symbolic tracking refusal must preserve origin/master"
  assert_topic_preserved

  setup_case symbolic-tracking-master merge main-off
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  tracked_master=$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)
  git -C "$CASE_MAIN" update-ref refs/remotes/origin/master-target "$tracked_master"
  git -C "$CASE_MAIN" update-ref -d refs/remotes/origin/master
  git -C "$CASE_MAIN" symbolic-ref refs/remotes/origin/master refs/remotes/origin/master-target
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic origin/master was accepted before explicit fetch"
  fi
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref refs/remotes/origin/master)" \
    refs/remotes/origin/master-target "symbolic origin/master must remain intact"
  assert_topic_preserved
  echo "PASS: symbolic local and tracking refs are refused"
}

test_remote_base_advance() {
  local real_git advanced_oid hook mode fake_bin log
  for mode in success fetch-failure; do
    setup_case "remote-base-advance-$mode" merge main-off main
    real_git=$(command -v git)
    git -C "$CASE_INTEGRATOR" commit --allow-empty -m sibling >/dev/null
    advanced_oid=$(git -C "$CASE_INTEGRATOR" rev-parse HEAD)
    if git -C "$CASE_MAIN" cat-file -e "$advanced_oid" 2>/dev/null; then
      fail "sibling commit must initially be absent from the cleanup repository"
    fi
    hook="$CASE_MAIN/.git/hooks/pre-push"
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      '"$REAL_GIT" -C "$RACE_INTEGRATOR" push origin "$RACE_OID:refs/heads/main" >/dev/null' \
      'exit 0' >"$hook"
    chmod +x "$hook"
    fake_bin="$CASE_ROOT/bin"
    mkdir -p "$fake_bin"
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'if [ "$3" = fetch ] && [ "$5" = --no-write-fetch-head ] && [ "$RACE_MODE" = fetch-failure ]; then exit 1; fi' \
      'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
    chmod +x "$fake_bin/git"
    log="$CASE_ROOT/cleanup.log"
    if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_INTEGRATOR="$CASE_INTEGRATOR" \
      RACE_OID="$advanced_oid" RACE_MODE="$mode" \
      "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --base main >"$log" 2>&1; then
      [ "$mode" = success ] || fail "cleanup accepted an unverifiable base advance"
      assert_cleaned
      git -C "$CASE_MAIN" cat-file -e "$advanced_oid^{commit}" ||
        fail "cleanup did not fetch the newly advertised base commit"
    else
      [ "$mode" = fetch-failure ] || { cat "$log"; fail "cleanup refused a sibling fast-forward"; }
      assert_remote_restored_after_local_cleanup
      grep 'without a verified fast-forward' "$log" >/dev/null ||
        fail "cleanup did not refuse at the post-deletion ancestry guard"
    fi
    assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/main | awk '{print $1}')" \
      "$advanced_oid" "cleanup must preserve the sibling base advance"
  done
  echo "PASS: sibling base advances are accepted only after a successful exact-tip fetch"
}

# A base rewritten after the initial fetch but before any topic deletion is caught by the
# pre-deletion read: nothing about the topic is touched, the session included.
test_remote_base_rewrite_before_deletion() {
  local fake_bin real_git remote_base log
  setup_case remote-base-rewrite-before-deletion merge main-off
  remote_base=$(git -C "$CASE_INTEGRATOR" rev-list --max-parents=0 HEAD)
  real_git=$(command -v git)
  fake_bin="$CASE_ROOT/bin"
  log="$CASE_ROOT/cleanup.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'is_ls_remote=0' \
    'is_topic=0' \
    'for arg in "$@"; do' \
    '  [ "$arg" = ls-remote ] && is_ls_remote=1' \
    '  [ "$arg" = refs/heads/topic ] && is_topic=1' \
    'done' \
    'if [ "$is_ls_remote" -eq 1 ] && [ "$is_topic" -eq 1 ] && [ ! -e "$RACE_MARKER" ]; then' \
    '  : >"$RACE_MARKER"' \
    '  "$REAL_GIT" -C "$RACE_INTEGRATOR" push --force origin "$RACE_BASE:refs/heads/master" >/dev/null 2>&1' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"
  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_INTEGRATOR="$CASE_INTEGRATOR" \
    RACE_BASE="$remote_base" RACE_MARKER="$CASE_ROOT/rewrite.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "cleanup accepted a base rewritten before topic deletion"
  fi
  [ -e "$CASE_ROOT/rewrite.injected" ] || fail "base rewrite was not injected"
  grep 'without a verified fast-forward before any topic deletion' "$log" >/dev/null ||
    { cat "$log" >&2; fail "the refusal was not the pre-deletion base read"; }
  assert_topic_preserved
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/topic)" "$CASE_TOPIC_OID" \
    "the tracking ref must survive a pre-deletion base refusal"
  echo "PASS: a base rewritten before topic deletion is refused with the topic intact"
}

test_remote_master_lease() {
  local real_git remote_base hook log
  setup_case remote-master-lease merge main-off
  remote_base=$(git -C "$CASE_INTEGRATOR" rev-list --max-parents=0 HEAD)
  real_git=$(command -v git)
  hook="$CASE_MAIN/.git/hooks/pre-push"
  log="$TEST_ROOT/remote-master-lease.log"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    '"$REAL_GIT" -C "$RACE_INTEGRATOR" push --force origin "$RACE_BASE:refs/heads/master" >/dev/null' \
    'exit 0' >"$hook"
  chmod +x "$hook"

  if REAL_GIT="$real_git" RACE_INTEGRATOR="$CASE_INTEGRATOR" \
    RACE_BASE="$remote_base" "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "topic deletion ignored a concurrent remote master rewrite"
  fi
  assert_remote_restored_after_local_cleanup
  assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/master | awk '{print $1}')" \
    "$remote_base" "remote master rewrite must remain visible after atomic refusal"
  echo "PASS: post-advertisement master rewrite restores the topic"
}

test_stale_master_response_retains_recovery() {
  local fake_bin real_git remote_base log
  setup_case stale-master-response merge main-off
  fake_bin="$TEST_ROOT/stale-master-response-bin"
  real_git=$(command -v git)
  remote_base=$(git -C "$CASE_INTEGRATOR" rev-list --max-parents=0 HEAD)
  log="$TEST_ROOT/stale-master-response.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'is_ls_remote=0' \
    'is_master=0' \
    'for arg in "$@"; do' \
    '  [ "$arg" = ls-remote ] && is_ls_remote=1' \
    '  [ "$arg" = refs/heads/master ] && is_master=1' \
    'done' \
    '# Only the final read, once local topic is gone: the pre-deletion read must see the real base.' \
    'if [ "$is_ls_remote" -eq 1 ] && [ "$is_master" -eq 1 ] &&' \
    '  ! "$REAL_GIT" -C "$RACE_MAIN" show-ref --verify --quiet refs/heads/topic; then' \
    '  output=$("$REAL_GIT" "$@")' \
    '  status=$?' \
    '  "$REAL_GIT" -C "$RACE_INTEGRATOR" push --force origin "$RACE_BASE:refs/heads/master" >/dev/null' \
    '  printf "%s\\n" "$output"' \
    '  exit "$status"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_INTEGRATOR="$CASE_INTEGRATOR" \
    RACE_MAIN="$CASE_MAIN" RACE_BASE="$remote_base" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1 ||
    { tail -n 40 "$log" >&2; fail "cleanup with a stale final master response failed (log tail above)"; }
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/master | awk '{print $1}')" \
    "$remote_base" "test must roll remote master back after returning its stale integrated OID"
  echo "PASS: retained recovery survives stale final master evidence"
}

test_symbolic_recovery_ref_refusal() {
  local recovery_ref
  setup_case symbolic-recovery-ref merge main-off
  recovery_ref="refs/ship-pr/recovery/topic/$CASE_TOPIC_OID"
  git -C "$CASE_MAIN" symbolic-ref "$recovery_ref" refs/heads/topic

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic recovery ref was accepted as durable topic retention"
  fi
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref "$recovery_ref")" refs/heads/topic \
    "refused symbolic recovery ref must remain intact"
  assert_topic_preserved
  echo "PASS: symbolic recovery ref is refused before topic deletion"
}

test_topic_reservation() {
  local fake_bin real_git candidate checkout_status
  setup_case topic-reservation merge main-off
  candidate="$CASE_ROOT/topic-candidate"
  git -C "$CASE_MAIN" worktree add --detach "$candidate" refs/heads/topic >/dev/null
  fake_bin="$TEST_ROOT/topic-reservation-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = logs/refs/heads/topic ]; then' \
    '  count=0' \
    '  [ ! -f "$COUNT_MARKER" ] || count=$(cat "$COUNT_MARKER")' \
    '  count=$((count + 1))' \
    '  printf "%s\n" "$count" >"$COUNT_MARKER"' \
    '  if [ "$count" -eq 2 ]; then' \
    '    if "$REAL_GIT" -C "$TOPIC_CANDIDATE" checkout topic >/dev/null 2>&1; then status=0; else status=$?; fi' \
    '    printf "%s\n" "$status" >"$CHECKOUT_MARKER"' \
    '  fi' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" TOPIC_CANDIDATE="$candidate" \
    COUNT_MARKER="$TEST_ROOT/topic-reservation.count" \
    CHECKOUT_MARKER="$TEST_ROOT/topic-reservation.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -f "$TEST_ROOT/topic-reservation.status" ] ||
    fail "topic reservation injection did not run (reflog reads: $(cat "$TEST_ROOT/topic-reservation.count" 2>/dev/null || echo none))"
  checkout_status=$(cat "$TEST_ROOT/topic-reservation.status")
  [ "$checkout_status" -ne 0 ] || fail "another worktree acquired topic during local deletion"
  assert_cleaned
  ! git -C "$candidate" symbolic-ref -q HEAD >/dev/null 2>&1 ||
    fail "topic candidate worktree stopped being detached"
  echo "PASS: topic reservation blocks checkout through local deletion"
}

test_topic_reservation_failure_keeps_remote() {
  local candidate fake_bin real_git log
  setup_case topic-reservation-failure merge main-off
  candidate="$CASE_ROOT/topic-acquisition-candidate"
  git -C "$CASE_MAIN" worktree add --detach "$candidate" refs/heads/topic >/dev/null
  fake_bin="$TEST_ROOT/topic-reservation-failure-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/topic-reservation-failure.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*ship-pr-topic-reserve*)' \
    '  if [ "$3" = switch ] && [ "$5" = topic ]; then' \
    '    "$REAL_GIT" -C "$TOPIC_CANDIDATE" checkout topic >/dev/null 2>&1' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" TOPIC_CANDIDATE="$candidate" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "topic reservation unexpectedly succeeded after competing acquisition"
  fi
  git -C "$CASE_MAIN" show-ref --verify --quiet refs/heads/topic || fail "local topic was lost"
  git -C "$CASE_MAIN" ls-remote --exit-code --heads origin refs/heads/topic >/dev/null 2>&1 ||
    fail "remote topic was deleted after reservation failure"
  [ -d "$CASE_SESSION" ] || fail "original session path was removed after reservation failure"
  echo "PASS: topic reservation failure leaves the remote branch untouched"
}

test_ignored_write_at_session_removal() {
  local archive fake_bin late_archive real_git log
  setup_case ignored-write-at-removal merge main-off
  echo local.log >>"$CASE_MAIN/.git/info/exclude"
  fake_bin="$TEST_ROOT/ignored-write-at-removal-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/ignored-write-at-removal.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = worktree ] && [ "$4" = remove ]; then' \
    '  case "$*" in' \
    '  */session*)' \
    '    if [ ! -e "$RACE_MARKER" ]; then' \
    '      : >"$RACE_MARKER"' \
    '      mkdir -p "$RACE_SESSION"' \
    '      echo irreplaceable >"$RACE_SESSION/local.log"' \
    '    fi' \
    '    ;;' \
    '  esac' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if ! PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_SESSION="$CASE_SESSION" \
    RACE_MARKER="$TEST_ROOT/ignored-write-at-removal.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    sed -n '1,120p' "$log" >&2
    fail "cleanup could not archive a late write at the former session path"
  fi
  late_archive=""
  for archive in "$CASE_ROOT"/.session.ship-pr-late-data.*; do
    [ -d "$archive" ] || continue
    [ -z "$late_archive" ] || fail "more than one late-data archive was created"
    late_archive="$archive"
  done
  [ -n "$late_archive" ] || fail "late ignored data did not receive a recovery archive"
  assert_eq "$(sed -n '1p' "$late_archive/data/local.log")" irreplaceable \
    "ignored data created at worktree removal must never be deleted"
  assert_absent "$CASE_SESSION"
  assert_ref_absent refs/heads/topic
  assert_remote_topic_absent
  assert_eq "$(git -C "$CASE_MAIN" rev-parse "refs/ship-pr/recovery/topic/$CASE_TOPIC_OID")" \
    "$CASE_TOPIC_OID" "late ignored write must leave the topic recovery reachable"
  grep -F "data appearing at the former session path was archived" "$log" >/dev/null ||
    fail "late data at the former session path was not reported"
  echo "PASS: atomic session archival cannot erase a late ignored write"
}

test_dangling_link_at_session_removal() {
  local archive fake_bin late_archive real_git log
  setup_case dangling-link-at-removal merge main-off
  fake_bin="$TEST_ROOT/dangling-link-at-removal-bin"
  real_git=$(command -v git)
  log="$TEST_ROOT/dangling-link-at-removal.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = worktree ] && [ "$4" = remove ]; then' \
    '  case "$*" in' \
    '  */session*)' \
    '    if [ ! -e "$RACE_MARKER" ]; then' \
    '      : >"$RACE_MARKER"' \
    '      ln -s missing-target "$RACE_SESSION"' \
    '    fi' \
    '    ;;' \
    '  esac' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_SESSION="$CASE_SESSION" \
    RACE_MARKER="$TEST_ROOT/dangling-link-at-removal.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1 ||
    { tail -n 40 "$log" >&2; fail "cleanup with a dangling link at session removal failed (log tail above)"; }
  late_archive=""
  for archive in "$CASE_ROOT"/.session.ship-pr-late-data.*; do
    [ -L "$archive/data" ] || continue
    [ -z "$late_archive" ] || fail "more than one dangling-link archive was created"
    late_archive="$archive"
  done
  [ -n "$late_archive" ] || fail "dangling link did not receive a recovery archive"
  assert_eq "$(readlink "$late_archive/data")" missing-target \
    "archived dangling link must retain its target text"
  assert_cleaned
  echo "PASS: dangling link at vacated session path is archived"
}

test_detached_session_head_recovery() {
  setup_case detached-session-head-recovery merge main-off
  git -C "$CASE_SESSION" checkout --detach >/dev/null
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/session-recovery/topic/$CASE_TOPIC_OID")" "$CASE_TOPIC_OID" \
    "validated detached session HEAD must remain reachable after unregistering"
  assert_cleaned
  echo "PASS: detached session HEAD receives a direct recovery ref"
}

test_session_head_locked_through_unregister() {
  local archive commit_status fake_bin real_git
  setup_case session-head-lock merge main-off
  fake_bin="$TEST_ROOT/session-head-lock-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = worktree ] && [ "$4" = remove ]; then' \
    '  case "$*" in' \
    '  */session*)' \
    '    for archive in "$RACE_ROOT"/.session.ship-pr-recovery.*/worktree; do' \
    '      [ -d "$archive" ] || continue' \
    '      "$REAL_GIT" -C "$archive" commit --allow-empty -m "too-late detached commit" >/dev/null 2>&1' \
    '      echo "$?" >"$COMMIT_MARKER"' \
    '    done' \
    '    ;;' \
    '  esac' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_ROOT="$CASE_ROOT" \
    COMMIT_MARKER="$TEST_ROOT/session-head-lock.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  commit_status=$(cat "$TEST_ROOT/session-head-lock.status")
  [ "$commit_status" -ne 0 ] || fail "archived session HEAD advanced after its final recovery read"
  assert_cleaned
  archive="$CASE_ARCHIVE/worktree"
  [ -f "$archive/value" ] || fail "locked session archive lost its worktree files"
  echo "PASS: archived session HEAD is locked through unregistering"
}

test_session_registration_locked_against_prune() {
  local fake_bin real_git
  setup_case session-registration-prune-lock merge main-off
  fake_bin="$TEST_ROOT/session-registration-prune-lock-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '*.ship-pr-recovery.*/worktree)' \
    '  if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = ORIG_HEAD ] && [ ! -e "$PRUNE_MARKER" ]; then' \
    '    : >"$PRUNE_MARKER"' \
    '    "$REAL_GIT" -C "$RACE_MAIN" worktree prune --expire now' \
    '  fi' \
    '  ;;' \
    'esac' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    PRUNE_MARKER="$TEST_ROOT/session-registration-prune-lock.injected" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -e "$TEST_ROOT/session-registration-prune-lock.injected" ] ||
    fail "concurrent worktree prune was not injected"
  assert_cleaned
  [ -f "$CASE_ARCHIVE/worktree/value" ] || fail "prune race damaged the session archive"
  echo "PASS: session registration stays locked against pruning through unregistering"
}

# The session archive is allocated beside the session before anything changes, so a parent that
# cannot hold it refuses the cleanup up front. Driven from outside: the session's parent is made
# unwritable, which is what an unavailable archive location is. An account that can create
# entries in a directory without write permission anyway (root, or Git Bash, where a directory's
# mode bit does not keep anyone out) cannot express it, and the case states that boundary.
test_archive_preflight_refusal() {
  local local_master refusal rc=0
  setup_case archive-preflight-refusal merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  chmod a-w "$CASE_ROOT"
  if mkdir "$CASE_ROOT/.write-probe" 2>/dev/null; then
    rmdir "$CASE_ROOT/.write-probe"
    chmod u+w "$CASE_ROOT"
    skip_boundary "an unwritable directory: this account creates entries in a directory without write permission (root, or a platform whose directories do not keep the mode bit)"
    return 0
  fi
  refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1) || rc=$?
  chmod u+w "$CASE_ROOT"
  [ "$rc" -ne 0 ] || fail "unavailable session archive was discovered only after destructive cleanup"
  case "$refusal" in
  *"could not allocate a session recovery archive beside $CASE_SESSION"*) ;;
  *) fail "the refusal was not the archive preflight: $refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "archive preflight failure must precede the local master update"
  assert_topic_preserved
  echo "PASS: session archive availability is preflighted before mutation"
}

# A target created at the archive path between allocation and the rename must not have the session
# nested inside it: the rename is rename(2), which refuses a nonempty target. A fake git creates
# the target at the helper's last Git call before the rename -- its second ancestry proof, against
# the updated local base -- which is the latest moment a writer can win from outside.
test_precreated_archive_target_refusal() {
  local attacked_target fake_bin real_git
  setup_case precreated-archive-target merge main-off
  fake_bin="$TEST_ROOT/precreated-archive-target-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$#" -eq 6 ] && [ "$1" = -C ] && [ "$2" = "$RACE_MAIN" ] && [ "$3" = merge-base ] &&' \
    '  [ "$4" = --is-ancestor ] && [ "$5" = refs/heads/topic ] && [ "$6" = refs/heads/master ] &&' \
    '  [ ! -e "$TARGET_MARKER" ]; then' \
    '  for archive in "$RACE_ROOT"/.session.ship-pr-recovery.*; do' \
    '    [ -d "$archive" ] || continue' \
    '    mkdir -p "$archive/worktree"' \
    '    echo attacker >"$archive/worktree/blocker"' \
    '    printf "%s\n" "$archive/worktree" >"$TARGET_MARKER"' \
    '  done' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" RACE_ROOT="$CASE_ROOT" \
    TARGET_MARKER="$TEST_ROOT/precreated-archive-target.path" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "session archive nested into a precreated target"
  fi
  [ -f "$TEST_ROOT/precreated-archive-target.path" ] || fail "the fixture never precreated the archive target"
  attacked_target=$(cat "$TEST_ROOT/precreated-archive-target.path")
  [ -f "$attacked_target/blocker" ] || fail "precreated archive target was overwritten"
  [ -d "$CASE_SESSION" ] || fail "failed atomic archive moved the original session"
  [ ! -e "$attacked_target/session" ] || fail "session was nested below the precreated target"
  git -C "$CASE_MAIN" show-ref --verify --quiet refs/heads/topic ||
    fail "local topic was lost after atomic archive refusal"

  rm -rf "$attacked_target"
  rmdir "$(dirname "$attacked_target")"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: atomic archive refuses a precreated nonempty target without nesting"
}

test_session_head_lock_preflight() {
  local head_path local_master lock_contents
  setup_case session-head-lock-preflight merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  head_path=$(git -C "$CASE_SESSION" rev-parse --git-path HEAD)
  lock_contents="owned by another Git process"
  printf '%s\n' "$lock_contents" >"$head_path.lock"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "pre-existing session HEAD lock was discovered only after mutation"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "session HEAD lock refusal must precede master advancement"
  assert_eq "$(cat "$head_path.lock")" "$lock_contents" \
    "session HEAD lock refusal must preserve the caller's lock"
  assert_topic_preserved
  echo "PASS: session HEAD lock is preflighted before mutation"
}

test_dangling_session_head_lock_preflight() {
  local head_path local_master
  setup_case dangling-session-head-lock-preflight merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  head_path=$(git -C "$CASE_SESSION" rev-parse --git-path HEAD)
  ln -s missing-lock-owner "$head_path.lock"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "dangling session HEAD lock symlink was discovered only after mutation"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "dangling session HEAD lock refusal must precede master advancement"
  [ -L "$head_path.lock" ] || fail "dangling session HEAD lock symlink was removed"
  assert_eq "$(readlink "$head_path.lock")" missing-lock-owner \
    "dangling session HEAD lock target must be preserved"
  assert_topic_preserved
  echo "PASS: dangling session HEAD lock is preflighted before mutation"
}

test_session_recovery_namespace_preflight() {
  local local_master
  setup_case session-recovery-namespace-preflight merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" update-ref refs/ship-pr/session-recovery/topic "$CASE_TOPIC_OID"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "conflicting session recovery namespace was discovered only after mutation"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "session recovery namespace refusal must precede master advancement"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/ship-pr/session-recovery/topic)" \
    "$CASE_TOPIC_OID" "conflicting session recovery prefix ref must be preserved"
  assert_topic_preserved
  echo "PASS: session recovery ref namespace is reserved before mutation"
}

test_dangling_config_lock_preflight() {
  local local_master lock_path
  setup_case dangling-config-lock-preflight merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  lock_path="$CASE_MAIN/.git/config.lock"
  ln -s missing-config-writer "$lock_path"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "dangling config lock symlink was discovered only after mutation"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "dangling config lock refusal must precede master advancement"
  [ -L "$lock_path" ] || fail "dangling config lock symlink was removed"
  assert_eq "$(readlink "$lock_path")" missing-config-writer \
    "dangling config lock target must be preserved"
  assert_topic_preserved
  echo "PASS: dangling repository config lock is preflighted before mutation"
}

test_divergent_tracking_tip_recovery() {
  local tracking_oid
  setup_case divergent-tracking-tip merge main-off
  tracking_oid=$(printf 'tracking-only commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  git -C "$CASE_MAIN" update-ref refs/remotes/origin/topic "$tracking_oid"

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/tracking-recovery/topic/$tracking_oid")" "$tracking_oid" \
    "divergent remote-tracking tip must remain directly reachable"
  echo "PASS: divergent remote-tracking tip receives a recovery ref before pruning"
}

test_tracking_tip_move_refusal() {
  local fake_bin race_oid real_git
  setup_case tracking-tip-move merge main-off
  race_oid=$(printf 'late tracking commit\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/tracking-tip-move-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = show-ref ] && [ "$6" = refs/remotes/origin/topic ]; then' \
    '  count=0' \
    '  [ ! -e "$COUNT_MARKER" ] || count=$(cat "$COUNT_MARKER")' \
    '  count=$((count + 1))' \
    '  echo "$count" >"$COUNT_MARKER"' \
    '  if [ "$count" -eq 2 ]; then' \
    '    "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/remotes/origin/topic "$RACE_OID"' \
    '  fi' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_OID="$race_oid" COUNT_MARKER="$TEST_ROOT/tracking-tip-move.count" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "cleanup deleted a remote-tracking ref that moved after its recovery snapshot"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/topic)" "$race_oid" \
    "late remote-tracking tip must be preserved"
  git -C "$CASE_MAIN" cat-file -e "$race_oid^{commit}" ||
    fail "commit unique to late remote-tracking tip was lost"
  git -C "$CASE_MAIN" show-ref --verify --quiet refs/heads/topic ||
    fail "local topic was lost after remote-tracking move refusal"
  [ -d "$CASE_SESSION" ] || fail "session was lost after remote-tracking move refusal"
  echo "PASS: remote-tracking ref movement is refused without deleting its new tip"
}

test_tracking_reflog_recovery() {
  local reflog_oid
  setup_case tracking-reflog-recovery merge main-off
  reflog_oid=$(printf 'tracking reflog only\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  git -C "$CASE_MAIN" update-ref refs/remotes/origin/topic "$reflog_oid"
  git -C "$CASE_MAIN" update-ref refs/remotes/origin/topic "$CASE_TOPIC_OID"
  keep_last_reflog_entry "$CASE_MAIN" refs/remotes/origin/topic

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/recovery/topic/tracking-reflog-$reflog_oid")" "$reflog_oid" \
    "remote-tracking reflog object must remain directly reachable"
  echo "PASS: remote-tracking reflog objects receive recovery refs before pruning"
}

test_tracking_reflog_locked_through_deletion() {
  local attempted_oid fake_bin real_git status
  setup_case tracking-reflog-delete-lock merge main-off
  attempted_oid=$(printf 'competing tracking ABA update\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/tracking-reflog-delete-lock-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = logs/refs/remotes/origin/topic ]; then' \
    '  count=0' \
    '  [ ! -f "$COUNT_MARKER" ] || count=$(cat "$COUNT_MARKER")' \
    '  count=$((count + 1))' \
    '  printf "%s\n" "$count" >"$COUNT_MARKER"' \
    '  if [ "$count" -eq 2 ]; then' \
    '    if "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/remotes/origin/topic "$RACE_OID" "$TOPIC_OID" >/dev/null 2>&1; then status=0; else status=$?; fi' \
    '    printf "%s\n" "$status" >"$STATUS_MARKER"' \
    '  fi' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_OID="$attempted_oid" TOPIC_OID="$CASE_TOPIC_OID" \
    COUNT_MARKER="$TEST_ROOT/tracking-reflog-delete-lock.count" \
    STATUS_MARKER="$TEST_ROOT/tracking-reflog-delete-lock.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -f "$TEST_ROOT/tracking-reflog-delete-lock.status" ] ||
    fail "test never attempted a tracking update during the locked reflog read"
  status=$(cat "$TEST_ROOT/tracking-reflog-delete-lock.status")
  [ "$status" -ne 0 ] || fail "competing tracking update succeeded during reflog retention"
  assert_cleaned
  echo "PASS: tracking ref and reflog stay locked together through deletion"
}

test_topic_reflog_recovery() {
  local reflog_oid
  setup_case topic-reflog-recovery merge main-off
  reflog_oid=$(printf 'topic reflog only\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  git -C "$CASE_MAIN" update-ref refs/heads/topic "$reflog_oid" "$CASE_TOPIC_OID"
  git -C "$CASE_MAIN" update-ref refs/heads/topic "$CASE_TOPIC_OID" "$reflog_oid"
  keep_last_reflog_entry "$CASE_MAIN" refs/heads/topic

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" rev-parse \
    "refs/ship-pr/recovery/topic/topic-reflog-$reflog_oid")" "$reflog_oid" \
    "local topic reflog object must remain directly reachable"
  echo "PASS: local topic reflog objects receive recovery refs before branch deletion"
}

test_topic_reflog_locked_through_deletion() {
  local attempted_oid fake_bin real_git status
  setup_case topic-reflog-delete-lock merge main-off
  attempted_oid=$(printf 'competing topic ABA update\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$CASE_TOPIC_OID^{tree}")" -p "$CASE_TOPIC_OID")
  fake_bin="$TEST_ROOT/topic-reflog-delete-lock-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = logs/refs/heads/topic ]; then' \
    '  count=0' \
    '  [ ! -f "$COUNT_MARKER" ] || count=$(cat "$COUNT_MARKER")' \
    '  count=$((count + 1))' \
    '  printf "%s\n" "$count" >"$COUNT_MARKER"' \
    '  if [ "$count" -eq 2 ]; then' \
    '    if "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/topic "$RACE_OID" "$TOPIC_OID" >/dev/null 2>&1; then status=0; else status=$?; fi' \
    '    printf "%s\n" "$status" >"$STATUS_MARKER"' \
    '  fi' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    RACE_OID="$attempted_oid" TOPIC_OID="$CASE_TOPIC_OID" \
    COUNT_MARKER="$TEST_ROOT/topic-reflog-delete-lock.count" \
    STATUS_MARKER="$TEST_ROOT/topic-reflog-delete-lock.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -f "$TEST_ROOT/topic-reflog-delete-lock.status" ] ||
    fail "test never attempted a topic update during the locked reflog read"
  status=$(cat "$TEST_ROOT/topic-reflog-delete-lock.status")
  [ "$status" -ne 0 ] || fail "competing topic update succeeded during the reflog retention window"
  assert_cleaned
  echo "PASS: topic ref and reflog stay locked together through final deletion"
}

test_final_topic_lease_keeps_remote() {
  local archive archive_count fake_bin new_oid old_oid race_main real_git remote_oid
  setup_case final-topic-lease merge main-off
  race_main=$(cd "$CASE_MAIN" && pwd -P)
  old_oid=$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)
  new_oid=$(printf 'late local topic advance\n' | git -C "$CASE_MAIN" commit-tree \
    "$(git -C "$CASE_MAIN" rev-parse "$old_oid^{tree}")" -p "$old_oid")
  fake_bin="$TEST_ROOT/final-topic-lease-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$2" = "$RACE_MAIN" ] && [ "$3" = update-ref ] && [ "$4" = --stdin ] && [ ! -d "$RACE_SESSION" ] && [ ! -e "$RACE_MARKER" ]; then' \
    '  : >"$RACE_MARKER"' \
    '  "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/topic "$RACE_NEW_OID" "$RACE_OLD_OID"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$race_main" \
    RACE_SESSION="$CASE_SESSION" RACE_MARKER="$TEST_ROOT/final-topic-lease.injected" \
    RACE_NEW_OID="$new_oid" RACE_OLD_OID="$old_oid" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "final topic lease accepted a concurrent local advance"
  fi
  [ -e "$TEST_ROOT/final-topic-lease.injected" ] || fail "final topic lease race was not injected"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)" "$new_oid" \
    "late local topic advance must remain local"
  # The remote deletion comes only after the local one commits (ludics-lite#287), so a refused
  # final lease never reached it: origin keeps the tip it had, rather than a restored one.
  remote_oid=$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')
  assert_eq "$remote_oid" "$old_oid" "remote topic must be untouched by a refused final lease"
  [ ! -d "$CASE_SESSION" ] || fail "session should already be archived at the final lease"
  archive_count=0
  for archive in "$CASE_ROOT"/.session.ship-pr-recovery.*; do
    [ -d "$archive" ] || continue
    archive_count=$((archive_count + 1))
  done
  assert_eq "$archive_count" 1 "final lease refusal must retain one session archive"
  echo "PASS: final topic lease races keep the local advance and leave the remote untouched"
}

test_remote_deletion_follows_local_deletion() {
  local zero
  setup_case remote-deletion-last merge main-off
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  zero=$(printf '%s' "$CASE_TOPIC_OID" | tr '0-9a-f' '0')
  assert_eq "$(cat "$CASE_PUSH_LOG")" "local-absent invoked
local-absent (delete) $zero refs/heads/topic $CASE_TOPIC_OID" \
    "the only push must be the remote topic deletion, sent after the local topic was gone"
  echo "PASS: the remote topic is deleted last, after the local deletion has committed"
}

# The negative controls for `assert_topic_preserved` (ludics-lite#343). `deleted` deletes the remote
# topic and pushes it back at the same tip: every ref and the session end exactly as they began, so
# only the push log can tell, and the assertion must go red on it. `unhooked` replaces the logging
# hook and pushes nothing: the empty log then records nothing, and the assertion must refuse it
# rather than pass. `redirected` leaves the hook in place but points core.hooksPath elsewhere, and
# `unexecutable` clears its executable bit: Git would never run it, so both are refused the same
# way. `up-to-date` sends a push that proposes no ref update, which still reaches the remote.
test_topic_preserved_negative_controls() {
  local mode out
  for mode in deleted unhooked redirected unexecutable up-to-date; do
    setup_case "topic-preserved-control-$mode" merge main-off
    case "$mode" in
    deleted)
      git -C "$CASE_MAIN" push origin :refs/heads/topic >/dev/null 2>&1
      git -C "$CASE_MAIN" push origin "$CASE_TOPIC_OID:refs/heads/topic" >/dev/null 2>&1
      assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')" \
        "$CASE_TOPIC_OID" "the restored remote topic must be back at its tip"
      ;;
    unhooked)
      printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$CASE_MAIN/.git/hooks/pre-push"
      ;;
    redirected)
      mkdir "$CASE_ROOT/other-hooks"
      git -C "$CASE_MAIN" config core.hooksPath "$CASE_ROOT/other-hooks"
      ;;
    unexecutable)
      chmod -x "$CASE_MAIN/.git/hooks/pre-push"
      # Git Bash reads executability off a `#!` line, not a mode bit, and so does Git for Windows:
      # there the hook is still one Git runs, and there is nothing for the assertion to refuse.
      if [ -x "$CASE_MAIN/.git/hooks/pre-push" ]; then
        skip_boundary "the unexecutable push logger: this platform reads a file executable from its #! line, not a mode bit, so chmod -x leaves a hook Git still runs"
        continue
      fi
      ;;
    up-to-date)
      git -C "$CASE_MAIN" push origin "$CASE_TOPIC_OID:refs/heads/topic" >/dev/null 2>&1
      assert_eq "$(cat "$CASE_PUSH_LOG")" "local-present invoked" \
        "an up-to-date push must be recorded although it proposes no ref update"
      ;;
    esac
    if out=$(assert_topic_preserved 2>&1); then
      fail "assert_topic_preserved passed a topic it cannot vouch for ($mode)"
    fi
    case "$mode:$out" in
    "deleted:FAIL: the remote was pushed to by a refusal that must not touch it: "*) ;;
    "unhooked:FAIL: the pre-push hook Git runs is not the push logger, so whether the remote was touched is unrecorded") ;;
    "redirected:FAIL: the pre-push hook Git runs is not the push logger, so whether the remote was touched is unrecorded") ;;
    "unexecutable:FAIL: the pre-push hook Git runs is not the push logger, so whether the remote was touched is unrecorded") ;;
    "up-to-date:FAIL: the remote was pushed to by a refusal that must not touch it: "*) ;;
    *) fail "assert_topic_preserved went red for another reason ($mode): $out" ;;
    esac
  done
  echo "PASS: assert_topic_preserved refuses a delete-then-restore, an up-to-date push, and a push logger Git would not run"
}

# A local topic recreated while the remote steps run must not outlive its public branch. Each mode
# recreates it at a different moment, in a different shape: `push` from the pre-push hook as a
# direct ref, `base` during the final base read as a dangling symbolic ref (which resolves to no
# tip, so the retained original is published). Either way the helper's last read catches it.
test_local_topic_recreated_during_remote_deletion() {
  local fake_bin hook log mode real_git
  for mode in push base; do
    setup_case "local-topic-recreated-$mode" merge main-off
    real_git=$(command -v git)
    log="$CASE_ROOT/cleanup.log"
    case "$mode" in
    push)
      hook="$CASE_MAIN/.git/hooks/pre-push"
      printf '%s\n' \
        '#!/usr/bin/env bash' \
        'if [ ! -e "$RACE_MARKER" ]; then' \
        '  : >"$RACE_MARKER"' \
        '  "$REAL_GIT" -C "$RACE_MAIN" update-ref refs/heads/topic "$RACE_OID" ""' \
        'fi' \
        'exit 0' >"$hook"
      chmod +x "$hook"
      ;;
    base)
      fake_bin="$CASE_ROOT/bin"
      mkdir -p "$fake_bin"
      printf '%s\n' \
        '#!/usr/bin/env bash' \
        'is_ls_remote=0' \
        'is_master=0' \
        'for arg in "$@"; do' \
        '  [ "$arg" = ls-remote ] && is_ls_remote=1' \
        '  [ "$arg" = refs/heads/master ] && is_master=1' \
        'done' \
        'if [ "$is_ls_remote" -eq 1 ] && [ "$is_master" -eq 1 ] && [ ! -e "$RACE_MARKER" ] &&' \
        '  ! "$REAL_GIT" -C "$RACE_MAIN" show-ref --verify --quiet refs/heads/topic; then' \
        '  : >"$RACE_MARKER"' \
        '  "$REAL_GIT" -C "$RACE_MAIN" symbolic-ref refs/heads/topic refs/heads/missing-topic-target' \
        'fi' \
        'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
      chmod +x "$fake_bin/git"
      ;;
    esac
    if PATH="${fake_bin:+$fake_bin:}$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
      RACE_OID="$CASE_TOPIC_OID" RACE_MARKER="$CASE_ROOT/recreated.injected" \
      "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
      fail "cleanup completed although local topic reappeared during its remote deletion ($mode)"
    fi
    [ -e "$CASE_ROOT/recreated.injected" ] || fail "local topic recreation was not injected ($mode)"
    grep 'reappeared (publishing .*) during the remote deletion; origin/topic was restored' "$log" >/dev/null ||
      { cat "$log" >&2; fail "the $mode refusal was not the final recreation check"; }
    case "$mode" in
    push)
      assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)" "$CASE_TOPIC_OID" \
        "the recreated local topic must be left alone"
      ;;
    base)
      assert_eq "$(git -C "$CASE_MAIN" symbolic-ref refs/heads/topic)" refs/heads/missing-topic-target \
        "the recreated symbolic topic must be left alone"
      ;;
    esac
    assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')" \
      "$CASE_TOPIC_OID" "the remote topic must be republished ($mode)"
    fake_bin=""
  done
  echo "PASS: a local topic recreated during the remote steps is published again"
}

# The Git for Windows shape of ludics-lite#287 at each local deletion in turn: the transaction's Git
# reads nothing and exits 0 having done nothing. The fixture keeps the real input open on fd 9, so
# the helper's writes still land in a pipe and the refusal is its own, not a SIGPIPE.
test_failed_local_deletion_keeps_remote() {
  local fake_bin mode real_git race_main
  for mode in tracking topic; do
    setup_case "failed-local-deletion-$mode" merge main-off
    race_main=$(cd "$CASE_MAIN" && pwd -P)
    real_git=$(command -v git)
    fake_bin="$CASE_ROOT/bin"
    mkdir -p "$fake_bin"
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'if [ "$2" = "$RACE_MAIN" ] && [ "$3" = update-ref ] && [ "$4" = --stdin ] && [ -f /dev/stdout ]; then' \
      '  case "$RACE_MODE" in' \
      '  tracking) exec 9<&0 </dev/null ;;' \
      '  topic) [ -d "$RACE_SESSION" ] || exec 9<&0 </dev/null ;;' \
      '  esac' \
      'fi' \
      'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
    chmod +x "$fake_bin/git"

    if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$race_main" RACE_MODE="$mode" \
      RACE_SESSION="$CASE_SESSION" \
      "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$CASE_ROOT/cleanup.log" 2>&1; then
      fail "cleanup succeeded although its $mode deletion transaction read nothing"
    fi
    grep 'ref deletion transaction did not start' "$CASE_ROOT/cleanup.log" >/dev/null ||
      { cat "$CASE_ROOT/cleanup.log" >&2; fail "the $mode refusal was not the unstarted transaction"; }
    [ ! -s "$CASE_PUSH_LOG" ] || fail "a failed $mode deletion still pushed: $(cat "$CASE_PUSH_LOG")"
    assert_eq "$(git -C "$CASE_MAIN" ls-remote origin refs/heads/topic | awk '{print $1}')" \
      "$CASE_TOPIC_OID" "remote topic must be untouched by a failed $mode deletion"
    assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/topic)" "$CASE_TOPIC_OID" \
      "local topic must survive a failed $mode deletion"
    case "$mode" in
    tracking)
      [ -d "$CASE_SESSION" ] || fail "session was archived although the tracking deletion failed first"
      assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/topic)" "$CASE_TOPIC_OID" \
        "tracking ref must survive its failed deletion"
      ;;
    topic) [ ! -d "$CASE_SESSION" ] || fail "session should already be archived at the final deletion" ;;
    esac
  done
  echo "PASS: a local deletion that does nothing never reaches the remote topic"
}

# Git for Windows cannot use an MSYS2 FIFO (ludics-lite#287), and this fixture cannot tell a FIFO
# from an anonymous pipe, so it breaks every transaction whose responses go to either: its Git then
# reads nothing and answers nothing. The helper's transactions answer into a regular file, so the
# whole cleanup still completes.
test_ref_transactions_answer_into_a_regular_file() {
  local fake_bin real_git
  setup_case transactions-without-fifos merge main-off
  real_git=$(command -v git)
  fake_bin="$CASE_ROOT/bin"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$4" = --stdin ] && [ -p /dev/stdout ]; then' \
    '  exec 9<&0 </dev/null >/dev/null' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"
  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: ref transactions complete without a FIFO or pipe on their response channel"
}

test_branch_config_locked_through_deletion() {
  local fake_bin real_git status
  setup_case branch-config-lock merge main-off
  fake_bin="$TEST_ROOT/branch-config-lock-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = rev-parse ] && [ "$4" = --git-path ] && [ "$5" = logs/refs/heads/topic ]; then' \
    '  count=0' \
    '  [ ! -f "$COUNT_MARKER" ] || count=$(cat "$COUNT_MARKER")' \
    '  count=$((count + 1))' \
    '  printf "%s\n" "$count" >"$COUNT_MARKER"' \
    '  if [ "$count" -eq 2 ]; then' \
    '    if "$REAL_GIT" -C "$RACE_MAIN" config branch.topic.remote raced >/dev/null 2>&1; then status=0; else status=$?; fi' \
    '    printf "%s\n" "$status" >"$STATUS_MARKER"' \
    '  fi' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    COUNT_MARKER="$TEST_ROOT/branch-config-lock.count" \
    STATUS_MARKER="$TEST_ROOT/branch-config-lock.status" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  [ -f "$TEST_ROOT/branch-config-lock.status" ] ||
    fail "branch config race was not attempted during deletion"
  status=$(cat "$TEST_ROOT/branch-config-lock.status")
  [ "$status" -ne 0 ] || fail "standard branch configuration was written during cleanup"
  assert_cleaned
  echo "PASS: repository configuration stays locked through topic deletion"
}

test_symref_capability_preflight() {
  local fake_bin local_master real_git
  setup_case symref-capability-preflight merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  fake_bin="$TEST_ROOT/symref-capability-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = update-ref ] && [ "$4" = --stdin ]; then' \
    '  exit 1' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "missing symref transaction capability was discovered only after mutation"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "symref capability refusal must precede master advancement"
  [ -z "$(git -C "$CASE_MAIN" for-each-ref --format='%(refname)' \
    refs/ship-pr/capability-probe-)" ] || fail "failed capability probe ref was left behind"
  assert_topic_preserved
  echo "PASS: symref transaction support is preflighted before mutation"
}

test_dangling_capability_ref_refusal() {
  local capability_ref fake_bin local_master real_git
  setup_case dangling-capability-ref merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  fake_bin="$TEST_ROOT/dangling-capability-ref-bin"
  real_git=$(command -v git)
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$3" = show-ref ] && [ "$4" = --exists ]; then' \
    '  "$REAL_GIT" -C "$RACE_MAIN" symbolic-ref "$5" refs/heads/missing-capability-target' \
    '  printf "%s\n" "$5" >"$CAPABILITY_MARKER"' \
    'fi' \
    'exec "$REAL_GIT" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" RACE_MAIN="$CASE_MAIN" \
    CAPABILITY_MARKER="$TEST_ROOT/dangling-capability-ref.path" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "pre-existing dangling capability ref was overwritten"
  fi
  capability_ref=$(cat "$TEST_ROOT/dangling-capability-ref.path")
  assert_eq "$(git -C "$CASE_MAIN" symbolic-ref "$capability_ref")" \
    refs/heads/missing-capability-target "dangling capability ref must be preserved"
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "dangling capability ref refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: dangling capability probe ref is detected without dereferencing"
}

test_option_like_branch_name() {
  setup_case option-like-branch merge main-off
  git -C "$CASE_MAIN" update-ref refs/heads/-topic "$CASE_TOPIC_OID" ""
  git -C "$CASE_SESSION" symbolic-ref HEAD refs/heads/-topic
  git -C "$CASE_MAIN" update-ref -d refs/heads/topic "$CASE_TOPIC_OID"
  git -C "$CASE_MAIN" config --rename-section branch.topic branch.-topic
  git -C "$CASE_SESSION" push origin "$CASE_TOPIC_OID:refs/heads/-topic" >/dev/null
  git -C "$CASE_SESSION" push origin :refs/heads/topic >/dev/null
  CASE_BRANCH=-topic

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" "$CASE_BRANCH" >/dev/null
  assert_cleaned
  echo "PASS: option-like topic branch name is handled safely"
}

test_relative_tmpdir() {
  setup_case relative-tmpdir merge main
  mkdir "$CASE_ROOT/relative-tmp"
  (cd "$CASE_ROOT" && TMPDIR=relative-tmp \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null)
  assert_cleaned
  [ ! -e "$CASE_MAIN/relative-tmp" ] ||
    fail "relative TMPDIR was incorrectly resolved beneath the main checkout"
  echo "PASS: relative TMPDIR is canonicalized before temporary worktree use"
}

test_session_tmpdir_refusal() {
  local local_master
  setup_case session-tmpdir merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  if TMPDIR="$CASE_SESSION" "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "session worktree was accepted as the temporary root"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "session TMPDIR refusal must precede master advancement"
  assert_topic_preserved
  echo "PASS: temporary roots inside the session are refused before mutation"
}

# An unusable TMPDIR refuses at the helper's first allocation in it, the worktree-list snapshot,
# which comes before the base fetch and before any reservation: the shell helper's order, which the
# port keeps by still allocating (and removing) that snapshot file.
test_unwritable_tmpdir_refusal() {
  local tmp tracking refusal rc=0
  setup_case unwritable-tmpdir merge main-off
  tmp="$CASE_ROOT/unwritable-tmp"
  mkdir "$tmp"
  tracking=$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)
  [ "$tracking" != "$(git -C "$CASE_REMOTE" rev-parse refs/heads/master)" ] ||
    fail "the fixture's tracking ref is already the remote tip, so an early fetch would go unseen"
  chmod a-w "$tmp"
  if mkdir "$tmp/.write-probe" 2>/dev/null; then
    rmdir "$tmp/.write-probe"
    chmod u+w "$tmp"
    skip_boundary "an unwritable directory: this account creates entries in a directory without write permission (root, or a platform whose directories do not keep the mode bit)"
    return 0
  fi
  refusal=$(TMPDIR="$tmp" "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1) || rc=$?
  chmod u+w "$tmp"
  assert_eq "$rc" 1 "an unwritable TMPDIR is an environment refusal"
  case "$refusal" in
  *"could not allocate the worktree list snapshot"*) ;;
  *) fail "the refusal was not the first temporary allocation: $refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/remotes/origin/master)" "$tracking" \
    "an unwritable TMPDIR must refuse before the base fetch"
  assert_eq "$(git -C "$CASE_MAIN" for-each-ref refs/ship-pr)" "" \
    "an unwritable TMPDIR must refuse before any reservation"
  assert_topic_preserved
  echo "PASS: an unwritable TMPDIR refuses at the first allocation, before the fetch"
}

test_config_lock_refusal() {
  setup_case config-lock merge main-off
  : >"$CASE_MAIN/.git/config.lock"
  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "repository config lock was accepted"
  fi
  assert_topic_preserved
  echo "PASS: config lock is refused before cleanup"
}

test_symbolic_repository_config_refusal() {
  local config_path local_master target
  setup_case symbolic-repository-config merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  config_path="$CASE_MAIN/.git/config"
  target="$TEST_ROOT/symbolic-repository-config.target"
  mv "$config_path" "$target"
  ln -s "$target" "$config_path"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic repository configuration was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "symbolic repository config refusal must precede master advancement"
  [ -L "$config_path" ] || fail "symbolic repository configuration was replaced"
  assert_topic_preserved
  echo "PASS: symbolic repository configuration is refused before mutation"
}

test_symbolic_worktree_config_preflight() {
  local config_path local_master target
  setup_case symbolic-worktree-config merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" config extensions.worktreeConfig true
  config_path=$(git_path_of "$CASE_SESSION" config.worktree) || fail "could not locate config.worktree"
  target="$TEST_ROOT/symbolic-worktree-config.target"
  : >"$target"
  { [ ! -e "$config_path" ] && [ ! -L "$config_path" ]; } || unlink "$config_path"
  ln -s "$target" "$config_path"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "symbolic per-worktree configuration was accepted"
  fi
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "symbolic worktree config refusal must precede master advancement"
  [ -L "$config_path" ] || fail "symbolic per-worktree configuration was changed"
  assert_topic_preserved
  echo "PASS: symbolic per-worktree configuration is refused during preflight"
}

test_ignored_master_collision_refusal() {
  local collision
  setup_case ignored-master-collision merge other
  collision="$CASE_MASTER_OWNER/collision"
  echo collision >>"$CASE_MAIN/.git/info/exclude"
  echo local-data >"$collision"
  echo remote-data >"$CASE_INTEGRATOR/collision"
  git -C "$CASE_INTEGRATOR" add collision
  git -C "$CASE_INTEGRATOR" commit -m "track an ignored master-owner path" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "master refresh overwrote an ignored path collision"
  fi
  assert_eq "$(sed -n '1p' "$collision")" local-data "ignored master-owner data must survive"
  assert_topic_preserved
  echo "PASS: ignored master-owner collision is refused"
}

test_ignored_master_descendant_refusal() {
  local collision tracked_tip
  setup_case ignored-master-descendant merge other
  collision="$CASE_MASTER_OWNER/collision"
  mkdir "$CASE_INTEGRATOR/collision"
  echo tracked >"$CASE_INTEGRATOR/collision/tracked"
  git -C "$CASE_INTEGRATOR" add collision/tracked
  git -C "$CASE_INTEGRATOR" commit -m "add tracked master directory" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null
  tracked_tip=$(git -C "$CASE_INTEGRATOR" rev-parse HEAD)
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  git -C "$CASE_MASTER_OWNER" reset --hard "$tracked_tip" >/dev/null

  git -C "$CASE_INTEGRATOR" rm collision/tracked >/dev/null
  echo remote-file >"$CASE_INTEGRATOR/collision"
  git -C "$CASE_INTEGRATOR" add collision
  git -C "$CASE_INTEGRATOR" commit -m "replace tracked directory with a file" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null
  echo collision/local >>"$CASE_MAIN/.git/info/exclude"
  echo local-data >"$collision/local"

  if "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>&1; then
    fail "master refresh replaced a directory containing ignored local data"
  fi
  assert_eq "$(sed -n '1p' "$collision/local")" local-data \
    "ignored descendant under a replaced directory must survive"
  assert_topic_preserved
  echo "PASS: ignored descendant under replaced master directory is refused"
}

# A pathname carrying a newline is C-quoted by every line-based Git rendering, so the read this
# replaced returned `"collision/lo\ncal.log"` -- a name no file on disk has -- and sent the
# operator after it. The refusal must carry the name the file actually has, and must carry it
# escaped: printed raw, the newline would forge a second diagnostic line out of the name's tail.
test_ignored_master_descendant_newline_name_refusal() {
  local collision descendant tracked_tip refusal
  setup_case ignored-master-descendant-newline merge other
  collision="$CASE_MASTER_OWNER/collision"
  descendant=$(printf 'lo\ncal.log')
  mkdir "$CASE_INTEGRATOR/collision"
  echo tracked >"$CASE_INTEGRATOR/collision/tracked"
  git -C "$CASE_INTEGRATOR" add collision/tracked
  git -C "$CASE_INTEGRATOR" commit -m "add tracked master directory" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null
  tracked_tip=$(git -C "$CASE_INTEGRATOR" rev-parse HEAD)
  git -C "$CASE_MAIN" fetch origin refs/heads/master:refs/remotes/origin/master >/dev/null
  git -C "$CASE_MASTER_OWNER" reset --hard "$tracked_tip" >/dev/null

  git -C "$CASE_INTEGRATOR" rm collision/tracked >/dev/null
  echo remote-file >"$CASE_INTEGRATOR/collision"
  git -C "$CASE_INTEGRATOR" add collision
  git -C "$CASE_INTEGRATOR" commit -m "replace tracked directory with a file" >/dev/null
  git -C "$CASE_INTEGRATOR" push origin master >/dev/null
  # A glob rather than the name itself: the exclude file is line-based and could not spell a
  # newline. It must leave `collision` and the tracked `collision/tracked` unignored, or the
  # check-ignore branch above the descendant read claims the refusal first.
  echo 'collision/*.log' >>"$CASE_MAIN/.git/info/exclude"
  echo local-data >"$collision/$descendant"
  case "$(git -C "$CASE_MASTER_OWNER" ls-files --others --ignored --exclude-standard \
    -- collision)" in
  '"'*) ;;
  *) fail "the fixture must produce a C-quoted ls-files path" ;;
  esac

  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "master refresh replaced a directory holding a newline-named ignored file"
  fi
  assert_eq "$(cat "$collision/$descendant")" local-data \
    "the newline-named ignored descendant must survive"
  if [ "$ON_MSYS" -eq 1 ]; then
    # The refusal and the survival above hold here too; the spelling is what cannot be compared.
    skip_boundary "how the refusal spells the newline name: $MSYS_CONTROL_NAME_BOUNDARY"
    assert_topic_preserved
    echo "PASS: a newline-named ignored descendant is refused"
    return 0
  fi
  # The name the file has, shell-quoted -- not the `"collision/lo\ncal.log"` Git would print.
  case "$refusal" in
  *"$(printf '%q' "$collision/$descendant")"*) ;;
  *) fail "the refusal did not name the descendant as it is spelled on disk: $refusal" ;;
  esac
  # And carries it escaped, not raw: the newline itself must never reach the operator's terminal,
  # where it would forge a second diagnostic line out of the tail of a pathname.
  case "$refusal" in
  *"$descendant"*) fail "the refusal printed the pathname's newline raw: $refusal" ;;
  esac
  assert_topic_preserved
  echo "PASS: a newline-named ignored descendant is refused and named as it is spelled"
}

test_missing_branch_config() {
  setup_case missing-branch-config merge main-off
  git -C "$CASE_MAIN" config --remove-section branch.topic
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: absent branch configuration is a normal cleanup state"
}

test_inherited_branch_config() {
  local included_config
  setup_case inherited-branch-config merge main-off
  included_config="$CASE_ROOT/included-branch-config"
  git -C "$CASE_MAIN" config --remove-section branch.topic
  printf '%s\n' \
    '[branch "topic"]' \
    '  remote = inherited-origin' \
    '  merge = refs/heads/topic' >"$included_config"
  git -C "$CASE_MAIN" config --local include.path "$included_config"

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" config --get branch.topic.remote)" inherited-origin \
    "inherited branch policy must be ignored rather than treated as editable local residue"
  echo "PASS: inherited branch configuration is deliberately left alone"
}

test_dotted_branch_config() {
  setup_case dotted-branch-config merge main-off
  git -C "$CASE_MAIN" config --remove-section branch.topic
  git -C "$CASE_MAIN" config branch.topic.child.remote child-origin
  git -C "$CASE_MAIN" config branch.topic.child.merge refs/heads/topic.child

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" config --local --no-includes \
    --get branch.topic.child.remote)" child-origin \
    "dotted child branch configuration must not be mistaken for topic configuration"
  echo "PASS: dotted child branch configuration remains distinct"
}

test_custom_branch_config() {
  setup_case custom-branch-config merge main-off
  git -C "$CASE_MAIN" config branch.topic.cleanupNote retain-me

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  assert_eq "$(git -C "$CASE_MAIN" config --local --no-includes \
    --get branch.topic.cleanupNote)" retain-me \
    "custom repository-local branch configuration must survive upstream cleanup"
  echo "PASS: custom branch configuration is preserved"
}

test_merge_options_cleanup() {
  setup_case merge-options-cleanup merge main-off
  git -C "$CASE_MAIN" config branch.topic.mergeOptions --no-edit

  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned
  echo "PASS: standard branch mergeOptions configuration is removed"
}

# --- cases pinned from the helper's fix history (ludics-lite#403) ------------------------------
# The v2 rewrite ports this helper to Python behind its command line. Each case below pins, from
# outside, a lesson a past round encoded in the helper's code that no case above asserted, so the
# port cannot drop it quietly.

# The option table (ludics-lite#332, after #302's `--force-integrated` listed bare over a valued
# arm): one declaration drives the printed listing and the parser, and check-prompts reads the
# PRINTED listing. So the text is pinned verbatim, every usage error is exit 2 with that text and
# nothing on stdout, an option is matched in exactly its listed spelling, a valued option's value
# may not be missing or empty, and the last occurrence wins. A usage error touches no repository.
test_usage_and_option_errors() {
  local expected local_master out rc
  setup_case usage-and-option-errors merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  expected=$(cat <<'USAGE_TEXT'
usage: post-merge-cleanup.sh <main-checkout> <session-worktree> <branch> [options]

Options:
  --base <branch>       Base branch to refresh and verify (default: master)
  --force-integrated <reason>
                        Why this squash/rebase merge is confirmed
  --regenerable <name>  A top-level directory of the session worktree that cleanup may
                        REMOVE rather than refuse over or archive, such as a build tree.
                        Repeatable, no default; the name must be one untracked directory
                        of the worktree root and is never followed through a symlink.

The ordinary path requires the topic branch to be an ancestor of origin/<base>. Use
--force-integrated only after independently confirming a squash or rebase merge; its
non-empty reason is printed in the cleanup record.
USAGE_TEXT
)
  # usage_error <description> <args...>: exit 2, the usage text on stderr, nothing on stdout.
  usage_error() {
    local what="$1" err="$CASE_ROOT/usage.err" stdout
    shift
    rc=0
    stdout=$("$HELPER" "$@" 2>"$err") || rc=$?
    assert_eq "$rc" 2 "$what must be a usage error"
    assert_eq "$stdout" "" "$what must print nothing on stdout"
    assert_eq "$(cat "$err")" "$expected" "$what must print the usage text"
  }
  usage_error "no arguments"
  usage_error "one argument" "$CASE_MAIN"
  usage_error "two arguments" "$CASE_MAIN" "$CASE_SESSION"
  usage_error "an unknown option" "$CASE_MAIN" "$CASE_SESSION" topic --keep-branch
  usage_error "an option in another spelling" "$CASE_MAIN" "$CASE_SESSION" topic --base=master
  usage_error "a stray positional argument" "$CASE_MAIN" "$CASE_SESSION" topic extra
  usage_error "--base without a value" "$CASE_MAIN" "$CASE_SESSION" topic --base
  usage_error "an empty --base" "$CASE_MAIN" "$CASE_SESSION" topic --base ''
  usage_error "--force-integrated without a value" "$CASE_MAIN" "$CASE_SESSION" topic --force-integrated
  usage_error "an empty --force-integrated" "$CASE_MAIN" "$CASE_SESSION" topic --force-integrated ''
  # A valued option takes the next word whatever it looks like (#302): here an option-shaped
  # reason, after which the stray word is what refuses.
  usage_error "a word after a consumed option-shaped value" \
    "$CASE_MAIN" "$CASE_SESSION" topic --force-integrated --base stray
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "a usage error must not advance the base"
  assert_topic_preserved

  # The last occurrence of a valued option wins: a base that does not exist, then the real one.
  out=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic --base no-such-base --base master)
  assert_cleaned
  case "$out" in
  "post-merge-cleanup.sh: cleaned topic and unregistered "*) ;;
  *) fail "the last --base did not win: $out" ;;
  esac
  echo "PASS: usage text, usage errors (exit 2, no repository touched), last occurrence wins"
}

# What a successful run reports, which the skill reads: one stdout line naming the session, its
# archive and both recovery refs; the --force-integrated reason on stderr as the cleanup record
# (the usage text promises it); and, for an already-absent remote topic, that no deletion was sent.
test_success_reports_its_record() {
  local err out
  setup_case success-record squash main-off
  err="$CASE_ROOT/success.err"
  out=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic \
    --force-integrated "confirmed squash merge" 2>"$err") ||
    { tail -n 40 "$err" >&2; fail "the --force-integrated cleanup failed (stderr tail above)"; }
  assert_cleaned
  assert_eq "$out" "post-merge-cleanup.sh: cleaned topic and unregistered $CASE_SESSION; session archived at $CASE_ARCHIVE/worktree; recovery retained at refs/ship-pr/recovery/topic/$CASE_TOPIC_OID and refs/ship-pr/session-recovery/topic/$CASE_TOPIC_OID" \
    "the success line must name the session, its archive and both recovery refs"
  grep -Fx "post-merge-cleanup.sh: FORCE-INTEGRATED override: confirmed squash merge" "$err" >/dev/null ||
    fail "the --force-integrated reason was not recorded on stderr: $(cat "$err")"

  setup_case success-record-absent-remote merge main-off
  git -C "$CASE_MAIN" push --no-verify origin :refs/heads/topic >/dev/null 2>&1
  err="$CASE_ROOT/success.err"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null 2>"$err" ||
    { tail -n 40 "$err" >&2; fail "cleanup of an already-absent remote topic failed (stderr tail above)"; }
  assert_cleaned
  grep -Fx "post-merge-cleanup.sh: origin/topic was already absent (no deletion sent)" "$err" >/dev/null ||
    fail "an already-absent remote topic was not reported: $(cat "$err")"
  ! grep -F "FORCE-INTEGRATED" "$err" >/dev/null || fail "an ordinary cleanup claimed an override"
  echo "PASS: a successful cleanup reports its record"
}

# Review round 2 of #287: the finishing command a refusal prints names the validated push URL with
# any http(s) userinfo removed, so no credential reaches the diagnostic, and the endpoint stays the
# one the helper validated rather than the remote's name. The fixture's origin is an https URL
# with a password; a fake git rewrites it to the case's bare repository through `insteadOf` for
# every call but `remote get-url`, which expands `insteadOf` itself and would otherwise report
# the local path. The pre-push hook refuses, which is the refusal that prints the command.
test_finish_command_strips_url_credentials() {
  local cred_url fake_bin finish hook log real_git
  setup_case finish-url-credentials merge main-off
  cred_url="https://ship-pr:s3cret@example.invalid/remote.git"
  git -C "$CASE_MAIN" remote set-url origin "$cred_url"
  real_git=$(command -v git)
  fake_bin="$CASE_ROOT/bin"
  log="$CASE_ROOT/cleanup.log"
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case " $* " in' \
    '*" remote get-url "*) exec "$REAL_GIT" "$@" ;;' \
    'esac' \
    'exec "$REAL_GIT" -c "url.$CRED_REMOTE.insteadOf=$CRED_URL" "$@"' >"$fake_bin/git"
  chmod +x "$fake_bin/git"
  hook="$CASE_MAIN/.git/hooks/pre-push"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$hook"
  chmod +x "$hook"

  if PATH="$fake_bin:$PATH" REAL_GIT="$real_git" CRED_REMOTE="$CASE_REMOTE" CRED_URL="$cred_url" \
    "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >"$log" 2>&1; then
    fail "a refused remote deletion was reported as a cleanup"
  fi
  grep "was refused while it was still at the validated tip $CASE_TOPIC_OID" "$log" >/dev/null ||
    { cat "$log" >&2; fail "the refusal was not the refused leased deletion"; }
  finish=$(sed -n 's/.*, finish with: //p' "$log")
  assert_eq "$finish" "git -C $(printf '%q' "$CASE_MAIN") push --force-with-lease=refs/heads/topic:$CASE_TOPIC_OID https://example.invalid/remote.git :refs/heads/topic" \
    "the finishing command must name the push URL without its userinfo"
  ! grep -F "s3cret" "$log" >/dev/null || { cat "$log" >&2; fail "a credential reached the diagnostics"; }
  echo "PASS: the finishing command strips http(s) userinfo from the validated push URL"
}

# Review rounds 2 and 7: the branch read and its deletion go through ONE push endpoint, so an
# origin with several push URLs is refused as ambiguous before anything changes.
test_multiple_push_endpoints_refusal() {
  local local_master refusal second
  setup_case multiple-push-endpoints merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  second="$CASE_ROOT/second.git"
  git clone --bare "$CASE_REMOTE" "$second" >/dev/null 2>&1
  git -C "$CASE_MAIN" remote set-url --add --push origin "$CASE_REMOTE"
  git -C "$CASE_MAIN" remote set-url --add --push origin "$second"
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "an origin with two push endpoints was accepted"
  fi
  case "$refusal" in
  *"origin has multiple push endpoints; refusing ambiguous branch deletion"*) ;;
  *) fail "the ambiguous push endpoints were not named: $refusal" ;;
  esac
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "the endpoint refusal must precede the base fast-forward"
  assert_topic_preserved
  echo "PASS: several push endpoints are refused as ambiguous"
}

# The identity checks the first rounds added, each refused before anything changes: the branch
# name's syntax, the base branch itself, a branch that does not exist, a session attached to
# another branch or detached off the tip, and the two checkout arguments' shapes (round 3's
# worktree root, round 1's canonical paths, the primary-checkout and same-repository rules).
test_identity_refusals() {
  local local_master refusal
  setup_case identity-refusals merge main-off
  local_master=$(git -C "$CASE_MAIN" rev-parse refs/heads/master)
  git -C "$CASE_MAIN" branch other refs/heads/topic
  # refused <expected text> <args...>: the helper refuses with exit 1 and names the problem.
  identity_refused() {
    local expected="$1" rc=0
    shift
    refusal=$("$HELPER" "$@" 2>&1) || rc=$?
    assert_eq "$rc" 1 "a refusal ($expected) must exit 1"
    case "$refusal" in
    *"$expected"*) ;;
    *) fail "the refusal did not say '$expected': $refusal" ;;
    esac
  }
  identity_refused "invalid branch name: bad..name" "$CASE_MAIN" "$CASE_SESSION" bad..name
  identity_refused "refusing to clean up the base branch master" "$CASE_MAIN" "$CASE_SESSION" master
  identity_refused "local branch does not exist: absent" "$CASE_MAIN" "$CASE_SESSION" absent
  identity_refused "session worktree owns topic, not other" "$CASE_MAIN" "$CASE_SESSION" other
  identity_refused "main checkout is not a git worktree: $CASE_ROOT" "$CASE_ROOT" "$CASE_SESSION" topic
  identity_refused "session path is not a git worktree: $CASE_ROOT" "$CASE_MAIN" "$CASE_ROOT" topic
  identity_refused "main-checkout is a linked worktree, not the primary checkout: $CASE_SESSION" \
    "$CASE_SESSION" "$CASE_MAIN" topic
  identity_refused "main checkout and session worktree must be different paths" "$CASE_MAIN" "$CASE_MAIN" topic
  identity_refused "main checkout and session worktree belong to different repositories" \
    "$CASE_MAIN" "$CASE_INTEGRATOR" topic
  git -C "$CASE_SESSION" checkout --quiet --detach HEAD~1
  identity_refused "detached session HEAD is not the tip of topic" "$CASE_MAIN" "$CASE_SESSION" topic
  git -C "$CASE_SESSION" checkout --quiet topic
  git -C "$CASE_MAIN" branch -D other >/dev/null
  assert_eq "$(git -C "$CASE_MAIN" rev-parse refs/heads/master)" "$local_master" \
    "an identity refusal must precede the base fast-forward"
  assert_topic_preserved
  echo "PASS: identity refusals precede every mutation"
}

# Round 11 retains the validated tip under refs/ship-pr/recovery/<branch>/<oid>. A retry after an
# interrupted cleanup finds that ref already there and accepts it; a ref of that name pointing
# anywhere else is refused, before the topic is touched.
test_preexisting_recovery_ref() {
  local refusal
  setup_case preexisting-recovery-ref merge main-off
  git -C "$CASE_MAIN" update-ref "refs/ship-pr/recovery/topic/$CASE_TOPIC_OID" "$CASE_TOPIC_OID"
  "$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic >/dev/null
  assert_cleaned

  setup_case unexpected-recovery-ref merge main-off
  git -C "$CASE_MAIN" update-ref "refs/ship-pr/recovery/topic/$CASE_TOPIC_OID" refs/heads/master
  if refusal=$("$HELPER" "$CASE_MAIN" "$CASE_SESSION" topic 2>&1); then
    fail "a recovery ref pointing at another object was accepted"
  fi
  case "$refusal" in
  *"recovery ref points at an unexpected object: refs/ship-pr/recovery/topic/$CASE_TOPIC_OID"*) ;;
  *) fail "the unexpected recovery ref was not named: $refusal" ;;
  esac
  assert_topic_preserved
  echo "PASS: an existing recovery ref is reused at the validated tip and refused elsewhere"
}

# --- runner self-cases (ludics-lite#9) -------------------------------------------------------
# The runner's own behaviors used to be verified by hand from patched scratch copies, repeated by
# nothing in CI. These point the runner at itself: a scratch COPY of this script and the helper,
# patched with sed the way the hand checks were, run with -j 1 inside so the nested runner's job
# control never overlaps this one's. Each asserts on the copy's exit status, its summary line, and
# the absence of the copy's own scratch root — never on this runner's state.

RUNNER="$SCRIPT_DIR/test-post-merge-cleanup.sh"
SELF_CASE=test_missing_branch_config # an ordinary quick case: one repository, one helper call
# The deadline a runner self-case gives its inner run of SELF_CASE when the case under test is
# NOT the deadline itself: generous, because the inner case does real git work and the shared
# macOS runner runs three of these copies beside the rest of the suite. At 5 s the inner case
# timed out under load and the self-case then read the timeout's wording instead of the report it
# was checking for -- red on main and on unrelated PRs (ludics-lite#68). Only the case that pins
# the deadline firing keeps a short one.
SELF_CASE_TIMEOUT=60

# copy_runner <dir> <root-tag>: a scratch copy of the runner and the helper, its scratch root
# template renamed so the copy's tree can be told from this run's and asserted gone afterwards.
# <dir> is the copy's `ship-pr/scripts` (COPY_DIR below): the helper is the command line, and what
# serves it may live elsewhere in the checkout -- since the v2 rewrite (ludics-lite#403) the helper
# is a forwarder to `scripts/py` and the package under `lib/` -- so the copy sits in a mirror of the
# checkout's layout, with copies of both beside it. Copies, not links: a rewrite of a copy must
# never reach this checkout's files, and Git Bash makes a directory link only with privileges.
COPY_DIR=copy/ship-pr/scripts
copy_runner() {
  local dir="$1" tag="$2" mirror checkout
  mkdir -p "$dir"
  mirror=$(CDPATH= cd "$dir/../.." && pwd -P) || fail "could not resolve the copy's checkout mirror"
  checkout=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd -P) || fail "could not resolve this checkout"
  rm -rf "$mirror/scripts" "$mirror/lib"
  mkdir -p "$mirror/scripts"
  cp "$checkout/scripts/py" "$mirror/scripts/py" || fail "could not copy scripts/py into the mirror"
  cp -R "$checkout/lib" "$mirror/lib" || fail "could not copy lib/ into the mirror"
  sed "s|/tmp/post-merge-cleanup-test\.XXXXXX|/tmp/post-merge-cleanup-test.$tag.XXXXXX|" "$RUNNER" \
    >"$dir/test-post-merge-cleanup.sh"
  grep -q "post-merge-cleanup-test\.$tag\.XXXXXX" "$dir/test-post-merge-cleanup.sh" ||
    fail "could not retarget the copy's scratch root"
  cp "$HELPER" "$dir/post-merge-cleanup.sh"
  chmod +x "$dir/test-post-merge-cleanup.sh" "$dir/post-merge-cleanup.sh"
}

# run_copy <command...>: run a scratch copy without this run's knobs. SHIP_PR_TEST_LOG_DIR in
# particular must not reach it: the copy would write its status files beside this runner's, and
# reap_one would read a copy's verdict as one of ours.
run_copy() {
  env -u SHIP_PR_TEST_LOG_DIR -u SHIP_PR_TEST_CASE_TIMEOUT -u SHIP_PR_TEST_JOBS "$@"
}

# assert_copy_root_gone <root-tag>: the copy removed its scratch root on every exit path.
assert_copy_root_gone() {
  local root
  for root in /tmp/post-merge-cleanup-test."$1".*; do
    [ ! -e "$root" ] || fail "the copy left its scratch root behind: $root"
  done
}

# rewrite_in_place <file>: rewrite the file through its existing inode — truncate, then write —
# as an editor or tool that saves in place does to a running script. The new text is the old
# with padding inserted after the shebang, sized so that the byte offset where the runner will
# next read the file (right after the `done` of its final wait loop: bash discards its read
# buffer at every fork and resumes from the file offset) now holds three lines that print a
# marker and exit 99. A shell that re-reads the file lands on them; one that parsed the whole
# group before running never looks. Unguarded, the same rewrite with plain comment padding once
# resumed at a harmless spot and reprinted a case's PASS line, so the landing is aimed, not left
# to where the shift happens to fall.
#
# rewrite_in_place <file> [<anchor line>]: the resume point is the byte after the last line that
# is exactly <anchor line>, `done` by default. The helper's copy is aimed at its guard's own
# `exit "$?"`, which every guarded file carries: what the helper's body holds -- a whole cleanup in
# shell, or a forwarder of a few lines -- is not this case's business, only that bash read it whole.
rewrite_in_place() {
  local file="$1" anchor="${2:-done}" first_line resume_at pad i=0 rewritten
  first_line=$(head -n 1 "$file")
  resume_at=$(grep -bxF -- "$anchor" "$file" | tail -n 1 | cut -d: -f1) || resume_at=""
  [ -n "$resume_at" ] || fail "no '$anchor' line to aim the rewrite at in $file"
  resume_at=$((resume_at + ${#anchor} + 1))
  pad=$((resume_at - ${#first_line} - 1))
  [ "$pad" -ge 0 ] || fail "the resume point precedes the shebang in $file"
  rewritten=$(
    printf '%s\n' "$first_line"
    awk -v n="$pad" 'BEGIN {
      while (n >= 80) { printf "%-79s\n", "#"; n -= 80 }
      if (n == 1) printf "\n"
      else if (n > 1) { printf "#"; for (i = 2; i < n; i++) printf "#"; printf "\n" }
    }'
    while [ "$i" -lt 3 ]; do
      echo 'echo "REWRITE_RESUMED: the shell re-read this file at line $LINENO" >&2; exit 99'
      i=$((i + 1))
    done
    tail -n +2 "$file"
  )
  printf '%s\n' "$rewritten" >"$file"
}

# unguard <file>: strip the brace group (ludics-lite#10) from a copy — the first line that is
# exactly `{`, and the closing `exit "$?"` and `}` — leaving a plain top-level script.
unguard() {
  local file="$1" stripped
  [ "$(tail -n 2 "$file")" = "$(printf 'exit "$?"\n}')" ] || fail "the copy does not end in the guard's exit and brace"
  stripped=$(awk 'BEGIN { opened = 0 } { if (!opened && $0 == "{") { opened = 1; next } print }' "$file" | sed '$d' | sed '$d')
  printf '%s\n' "$stripped" >"$file"
}

# gate_helper <copy-dir> <started-file> <go-file>: make the copy's helper announce that it has
# started and hold, inside its brace group, until told to go. While it holds, the case that ran
# it and the copy's runner are all mid-run, so the rewrite below lands on three live readers of
# the two files whatever the box's speed (on a fast runner an ungated case finished in a second,
# before a fixed delay's rewrite, and the negative control had nothing to catch; gating the case
# instead left the helper to start fresh from the rewritten file and exit on the marker).
gate_helper() {
  local copy="$1" started="$2" go="$3" gated
  gated=$(awk -v hold="touch '$started'; while [ ! -e '$go' ]; do sleep 0.1; done" \
    'BEGIN { opened = 0 } { print; if (!opened && $0 == "{") { opened = 1; print hold } }' "$copy/post-merge-cleanup.sh")
  printf '%s\n' "$gated" >"$copy/post-merge-cleanup.sh"
  grep -q "^touch '$started'; while" "$copy/post-merge-cleanup.sh" || fail "could not gate the copy's helper"
}

# run_copy_rewritten <copy-dir> <out-file> <rewrite-helper-too>: run the copy on SELF_CASE,
# rewrite its script(s) in place once the case has the gated helper running, then let the helper
# finish. Prints the copy's exit status.
run_copy_rewritten() {
  local copy="$1" out="$2" helper_too="$3" started="$copy.started" go="$copy.go" pid rc tries=0
  rm -f "$started" "$go"
  gate_helper "$copy" "$started" "$go"
  run_copy "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null &
  pid=$!
  while [ ! -e "$started" ]; do
    [ "$tries" -lt 600 ] || { kill_case_group "$pid" 2>/dev/null; fail "the copy's helper did not start within 60s: $(cat "$out")"; }
    sleep 0.1
    tries=$((tries + 1))
  done
  rewrite_in_place "$copy/test-post-merge-cleanup.sh"
  [ "$helper_too" -eq 0 ] || rewrite_in_place "$copy/post-merge-cleanup.sh" 'exit "$?"'
  touch "$go"
  if wait "$pid"; then rc=0; else rc=$?; fi
  echo "$rc"
}

test_runner_survives_midrun_rewrite() {
  # Candidate (7) of ludics-lite#9, grounded in ludics-lite#10: bash reads a script by offset
  # while it runs, so an in-place rewrite of the runner or the helper mid-run resumed the shell at
  # a shifted offset (once: skipping the final wait loop and removing the root under live cases).
  # Both scripts are one brace group parsed whole before its first command. The guarded copies
  # are rewritten while a case has the helper mid-run and must still end with the ordinary
  # summary; the negative control — the same rewrite of a runner copy with the group stripped —
  # must not, which is what makes this a regression test rather than a tautology. A command
  # appended past the guarded copy's closing brace must never run either.
  local tag="rw$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" rc
  copy_runner "$copy" "$tag-guarded"
  echo 'echo SHOULD_NOT_RUN' >>"$copy/test-post-merge-cleanup.sh"
  rc=$(run_copy_rewritten "$copy" "$out" 1)
  [ "$rc" -eq 0 ] || fail "the guarded copy exited $rc after a mid-run rewrite: $(cat "$out")"
  grep -q '^PASS: 1 selected post-merge cleanup states' "$out" ||
    fail "the guarded copy printed no summary after a mid-run rewrite: $(cat "$out")"
  ! grep -q SHOULD_NOT_RUN "$out" || fail "a command appended past the closing brace ran: $(cat "$out")"
  ! grep -q '^REWRITE_RESUMED' "$out" || fail "the guarded copy re-read its file after the rewrite: $(cat "$out")"
  assert_copy_root_gone "$tag-guarded"

  rm -rf "$copy"
  copy_runner "$copy" "$tag-unguarded"
  unguard "$copy/test-post-merge-cleanup.sh"
  rc=$(run_copy_rewritten "$copy" "$out" 0)
  [ "$rc" -eq 99 ] && grep -q '^REWRITE_RESUMED' "$out" ||
    fail "negative control: a copy without the brace group did not resume at the rewritten offset (exit $rc), so the guard is not what this case tests: $(cat "$out")"
  # The resumed shell exits through its EXIT trap, which removes the copy's root; nothing of the
  # run may outlive this case either way.
  sleep 1
  rm -rf /tmp/post-merge-cleanup-test."$tag-unguarded".*
  echo "PASS: an in-place rewrite of the runner and the helper mid-run does not corrupt the run; without the guard it resumes at the rewritten offset"
}

test_runner_kills_a_case_past_its_deadline() {
  # ludics-lite#14: a case that stalls (one sat silent for six hours of macOS CI) is killed with
  # its whole process group at SHIP_PR_TEST_CASE_TIMEOUT, reported as a failure naming the
  # deadline together with its log, and the run still ends with its root removed.
  # The stall is a descendant that ignores TERM under a case shell that dies on it: the leader
  # vanishes at the first signal, and only a runner that watches the whole group escalates to
  # KILL for what is left. The descendant writes its own pid before it execs, and the case reads
  # that pid with pid_alive, the way the runner reads its groups, not with pgrep: Git for Windows
  # ships no pgrep, where the check passed while checking nothing (ludics-lite#337).
  local tag="dl$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" rc marker patched
  local pidfile="$copy/stall.pid" stall_pid tries=0
  marker="sh -c 'trap \"\" TERM; echo \$\$ >\"$pidfile\"; exec sleep 3571'"
  copy_runner "$copy" "$tag"
  patched=$(sed "s|^$SELF_CASE() {\$|$SELF_CASE() { $marker;|" "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  grep -qF -- "$SELF_CASE() { $marker;" "$copy/test-post-merge-cleanup.sh" || fail "could not plant the stall in the copy"
  if run_copy env SHIP_PR_TEST_CASE_TIMEOUT=2 "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] || fail "the copy exited $rc with a stalled case, expected 1: $(cat "$out")"
  grep -q "timed out after 2s (SHIP_PR_TEST_CASE_TIMEOUT); its process group was killed" "$out" ||
    fail "the stalled case was not reported against its deadline: $(cat "$out")"
  grep -q "^FAIL: 1 of 1 post-merge cleanup states failed" "$out" || fail "no failing summary: $(cat "$out")"
  [ -s "$pidfile" ] || fail "the planted descendant never wrote its pid, so nothing here checks it: $(cat "$out")"
  stall_pid=$(cat "$pidfile")
  # A settle, not a deadline: a descendant the runner never escalated to sleeps for an hour. The
  # case only reads the pid and never signals it, since by now the pid may name another process.
  while pid_alive "$stall_pid"; do
    [ "$tries" -lt 20 ] ||
      fail "the TERM-ignoring descendant (pid $stall_pid) survived the deadline: the runner stopped escalating at the leader"
    sleep 0.1
    tries=$((tries + 1))
  done
  assert_copy_root_gone "$tag"
  echo "PASS: a case past its deadline is killed with its process group and reported"
}

test_runner_names_a_setup_case_failure() {
  # Candidate (1) of ludics-lite#9: setup_case has its own local `name`, so the status trap must
  # have captured its destination before that scope exists. Force setup_case to fail after the
  # local is declared; the copy must promptly report the selected function's name and ordinary
  # exit status, not wait on a status file named after setup_case's scratch slug.
  local tag="setup$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" patched rc
  copy_runner "$copy" "$tag"
  patched=$(awk '{
    print
    if ($0 == "  local name=\"$1\" merge_mode=\"$2\" owner_mode=\"$3\" base_branch=\"${4:-master}\"")
      print "  false # runner self-case: fail inside setup_case after its local name is live"
  }' "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  grep -q '^  false # runner self-case: fail inside setup_case' "$copy/test-post-merge-cleanup.sh" ||
    fail "could not plant a failure inside the copy's setup_case"

  if run_copy env SHIP_PR_TEST_CASE_TIMEOUT="$SELF_CASE_TIMEOUT" "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] || fail "the copy exited $rc after setup_case failed, expected 1: $(cat "$out")"
  grep -Fqx "===== FAIL: $SELF_CASE (exit 1) =====" "$out" ||
    fail "the setup_case failure was not reported under the selected case name: $(cat "$out")"
  grep -q "^FAIL: 1 of 1 post-merge cleanup states failed.*: $SELF_CASE$" "$out" ||
    fail "the setup_case failure printed no right-named summary: $(cat "$out")"
  assert_copy_root_gone "$tag"
  echo "PASS: a failure inside setup_case fails the right-named case without hanging"
}

test_runner_names_an_errexit_death() {
  # ludics-lite#649: a case that set -e ends is reported with its command and line, and only that
  # one. Each copy's selected case first fails a command in each shape report_errexit must keep
  # quiet -- under if, ||, &&, !, inside a function called from an if, inside a command
  # substitution whose capture is then checked, and a pipeline that only pipefail fails, under
  # set +e, whose PIPESTATUS is then checked (bash 3.2 resets it to the trap's own status if the
  # trap runs a command) -- and then dies on an unguarded command inside a block whose stderr goes
  # to a file, as the helper's output did on 2026-10-15: a plain command in one copy, and in the
  # other a pipeline whose failed component is not its last, which the report must say. Exactly
  # one ERREXIT line may appear, naming the death, its function and its line in the copy (bash >=
  # 4; bash 3.2, which gives a trap no usable line, says so instead). The copy runs on the `bash`
  # PATH finds, through its shebang, so that bash's version decides the form; it runs without
  # BASHOPTS and POSIXLY_CORRECT, whose inherit_errexit would keep errexit in the substitution
  # (a real death there, which report_errexit would rightly report, but not this case's shape).
  local tag="errexit$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" version where
  local missing='test -e /nonexistent/runner-self-case-errexit'
  version=$(run_copy bash -c 'printf "%s %s" "${BASH_VERSINFO[0]}" "$BASH_VERSION"') ||
    fail "could not read the version of the bash the copy runs on"
  errexit_copy() { # <death line> <the death as the report names it>
    local death="$1" named="$2" patched rc line
    rm -rf "$copy"
    copy_runner "$copy" "$tag"
    patched=$(awk -v target="$SELF_CASE() {" -v death="$death" '{
      print
      if ($0 == target) {
        print "  runner_self_guarded() { false; }"
        print "  if false; then :; fi"
        print "  false || :"
        print "  false && :"
        print "  ! false"
        print "  if runner_self_guarded; then :; fi"
        print "  runner_self_capture=$(false; echo captured)"
        print "  [ \"$runner_self_capture\" = captured ] || fail \"a substitution capture changed: $runner_self_capture\""
        print "  set +e; false | true; runner_self_statuses=\"${PIPESTATUS[*]}\"; set -e"
        print "  [ \"$runner_self_statuses\" = \"1 0\" ] || fail \"the ERR trap reset PIPESTATUS under set +e: $runner_self_statuses\""
        print "  {"
        print "    " death
        print "  } 2>\"$TEST_ROOT/runner-self-case.err\""
      }
    }' "$copy/test-post-merge-cleanup.sh")
    printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
    line=$(grep -nxF -- "    $death" "$copy/test-post-merge-cleanup.sh" | cut -d: -f1)
    [ -n "$line" ] || fail "could not plant the errexit death in the copy: $death"
    if [ "${version%% *}" -ge 4 ]; then
      where="line $line"
    else
      where="bash ${version#* } gives a trap no line inside a function"
    fi
    if run_copy env -u BASHOPTS -u POSIXLY_CORRECT SHIP_PR_TEST_CASE_TIMEOUT="$SELF_CASE_TIMEOUT" \
      "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null; then
      rc=0
    else
      rc=$?
    fi
    [ "$rc" -eq 1 ] || fail "the copy exited $rc after its case died under set -e at '$death', expected 1: $(cat "$out")"
    grep -Fqx "===== FAIL: $SELF_CASE (exit 1) =====" "$out" ||
      fail "the errexit death at '$death' was not reported under the selected case name: $(cat "$out")"
    grep -Fqx "ERREXIT: set -e ended this shell of the case at $named (exit 1) in $SELF_CASE, $where" "$out" ||
      fail "the errexit death did not name $named, its function and $where: $(cat "$out")"
    [ "$(grep -c '^ERREXIT: ' "$out")" -eq 1 ] ||
      fail "a guarded failure was reported as an errexit death: $(cat "$out")"
    assert_copy_root_gone "$tag"
  }
  errexit_copy "$missing" "\`$missing\`"
  errexit_copy "$missing | true" "the pipeline ending in \`true\` (statuses 1 0)"
  echo "PASS: a case that set -e ends names its command (a pipeline by its statuses) and line, and guarded failures stay quiet"
}

test_runner_reaps_a_statusless_case() {
  # Candidate (2) of ludics-lite#9: a case shell may exit without running its status trap. Remove
  # the trap from a copy; the scheduler must notice the gone or zombie child, reap it, and report
  # the missing status instead of polling forever or accepting the child's zero exit.
  local tag="statusless$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" patched rc
  copy_runner "$copy" "$tag"
  patched=$(awk '{
    if ($0 ~ /^  trap .*CASE_STATUS_FILE.* EXIT$/) {
      print "  : # runner self-case: deliberately omit the case status trap"
      next
    }
    print
  }' "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  grep -q '^  : # runner self-case: deliberately omit' "$copy/test-post-merge-cleanup.sh" ||
    fail "could not remove the copy's case status trap"

  if run_copy env SHIP_PR_TEST_CASE_TIMEOUT="$SELF_CASE_TIMEOUT" "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] || fail "the copy exited $rc without a case status, expected 1: $(cat "$out")"
  grep -q "^===== FAIL: $SELF_CASE .*the case exited 0 without reporting a status.*=====$" "$out" ||
    fail "the status-less case was not reported under its selected name: $(cat "$out")"
  grep -q "^FAIL: 1 of 1 post-merge cleanup states failed.*: $SELF_CASE$" "$out" ||
    fail "the status-less case printed no right-named summary: $(cat "$out")"
  assert_copy_root_gone "$tag"
  echo "PASS: a status-less case is reaped and reported instead of hanging"
}

test_runner_cleans_up_after_a_closed_pipe() {
  # Candidate (3) of ludics-lite#9: verbose output can lose its reader. Give the selected case a
  # log larger than a pipe buffer, read one line, and close the pipe. The copy must take SIGPIPE,
  # run its EXIT cleanup, and remove its scratch root. The inner runner stays at -j 1, matching
  # every runner self-case; its exit status, the one retained output line, and its root are the
  # only state this outer case inspects. Bash 3.2 reports the closed external writer as SIGPIPE
  # (141), while Bash 5 can surface the failed builtin write as 1; both are nonzero closed-pipe
  # exits, and the cleanup contract is the same.
  # The copy then runs a second time with SIGPIPE ignored, as the macOS CI runner starts it: there
  # no writer dies of the signal, and each sees EPIPE and exits with its own status, which is how
  # a -v path through BSD awk (exit 2) passed a local run and went red in CI (ludics-lite#338). A
  # signal ignored when a shell starts stays ignored in it, so the only closed-pipe exit there is 1.
  local tag="pipe$$" copy="$TEST_ROOT/$COPY_DIR" err="$TEST_ROOT/copy.err" out="$TEST_ROOT/copy.out" patched
  local copy_rc head_rc pipeline_statuses sigpipe
  copy_runner "$copy" "$tag"
  patched=$(awk -v target="$SELF_CASE() {" '{
    print
    if ($0 == target) {
      print "  echo RUNNER_CLOSED_PIPE_HEAD"
      print "  i=0; while [ \"$i\" -lt 20000 ]; do printf \"runner closed pipe payload %s\\n\" \"$i\"; i=$((i + 1)); done"
    }
  }' "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  grep -q '^  echo RUNNER_CLOSED_PIPE_HEAD$' "$copy/test-post-merge-cleanup.sh" ||
    fail "could not give the copy enough verbose output to close its pipe"

  for sigpipe in inherited ignored; do
    rm -f "$err" "$out"
    set +e
    # A plain `runner -v | head -1` pipes stdout only. Keep stderr separate too: macOS Bash's known
    # job-control diagnostic is written before the case redirections exist, but it is not output
    # whose reader closed and must not race the deterministic stdout payload for head's one line.
    {
      [ "$sigpipe" = inherited ] || trap '' PIPE
      run_copy "$copy/test-post-merge-cleanup.sh" -j 1 -v "$SELF_CASE"
    } 2>"$err" | head -n 1 >"$out"
    pipeline_statuses=("${PIPESTATUS[@]}")
    set -e
    copy_rc="${pipeline_statuses[0]}"
    head_rc="${pipeline_statuses[1]}"
    case "$sigpipe:$copy_rc" in
    inherited:1 | inherited:141 | ignored:1) ;;
    inherited:*) fail "the copy exited $copy_rc after its pipe closed, expected 1 or 141" ;;
    *) fail "with SIGPIPE ignored the copy exited $copy_rc after its pipe closed, expected 1: $(cat "$err")" ;;
    esac
    [ "$head_rc" -eq 0 ] || fail "head exited $head_rc while closing the copy's pipe (SIGPIPE $sigpipe)"
    grep -Fqx RUNNER_CLOSED_PIPE_HEAD "$out" ||
      fail "the closed-pipe run (SIGPIPE $sigpipe) did not yield its deterministic first line: $(cat "$out")"
    assert_copy_root_gone "$tag"
  done
  echo "PASS: -v piped to head -1 exits on the closed pipe and removes the scratch root, with SIGPIPE inherited and ignored"
}

test_runner_term_midrun_exits_130() {
  # Candidate (4) of ludics-lite#9: wait until the copied helper is running inside its brace group
  # (a fixed delay raced on fast CI), then TERM the runner. Its scheduler trap must leave the case
  # registered for EXIT cleanup, which terminates and reaps the group before removing the root.
  local tag="term$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out"
  local started go pid rc tries=0
  copy_runner "$copy" "$tag"
  started="$copy.started"
  go="$copy.go"
  gate_helper "$copy" "$started" "$go"
  # Start the external env directly: backgrounding run_copy would expose the PID of bash's
  # function subshell, so TERM would kill that wrapper with 143 instead of reaching the copied
  # runner and exercising its 130 trap path.
  env -u SHIP_PR_TEST_LOG_DIR -u SHIP_PR_TEST_CASE_TIMEOUT -u SHIP_PR_TEST_JOBS \
    "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null &
  pid=$!
  while [ ! -e "$started" ]; do
    kill -0 "$pid" 2>/dev/null || fail "the copy exited before its helper announced itself: $(cat "$out")"
    [ "$tries" -lt 600 ] || { kill_case_group "$pid" 2>/dev/null; fail "the copy's helper did not start within 60s: $(cat "$out")"; }
    sleep 0.1
    tries=$((tries + 1))
  done
  kill -TERM "$pid" || fail "could not send TERM to the copied runner"
  if wait "$pid"; then rc=0; else rc=$?; fi
  [ "$rc" -eq 130 ] || fail "the copied runner exited $rc on TERM, expected 130: $(cat "$out")"
  grep -q '^FAIL: interrupted with 1 post-merge cleanup states still running$' "$out" ||
    fail "the TERM run printed no interrupted summary: $(cat "$out")"
  assert_copy_root_gone "$tag"
  echo "PASS: TERM mid-run exits 130 after reaping the case and removing the scratch root"
}

test_runner_refuses_bad_arguments() {
  # Candidate (5) of ludics-lite#9: every refused invocation exits 1 before any case starts and
  # names the problem, and --list spells the names the refusals are checked against.
  local out rc
  refused() { # <label> <expected message> <args...>
    local label="$1" want="$2"
    shift 2
    if out=$("$RUNNER" "$@" 2>&1 </dev/null); then rc=0; else rc=$?; fi
    [ "$rc" -eq 1 ] || fail "$label: exit $rc, expected 1: $out"
    case "$out" in *"$want"*) ;; *) fail "$label: expected '$want' in: $out" ;; esac
    case "$out" in *"PASS:"* | *"===== FAIL"*) fail "$label: a case ran before the refusal: $out" ;; esac
  }
  refused "an empty --jobs=" "must be a positive integer, got ''" --jobs= "$SELF_CASE"
  refused "-j 00" "must be a positive integer, got '00'" -j 00 "$SELF_CASE"
  refused "-j abc" "must be a positive integer, got 'abc'" -j abc "$SELF_CASE"
  refused "-j without a count" "needs a job count" "$SELF_CASE" -j
  refused "a duplicated name" "test name given more than once: $SELF_CASE" "$SELF_CASE" "$SELF_CASE"
  refused "an unknown name" "unknown test name: test_no_such_case" test_no_such_case
  refused "an unknown option" "unknown option: --bogus" --bogus
  if out=$(SHIP_PR_TEST_CASE_TIMEOUT=soon "$RUNNER" "$SELF_CASE" 2>&1 </dev/null); then rc=0; else rc=$?; fi
  [ "$rc" -eq 1 ] || fail "a bad deadline: exit $rc, expected 1: $out"
  case "$out" in
  *"SHIP_PR_TEST_CASE_TIMEOUT must be a number of seconds, 0, or off, got 'soon'"*) ;;
  *) fail "a bad deadline was not refused by name: $out" ;;
  esac
  out=$("$RUNNER" --list) || fail "--list exited nonzero"
  grep -qx "$SELF_CASE" <<<"$out" || fail "--list does not spell $SELF_CASE"
  grep -qx test_runner_refuses_bad_arguments <<<"$out" || fail "--list does not spell this case"
  echo "PASS: refused arguments exit 1 before any case starts"
}

test_runner_help_ignores_inherited_pids() {
  # Candidate (6) of ludics-lite#9: RUNNING_PIDS is declared before the EXIT trap is installed, so
  # an exit ahead of the runner (--help here) cannot signal whatever an inherited variable of that
  # name happens to list.
  local bystander out
  sleep 3573 &
  bystander=$!
  out=$(RUNNING_PIDS="$bystander" "$RUNNER" --help 2>&1) ||
    fail "--help exited nonzero with an inherited RUNNING_PIDS: $out"
  case "$out" in *"usage: test-post-merge-cleanup.sh"*) ;; *) fail "--help printed no usage: $out" ;; esac
  sleep 0.2
  kill -0 "$bystander" 2>/dev/null || fail "--help signalled the process an inherited RUNNING_PIDS named"
  kill "$bystander" 2>/dev/null || true
  wait "$bystander" 2>/dev/null || true
  echo "PASS: --help with an inherited RUNNING_PIDS signals nothing"
}

test_runner_counts_a_stated_boundary() {
  # ludics-lite#338: a case that states a platform boundary still passes, but its SKIP line is
  # printed under its name and the summary counts and names it, so the boundary is on the record.
  local tag="bd$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" patched rc
  copy_runner "$copy" "$tag"
  patched=$(sed "s|^$SELF_CASE() {\$|$SELF_CASE() { skip_boundary 'runner self-case boundary';|" "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  grep -qF -- "$SELF_CASE() { skip_boundary 'runner self-case boundary';" "$copy/test-post-merge-cleanup.sh" ||
    fail "could not plant a boundary in the copy"
  if run_copy env SHIP_PR_TEST_CASE_TIMEOUT="$SELF_CASE_TIMEOUT" "$copy/test-post-merge-cleanup.sh" -j 1 "$SELF_CASE" >"$out" 2>&1 </dev/null; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -eq 0 ] || fail "the copy exited $rc with a stated boundary, expected 0: $(cat "$out")"
  grep -Fqx "SKIP $SELF_CASE: runner self-case boundary" "$out" ||
    fail "the boundary was not printed under the case's name: $(cat "$out")"
  grep -q "^PASS: 1 selected post-merge cleanup states (.*); 1 of them stated a platform boundary (SKIP): $SELF_CASE\$" "$out" ||
    fail "the summary did not count the boundary: $(cat "$out")"
  assert_copy_root_gone "$tag"

  # Verbose, beside a failing case: the whole log still names its SKIP line, and the FAIL line
  # names the boundary case too, ahead of the failed cases it keeps last.
  patched=$(sed "s|^test_unchecked_out_master() {\$|test_unchecked_out_master() { fail 'runner self-case failure';|" "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  grep -qF -- "test_unchecked_out_master() { fail 'runner self-case failure';" "$copy/test-post-merge-cleanup.sh" ||
    fail "could not plant a failure in the copy"
  if run_copy env SHIP_PR_TEST_CASE_TIMEOUT="$SELF_CASE_TIMEOUT" "$copy/test-post-merge-cleanup.sh" -v -j 1 \
    "$SELF_CASE" test_unchecked_out_master >"$out" 2>&1 </dev/null; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -eq 1 ] || fail "the copy exited $rc with a failing case, expected 1: $(cat "$out")"
  grep -Fqx "SKIP $SELF_CASE: runner self-case boundary" "$out" ||
    fail "the verbose log did not name the boundary's case: $(cat "$out")"
  grep -q "^FAIL: 1 of 2 post-merge cleanup states failed in .*; of those that passed, 1 of them stated a platform boundary (SKIP): $SELF_CASE): test_unchecked_out_master\$" "$out" ||
    fail "the failing summary did not name the boundary case: $(cat "$out")"
  assert_copy_root_gone "$tag"
  echo "PASS: a stated boundary is printed under its case and counted in the summary, verbose or failing"
}

# ludics-lite#386: a `core.hooksPath` in the configuration the suite is run under sends Git past
# the race-injection hook a case writes to `.git/hooks`. It is planted here through each channel
# isolate_git_config closes -- the user's global file found through HOME, a GIT_CONFIG_GLOBAL file,
# a GIT_CONFIG_SYSTEM file, a GIT_CONFIG_COUNT pair, GIT_CONFIG_PARAMETERS -- and each is first
# shown to reach Git from where the suite is started. A copy of the runner then runs a race case
# under it, and the race must still fire: test_remote_master_lease's pre-push hook rewrites the
# remote base, and the case fails if the helper never saw it. The negative control strips the
# isolation from a copy: the same case under the HOME leg must then go red on the race it no
# longer ran, which is what makes the passing legs a test of the isolation and not of the case.
test_runner_isolates_ambient_git_config() {
  local tag="gc$$" copy="$TEST_ROOT/$COPY_DIR" out="$TEST_ROOT/copy.out" home="$TEST_ROOT/home"
  local hooks="$TEST_ROOT/ambient-hooks" planted="$TEST_ROOT/ambient.gitconfig" leg leg_env patched rc
  local race=test_remote_master_lease
  mkdir -p "$home" "$hooks"
  git config --file "$planted" core.hooksPath "$hooks"
  cp "$planted" "$home/.gitconfig"
  copy_runner "$copy" "$tag"
  for leg in home global system count parameters; do
    # The outer runner's own isolation is removed first, so the leg is what the copy inherits.
    leg_env=(env -u GIT_CONFIG_NOSYSTEM -u GIT_CONFIG_GLOBAL -u XDG_CONFIG_HOME)
    case "$leg" in
    home) leg_env+=(HOME="$home") ;;
    global) leg_env+=(GIT_CONFIG_GLOBAL="$planted") ;;
    system) leg_env+=(GIT_CONFIG_SYSTEM="$planted") ;;
    count) leg_env+=(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="$hooks") ;;
    parameters) leg_env+=(GIT_CONFIG_PARAMETERS="'core.hookspath'='$hooks'") ;;
    esac
    [ -n "$(cd "$TEST_ROOT" && "${leg_env[@]}" git config --get core.hooksPath)" ] ||
      fail "the planted core.hooksPath does not reach Git through the $leg leg, so the leg tests nothing"
    if run_copy "${leg_env[@]}" "$copy/test-post-merge-cleanup.sh" -j 1 "$race" >"$out" 2>&1 </dev/null; then
      rc=0
    else
      rc=$?
    fi
    [ "$rc" -eq 0 ] || fail "a core.hooksPath planted through the $leg leg reached the race case (exit $rc): $(cat "$out")"
  done
  assert_copy_root_gone "$tag"

  rm -rf "$copy"
  copy_runner "$copy" "$tag-open"
  patched=$(sed 's/^  isolate_git_config$/  :/' "$copy/test-post-merge-cleanup.sh")
  printf '%s\n' "$patched" >"$copy/test-post-merge-cleanup.sh"
  ! grep -q '^  isolate_git_config$' "$copy/test-post-merge-cleanup.sh" ||
    fail "could not strip the isolation from the copy"
  if run_copy env -u GIT_CONFIG_NOSYSTEM -u GIT_CONFIG_GLOBAL -u XDG_CONFIG_HOME HOME="$home" \
    "$copy/test-post-merge-cleanup.sh" -j 1 "$race" >"$out" 2>&1 </dev/null; then
    fail "negative control: without the isolation the race case passed under a global core.hooksPath, so the isolation is not what this case tests: $(cat "$out")"
  fi
  grep -qxF 'FAIL: topic deletion ignored a concurrent remote master rewrite' "$out" ||
    fail "negative control: the copy without the isolation failed, but not on the race it skipped: $(cat "$out")"
  assert_copy_root_gone "$tag-open"
  echo "PASS: a core.hooksPath planted through the global, system or environment configuration leaves a race fixture firing; without the isolation it does not"
}

TESTS=(
  test_unchecked_out_master
  test_master_owned_by_main
  test_master_owned_by_other_worktree
  test_main_base_support
  test_safe_topic_deletion
  test_squash_rebase_override
  test_newer_remote_tip_refusal
  test_ls_remote_failure_refusal
  test_invalid_path_refusal
  test_git_windows_drive_path_is_absolute
  test_git_local_environment_is_cleared
  test_non_files_ref_backend_refusal
  test_replacement_refs_disabled
  test_unrelated_upstream_deletion
  test_distinct_push_endpoint
  test_topic_tag_collision
  test_master_tag_collision
  test_excluded_master_fetch_refusal
  test_conditional_local_ref_deletion
  test_already_absent_remote_retry
  test_absent_remote_recreation_race
  test_absent_remote_tracking_ref_appears
  test_other_topic_owner_refusal
  test_dirty_session_refusal
  test_ignored_session_refusal
  test_session_harness_ignored_data_passes
  test_session_ignored_identical_to_base_passes
  test_session_ignored_differing_from_base_refusal
  test_session_ignored_symlink_refusal
  test_session_bare_claude_entry_refusal
  test_session_ignored_symlinked_base_ancestor_refusal
  test_session_ignored_quoted_path_passes
  test_session_ignored_directory_of_base_copies
  test_session_ignored_directory_unreadable_subtree_refusal
  test_regenerable_directory_clears_the_session_gate
  test_regenerable_refusals
  test_regenerable_name_resolution_refusals
  test_session_ignored_path_control_characters_are_escaped
  test_master_reservation
  test_unowned_master_reservation
  test_concurrent_master_edit_refusal
  test_concurrent_ignored_master_collision
  test_preexisting_ignored_master_data
  test_master_owner_harness_untracked_data_passes
  test_master_owner_untracked_data_refusal
  test_master_owner_switch_refusal
  test_master_initial_detach_compare_and_swap
  test_master_update_failure_reattaches_owner
  test_master_owner_without_head_reflog
  test_master_handoff_stays_reserved
  test_master_refresh_preserves_concurrent_ref
  test_master_reattach_compare_and_swap
  test_master_reattach_verifies_named_branch
  test_ignored_data_during_master_detach
  test_ignored_data_during_topic_detach
  test_ignored_data_during_topic_reattach
  test_attached_session_head_compare_and_swap
  test_detached_session_head_compare_and_swap
  test_initialized_session_submodule_refusal
  test_escape_named_session_submodule_refusal
  test_deinitialized_session_submodule_refusal
  test_session_module_gitdir_newline_name_refusal
  test_refusal_escaping_survives_xpg_echo
  test_initialized_master_submodule_refusal
  test_master_resolve_undo_refusal
  test_assume_unchanged_master_refusal
  test_skip_worktree_master_refusal
  test_sparse_master_owner
  test_sparse_hidden_deletion_refusal
  test_skip_worktree_deleted_master_refusal
  test_newline_worktree_paths
  test_master_active_operation_refusal
  test_master_index_lock_refusal
  test_master_changed_path_failure_refusal
  test_diverged_master_refusal
  test_locked_session_refusal
  test_active_session_operation_refusal
  test_active_session_bisect_refusal
  test_symbolic_session_pseudoref_refusal
  test_private_worktree_ref_refusal
  test_rewritten_worktree_ref_refusal
  test_session_pseudoref_recovery
  test_session_reflog_recovery
  test_session_index_recovery
  test_session_split_index_recovery
  test_session_resolve_undo_recovery
  test_worktree_config_archive
  test_commit_message_archive
  test_concurrent_commit_message_archive
  test_squash_message_archive
  test_tag_and_notes_messages_archive
  test_sparse_checkout_archive
  test_session_metadata_lock_preflight
  test_late_private_worktree_ref_recovery
  test_shared_private_namespace_roots_preserved
  test_private_namespace_locked_through_unregister
  test_late_active_session_operation_refusal
  test_late_session_module_refusal
  test_symbolic_ref_refusal
  test_remote_base_advance
  test_remote_base_rewrite_before_deletion
  test_remote_master_lease
  test_stale_master_response_retains_recovery
  test_symbolic_recovery_ref_refusal
  test_topic_reservation
  test_topic_reservation_failure_keeps_remote
  test_ignored_write_at_session_removal
  test_dangling_link_at_session_removal
  test_detached_session_head_recovery
  test_session_head_locked_through_unregister
  test_session_registration_locked_against_prune
  test_archive_preflight_refusal
  test_precreated_archive_target_refusal
  test_session_head_lock_preflight
  test_dangling_session_head_lock_preflight
  test_session_recovery_namespace_preflight
  test_dangling_config_lock_preflight
  test_divergent_tracking_tip_recovery
  test_tracking_tip_move_refusal
  test_tracking_reflog_recovery
  test_tracking_reflog_locked_through_deletion
  test_topic_reflog_recovery
  test_topic_reflog_locked_through_deletion
  test_final_topic_lease_keeps_remote
  test_remote_deletion_follows_local_deletion
  test_topic_preserved_negative_controls
  test_local_topic_recreated_during_remote_deletion
  test_failed_local_deletion_keeps_remote
  test_ref_transactions_answer_into_a_regular_file
  test_branch_config_locked_through_deletion
  test_symref_capability_preflight
  test_dangling_capability_ref_refusal
  test_option_like_branch_name
  test_relative_tmpdir
  test_session_tmpdir_refusal
  test_unwritable_tmpdir_refusal
  test_config_lock_refusal
  test_symbolic_repository_config_refusal
  test_symbolic_worktree_config_preflight
  test_ignored_master_collision_refusal
  test_ignored_master_descendant_refusal
  test_ignored_master_descendant_newline_name_refusal
  test_missing_branch_config
  test_inherited_branch_config
  test_dotted_branch_config
  test_custom_branch_config
  test_merge_options_cleanup
  test_usage_and_option_errors
  test_success_reports_its_record
  test_finish_command_strips_url_credentials
  test_multiple_push_endpoints_refusal
  test_identity_refusals
  test_preexisting_recovery_ref
  test_runner_names_a_setup_case_failure
  test_runner_names_an_errexit_death
  test_runner_reaps_a_statusless_case
  test_runner_cleans_up_after_a_closed_pipe
  test_runner_term_midrun_exits_130
  test_runner_survives_midrun_rewrite
  test_runner_kills_a_case_past_its_deadline
  test_runner_refuses_bad_arguments
  test_runner_help_ignores_inherited_pids
  test_runner_counts_a_stated_boundary
  test_runner_isolates_ambient_git_config
)

usage() {
  cat <<'USAGE'
usage: test-post-merge-cleanup.sh [-j N] [-v] [test_name ...]

With no arguments every case runs. Each argument names one case exactly, as the
test function is spelled in this file; --list prints the available names. An
unknown name, or one given twice, is refused before any case runs.

Cases are independent, so they run concurrently, N at a time (-j N, --jobs=N,
or SHIP_PR_TEST_JOBS; default: the number of online processors). Each case's
output is buffered and printed whole when it completes, so a failure report is
never interleaved with another case; passing cases print only their PASS lines
unless -v/--verbose asks for their full output. -j 1 runs the cases serially.

Each case has a deadline: SHIP_PR_TEST_CASE_TIMEOUT seconds (default 300; 0 or
off disables it). A case still running at its deadline has its process group
killed and is reported as a failure naming the deadline, with its log, so one
stalled case cannot hold the suite open until the CI job's own timeout.
SHIP_PR_TEST_LOG_DIR keeps every case's log and status file in that directory
instead of under the scratch root, where CI can collect them after a failure.
USAGE
}

known_test() {
  local name="$1" candidate
  for candidate in "${TESTS[@]}"; do
    [ "$candidate" = "$name" ] && return 0
  done
  return 1
}

JOBS="${SHIP_PR_TEST_JOBS:-}" # an empty variable is unset, as for the other SHIP_PR_* knobs
JOBS_EXPLICIT=0               # an explicit -j / --jobs value, empty included, is validated as given
VERBOSE=0
NAMED=0
SELECTED_COUNT=0
SELECTED=()
while [ "$#" -gt 0 ]; do
  case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  --list)
    printf '%s\n' "${TESTS[@]}"
    exit 0
    ;;
  -v | --verbose) VERBOSE=1 ;;
  -j | --jobs)
    [ "$#" -ge 2 ] || {
      echo "FAIL: $1 needs a job count" >&2
      exit 1
    }
    JOBS="$2"
    JOBS_EXPLICIT=1
    shift
    ;;
  -j?*)
    JOBS="${1#-j}"
    JOBS_EXPLICIT=1
    ;;
  --jobs=*)
    JOBS="${1#--jobs=}"
    JOBS_EXPLICIT=1
    ;;
  -*)
    echo "FAIL: unknown option: $1" >&2
    usage >&2
    exit 1
    ;;
  *)
    known_test "$1" || {
      echo "FAIL: unknown test name: $1" >&2
      echo "run with --list to see the ${#TESTS[@]} available names" >&2
      exit 1
    }
    # Each case owns the scratch subtree, log, and status file named after it, so a name
    # selected twice would run two copies of the case on one tree.
    for selected_test in ${SELECTED[@]+"${SELECTED[@]}"}; do
      [ "$selected_test" != "$1" ] || {
        echo "FAIL: test name given more than once: $1" >&2
        exit 1
      }
    done
    NAMED=1
    SELECTED+=("$1")
    SELECTED_COUNT=$((SELECTED_COUNT + 1))
    ;;
  esac
  shift
done

if [ "$SELECTED_COUNT" -eq 0 ]; then
  SELECTED=("${TESTS[@]}")
  SELECTED_COUNT=${#TESTS[@]}
fi

if [ "$JOBS_EXPLICIT" -eq 0 ] && [ -z "$JOBS" ]; then
  JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || JOBS=""
  case "$JOBS" in
  '' | *[!0-9]* | 0) JOBS=4 ;; # no readable processor count: a CI-runner-sized default
  esac
fi
case "$JOBS" in
'' | *[!0-9]*) JOBS_VALUE=-1 ;;
*) JOBS_VALUE=$((10#$JOBS)) ;; # decimal, so 00 is zero and 08 is eight
esac
[ "$JOBS_VALUE" -ge 1 ] || {
  echo "FAIL: the job count (-j / SHIP_PR_TEST_JOBS) must be a positive integer, got '$JOBS'" >&2
  exit 1
}
JOBS="$JOBS_VALUE"
[ "$JOBS" -le "$SELECTED_COUNT" ] || JOBS="$SELECTED_COUNT"

CASE_TIMEOUT="${SHIP_PR_TEST_CASE_TIMEOUT:-300}"
case "$CASE_TIMEOUT" in
off) CASE_TIMEOUT=0 ;;
'' | *[!0-9]*)
  echo "FAIL: SHIP_PR_TEST_CASE_TIMEOUT must be a number of seconds, 0, or off, got '$CASE_TIMEOUT'" >&2
  exit 1
  ;;
*) CASE_TIMEOUT=$((10#$CASE_TIMEOUT)) ;;
esac

# How the runner reads a case's processes (ludics-lite#337). Two readings, chosen by platform:
# - ps: `ps -o`, everywhere but the Cygwin family. A zombie still answers `kill -0` there, so only
#   ps's state column tells a finished case from a running one, and a killed leader is a zombie
#   until reaped and would otherwise keep its group looking alive.
# - kill: Git for Windows' MSYS2 bash and Cygwin (uname MINGW*, MSYS*, CYGWIN*), whose ps has no
#   -o. There every ps reading below came back empty: reap_one took each running case for one
#   already gone and blocked in `wait` on it, so no deadline was ever checked and a stalled case
#   held the job to its step cap. Cygwin's kill() skips a process that has exited, reaped or
#   not, so `kill -0 PID` and `kill -0 -- -PGID` answer for live processes only; /proc/PID/pgid
#   is Cygwin's own file naming a process's group.
# Any other host whose ps cannot print fields is refused before a case starts, rather than read as
# one where every case has already finished.
case "$ON_MSYS" in
1) PROC_READING=kill ;;
*)
  PROC_READING=ps
  ps -o pgid=,stat= -p "$$" >/dev/null 2>&1 || {
    echo "FAIL: the runner reads its cases' processes with ps -o, which this host's ps refuses" >&2
    exit 1
  }
  ;;
esac

# Every case builds its scratch repositories under $TEST_ROOT and reads nothing outside them, so
# each one runs in a background subshell with a private root named after the case. The subshell
# reports its exit status through a file: a zombie still answers `kill -0`, and bash 3.2 has no
# `wait -n`, so the status file is what the parent polls for. Nothing here relies on the parent's
# EXIT trap (which background subshells do not inherit); the root is removed once, at the end.
#
# Job control puts each case in its own process group, so the whole tree a case spawned — the
# helper, its git children, a hook paused in a sleep loop — can be terminated as a unit: on an
# interrupt, and after every case, before its scratch tree is removed from under it. Without it
# a killed case leaves descendants waiting on markers in a directory that no longer exists.
set -m
if [ -n "${SHIP_PR_TEST_LOG_DIR:-}" ]; then
  LOG_DIR="$SHIP_PR_TEST_LOG_DIR" # kept after the run: CI collects it as an artifact on failure
else
  LOG_DIR="$TEST_ROOT/.logs"
fi
mkdir -p "$LOG_DIR" || {
  echo "FAIL: cannot create the log directory $LOG_DIR" >&2
  exit 1
}
PASSED_COUNT=0
FAILED_COUNT=0
FAILED=()
BOUNDARY_COUNT=0 # passing cases that stated a platform boundary (skip_boundary)
BOUNDARY=()

# run_case <name> <slot>: the case's scratch root is named after its spawn slot, not the case, so
# the path every fixture builds under it stays short. Windows' 260-character MAX_PATH bounds a
# Git for Windows path without core.longpaths, and the case name on top of the case's own slug and
# a session-recovery ref pushed four cases just past it (ludics-lite#338). The log and
# status files carry the name.
run_case() {
  local name="$1"
  # The trap body is evaluated when the subshell exits, under whatever scope is live then. Every
  # case's setup_case has its own local `name`, so a failure inside it would resolve `$name` to
  # the scratch slug and write a status file the parent never looks for. Resolve the path now.
  CASE_STATUS_FILE="$LOG_DIR/$name.status"
  trap 'echo "$?" >"$CASE_STATUS_FILE"' EXIT
  # fd 8 is the case log as opened here, so report_errexit reaches it from inside a block whose
  # stderr the case sent to a file. `set -E` hands the ERR trap to every function and subshell.
  exec 8>&2
  set -E
  trap 'case $- in *e*) report_errexit "$?" "$LINENO" "${FUNCNAME[0]:-}" "$BASH_COMMAND" "${PIPESTATUS[*]}" ;; esac' ERR
  TEST_ROOT="$TEST_ROOT/$2"
  CASE_NAME="$name" # skip_boundary names its line with it
  mkdir -p "$TEST_ROOT" || exit 1
  isolate_git_config
  "$name"
}

# report_errexit <status> <line> <function> <command> <statuses>: the case's ERR trap
# (ludics-lite#649). A command that fails under `set -e` ends the case with a bare status, and its
# output may have gone to a file the case never got to print: on 2026-10-15 main went red on
# `===== FAIL: <case> (exit 1) =====` and nothing else. So a shell of the case that errexit is
# about to end first writes one line to the case log naming the command, its status, its function
# and its line. For a pipeline that pipefail failed, bash's <command> is the pipeline's LAST
# command, which may well have succeeded, so the line says so and gives every component's status
# left to right (<statuses>, PIPESTATUS as the trap found it), which names the failed one by its
# position; bash keeps no text of the pipeline's other commands.
# Boundary -- what it reports: exactly the failures errexit acts on, since bash runs ERR under
# errexit's own rules, and only where errexit is on (`$-` holds e). Quiet by construction: a
# command guarded by `if`, `while`, `until`, `!`, or any but the last of an `&&`/`||` list (and
# everything inside a function called from one), a `set +e` region, and a command substitution,
# where bash clears errexit. Under `inherit_errexit` or POSIX mode a substitution keeps errexit, so
# a failure there really does end it and is reported; either way the line goes to fd 8, never into
# the capture. Not reported: `fail` and every other explicit `exit`, which say their own
# piece, and a case killed by a signal or its deadline, which report_case names. A subshell that
# errexit ends reports itself, and bash 5 then reports the subshell's command in its parent too;
# a background subshell's line is true of that subshell, not of the case. The `$-` test sits in
# the trap itself, not in here: in bash 3.2 an ERR trap that runs any simple command resets
# PIPESTATUS, which test_runner_cleans_up_after_a_closed_pipe reads after a pipeline it lets fail
# under `set +e`, so where errexit is off the trap must run nothing. bash 3.2 also gives a trap
# the line of an enclosing compound command, not the failing one's, so there the report says so
# instead of misleading (a DEBUG-trap line tracker resets PIPESTATUS the same way).
# test_runner_names_an_errexit_death pins the report and the quiet shapes.
report_errexit() {
  local line="line $2" command="\`$4\`"
  [ "${BASH_VERSINFO[0]}" -ge 4 ] || line="bash $BASH_VERSION gives a trap no line inside a function"
  case "$5" in
  *' '*) command="the pipeline ending in $command (statuses $5)" ;;
  esac
  printf '%s\n' "ERREXIT: set -e ended this shell of the case at $command (exit $1) in ${3:-the top level of the case}, $line" >&8
}

# isolate_git_config: the case's Git -- its fixtures, its hooks, and the helper, which inherits
# this -- reads the case's repositories' own configuration and one scratch global file, nothing
# else (ludics-lite#386). A user's global `core.hooksPath` sent Git past every race-injection hook
# a case writes to `.git/hooks`, so the case's verdict was the user's configuration's, not the
# helper's; a global `init.templateDir`, `user.*`, `init.defaultBranch` and the rest reached every
# fixture the same way. Cleared: the system file (GIT_CONFIG_NOSYSTEM, which also outranks a
# GIT_CONFIG_SYSTEM), the global and XDG files (GIT_CONFIG_GLOBAL names the scratch one instead;
# Git >= 2.32), and the configuration the environment carries (GIT_CONFIG_COUNT with its
# GIT_CONFIG_KEY_n/VALUE_n pairs, GIT_CONFIG_PARAMETERS, the legacy GIT_CONFIG). The scratch file
# pins `init.defaultBranch` to Git's built-in default, which also silences the hint every
# `git init --bare` printed. Not cleared: Git's other environment (GIT_EDITOR, GIT_TRACE, GIT_SSH
# ...), which no case's verdict has been seen to depend on. The helper clearing the environment
# configuration itself is test_git_local_environment_is_cleared's to pin, which sets it on the
# helper's call alone. Fail-closed: a Git that ignores any of this (GIT_CONFIG_GLOBAL before 2.32)
# lists more than the scratch file outside a repository, and the case fails before it runs.
# test_runner_isolates_ambient_git_config plants a hooksPath through each channel.
isolate_git_config() {
  local listed
  unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CONFIG_SYSTEM
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL="$TEST_ROOT/.ship-pr-test-gitconfig"
  printf '%s\n' '[init]' '	defaultBranch = master' >"$GIT_CONFIG_GLOBAL" ||
    fail "could not write the case's scratch global Git configuration"
  listed=$(CDPATH= cd "$TEST_ROOT" && git config --list 2>&1) || listed="(git config --list failed: $listed)"
  [ "$listed" = init.defaultbranch=master ] ||
    fail "Git still reads configuration from outside the case ($(git --version)); outside a repository it lists: $listed"
}

SPAWNED=0 # the next case's index in the RUNNING_* arrays, which unset leaves sparse

start_case() {
  local name="$1" i pid pgid
  # A kept log directory may hold a status file from a previous run; reap_one would take it for
  # this case's verdict before the case had run.
  rm -f "$LOG_DIR/$name.status"
  i=$SPAWNED
  (run_case "$name" "$i") >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  pid=$!
  SPAWNED=$((SPAWNED + 1))
  RUNNING_PIDS[$i]="$pid"
  RUNNING_NAMES[$i]="$name"
  RUNNING_STARTS[$i]="$SECONDS"
  RUNNING=$((RUNNING + 1))
  # Prove the case is in its own process group rather than trusting job control's handoff. Both
  # sides of the fork call setpgid; on macOS the child's call intermittently fails with "child
  # setpgid (N to N): Operation not permitted" (bash prints that line itself, before the case's
  # redirections apply, so it cannot be silenced here). On every such occasion observed the
  # parent's identical call had already succeeded — 354 spawns, 13 complaints, 0 wrong groups —
  # so the line is noise; this check is what makes that a fact rather than a hope. A case that
  # is nevertheless not a group leader cannot be repaired from here (setpgid reaches only the
  # caller or its children, and any helper process this runner starts is the case's sibling),
  # and the deadline and cleanup guarantees rest on the group: the case is ended now and
  # reported as a runner failure, rather than run with descendants nothing can terminate.
  pgid=$(case_pgid "$pid")
  if [ -n "$pgid" ] && [ "$pgid" != "$pid" ]; then
    kill_case_group "$pid"
    report_case "$i" " — the runner could not place it in its own process group (it ran in $pgid), so its descendants could not have been terminated as a unit; the case was ended, not run"
  fi
}

# case_running <pid>: the case's leader is still running (a zombie, or a pid already gone, is not).
case_running() {
  local state
  if [ "$PROC_READING" = kill ]; then
    kill -0 "$1" 2>/dev/null
    return
  fi
  state=$(ps -o stat= -p "$1" 2>/dev/null) || state=""
  case "$state" in
  '' | Z*) return 1 ;;
  esac
}

# group_alive <pgid>: anything in the group is still running, zombies excluded.
group_alive() {
  if [ "$PROC_READING" = kill ]; then
    kill -0 -- "-$1" 2>/dev/null
    return
  fi
  [ "$(ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { n++ } END { print n + 0 }')" -gt 0 ]
}

# pid_alive <pid>: the process is still running, zombies excluded — a killed orphan stays a
# zombie for as long as PID 1 does not reap it, which in some containers is forever.
pid_alive() {
  if [ "$PROC_READING" = kill ]; then
    kill -0 "$1" 2>/dev/null
    return
  fi
  case "$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')" in
  '' | Z*) return 1 ;;
  esac
}

# case_pgid <pid>: the process's group, or nothing once it is gone.
case_pgid() {
  local pgid
  if [ "$PROC_READING" = kill ]; then
    pgid=$(cat "/proc/$1/pgid" 2>/dev/null) || pgid=""
  else
    pgid=$(ps -o pgid= -p "$1" 2>/dev/null) || pgid=""
  fi
  printf '%s\n' "$pgid" | tr -d ' '
}

# kill_case_group <pid>: terminate a case's process group and its leader, escalating to KILL
# once a grace period passes with anything in the group still alive — the leader may well die
# on TERM while a descendant that ignores it lives on, and it is the whole group that has to be
# gone before the case's tree can be removed.
kill_case_group() {
  local pid="$1" tries=0
  kill -TERM -- "-$pid" >/dev/null 2>&1 || true
  kill -TERM "$pid" >/dev/null 2>&1 || true
  while [ "$tries" -lt 25 ]; do
    group_alive "$pid" || return 0
    sleep 0.2
    tries=$((tries + 1))
  done
  kill -KILL -- "-$pid" >/dev/null 2>&1 || true
  kill -KILL "$pid" >/dev/null 2>&1 || true
}

# report_case <index> [deadline-note]: reap the case and print its verdict. A deadline note
# means the runner killed it: that is a failure whatever its status trap managed to write.
report_case() {
  local i="$1" deadline_note="${2:-}" name pid status log note wait_status
  name="${RUNNING_NAMES[$i]}"
  pid="${RUNNING_PIDS[$i]}"
  log="$LOG_DIR/$name.log"
  if wait "$pid" >/dev/null 2>&1; then wait_status=0; else wait_status=$?; fi
  stop_if_interrupted # a trapped signal returns from wait early; the case is still registered
  kill -TERM -- "-$pid" >/dev/null 2>&1 || true # anything the case left behind in its group
  note=""
  if [ -n "$deadline_note" ]; then
    status=1
    note="$deadline_note"
  elif [ -f "$LOG_DIR/$name.status" ]; then
    status=$(cat "$LOG_DIR/$name.status" 2>/dev/null) || status=""
  else
    # The subshell died without its status trap running (a signal, or a broken trap): that is
    # never a pass, whatever the exit status says.
    status=""
    note=" — the case exited $wait_status without reporting a status"
  fi
  case "$status" in
  '' | *[!0-9]*) status=1 ;;
  esac
  unset "RUNNING_PIDS[$i]" "RUNNING_NAMES[$i]" "RUNNING_STARTS[$i]"
  RUNNING=$((RUNNING - 1))
  if [ "$status" -eq 0 ]; then
    PASSED_COUNT=$((PASSED_COUNT + 1))
    if awk -v p="SKIP $name: " 'index($0, p) == 1 { found = 1 } END { exit !found }' "$log"; then
      BOUNDARY_COUNT=$((BOUNDARY_COUNT + 1))
      BOUNDARY+=("$name")
    fi
    if [ "$VERBOSE" -eq 1 ]; then
      cat "$log"
    else
      # Each PASS and SKIP line names its case, so a log cut off mid-run shows which cases never
      # reported without finding them by elimination (ludics-lite#337). A case that states a
      # boundary for all of itself prints only its SKIP line.
      awk -v n="$name" -v p="SKIP $name: " '
        index($0, p) == 1 { print; found = 1; next }
        sub(/^PASS:/, "PASS " n ":") { print; found = 1 }
        END { exit !found }' "$log" ||
        echo "PASS $name: (printed no PASS line)"
    fi
    rm -rf "${TEST_ROOT:?}/$i"
  else
    FAILED_COUNT=$((FAILED_COUNT + 1))
    FAILED+=("$name")
    {
      echo "===== FAIL: $name (exit $status$note) ====="
      cat "$log"
      echo "===== end of $name ====="
    } >&2
  fi
}

reap_one() {
  local i
  while :; do
    stop_if_interrupted
    for i in ${RUNNING_PIDS[@]+"${!RUNNING_PIDS[@]}"}; do
      if [ -f "$LOG_DIR/${RUNNING_NAMES[$i]}.status" ]; then
        report_case "$i"
        return 0
      fi
      # A subshell that exited without its status file must still be reaped, or the suite would
      # wait on it forever: a zombie (or a pid already gone) is finished, whatever it reported.
      if ! case_running "${RUNNING_PIDS[$i]}"; then
        report_case "$i"
        return 0
      fi
      # The deadline (ludics-lite#14): a case that stalls — one sat silent for the six hours of a
      # CI job's default timeout — is killed as a group and reported, naming the deadline, rather
      # than polled for as long as the job lasts.
      if [ "$CASE_TIMEOUT" -gt 0 ] && [ $((SECONDS - ${RUNNING_STARTS[$i]})) -ge "$CASE_TIMEOUT" ]; then
        kill_case_group "${RUNNING_PIDS[$i]}"
        report_case "$i" " — timed out after ${CASE_TIMEOUT}s (SHIP_PR_TEST_CASE_TIMEOUT); its process group was killed"
        return 0
      fi
    done
    sleep 0.2
  done
}

# A signal only sets a flag. Exiting from inside the trap could fall between a case's spawn and
# its registration, and the EXIT cleanup would then know nothing of that case; instead the
# scheduler stops at its next step, once every spawned case is on record, and the EXIT trap
# terminates and reaps the in-flight process groups before removing the root.
INTERRUPTED=0
on_signal() {
  INTERRUPTED=1
}
stop_if_interrupted() {
  [ "$INTERRUPTED" -eq 0 ] || {
    echo "FAIL: interrupted with $RUNNING post-merge cleanup states still running" >&2
    exit 130
  }
}
trap on_signal INT TERM

SECONDS=0
for selected_test in "${SELECTED[@]}"; do
  while [ "$RUNNING" -ge "$JOBS" ]; do
    reap_one
  done
  stop_if_interrupted
  start_case "$selected_test"
done
while [ "$RUNNING" -gt 0 ]; do
  reap_one
done
stop_if_interrupted

# A passing case that stated a platform boundary passed only what it ran, so the summary counts
# and names those cases every time (ludics-lite#338): a boundary is never silently green.
# The FAIL line keeps the failed cases last, after its final colon, where readers of it look.
BOUNDARY_NOTE=""
[ "$BOUNDARY_COUNT" -eq 0 ] ||
  BOUNDARY_NOTE="$BOUNDARY_COUNT of them stated a platform boundary (SKIP): ${BOUNDARY[*]}"
if [ "$FAILED_COUNT" -gt 0 ]; then
  echo "FAIL: $FAILED_COUNT of $SELECTED_COUNT post-merge cleanup states failed in ${SECONDS}s (-j $JOBS${BOUNDARY_NOTE:+; of those that passed, $BOUNDARY_NOTE}): ${FAILED[*]}" >&2
  exit 1
fi
if [ "$NAMED" -eq 0 ]; then
  echo "PASS: all post-merge cleanup states ($SELECTED_COUNT cases in ${SECONDS}s, -j $JOBS)${BOUNDARY_NOTE:+; $BOUNDARY_NOTE}"
else
  echo "PASS: $SELECTED_COUNT selected post-merge cleanup states (${SECONDS}s, -j $JOBS)${BOUNDARY_NOTE:+; $BOUNDARY_NOTE}"
fi
exit "$?"
}
