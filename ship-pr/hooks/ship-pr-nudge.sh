#!/bin/bash
# Stop hook: when a session ends with finished-looking work that never landed, block the stop once
# and point at the ship-pr skill.
#
# A Stop hook's stdout does not reach the model -- blocking (exit 2, message on stderr) is the only
# channel. Blocking costs an extra model turn, so this is a STATE GATE, not a reminder: it stays
# silent unless there is genuinely unlanded work, and it speaks at most once per repository state.
#
# Exit 0 = let the session stop. Exit 2 = block, stderr goes to the model.

input=$(cat)

# Both Claude Code and Codex send JSON on stdin and accept exit 2 + stderr at Stop.
# Never approximate JSON with sed: escaped paths and multiline records are valid input.
# Python is a fallback for fleet boxes without jq; without either parser, stay quiet.
have_jq=$(command -v jq 2>/dev/null)
have_python=$(command -v python3 2>/dev/null)
[ -n "$have_jq$have_python" ] || exit 0
q() {
  if [ -n "$have_jq" ]; then
    printf '%s' "$input" | "$have_jq" -r --arg key "$1" '.[$key] // empty' 2>/dev/null
  else
    printf '%s' "$input" | "$have_python" -c '
import json, sys
try:
    value = json.load(sys.stdin).get(sys.argv[1])
    if isinstance(value, bool):
        print(str(value).lower())
    elif isinstance(value, str):
        print(value)
except (ValueError, AttributeError):
    pass
' "$1" 2>/dev/null
  fi
}

# 1. Loop guard: we already blocked once and the model is answering us.
[ "$(q stop_hook_active)" = "true" ] && exit 0

cwd=$(q cwd)
[ -d "$cwd" ] && cd "$cwd" || exit 0

# 2. Only inside a git repo (worktrees included).
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$branch" ] || [ "$branch" = "HEAD" ] && exit 0

# 3. The default branch is where work lands, so being on it means nothing is pending review.
default_branch=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
default_branch=${default_branch#origin/}
[ -z "$default_branch" ] && default_branch=master
[ "$branch" = "$default_branch" ] && exit 0

upstream="origin/$default_branch"
git rev-parse --verify --quiet "$upstream" >/dev/null || exit 0

# 4. What is unlanded: uncommitted changes, and commits this branch has that the default branch
# does not. Both are read locally here, so a merged-but-unfetched branch can still look ahead;
# the PR lookup and the base refresh below are what catch that case.
dirty=$(git status --porcelain 2>/dev/null) || exit 0
ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null) || exit 0
[ -z "$dirty" ] && [ "$ahead" = "0" ] && exit 0

# 5. A Stop does not mean the work settled, only that the turn yielded: backgrounded builds, test
# runs and PR watchers keep running across it, and the session is woken again when they finish.
# Nudging mid-flight asks about work that is still happening, so defer -- silently, and WITHOUT
# stamping, so the question gets asked once the state stops moving.
#
# Claude Code writes each background task to <session dir>/tasks/<id>.output and appends an exit
# marker when it ends. A task file with no marker is either running or was abandoned, so recency
# decides: an old unmarked file is a corpse, not a running job, and must not mute the hook forever.
# Codex does not use Claude's task files. Do not infer its background state from them.
# Its Stop payload adds turn_id; the shared loop guard and coarse stamp still apply.
sid=$(q session_id)
[ -n "$sid" ] || exit 0
if [ -z "$(q turn_id)" ]; then
  for tasks_dir in /private/tmp/claude-*/*/"$sid"/tasks "${TMPDIR:-/tmp}"/claude-*/*/"$sid"/tasks; do
    [ -d "$tasks_dir" ] || continue
    while IFS= read -r out; do
      grep -aq '^\[exited with code' "$out" || exit 0
    done < <(find "$tasks_dir" -name '*.output' -mmin -30 2>/dev/null)
  done
fi

# 6. A turn that ends by asking the user something is already waiting on them; blocking it would
# talk over the question. Heuristic, and deliberately cheap: worst case is one skipped nudge.
transcript=$(q transcript_path)
if [ -f "$transcript" ] && tail -c 20000 "$transcript" | tail -3 | grep -Eq 'AskUserQuestion|request_user_input(_async)?'; then
  exit 0
fi

# 7. Deliberately coarse: more edits to the same dirty files do NOT reset the nudge.
# Include the worktree and session in the hash, both to isolate repos and to avoid using
# an input session id as a path. Atomic mkdir lets concurrent Stops share one claim.
#
# With a human attending, nothing short of another branch resets it: they decide when to land, so
# one reminder per session and branch is enough. Claude Code sets CLAUDE_CODE_SESSION_ATTENDED per
# process -- 1 in the desktop app, 0 under `claude -p` even when inherited from an attended parent
# (probed 2026-10-31, 2.1.309) -- so CLI fleet workers keep the per-state nudge. Codex payloads
# (turn_id) do too: Codex sets no such variable, and an inherited one would describe someone else.
#
# Not done (yet): an attended session could skip the blocked stop altogether -- hold the message
# here, and have this script registered as UserPromptSubmit hand it over as `additionalContext`
# with the human's next message, costing no extra turn. Whether a reminder that arrives a message
# late still lands the work is the open question.
hash_cmd=$(command -v shasum || command -v sha1sum || command -v cksum)
if [ -z "$(q turn_id)" ] && [ "${CLAUDE_CODE_SESSION_ATTENDED:-}" = 1 ]; then
  state=$(printf '%s\n' "$(pwd -P)" "$sid" "$branch" attended | "$hash_cmd" | cut -d' ' -f1)
