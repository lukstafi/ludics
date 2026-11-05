#!/usr/bin/env bash
# Re-run every pr-review fixture suite under the environment axes that broke #106.
# Local use: ship-pr/scripts/run-pr-review-hostile.sh [--shard I/N]
# Requires an installed non-C locale (default en_US.UTF-8; override PR_REVIEW_HOSTILE_LOCALE).
# Suite stderr must be empty: an exit-zero sed locale error is still a broken assertion.
#
# --shard I/N (ludics#974) runs part I (0-based, as GitHub's strategy.job-index) of N contiguous
# parts of the suite list -- every test-pr-review-*.sh beside this script, in C-locale order -- cut
# at the suite file names in PR_REVIEW_HOSTILE_CUTS ('|'-separated, N-1 of them, each the first
# suite of the part after it). The parts of one cut list are every suite once, so a new suite lands
# in some part. Refused before anything runs: N other than the cuts plus one (a matrix that lost a
# row, passed as strategy.job-total), a cut that names no suite, cuts out of order, repeated or at
# the first suite (an empty part would pass green running nothing), I outside 0..N-1, and any
# other argument. Boundary: it reads the cut list and the suite file names, nothing else.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd -P)
refuse() {
  printf '%s\n' "run-pr-review-hostile.sh: $1" >&2
  exit 2
}
shard=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shard)
      [ "$#" -ge 2 ] || refuse "--shard: want I/N after it"
      shard=$2
      shift 2
      ;;
    *) refuse "unknown argument: $(printf '%q' "$1") (usage: run-pr-review-hostile.sh [--shard I/N])" ;;
  esac
done
# Every suite, in C-locale order whatever the caller's locale: the parts must be the same lists on
# every row of a matrix.
all=()
while IFS= read -r name; do
  [ -n "$name" ] && all+=("$name")
