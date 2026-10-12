#!/usr/bin/env bash
# Exercises scripts/py, the interpreter wrapper every Python entry point of the v2 rewrite runs
# through (ludics-lite#403): the probe that picks the first Python >= 3.12, the refusal that names
# every candidate when none qualifies, and how the chosen one is run -- the arguments, stdin, the
# exit status, the package on PYTHONPATH and nothing from the caller's cwd on sys.path.
#
# The probe list is replaced through LUDICS_PY_CANDIDATES with fake interpreters in a scratch
# directory, so the refusal and the ordering are exercised on a box that HAS a good Python (the
# built-in list starts at /opt/homebrew/bin/python3, which no PATH edit can hide). The cases that
# run real Python use the built-in list, so they also prove this box (or CI runner) qualifies.
#
# Usage: test-py.sh   (exit 0 all pass, 1 otherwise)

set -uo pipefail

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape.
{
HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/.." && pwd -P)
PY="$HERE/py"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/test-py.XXXXXX") || exit 1
# Resolved physically, like every root here: the wrapper computes its lib/ with `pwd -P`, and the
# fake interpreters below log paths this suite compares against (ludics-lite#208).
TMP=$(CDPATH= cd "$TMP" && pwd -P) || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "PASS: $*"
}
ko() {
  fail=$((fail + 1))
  echo "FAIL: $*"
}

# fake <path> <version> <probe exit>: an "interpreter" that answers the probe with <version> and
# <probe exit>, and otherwise logs its arguments (one per line) and PYTHONPATH to <path>.log, and
# the caller's PYTHONPATH as scripts/py noted it to <path>.caller.
fake() {
  mkdir -p "$(dirname "$1")"
  cat >"$1" <<EOF
#!/bin/sh
if [ "\$1" = -c ]; then
  printf '%s\n' '$2'
  exit $3
fi
{ for a in "\$@"; do printf 'arg:%s\n' "\$a"; done; printf 'PYTHONPATH:%s\n' "\$PYTHONPATH"; } >"$1.log"
printf 'caller:%s\n' "\${LUDICS_CALLER_PYTHONPATH-unset}" >"$1.caller"
exit 0
EOF
  chmod +x "$1"
}

# The refusal: every candidate named with what was found there, exit 2, nothing run.
mkdir -p "$TMP/bin"
fake "$TMP/bin/old" 3.9.6 1
fake "$TMP/bin/py2" 2.7.18 1
cat >"$TMP/bin/broken" <<'EOF'
#!/bin/sh
exit 3
EOF
chmod +x "$TMP/bin/broken"
candidates="$TMP/bin/absent
$TMP/bin/old
$TMP/bin/py2
$TMP/bin/broken
no-such-python-on-path"
out=$(LUDICS_PY_CANDIDATES="$candidates" "$PY" -c 'print(1)' 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ok "no qualifying interpreter exits 2" || ko "no qualifying interpreter: rc=$rc, want 2 -- $out"
for want in "no Python >= 3.12 found, so nothing was run" \
  "$TMP/bin/absent: absent" \
  "$TMP/bin/old ($TMP/bin/old): Python 3.9.6, older than 3.12" \
  "$TMP/bin/py2 ($TMP/bin/py2): Python 2.7.18, older than 3.12" \
  "$TMP/bin/broken ($TMP/bin/broken): did not run as Python (exit 3)" \
  "no-such-python-on-path: not on PATH" \
  "LUDICS_PY_CANDIDATES"; do
  case "$out" in
  *"$want"*) ok "the refusal says: $want" ;;
  *) ko "the refusal does not say '$want' -- $out" ;;
  esac
done
[ ! -e "$TMP/bin/old.log" ] && [ ! -e "$TMP/bin/py2.log" ] &&
  ok "an old interpreter is probed, never run" || ko "an old interpreter was run past its probe"

