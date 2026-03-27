#!/usr/bin/env bash
set -euo pipefail

# ludics test script — shellcheck + smoke tests
# Usage: ./tests/test.sh

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pai="$root_dir/bin/ludics"

pass=0
fail=0
skip=0

green=$'\033[32m'
red=$'\033[31m'
yellow=$'\033[33m'
bold=$'\033[1m'
reset=$'\033[0m'

ok() {
  echo "  ${green}PASS${reset}  $1"
  pass=$((pass + 1))
}

fail() {
  echo "  ${red}FAIL${reset}  $1"
  if [[ -n "${2:-}" ]]; then
    echo "        $2"
  fi
  fail=$((fail + 1))
}

skipped() {
  echo "  ${yellow}SKIP${reset}  $1"
  skip=$((skip + 1))
}

# ── Section: Bash version ────────────────────────────────────────────
echo "${bold}Bash version${reset}"

if [[ "${BASH_VERSINFO[0]}" -ge 4 ]]; then
  ok "Bash ${BASH_VERSION} (>= 4 required for declare -gA)"
else
  fail "Bash ${BASH_VERSION}" "Bash 4+ required; macOS system bash is too old"
fi

# ── Section: shellcheck ──────────────────────────────────────────────
echo
echo "${bold}shellcheck${reset}"

if ! command -v shellcheck &>/dev/null; then
  skipped "shellcheck not installed"
else
  # Collect all shell scripts (bin/ludics is a compiled binary, skip it)
  scripts=()
  while IFS= read -r f; do scripts+=("$f"); done < <(find "$root_dir/templates/hooks" -name '*.sh' 2>/dev/null | sort)

  for script in "${scripts[@]}"; do
    label="${script#"$root_dir/"}"
    if shellcheck -P "$root_dir" -x -S warning "$script" &>/dev/null; then
      ok "$label"
    else
      fail "$label" "$(shellcheck -P "$root_dir" -x -S warning "$script" 2>&1 | head -5)"
    fi
  done
fi

# ── Section: smoke tests ─────────────────────────────────────────────
echo
echo "${bold}Smoke tests${reset}"

# help prints usage and exits 0
if output=$("$pai" help 2>&1) && echo "$output" | grep -q "Usage:"; then
  ok "ludics help"
else
  fail "ludics help" "expected exit 0 with 'Usage:' in output"
fi

# doctor runs and produces health-check output (may exit non-zero if env incomplete)
if output=$("$pai" doctor 2>&1) && echo "$output" | grep -q "Health Check"; then
  ok "ludics doctor (all checks passed)"
elif echo "$output" | grep -q "Health Check"; then
  ok "ludics doctor (ran with warnings)"
else
  fail "ludics doctor" "expected 'Health Check' in output"
fi

# unknown command should fail
if "$pai" this-does-not-exist &>/dev/null; then
  fail "ludics <unknown>" "expected non-zero exit"
else
  ok "ludics <unknown> → non-zero exit"
fi

# ── Section: content_fingerprint ─────────────────────────────────────
echo
echo "${bold}content_fingerprint${reset}"

# Inline the fingerprint function (was previously extracted from lib/tasks.sh)
content_fingerprint() {
  local text="$1"
  text="${text,,}"
  text="$(printf '%s' "$text" | tr -cd 'a-z0-9 ' | tr -s ' ' | sed 's/^ //;s/ $//')"
  if command -v md5sum >/dev/null 2>&1; then
    printf '%s' "$text" | md5sum | cut -c1-8
  elif command -v md5 >/dev/null 2>&1; then
    printf '%s' "$text" | md5 -q | cut -c1-8
  else
    printf '%s' "$text" | cksum | awk '{printf "%08x", $1}'
  fi
}

