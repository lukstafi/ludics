#!/usr/bin/env bash
# Sync the local scheduled-task prompts between this checkout and the desktop app's
# ~/.claude/scheduled-tasks/<id>/.
#
# Those directories must hold REAL files. The symlink trick the skills still use stopped
# working for scheduled tasks in desktop app 1.46388.4 (2026-09-06): the scheduler now
# refuses a task file whose path traverses a symlink ("symlink detected before open;
# refusing to open"), and a task whose prompt it cannot read is dispatched, never started,
# and cleared ten minutes later as a stale dispatch -- with lastRunAt stamped by the clear,
# so the registry still looks like it ran. Hence copies, and hence this script.
#
# Usage:
#   sync-routines.sh              status only: report drift, exit 1 if any
#   sync-routines.sh push         this checkout -> ~/.claude/scheduled-tasks (after editing here)
#   sync-routines.sh pull         ~/.claude/scheduled-tasks -> this checkout (after an edit
#                                 made in place, e.g. by the routine's own run)
#
# Options:
#   -n, --dry-run                 say what would be copied, copy nothing
#   -h, --help                    this text
#
# Exit codes:
#   0  status: everything in sync. push/pull: every routine handled.
#   1  status: drift -- including a routine not installed, one installed as a symlink, a
#      destination reached through one, and a retired routine still installed.
#      push: nothing was copied, or not everything was -- the destination is behind a symlink,
#      the checkout's own prompt is unusable, or a publish did not end with the destination
#      holding the source.
#      pull: there was nothing real to take -- no installed prompt, or one that IS a symlink, or
#      one that is not a usable prompt.
#      Two things are deliberately NOT failures. A push that installs a prompt over a placeholder
#      is a success, and so is a pull that RESTORES a checkout routine that was deleted or linked
#      away: repairing this side is what pull is for. A destination reached through a symlinked
#      ANCESTOR is the asymmetric case, and it is symmetric between the two roots: publishing
#      through a symlinked ancestor is refused, reading through one only warned about. So a
#      symlinked DESTINATION root refuses a push and lets a pull through, while a symlinked
#      SOURCE root (this checkout's routines/) refuses a PULL and lets a push through. status
#      reports the destination one as drift, since the scheduler cannot read a task file whose
#      path traverses a link however the sync went.
#   2  usage: an argument this script does not know.
#
# The destination is $CLAUDE_SCHEDULED_TASKS_DIR when set, which is what the fixture suite
# scripts/test-sync-routines.sh points at scratch trees; otherwise ~/.claude/scheduled-tasks.
#
# Only status allows a missing final LF in the top-level SKILL.md on either side, provided
# all other bytes and paths agree. Additional blank lines and companion files compare exactly,
# as do both copying modes. Prompt validation still runs before the comparison.
#
# Registration is separate: the desktop app's registry (cron, working directory, model) is
# not a file in this repository. Register a task with the `schedule` tool first -- it writes
# a placeholder SKILL.md -- then `sync-routines.sh push` over it.

set -euo pipefail
# No pathname expansion, anywhere. Paths are split on `/` and routine names on whitespace with
# unquoted expansions, which do word splitting AND globbing: a path component or a routine name
# holding a `*`, `?` or `[` would be replaced by whatever it happens to match in the caller's
# working directory, and the script would then reason about a name nobody passed it. Word
# splitting still happens, which is what those loops want; `case` patterns are unaffected.
set -f

# The routines this script syncs: exactly the rows of routines/README.md's table whose Kind is
# `local scheduled task`. The cloud routine (ocannl-ci-red-triage) is not here -- it is synced
# by hand through the `schedule` skill, per that README.
#
# The list is written out rather than read off the table on purpose. Parsing the README at
# runtime would put a Markdown table model in the path of every sync, and ludics-lite#75 is
# thirteen review rounds of what that costs; the drift it would guard against instead has a
# test: scripts/test-sync-routines.sh reads this line and the table and refuses them if they
# disagree, with negative controls that show the comparison can fail (ludics-lite#77). Keep
# the assignment on one line, `LOCAL_ROUTINES="..."`, which is the shape the suite reads.
LOCAL_ROUTINES="daily-issue-planning ocannl-cross-machine-sweep"