# The first qualifying candidate wins, and nothing after it is probed or run. Paths with spaces are
# kept whole (one candidate per line).
fake "$TMP/dir with spaces/new" 3.12.4 0
fake "$TMP/bin/newer" 3.14.0 0
out=$(LUDICS_PY_CANDIDATES="$TMP/bin/old
$TMP/dir with spaces/new
$TMP/bin/newer" "$PY" -m ludics.prreview 'two words' '' 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ok "a qualifying interpreter after an old one runs" || ko "rc=$rc -- $out"
log=$(cat "$TMP/dir with spaces/new.log" 2>/dev/null)
want="arg:-B
arg:-X
arg:utf8
arg:-P
arg:-m
arg:ludics.prreview
arg:two words
arg:
PYTHONPATH:$ROOT/lib"
[ "$log" = "$want" ] && ok "it gets -B -X utf8 -P, then the arguments verbatim, with lib/ as PYTHONPATH" ||
  ko "the chosen interpreter was run as: $log -- want: $want"
[ ! -e "$TMP/bin/newer.log" ] && ok "a later candidate is not run" || ko "a later candidate ran too"

# An inherited PYTHONPATH is replaced, not extended: the rewrite is standard-library only.
LUDICS_PY_CANDIDATES="$TMP/bin/newer" PYTHONPATH="$TMP/elsewhere" "$PY" -c x >/dev/null 2>&1
case "$(cat "$TMP/bin/newer.log" 2>/dev/null)" in
*"PYTHONPATH:$ROOT/lib") ok "an inherited PYTHONPATH is replaced by lib/" ;;
*) ko "PYTHONPATH was not exactly lib/: $(cat "$TMP/bin/newer.log" 2>/dev/null)" ;;
esac
# ...and noted, so the entry point can put it back for the programs it runs (ludics.cli): `=` and
# the value when it was set (empty included), nothing at all when it was not.
[ "$(cat "$TMP/bin/newer.caller" 2>/dev/null)" = "caller:=$TMP/elsewhere" ] &&
  ok "the caller's PYTHONPATH is noted for the entry point" ||
  ko "the caller's PYTHONPATH note: $(cat "$TMP/bin/newer.caller" 2>/dev/null)"
LUDICS_PY_CANDIDATES="$TMP/bin/newer" PYTHONPATH="" "$PY" -c x >/dev/null 2>&1
[ "$(cat "$TMP/bin/newer.caller" 2>/dev/null)" = "caller:=" ] &&
  ok "an empty PYTHONPATH is noted as set and empty" ||
  ko "an empty PYTHONPATH's note: $(cat "$TMP/bin/newer.caller" 2>/dev/null)"
(unset PYTHONPATH; LUDICS_PY_CANDIDATES="$TMP/bin/newer" "$PY" -c x >/dev/null 2>&1)
[ "$(cat "$TMP/bin/newer.caller" 2>/dev/null)" = "caller:" ] &&
  ok "an unset PYTHONPATH is noted as unset" ||
  ko "an unset PYTHONPATH's note: $(cat "$TMP/bin/newer.caller" 2>/dev/null)"

# The locale-coercion switch scripts/py sets for its own interpreter is noted the same way, and an
# entry point's restore (ludics.cli) hands its children the caller's value -- none, or its own.
show_coerce='import os; from ludics import cli; cli.restore_caller_environment(os.environ); print(os.environ.get("PYTHONCOERCECLOCALE", "unset"))'
out=$(unset PYTHONCOERCECLOCALE; "$PY" -c "$show_coerce" 2>&1)
[ "$out" = unset ] && ok "an unset PYTHONCOERCECLOCALE is unset again for an entry point's children" ||
  ko "an unset PYTHONCOERCECLOCALE reached the children as: $out"
out=$(PYTHONCOERCECLOCALE=warn "$PY" -c "$show_coerce" 2>&1)
[ "$out" = warn ] && ok "the caller's PYTHONCOERCECLOCALE is put back for an entry point's children" ||
  ko "PYTHONCOERCECLOCALE=warn reached the children as: $out"