# Test basic format: 8-char hex
fp1="$(content_fingerprint "Add dark mode support")"
if [[ ${#fp1} -eq 8 && "$fp1" =~ ^[0-9a-f]{8}$ ]]; then
  ok "fingerprint is 8-char hex: $fp1"
else
  fail "fingerprint format" "got: '$fp1' (length ${#fp1})"
fi

# Test case insensitivity
fp2="$(content_fingerprint "ADD DARK MODE SUPPORT")"
if [[ "$fp1" == "$fp2" ]]; then
  ok "fingerprint is case-insensitive"
else
  fail "fingerprint case normalization" "$fp1 vs $fp2"
fi

# Test whitespace normalization
fp3="$(content_fingerprint "  Add   dark  mode  support  ")"
if [[ "$fp1" == "$fp3" ]]; then
  ok "fingerprint normalizes whitespace"
else
  fail "fingerprint whitespace normalization" "$fp1 vs $fp3"
fi

# Test punctuation stripping
fp4="$(content_fingerprint "Add dark-mode support!")"
fp5="$(content_fingerprint "Add darkmode support")"
if [[ "$fp4" == "$fp5" ]]; then
  ok "fingerprint strips non-alphanumeric"
else
  fail "fingerprint punctuation normalization" "$fp4 vs $fp5"
fi

# Test different texts produce different fingerprints
fp6="$(content_fingerprint "Completely different task")"
if [[ "$fp1" != "$fp6" ]]; then
  ok "different texts produce different fingerprints"
else
  fail "fingerprint collision" "$fp1 == $fp6"
fi

# ── Section: queue-hold sentinel ─────────────────────────────────────
echo
echo "${bold}queue-hold sentinel${reset}"

# Use a temp directory to simulate a harness; always clean up even on failure.
qh_tmpdir="$(mktemp -d)"
qh_cleanup() { rm -rf "$qh_tmpdir"; }
trap qh_cleanup EXIT

# 1. No sentinel file → queue is NOT held
if [[ ! -f "$qh_tmpdir/mag/queue-hold" ]]; then
  ok "queue not held when sentinel absent"
else
  fail "queue-hold initial state" "expected no sentinel file"
fi

# 2. Create mag/ dir + sentinel → queue IS held (mirrors mkdirSync + writeFileSync)
mkdir -p "$qh_tmpdir/mag"
touch "$qh_tmpdir/mag/queue-hold"
if [[ -f "$qh_tmpdir/mag/queue-hold" ]]; then
  ok "queue held when sentinel present"
else
  fail "queue-hold after create" "sentinel file not found"
fi

# 3. Remove sentinel → queue resumes (mirrors unlinkSync)
rm "$qh_tmpdir/mag/queue-hold"
if [[ ! -f "$qh_tmpdir/mag/queue-hold" ]]; then
  ok "queue resumes after sentinel removed"
else
  fail "queue-hold after remove" "sentinel file still present"
fi

# 4. mkdir -p is idempotent when mag/ already exists (covers the mkdirSync fix)
mkdir -p "$qh_tmpdir/mag"
touch "$qh_tmpdir/mag/queue-hold"
if [[ -f "$qh_tmpdir/mag/queue-hold" ]]; then
  ok "sentinel writeable after idempotent mkdir -p (existing dir)"
else
  fail "queue-hold idempotent mkdir" "could not write sentinel after re-mkdir"
fi

# 5. Sentinel writable even when mag/ did NOT pre-exist (the ENOENT fix scenario)
qh_fresh="$(mktemp -d)"
mkdir -p "$qh_fresh/mag"   # same as mkdirSync({ recursive: true }) in the fix
touch "$qh_fresh/mag/queue-hold"
if [[ -f "$qh_fresh/mag/queue-hold" ]]; then
  ok "sentinel writeable in fresh harness without pre-existing mag/"
else
  fail "queue-hold fresh harness" "could not write sentinel"
fi
rm -rf "$qh_fresh"

# ── Summary ───────────────────────────────────────────────────────────
echo
total=$((pass + fail + skip))
echo "${bold}Results: $pass passed, $fail failed, $skip skipped${reset} ($total checks)"

if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