# Routines that USED to be local scheduled tasks. Deleting a prompt directory here retires
# nothing on a box that already has it: the installed copy stays, and so does the desktop app's
# registry entry, which names the file by path and keeps firing it. The loop above cannot see
# that -- it iterates this repository's list, not the destination -- so retired names are carried
# as tombstones and looked for by name. The script never deletes one: the registry is the desktop
# app's, and a prompt removed while its entry stands would fire and fail rather than stop.
# A tombstone is dropped once the fleet is known to be clean.
RETIRED_ROUTINES="ocannl-format-sweep"

repo_root=$(cd "$(dirname "$0")/.." && pwd)
src_root="$repo_root/routines"
dest_root="${CLAUDE_SCHEDULED_TASKS_DIR:-$HOME/.claude/scheduled-tasks}"

mode=status
mode_given=
dry_run=false

while [ $# -gt 0 ]; do
  case "$1" in
    push|pull|status)
      # `pull push` used to run a push, silently discarding the installed edits the caller
      # asked to recover: the two write in OPPOSITE directions, so the last token winning is
      # the worst possible tie-break. One mode per invocation.
      if [ -n "$mode_given" ]; then
        echo "sync-routines: only one mode may be given, got '$mode_given' then '$1'; push and pull write in opposite directions (try --help)" >&2
        exit 2
      fi
      mode_given=$1
      mode=$1
      ;;
    -n|--dry-run) dry_run=true ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "sync-routines: unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