# The built-in list on this box: a real interpreter >= 3.12 is found.
out=$("$PY" -c 'import sys; print(sys.version_info >= (3, 12))' 2>&1)
[ "$out" = True ] && ok "the built-in list finds a Python >= 3.12 here" ||
  ko "the built-in list did not run a Python >= 3.12: $out"

# Exit status and stdin pass through: the wrapper execs, it does not interpret.
out=$(printf 'abc' | "$PY" -c 'import sys; sys.exit(40 + len(sys.stdin.read()))' 2>&1)
rc=$?
[ "$rc" -eq 43 ] && ok "stdin reaches the program and its exit status is the wrapper's" ||
  ko "rc=$rc, want 43 -- $out"

# The package is importable, from lib/ of this checkout.
out=$("$PY" -c 'import ludics, os; print(os.path.dirname(os.path.realpath(ludics.__file__)))' 2>&1)
[ "$out" = "$ROOT/lib/ludics" ] && ok "the ludics package is importable from lib/" ||
  ko "import ludics: $out (want $ROOT/lib/ludics)"

# Through a symlinked directory (how the skills reach a checkout), lib/ is still the checkout's.
ln -s "$HERE" "$TMP/linked-scripts"
out=$("$TMP/linked-scripts/py" -c 'import ludics, os; print(os.path.dirname(os.path.realpath(ludics.__file__)))' 2>&1)
[ "$out" = "$ROOT/lib/ludics" ] && ok "run through a symlinked directory, it still finds the checkout's lib/" ||
  ko "through a symlinked directory: $out (want $ROOT/lib/ludics)"

# Nothing from the caller's cwd shadows a module: pr-review.sh runs from inside arbitrary project
# checkouts. Without -P, a `json.py` in the cwd is what `import json` loads.
mkdir -p "$TMP/project"
printf 'raise SystemExit("the cwd json.py was imported")\n' >"$TMP/project/json.py"
out=$(cd "$TMP/project" && "$PY" -c 'import json; print(json.dumps([1]))' 2>&1)
[ "$out" = "[1]" ] && ok "a module in the cwd does not shadow the standard library" ||
  ko "the cwd shadowed a module: $out"

# No bytecode lands in the checkout (ludics-lite#585): lib/ is a box's served skills checkout, and
# the preflight refuses on any file there, ignored ones included. A copy of the wrapper and lib/,
# so a cache this checkout already holds cannot stand in for the run's; PYTHONDONTWRITEBYTECODE is
# unset, as in a non-interactive ssh session, since a caller that exports it hides the defect.
mkdir -p "$TMP/served/scripts"
cp "$PY" "$TMP/served/scripts/py" && cp -R "$ROOT/lib" "$TMP/served/lib" &&
  find "$TMP/served/lib" -name __pycache__ -type d -prune -exec rm -rf {} + ||
  ko "could not copy scripts/py and lib/ (setup, not the wrapper)"
out=$(unset PYTHONDONTWRITEBYTECODE; "$TMP/served/scripts/py" -c 'import ludics.fleetworker.farside, ludics.prreview; print("ran")' 2>&1)
caches=$(find "$TMP/served/lib" -name __pycache__ 2>/dev/null)
[ "$out" = ran ] && [ -z "$caches" ] && ok "a run with PYTHONDONTWRITEBYTECODE unset leaves no __pycache__ under lib/" ||
  ko "a run with PYTHONDONTWRITEBYTECODE unset: output '$out', caches left: $caches"

# UTF-8 on the streams whatever the locale.
out=$(LC_ALL=C LANG=C "$PY" -c 'print("—")' 2>&1)
[ "$out" = "—" ] && ok "stdout is UTF-8 under LC_ALL=C" || ko "stdout under LC_ALL=C: $out"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
exit "$?"
}
