#!/usr/bin/env bash
# Exercises sync-routines.sh against scratch trees -- no ~/.claude, no desktop app. The script
# resolves both ends from its own location (routines/ beside its scripts/ directory) and from
# $CLAUDE_SCHEDULED_TASKS_DIR, so every case here runs a byte-identical COPY of the script
# inside a scratch checkout: a `pull` case must never be able to write into the real routines/.
#
# What it pins:
#   - the four states status reports (in sync, drift, installed as a symlink, not installed)
#     and the exit code of each, including the final LF exception for the top-level prompt;
#   - that push replaces a symlink with a real directory instead of writing THROUGH it, which
#     is the whole reason the script exists (desktop app 1.46388.4 refuses a task file reached
#     through a symlink, quietly), and that a destination reached through a link at any component
#     ABOVE the routine directory is refused too, with the same trees under their real path as
#     the control;
#   - that a directory which EXISTS and is still not a usable prompt -- a symlink anywhere
#     inside it, no SKILL.md, or a SKILL.md that is empty or carries no readable frontmatter --
#     is refused rather than certified in sync or pulled over the checkout, in both directions,
#     with legal-but-unusual prompts as the control that the shared check is not refusing everything --
#     including a description that quotes the parser's own markers, and this repository's own
#     prompts -- and that malformed optional fields are refused by both callers of the
#     single frontmatter grammar in check-prompts.sh;
#   - that the two roots must be disjoint, however the overlap is spelled, since a destination
#     under routines/ has the publisher walk the tree it is writing;
#   - that a push never leaves the installed prompt absent or half-written, sampled by a reader
#     running flat out across a series of them, with a control that the reader can report an
#     absence;
#   - that publishing REPLACES what stands in its way rather than following or entering it -- a
#     linked directory at either end, a directory where SKILL.md belongs, a file where a
#     directory belongs -- and reads its own result, so "republished" is not a claim about the
#     commands issued;
#   - that the checkout side is validated BEFORE any branch that would publish it, the
#     not-installed and symlinked-installation branches included;
#   - that a routine file whose name carries a newline is published under the name it has and is
#     not deleted by the pruning pass, `find` being a line-wise producer the way git's path
#     listings were before PR #215 -- with a leftover of the same shape as the control that the
#     pruning still works, and a bystander in the caller's working directory that must survive;
#   - that two modes in one invocation are a usage error, since push and pull write in opposite
#     directions and the last token used to win;
#   - that a RETIRED routine still installed on a box is reported rather than passed over -- the
#     loop iterates this repository's list, so without a tombstone the leftover is invisible --
#     including the DANGLING link an upgraded box is left with, and that the script removes
#     nothing itself, the registry being the desktop app's;
#   - that publishing through a symlinked ANCESTOR is refused at either root and reading through
#     one only warned about: a linked destination root refuses a push, a linked routines/ refuses
#     a pull, and each lets the other direction through;
#   - that --dry-run copies nothing, in every mode, and still says what it would do;
#   - the usage exits: an unknown argument is 2, --help prints the header;
#   - that LOCAL_ROUTINES lists exactly the routines/README.md rows whose Kind is
#     `local scheduled task` (ludics-lite#77), with negative controls that show the comparison
#     can fail -- a claim that cannot fail would be worse than no claim;
#   - that the workflow job running this suite carries no `if:`/`needs:`, since the diff
#     classification calls an all-Markdown PR prompt-only and that is the one shape the pin
#     above exists to catch;
#   - that the tracked mode of sync-routines.sh is 755, which a `> tmp && mv` rewrite drops.
#
# Usage: test-sync-routines.sh   (exit 0 all pass, 1 otherwise)

set -uo pipefail

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape.
{
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SYNC="$HERE/sync-routines.sh"
ROUTINES_README="$ROOT/routines/README.md"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/sync-routines-test.XXXXXX") || exit 1
# Physical path: the script refuses a destination reached through a symlink at ANY component,
# and on macOS $TMPDIR sits under /var, which is a link to /private/var. Every case below wants
# a clean root, so the symlink cases can put the link where they mean it. Directly under the
# allocation, which is where check-scratch-dirs.sh looks and all it looks at (ludics-lite#208).
TMP=$(CDPATH= cd "$TMP" && pwd -P) || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
# Both report and then RETURN 0 explicitly. These are used as `<test> && ok ... || ko ...`, the
# house style, in which anything that makes `ok` itself fail fires `ko` on an assertion that
# held -- a FAIL nobody can reproduce.
ok() { pass=$((pass + 1)); echo "PASS: $*"; return 0; }
ko() { fail=$((fail + 1)); echo "FAIL: $*"; return 0; }
# contains <haystack> <literal needle>, has/hasi <haystack> <extended regex>: the assertions read
# a STRING, never a pipeline into `grep -q`. `grep -q` exits at the first match and closes the
# pipe, so under `set -o pipefail` the writer can take a SIGPIPE and turn a condition that held
# into a false one -- a fixture that fails nondeterministically, which on the routines-table pin
# would be worse than no pin (round 6 of this PR). `case` forks nothing; the here-strings below
# give grep a file, which cannot be SIGPIPEd.
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
has() { grep -qE -- "$2" <<<"$1"; }
hasi() { grep -qiE -- "$2" <<<"$1"; }
# expect <label> <want-rc> <want-substring> -- <cmd...>; leaves the output in $out, rc in $rc.
expect() {
  local label="$1" want_rc="$2" want="$3"; shift 3; [ "$1" = -- ] && shift
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq "$want_rc" ] && contains "$out" "$want"; then ok "$label"
  else ko "$label (rc=$rc want $want_rc; want /$want/) -- $out"; fi
}

# --- the routines this script claims to sync ---------------------------------------------------
# Read off the assignment rather than by sourcing: the script exits on `-h` and does work at
# top level, so it is not sourceable, and the shape the comment promises is a one-line
# LOCAL_ROUTINES="...".
routines_list_of() { sed -n 's/^LOCAL_ROUTINES="\([^"]*\)"[[:space:]]*$/\1/p' "$1"; }
retired_list_of() { sed -n 's/^RETIRED_ROUTINES="\([^"]*\)"[[:space:]]*$/\1/p' "$1"; }
LOCAL_ROUTINES=$(routines_list_of "$SYNC")
RETIRED_ROUTINES=$(retired_list_of "$SYNC")
if [ -n "$LOCAL_ROUTINES" ]; then
  ok "sync-routines.sh declares LOCAL_ROUTINES ($LOCAL_ROUTINES)"
else
  ko "no one-line LOCAL_ROUTINES=\"...\" in $SYNC -- every case below would test nothing"
  echo; echo "$pass passed, $fail failed"; exit 1
fi

# --- a scratch checkout, so `pull` cannot reach the real routines/ ------------------------------
# The routine names come from the script's own list: adding a routine must not mean editing a
# scratch tree here. The prompts are stand-ins -- this suite is about the copying, and
# check-prompts.sh is what judges the real prompts.
REPO="$TMP/repo"
mkdir -p "$REPO/scripts"
# check-prompts.sh forwards to Python (ludics-lite#403): scripts/py finds the interpreter and lib/
# holds the checker, so a checkout that can run it carries all three.
copy_checker() {
  cp "$HERE/check-prompts.sh" "$HERE/py" "$1/scripts/"
  ln -s "$HERE/../lib" "$1/lib"
}
copy_checker "$REPO"
cp "$SYNC" "$REPO/scripts/sync-routines.sh"
chmod +x "$REPO/scripts/sync-routines.sh"
SR="$REPO/scripts/sync-routines.sh"
cmp -s "$SYNC" "$SR" && ok "the scratch copy of the script is byte-identical to the tracked one" \
  || ko "the scratch copy differs from $SYNC -- the cases below judge the wrong bytes"