# physical_of <path>: <path> as the filesystem will see it -- every symlink resolved, every `.`
# and `..` folded -- so two roots can be compared as they will BE and not as they were spelled.
# There is no realpath on stock macOS; `cd -P` is the portable resolver, and it only works on a
# directory that exists, so the tail that does not exist yet is folded lexically. That is sound
# for exactly the reason it is needed: those components do not exist, `mkdir -p` is about to
# create them as plain directories, and `missing/..` is then the parent -- but only once they
# have been folded, which is the bug this replaces. Folding can uncover a longer existing prefix
# (`/a/missing/../link/x`), so resolve and fold until it settles.
physical_of() {
  local p=$1 d suffix base comp oldifs rounds=0 previous=
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ "$p" != "$previous" ] && [ "$rounds" -lt 16 ]; do
    previous=$p
    rounds=$((rounds + 1))
    d=$p
    suffix=
    # Peel with parameter expansion rather than `$(basename)`/`$(dirname)`: command
    # substitution strips trailing newlines, so a component whose name ends in one would come
    # back truncated and the path would resolve to a neighbour that is not it. ${d%/*} empties
    # out on a component sitting directly under the root (`/a` -> ``), which the loop's own
    # `[ -n "$d" ]` reads as the end of the walk -- the same place `dirname`'s `/` stopped it.
    while [ "$d" != "/" ] && [ -n "$d" ] && [ ! -d "$d" ]; do
      comp=${d##*/}
      suffix="/$comp$suffix"
      case "$d" in */*) d=${d%/*} ;; *) d= ;; esac
    done
    # The resolver below is command substitution over a pathname too, and that one stays: `pwd
    # -P` can only leave its subshell as output, command substitution eats the trailing newlines
    # it would have to carry, and there is no realpath on stock macOS to ask instead. So the
    # residual: an EXISTING directory whose own name ends in a newline is not resolved faithfully
    # by this function -- only the non-existent tail peeled above is exact. Issue #239 tracks the
    # class and records `$(cd ... && pwd -P)` as wanting a permanent exemption.
    if [ -d "$d" ]; then base=$(cd "$d" && pwd -P); else base=$d; fi
    [ "$base" = "/" ] && base=
    oldifs=$IFS
    IFS=/
    for comp in $suffix; do
      case "$comp" in
        '' | '.') ;;
        '..') base=${base%/*} ;;
        *) base="$base/$comp" ;;
      esac
    done
    IFS=$oldifs
    [ -n "$base" ] || base=/
    p=$base
  done
  printf '%s\n' "$p"
}

# first_symlinked_ancestor <dir>: the first component of <dir>'s path that is a symlink, or
# nothing. The per-routine `[ -L "$dst" ]` check below only sees the routine's own directory, but
# the scheduler refuses a task file whose path traverses a symlink at ANY component: a symlinked
# ~/.claude, or a scheduled-tasks directory moved aside and linked back, hides behind a $dst that
# is a real directory and would otherwise be reported in sync while nothing could read it.
#
# The walk is over the LITERAL components, which is what the registry stores and what the reader
# traverses -- so a component above the destination counts too, even one nobody here chose (on
# macOS /var is a link to /private/var, so a destination under /var/... genuinely is behind one).
# `pwd -P` at the caller's end is how a path is made clean; realpath is not on stock macOS.
first_symlinked_ancestor() {
  # `set -f` at the top of the file is what keeps the unquoted `$path` below from globbing.
  local path=$1 prefix="" comp oldifs
  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
  oldifs=$IFS
  IFS=/
  for comp in $path; do
    [ -n "$comp" ] || continue
    prefix="$prefix/$comp"
    if [ -L "$prefix" ]; then IFS=$oldifs; printf '%s\n' "$prefix"; return 0; fi
  done
  IFS=$oldifs
  return 1
}

# prompt_problem <dir>: says why <dir> is not a usable prompt directory, or exits 1 saying
# nothing. Two ways a directory that EXISTS still is not one, and neither is visible to the
# `-L` test on the directory itself or to the `diff -r` comparison below:
#   - a symlink anywhere inside it. The scheduler's rule is about every component of the path,
#     so a linked SKILL.md is as unreadable as a linked directory -- and `diff -r` follows the
#     link and reports the trees identical, which is a green verdict over an installation
#     nothing can open.
#   - no regular SKILL.md. That is the file the registry names by path; a directory without one
#     is a leftover, not a routine, and pulling from it would replace the checkout's prompt
#     with nothing.
prompt_problem() {
  local dir=$1 link l problem
  # The two ways a prompt directory is not even a directory. Both matter on the SOURCE side,
  # where `pull` is the repair: a deleted routine and one someone linked out of the tree are
  # exactly what a pull should be able to restore from a usable installed copy.
  if [ -L "$dir" ]; then
    printf 'is a symlink (-> %s) where a real directory belongs\n' "$(readlink "$dir")"
    return 0
  fi
  if [ ! -d "$dir" ]; then
    printf 'is not a directory\n'
    return 0
  fi
  # NUL-delimited, and only the first record: a link whose own name holds a newline would be
  # reported truncated by `-print | head -n 1`, and a name is exactly what this line is for.
  link=""
  while IFS= read -r -d '' l; do link=$l; break; done < <(find "$dir" -type l -print0 2>/dev/null)
  if [ -n "$link" ]; then
    printf 'holds a symlink (%s -> %s), and the scheduler refuses any component of the path\n' \
      "$link" "$(readlink "$link")"
    return 0
  fi
  if [ ! -f "$dir/SKILL.md" ]; then
    printf 'has no SKILL.md, which is the file the registry names by path\n'
    return 0
  fi
  # One grammar owner, including optional fields and byte validation. Installed task IDs
  # need not equal the prompt name, so use the checker's directory-independent mode.
  if ! problem=$("$repo_root/scripts/check-prompts.sh" --one "$dir" 2>&1); then
    printf 'has a SKILL.md rejected by check-prompts:\n%s\n' "$problem"
    return 0
  fi
  # A scheduled task still needs something to run. This is a Markdown-body requirement,
  # not frontmatter grammar; the checker above has already proved the exact fences.
  if ! awk 'NR == 1 { next } !closed && /^---$/ { closed=1; next }
    closed && /[^[:space:]]/ { body=1 }
    END { exit body ? 0 : 1 }' "$dir/SKILL.md"; then
    printf 'has a SKILL.md with nothing under its frontmatter: no prompt to run\n'
    return 0
  fi
  return 1
}

# publish_dir <src> <dst>: make dst's contents match src's, keeping a readable prompt at dst
# throughout. A directory cannot be swapped atomically on POSIX -- rename(2) replaces a directory
# only when the target is an empty one -- and the `rm -rf "$dst"; mv tmp "$dst"` pair this started
# as left a window in which the registry's path did not exist at all. A dispatch landing in that
# window cannot open SKILL.md, which is precisely the silent stale-dispatch failure this script
# exists to prevent. So each FILE is staged beside its final name inside dst and renamed onto it,
# which rename(2) does make atomic, and only then is what src no longer has removed. A file is
# therefore never absent, only briefly old.
#
# Paths come off `find` NUL-delimited and are read with `read -d ""`. A line at a time is what
# this did, and a newline in a routine's filename split one path into two: the staging loop below
# would `cp` a path that does not exist, and the pruning loop would `rm -f` the halves -- the
# second of them relative to the caller's working directory, since stripping the `$dst` prefix
# off a path that no longer starts with it leaves the name alone. Same hazard, and same fix, as
# PR #215 made for git's `--porcelain`/`ls-files` output; the producer here is `find`.
# Every step is checked. publish_dir is called as the condition of an `if`, which suspends
# `set -e` for the whole dynamic extent of the call, so an unchecked `cp` or `mv` that failed --
# a full or unwritable destination -- would leave the OLD prompt in place and the caller would
# report the routine published. The `|| exit 1` inside a `find | while` pipeline exits that
# subshell, which `|| return 1` on the pipeline then propagates.
publish_dir() {
  local src=$1 dst=$2
  # The destination root itself may be a symlink -- a task directory left over from the symlink
  # era, or a routine directory in this checkout that someone linked out. Following it would
  # write through into the link's target and leave the link standing, so replace it.
  if [ -L "$dst" ]; then
    rm -f "$dst" || return 1
  elif [ -e "$dst" ] && [ ! -d "$dst" ]; then
    # ...or a plain file where a directory belongs.
    rm -f "$dst" || return 1
  fi
  mkdir -p "$dst" || return 1
  # Directories first, so a file's parent exists when the file is staged. Anything of another
  # kind standing in a directory's place goes: mkdir would fail on it, and a link would send the
  # files below it out of the tree.
  find "$src" -type d -print0 | while IFS= read -r -d '' d; do
    rel=${d#"$src"}; rel=${rel#/}
    [ -n "$rel" ] || continue
    if [ -L "$dst/$rel" ] || { [ -e "$dst/$rel" ] && [ ! -d "$dst/$rel" ]; }; then
      rm -rf "$dst/$rel" || exit 1
    fi
    mkdir -p "$dst/$rel" || exit 1
  done || return 1
  find "$src" -type f -print0 | while IFS= read -r -d '' f; do
    rel=${f#"$src"}; rel=${rel#/}
    # A DIRECTORY standing where a file belongs is the one case rename(2) does not resolve:
    # `mv -f file dir/` moves the file INTO it and the destination keeps the directory. That is
    # true of a SYMLINK to a directory as well -- checked on macOS 15, where the link survived
    # and the staged file landed in its target -- so the test is `-d`, which follows the link,
    # and `rm -rf` on a link removes the link and not what it points at. A symlink to a FILE
    # needs no such care: rename replaces the name, which is what turns a linked SKILL.md into a
    # real one without a moment where the prompt is missing.
    # >>> kind-guard: scripts/test-sync-routines.sh builds a copy of this script with the block
    # between these two markers deleted, to show that publish_checked's post-condition below can
    # actually fail. Keep the markers if the guard moves.
    if [ -d "$dst/$rel" ]; then
      rm -rf "$dst/$rel" || exit 1
    fi
    # <<< kind-guard
    # Split with parameter expansion rather than `$(dirname)`/`$(basename)`: command
    # substitution strips trailing newlines, so a component whose name ends in one would be
    # staged into a directory that does not exist.
    base=${rel##*/}; parent=${rel%"$base"}
    tmp="$dst/$parent.sync-$$-$base"
    cp "$f" "$tmp" || exit 1
    mv -f "$tmp" "$dst/$rel" || { rm -f "$tmp"; exit 1; }
  done || return 1
  # Then what src no longer has. Files and links (`! -type d` catches both -- find does not
  # follow links), then the directories that are left empty, deepest first.
  # >>> prune-guard: scripts/test-sync-routines.sh builds a copy of this script with the block
  # between these two markers deleted, to show that publish_checked's tree comparison catches a
  # destination that merely LOOKS like a prompt. Keep the markers if the pruning moves.
  find "$dst" ! -type d -print0 | while IFS= read -r -d '' f; do
    rel=${f#"$dst"}; rel=${rel#/}
    case "$rel" in .sync-$$-* | */.sync-$$-*) continue ;; esac
    [ -e "$src/$rel" ] || rm -f "$f" || exit 1
  done || return 1
  # `sort -z` keeps the ordering NUL-delimited too; plain `sort -r` would re-split on the
  # newlines `-print0` just protected. Lexicographic descending puts "a/b" before "a", which is
  # the deepest-first order rmdir needs.
  find "$dst" -type d -print0 | sort -z -r | while IFS= read -r -d '' d; do
    rel=${d#"$dst"}; rel=${rel#/}
    [ -n "$rel" ] || continue
    [ -d "$src/$rel" ] || rmdir "$d" 2>/dev/null || true
  done || return 1
  # <<< prune-guard
  return 0
}