else
  state=$(printf '%s\n' "$(pwd -P)" "$sid" "$branch" "$(git rev-parse HEAD)" "$dirty" | "$hash_cmd" | cut -d' ' -f1)
fi
stamp_dir="${TMPDIR:-/tmp}/ship-pr-nudge"
mkdir -p "$stamp_dir" 2>/dev/null || exit 0
stamp="$stamp_dir/$state"
[ -e "$stamp" ] && exit 0

# 8. A branch that already has a PR has been shipped; monitoring it is the session's own business.
# Network calls happen only once the local checks say something is pending, and each is bounded:
# a GitHub or remote that does not answer in time counts as a failed call, never a held stop.
# Keep ALL PR states exempt: closed PRs may be deliberately abandoned experiments.
# A successful empty list proves absence; auth/network errors, timeouts and missing gh do not.
command -v gh >/dev/null 2>&1 || exit 0
net_deadline=$((SECONDS + 15))
bounded() {
  local left=$((net_deadline - SECONDS)) pid rc
  [ "$left" -gt 5 ] && left=5
  [ "$left" -gt 0 ] || return 124
  "$@" </dev/null 2>/dev/null &
  pid=$!
  # The watchdog must not hold the caller's stdout: $(...) waits for every writer to close it.
  # It kills only after a nap that ran out: a missing or failed sleep kills nothing.
  ( sleep "$left" & nap=$!; trap 'kill "$nap"; exit' TERM; wait "$nap" && kill "$pid" ) >/dev/null 2>&1 &
  local dog=$!
  wait "$pid" 2>/dev/null; rc=$?
  kill "$dog" 2>/dev/null
  return "$rc"
}
# Where to look. gh's default resolution prefers a remote named `upstream`, so a fork-shaped
# checkout (origin = a staging repo, upstream = its parent) without `gh repo set-default` asks the
# parent and reads a merged origin PR as "no PR" (#404). Ask origin's repository explicitly --
# the branch is judged against origin's base, so that is where its PR lives -- and gh's default
# too whenever it may differ: PRs from a fork to its parent live there. An empty entry is gh's
# default.
repos=()
origin_url=$(git remote get-url origin 2>/dev/null) && repos+=("$origin_url")
if [ "$(git remote 2>/dev/null)" != origin ] && [ "$(git config remote.origin.gh-resolved 2>/dev/null)" != base ]; then
  repos+=("")
fi
pr_exempt() {
  local pr_count repo
  for repo in "${repos[@]}"; do
    pr_count=$(bounded gh pr list ${repo:+--repo "$repo"} "$@" --state all --limit 1 --json number --jq length) || exit 0
    case "$pr_count" in
      0) ;;
      1) mkdir "$stamp" 2>/dev/null; exit 0 ;;
      *) exit 0 ;;
    esac
  done
  return 1
}
pr_exempt --head "$branch"
# The work may have been pushed under another name (`git push origin HEAD:<name>`), so also look
# for a PR by HEAD's SHA. GitHub's SHA search matches ANY commit of a PR, so a HEAD that is an
# ancestor of a PR's head counts too, at no extra cost. A HEAD with commits beyond a PR's head
# does not: those commits are in no PR, and a branch stacked on another PR looks the same.
# With nothing ahead, HEAD is already on the default branch and would match the PR that landed it.
[ "$ahead" != "0" ] && pr_exempt --search "$(git rev-parse HEAD)"

# 9. No PR anywhere. Commits can still have landed without one (a direct push from another
# checkout), and `ahead` was counted against a local ref nothing here refreshes: `gh pr merge`
# does not update it. Refresh the base before blaming the branch; if that fails, say so.
stale_note=
if [ "$ahead" != "0" ]; then
  if GIT_TERMINAL_PROMPT=0 bounded git fetch --quiet --no-tags origin \
       "+refs/heads/$default_branch:refs/remotes/$upstream"; then
    ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null) || exit 0
    [ -z "$dirty" ] && [ "$ahead" = "0" ] && exit 0
  else
    stale_note=" (could not refresh $upstream: counted against the local ref, which may be stale)"
  fi
fi

mkdir "$stamp" 2>/dev/null || exit 0
{
  printf 'Unlanded work: branch %s' "$branch"
  [ "$ahead" != "0" ] && printf ', %s commit(s) ahead of %s%s' "$ahead" "$upstream" "$stale_note"
  [ -n "$dirty" ] && printf ', uncommitted changes'
  printf ', no PR.\n'
  printf 'If the goal is finished, invoke the ship-pr skill to land it. If it is not -- work still\n'
  printf 'in progress, an investigation that changed nothing, a path that went wrong, or the user\n'
  printf 'already said how to land it -- say which in one line and stop.\n'
} >&2
exit 2
