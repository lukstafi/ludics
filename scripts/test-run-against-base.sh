#!/usr/bin/env bash
# Exercises run-against-base.sh against a scratch repo: a bare origin whose main is a base
# commit carrying a buggy toy library and its suite, and a clone whose WORKING TREE fixes the
# library and adds a case to the suite that the base's library fails. What it pins:
#   - the helper runs the working tree's suite against the base's library and reports the base
#     failure -- the suite's own exit status and its pass/fail line -- while the same suite passes
#     in the working tree (the control that the failure is the base's, not the suite's);
#   - only the suite is copied: the working tree's fixed library never reaches the base run;
#   - the base copy is a real git checkout (the `git archive` shape broke a case in the
#     2026-09-28 wave), a suite new in the working tree runs too, and suite arguments pass through;
#   - --base <ref> picks another base, and a fixed one passes;
#   - a refusal (unknown ref, a suite outside the checkout) exits 125, never the suite's status;
#   - every exit path, TERM and INT during the run included, leaves no worktree registered, no
#     scratch directory under $TMPDIR, the suite process gone, and the checkout's status as it was;
#   - nothing the suite does holds the helper: a suite that ignores TERM is killed after the grace,
#     an orphan that inherited its output is stopped with it, and a worktree it locked still goes;
#     a left-behind child with a TERM cleanup of its own gets the whole grace to finish it;
#   - whatever the base keeps on the suite's path -- a symlink out of the checkout at the leaf or
#     at a parent, a directory where the suite now is -- is replaced, never followed or written
#     through, and nothing is created outside the worktree;
#   - a suite named with a leading dash, or ending in a newline, runs that very file; a `--`
#     directory on the suite's path installs; a working-tree suite that is a symlink is refused
#     rather than followed;
#   - a path inside .git is refused, and a suite that cannot be started (a missing interpreter,
#     directly or behind `#!/usr/bin/env`) exits 125 rather than its exec error's 126/127;
#   - an unreadable directory the suite leaves behind does not leak the scratch;
#   - git's repository-local variables exported by the caller (GIT_DIR, GIT_WORK_TREE,
#     GIT_INDEX_FILE) reach neither the suite nor the helper's own git commands;
#   - a sparse source checkout still gets a complete base (and stays sparse itself), another
#     worktree's registration is never pruned, and a base's submodules are named on the result;
#   - a second signal during the cleanup does not cut the teardown short;
#   - RUN_AGAINST_BASE_GRACE is validated up front, and a suite's own 125 exits 1;
#   - --also carries a named working-tree file (a fixture library) into the base, and nothing
#     else; --mutate edits a file inside the throwaway worktree only -- by default a snapshot of
#     the working tree, uncommitted edits included -- and refuses a mutation that changes nothing;
#   - --timeout / RUN_AGAINST_BASE_TIMEOUT stops a hanging suite's group and reports the base as
#     failing (124), a suite ignoring TERM included, while one inside the timeout is judged as ever;
#   - a lib/ unit file runs through the base's scripts/py as `-m unittest <module>` with no
#     PYTHONPATH from the caller, reaching its own verdict (relative imports included); scripts/py
#     finding no interpreter, or hanging past --timeout while it looks, is 125, and so is a base
#     scripts/py that cannot run; a base without one falls back to python3 and says so; a lib/ path CI's discovery never runs (no
#     module name, not test_*.py, outside a package) is refused; a *.py outside lib/ runs under
#     python3;
#   - --command runs a project's runner (a PATH program, or the run tree's copy of a checkout
#     file, the working tree's only when --also carries it) from the root of the run's tree, its
#     argv after the required `--` verbatim; the malformed forms, a program not found or not
#     startable, and a missing env interpreter exit 125, a hang 124 (#765);
#   - --revert <commit> <path> undoes that commit's change under the path in the throwaway tree
#     (the working-tree snapshot without --base): the change's other files and later independent
#     edits stay, added files go and modes return, overlapping commits revert newest first, and a
#     revert precedes the mutations; an unknown, merge, root or out-of-history commit, a path it
#     does not change (paths are literal), a symlink change and an overlapped patch exit 125; the
#     live tree's files, index and stash are untouched (#765);
#   - a plain base run that carries every file the branch changes warns that it is the branch's
#     own run; a mutant run, or a branch with an uncarried change (untracked included), does not
#     (#501).
#
# Usage: test-run-against-base.sh   (exit 0 all pass, 1 otherwise)

set -uo pipefail

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command (ludics-lite#10, #247).
{
HERE=$(cd "$(dirname "$0")" && pwd -P)
RAB="$HERE/run-against-base.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/run-against-base-test.XXXXXX") || exit 1
TMP=$(CDPATH= cd "$TMP" && pwd -P) || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf '%s\n' "PASS: $*"
}
ko() {
  fail=$((fail + 1))
  printf '%s\n' "FAIL: $*"
}

g() { git -c user.name=t -c user.email=t@example.invalid -c init.defaultBranch=main "$@"; }

# The helper's scratch directories go here, so "nothing left behind" is a directory listing.
HTMP="$TMP/htmp"
mkdir -p "$HTMP"

g init -q --bare "$TMP/origin.git"
R="$TMP/repo"
g init -q "$R"
mkdir -p "$R/scripts"
cat >"$R/scripts/lib.sh" <<'EOF'
add() { echo $(($1 - $2)); }
EOF
cat >"$R/scripts/test-toy.sh" <<'EOF'
#!/usr/bin/env bash
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/lib.sh"
pass=0; fail=0
[ "$(add 2 0)" = 2 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: add 2 0"; }
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
EOF
chmod +x "$R/scripts/test-toy.sh"
g -C "$R" add -A
g -C "$R" commit -qm base
g -C "$R" remote add origin "$TMP/origin.git"
g -C "$R" push -q origin main
g -C "$R" fetch -q origin
BASE_SHA=$(git -C "$R" rev-parse HEAD)

# A fixed library committed on a side branch, for --base.
g -C "$R" checkout -qb fixed
printf '%s\n' 'add() { echo $(($1 + $2)); }' >"$R/scripts/lib.sh"
g -C "$R" commit -qam fix
g -C "$R" checkout -q main

# A base that keeps a suite path as a symlink to a file outside the checkout.
printf '%s\n' 'VICTIM' >"$TMP/victim.sh"
g -C "$R" checkout -qb linked
ln -s "$TMP/victim.sh" "$R/scripts/test-link.sh"
# ...a parent directory kept as a symlink out of the checkout, and a directory where the working
# tree has a suite file.
mkdir -p "$TMP/outdir" "$R/scripts/test-dir"
ln -s "$TMP/outdir" "$R/scripts/lnk"
printf 'x\n' >"$R/scripts/test-dir/x"
# ...and a directory that is a submodule (a gitlink) in the base and an ordinary one now.
g -C "$R" add -A
g -C "$R" update-index --add --cacheinfo "160000,$BASE_SHA,scripts/subdir"
g -C "$R" commit -qm link
g -C "$R" checkout -q main

# The working tree: the fix, plus a case the base fails, a git probe, and an argument echo.
printf '%s\n' 'add() { echo $(($1 + $2)); }' >"$R/scripts/lib.sh"
cat >"$R/scripts/test-toy.sh" <<'EOF'
#!/usr/bin/env bash
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/lib.sh"
pass=0; fail=0
[ "$(add 2 0)" = 2 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: add 2 0"; }
[ "$(add 2 3)" = 5 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: add 2 3"; }
top=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || top=NONE
echo "TOPLEVEL=$(cd "$top" 2>/dev/null && pwd -P || echo NONE) HERE=$HERE"
echo "ARGS=[$*]"
case "${1-}" in
--slow) echo "$$" >"$2"; exec sleep 60 ;;
--stubborn) trap '' TERM; echo "$$" >"$2"; while :; do sleep 1; done ;;
--orphan) sleep 60 & echo "$!" >"$2" ;;
--graceful)
  # The ready file is the handshake: the suite exits only once the child's TERM trap is armed,
  # or the helper's TERM can land before it and the default action skips the cleanup.
  ( trap 'sleep 1; echo done >"$2"; exit 0' TERM; : >"$2.ready"; sleep 60 & wait ) >/dev/null 2>&1 &
  for i in $(seq 1 300); do [ -e "$2.ready" ] && break; sleep 0.1; done ;;