# publish_checked <src> <dst>: publish, then READ THE RESULT. A publish that reported success
# over a destination that is still not a usable prompt is the same false verdict this script
# exists to remove from the install step; the post-condition is what makes "republished" mean
# something rather than "the commands were issued".
publish_checked() {
  local src=$1 dst=$2 left report
  if ! publish_dir "$src" "$dst"; then
    warn "sync-routines: publishing $src -> $dst failed part-way; $dst is not what $src holds"
    return 1
  fi
  if left=$(prompt_problem "$dst"); then
    warn "sync-routines: after publishing, $dst still $left"
    return 1
  fi
  # Presence is not enough: an old prompt that a failed copy left standing satisfies it. The
  # claim is that the destination now HOLDS THE SOURCE, so read that. Output, not exit code
  # (see the drift comparison below for why).
  report=$(diff -r -q "$src" "$dst" 2>&1) || true
  if [ -n "$report" ]; then
    warn "sync-routines: after publishing, $dst still differs from $src: $report"
    return 1
  fi
  return 0
}

# A line terminator can be restored by appending one byte. If the shorter file already ends
# in LF, appending another would add a blank line instead. Keep pipefail on the comparison
# so a failed read cannot pass as a truncated prompt.
equals_with_final_lf() {
  local last_byte
  { cat "$1" && printf '\n'; } | cmp -s - "$2" || return 1
  last_byte=$(tail -c 1 "$1" | od -An -tu1) || return 1
  [ "$last_byte" -ne 10 ]
}