done < <(cd "$script_dir" && for f in test-pr-review-*.sh; do [ -e "$f" ] && printf '%s\n' "$f"; done | LC_ALL=C sort)
[ "${#all[@]}" -gt 0 ] || refuse "no test-pr-review-*.sh beside it in $(printf '%q' "$script_dir")"
selected=("${all[@]}")
if [ -n "$shard" ]; then
  case "$shard" in
    [0-9]*/[0-9]*) i=${shard%%/*} n=${shard#*/} ;;
    *) refuse "--shard: want I/N (part I of N, 0-based), got $(printf '%q' "$shard")" ;;
  esac
  case "$i$n" in *[!0-9]*) refuse "--shard: want I/N (part I of N, 0-based), got $(printf '%q' "$shard")" ;; esac
  i=$((10#$i)) n=$((10#$n))
  { [ "$n" -ge 1 ] && [ "$i" -lt "$n" ]; } || refuse "--shard: part $i of $n does not exist (parts are 0..$((n - 1)))"
  cuts=()
  [ -z "${PR_REVIEW_HOSTILE_CUTS:-}" ] || IFS='|' read -r -a cuts <<<"$PR_REVIEW_HOSTILE_CUTS"
  [ "${#cuts[@]}" -eq $((n - 1)) ] ||
    refuse "--shard: $n parts need $((n - 1)) cut(s) in PR_REVIEW_HOSTILE_CUTS, which names ${#cuts[@]}: $(printf '%q' "${PR_REVIEW_HOSTILE_CUTS:-}")"
  prev=0 lo=0 hi=${#all[@]}
  for ((k = 0; k < ${#cuts[@]}; k++)); do
    at=-1
    for ((s = 0; s < ${#all[@]}; s++)); do [ "${all[$s]}" = "${cuts[$k]}" ] && at=$s; done
    [ "$at" -ge 0 ] || refuse "--shard: cut $(printf '%q' "${cuts[$k]}") names no suite here"
    [ "$at" -gt "$prev" ] || refuse "--shard: cut $(printf '%q' "${cuts[$k]}") leaves an empty part (cuts go in suite order, once each, after the first suite)"
    prev=$at
    [ "$k" -ne $((i - 1)) ] || lo=$at
    [ "$k" -ne "$i" ] || hi=$at
  done
  selected=("${all[@]:$lo:$((hi - lo))}")
  printf 'Hostile shard %s: %s of %s suites\n' "$i/$n" "${#selected[@]}" "${#all[@]}"
fi
hostile_locale=${PR_REVIEW_HOSTILE_LOCALE:-en_US.UTF-8}
# Validate in a separate process, without changing the runner's own parsing locale.
python3 - "$hostile_locale" <<'PY'
import locale
import sys
name = sys.argv[1]
if name.lower() in ('c', 'posix', 'c.utf8', 'c.utf-8'):
    sys.exit('hostile pass requires a non-C locale')
locale.setlocale(locale.LC_ALL, name)
PY

scratch=$(mktemp -d "${TMPDIR:-/tmp}/pr-review hostile.XXXXXX")
# Physical path: this runner hands $scratch to the suites as their TMPDIR, so an unresolved one
# is inherited by every fixture path they build (ludics-lite#208).
scratch=$(CDPATH= cd "$scratch" && pwd -P)
trap 'rm -rf "$scratch"' EXIT
# The copy keeps the checkout's layout around the scripts, so pr-review.sh still finds the Python
# half of a subcommand ported by ludics-lite#403 (../../scripts/py, which runs ../../lib) and runs
# it from the spaced path too. A runner copied out alone (test-pr-review-hostile.py's synthetic
# suites) has no checkout around it, and copies the scripts only.
suites="$scratch/repo with spaces/ship-pr/scripts"
mkdir -p "$suites" "$scratch/tmp with spaces"
cp -p "$script_dir/"*.sh "$suites/"
if [ -x "$script_dir/../../scripts/py" ] && [ -d "$script_dir/../../lib" ]; then
  mkdir "$scratch/repo with spaces/scripts"
  cp -p "$script_dir/../../scripts/py" "$scratch/repo with spaces/scripts/"
  cp -pR "$script_dir/../../lib" "$scratch/repo with spaces/"
fi
result=0
for name in ${selected[@]+"${selected[@]}"}; do
  suite="$suites/$name"
  printf '\nHostile pass: %s (locale=%s)\n' "$name" "$hostile_locale"
  rc=0
  # Execute the file itself, preserving the mode-bit check. Bash imports the exported
  # functions; IFS and PIPESTATUS are intentionally supplied too, though Bash resets
  # them on startup. The lib suite pins their rejection as retune constants.
  env GRACE=777 ABSENT_GRACE=5 CHECKS_INTERVAL=9 STALL=3 ROUND_GAP=1 \
    IFS=hostile PIPESTATUS=hostile LC_ALL="$hostile_locale" \
    TMPDIR="$scratch/tmp with spaces" \
    bash -c 'gh(){ :; }; fail(){ :; }; export -f gh fail; exec "$1"' _ "$suite" \
    >"$scratch/stdout" 2>"$scratch/stderr" || rc=$?
  cat "$scratch/stdout"
  cat "$scratch/stderr" >&2
  if [ "$rc" -ne 0 ] || [ -s "$scratch/stderr" ]; then
    printf 'FAIL: %s: exit=%s; stderr must be empty\n' "$name" "$rc" >&2
    result=1
  fi
  # Check before deleting anything, including hidden entries and dangling symlinks.
  leftovers=$(find "$scratch/tmp with spaces" -mindepth 1 -print)
  if [ -n "$leftovers" ]; then
    printf 'FAIL: %s left temporary files:\n%s\n' "$name" "$leftovers" >&2
    result=1
  fi
  # Give the next suite a clean TMPDIR even if this one failed its cleanup check.
  rm -rf "$scratch/tmp with spaces"
  mkdir "$scratch/tmp with spaces"
done
exit "$result"