--rc125) exit 125 ;;
--rc124) exit 124 ;;
--lockout) mkdir -p "$HERE/sealed/d" && : >"$HERE/sealed/d/f" && chmod 000 "$HERE/sealed/d" ;;
--lock) git -C "$HERE" worktree lock "$(git -C "$HERE" rev-parse --show-toplevel)" ;;
esac
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
EOF
cat >"$R/scripts/test-new.sh" <<'EOF'
#!/usr/bin/env bash
echo "1 passed, 0 failed"
EOF
chmod +x "$R/scripts/test-new.sh"
cat >"$R/scripts/test-link.sh" <<'EOF'
#!/usr/bin/env bash
echo "1 passed, 0 failed"
EOF
chmod +x "$R/scripts/test-link.sh"
cp -p "$R/scripts/test-link.sh" "$R/scripts/-check.sh"
mkdir -p "$R/scripts/subdir"
cp -p "$R/scripts/test-link.sh" "$R/scripts/subdir/test-insub.sh"
# A name ending in a newline, beside the same name without it (which must not be the one run).
cp -p "$R/scripts/test-link.sh" "$R/scripts/test-nl.sh"$'\n'
printf '#!/usr/bin/env bash\necho "WRONG FILE"\nexit 3\n' >"$R/scripts/test-nl.sh"
chmod +x "$R/scripts/test-nl.sh"
printf '#!/usr/bin/env run-against-base-no-such-interpreter\nexit 1\n' >"$R/scripts/test-envmiss.sh"
chmod +x "$R/scripts/test-envmiss.sh"
printf '#!/usr/bin/env -S run-against-base-no-such-interpreter --flag\nexit 1\n' >"$R/scripts/test-envS.sh"
chmod +x "$R/scripts/test-envS.sh"
printf '#!/usr/bin/env -S bash -e\necho "ARGS=[$*]"\necho "1 passed, 0 failed"\n' >"$R/scripts/test-envSok.sh"
chmod +x "$R/scripts/test-envSok.sh"
mkdir -p "$TMP/interp-bin"
printf '#!/bin/sh\nexec bash "$@"\n' >"$TMP/interp-bin/rab-private-interp"
chmod +x "$TMP/interp-bin/rab-private-interp"
printf '#!/usr/bin/env -S PATH=/definitely/no/such/path bash\nexit 0\n' >"$R/scripts/test-envPATHbad.sh"
printf '#!/usr/bin/env -S PATH=%s:/usr/bin:/bin rab-private-interp\necho "1 passed, 0 failed"\n' "$TMP/interp-bin" >"$R/scripts/test-envPATHok.sh"
chmod +x "$R/scripts/test-envPATHbad.sh" "$R/scripts/test-envPATHok.sh"
mkdir -p "$R/scripts/--"
cp -p "$R/scripts/test-link.sh" "$R/scripts/--/test-dash.sh"
# An executable suite outside git, so only the symlink refusal can stop it running.
cp -p "$R/scripts/test-link.sh" "$TMP/outside-suite.sh"
ln -s "$TMP/outside-suite.sh" "$R/scripts/test-symleaf.sh"
printf '#!/nonexistent/interpreter\necho "1 passed, 1 failed"\nexit 1\n' >"$R/scripts/test-noexec.sh"
chmod +x "$R/scripts/test-noexec.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$R/.git/hooks/test-meta"
chmod +x "$R/.git/hooks/test-meta"
mkdir -p "$R/scripts/lnk/deep"
cp -p "$R/scripts/test-link.sh" "$R/scripts/lnk/deep/test-deep.sh"
cp -p "$R/scripts/test-link.sh" "$R/scripts/test-dir"
# A suite whose fixture library changed with it (ludics-lite#501): the library is new in the
# working tree, so without --also the base run fails for want of it -- the wrong reason.
printf '%s\n' 'want_sum() { echo 5; }' >"$R/scripts/fixlib.sh"
cat >"$R/scripts/test-fix.sh" <<'EOF'
#!/usr/bin/env bash
HERE=$(cd "$(dirname "$0")" && pwd -P)
[ -f "$HERE/fixlib.sh" ] || { echo "NO FIXTURE LIBRARY"; echo "0 passed, 1 failed"; exit 2; }
. "$HERE/fixlib.sh"
. "$HERE/lib.sh"
pass=0; fail=0
[ "$(add 2 3)" = "$(want_sum)" ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: add 2 3"; }
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
EOF
chmod +x "$R/scripts/test-fix.sh"
ln -s "$TMP/outside-suite.sh" "$R/scripts/fixlink.sh"
status_before=$(git -C "$R" status --porcelain)

# worktrees_clean LABEL: nothing but the checkout itself registered, and no helper scratch left.
worktrees_clean() {
  local n left
  n=$(git -C "$R" worktree list --porcelain | grep -c '^worktree ')
  left=$(ls -A "$HTMP")
  if [ "$n" -eq 1 ] && [ -z "$left" ]; then
    ok "$1: no worktree registered, no scratch left"
  else
    ko "$1: $n worktrees registered, scratch left: [$left] -- $(git -C "$R" worktree list)"
  fi
}

# run_rab ARGS...: the helper from inside the scratch checkout; sets $out and $rc.
run_rab() {
  out=$(cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 "$RAB" "$@" 2>&1)
  rc=$?
}

# ---- the control: the working tree's suite passes on the working tree ------------------------
wt_out=$(cd "$R" && scripts/test-toy.sh 2>&1)
wt_rc=$?
if [ "$wt_rc" -eq 0 ] && grep -qF '2 passed, 0 failed' <<<"$wt_out"; then
  ok "control: the new suite passes in the working tree"
else
  ko "control: the new suite should pass in the working tree (rc=$wt_rc) -- $wt_out"
fi

# ---- the negative control: default base origin/main ----------------------------------------
run_rab test-toy.sh one two
if [ "$rc" -eq 1 ]; then ok "base run exits with the suite's status (1)"; else ko "base run rc=$rc want 1 -- $out"; fi
if grep -qF 'FAIL: add 2 3' <<<"$out"; then
  ok "the working tree's new case ran, against the base library"
else
  ko "the new case should fail on the base library -- $out"
fi
if grep -qF 'run-against-base: exit 1 on origin/main: 1 passed, 1 failed' <<<"$out"; then
  ok "reports exit status and pass/fail line"
else
  ko "missing the report line -- $out"
fi
if grep -qF "against origin/main ($(git -C "$R" rev-parse --short "$BASE_SHA"))" <<<"$out"; then
  ok "names the base and its commit"
else
  ko "should name origin/main and its short sha -- $out"
fi
here=$(sed -n 's/^TOPLEVEL=\([^ ]*\) HERE=\(.*\)$/\2/p' <<<"$out")
top=$(sed -n 's/^TOPLEVEL=\([^ ]*\) HERE=.*$/\1/p' <<<"$out")
if [ -n "$here" ] && [ "$top/scripts" = "$here" ] && case "$here" in "$HTMP"/*) true ;; *) false ;; esac; then
  ok "the base copy is a git checkout under \$TMPDIR, and the suite ran from it"
else
  ko "want a git toplevel under $HTMP holding the suite; got TOPLEVEL=$top HERE=$here"
fi
if grep -qF 'ARGS=[one two]' <<<"$out"; then ok "suite arguments pass through"; else ko "args lost -- $out"; fi
# The options lead: each of them is taken, the later --base winning, for as long as they lead,
# and the first word that is none of them ends them -- it and every word after it are the suite's,
# an option's name included (the 2026-10 contract; before --also it was one leading --base).
run_rab test-toy.sh --base nosuch --base fixed one --base x --timeout 5
if [ "$rc" -eq 0 ] && grep -qF 'ARGS=[one --base x --timeout 5]' <<<"$out" \
  && grep -qF 'against fixed' <<<"$out"; then
  ok "leading options are the helper's, the later --base winning; the first other word ends them"
else
  ko "option boundary: rc=$rc -- $out"
fi
worktrees_clean "after a failing base run"
if [ "$(git -C "$R" status --porcelain)" = "$status_before" ]; then
  ok "the checkout's working tree is untouched"
else
  ko "working tree changed: $(git -C "$R" status --porcelain)"
fi

# ---- --base: a fixed base passes; a suite new in the working tree runs ------------------------
run_rab test-toy.sh --base fixed
if [ "$rc" -eq 0 ] && grep -qF 'run-against-base: exit 0 on fixed: 2 passed, 0 failed' <<<"$out"; then
  ok "--base fixed: the suite passes"
else
  ko "--base fixed: rc=$rc -- $out"
fi
worktrees_clean "after a passing base run"
run_rab "$R/scripts/test-new.sh"
if [ "$rc" -eq 0 ] && grep -qF 'exit 0 on origin/main: 1 passed, 0 failed' <<<"$out"; then
  ok "a suite absent from the base (absolute path) runs"
else
  ko "new suite: rc=$rc -- $out"
fi

# ---- refusals exit 125 and leave nothing ------------------------------------------------------
run_rab test-toy.sh --base no-such-ref
if [ "$rc" -eq 125 ] && grep -qF 'no such commit: no-such-ref' <<<"$out"; then
  ok "unknown base refused with 125"
else
  ko "unknown base: rc=$rc -- $out"
fi
printf '#!/usr/bin/env bash\n' >"$TMP/outside.sh"
chmod +x "$TMP/outside.sh"
run_rab "$TMP/outside.sh"
if [ "$rc" -eq 125 ] && grep -qF 'is not inside this checkout' <<<"$out"; then
  ok "a suite outside the checkout refused with 125"
else
  ko "outside suite: rc=$rc -- $out"
fi
run_rab test-missing.sh
if [ "$rc" -eq 125 ]; then ok "a missing suite refused with 125"; else ko "missing suite: rc=$rc -- $out"; fi
worktrees_clean "after refusals"

# ---- a signal mid-run: the worktree still goes, and so does the suite ------------------------
# signal_case SIG WANT_RC [MODE [twice]]: `set -m` gives the helper its own process group with default signal
# dispositions -- a non-interactive shell starts background jobs with INT ignored, and a signal
# ignored on entry cannot be trapped.
signal_case() {
  local sig=$1 want=$2 mode=${3:---slow} pidf="$TMP/suite.pid.$1${3-}${4-}" hpid spid i rc_s
  rm -f "$pidf"
  set -m
  (cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 exec "$RAB" test-toy.sh "$mode" "$pidf") >"$TMP/sig.$sig.out" 2>&1 &
  hpid=$!
  set +m
  for i in $(seq 1 300); do
    [ -s "$pidf" ] && break
    sleep 0.1
  done
  spid=$(cat "$pidf" 2>/dev/null)
  if [ -z "$spid" ]; then
    ko "$sig: the suite never started -- $(cat "$TMP/sig.$sig.out")"
    kill -KILL "$hpid" 2>/dev/null
    return
  fi
  kill -"$sig" "$hpid"
  # A second signal inside the cleanup's grace must not cut the teardown short.
  [ "${4-}" = twice ] && sleep 0.5 && kill -"$sig" "$hpid" 2>/dev/null
  # Bounded: a helper that waits forever on a suite ignoring TERM is the regression this case is
  # for, and it must fail here rather than hang the run. An exited helper is a zombie until
  # waited for, and kill -0 reaches a zombie, so the state is read instead.
  for i in $(seq 1 300); do
    case $(ps -o stat= -p "$hpid" 2>/dev/null) in '' | Z*) break ;; esac
    sleep 0.1
  done
  if case $(ps -o stat= -p "$hpid" 2>/dev/null) in '' | Z*) false ;; *) true ;; esac then
    ko "$sig: the helper was still running 30s after $sig"
    kill -KILL -- "-$hpid" "-$spid" 2>/dev/null
  fi
  wait "$hpid"
  rc_s=$?
  if [ "$rc_s" -eq "$want" ]; then ok "$sig: helper exits $want"; else ko "$sig: helper rc=$rc_s want $want"; fi
  for i in $(seq 1 50); do
    kill -0 "$spid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$spid" 2>/dev/null; then
    ko "$sig: the suite ($spid) outlived the helper"
    kill -KILL "$spid" 2>/dev/null
  else
    ok "$sig: the suite is gone"
  fi
  worktrees_clean "after $sig mid-run"
}
signal_case TERM 143
signal_case INT 130
# A suite that ignores TERM: the helper's own wait is bounded, and KILL follows the grace.
signal_case TERM 143 --stubborn
signal_case TERM 143 --stubborn twice

# ---- what the suite leaves behind is not the helper's to wait on ------------------------------
# An orphan that inherited the suite's stdout holds the output pipe open after the suite exits;
# the helper must still report and clean up promptly, and the orphan must not outlive it.
SECONDS=0
run_rab test-toy.sh --orphan "$TMP/orphan.pid"
took=$SECONDS
opid=$(cat "$TMP/orphan.pid" 2>/dev/null)
if [ "$rc" -eq 1 ] && [ "$took" -lt 20 ] && grep -qF 'exit 1 on origin/main: 1 passed, 1 failed' <<<"$out"; then
  ok "an orphan holding the output does not hold the helper (${took}s)"
else
  ko "orphan: rc=$rc after ${took}s -- $out"
fi
# A killed orphan can sit as a zombie until init reaps it, and kill -0 reaches a zombie.
if [ -n "$opid" ] && case $(ps -o stat= -p "$opid" 2>/dev/null) in '' | Z*) true ;; *) false ;; esac then
  ok "the orphan is stopped with the suite"
else
  ko "the orphan ($opid) outlived the helper"
  [ -n "$opid" ] && kill -KILL "$opid" 2>/dev/null
fi
worktrees_clean "after an orphaned child"

# A background child with a TERM cleanup of its own gets the grace, not a fixed moment: the group
# is what is waited for, not the leader that has already exited.
rm -f "$TMP/graceful.done" "$TMP/graceful.done.ready"
out=$(cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=4 "$RAB" test-toy.sh --graceful "$TMP/graceful.done" 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && [ -s "$TMP/graceful.done" ]; then
  ok "a left-behind child's TERM cleanup completes within the grace"
else
  ko "graceful: rc=$rc, marker $( [ -s "$TMP/graceful.done" ] && echo present || echo absent) -- $out"
fi
worktrees_clean "after a graceful child"

# A base whose suite path is a symlink out of the checkout: removed, never written through.
run_rab test-link.sh --base linked
if [ "$rc" -eq 0 ] && [ "$(cat "$TMP/victim.sh")" = VICTIM ]; then
  ok "a symlinked suite path in the base is replaced, not written through"
else
  ko "symlink: rc=$rc, victim now: $(cat "$TMP/victim.sh") -- $out"
fi
worktrees_clean "after a symlinked base path"

# A parent component the base keeps as a symlink is replaced, not followed -- not even by mkdir.
run_rab lnk/deep/test-deep.sh --base linked
if [ "$rc" -eq 0 ] && [ -z "$(ls -A "$TMP/outdir")" ]; then
  ok "a symlinked parent in the base is replaced: nothing created outside the worktree"
else
  ko "parent symlink: rc=$rc, outdir holds [$(ls -A "$TMP/outdir")] -- $out"
fi
# A directory in the base where the working tree has the suite file: a path-type change.
run_rab test-dir --base linked
if [ "$rc" -eq 0 ]; then ok "a base directory at the suite's path is replaced"; else ko "dir at suite path: rc=$rc -- $out"; fi
worktrees_clean "after replacing base paths"

# A suite name that starts with a dash is a file, not an option.
run_rab -check.sh
if [ "$rc" -eq 0 ]; then ok "a suite named -check.sh runs"; else ko "leading dash: rc=$rc -- $out"; fi
# A trailing newline is part of the name: the suite named so runs, not its newline-free twin.
run_rab "test-nl.sh"$'\n'
if [ "$rc" -eq 0 ] && ! grep -qF 'WRONG FILE' <<<"$out"; then
  ok "a suite name ending in a newline runs that file"
else
  ko "trailing newline: rc=$rc -- $out"
fi
# A directory literally named `--` is a path component like any other.
run_rab ./--/test-dash.sh
if [ "$rc" -eq 0 ]; then ok "a \`--\` directory on the suite's path installs"; else ko "-- component: rc=$rc -- $out"; fi
# A suite path that is itself a symlink (here, out of the checkout) is refused, not followed.
run_rab test-symleaf.sh
if [ "$rc" -eq 125 ] && grep -qF 'is a symlink' <<<"$out"; then
  ok "a symlinked suite in the working tree is refused"
else
  ko "symlink leaf: rc=$rc -- $out"
fi
# A caller exporting git's repository-local variables (as a git hook does): the suite's git must
# still see the base worktree, not the caller's checkout.
out=$(cd "$R/scripts" && GIT_DIR="$R/.git" GIT_WORK_TREE="$R" TMPDIR="$HTMP" "$RAB" test-toy.sh 2>&1)
rc=$?
top=$(sed -n 's/^TOPLEVEL=\([^ ]*\) HERE=.*$/\1/p' <<<"$out")
if [ "$rc" -eq 1 ] && case "$top" in "$HTMP"/*) true ;; *) false ;; esac; then
  ok "GIT_DIR/GIT_WORK_TREE from the caller do not reach the suite"
else
  ko "git env: rc=$rc TOPLEVEL=$top -- $out"
fi
# ...and an exported GIT_INDEX_FILE (staged-file tooling) is not the helper's to write: the base
# worktree's checkout must not overwrite it.
g -C "$R" add scripts/test-new.sh
cp "$R/.git/index" "$TMP/alt-index"
before=$(cksum <"$TMP/alt-index")
g -C "$R" reset -q scripts/test-new.sh
out=$(cd "$R/scripts" && GIT_INDEX_FILE="$TMP/alt-index" TMPDIR="$HTMP" "$RAB" test-toy.sh 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && [ "$(cksum <"$TMP/alt-index")" = "$before" ]; then
  ok "an exported GIT_INDEX_FILE is left as it was"
else
  ko "GIT_INDEX_FILE: rc=$rc, index $( [ "$(cksum <"$TMP/alt-index")" = "$before" ] && echo same || echo REWRITTEN) -- $out"
fi
worktrees_clean "after a caller with git's local variables"
# A parent that is a submodule in the base: its content is not checked out there, so the run is
# refused rather than reported as a base failure.
run_rab subdir/test-insub.sh --base linked
if [ "$rc" -eq 125 ] && grep -qF 'is a submodule in linked' <<<"$out"; then
  ok "a path through a submodule of the base is refused"
else
  ko "base gitlink: rc=$rc -- $out"
fi
# A suite in a nested repository (as a submodule's would be) is refused from the outer one: the
# outer base holds none of its neighbours.
g init -q "$R/sub"
cp -p "$R/scripts/test-link.sh" "$R/sub/test-sub.sh"
run_rab ../sub/test-sub.sh
if [ "$rc" -eq 125 ] && grep -qF 'nested repository' <<<"$out"; then
  ok "a suite inside a nested repository is refused from the outer checkout"
else
  ko "nested repo: rc=$rc -- $out"
fi
rm -rf "$R/sub"
# A suite under .git is not a working-tree file.
run_rab "$R/.git/hooks/test-meta"
if [ "$rc" -eq 125 ] && grep -qF 'inside a .git directory' <<<"$out"; then
  ok "a path inside .git is refused"
else
  ko ".git path: rc=$rc -- $out"
fi
# ...and so did one whose `#!/usr/bin/env <prog>` names a program that is not on PATH, which the
# exec cannot see (env itself starts).
run_rab test-envmiss.sh
if [ "$rc" -eq 125 ] && grep -qF 'not on PATH' <<<"$out"; then
  ok "an env shebang naming a missing interpreter exits 125, not env's 127"
else
  ko "env interpreter: rc=$rc -- $out"
fi
# The `-S` form, as common as the plain one: a missing program behind it is caught the same way,
# and a present one runs with the suite's arguments intact.
run_rab test-envS.sh
if [ "$rc" -eq 125 ] && grep -qF 'not on PATH' <<<"$out"; then
  ok "an env -S shebang naming a missing interpreter exits 125"
else
  ko "env -S missing: rc=$rc -- $out"
fi
if [ "$(uname)" = Darwin ] || env -S true 2>/dev/null; then
  run_rab test-envSok.sh -- a
  if [ "$rc" -eq 0 ] && grep -qF 'ARGS=[-- a]' <<<"$out"; then
    ok "an env -S shebang with its program present runs, arguments intact"
  else
    ko "env -S present: rc=$rc -- $out"
  fi
fi
# A PATH= in the shebang is the PATH env searches: bash is on ours and not on that one, and a
# private interpreter is on that one and not on ours.
if [ "$(uname)" = Darwin ] || env -S true 2>/dev/null; then
  run_rab test-envPATHbad.sh
  if [ "$rc" -eq 125 ] && grep -qF 'not on the PATH its shebang sets' <<<"$out"; then
    ok "a program missing from the shebang's own PATH= exits 125"
  else
    ko "env PATH= bad: rc=$rc -- $out"
  fi
  run_rab test-envPATHok.sh
  if [ "$rc" -eq 0 ]; then
    ok "a program found only on the shebang's own PATH= runs"
  else
    ko "env PATH= ok: rc=$rc -- $out"
  fi
fi
# A suite whose interpreter is missing never ran: that is the helper's 125, not a base failure.
run_rab test-noexec.sh
if [ "$rc" -eq 125 ] && grep -qF 'it never ran' <<<"$out"; then
  ok "a suite that cannot be started exits 125, not 126/127"
else
  ko "exec failure: rc=$rc -- $out"
fi
worktrees_clean "after path-shape cases"

# The grace is validated before anything is allocated; a suite's own 125 is not the helper's.
out=$(cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=0.5 "$RAB" test-toy.sh 2>&1)
rc=$?
if [ "$rc" -eq 125 ] && grep -qF 'must be whole seconds' <<<"$out"; then
  ok "a fractional grace is refused up front"
else
  ko "grace 0.5: rc=$rc -- $out"
fi
out=$(cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=09 "$RAB" test-toy.sh 2>&1)
rc=$?
if [ "$rc" -eq 1 ]; then ok "a zero-padded grace (09) is read as decimal"; else ko "grace 09: rc=$rc -- $out"; fi
# The suite's grace is not tee's: with it at 0, a tee that has not yet seen EOF the instant the
# suite exits is still draining, not a failed capture (a macOS CI runner once took over a second).
out=$(cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=0 "$RAB" test-toy.sh 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && grep -qF 'exit 1 on origin/main: 1 passed, 1 failed' <<<"$out"; then
  ok "a zero grace still reads the suite's output and status"
else
  ko "grace 0: rc=$rc -- $out"
fi
run_rab test-toy.sh --rc125
if [ "$rc" -eq 1 ] && grep -qF 'exit 125 on origin/main' <<<"$out"; then
  ok "a suite's own 125 is reported, and exits 1"
else
  ko "suite 125: rc=$rc -- $out"
fi
worktrees_clean "after grace and 125 cases"

# A suite that leaves an unreadable directory behind: the scratch still goes (as root the
# permissions never bite, so this passes trivially there).
run_rab test-toy.sh --lockout
if [ "$rc" -eq 1 ]; then ok "an unreadable leftover: the suite's status is reported"; else ko "lockout: rc=$rc -- $out"; fi
worktrees_clean "after an unreadable leftover"

# A sparse source checkout: its patterns are copied into the base worktree, and a suite reading a
# file outside them would fail there for want of it. The base is filled in; the source stays
# sparse.
SP="$TMP/sparse"
g init -q "$SP"
mkdir -p "$SP/a" "$SP/b"
printf 'data\n' >"$SP/b/data"
printf '#!/usr/bin/env bash\nHERE=$(cd "$(dirname "$0")" && pwd -P)\n[ -f "$HERE/../b/data" ] && echo "1 passed, 0 failed"\n' >"$SP/a/test-sp.sh"
chmod +x "$SP/a/test-sp.sh"
g -C "$SP" add -A
g -C "$SP" commit -qm base
g -C "$SP" sparse-checkout set a >/dev/null 2>&1
printf '# edited\n' >>"$SP/a/test-sp.sh"
out=$(cd "$SP/a" && TMPDIR="$HTMP" "$RAB" test-sp.sh --base HEAD 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$SP/b/data" ]; then
  ok "a sparse source: the base worktree is complete, the source stays sparse"
else
  ko "sparse: rc=$rc, source b/data $( [ -e "$SP/b/data" ] && echo present || echo absent) -- $out"
fi
if [ -z "$(ls -A "$HTMP")" ] && [ "$(git -C "$SP" worktree list --porcelain | grep -c '^worktree ')" -eq 1 ]; then
  ok "after a sparse source: no worktree registered, no scratch left"
else
  ko "after a sparse source: $(git -C "$SP" worktree list)"
fi

# Another worktree of the repository whose directory is gone is not the helper's to forget:
# `git worktree prune` would drop its registration along with any of the helper's own.
g -C "$R" worktree add -q --detach "$TMP/stale-wt" HEAD
rm -rf "$TMP/stale-wt"
run_rab test-toy.sh
if git -C "$R" worktree list --porcelain | grep -qxF "worktree $TMP/stale-wt"; then
  ok "an unrelated missing worktree stays registered"
else
  ko "the unrelated worktree's registration was pruned -- $out"
fi
g -C "$R" worktree prune
worktrees_clean "after an unrelated missing worktree"

# Submodules of the base elsewhere than the suite's path are not checked out; the result says so.
run_rab test-link.sh --base linked
if grep -qF 'note: linked has 1 submodule(s), not checked out here' <<<"$out"; then
  ok "a base's submodules are named on the result"
else
  ko "submodule note missing -- $out"
fi

# ---- --also: a fixture library that changed with the suite rides into the base (#501) ---------
run_rab test-fix.sh
if [ "$rc" -eq 2 ] && grep -qF 'NO FIXTURE LIBRARY' <<<"$out"; then
  ok "without --also only the suite is copied: the base run lacks the new library"
else
  ko "no --also: rc=$rc -- $out"
fi
run_rab test-fix.sh --also fixlib.sh
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out" && ! grep -qF 'NO FIXTURE LIBRARY' <<<"$out" \
  && grep -qF 'run-against-base: also: scripts/fixlib.sh (working tree)' <<<"$out"; then
  ok "--also carries the library, so the base fails for the base's reason, and says it carried it"
else
  ko "--also: rc=$rc -- $out"
fi
run_rab test-fix.sh --also fixlib.sh --base fixed
if [ "$rc" -eq 0 ] && grep -qF 'exit 0 on fixed: 1 passed, 0 failed' <<<"$out"; then
  ok "...options in any order: --also before --base, and a fixed base passes"
else
  ko "--also then --base: rc=$rc -- $out"
fi
if ! grep -qF 'add() { echo $(($1 - $2)); }' "$R/scripts/lib.sh"; then
  ok "...and the working tree's own library was never carried with it"
else
  ko "the working tree's lib.sh changed"
fi
run_rab test-fix.sh --also fixlink.sh
if [ "$rc" -eq 125 ] && grep -qF 'is a symlink' <<<"$out"; then
  ok "an --also path that is a symlink is refused like a suite"
else
  ko "--also symlink: rc=$rc -- $out"
fi
run_rab test-fix.sh --also "$TMP/outside.sh"
if [ "$rc" -eq 125 ] && grep -qF 'is not inside this checkout' <<<"$out"; then
  ok "...and so is one outside the checkout"
else
  ko "--also outside: rc=$rc -- $out"
fi
run_rab test-fix.sh --also
if [ "$rc" -eq 125 ] && grep -qF -- '--also needs a path' <<<"$out"; then
  ok "...and an --also with no path"
else
  ko "--also bare: rc=$rc -- $out"
fi
worktrees_clean "after --also cases"

# ---- --mutate: a mutant of the change, made in the throwaway worktree only (#501, #545) ---------
lib_before=$(cksum <"$R/scripts/lib.sh")
run_rab test-toy.sh --mutate lib.sh 's/+/-/'
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out" \
  && grep -qF 'run-against-base: mutant: scripts/lib.sh: s/+/-/' <<<"$out" \
  && grep -qF 'exit 1 on the working tree: 1 passed, 1 failed' <<<"$out"; then
  ok "a mutant that undoes the fix turns the new case red, and the run names the mutation"
else
  ko "mutant: rc=$rc -- $out"
fi
if [ "$(cksum <"$R/scripts/lib.sh")" = "$lib_before" ] && [ "$(git -C "$R" status --porcelain)" = "$status_before" ]; then
  ok "...and the live tree is untouched"
else
  ko "the mutant reached the live tree: $(git -C "$R" status --porcelain)"
fi
if [ -z "$(git -C "$R" stash list)" ]; then
  ok "...and the working-tree snapshot leaves no stash entry behind"
else
  ko "the snapshot left a stash entry: $(git -C "$R" stash list)"
fi
# The snapshot is the working tree, uncommitted fix included: the base commit would fail this
# suite, so a mutant that leaves the logic alone passing is what shows the snapshot is not HEAD.
run_rab test-toy.sh --mutate lib.sh 's/$/ # mutated/'
if [ "$rc" -eq 0 ] && grep -qF 'exit 0 on the working tree: 2 passed, 0 failed' <<<"$out"; then
  ok "without --base a mutant runs on the working tree's uncommitted state, not on HEAD"
else
  ko "snapshot: rc=$rc -- $out"
fi
run_rab test-toy.sh --base fixed --mutate lib.sh 's/+/-/'
if [ "$rc" -eq 1 ] && grep -qF 'exit 1 on fixed: 1 passed, 1 failed' <<<"$out"; then
  ok "...and with --base the mutation applies to that ref's copy"
else
  ko "mutant on --base: rc=$rc -- $out"
fi
# A mutation of a carried file: --also first, then the mutation, in that order whatever the flags'.
run_rab test-fix.sh --base fixed --mutate fixlib.sh 's/5/6/' --also fixlib.sh
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out"; then
  ok "a mutation may name a file --also carried"
else
  ko "mutant of an --also file: rc=$rc -- $out"
fi
run_rab test-toy.sh --mutate lib.sh 's/no-such-text/x/'
if [ "$rc" -eq 125 ] && grep -qF 'changed nothing in scripts/lib.sh' <<<"$out"; then
  ok "a mutation that changes nothing is refused: it is not a mutant"
else
  ko "no-op mutant: rc=$rc -- $out"
fi
run_rab test-toy.sh --mutate test-new.sh 's/1 passed/2 passed/' --base fixed
if [ "$rc" -eq 125 ] && grep -qF 'nothing there to mutate' <<<"$out"; then
  ok "a mutation of a file the run's tree does not hold is refused"
else
  ko "mutant of a missing file: rc=$rc -- $out"
fi
# An untracked file is in the live tree but not in the snapshot: the refusal says so and names
# the way through, rather than calling the working tree empty there.
printf '%s\n' 'echo 2' >"$R/scripts/untracked.sh"
run_rab test-toy.sh --mutate untracked.sh 's/2/3/'
if [ "$rc" -eq 125 ] && grep -qF 'scripts/untracked.sh is untracked, and the working-tree snapshot holds tracked files only' <<<"$out" \
  && grep -qF -- '--also scripts/untracked.sh' <<<"$out"; then
  ok "a mutation of an untracked file is refused as untracked, naming --also"
else
  ko "mutant of an untracked file: rc=$rc -- $out"
fi
run_rab test-toy.sh --mutate untracked.sh 's/2/3/' --also untracked.sh
if [ "$rc" -eq 0 ] && grep -qF 'mutant: scripts/untracked.sh: s/2/3/' <<<"$out"; then
  ok "...and carried with --also it is mutated"
else
  ko "mutant of an untracked file carried: rc=$rc -- $out"
fi
rm -f "$R/scripts/untracked.sh"
run_rab test-toy.sh --mutate lib.sh
if [ "$rc" -eq 125 ] && grep -qF -- '--mutate needs a file and a sed expression' <<<"$out"; then
  ok "a --mutate without its expression is refused"
else
  ko "--mutate bare: rc=$rc -- $out"
fi
# An interrupted mutant run leaves the live tree as it was: the mutant only ever existed in the
# throwaway worktree, which goes with the run.
rm -f "$TMP/mut.pid"
set -m
(cd "$R/scripts" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 exec "$RAB" test-toy.sh --mutate lib.sh 's/+/-/' --slow "$TMP/mut.pid") >"$TMP/mut.out" 2>&1 &
mpid=$!
set +m
for i in $(seq 1 300); do [ -s "$TMP/mut.pid" ] && break; sleep 0.1; done
kill -TERM "$mpid" 2>/dev/null
wait "$mpid"
mrc=$?
if [ "$mrc" -eq 143 ] && [ "$(cksum <"$R/scripts/lib.sh")" = "$lib_before" ]; then
  ok "a mutant run stopped by TERM leaves the live tree as it was"
else
  ko "interrupted mutant: rc=$mrc, lib.sh $( [ "$(cksum <"$R/scripts/lib.sh")" = "$lib_before" ] && echo same || echo CHANGED) -- $(cat "$TMP/mut.out")"
fi
worktrees_clean "after --mutate cases"

# ---- --timeout: a hang is a failing base, not a run without a verdict (#501, #549) -------------
# timeout_case LABEL MODE [helper env...]: the hanging suite is stopped, the run exits 124, and the
# suite and the worktree are gone, well inside the bound that a missing timeout would cross.
timeout_case() {
  local label=$1 mode=$2 pidf="$TMP/to.pid.$1" spid
  shift 2
  rm -f "$pidf"
  SECONDS=0
  out=$(cd "$R/scripts" && env TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 "$@" "$RAB" test-toy.sh $TIMEOUT_ARGS "$mode" "$pidf" 2>&1)
  rc=$?
  took=$SECONDS
  spid=$(cat "$pidf" 2>/dev/null)
  if [ "$rc" -eq 124 ] && [ "$took" -lt 30 ] && grep -qF 'exit 124 on origin/main: timed out after 2s' <<<"$out"; then
    ok "$label: the hang is reported as the base failing, exit 124 (${took}s)"
  else
    ko "$label: rc=$rc after ${took}s -- $out"
  fi
  if [ -n "$spid" ] && case $(ps -o stat= -p "$spid" 2>/dev/null) in '' | Z*) true ;; *) false ;; esac then
    ok "$label: the hung suite is stopped"
  else
    ko "$label: the suite ($spid) outlived the timeout"
    [ -n "$spid" ] && kill -KILL "$spid" 2>/dev/null
  fi
  worktrees_clean "after $label"
}
TIMEOUT_ARGS="--timeout 2"
timeout_case "--timeout" --slow
# A suite that ignores TERM is killed after the grace, as at any other stop.
timeout_case "--timeout on a suite ignoring TERM" --stubborn
TIMEOUT_ARGS=
timeout_case "RUN_AGAINST_BASE_TIMEOUT" --slow RUN_AGAINST_BASE_TIMEOUT=2
# A suite that finishes inside the timeout is judged as ever.
run_rab test-toy.sh --timeout 30
if [ "$rc" -eq 1 ] && grep -qF 'exit 1 on origin/main: 1 passed, 1 failed' <<<"$out"; then
  ok "a suite that finishes inside the timeout reports its own status"
else
  ko "timeout not reached: rc=$rc -- $out"
fi
run_rab test-toy.sh --timeout 30 --rc124
if [ "$rc" -eq 1 ] && grep -qF 'exit 124 on origin/main' <<<"$out"; then
  ok "...and a suite's own 124 exits 1 while a timeout is armed, so 124 means the timeout"
else
  ko "suite 124 with a timeout: rc=$rc -- $out"
fi
run_rab test-toy.sh --timeout 1.5
if [ "$rc" -eq 125 ] && grep -qF 'must be whole seconds' <<<"$out"; then
  ok "a fractional timeout is refused up front"
else
  ko "timeout 1.5: rc=$rc -- $out"
fi
worktrees_clean "after --timeout cases"

# A suite that locks its own worktree: a single --force refuses a locked one.
run_rab test-toy.sh --lock
if [ "$rc" -eq 1 ]; then ok "a locked worktree: the suite's status is still reported"; else ko "lock: rc=$rc -- $out"; fi
worktrees_clean "after the suite locked its worktree"

# ---- a *.py suite: a lib/ module through the base's scripts/py, any other under python3 --------
# A second scratch repo shaped like this one: scripts/py (this checkout's own) and a package under
# lib/ whose unit file imports it by name and relatively. The base's library is buggy, the working
# tree fixes it and adds the case the base fails. No PYTHONPATH reaches the helper, so the case
# reaches the test's own verdict only if the helper puts lib/ on the path itself.
P="$TMP/pyrepo"
g init -q --bare "$TMP/pyorigin.git"
g init -q "$P"
mkdir -p "$P/lib/toy/tests" "$P/scripts"
: >"$P/lib/toy/__init__.py"
: >"$P/lib/toy/tests/__init__.py"
printf '%s\n' 'def add(a, b):' '    return a - b' >"$P/lib/toy/calc.py"
printf '%s\n' 'ZERO = 0' >"$P/lib/toy/tests/helper.py"
cat >"$P/lib/toy/tests/test_calc.py" <<'EOF'
import unittest

from toy.calc import add

from . import helper


class TestAdd(unittest.TestCase):
    def test_add_zero(self):
        self.assertEqual(add(2, helper.ZERO), 2)


if __name__ == "__main__":
    unittest.main()
EOF
printf '%s\n' 'OK = True' >"$P/scripts/plainlib.py"
cat >"$P/scripts/test-plain.py" <<'EOF'
import os
import sys

import plainlib  # from the file's own directory, as `python3 <file>` puts it on sys.path

print("PYTHONPATH=" + os.environ.get("PYTHONPATH", "<unset>"))
print("1 passed, 0 failed" if plainlib.OK else "0 passed, 1 failed")
sys.exit(0 if plainlib.OK else 1)
EOF
g -C "$P" add -A
g -C "$P" commit -qm old
g -C "$P" branch old
cp -p "$HERE/py" "$P/scripts/py"
g -C "$P" add -A
g -C "$P" commit -qm 'add scripts/py'
g -C "$P" remote add origin "$TMP/pyorigin.git"
g -C "$P" push -q origin main
g -C "$P" fetch -q origin
g -C "$P" checkout -qb unrunnable
chmod -x "$P/scripts/py"
g -C "$P" -c core.fileMode=true commit -qam 'scripts/py loses its mode'
g -C "$P" checkout -q main
chmod +x "$P/scripts/py"
g -C "$P" checkout -qb fixed
printf '%s\n' 'def add(a, b):' '    return a + b' >"$P/lib/toy/calc.py"
g -C "$P" commit -qam fix
g -C "$P" checkout -q main
# The working tree: the fix, the new case, and a lib/ file no module name can reach.
printf '%s\n' 'def add(a, b):' '    return a + b' >"$P/lib/toy/calc.py"
cat >"$P/lib/toy/tests/test_calc.py" <<'EOF'
import unittest

from toy.calc import add

from . import helper


class TestAdd(unittest.TestCase):
    def test_add_zero(self):
        self.assertEqual(add(2, helper.ZERO), 2)

    def test_add_nonzero(self):
        self.assertEqual(add(2, 3), 5)


if __name__ == "__main__":
    unittest.main()
EOF
cp -p "$P/lib/toy/tests/test_calc.py" "$P/lib/toy/tests/test-dash.py"
mkdir -p "$P/lib/toy/loose"
cp -p "$P/lib/toy/tests/test_calc.py" "$P/lib/toy/loose/test_loose.py"
printf '#!/bin/sh\nexec sleep 60\n' >"$TMP/interp-bin/rab-hanging-python"
chmod +x "$TMP/interp-bin/rab-hanging-python"
PY_EXTRA=
# run_py ARGS...: the helper from the root of the Python scratch checkout, PYTHONPATH unset.
run_py() {
  out=$(cd "$P" && env -u PYTHONPATH ${PY_EXTRA:+"$PY_EXTRA"} TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 "$RAB" "$@" 2>&1)
  rc=$?
}
py_clean() {
  local n left
  n=$(git -C "$P" worktree list --porcelain | grep -c '^worktree ')
  left=$(ls -A "$HTMP")
  if [ "$n" -eq 1 ] && [ -z "$left" ]; then
    ok "$1: no worktree registered, no scratch left"
  else
    ko "$1: $n worktrees registered, scratch left: [$left] -- $(git -C "$P" worktree list)"
  fi
}
wt_out=$(cd "$P" && env -u PYTHONPATH scripts/py -m unittest toy.tests.test_calc 2>&1)
wt_rc=$?
if [ "$wt_rc" -eq 0 ] && grep -qF 'Ran 2 tests' <<<"$wt_out"; then
  ok "py control: the new unit file passes in the working tree"
else
  ko "py control: the unit file should pass in the working tree (rc=$wt_rc) -- $wt_out"
fi
run_py lib/toy/tests/test_calc.py -v
if [ "$rc" -eq 1 ] && grep -qE '^test_add_nonzero .* FAIL$' <<<"$out" && grep -qE '^test_add_zero .* ok$' <<<"$out" \
  && ! grep -qE 'ImportError|ModuleNotFoundError' <<<"$out"; then
  ok "a lib/ unit file reaches its own verdict on the base, no PYTHONPATH set: the new case fails there"
else
  ko "lib/ unit file on the base: want rc 1 with test_add_nonzero FAIL and no import error; rc=$rc -- $out"
fi
if grep -qF 'run-against-base: runs as: ./scripts/py -m unittest toy.tests.test_calc' <<<"$out" \
  && grep -qF 'run-against-base: exit 1 on origin/main: FAILED (failures=1)' <<<"$out"; then
  ok "...run as \`scripts/py -m unittest <module>\`, which the run names, with unittest's verdict reported"
else
  ko "want the runs-as line and unittest's verdict -- $out"
fi
run_py lib/toy/tests/test_calc.py --base fixed -k test_add_nonzero
if [ "$rc" -eq 0 ] && grep -qF 'Ran 1 test' <<<"$out" && grep -qF 'exit 0 on fixed: OK' <<<"$out"; then
  ok "a fixed base passes, and the suite args reach unittest (-k picks the case)"
else
  ko "fixed base with -k: rc=$rc -- $out"
fi
# scripts/py that finds no Python >= 3.12 runs nothing: the suite never ran, which is not a result.
PY_EXTRA=LUDICS_PY_CANDIDATES=/nonexistent/run-against-base-python3
run_py lib/toy/tests/test_calc.py
PY_EXTRA=
if [ "$rc" -eq 125 ] && grep -qF 'never started an interpreter for lib/toy/tests/test_calc.py' <<<"$out" \
  && grep -qF 'no Python >= 3.12 found' <<<"$out"; then
  ok "scripts/py with no qualifying interpreter exits 125, not scripts/py's 2"
else
  ko "no interpreter for scripts/py: rc=$rc -- $out"
fi
# A candidate that hangs while scripts/py probes it is inside the run, so --timeout bounds it; the
# interpreter never started, so that is still 125, not a base that hung.
PY_EXTRA="LUDICS_PY_CANDIDATES=$TMP/interp-bin/rab-hanging-python"
run_py lib/toy/tests/test_calc.py --timeout 2
PY_EXTRA=
if [ "$rc" -eq 125 ] && grep -qF 'stopped by the 2s timeout); it never ran' <<<"$out"; then
  ok "...and one whose interpreter search hangs is stopped by --timeout, and exits 125"
else
  ko "hanging interpreter search under --timeout: rc=$rc -- $out"
fi
run_py lib/toy/tests/test_calc.py --base old
if [ "$rc" -ne 125 ] && grep -qF 'note: old has no scripts/py, so lib/toy/tests/test_calc.py runs under plain python3' <<<"$out" \
  && grep -qF 'runs as: python3 ./lib/toy/tests/test_calc.py' <<<"$out"; then
  ok "a base older than scripts/py falls back to plain python3, and says so"
else
  ko "base without scripts/py: rc=$rc -- $out"
fi
# A base whose scripts/py is there but cannot run is no base older than it: refused, not python3.
run_py lib/toy/tests/test_calc.py --base unrunnable
if [ "$rc" -eq 125 ] && grep -qF "the base's scripts/py is not an executable file" <<<"$out" \
  && ! grep -qF 'runs as:' <<<"$out"; then
  ok "a base whose scripts/py is not executable is refused with 125, not run under python3"
else
  ko "unrunnable scripts/py: rc=$rc -- $out"
fi
run_py lib/toy/tests/test-dash.py
if [ "$rc" -eq 125 ] && grep -qF 'is not an importable module path under lib/' <<<"$out"; then
  ok "a lib/ path no module name can reach is refused with 125"
else
  ko "lib/ dash name: rc=$rc -- $out"
fi
# A file CI's discovery never runs is no suite: not named test_*.py, or below a non-package.
run_py lib/toy/tests/helper.py
if [ "$rc" -eq 125 ] && grep -qF 'is not named test_*.py' <<<"$out"; then
  ok "a lib/ file not named test_*.py is refused with 125"
else
  ko "lib/ non-test name: rc=$rc -- $out"
fi
run_py lib/toy/loose/test_loose.py
if [ "$rc" -eq 125 ] && grep -qF 'lib/toy/loose has no __init__.py' <<<"$out"; then
  ok "a lib/ test below a directory with no __init__.py is refused with 125"
else
  ko "lib/ test outside a package: rc=$rc -- $out"
fi
run_py scripts/test-plain.py
if [ "$rc" -eq 0 ] && grep -qF 'runs as: python3 ./scripts/test-plain.py' <<<"$out" \
  && grep -qF 'PYTHONPATH=<unset>' <<<"$out"; then
  ok "a *.py suite outside lib/ runs under python3 as CI runs it: its own directory on the path, no PYTHONPATH"
else
  ko "outside lib/: rc=$rc -- $out"
fi
py_clean "after the *.py cases"

# ---- --command: a project's own runner, from the root of the run's tree (ludics-lite#765) -------
# run_rab runs from scripts/, so a command spelled from the root only resolves if it runs there.
run_rab --command --also test-toy.sh -- bash scripts/test-toy.sh one
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out" && grep -qF 'ARGS=[one]' <<<"$out" \
  && grep -qF 'run-against-base: command: bash scripts/test-toy.sh one (from PATH) against origin/main' <<<"$out" \
  && grep -qF 'run-against-base: exit 1 on origin/main: 1 passed, 1 failed' <<<"$out"; then
  ok "--command runs a PATH program from the run tree's root, with the carried suite, against the base library"
else
  ko "--command PATH program: rc=$rc -- $out"
fi
if ! grep -qF 'warning:' <<<"$out"; then
  ok "...and a branch that changes more than it carries draws no warning"
else
  ko "unexpected warning -- $out"
fi
# The argv after the `--` is the command's, verbatim: spaces, an empty word, a glob, leading
# dashes, another `--`, and the helper's own option names.
# shellcheck disable=SC2016 # expanded by the inner bash
run_rab --command -- bash -c 'printf "<%s>" "$@"; echo; echo "PWD=$(pwd -P) TOP=$(git rev-parse --show-toplevel)"' argv0 'a b' '' '*' -x -- --also --base
want_pwd=$(sed -n 's/^PWD=\([^ ]*\) TOP=.*$/\1/p' <<<"$out")
want_top=$(sed -n 's/^PWD=[^ ]* TOP=\(.*\)$/\1/p' <<<"$out")
if [ "$rc" -eq 0 ] && grep -qxF '<a b><><*><-x><--><--also><--base>' <<<"$out" \
  && [ -n "$want_pwd" ] && [ "$want_pwd" = "$want_top" ] \
  && case "$want_pwd" in "$HTMP"/*) true ;; *) false ;; esac; then
  ok "...its argv arrives verbatim, and it runs at the root of the throwaway checkout"
else
  ko "--command argv/cwd: rc=$rc -- $out"
fi
# A program with a `/` is a file of the checkout, run as the RUN TREE's copy: the base's suite
# (one case, passing) unless --also carries the working tree's.
run_rab --command -- ./test-toy.sh
if [ "$rc" -eq 0 ] && grep -qF 'exit 0 on origin/main: 1 passed, 0 failed' <<<"$out" \
  && grep -qF 'command: ./scripts/test-toy.sh (the run tree'"'"'s copy)' <<<"$out"; then
  ok "a command path runs the run tree's copy, not the working tree's"
else
  ko "--command path, base copy: rc=$rc -- $out"
fi
run_rab --command --also test-toy.sh -- ./test-toy.sh
if [ "$rc" -eq 1 ] && grep -qF 'exit 1 on origin/main: 1 passed, 1 failed' <<<"$out"; then
  ok "...and --also carries the working tree's copy of it"
else
  ko "--command path carried: rc=$rc -- $out"
fi
run_rab --command -- sh -c 'exit 125'
if [ "$rc" -eq 1 ]; then ok "a command's own 125 exits 1, as a suite's does"; else ko "command 125: rc=$rc -- $out"; fi
# Refusals, each 125 and before any worktree.
cmd_refusal() { # LABEL WANT_TEXT ARGS...
  local label=$1 want=$2
  shift 2
  run_rab "$@"
  if [ "$rc" -eq 125 ] && grep -qF -- "$want" <<<"$out"; then
    ok "--command refuses $label with 125"
  else
    ko "--command $label: rc=$rc -- $out"
  fi
}
cmd_refusal "a word before the --" 'takes its options, then -- and the command' --command test-toy.sh
cmd_refusal "options with no --" 'needs -- <program> [args...]' --command --also test-toy.sh
cmd_refusal "a -- with no program" 'needs a program after the --' --command --
cmd_refusal "a program not on PATH" 'is not a program on PATH here' --command -- run-against-base-no-such-program
cmd_refusal "a path outside the checkout" 'is not inside this checkout' --command -- "$TMP/outside.sh"
cmd_refusal "a symlinked program" 'is a symlink' --command -- ./fixlink.sh
cmd_refusal "a program the base does not hold" 'scripts/test-new.sh is not a regular file in origin/main' --command -- ./test-new.sh
cmd_refusal "a program whose env interpreter is missing" 'needs run-against-base-no-such-interpreter' --command --also test-envmiss.sh -- ./test-envmiss.sh
# The base's lib.sh is not executable: the exec fails, which is the helper's 125, not a 126.
cmd_refusal "a program that cannot be started" 'could not start' --command -- ./lib.sh
# A base that keeps the program's directory as a symlink out of the checkout would run a file
# outside the run's tree.
cmd_refusal "a program below a symlinked directory of the base" 'is not a directory of the run'"'"'s tree' --command --base linked -- ./lnk/deep/test-deep.sh
# A script found on PATH whose env interpreter is missing never runs: 125, not env's 127.
printf '#!/usr/bin/env run-against-base-no-such-interpreter\nexit 0\n' >"$TMP/interp-bin/rab-envmiss-cmd"
chmod +x "$TMP/interp-bin/rab-envmiss-cmd"
out=$(cd "$R/scripts" && PATH="$TMP/interp-bin:$PATH" TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 "$RAB" --command -- rab-envmiss-cmd 2>&1)
rc=$?
if [ "$rc" -eq 125 ] && grep -qF 'rab-envmiss-cmd needs run-against-base-no-such-interpreter' <<<"$out"; then
  ok "--command refuses a PATH script whose env interpreter is missing with 125"
else
  ko "--command PATH script, missing interpreter: rc=$rc -- $out"
fi
SECONDS=0
run_rab --command --timeout 2 -- sleep 30
if [ "$rc" -eq 124 ] && [ "$SECONDS" -lt 25 ] && grep -qF 'timed out after 2s' <<<"$out"; then
  ok "--timeout stops a hanging command: 124"
else
  ko "--command timeout: rc=$rc after ${SECONDS}s -- $out"
fi
worktrees_clean "after --command cases"
if [ "$(git -C "$R" status --porcelain)" = "$status_before" ]; then
  ok "...and the checkout's working tree is untouched"
else
  ko "working tree changed: $(git -C "$R" status --porcelain)"
fi

# ---- --revert: the head with one committed change undone (ludics-lite#765) ---------------------
# History: B0 (buggy add and mul) -> C1 (the fix: add, mul, a new extra.sh, tools.sh made
# executable) -> C2 (the cases) -> C3 (a later, independent fix to sub, a far line of lib.sh, and
# its case; docs.txt). The branch `overlap` adds C4, which rewrites C1's line of lib.sh again.
V="$TMP/rev"
g init -q "$V"
mkdir -p "$V/scripts"
cat >"$V/scripts/lib.sh" <<'EOF'
add() { echo $(($1 - $2)); }
# padding 1
# padding 2
# padding 3
# padding 4
# padding 5
sub() { echo $(($1 + $2)); }
EOF
printf '%s\n' 'mul() { echo $(($1 + $2)); }' >"$V/scripts/mul.sh"
printf '%s\n' 'echo tool' >"$V/scripts/tools.sh"
printf '%s\n' 'docs' >"$V/docs.txt"
printf '%s\n' 'notes' >"$V/notes.txt"
cat >"$V/scripts/test-v.sh" <<'EOF'
#!/usr/bin/env bash
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/lib.sh"; . "$HERE/mul.sh"
pass=0; fail=0
t() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }
t 'add 2 0' "$(add 2 0)" 2
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
EOF
chmod +x "$V/scripts/test-v.sh"
g -C "$V" add -A
g -C "$V" commit -qm B0
REV_B0=$(git -C "$V" rev-parse HEAD)
sed -i.bak 's/\$1 - \$2/$1 + $2/' "$V/scripts/lib.sh"
printf '%s\n' 'mul() { echo $(($1 * $2)); }' >"$V/scripts/mul.sh"
printf '%s\n' 'EXTRA=1' >"$V/scripts/extra.sh"
chmod +x "$V/scripts/tools.sh"
rm -f "$V/scripts/lib.sh.bak"
g -C "$V" add -A
g -C "$V" -c core.fileMode=true commit -qm C1
REV_C1=$(git -C "$V" rev-parse HEAD)
cat >"$V/scripts/test-v.sh" <<'EOF'
#!/usr/bin/env bash
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/lib.sh"; . "$HERE/mul.sh"
pass=0; fail=0
t() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }
t 'add 2 0' "$(add 2 0)" 2
t 'add 2 3' "$(add 2 3)" 5
t 'mul 2 3' "$(mul 2 3)" 6
t 'extra' "$( [ -f "$HERE/extra.sh" ] && echo y)" y
t 'tools-exec' "$( [ -x "$HERE/tools.sh" ] && echo y)" y
[ -f "$HERE/../C3" ] && t 'sub 5 2' "$(sub 5 2)" 3
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
EOF
g -C "$V" add -A
g -C "$V" commit -qm C2
sed -i.bak 's/\$1 + \$2)); }$/$1 - $2)); }/' "$V/scripts/lib.sh"
sed -i.bak '1s/\$1 - \$2/$1 + $2/' "$V/scripts/lib.sh"
rm -f "$V/scripts/lib.sh.bak"
: >"$V/C3"
printf '%s\n' 'docs, revised' >"$V/docs.txt"
g -C "$V" add -A
g -C "$V" commit -qm C3
REV_C3=$(git -C "$V" rev-parse HEAD)
g -C "$V" checkout -qb overlap
sed -i.bak '1s/.*/add() { echo $(( $1 + $2 )); }/' "$V/scripts/lib.sh"
rm -f "$V/scripts/lib.sh.bak"
g -C "$V" commit -qam C4
REV_C4=$(git -C "$V" rev-parse HEAD)
# A commit off HEAD's history, a merge, and a symlink change, each on a branch of its own.
g -C "$V" checkout -q -b side "$REV_B0"
printf '%s\n' side >"$V/side.txt"
g -C "$V" add -A
g -C "$V" commit -qm side
REV_SIDE=$(git -C "$V" rev-parse HEAD)
g -C "$V" checkout -q -b merged "$REV_C3"
g -C "$V" merge -q --no-ff -m merge side
REV_MERGE=$(git -C "$V" rev-parse HEAD)
g -C "$V" checkout -q -b withlink "$REV_C3"
ln -s lib.sh "$V/scripts/ln"
g -C "$V" add -A
g -C "$V" commit -qm link
REV_LINK=$(git -C "$V" rev-parse HEAD)
g -C "$V" checkout -q main
# The live tree carries a staged and an unstaged edit, which the snapshot holds and no run touches
# (in a file of their own: a reverse patch's context must still match the files it reverts).
printf '%s\n' 'staged' >>"$V/notes.txt"
g -C "$V" add notes.txt
printf '%s\n' 'unstaged' >>"$V/notes.txt"
v_state() {
  printf '%s\n' "$(git -C "$V" status --porcelain)" "$(git -C "$V" diff)" "$(git -C "$V" diff --cached)" \
    "$(git -C "$V" stash list)" "$(cksum <"$V/scripts/lib.sh")" "$(cksum <"$V/notes.txt")"
}
v_before=$(v_state)
run_v() { # DIR ARGS...: the helper from DIR under the revert checkout
  local d=$1
  shift
  out=$(cd "$V/$d" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 "$RAB" "$@" 2>&1)
  rc=$?
}
v_clean() {
  local n left
  n=$(git -C "$V" worktree list --porcelain | grep -c '^worktree ')
  left=$(ls -A "$HTMP")
  if [ "$n" -eq 1 ] && [ -z "$left" ] && [ "$(v_state)" = "$v_before" ]; then
    ok "$1: no worktree registered, no scratch left, the live tree's files, index and stash as they were"
  else
    ko "$1: $n worktrees, scratch [$left], state changed: $( [ "$(v_state)" = "$v_before" ] && echo no || echo YES)"
  fi
}
c1=$(git -C "$V" rev-parse --short "$REV_C1")
wt_out=$(cd "$V" && scripts/test-v.sh 2>&1)
if [ $? -eq 0 ] && grep -qF '6 passed, 0 failed' <<<"$wt_out"; then
  ok "revert control: the head passes all six cases"
else
  ko "revert control: the head should pass -- $wt_out"
fi
run_v scripts test-v.sh --revert "$REV_C1" lib.sh
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out" && ! grep -qF 'FAIL: mul' <<<"$out" \
  && ! grep -qF 'FAIL: sub' <<<"$out" && grep -qF '5 passed, 1 failed' <<<"$out" \
  && grep -qF "run-against-base: revert: $c1 under lib.sh" <<<"$out" \
  && grep -qF 'exit 1 on the working tree' <<<"$out" \
  && grep -qF 'with uncommitted tracked edits' <<<"$out"; then
  ok "--revert C1 lib.sh: the add case goes red; C1's other file stays fixed and C3's later edit survives"
else
  ko "--revert one file: rc=$rc -- $out"
fi
run_v . scripts/test-v.sh --revert "$REV_C1" .
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out" && grep -qF 'FAIL: mul 2 3' <<<"$out" \
  && grep -qF 'FAIL: extra' <<<"$out" && grep -qF 'FAIL: tools-exec' <<<"$out" && ! grep -qF 'FAIL: sub' <<<"$out"; then
  ok "--revert C1 . from the root undoes the whole commit: an added file is deleted, a mode restored"
else
  ko "--revert whole commit: rc=$rc -- $out"
fi
run_v . scripts/test-v.sh --revert "$REV_C3" docs.txt
if [ "$rc" -eq 0 ] && grep -qF '6 passed, 0 failed' <<<"$out"; then
  ok "reverting an irrelevant change still passes"
else
  ko "irrelevant revert: rc=$rc -- $out"
fi
run_v . --command --revert "$REV_C1" scripts/mul.sh -- scripts/test-v.sh
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: mul 2 3' <<<"$out" && ! grep -qF 'FAIL: add' <<<"$out"; then
  ok "--revert works in command mode too"
else
  ko "--revert with --command: rc=$rc -- $out"
fi
# The order is copies, reverts, mutations: a mutation of the reverted file sees the revert (on
# C1's own lib.sh the expression would change nothing, and be refused).
run_v scripts test-v.sh --mutate lib.sh '1s/\$1 - \$2/$1 + $2/' --revert "$REV_C1" lib.sh
if [ "$rc" -eq 0 ] && grep -qF '6 passed, 0 failed' <<<"$out"; then
  ok "a mutation applies after the revert, whatever the flags' order"
else
  ko "revert then mutate: rc=$rc -- $out"
fi
run_v scripts test-v.sh --base overlap --revert "$REV_C4" lib.sh --revert "$REV_C1" lib.sh
if [ "$rc" -eq 1 ] && grep -qF 'FAIL: add 2 3' <<<"$out" && grep -qF 'exit 1 on overlap' <<<"$out"; then
  ok "with --base, two overlapping commits revert newest first"
else
  ko "newest-first reverts: rc=$rc -- $out"
fi
v_refusal() { # LABEL WANT_TEXT ARGS...
  local label=$1 want=$2
  shift 2
  run_v scripts test-v.sh "$@"
  if [ "$rc" -eq 125 ] && grep -qF -- "$want" <<<"$out" && ! grep -qF 'passed,' <<<"$out"; then
    ok "--revert refuses $label with 125, running nothing"
  else
    ko "--revert $label: rc=$rc -- $out"
  fi
}
v_refusal "a revert that a later change overlaps" 'does not apply to overlap in reverse' --base overlap --revert "$REV_C1" lib.sh
v_refusal "an unknown commit" '--revert: no such commit: nosuch' --revert nosuch lib.sh
v_refusal "a merge commit" 'is a merge commit' --revert "$REV_MERGE" .
v_refusal "a root commit" 'is a root commit' --revert "$REV_B0" lib.sh
v_refusal "a commit outside the run's history" 'is not in the history of the working tree' --revert "$REV_SIDE" .
v_refusal "a path the commit does not change" 'changes nothing under test-v.sh' --revert "$REV_C1" test-v.sh
v_refusal "a symlink change" 'changes a symlink or a submodule' --base withlink --revert "$REV_LINK" .
v_refusal "a pathspec pattern (paths are literal)" 'changes nothing under' --revert "$REV_C1" '*.sh'
v_refusal "a --revert with no path" '--revert needs a commit and a path' --revert "$REV_C1"
v_clean "after --revert cases"

# ---- the carried-everything warning (ludics-lite#501) ---------------------------------------------
# A base run that carries every file the branch changes is the branch's own run, not a control.
Wr="$TMP/warn"
g init -q "$Wr"
mkdir -p "$Wr/scripts"
printf '%s\n' 'add() { echo $(($1 - $2)); }' >"$Wr/scripts/lib.sh"
printf '#!/usr/bin/env bash\necho "1 passed, 0 failed"\n' >"$Wr/scripts/test-w.sh"
chmod +x "$Wr/scripts/test-w.sh"
g -C "$Wr" add -A
g -C "$Wr" commit -qm base
g -C "$Wr" branch base
run_w() {
  out=$(cd "$Wr" && TMPDIR="$HTMP" RUN_AGAINST_BASE_GRACE=1 "$RAB" "$@" 2>&1)
  rc=$?
}
printf '%s\n' '# a new case' >>"$Wr/scripts/test-w.sh"
run_w scripts/test-w.sh --base base
if [ "$rc" -eq 0 ] && grep -qF 'run-against-base: warning: every file this branch changes' <<<"$out"; then
  ok "a branch that changes only its suite is warned that the base run is its own run (exit unchanged)"
else
  ko "suite-only warning: rc=$rc -- $out"
fi
run_w scripts/test-w.sh --base base --mutate scripts/lib.sh 's/-/+/'
if [ "$rc" -eq 0 ] && ! grep -qF 'warning:' <<<"$out"; then
  ok "...and a mutant run, which is the control it should take, is not"
else
  ko "warning under --mutate: rc=$rc -- $out"
fi
printf '%s\n' '# fixed' >>"$Wr/scripts/lib.sh"
run_w scripts/test-w.sh --base base
if ! grep -qF 'warning:' <<<"$out"; then
  ok "a branch that also changes code the run does not carry is not warned"
else
  ko "warned with an uncarried change -- $out"
fi
run_w scripts/test-w.sh --base base --also scripts/lib.sh
if grep -qF 'warning:' <<<"$out"; then
  ok "...but carrying that code too is warned"
else
  ko "no warning when everything is carried -- $out"
fi
g -C "$Wr" commit -qam 'the change, committed'
printf '%s\n' 'notes' >"$Wr/notes.md"
run_w scripts/test-w.sh --base base --also scripts/lib.sh
if ! grep -qF 'warning:' <<<"$out"; then
  ok "committed changes count, and so does an untracked file the run does not carry"
else
  ko "warned despite an untracked uncarried file -- $out"
fi
rm -f "$Wr/notes.md"
run_w scripts/test-w.sh --base base --also scripts/lib.sh
if grep -qF 'warning:' <<<"$out"; then
  ok "...and without it the committed branch is warned"
else
  ko "no warning on the committed branch -- $out"
fi

printf '\n%s\n' "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
exit "$?"
}