# is_under <child> <parent>: is <child> strictly inside <parent>? The filesystem root is the case
# that makes a naive prefix test wrong -- "/" plus "/" is "//", which matches no ordinary path, so
# a destination of "/" read as disjoint from everything and the guard below let it through.
is_under() {
  local child=$1 parent=$2
  [ "$parent" = "/" ] && parent=
  case "$child" in "$parent"/?*) return 0 ;; esac
  return 1
}

# The two roots must be disjoint. If the destination lands inside the checkout's routines/ --
# CLAUDE_SCHEDULED_TASKS_DIR set to a path under it -- then push creates the destination INSIDE
# the source and publish_dir's `find "$src"` then walks the tree it is writing, copying the
# installation into the canonical prompts and back again. It is checked before anything is
# written, and on the PHYSICAL paths, so a link cannot spell the overlap away. Exit 2: this is
# how the command was invoked, not something about the routines.
src_phys=$(physical_of "$src_root")
dest_phys=$(physical_of "$dest_root")
overlap=
if [ "$src_phys" = "$dest_phys" ]; then
  overlap="are the same directory"
elif is_under "$dest_phys" "$src_phys"; then
  overlap="is inside the checkout's routines/"
elif is_under "$src_phys" "$dest_phys"; then
  overlap="contains the checkout's routines/"