# reset_trees: a fresh source checkout and an empty install root before each case.
reset_trees() {
  rm -rf "$REPO/routines" "$TMP/installed"
  mkdir -p "$REPO/routines" "$TMP/installed"
  for r in $LOCAL_ROUTINES; do
    mkdir -p "$REPO/routines/$r"
    printf -- '---\nname: %s\ndescription: scratch prompt for %s\n---\n\nbody v1\n' "$r" "$r" \
      > "$REPO/routines/$r/SKILL.md"
  done
}
install_all() {  # a real, in-sync installation, the way a push leaves one
  for r in $LOCAL_ROUTINES; do
    rm -rf "${TMP:?}/installed/$r"
    cp -R "$REPO/routines/$r" "$TMP/installed/$r"
  done
}
first_routine() { set -- $LOCAL_ROUTINES; echo "$1"; }
R1=$(first_routine)
run_sync() { env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/installed" "$SR" "$@"; }

# --- usage --------------------------------------------------------------------------------------
reset_trees; install_all
expect "an unknown argument is refused with exit 2" 2 "unknown argument: --frobnicate" -- \
  run_sync --frobnicate
contains "$out" '--help' \
  && ok "...and points at --help" || ko "the refusal does not mention --help -- $out"

expect "--help prints the header's usage" 0 "sync-routines.sh push" -- run_sync --help
contains "$out" 'symlink' \
  && ok "...including why copies rather than symlinks" || ko "--help drops the symlink lore -- $out"
has "$out" '^#' \
  && ko "--help leaks the comment markers -- $out" || ok "...with the comment markers stripped"
expect "-h is the same" 0 "Exit codes:" -- run_sync -h

# --- status: the four states --------------------------------------------------------------------
reset_trees; install_all
expect "status on a matching pair exits 0" 0 "all local routines in sync" -- run_sync
contains "$out" "$R1: in sync" \
  && ok "...naming each routine" || ko "status does not name $R1 -- $out"
expect "status is also the default with no argument at all" 0 "in sync" -- run_sync status

reset_trees; install_all
src_prompt="$REPO/routines/$R1/SKILL.md"
installed_prompt="$TMP/installed/$R1/SKILL.md"
# The fixture ends in exactly one LF, so command substitution models the editor's save here.
printf '%s' "$(cat "$src_prompt")" > "$installed_prompt"
cp "$src_prompt" "$TMP/checkout-before-status"
cp "$installed_prompt" "$TMP/installed-before-status"
expect "status accepts a missing final LF in the installed prompt" 0 \
  "$R1: in sync (final newline differs)" -- run_sync
cmp -s "$src_prompt" "$TMP/checkout-before-status" \
  && cmp -s "$installed_prompt" "$TMP/installed-before-status" \
  && ok "...without rewriting either prompt" || ko "status changed a prompt during the final LF check"

mkdir -p "$REPO/routines/$R1/extra" "$TMP/installed/$R1/extra"
printf 'companion\n' > "$REPO/routines/$R1/extra/SKILL.md"
printf 'companion' > "$TMP/installed/$R1/extra/SKILL.md"
expect "status still reports a nested SKILL.md difference beside the missing LF" 1 \
  "$R1: DRIFT" -- run_sync

reset_trees; install_all
printf '%s' "$(cat "$installed_prompt")" > "$src_prompt"
expect "status accepts a missing final LF in the checkout prompt" 0 \
  "$R1: in sync (final newline differs)" -- run_sync
printf ' with an edit' >> "$src_prompt"
expect "status reports a prompt edit beside the missing LF" 1 "$R1: DRIFT" -- run_sync

reset_trees; install_all
printf '\n' >> "$installed_prompt"
expect "status reports an extra blank line at EOF" 1 "$R1: DRIFT" -- run_sync

reset_trees; install_all
printf 'body v2 -- edited in the installed copy\n' >> "$TMP/installed/$R1/SKILL.md"
expect "status reports drift with exit 1" 1 "$R1: DRIFT" -- run_sync
contains "$out" 'body v2' \
  && ok "...and shows the differing lines" || ko "the drift report carries no diff -- $out"
contains "$out" 'push' \
  && ok "...and names the way out" || ko "the drift report suggests nothing -- $out"

reset_trees
rm -rf "$TMP/installed/$R1"
ln -s "$REPO/routines/$R1" "$TMP/installed/$R1"
install_all_rest() { for r in $LOCAL_ROUTINES; do [ "$r" = "$R1" ] && continue
  rm -rf "${TMP:?}/installed/$r"; cp -R "$REPO/routines/$r" "$TMP/installed/$r"; done; }
install_all_rest
expect "status calls out a symlinked installation with exit 1" 1 "installed as a SYMLINK" -- run_sync
contains "$out" 'the scheduler cannot read it' \
  && ok "...and says the scheduler cannot read it" || ko "no consequence given -- $out"

reset_trees
expect "status reports a missing prompt directory with exit 1" 1 "no prompt directory at" -- run_sync
# The registry is the desktop app's and unreadable from here, so nothing may be asserted about it
# from the absence of a directory: the line reports the directory, not a registration state.
hasi "$out" 'unregister|not registered|no cron' \
  && ko "the missing-directory line claims something about the registry it cannot read -- $out" \
  || ok "...without inferring anything about the registry from it"

# --- push ---------------------------------------------------------------------------------------
reset_trees; install_all
printf 'body v2\n' >> "$REPO/routines/$R1/SKILL.md"
expect "push copies the checkout's prompt over the installed one" 0 "$R1: pushed to" -- run_sync push
grep -q 'body v2' "$TMP/installed/$R1/SKILL.md" \
  && ok "...and the installed copy now carries the edit" \
  || ko "the installed copy was not updated: $(cat "$TMP/installed/$R1/SKILL.md")"
expect "...leaving status clean" 0 "all local routines in sync" -- run_sync

# The case the change exists for: a directory left over from the symlink era.
reset_trees; install_all
rm -rf "$TMP/installed/$R1"
ln -s "$REPO/routines/$R1" "$TMP/installed/$R1"
printf 'body v2\n' >> "$REPO/routines/$R1/SKILL.md"
expect "push replaces a symlinked installation" 0 "symlink replaced with a real copy" -- run_sync push
[ -d "$TMP/installed/$R1" ] && [ ! -L "$TMP/installed/$R1" ] \
  && ok "...with a real directory the scheduler can open" \
  || ko "$TMP/installed/$R1 is still a symlink after push"
# The negative control on the replacement: `ln -sfn` onto a live link is how the old install loop
# wrote INTO the target instead of over the link. Nothing may have appeared inside the source.
[ ! -e "$REPO/routines/$R1/$R1" ] \
  && ok "...and nothing was written through the link into the checkout" \
  || ko "push wrote into the link target: $REPO/routines/$R1/$R1 exists"
grep -q 'body v2' "$TMP/installed/$R1/SKILL.md" \
  && ok "...carrying the checkout's current prompt" || ko "the replacement copy is stale"

reset_trees
expect "push installs a routine that is not there at all" 0 "prompt installed at" -- run_sync push
[ -f "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...writing a real file" || ko "nothing was installed at $TMP/installed/$R1"
contains "$out" 'never fires' \
  && ok "...while saying a prompt no registry entry names never fires" \
  || ko "push installed silently, saying nothing about registration -- $out"
# ...but conditionally: the directory was missing, which is no evidence the task is unregistered.
hasi "$out" 'is still unregistered|is unregistered|no cron will fire' \
  && ko "push asserts the task is unregistered, which it cannot know from a missing directory -- $out" \
  || ok "...as a thing to check, not as a claim about the registry"

reset_trees
rm -rf "$TMP/installed"
expect "push creates the scheduled-tasks directory on a box that has none" 0 "prompt installed at" -- \
  run_sync push
[ -f "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...and installs into it" || ko "push did not create $TMP/installed"

reset_trees; install_all
rm -rf "$REPO/routines/$R1"
expect "push over a missing source routine exits 1 rather than reporting success" 1 \
  "is not a directory" -- run_sync push
contains "$out" 'were not synced' \
  && ok "...and says so in the summary" || ko "the summary claims a clean push -- $out"

# --- pull ---------------------------------------------------------------------------------------
reset_trees; install_all
printf 'body v2 -- written by the routine mid-run\n' >> "$TMP/installed/$R1/SKILL.md"
expect "pull takes an edit made in the installed copy" 0 "$R1: pulled into" -- run_sync pull
grep -q 'mid-run' "$REPO/routines/$R1/SKILL.md" \
  && ok "...into the checkout" || ko "the checkout was not updated: $(cat "$REPO/routines/$R1/SKILL.md")"
contains "$out" 'Nothing is committed' \
  && ok "...and says the commit is still the caller's" || ko "pull does not mention committing -- $out"

reset_trees; install_all
rm -rf "$TMP/installed/$R1"
ln -s "$REPO/routines/$R1" "$TMP/installed/$R1"
expect "pull refuses to read back through a symlink" 1 "nothing to pull" -- run_sync pull
grep -q 'body v1' "$REPO/routines/$R1/SKILL.md" \
  && ok "...leaving the checkout's prompt alone" || ko "pull mangled the source through the link"

reset_trees
expect "pull with nothing installed exits 1" 1 "nothing to pull" -- run_sync pull

# --- --dry-run copies nothing -------------------------------------------------------------------
reset_trees; install_all
printf 'body v2\n' >> "$REPO/routines/$R1/SKILL.md"
before=$(cat "$TMP/installed/$R1/SKILL.md")
expect "push --dry-run says what it would do" 0 "would push" -- run_sync push --dry-run
[ "$(cat "$TMP/installed/$R1/SKILL.md")" = "$before" ] \
  && ok "...and copies nothing" || ko "push --dry-run wrote to the installed copy"
contains "$out" 'dry run: nothing was copied' \
  && ok "...and does not report routines updated" || ko "the dry run's summary claims work -- $out"
expect "-n is the same flag" 0 "would push" -- run_sync push -n
[ "$(cat "$TMP/installed/$R1/SKILL.md")" = "$before" ] \
  && ok "...and copies nothing either" || ko "push -n wrote to the installed copy"

reset_trees; install_all
printf 'body v2\n' >> "$TMP/installed/$R1/SKILL.md"
src_before=$(cat "$REPO/routines/$R1/SKILL.md")
expect "pull --dry-run copies nothing" 0 "would pull" -- run_sync pull --dry-run
[ "$(cat "$REPO/routines/$R1/SKILL.md")" = "$src_before" ] \
  && ok "...leaving the checkout untouched" || ko "pull --dry-run wrote into the checkout"

reset_trees; install_all
rm -rf "$TMP/installed/$R1"
ln -s "$REPO/routines/$R1" "$TMP/installed/$R1"
expect "push --dry-run over a symlink only says it would replace it" 0 "would replace the symlink" -- \
  run_sync push --dry-run
[ -L "$TMP/installed/$R1" ] \
  && ok "...leaving the symlink in place" || ko "push --dry-run replaced the symlink"

reset_trees
expect "push --dry-run over a missing installation says it would install" 0 "would install" -- \
  run_sync push --dry-run
[ ! -e "$TMP/installed/$R1" ] \
  && ok "...installing nothing" || ko "push --dry-run installed $R1"

# --- a destination reached through a symlink ----------------------------------------------------
# The per-routine check only sees the routine's own directory; the scheduler refuses a task file
# whose path traverses a link at any component, so a symlinked ~/.claude or scheduled-tasks makes
# every $dst a real directory behind a link. Reported "in sync" before this was checked.
reset_trees; install_all
LINKED="$TMP/linked-root"
rm -f "$LINKED"
ln -s "$TMP/installed" "$LINKED"
linked_sync() { env CLAUDE_SCHEDULED_TASKS_DIR="$LINKED" "$SR" "$@"; }

expect "status refuses a destination root that is itself a symlink" 1 "reached through a SYMLINK" -- \
  linked_sync
contains "$out" 'at any component' \
  && ok "...saying the scheduler refuses any component" || ko "no reason given -- $out"
# The negative control on that verdict: the SAME trees reached by their real path are in sync, so
# the exit 1 above is about the link and not about the fixture.
expect "...while the same trees under their real path are in sync" 0 "all local routines in sync" -- \
  run_sync

expect "push refuses to install behind a symlinked root" 1 "refusing to push behind a symlink" -- \
  linked_sync push
# And it refuses before writing: a push that copied first would leave the prompt behind the link.
printf 'body v2\n' >> "$REPO/routines/$R1/SKILL.md"
linked_sync push >/dev/null 2>&1
grep -q 'body v2' "$TMP/installed/$R1/SKILL.md" \
  && ko "the refused push copied anyway" || ok "...copying nothing"
expect "push --dry-run refuses the same way" 1 "refusing to push behind a symlink" -- \
  linked_sync push --dry-run

# A deeper link: the root exists as a real directory, but a component above it is a link.
reset_trees; install_all
mkdir -p "$TMP/deep/real"
rm -f "$TMP/deep/link"
ln -s "$TMP/deep/real" "$TMP/deep/link"
mkdir -p "$TMP/deep/real/tasks"
for r in $LOCAL_ROUTINES; do cp -R "$REPO/routines/$r" "$TMP/deep/real/tasks/$r"; done
expect "status refuses when a component ABOVE the destination is the link" 1 \
  "reached through a SYMLINK" -- env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/deep/link/tasks" "$SR"
contains "$out" "$TMP/deep/link" \
  && ok "...naming the component that is the link" || ko "the refusal does not name the link -- $out"
# The control: the same tree by its real path is in sync, so the refusal is the link's doing.
expect "...while the real path of that same tree is in sync" 0 "all local routines in sync" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/deep/real/tasks" "$SR"

# pull is a read: the files behind the link are real, so it warns and proceeds rather than refusing.
reset_trees; install_all
printf 'body v2 -- written by the routine mid-run\n' >> "$TMP/installed/$R1/SKILL.md"
expect "pull behind a symlinked root warns but proceeds" 0 "pulling anyway" -- linked_sync pull
grep -q 'mid-run' "$REPO/routines/$R1/SKILL.md" \
  && ok "...taking the edit, since the content behind the link is real" \
  || ko "pull behind the link took nothing"
# That asymmetry -- push refuses, status reports, pull proceeds -- is a contract callers read out
# of `--help`, so the help text has to state it. A behaviour change fails the cases above; a help
# text that promises a refusal pull does not perform fails this one.
out=$(run_sync --help 2>&1)
contains "$out" "refuses a push and lets a pull through" \
  && ok "...and --help says so, rather than promising a refusal in every mode" \
  || ko "--help does not state pull's behaviour behind a symlinked destination root -- callers would read the wrong exit contract"
contains "$out" "refuses a PULL and lets a push through" \
  && ok "...and states the mirror rule for a symlinked checkout root" \
  || ko "--help does not state the source-root rule -- $out"

# --- the CHECKOUT root reached through a symlink --------------------------------------------------
# The mirror of the destination-root case, and the one prompt_problem cannot see: if `routines/`
# itself is a link, each routine directory under it is perfectly normal. A pull publishes into
# that side, so it would write into the link's target -- outside the checkout, where `git diff`
# will not show it -- and leave the link standing while reporting the routines pulled.
reset_trees; install_all
printf 'body v2 -- the installed edit\n' >> "$TMP/installed/$R1/SKILL.md"
mkdir -p "$TMP/outside-routines"
for r in $LOCAL_ROUTINES; do
  mkdir -p "$TMP/outside-routines/$r"
  printf -- '---\nname: %s\ndescription: external prompt for %s\n---\n\nexternal prompt nobody asked to change\n' \
    "$r" "$r" > "$TMP/outside-routines/$r/SKILL.md"
done
LINKREPO="$TMP/linkrepo"
rm -rf "$LINKREPO"
mkdir -p "$LINKREPO/scripts"
copy_checker "$LINKREPO"
cp "$SYNC" "$LINKREPO/scripts/sync-routines.sh"
chmod +x "$LINKREPO/scripts/sync-routines.sh"
ln -s "$TMP/outside-routines" "$LINKREPO/routines"
linked_src() { env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/installed" "$LINKREPO/scripts/sync-routines.sh" "$@"; }

expect "pull refuses a checkout whose routines/ is a symlink" 1 "refusing to pull into a checkout" -- \
  linked_src pull
grep -q 'external prompt nobody asked to change' "$TMP/outside-routines/$R1/SKILL.md" \
  && ok "...writing nothing into the link's target" \
  || ko "the refused pull wrote into $TMP/outside-routines: $(cat "$TMP/outside-routines/$R1/SKILL.md")"
[ -L "$LINKREPO/routines" ] \
  && ok "...and leaving the link alone, since routines/ is not this script's to replace" \
  || ko "the link was replaced"
# push and status only READ that side, and the scheduler never opens it, so they go on with a
# warning. This is the control that the refusal above is about WRITING and not about the link.
expect "...while push reads through it and says so" 0 "reading it anyway" -- linked_src push
grep -q 'external prompt' "$TMP/installed/$R1/SKILL.md" \
  && ok "...having installed what is behind the link" || ko "push through the link installed nothing"
expect "...and status reads through it too" 0 "all local routines in sync" -- linked_src

# --- an installed directory that exists and is not a usable prompt -------------------------------
# `-L "$dst"` sees only the routine's own directory and `diff -r` FOLLOWS a link, so an installed
# SKILL.md that is a link to the byte-identical checkout file used to read as "in sync" over an
# installation the scheduler refuses. And a directory whose SKILL.md was deleted used to read as
# drift and be PULLED, deleting the checkout's tracked prompt.
reset_trees; install_all
rm -f "$TMP/installed/$R1/SKILL.md"
ln -s "$REPO/routines/$R1/SKILL.md" "$TMP/installed/$R1/SKILL.md"
expect "status refuses an installed SKILL.md that is a symlink" 1 "holds a symlink" -- run_sync
has "$out" "^$R1: in sync" \
  && ko "it still called $R1 in sync while following the link -- $out" \
  || ok "...rather than following it into an in-sync verdict"
# The control: the same trees with a real, byte-identical SKILL.md ARE in sync, so the refusal is
# the link's doing and not the fixture's.
reset_trees; install_all
expect "...while the identical bytes as a real file are in sync" 0 "all local routines in sync" -- run_sync

reset_trees; install_all
rm -f "$TMP/installed/$R1/SKILL.md"
ln -s "$REPO/routines/$R1/SKILL.md" "$TMP/installed/$R1/SKILL.md"
expect "push republishes over a symlinked prompt file" 0 "republished to" -- run_sync push
[ -f "$TMP/installed/$R1/SKILL.md" ] && [ ! -L "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...leaving a real file the scheduler can open" \
  || ko "the installed SKILL.md is still a symlink after push"
expect "...and status is clean afterwards" 0 "all local routines in sync" -- run_sync

reset_trees; install_all
rm -f "$TMP/installed/$R1/SKILL.md"
ln -s "$REPO/routines/$R1/SKILL.md" "$TMP/installed/$R1/SKILL.md"
expect "pull refuses a symlinked installed prompt" 1 "refusing to pull from it" -- run_sync pull
grep -q 'body v1' "$REPO/routines/$R1/SKILL.md" \
  && ok "...leaving the checkout's prompt alone" || ko "pull mangled the checkout"

# A nested link, to show the check is about the whole tree and not about SKILL.md alone.
reset_trees; install_all
mkdir -p "$TMP/installed/$R1/refs"
ln -s "$REPO/routines/$R1/SKILL.md" "$TMP/installed/$R1/refs/copy.md"
expect "status refuses a link nested deeper in the installed directory" 1 "holds a symlink" -- run_sync

# The other way a directory exists and is not a prompt.
reset_trees; install_all
rm -f "$TMP/installed/$R1/SKILL.md"
expect "status refuses an installed directory with no SKILL.md" 1 "has no SKILL.md" -- run_sync
expect "...and pull refuses to take it" 1 "refusing to pull from it" -- run_sync pull
[ -f "$REPO/routines/$R1/SKILL.md" ] \
  && ok "...so the checkout's tracked prompt survives" \
  || ko "pull deleted $REPO/routines/$R1/SKILL.md"
expect "...while push republishes into it" 0 "republished to" -- run_sync push
[ -f "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...restoring the prompt" || ko "push did not restore the installed SKILL.md"

# The same reader over the checkout side: pushing a broken prompt is refused, pulling onto it is
# the repair and is allowed.
reset_trees; install_all
rm -f "$REPO/routines/$R1/SKILL.md"
expect "push refuses a checkout directory with no SKILL.md" 1 "refusing to install it" -- run_sync push
grep -q 'body v1' "$TMP/installed/$R1/SKILL.md" \
  && ok "...leaving the installed prompt alone" || ko "the refused push wrote to the installed copy"
expect "...while pull onto it is allowed, since that is the repair" 0 "pulled into" -- run_sync pull
[ -f "$REPO/routines/$R1/SKILL.md" ] \
  && ok "...restoring the checkout's prompt" || ko "pull did not restore $REPO/routines/$R1/SKILL.md"

# --- a regular file is not yet a prompt -----------------------------------------------------------
# A zero-byte or frontmatter-less SKILL.md installs happily and then compares equal to itself, so
# push would replace a working prompt with one the loaders can read no name, no description and no
# body out of -- the same quiet nothing-ran as an unreadable file, by a different route. The shared check
# below delegates to check-prompts.sh instead of reimplementing its grammar.
for defect in empty no-fence unclosed no-name no-description; do
  reset_trees; install_all
  case "$defect" in
    empty)          : > "$REPO/routines/$R1/SKILL.md" ;;
    no-fence)       printf 'name: %s\n\nbody\n' "$R1" > "$REPO/routines/$R1/SKILL.md" ;;
    unclosed)       printf -- '---\nname: %s\ndescription: d\n\nbody\n' "$R1" > "$REPO/routines/$R1/SKILL.md" ;;
    no-name)        printf -- '---\ndescription: d\n---\n\nbody\n' > "$REPO/routines/$R1/SKILL.md" ;;
    no-description) printf -- '---\nname: %s\n---\n\nbody\n' "$R1" > "$REPO/routines/$R1/SKILL.md" ;;
  esac
  expect "push refuses a checkout SKILL.md that is $defect" 1 "refusing to install it" -- run_sync push
  grep -q 'body v1' "$TMP/installed/$R1/SKILL.md" \
    && ok "...leaving the working installed prompt in place" \
    || ko "the $defect prompt replaced the installed one"
  expect "...and status calls it out" 1 "$R1: $REPO/routines/$R1" -- run_sync
done
# The same shared check on the installed side.
reset_trees; install_all
: > "$TMP/installed/$R1/SKILL.md"
expect "status refuses an installed SKILL.md that is empty" 1 "no YAML frontmatter" -- run_sync
expect "...pull refuses to take it" 1 "refusing to pull from it" -- run_sync pull
[ -s "$REPO/routines/$R1/SKILL.md" ] \
  && ok "...leaving the checkout's prompt alone" || ko "pull emptied the checkout's prompt"
expect "...while push republishes over it" 0 "republished to" -- run_sync push
[ -s "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...restoring a real prompt" || ko "the installed prompt is still empty"

# The control: a well-formed prompt with unusual but legal content passes, so the shared check is not
# just refusing everything. CRLF is refused consistently with repository validation.
reset_trees; install_all
printf -- '---\r\nname: %s\r\ndescription: a prompt with CRLF line endings\r\n---\r\n\r\nbody\r\n' \
  "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "CRLF is refused by the shared LF grammar" 1 "no YAML frontmatter" -- run_sync push
expect "...and status reports the same defect" 1 "no YAML frontmatter" -- run_sync
reset_trees; install_all
expect "...as does the ordinary one, which is the baseline for all of the above" 0 "in sync" -- run_sync

# --- delegated field and body validation ------------------------------------------------------
# The first draft of it was three ad-hoc tests. Each of these is a shape it got wrong.
reset_trees; install_all
printf -- '---\nname:\ndescription: d\n---\n\nbody\n' > "$REPO/routines/$R1/SKILL.md"
expect "push refuses a name: with no value" 1 "frontmatter 'name:' has no value" -- run_sync push
reset_trees; install_all
printf -- '---\nname: %s\ndescription:   \n---\n\nbody\n' "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "...and a description: that is only whitespace" 1 "frontmatter 'description:' has no value" -- run_sync push
reset_trees; install_all
printf -- '---\nx-name: %s\nx-description: d\n---\n\nbody\n' "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "...and keys that merely CONTAIN the field names" 1 "frontmatter has no 'name:' line" -- run_sync push
reset_trees; install_all
printf -- '---\nname: %s\ndescription: d\n---\n' "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "...and frontmatter with no prompt under it" 1 "no prompt to run" -- run_sync push
reset_trees; install_all
printf -- '---\nname: %s\ndescription: d\n---\n   \n\t\n' "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "...including a body of nothing but whitespace" 1 "no prompt to run" -- run_sync push
grep -q 'body v1' "$TMP/installed/$R1/SKILL.md" \
  && ok "...with the working installation left in place throughout" \
  || ko "one of the refused pushes still replaced the installed prompt"

# The other direction: shapes that are legal must PASS, or the shared check is just a wall. A value that
# contains the parser's own vocabulary is the one that caught an in-band marker.
reset_trees; install_all
printf -- '---\nname: %s\ndescription: Reports an @@UNCLOSED@@ parser state, and --- fences\n---\n\nbody v2\n' \
  "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "a description that quotes the parser's own markers is a valid prompt" 0 "pushed to" -- run_sync push
expect "...and reads as in sync afterwards" 0 "all local routines in sync" -- run_sync
reset_trees; install_all
printf -- '---\nname: %s\ndescription: d\nallowed-tools: Bash, Read\n---\n\nbody v2\n' \
  "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "...as is frontmatter carrying keys this shared check does not know" 0 "pushed to" -- run_sync push
# The repository's own prompts are the last word: whatever this shared check is, they must pass it.
for r in $LOCAL_ROUTINES; do
  out=$(env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/probe-$r" "$SYNC" 2>&1) || true
  contains "$out" "routines/$r has" \
    && ko "the shared check rejects this repository's own $r prompt: $out" \
    || ok "this repository's $r prompt passes the shared check"
done

# A missing validator must refuse, never turn failed delegation into a clean verdict.
reset_trees; install_all
mv "$REPO/scripts/check-prompts.sh" "$REPO/scripts/check-prompts.saved"
expect "missing grammar owner fails closed" 1 'rejected by check-prompts' -- run_sync push
mv "$REPO/scripts/check-prompts.saved" "$REPO/scripts/check-prompts.sh"
expect "restoring the grammar owner restores the control" 0 'all local routines in sync' -- run_sync

# The shared grammar is pinned from both callers with a malformed optional field.
reset_trees; install_all
printf -- '---\nname: %s\ndescription: d\nallowed-tools: [\n---\n\nbody v2\n' \
  "$R1" > "$REPO/routines/$R1/SKILL.md"
expect "sync delegates malformed OPTIONAL fields to the grammar owner" 1 "allowed-tools" -- \
  run_sync push
CPTREE="$TMP/cptree"
rm -rf "$CPTREE"
mkdir -p "$CPTREE/routines/$R1"
cp "$REPO/routines/$R1/SKILL.md" "$CPTREE/routines/$R1/SKILL.md"
cp "$ROOT/routines/README.md" "$CPTREE/routines/README.md"
cp "$ROOT/README.md" "$CPTREE/README.md"
if [ -x "$ROOT/scripts/check-prompts.sh" ]; then
  cp_out=$("$ROOT/scripts/check-prompts.sh" "$CPTREE" 2>&1) || true
  contains "$cp_out" "allowed-tools" \
    && ok "...while check-prompts.sh, which owns the grammar, refuses that same file" \
    || ko "check-prompts.sh does not catch a malformed optional field either, so nothing does: $cp_out"
  # The control: with the value made well-formed, the checker passes the same tree, so the
  # refusal above is the malformed value and not the scratch tree.
  printf -- '---\nname: %s\ndescription: d\nallowed-tools: Bash\n---\n\nbody v2\n' \
    "$R1" > "$CPTREE/routines/$R1/SKILL.md"
  cp_out=$("$ROOT/scripts/check-prompts.sh" "$CPTREE" 2>&1) || true
  contains "$cp_out" "allowed-tools" \
    && ko "the checker complains about a well-formed optional field too: $cp_out" \
    || ok "...and passes it once the value is well-formed"
else
  ko "no $ROOT/scripts/check-prompts.sh to compare against -- the division above is unpinned"
fi

# --- the two roots must be disjoint ---------------------------------------------------------------
# A destination under the checkout's routines/ makes push create the destination INSIDE the
# source, after which `find "$src"` walks the tree it is writing and the installation is copied
# into the canonical prompts.
reset_trees; install_all
before=$(cat "$REPO/routines/$R1/SKILL.md")
inside="$REPO/routines/$R1/installed"
expect "a destination inside the checkout's routines/ is refused with exit 2" 2 \
  "is inside the checkout's routines/" -- env CLAUDE_SCHEDULED_TASKS_DIR="$inside" "$SR" push
[ ! -e "$inside" ] \
  && ok "...before anything is created under the tracked prompts" || ko "$inside was created"
[ "$(cat "$REPO/routines/$R1/SKILL.md")" = "$before" ] \
  && ok "...and the tracked prompt is untouched" || ko "the refused push modified the checkout"
expect "...and status refuses it too, not just the writing modes" 2 "is inside the checkout" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$inside" "$SR"
expect "the routines/ directory itself as a destination is refused" 2 "are the same directory" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$REPO/routines" "$SR" push
expect "...and a destination that CONTAINS it" 2 "contains the checkout's routines/" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$REPO" "$SR" push
# Spelled through a link, the overlap must still be seen: the comparison is on physical paths.
rm -f "$TMP/routes-link"
ln -s "$REPO/routines" "$TMP/routes-link"
expect "...however the overlap is spelled" 2 "are the same directory" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/routes-link" "$SR" push
# ...and however it is SPELLED. A `..` after a component that does not exist yet is folded by the
# filesystem the moment `mkdir -p` creates that component, so it has to be folded here first --
# otherwise the comparison sees two disjoint paths and the push then writes into the checkout.
reset_trees; install_all
before=$(cat "$REPO/routines/$R1/SKILL.md")
expect "a destination reaching routines/ through a not-yet-existing component and .. is refused" 2 \
  "are the same directory" -- env CLAUDE_SCHEDULED_TASKS_DIR="$REPO/routines/missing/../../routines" "$SR" push
[ ! -e "$REPO/routines/missing" ] \
  && ok "...without creating the component it was spelled through" \
  || ko "$REPO/routines/missing was created"
[ "$(cat "$REPO/routines/$R1/SKILL.md")" = "$before" ] \
  && ok "...and the tracked prompt is untouched" || ko "the refused push modified the checkout"
expect "...and one that lands BELOW routines/ the same way" 2 "is inside the checkout's routines/" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/nope/../$(basename "$REPO")/routines/$R1/installed" "$SR" push
expect "...as does a plain ./ and ../ walk onto it" 2 "are the same directory" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$REPO/./routines/$R1/.." "$SR" push
# The filesystem root contains everything, this checkout included, and is the one parent a naive
# prefix test gets wrong: "/" plus "/" is "//", which matches no ordinary path.
expect "the filesystem root as a destination is refused, not treated as disjoint" 2 \
  "contains the checkout's routines/" -- env CLAUDE_SCHEDULED_TASKS_DIR=/ "$SR" push
expect "...in dry-run too, which would otherwise print what it would install under /" 2 \
  "contains the checkout's routines/" -- env CLAUDE_SCHEDULED_TASKS_DIR=/ "$SR" push --dry-run
contains "$out" "would install /" \
  && ko "it still proposed installing at the root -- $out" \
  || ok "...proposing nothing"
[ ! -e "/$R1" ] && ok "...and creating nothing there" || ko "/$R1 exists"

# A path component that is a glob pattern must be read as the literal name it is. The component
# loops split on `/` with an unquoted expansion, which globs as well as splits, so a component
# like `r*` would be replaced by whatever it matches in the CALLER's working directory -- and the
# script would then judge a path nobody gave it.
reset_trees; install_all
mkdir -p "$TMP/globdir/real"
for r in $LOCAL_ROUTINES; do cp -R "$REPO/routines/$r" "$TMP/globdir/real/$r"; done
rm -f "$TMP/globdir/r*"
ln -s "$TMP/globdir/real" "$TMP/globdir/r*"
( cd "$REPO" && env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/globdir/r*/" "$SR" push --dry-run ) \
  > "$TMP/glob.out" 2>&1 && glob_rc=0 || glob_rc=$?
glob_out=$(cat "$TMP/glob.out")
[ "$glob_rc" -eq 1 ] && contains "$glob_out" "reached through a SYMLINK" \
  && ok "a destination component that looks like a glob is read as the literal name" \
  || ko "the glob-named symlinked root was not refused (rc=$glob_rc) -- $glob_out"
# The control: the same destination by its real name is not refused, so the refusal above is the
# link and not the metacharacter.
( cd "$REPO" && env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/globdir/real" "$SR" ) > "$TMP/glob2.out" 2>&1 \
  && glob_rc=0 || glob_rc=$?
[ "$glob_rc" -eq 0 ] \
  && ok "...while the same tree by its real name is in sync" \
  || ko "the control run failed (rc=$glob_rc) -- $(cat "$TMP/glob2.out")"
# And a ROUTINE name holding a metacharacter must not expand either: the install loop splits
# LOCAL_ROUTINES the same way.
GLOBREPO="$TMP/globrepo"
rm -rf "$GLOBREPO"
mkdir -p "$GLOBREPO/scripts" "$GLOBREPO/routines"
sed 's/^LOCAL_ROUTINES=.*/LOCAL_ROUTINES="ro*tine"/' "$SYNC" > "$GLOBREPO/scripts/sync-routines.sh"
chmod +x "$GLOBREPO/scripts/sync-routines.sh"
mkdir -p "$GLOBREPO/routines/routine-that-would-match"
printf -- '---\nname: x\ndescription: d\n---\n\nbody\n' \
  > "$GLOBREPO/routines/routine-that-would-match/SKILL.md"
out=$( cd "$GLOBREPO/routines" && env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/globdest" \
  "$GLOBREPO/scripts/sync-routines.sh" 2>&1 ) || true
contains "$out" "ro*tine" \
  && ok "...and a routine name holding a metacharacter is reported as itself" \
  || ko "the routine name expanded against the working directory -- $out"
contains "$out" "routine-that-would-match" \
  && ko "it reported a directory the name merely matched -- $out" \
  || ok "...not as the directory it happens to match"

# The control: a `..` walk that genuinely lands OUTSIDE the checkout is not refused, so the
# folding is not simply refusing anything with a dot segment in it. (It walks through components
# that exist, since a path whose parent has yet to be created does not resolve for a READ either.)
expect "...while a .. walk that lands outside the checkout is fine" 0 "all local routines in sync" -- \
  env CLAUDE_SCHEDULED_TASKS_DIR="$REPO/../installed" "$SR"

# The control: a destination outside the checkout is not refused.
expect "...while a destination outside the checkout is fine" 0 "all local routines in sync" -- run_sync

# --- publishing keeps a readable prompt at every instant -----------------------------------------
# The scheduler opens $dst/SKILL.md by the path the registry stores. The first draft removed the
# directory and moved a staged one into place, so a dispatch between the two saw no path at all --
# the same silent stale-dispatch failure the script exists to prevent. Files are staged inside the
# destination and renamed onto their final names instead, so the prompt is never absent.
reset_trees; install_all
# A reader running flat out across a SERIES of pushes: every sample must find the file, and must
# read it as one whole version or the other, never as a partial write or an absence. One push is
# over too quickly to sample meaningfully.
watcher_log="$TMP/reader.log"
: > "$watcher_log"
rm -f "$TMP/reader.stop"
( while [ ! -f "$TMP/reader.stop" ]; do
    if [ -f "$TMP/installed/$R1/SKILL.md" ]; then
      if grep -q 'body v[12]$' "$TMP/installed/$R1/SKILL.md" 2>/dev/null; then printf 'whole\n'
      else printf 'PARTIAL\n'; fi
    else
      printf 'MISSING\n'
    fi
  done >> "$watcher_log" ) &
watcher=$!
i=0
while [ "$i" -lt 12 ]; do
  if [ $((i % 2)) -eq 0 ]; then v=2; else v=1; fi
  printf -- '---\nname: %s\ndescription: scratch prompt for %s\n---\n\nbody v%s\n' \
    "$R1" "$R1" "$v" > "$REPO/routines/$R1/SKILL.md"
  run_sync push >/dev/null 2>&1
  i=$((i + 1))
done
: > "$TMP/reader.stop"
wait "$watcher" 2>/dev/null
samples=$(grep -c . "$watcher_log" 2>/dev/null) || true  # grep -c exits 1 on zero matches
[ "${samples:-0}" -gt 20 ] \
  && ok "the reader sampled the installed prompt $samples times across 12 pushes" \
  || ko "only ${samples:-0} samples taken -- too few for the absence check below to mean anything"
grep -q 'MISSING' "$watcher_log" \
  && ko "the prompt was absent during a push: a dispatch in that window reads nothing" \
  || ok "...and never once found it absent"
grep -q 'PARTIAL' "$watcher_log" \
  && ko "the reader saw a half-written prompt during a push" \
  || ok "...nor half-written: every sample was one whole version"
rm -f "$TMP/reader.stop"
# The negative control on the reader itself: with the prompt genuinely removed it must say MISSING,
# or the verdict above is a check that cannot fail.
: > "$watcher_log"
( while [ ! -f "$TMP/reader.stop" ]; do
    if [ -f "$TMP/installed/$R1/SKILL.md" ]; then printf 'present\n'; else printf 'MISSING\n'; fi
  done >> "$watcher_log" ) &
watcher=$!
rm -rf "$TMP/installed/$R1"
sleep 1
: > "$TMP/reader.stop"
wait "$watcher" 2>/dev/null
grep -q 'MISSING' "$watcher_log" \
  && ok "the reader reports MISSING when the prompt really is gone, so the check above can fail" \
  || ko "the reader never noticed a removed prompt -- the absence verdict above means nothing"
rm -f "$TMP/reader.stop"

# Publishing also prunes what the source no longer has, or a stale file outlives its prompt.
reset_trees; install_all
printf 'stale\n' > "$TMP/installed/$R1/leftover.md"
expect "push prunes a file the checkout no longer has" 0 "pushed to" -- run_sync push
[ ! -e "$TMP/installed/$R1/leftover.md" ] \
  && ok "...removing it" || ko "leftover.md survived the push"
[ -f "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...while the prompt itself stays" || ko "the push pruned SKILL.md too"

# --- publishing replaces what stands in its way, and reads its own result ------------------------
# Every branch that publishes had a way to "succeed" over a destination that was still not a
# usable prompt. `mkdir -p` follows a link; `mv -f file dir/` moves the file INTO the directory
# instead of replacing it; and nothing read the result afterwards.

# The P1 shape: pull repairing a checkout whose routine directory is a LINK out of the tree.
reset_trees; install_all
printf 'body v2 -- the installed edit to recover\n' >> "$TMP/installed/$R1/SKILL.md"
mkdir -p "$TMP/outside"
printf 'external content nobody asked to change\n' > "$TMP/outside/SKILL.md"
rm -rf "$REPO/routines/$R1"
ln -s "$TMP/outside" "$REPO/routines/$R1"
expect "pull replaces a symlinked checkout routine instead of writing through it" 0 "pulled into" -- \
  run_sync pull
[ -d "$REPO/routines/$R1" ] && [ ! -L "$REPO/routines/$R1" ] \
  && ok "...leaving a real directory in the checkout" \
  || ko "$REPO/routines/$R1 is still a symlink after pull"
grep -q 'external content nobody asked to change' "$TMP/outside/SKILL.md" \
  && ok "...and the link's target is untouched" \
  || ko "pull wrote through the link into $TMP/outside: $(cat "$TMP/outside/SKILL.md")"
grep -q 'the installed edit to recover' "$REPO/routines/$R1/SKILL.md" \
  && ok "...while the installed edit did land in the checkout" || ko "the pull took nothing"

# The same for push onto a destination whose routine directory is a link -- covered above by the
# symlink-installation case, and here through publish_dir's own guard, with the target checked.
reset_trees; install_all
mkdir -p "$TMP/outside2"
printf 'external\n' > "$TMP/outside2/SKILL.md"
rm -rf "$TMP/installed/$R1"
ln -s "$TMP/outside2" "$TMP/installed/$R1"
expect "push replaces a symlinked installation without writing through it" 0 "symlink replaced" -- \
  run_sync push
grep -q '^external$' "$TMP/outside2/SKILL.md" \
  && ok "...leaving the link's target untouched" \
  || ko "push wrote through the link into $TMP/outside2: $(cat "$TMP/outside2/SKILL.md")"

# A DIRECTORY standing where SKILL.md belongs: `mv -f` would move the staged file inside it.
reset_trees; install_all
rm -f "$TMP/installed/$R1/SKILL.md"
mkdir -p "$TMP/installed/$R1/SKILL.md"
printf 'junk\n' > "$TMP/installed/$R1/SKILL.md/inner.txt"
expect "push replaces a directory standing where SKILL.md belongs" 0 "republished to" -- run_sync push
[ -f "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...with a regular file" \
  || ko "$TMP/installed/$R1/SKILL.md is still not a regular file: $(ls -ld "$TMP/installed/$R1/SKILL.md" 2>&1)"
expect "...so the next status is clean" 0 "all local routines in sync" -- run_sync

# And the other way round: a FILE standing where a directory belongs.
reset_trees
mkdir -p "$REPO/routines/$R1/refs"
printf 'ref\n' > "$REPO/routines/$R1/refs/note.md"
install_all
rm -rf "$TMP/installed/$R1/refs"
printf 'not a directory\n' > "$TMP/installed/$R1/refs"
# `diff -r -q` PRINTS this mismatch and exits 0, so the drift test reads its output, not its
# status; an exit-code test called these trees identical.
expect "status calls a directory-versus-file mismatch drift" 1 "$R1: DRIFT" -- run_sync
expect "push replaces a file standing where a directory belongs" 0 "pushed to" -- run_sync push
[ -f "$TMP/installed/$R1/refs/note.md" ] \
  && ok "...creating the directory below it" || ko "refs/note.md was not published"

# A symlink TO A DIRECTORY at SKILL.md's name: `mv -f` follows it too (checked on macOS 15 --
# the link survived and the staged file landed in its target), so the guard tests -d, which
# follows the link, rather than "is not a link".
reset_trees; install_all
mkdir -p "$TMP/linktarget"
rm -f "$TMP/installed/$R1/SKILL.md"
ln -s "$TMP/linktarget" "$TMP/installed/$R1/SKILL.md"
expect "push replaces a link-to-a-directory standing at SKILL.md" 0 "republished to" -- run_sync push
[ -f "$TMP/installed/$R1/SKILL.md" ] && [ ! -L "$TMP/installed/$R1/SKILL.md" ] \
  && ok "...with a regular file" || ko "SKILL.md is still a link after push"
[ -z "$(ls -A "$TMP/linktarget")" ] \
  && ok "...and nothing was written through it into the link's target" \
  || ko "push wrote into $TMP/linktarget: $(ls -A "$TMP/linktarget")"

# --- pull is the repair, up to a checkout routine that is gone -----------------------------------
# "pull repairs the checkout" has to include the plainest breakages, or the recovery command
# cannot recover. status and push still refuse: only pull reads on past a broken source.
reset_trees; install_all
printf 'body v2 -- the installed edit\n' >> "$TMP/installed/$R1/SKILL.md"
rm -rf "$REPO/routines/$R1"
expect "pull restores a checkout routine that was deleted" 0 "pulled into" -- run_sync pull
[ -f "$REPO/routines/$R1/SKILL.md" ] \
  && ok "...recreating its directory" || ko "$REPO/routines/$R1/SKILL.md was not restored"
grep -q 'the installed edit' "$REPO/routines/$R1/SKILL.md" \
  && ok "...with the installed copy's content" || ko "the restored prompt is not the installed one"
expect "...leaving status clean" 0 "all local routines in sync" -- run_sync

reset_trees; install_all
rm -rf "$REPO/routines/$R1"
expect "status still calls a deleted checkout routine a problem" 1 "is not a directory" -- run_sync
expect "...and push still refuses to install one" 1 "refusing to install it" -- run_sync push

reset_trees; install_all
rm -rf "$REPO/routines/$R1"
expect "pull --dry-run says it would restore it, and does not" 0 "would restore" -- run_sync pull --dry-run
[ ! -e "$REPO/routines/$R1" ] \
  && ok "...restoring nothing" || ko "pull --dry-run wrote $REPO/routines/$R1"

# A checkout routine linked out of the tree: the link is replaced, its target untouched.
reset_trees; install_all
mkdir -p "$TMP/outside3"
printf 'external\n' > "$TMP/outside3/SKILL.md"
rm -rf "$REPO/routines/$R1"
ln -s "$TMP/outside3" "$REPO/routines/$R1"
expect "pull replaces a checkout routine that is a symlink" 0 "pulled into" -- run_sync pull
[ -d "$REPO/routines/$R1" ] && [ ! -L "$REPO/routines/$R1" ] \
  && ok "...with a real directory" || ko "$REPO/routines/$R1 is still a link"
grep -q '^external$' "$TMP/outside3/SKILL.md" \
  && ok "...and the link's target untouched" || ko "pull wrote through the link"

# The one the diff shortcut hid: a checkout SKILL.md that is a LINK to byte-identical content.
# `diff` follows it and reports no difference, so the pull used to exit 0 having done nothing.
reset_trees; install_all
rm -f "$REPO/routines/$R1/SKILL.md"
ln -s "$TMP/installed/$R1/SKILL.md" "$REPO/routines/$R1/SKILL.md"
expect "pull repairs a linked checkout SKILL.md whose bytes already match" 0 "pulled into" -- \
  run_sync pull
[ -f "$REPO/routines/$R1/SKILL.md" ] && [ ! -L "$REPO/routines/$R1/SKILL.md" ] \
  && ok "...replacing the link with a real file" \
  || ko "the checkout SKILL.md is still a link, and the pull claimed to be done"
expect "...so status no longer calls the checkout unusable" 0 "all local routines in sync" -- run_sync
expect "...and a following push does not refuse it" 0 "routine(s) updated" -- run_sync push
# The control: identical bytes as a REAL file are in sync and pull does nothing, so the case
# above is the link's doing.
reset_trees; install_all
out=$(run_sync pull 2>&1); rc=$?
[ "$rc" -eq 0 ] && contains "$out" '0 routine(s) updated' \
  && ok "...while identical real files leave pull with nothing to do" \
  || ko "pull copied over trees that already match (rc=$rc) -- $out"

# --- a failing publish is a failure, not a success over the old contents -------------------------
# publish_checked is called as an `if` condition, which suspends `set -e` for the whole call, so
# every step inside publish_dir checks itself. And presence is not enough afterwards: a `cp` that
# failed leaves the OLD prompt standing, which satisfies "there is a SKILL.md".
reset_trees; install_all
printf 'body v2 -- must not be reported as published\n' >> "$REPO/routines/$R1/SKILL.md"
mkdir -p "$TMP/failbin"
printf '#!/bin/sh\nexit 1\n' > "$TMP/failbin/cp"
chmod +x "$TMP/failbin/cp"
out=$(env PATH="$TMP/failbin:$PATH" CLAUDE_SCHEDULED_TASKS_DIR="$TMP/installed" "$SR" push 2>&1); rc=$?
[ "$rc" -eq 1 ] \
  && ok "a push whose cp fails exits 1" || ko "push with a failing cp exited $rc -- $out"
contains "$out" "$R1: pushed to" \
  && ko "...but it still reported the routine pushed -- $out" \
  || ok "...and does not report the routine pushed"
has "$out" 'failed part-way|still differs from' \
  && ok "...saying the destination is not what the checkout holds" \
  || ko "no diagnosis of the failed publish -- $out"
grep -q 'must not be reported as published' "$TMP/installed/$R1/SKILL.md" \
  && ko "the new content reached the installation despite the failing cp" \
  || ok "...while the old installed prompt is still there, unclaimed"
# The control: the same push without the shim on PATH succeeds, so the failure above is the cp's.
expect "...while the same push with a working cp succeeds" 0 "pushed to" -- run_sync push
grep -q 'must not be reported as published' "$TMP/installed/$R1/SKILL.md" \
  && ok "...and does land the new content" || ko "the working push did not land the content"

# --- publish_checked reads its own result, and that reading can fail -----------------------------
# The post-condition is the guard on the guard: with every case above passing, no publish reaches
# it, and a claim that cannot fail is worth nothing. So build a copy of the script with the
# file-kind guard deleted -- the defect the round-4 review found -- and require the post-condition
# to catch it. Nothing here weakens the real script; it is the control that gives the real
# script's "republished" line its meaning.
# strip_marked_block <name> <out>: a copy of the tracked script with the block between
# `# >>> <name>` and `# <<< <name>` deleted. Every caller checks that the strip removed
# something, so a marker that moved makes the control fail loudly instead of passing vacuously.
strip_marked_block() {
  SMB_NAME="$1" awk '
    $0 ~ "^ *# >>> " ENVIRON["SMB_NAME"] { skip = 1 }
    !skip { print }
    $0 ~ "^ *# <<< " ENVIRON["SMB_NAME"] { skip = 0 }
  ' "$SYNC" > "$2"
  chmod +x "$2"
}
# strip_check <name> <file> <label>: the markers were both in the tracked script and none is left.
strip_check() {
  local marks stripped o_lines s_lines shrank
  marks=$(grep -c "$1" "$SYNC" 2>/dev/null) || true
  stripped=$(grep -c "$1" "$2" 2>/dev/null) || true
  o_lines=$(wc -l < "$SYNC" | tr -d ' ')
  s_lines=$(wc -l < "$2" | tr -d ' ')
  shrank=$((o_lines - s_lines))
  if [ "${marks:-0}" -eq 2 ] && [ "${stripped:-1}" -eq 0 ] && [ "$shrank" -ge 3 ]; then
    ok "$3 ($shrank lines removed)"
  else
    ko "$3: the $1 markers are not both in $SYNC, or the strip removed nothing (marks=${marks:-0} left=${stripped:-?} shrank=$shrank) -- the control below proves nothing"
  fi
}
BROKEN="$TMP/broken"
mkdir -p "$BROKEN/scripts"
copy_checker "$BROKEN"
strip_marked_block kind-guard "$BROKEN/scripts/sync-routines.sh"
strip_check kind-guard "$BROKEN/scripts/sync-routines.sh" \
  "a copy of the script without the file-kind guard was built"
cp -R "$REPO/routines" "$BROKEN/routines"
rm -rf "$TMP/broken-installed"
mkdir -p "$TMP/broken-installed"
for r in $LOCAL_ROUTINES; do cp -R "$BROKEN/routines/$r" "$TMP/broken-installed/$r"; done
rm -f "$TMP/broken-installed/$R1/SKILL.md"
mkdir -p "$TMP/broken-installed/$R1/SKILL.md"
out=$(env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/broken-installed" "$BROKEN/scripts/sync-routines.sh" push 2>&1); rc=$?
if [ "$rc" -eq 1 ] && contains "$out" 'after publishing'; then
  ok "the post-condition catches a publish that left the destination unusable"
else
  ko "the guard-less copy reported rc=$rc without the post-condition firing -- $out"
fi
contains "$out" "$R1: republished to" \
  && ko "it still printed 'republished' for a routine it did not republish -- $out" \
  || ok "...and does not call it republished"
# The second clause, and the one the round-5 review asked for by name: presence is not enough,
# the destination must HOLD THE SOURCE. prompt_problem cannot see this -- a stale leftover file
# sits beside a perfectly good SKILL.md -- so it needs its own guard-less copy, without the
# pruning pass.
NOPRUNE="$TMP/noprune"
mkdir -p "$NOPRUNE/scripts"
copy_checker "$NOPRUNE"
strip_marked_block prune-guard "$NOPRUNE/scripts/sync-routines.sh"
strip_check prune-guard "$NOPRUNE/scripts/sync-routines.sh" \
  "a copy of the script that publishes without pruning was built"
cp -R "$REPO/routines" "$NOPRUNE/routines"
rm -rf "$TMP/noprune-installed"
mkdir -p "$TMP/noprune-installed"
for r in $LOCAL_ROUTINES; do cp -R "$NOPRUNE/routines/$r" "$TMP/noprune-installed/$r"; done
printf 'a file the checkout no longer has\n' > "$TMP/noprune-installed/$R1/leftover.md"
out=$(env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/noprune-installed" "$NOPRUNE/scripts/sync-routines.sh" push 2>&1); rc=$?
if [ "$rc" -eq 1 ] && contains "$out" 'still differs from'; then
  ok "the post-condition catches a destination that has a SKILL.md but is not the source"
else
  ko "the prune-less copy reported rc=$rc without the tree comparison firing -- $out"
fi
contains "$out" "$R1: pushed to" \
  && ko "...but it still reported the routine pushed -- $out" \
  || ok "...and does not report it pushed"
# The control on that one: with nothing extra installed, the same prune-less copy succeeds.
rm -rf "$TMP/noprune-installed"
mkdir -p "$TMP/noprune-installed"
for r in $LOCAL_ROUTINES; do cp -R "$NOPRUNE/routines/$r" "$TMP/noprune-installed/$r"; done
printf 'body v2\n' >> "$NOPRUNE/routines/$R1/SKILL.md"
out=$(env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/noprune-installed" "$NOPRUNE/scripts/sync-routines.sh" push 2>&1); rc=$?
[ "$rc" -eq 0 ] && contains "$out" 'pushed to' \
  && ok "...while the same copy publishes cleanly with nothing left over" \
  || ko "the prune-less copy fails even a plain push (rc=$rc): $out"

# The control on the control: the same guard-less copy over a destination with nothing in the way
# publishes cleanly, so the failure above is the missing guard and not the copy itself.
rm -rf "$TMP/broken-installed"
mkdir -p "$TMP/broken-installed"
for r in $LOCAL_ROUTINES; do cp -R "$BROKEN/routines/$r" "$TMP/broken-installed/$r"; done
printf 'body v2\n' >> "$BROKEN/routines/$R1/SKILL.md"
out=$(env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/broken-installed" "$BROKEN/scripts/sync-routines.sh" push 2>&1); rc=$?
[ "$rc" -eq 0 ] && contains "$out" 'pushed to' \
  && ok "...while the same copy publishes cleanly with nothing in the way" \
  || ko "the guard-less copy fails even a plain push (rc=$rc) -- the control above is not about the guard: $out"

# --- a routine file whose name carries a newline -------------------------------------------------
# `find -print` hands out one path per LINE, so such a name arrives as two paths: the staging loop
# copies a source path that does not exist, and the pruning loop `rm -f`s the two halves instead
# of the file -- the second half RELATIVE to the caller's working directory, since stripping the
# "$dst" prefix off a path that no longer begins with it leaves the bare tail. PR #215 fixed this
# hazard where git produced the paths; the producer here is find, so it was fixed separately.
# The names are built once, so every case below means the same file.
NL_NAME=$'two\nlines.md'
SP_NAME=' spaced name.md'
reset_trees; install_all
printf 'an asset whose name holds a newline\n' > "$REPO/routines/$R1/$NL_NAME"
printf 'an asset whose name holds leading and trailing spaces\n' > "$REPO/routines/$R1/$SP_NAME"
expect "push publishes a file whose name contains a newline" 0 "$R1: pushed to" -- run_sync push
[ -f "$TMP/installed/$R1/$NL_NAME" ] \
  && ok "...under the name it has, not one the split invented" \
  || ko "no such file installed -- the directory holds: $(ls -b "$TMP/installed/$R1" | tr '\n' ' ')"
[ ! -e "$TMP/installed/$R1/two" ] && [ ! -e "$TMP/installed/$R1/lines.md" ] \
  && ok "...and neither half of the name was published as a file of its own" \
  || ko "a split half was published: $(ls -b "$TMP/installed/$R1" | tr '\n' ' ')"
contains "$(cat "$TMP/installed/$R1/$NL_NAME" 2>/dev/null)" 'holds a newline' \
  && ok "...carrying the source file's bytes" \
  || ko "the published copy is not the source file"
[ -f "$TMP/installed/$R1/$SP_NAME" ] \
  && ok "...and a name with leading and trailing spaces is published untrimmed" \
  || ko "the spaced name did not survive: $(ls -b "$TMP/installed/$R1" | tr '\n' ' ')"
expect "...leaving status clean" 0 "all local routines in sync" -- run_sync

# The pruning pass is the destructive half of a publish: it walks the DESTINATION and removes what
# the source no longer has. Make it run with the newline-named file present at both ends -- an
# edit elsewhere in the routine is what gets publish_dir called at all -- and the file must still
# be there afterwards.
printf 'body v2\n' >> "$REPO/routines/$R1/SKILL.md"
expect "a later push does not prune the newline-named file it published" 0 "$R1: pushed to" -- \
  run_sync push
[ -f "$TMP/installed/$R1/$NL_NAME" ] \
  && ok "...the file is still installed after the pruning pass" \
  || ko "the pruning pass deleted a file the checkout has: $(ls -b "$TMP/installed/$R1" | tr '\n' ' ')"
grep -q 'body v2' "$TMP/installed/$R1/SKILL.md" \
  && ok "...and the edit that occasioned the push landed" \
  || ko "the push did not update SKILL.md, so the pruning pass above may not have run"

# ...and it must still prune such a file when the checkout drops it, so the case above is not
# passing because the pruning stopped working on these names. The decoy is the other half of the
# old defect: the tail of a split path is RELATIVE, so `rm -f` aimed it at whatever sits under
# that name in the caller's working directory.
reset_trees; install_all
printf 'a leftover the checkout does not have\n' > "$TMP/installed/$R1/$NL_NAME"
DECOY="$TMP/decoy"
mkdir -p "$DECOY"
printf 'a bystander in the working directory the push is run from\n' > "$DECOY/lines.md"
out=$(cd "$DECOY" && env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/installed" "$SR" push 2>&1); rc=$?
[ "$rc" -eq 0 ] && contains "$out" "$R1: pushed to" \
  && ok "a push prunes a leftover whose name contains a newline" \
  || ko "the push over the leftover exited $rc -- $out"
[ ! -e "$TMP/installed/$R1/$NL_NAME" ] \
  && ok "...removing it from the installation" \
  || ko "the leftover survived: $(ls -b "$TMP/installed/$R1" | tr '\n' ' ')"
[ -f "$DECOY/lines.md" ] \
  && ok "...and nothing under the caller's working directory was removed" \
  || ko "the prune deleted $DECOY/lines.md, which no publish has any business touching"

# The post-condition itself: a publish that leaves an unusable destination must not report success.
# Negative control by construction -- the same publish over a source that IS usable succeeds.
reset_trees; install_all
rm -f "$REPO/routines/$R1/SKILL.md"
printf 'not a prompt\n' > "$REPO/routines/$R1/notes.md"
expect "push refuses a checkout prompt with no SKILL.md before publishing anything" 1 \
  "refusing to install it" -- run_sync push
grep -q 'body v1' "$TMP/installed/$R1/SKILL.md" \
  && ok "...leaving the installed prompt intact" || ko "the refused push damaged the installation"

# The ordering the source check needed: the not-installed branch used to publish before it ran.
reset_trees
rm -rf "$TMP/installed/$R1"
rm -f "$REPO/routines/$R1/SKILL.md"
expect "push over a MISSING installation validates the checkout first" 1 "refusing to install it" -- \
  run_sync push
[ ! -e "$TMP/installed/$R1" ] \
  && ok "...installing nothing unusable" || ko "an unusable prompt was installed at $TMP/installed/$R1"
contains "$out" "$R1: prompt installed" \
  && ko "it reported the broken routine as installed -- $out" \
  || ok "...and did not report it installed"

# Same ordering through the symlinked-installation branch, which also publishes.
reset_trees
rm -rf "$TMP/installed/$R1"
ln -s "$REPO/routines/$R1" "$TMP/installed/$R1"
rm -f "$REPO/routines/$R1/SKILL.md"
expect "push over a SYMLINKED installation validates the checkout first" 1 "refusing to install it" -- \
  run_sync push
[ -L "$TMP/installed/$R1" ] \
  && ok "...leaving the symlink rather than replacing it with an unusable copy" \
  || ko "the symlink was replaced by a prompt with no SKILL.md"

# --- one mode per invocation ---------------------------------------------------------------------
# `pull push` used to run a push, overwriting the installed edits the caller asked to recover.
reset_trees; install_all
printf 'body v2 -- the edit the caller wants back\n' >> "$TMP/installed/$R1/SKILL.md"
expect "two modes in one invocation are refused with exit 2" 2 "only one mode may be given" -- \
  run_sync pull push
grep -q 'the edit the caller wants back' "$TMP/installed/$R1/SKILL.md" \
  && ok "...before either direction is written" \
  || ko "the refused invocation still overwrote the installed edit"
contains "$out" 'opposite directions' \
  && ok "...saying why the last token must not win" || ko "no reason given -- $out"
expect "...in the other order too" 2 "only one mode may be given" -- run_sync push pull
expect "...and a repeated mode is refused as well" 2 "only one mode may be given" -- run_sync push push
# The control: one mode with the same flags still works, so the refusal is about the second mode.
expect "...while one mode with its flags is accepted" 0 "would pull" -- run_sync pull --dry-run

# --- the pin: LOCAL_ROUTINES vs the routines table ----------------------------------------------
# ludics-lite#77: nothing said that the install loop lists exactly the rows whose Kind is `local
# scheduled task`. It is a script list now, so the pin is here. This reads the table narrowly --
# a row is a line whose first cell is a backticked name and whose second is the kind -- and the
# emptiness guard below is what stops a mangled table from passing vacuously. check-prompts.sh
# deliberately has no table model (ludics-lite#75) and this does not give it one.
local_rows_of() {
  awk -F'|' '
    function cell(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    # A fenced block is an EXAMPLE, never a declaration, and the table ends at the first line
    # that is not one of its rows. Without both bounds a row-shaped line in a code fence or in
    # prose below counts, and a row genuinely removed from the table is masked by it -- at which
    # point this pin passes over exactly the drift it exists to catch.
    /^[[:space:]]*```/ { fence = !fence; next }
    fence { next }
    !in_table {
      if ($0 ~ /^[[:space:]]*\|/ && cell($2) == "Routine" && cell($3) == "Kind") in_table = 1
      next
    }
    $0 !~ /^[[:space:]]*\|/ { exit }
    {
      name = cell($2); kind = cell($3)
      if (kind != "local scheduled task") next
      if (substr(name, 1, 1) != "`" || substr(name, length(name), 1) != "`") next
      print substr(name, 2, length(name) - 2)
    }
  ' "$1" | sort | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}
sorted_words() { printf '%s\n' $1 | sort | tr '\n' ' ' | sed 's/[[:space:]]*$//'; }

table_rows=$(local_rows_of "$ROUTINES_README")
if [ -n "$table_rows" ]; then
  ok "routines/README.md declares local scheduled tasks ($table_rows)"
else
  ko "no \`local scheduled task\` row found in $ROUTINES_README -- the comparison below would be vacuous"
fi
declared=$(sorted_words "$LOCAL_ROUTINES")
if [ -n "$table_rows" ] && [ "$declared" = "$table_rows" ]; then
  ok "LOCAL_ROUTINES lists exactly the table's local scheduled tasks"
else
  ko "LOCAL_ROUTINES ($declared) is not the table's local rows ($table_rows) -- ludics-lite#77"
fi

# The negative controls. Without these the comparison above is a claim that cannot fail: the
# same reader, over tables with a known defect, must disagree with the script's list.
cat > "$TMP/table-extra.md" <<'EOF'
| Routine | Kind | Fires |
| --- | --- | --- |
| `daily-issue-planning` | local scheduled task | daily |
| `ocannl-cross-machine-sweep` | local scheduled task | daily |
| `a-routine-nobody-syncs` | local scheduled task | daily |
| `ocannl-ci-red-triage` | cloud routine | on red |
EOF
[ "$(local_rows_of "$TMP/table-extra.md")" != "$declared" ] \
  && ok "the table reader catches a local row the script does not sync" \
  || ko "an unsynced local row reads as agreement -- the pin above proves nothing"

cat > "$TMP/table-missing.md" <<'EOF'
| Routine | Kind | Fires |
| --- | --- | --- |
| `daily-issue-planning` | local scheduled task | daily |
| `ocannl-ci-red-triage` | cloud routine | on red |
EOF
[ "$(local_rows_of "$TMP/table-missing.md")" != "$declared" ] \
  && ok "...and a synced routine that has no row" \
  || ko "a missing row reads as agreement"

cat > "$TMP/table-kind.md" <<'EOF'
| Routine | Kind | Fires |
| --- | --- | --- |
| `daily-issue-planning` | local scheduled task | daily |
| `ocannl-cross-machine-sweep` | local scheduled task | daily |
| `ocannl-ci-red-triage` | local scheduled task | on red |
EOF
[ "$(local_rows_of "$TMP/table-kind.md")" != "$declared" ] \
  && ok "...and the cloud routine relabelled as a local task" \
  || ko "the Kind cell is not read: a relabelled cloud row reads as agreement"

# A row-shaped line in a fenced EXAMPLE is not a declaration, and must not mask a row that was
# genuinely removed -- otherwise the pin passes over exactly the drift it is for.
{
  printf '| Routine | Kind | Fires |\n| --- | --- | --- |\n'
  printf '| `ocannl-cross-machine-sweep` | local scheduled task | daily |\n'
  printf '| `ocannl-ci-red-triage` | cloud routine | on red |\n\n'
  printf 'An example of a row:\n\n```md\n'
  printf '| `daily-issue-planning` | local scheduled task | daily |\n'
  printf '```\n'
} > "$TMP/table-fenced.md"
[ "$(local_rows_of "$TMP/table-fenced.md")" != "$declared" ] \
  && ok "...and a row that exists only inside a fenced example does not stand in for a real one" \
  || ko "a fenced example masked a removed row: $(local_rows_of "$TMP/table-fenced.md")"
# ...nor does one below the table's end.
{
  printf '| Routine | Kind | Fires |\n| --- | --- | --- |\n'
  printf '| `ocannl-cross-machine-sweep` | local scheduled task | daily |\n\n'
  printf 'Retired routines, kept for the record:\n\n'
  printf '| `daily-issue-planning` | local scheduled task | daily |\n'
} > "$TMP/table-after.md"
[ "$(local_rows_of "$TMP/table-after.md")" != "$declared" ] \
  && ok "...nor one written below the table it left" \
  || ko "a row past the table's end counted: $(local_rows_of "$TMP/table-after.md")"
# The control on those two bounds: the real table, whose rows follow its header, still reads.
[ -n "$(local_rows_of "$ROUTINES_README")" ] \
  && ok "...while the real table still reads through both bounds" \
  || ko "the bounded reader finds nothing in $ROUTINES_README"

cat > "$TMP/table-none.md" <<'EOF'
| Routine | Kind | Fires |
| --- | --- | --- |
| `ocannl-ci-red-triage` | cloud routine | on red |
EOF
[ -z "$(local_rows_of "$TMP/table-none.md")" ] \
  && ok "...and a table with no local rows reads as empty, which the guard above refuses" \
  || ko "a table with no local rows produced rows anyway"

# The reader must not be fooled by the kind appearing somewhere other than the Kind cell.
cat > "$TMP/table-prose.md" <<'EOF'
Every local scheduled task is listed below.

| Routine | Kind | Fires |
| --- | --- | --- |
| `daily-issue-planning` | local scheduled task | a local scheduled task, daily |
| `ocannl-cross-machine-sweep` | local scheduled task | daily |
EOF
[ "$(local_rows_of "$TMP/table-prose.md")" = "$declared" ] \
  && ok "...while prose and later cells saying \"local scheduled task\" add no rows" \
  || ko "the reader picked up rows outside the Kind cell: $(local_rows_of "$TMP/table-prose.md")"

# --- retired routines are tombstoned, not forgotten ----------------------------------------------
# Deleting a prompt directory in this repository retires nothing on a box that already has it: the
# installed copy stays and so does the registry entry naming it, which keeps firing. The install
# loop cannot see that, because it iterates this repository's list rather than the destination.
if [ -n "$RETIRED_ROUTINES" ]; then
  ok "sync-routines.sh carries tombstones for retired routines ($RETIRED_ROUTINES)"
else
  ko "no RETIRED_ROUTINES list in $SYNC -- a retired routine's installation is invisible again"
fi
RETIRED1=$(set -- $RETIRED_ROUTINES; echo "${1:-}")
if [ -n "$RETIRED1" ]; then
  reset_trees; install_all
  # The control first: with nothing left over, status is clean and says nothing about it.
  expect "with no retired routine installed, status is clean" 0 "all local routines in sync" -- run_sync
  contains "$out" "$RETIRED1" \
    && ko "it named $RETIRED1 with nothing installed for it -- $out" \
    || ok "...and does not mention $RETIRED1"

  mkdir -p "$TMP/installed/$RETIRED1"
  printf -- '---\nname: %s\ndescription: the retired one\n---\n\nstill here\n' "$RETIRED1" \
    > "$TMP/installed/$RETIRED1/SKILL.md"
  expect "status reports a retired routine that is still installed" 1 "RETIRED, but still installed" -- \
    run_sync
  contains "$out" "Deregister '$RETIRED1'" \
    && ok "...telling the operator to deregister it in the desktop app" \
    || ko "the report does not say to deregister it -- $out"
  contains "$out" "$TMP/installed/$RETIRED1" \
    && ok "...and naming the directory to remove afterwards" || ko "no path given -- $out"
  # It must NOT delete it: the registry entry is the desktop app's, and a prompt removed under a
  # live entry fires and fails rather than stopping.
  [ -f "$TMP/installed/$RETIRED1/SKILL.md" ] \
    && ok "...while removing nothing itself, since the registry is not this script's to change" \
    || ko "the script deleted $TMP/installed/$RETIRED1"
  expect "...and push reports it too rather than passing clean" 1 "RETIRED, but still installed" -- \
    run_sync push
  [ -f "$TMP/installed/$RETIRED1/SKILL.md" ] \
    && ok "...still removing nothing" || ko "push deleted the retired routine's directory"
  # The state an upgraded box is actually in: the old install loop symlinked the task directory
  # into this checkout, and this change deletes the target, so what is left is a DANGLING link --
  # which `-e` calls absent while the registry entry still names it.
  rm -rf "$TMP/installed/$RETIRED1"
  ln -s "$TMP/no-such-target-$RETIRED1" "$TMP/installed/$RETIRED1"
  [ ! -e "$TMP/installed/$RETIRED1" ] && [ -L "$TMP/installed/$RETIRED1" ] \
    && ok "...the upgraded box's dangling link is invisible to a plain existence test" \
    || ko "the fixture did not produce a dangling link, so the case below proves nothing"
  expect "...and a DANGLING retired link is reported all the same" 1 "RETIRED, but still installed" -- \
    run_sync
  [ -L "$TMP/installed/$RETIRED1" ] \
    && ok "...and is still left for the operator to remove after deregistering" \
    || ko "the script removed the dangling link itself"
  rm -f "$TMP/installed/$RETIRED1"

  # A retired name must be retired in the repository too, or the tombstone contradicts the table.
  case " $LOCAL_ROUTINES " in
    *" $RETIRED1 "*) ko "$RETIRED1 is tombstoned AND in LOCAL_ROUTINES" ;;
    *) ok "...and $RETIRED1 is not in LOCAL_ROUTINES" ;;
  esac
  [ ! -d "$ROOT/routines/$RETIRED1" ] \
    && ok "...nor does routines/$RETIRED1 exist" || ko "routines/$RETIRED1 is still in the repository"
  contains " $(local_rows_of "$ROUTINES_README") " " $RETIRED1 " \
    && ko "$RETIRED1 still has a local scheduled task row in $ROUTINES_README" \
    || ok "...nor a row in the routines table"
else
  ok "no retired routine to check (the tombstone list is empty)"
fi

# --- the pin has to actually run ----------------------------------------------------------------
# The comparison above is only worth what CI runs. The diff classification in the workflow calls a
# PR prompt-only when every file it touches is Markdown other than the top-level README -- and a PR
# that adds or relabels a local routine can be exactly that (routines/README.md plus a prompt). So
# this suite's job must carry no `if:` and no `needs:`, or the one check that compares the table
# with LOCAL_ROUTINES is skipped on precisely the PRs that can break it. That job is `prompts`,
# the small guards (ludics-lite#474), which runs this suite as one of its steps.
WORKFLOW="$ROOT/.github/workflows/skill-scripts.yml"
# The block of one job: from `  <name>:` to the next line at that indent. A narrow read, like the
# table read above, and the emptiness guard is the same idea.
job_block() {
  JB_NAME="$1" awk '
    BEGIN { want = "  " ENVIRON["JB_NAME"] ":" }
    $0 == want { inside = 1; next }
    inside && /^  [^ #]/ { exit }
    inside { print }
  ' "$2"
}
if [ -f "$WORKFLOW" ]; then
  block=$(job_block prompts "$WORKFLOW")
  if [ -n "$block" ]; then
    ok "the workflow declares a prompts job"
    contains "$block" 'test-sync-routines.sh' \
      && ok "...that runs this suite" || ko "the prompts job does not run this suite"
    has "$block" '^    (if|needs):' \
      && ko "the prompts job is conditioned on the diff classification, so the routines-table pin is skipped on an all-Markdown PR -- the one shape that breaks it" \
      || ok "...unconditionally, so an all-Markdown PR is judged by it too"
  else
    ko "no prompts job in $WORKFLOW -- nothing runs this suite"
  fi
else
  ko "no $WORKFLOW to read"
fi
# The negative controls: the same reader over a scratch workflow, conditioned and unconditioned.
cat > "$TMP/wf-conditioned.yml" <<'EOF'
jobs:
  lint:
    runs-on: ubuntu-latest
  prompts:
    name: small guards (ubuntu)
    needs: changes
    if: ${{ needs.changes.outputs.scripts == 'true' }}
    steps:
      - run: scripts/test-sync-routines.sh
  macos:
    runs-on: macos-latest
EOF
has "$(job_block prompts "$TMP/wf-conditioned.yml")" '^    (if|needs):' \
  && ok "the job reader sees an if:/needs: line when one is there, so the verdict above can fail" \
  || ko "the job reader misses a conditioned job -- the verdict above means nothing"
cat > "$TMP/wf-plain.yml" <<'EOF'
jobs:
  prompts:
    name: small guards (ubuntu)
    steps:
      - run: scripts/test-sync-routines.sh
  macos:
    needs: changes
    if: ${{ always() }}
EOF
has "$(job_block prompts "$TMP/wf-plain.yml")" '^    (if|needs):' \
  && ko "the job reader read past the end of the job into the next one" \
  || ok "...and stops at the next job, so a neighbour's condition is not read as this job's"

# --- the executable bit -------------------------------------------------------------------------
# A `> tmp && mv` rewrite of a script drops mode 755, and the failure is a CI run away: the
# workflow calls the script by path.
mode_of_tracked() { (cd "$ROOT" && git ls-files -s -- "$1" 2>/dev/null | awk '{print $1}'); }
sync_mode=$(mode_of_tracked scripts/sync-routines.sh)
case "$sync_mode" in
  100755) ok "scripts/sync-routines.sh is tracked executable (100755)" ;;
  "")     ko "scripts/sync-routines.sh is not tracked yet -- git add it, mode 755" ;;
  *)      ko "scripts/sync-routines.sh is tracked as $sync_mode, not 100755: chmod +x and re-add" ;;
esac
[ -x "$SYNC" ] && ok "...and executable in the working tree" || ko "$SYNC is not executable"
# The negative control for the mode read: the same helper over a scratch repo with a 644 script.
GITREPO="$TMP/moderepo"
mkdir -p "$GITREPO"
( cd "$GITREPO" \
  && git init -q . \
  && printf '#!/usr/bin/env bash\ntrue\n' > s.sh && chmod 644 s.sh \
  && git add s.sh ) >/dev/null 2>&1
scratch_mode=$( cd "$GITREPO" && git ls-files -s -- s.sh 2>/dev/null | awk '{print $1}' )
[ "$scratch_mode" = "100644" ] \
  && ok "the mode read reports 100644 for a non-executable script, so the check above can fail" \
  || ko "the mode read said '$scratch_mode' for a 644 file -- the verdict above means nothing"

# --- the real checkout, as the last word --------------------------------------------------------
# status against a destination that exists but holds nothing: the script must report, not crash,
# and must not touch the real ~/.claude/scheduled-tasks.
mkdir -p "$TMP/empty-dest"
out=$(env CLAUDE_SCHEDULED_TASKS_DIR="$TMP/empty-dest" "$SYNC" 2>&1); rc=$?
[ "$rc" -eq 1 ] && contains "$out" 'no prompt directory at' \
  && ok "the tracked script itself reports an empty destination with exit 1" \
  || ko "the tracked script on an empty destination: rc=$rc -- $out"
[ -z "$(ls -A "$TMP/empty-dest")" ] \
  && ok "...and a status read wrote nothing" || ko "status created files in the destination"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
exit "$?"
}