fi
if [ -n "$overlap" ]; then
  warn "sync-routines: the destination $overlap:"
  warn "  routines:    $src_phys"
  warn "  destination: $dest_phys"
  warn "A sync copies between two separate trees; overlapping roots would have it walk the tree"
  warn "it is writing and copy an installation into the canonical prompts. Point"
  warn "CLAUDE_SCHEDULED_TASKS_DIR somewhere outside this checkout."
  exit 2
fi

drift=0      # status only: the checkout and the installed copies disagree
problems=0   # push/pull only: a routine this run could not sync
copied=0

# Both roots are checked once, above the loop, because each is a fact about the root and not
# about any one routine. The rule is the same at both ends and comes from the filesystem, not
# from which side we happen to be on: PUBLISHING through a symlinked ancestor is refused, because
# it writes into the link's target and leaves the link standing, while READING through one is
# fine, since the files behind it are real. What the destination adds on top is the scheduler:
# it will not open a task file whose path traverses a link, so a destination behind one is a
# problem even when nothing is being written.
if link=$(first_symlinked_ancestor "$dest_root"); then
  warn "$dest_root is reached through a SYMLINK ($link -> $(readlink "$link")) -- the scheduler"
  warn "refuses a task file whose path traverses one, at any component. Make the destination a"
  warn "real directory (or point CLAUDE_SCHEDULED_TASKS_DIR at the resolved path) before syncing."
  case "$mode" in
    push)
      # Copying would succeed and install a prompt nothing can read: the exact quiet failure
      # this script exists to prevent.
      warn "sync-routines: refusing to push behind a symlink"
      exit 1
      ;;
    pull)
      # Reading is unaffected -- the files behind the link are real -- so this is a warning.
      warn "sync-routines: pulling anyway; the content behind the link is real"
      ;;
    *) drift=1 ;;
  esac
fi

if link=$(first_symlinked_ancestor "$src_root"); then
  warn "$src_root is reached through a SYMLINK ($link -> $(readlink "$link"))."
  case "$mode" in
    pull)
      # This is the write side for a pull. Publishing through the link would overwrite files in
      # its target -- outside the checkout, where `git diff` cannot show them -- and leave the
      # link standing while reporting the routines pulled. Replacing the link is not this
      # script's call either: routines/ is a tracked directory and somebody put it there.
      warn "sync-routines: refusing to pull into a checkout reached through a symlink; a pull"
      warn "writes, and it would write into $(readlink "$link") and leave the link in place."
      exit 1
      ;;
    *)
      # push and status only READ this side, and the scheduler never opens it.
      warn "sync-routines: reading it anyway; nothing writes to this side in $mode mode"
      ;;
  esac
fi

# A push onto a box whose scheduled-tasks directory does not exist yet has to create it, or
# publish_dir's `mkdir -p` lands nowhere. Status and pull read, so they leave the filesystem
# alone.
if [ "$mode" = push ] && ! $dry_run; then
  mkdir -p "$dest_root"
fi

for r in $RETIRED_ROUTINES; do
  # `-e` alone misses the state an upgraded box is actually IN: the old install loop symlinked
  # the task directory into this checkout, and this change deletes the target, so what is left is
  # a DANGLING link -- invisible to -e, and still named by a live registry entry.
  [ -e "$dest_root/$r" ] || [ -L "$dest_root/$r" ] || continue
  warn "$r: RETIRED, but still installed at $dest_root/$r"
  warn "$r: this repository no longer carries its prompt, and deleting one here does not stop a"
  warn "$r: registered task. Deregister '$r' in the desktop app's scheduled tasks, THEN remove"
  warn "$r: $dest_root/$r. Until both are done it keeps firing."
  case "$mode" in
    status) drift=1 ;;
    *) problems=1 ;;
  esac
done

for r in $LOCAL_ROUTINES; do
  src="$src_root/$r"
  dst="$dest_root/$r"

  # THE SOURCE COMES FIRST, before any branch that might publish it. A push that installs an
  # unusable prompt -- a half-finished local edit with SKILL.md deleted, say -- and then reports
  # success is the false verdict this script exists to remove, and the destination branches below
  # (symlinked, missing, unusable) all publish. `pull` is the exception in the other direction:
  # a broken checkout prompt, up to and including a deleted directory or one linked out of the
  # tree, is what a pull REPAIRS from a usable installed copy, so it reads on and remembers.
  src_broken=0
  if src_problem=$(prompt_problem "$src"); then
    warn "$r: $src $src_problem"
    case "$mode" in
      pull) src_broken=1 ;;
      push)
        warn "$r: refusing to install it -- fix the prompt in this checkout first"
        problems=1
        continue
        ;;
      *) drift=1; continue ;;
    esac
  fi

  if [ -L "$dst" ]; then
    warn "$r: installed as a SYMLINK ($(readlink "$dst")) -- the scheduler cannot read it"
    case "$mode" in
      push)
        if $dry_run; then
          say "$r: would replace the symlink with a real directory"
        elif publish_checked "$src" "$dst"; then
          say "$r: symlink replaced with a real copy"
          copied=$((copied + 1))
        else
          problems=1
        fi
        ;;
      pull)
        # Reading through the link would "pull" the checkout onto itself and call the drift
        # resolved. There is nothing installed to take.
        warn "$r: nothing to pull -- the installed path is a link, not a copy; \`push\` first"
        problems=1
        ;;
      *) drift=1 ;;
    esac
    continue
  fi

  if [ ! -d "$dst" ]; then
    # The registry lives in the desktop app and is not readable from here, so a missing prompt
    # directory says nothing about whether a registry entry names it. Report the fact, not an
    # inference from it.
    warn "$r: no prompt directory at $dst"
    case "$mode" in
      push)
        if $dry_run; then
          say "$r: would install $src -> $dst"
        elif publish_checked "$src" "$dst"; then
          say "$r: prompt installed at $dst"
          say "$r: if the desktop app does not list this task, register it -- a prompt no registry"
          say "$r: entry names never fires, and this script cannot see the registry either way"
          copied=$((copied + 1))
        else
          problems=1
        fi
        ;;
      pull)
        warn "$r: nothing to pull -- there is no installed prompt to take"
        problems=1
        ;;
      *) drift=1 ;;
    esac
    continue
  fi

  # Both sides exist. The installed one can still be a directory that is not a usable prompt, and
  # the comparison below would not notice: `diff -r` FOLLOWS a symlink, so a linked SKILL.md
  # reads as identical, and a missing SKILL.md is not a difference if neither side has one.
  if dst_problem=$(prompt_problem "$dst"); then
    warn "$r: the installed prompt at $dst $dst_problem"
    case "$mode" in
      push)
        # Republishing over it IS the repair, and it must happen whatever the comparison below
        # would have said.
        if $dry_run; then
          say "$r: would republish $src -> $dst"
        elif publish_checked "$src" "$dst"; then
          say "$r: republished to $dst"
          copied=$((copied + 1))
        else
          problems=1
        fi
        ;;
      pull)
        warn "$r: refusing to pull from it -- that would replace the checkout's prompt with an unusable copy"
        problems=1
        ;;
      *) drift=1 ;;
    esac
    continue
  fi

  # The comparison is on diff's OUTPUT, not on its exit code. `diff -r -q` reports a path that is
  # a directory on one side and a regular file on the other by printing the mismatch and exiting
  # 0 (checked on macOS 15), so an exit-code test calls those trees identical -- a silent
  # "in sync" over a destination the scheduler cannot use. Anything diff has to say, including a
  # complaint on stderr, is drift.
  diff_report=$(diff -r -q "$src" "$dst" 2>&1) || true
  # `$src_broken` overrides an empty report, and has to: `diff` FOLLOWS a symlinked SKILL.md, so
  # a checkout prompt that is a link to byte-identical content compares equal while still being
  # a prompt nothing can read. Taking the shortcut there would leave the link standing and call
  # the pull done.
  if [ -z "$diff_report" ] && [ "$src_broken" -eq 0 ]; then
    if [ "$mode" = status ]; then say "$r: in sync"; fi
    continue
  fi

  case "$mode" in
    status)
      # Accept only the complete report reproduced by comparing the two top-level prompts.
      # Let diff format the paths in both reports, including names containing newlines.
      prompt_diff_rc=0
      prompt_report=$(diff -q "$src/SKILL.md" "$dst/SKILL.md" 2>&1) || prompt_diff_rc=$?
      if [ "$prompt_diff_rc" -eq 1 ] && [ -n "$prompt_report" ] && [ "$diff_report" = "$prompt_report" ] \
        && { equals_with_final_lf "$src/SKILL.md" "$dst/SKILL.md" \
          || equals_with_final_lf "$dst/SKILL.md" "$src/SKILL.md"; }; then
        say "$r: in sync (final newline differs)"
        continue
      fi
      say "$r: DRIFT"
      diff -r -u "$src" "$dst" 2>&1 | sed 's/^/    /' || true
      drift=1
      ;;
    push)
      if $dry_run; then
        say "$r: would push $src -> $dst"
      elif publish_checked "$src" "$dst"; then
        say "$r: pushed to $dst"
        copied=$((copied + 1))
      else
        problems=1
      fi
      ;;
    pull)
      if $dry_run; then
        if [ "$src_broken" -eq 1 ]; then
          say "$r: would restore $dst -> $src"
        else
          say "$r: would pull $dst -> $src"
        fi
      elif publish_checked "$dst" "$src"; then
        say "$r: pulled into $src -- review it with git diff"
        copied=$((copied + 1))
      else
        problems=1
      fi
      ;;
  esac
done

if [ "$mode" = status ]; then
  if [ "$drift" -eq 0 ]; then
    say "all local routines in sync with $dest_root"
  else
    say ""
    say "run \`$0 push\` to install this checkout's prompts, or \`pull\` to take the installed ones."
  fi
  exit "$drift"
fi

say ""
if $dry_run; then
  say "dry run: nothing was copied."
else
  say "$copied routine(s) updated."
fi
if [ "$mode" = pull ] && [ "$copied" -gt 0 ]; then
  say "Nothing is committed: review with git diff, then commit here."
fi
if [ "$problems" -ne 0 ]; then
  warn "sync-routines: some routines were not synced (see the lines above)"
fi
exit "$problems"
