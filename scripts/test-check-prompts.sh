#!/usr/bin/env bash
# Exercises check-prompts.sh against a scratch tree: a well-formed layout passes, and each defect
# the checker exists for is refused with the message that names it -- with the passing tree as
# the control, since a scan that cannot fail would prove nothing (ludics-lite#55). It ends by
# running the checker on this checkout, which is the same verdict CI's prompt hygiene job reads.
#
# Usage: test-check-prompts.sh   (exit 0 all pass, 1 otherwise)

set -uo pipefail
# Feed captured assertions with here-strings: early-exiting grep must not SIGPIPE a writer.

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape.
{
# This suite runs IN GitHub Actions as one of the lint job's steps, so GITHUB_ACTIONS is ambient
# there and absent on every box it is run from at a prompt. The checker reads that variable to
# pick the refusal's form (a sentence, or a ::error annotation), so a control that lets it through
# passes locally and goes red only in CI (PR #303 closed the same class in test-preflight.sh).
# Dropped once here, for every control below: the annotation form is asserted only where a
# control sets the variable itself.
unset GITHUB_ACTIONS
HERE=$(cd "$(dirname "$0")" && pwd)
CP="$HERE/check-prompts.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/check-prompts-test.XXXXXX") || exit 1
# Physical path: check-prompts.sh resolves its own root with `pwd -P`, and on macOS $TMPDIR is
# under /var, a symlink to /private/var. Unresolved, every assertion comparing the checker's
# output against a $TMP path stops matching in silence (ludics-lite#208).
TMP=$(CDPATH= cd "$TMP" && pwd -P) || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok() { pass=$((pass + 1)); echo "PASS: $*"; }
ko() { fail=$((fail + 1)); echo "FAIL: $*"; }
# expect <label> <want-rc> <want-substring> -- <cmd...>; leaves the output in $out.
expect() {
  local label="$1" want_rc="$2" want="$3"; shift 3; [ "$1" = -- ] && shift
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq "$want_rc" ] && grep -qF -- "$want" <<<"$out"; then ok "$label"
  else ko "$label (rc=$rc want $want_rc; want /$want/) -- $out"; fi
}

# row_after_beta <row>: inserts a row into the scratch README's skill table, after `beta`.
# An insert that matched nothing would leave a probe asserting a pass over an unmutated tree,
# which is a probe that cannot fail: the helper says so instead.
row_after_beta() {
  grep -q '^| `beta` |' "$R/README.md" \
    || { ko "row_after_beta: the scratch README carries no \`beta\` row to insert after"; return 1; }
  sed -i.bak "/^| \`beta\` |/a\\
$1" "$R/README.md"
}
# beta_row <line>: replaces the scratch README's `beta` row with <line>. Matched and rewritten
# by awk rather than sed, so a replacement full of pipes needs no delimiter gymnastics.
# A replacement that matched nothing would leave a probe asserting a pass over an unmutated
# tree, which is a probe that cannot fail: the helper says so instead.
beta_row() {
  awk -v repl="$1" '/^\| `beta` \| The second\. \|$/ { print repl; hit = 1; next } { print }
    END { exit hit ? 0 : 1 }' "$R/README.md" > "$R/README.row" \
    || { ko "beta_row: the scratch README carries no \`beta\` row to replace"; return 1; }
  mv "$R/README.row" "$R/README.md"
}

# --- the scratch tree: two skills, two routines, both index tables ---------------------------
skill() {  # skill <root> <name> [frontmatter lines...]: writes <root>/<name>/SKILL.md
  local root="$1" name="$2"; shift 2
  mkdir -p "$root/$name"
  { echo '---'; printf '%s\n' "$@"; echo '---'; echo; echo "# $name"; } > "$root/$name/SKILL.md"
}
fresh() {  # fresh <root>: a passing layout from scratch
  local root="$1"
  rm -rf "$root"; mkdir -p "$root/routines" "$root/scripts"
  skill "$root" alpha 'name: alpha' 'description: The first skill.'
  skill "$root" beta 'name: beta' 'description: The second skill.' 'allowed-tools: Bash'
  skill "$root/routines" nightly 'name: nightly' 'description: A nightly routine.'
  skill "$root/routines" weekly 'name: weekly' 'description: A weekly routine.'
  cat > "$root/README.md" <<'EOF'
# scratch

| Skill | What it does |
| --- | --- |
| `alpha` | The first. |
| `beta` | The second. |

| Variable | Meaning |
| --- | --- |
| `NOT_A_SKILL` | A table with backticks that is not the skill table. |
EOF
  cat > "$root/routines/README.md" <<'EOF'
# Routines

| Routine | Kind | Fires |
| --- | --- | --- |
| `nightly` | local | daily |
| `weekly` | local | weekly |
EOF
}
R="$TMP/tree"

fresh "$R"
expect "a well-formed tree passes" 0 '6 passed, 0 failed' -- "$CP" "$R"
expect "a missing root is refused, not passed" 2 'no such directory' -- "$CP" "$TMP/nowhere"
# A root carrying no prompt at all is a verdict, not a pass over nothing.
mkdir -p "$TMP/empty"
expect "a root with no prompt at all is refused, not passed" 1 \
  "FAIL: .: no */SKILL.md or routines/*/SKILL.md under $TMP/empty" -- "$CP" "$TMP/empty"
expect "--help prints the usage and succeeds" 0 'usage: check-prompts.sh [root] | --one <dir>' -- "$CP" --help
expect "an unknown option is a usage error" 2 'check-prompts: unknown option: --bogus' -- "$CP" --bogus

# Single-directory mode shares the grammar but has no repository layout requirements.
fresh "$R"
expect "one prompt needs no README" 0 '1 passed, 0 failed' -- "$CP" --one "$R/alpha"
mv "$R/alpha" "$R/installed task"
expect "installed IDs may differ from prompt names, including paths with spaces" 0 '1 passed, 0 failed' -- "$CP" --one "$R/installed task/"
expect "missing single prompt" 1 'missing regular SKILL.md' -- "$CP" --one "$R/scripts"
expect "one requires a directory argument" 2 'usage:' -- "$CP" --one
expect "one rejects extra arguments" 2 'usage:' -- "$CP" --one "$R" extra
expect "root rejects extra arguments" 2 'usage:' -- "$CP" "$R" extra
for field in 'description: null' 'description: [' 'allowed-tools: ['; do
  skill "$R" alpha 'name: alpha' 'description: valid' "$field"
  expect "one refuses $field with the shared grammar" 1 'FAIL: SKILL.md:' -- "$CP" --one "$R/alpha"
done
skill "$R" alpha 'name: alpha' 'description: valid'
printf '\000' >> "$R/alpha/SKILL.md"
expect "one retains byte validation" 1 'NUL or invalid UTF-8' -- "$CP" --one "$R/alpha"

# --- frontmatter defects ---------------------------------------------------------------------
fresh "$R"; sed -i.bak '1d' "$R/alpha/SKILL.md"
expect "no opening fence" 1 'alpha/SKILL.md: no YAML frontmatter' -- "$CP" "$R"

fresh "$R"; printf -- '---\nname: beta\ndescription: unclosed\n\n# beta\n' > "$R/beta/SKILL.md"
expect "no closing fence" 1 'beta/SKILL.md: no YAML frontmatter' -- "$CP" "$R"
# The opening fence is the line `---` exactly: a CRLF line end or a trailing blank is not it.
fresh "$R"; printf -- '---\r\nname: alpha\r\ndescription: CRLF throughout\r\n---\r\n' > "$R/alpha/SKILL.md"
expect "a CRLF opening fence is no fence" 1 'alpha/SKILL.md: no YAML frontmatter' -- "$CP" "$R"
fresh "$R"; printf -- '--- \nname: alpha\ndescription: a blank after the fence\n---\n' > "$R/alpha/SKILL.md"
expect "...nor is one with a trailing blank" 1 'alpha/SKILL.md: no YAML frontmatter' -- "$CP" "$R"

fresh "$R"; skill "$R" alpha 'description: nameless'
expect "missing name" 1 "alpha/SKILL.md: frontmatter has no 'name:' line" -- "$CP" "$R"

fresh "$R"; skill "$R/routines" weekly 'name: weekly' 'description:'
expect "empty description" 1 "weekly/SKILL.md: frontmatter 'description:' has no value" -- "$CP" "$R"

fresh "$R"; skill "$R" beta 'name: beta' 'name: beta' 'description: twice named'
expect "duplicate name" 1 "beta/SKILL.md: frontmatter has 2 'name:' lines" -- "$CP" "$R"

# Declarations are counted as keys, not as non-empty values: a blank `name:` beside a populated
# one is two declarations, and neither the blank one nor the mismatch it could hide gets through.
fresh "$R"; skill "$R" beta 'name:' 'name: alpha' 'description: blank beside populated'
expect "a blank duplicate key still counts" 1 "beta/SKILL.md: frontmatter has 2 'name:' lines" -- "$CP" "$R"

# Values resolve the way YAML resolves a one-line scalar: the quoted, null and comment-only
# spellings of empty are empty, and quotes and a trailing comment around real text are not text.
for empty in 'description: ""' "description: ''" 'description: null' 'description: ~' 'description: # only a comment' 'description:    '; do
  fresh "$R"; skill "$R" alpha 'name: alpha' "$empty"
  expect "'$empty' is empty" 1 "alpha/SKILL.md: frontmatter 'description:' has no value" -- "$CP" "$R"
done
fresh "$R"; skill "$R" alpha "name: 'alpha'" 'description: "Quoted, with a # inside." # and a trailing note'
expect "quoted and commented values resolve to their text" 0 '6 passed, 0 failed' -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: "beta"' 'description: quoted mismatch'
expect "...so a quoted name is still compared to the directory" 1 "name 'beta' does not match its directory 'alpha'" -- "$CP" "$R"

# The value grammar is a subset of YAML: whatever it accepts a loader reads as the same string,
# and whatever a loader might read otherwise -- or reject -- is refused, with the reason. One
# probe per refusal reason, then the plain-text shapes that must stay accepted.
while IFS='|' read -r value reason; do
  fresh "$R"; skill "$R" alpha 'name: alpha' "description: $value"
  expect "'description: $value' is refused ($reason)" 1 "outside the grammar this check accepts: '$value' ($reason" -- "$CP" "$R"
done <<'CASES'
"unterminated|a double-quoted value must close
"closed" then more|a double-quoted value must close
'unterminated|a single-quoted value must close
'closed' then more|a single-quoted value must close
[]|starts with the YAML indicator '['
{}|starts with the YAML indicator '{'
[a, b]|starts with the YAML indicator '['
&anchor text|starts with the YAML indicator '&'
*alias|starts with the YAML indicator '*'
!!str text|starts with the YAML indicator '!'
`backticked`|starts with the YAML indicator '`'
- a list item|starts with '- '
? a key|starts with '? '
: a value|starts with ': '
Runs checks: quickly|contains ': ' or ends with ':'
Ends with a colon:|contains ': ' or ends with ':'
42|'42' does not start with a letter
1e3|'1e3' does not start with a letter
.inf|'.inf' does not start with a letter
2001-12-15|'2001-12-15' does not start with a letter
0b1010|'0b1010' does not start with a letter
12:34|'12:34' does not start with a letter
+1_000|'+1_000' does not start with a letter
<< merge|'<< merge' does not start with a letter
-x is plain to YAML but outside the grammar|'-x is plain to YAML but outside the grammar' does not start with a letter
true|'true' is a boolean or null
Yes|'Yes' is a boolean or null
n|'n' is a boolean or null
CASES
for value in 'Runs checks:quickly, no space after the colon' 'v1.2 of 3 things, 100% plain' \
  'Text - with - dashes and a trailing note # here' 'Nothing is 2001-12-15 once a letter leads' \
  '"Runs checks: quickly, quoted"' "'It''s quoted, with: a colon'" 'Yes it is text, not a boolean' \
  '"2001-12-15, quoted, is text"'; do
  fresh "$R"; skill "$R" alpha 'name: alpha' "description: $value"
  expect "'description: $value' is accepted" 0 '6 passed, 0 failed' -- "$CP" "$R"
done

fresh "$R"; skill "$R" alpha 'name: alpah' 'description: misspelt'
expect "name must match the directory" 1 "name 'alpah' does not match its directory 'alpha'" -- "$CP" "$R"

# A block scalar is refused by its header, whatever indicators or comment follow the `|`/`>`;
# and its body, like any continued, nested or listed value, is refused as a non-key line, so a
# value cannot span lines whichever way it is spelled.
for header in 'description: |' 'description: |2-' 'description: >+' 'description: > # folded'; do
  fresh "$R"; skill "$R" alpha 'name: alpha' "$header"
  expect "block scalar header '$header'" 1 'description is a block scalar' -- "$CP" "$R"
done
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: |' '  A block scalar body.'
expect "a block scalar body is a non-key line" 1 "not a top-level 'key: value'" -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: The first line' '  continued on a second.'
expect "a plain scalar continued on the next line" 1 "not a top-level 'key: value'" -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: listed' 'allowed-tools:' '  - Bash'
expect "a nested list" 1 "not a top-level 'key: value'" -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: commented' '# a comment line' '' 'model: sonnet'
expect "blank and comment lines between keys are fine" 0 '6 passed, 0 failed' -- "$CP" "$R"

# Double-quoted values admit only `\"` and `\\`: a backslash a loader would reject (`\q`) and one
# it would turn into a second line (`\n`) are refused alike, and the two admitted ones decode.
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: "bad \q escape"'
expect "an escape YAML rejects" 1 'may escape only \" and \\' -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: "first\nsecond"'
expect "an escape that would make a second line" 1 'may escape only \" and \\' -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: "al\"pha"' 'description: "a \"quoted\" word and a \\ backslash"'
expect "the admitted escapes decode before the directory comparison" 1 "name 'al\"pha' does not match its directory 'alpha'" -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: "a \"quoted\" word and a \\ backslash"'
expect "...and pass where the text is fine" 0 '6 passed, 0 failed' -- "$CP" "$R"

# A control character anywhere in the frontmatter is refused whole: the tab YAML reads as a
# separator after `:`, and the carriage return a loader would fold into the value.
fresh "$R"; skill "$R" alpha 'name: alpha' "description: Runs:$(printf '\t')quickly"
expect "a tab in a value" 1 'frontmatter carries a control character' -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' "description: CRLF line$(printf '\r')"
expect "a carriage return" 1 'frontmatter carries a control character' -- "$CP" "$R"
# ...found however large the frontmatter: the test is judged on grep's output, so a tab early
# in 20000 lines is not lost to grep stopping and printf dying of SIGPIPE under pipefail.
fresh "$R"; { printf -- '---\nname: alpha\n# an early tab\there\n'; awk 'BEGIN { for (i = 0; i < 20000; i++) print "# filler" }'; printf -- 'description: late\n---\n'; } > "$R/alpha/SKILL.md"
expect "a tab early in a large frontmatter" 1 'frontmatter carries a control character' -- "$CP" "$R"

# A NUL byte never reaches a shell variable (bash drops it, warning on stderr where no verdict
# reads), and invalid UTF-8 is a loader error: both are refused on the raw file, first.
fresh "$R"; printf -- '---\nname: alpha\ndescription: a NUL \000 inside\n---\n' > "$R/alpha/SKILL.md"
expect "a NUL byte" 1 'a byte sequence no loader accepts' -- "$CP" "$R"
fresh "$R"; printf -- '---\nname: alpha\ndescription: bad \377 byte\n---\n' > "$R/alpha/SKILL.md"
expect "invalid UTF-8" 1 'a byte sequence no loader accepts' -- "$CP" "$R"
# ...and the characters YAML's printable set excludes, by the spec's definition: the C1
# controls and the two non-characters. Everything else valid UTF-8 encodes is content.
fresh "$R"; printf -- '---\nname: alpha\ndescription: a C1 control \302\205 inside\n---\n' > "$R/alpha/SKILL.md"
expect "a C1 control (U+0085)" 1 'a byte sequence no loader accepts' -- "$CP" "$R"
fresh "$R"; printf -- '---\nname: alpha\ndescription: a\357\277\276 non-character\n---\n' > "$R/alpha/SKILL.md"
expect "U+FFFE" 1 'a byte sequence no loader accepts' -- "$CP" "$R"
fresh "$R"; printf -- '---\nname: alpha\ndescription: a\342\200\250b, split by a line separator\n---\n' > "$R/alpha/SKILL.md"
expect "U+2028, a line break to YAML 1.1" 1 'a byte sequence no loader accepts' -- "$CP" "$R"
# ...and read to the end: an early forbidden character in a large frontmatter is not lost to
# grep stopping at its first match and awk dying of SIGPIPE under pipefail.
fresh "$R"; { printf -- '---\nname: alpha\ndescription: a\357\277\276 early non-character\n'; awk 'BEGIN { for (i = 0; i < 5000; i++) print "# filler" }'; printf -- '---\n'; } > "$R/alpha/SKILL.md"
expect "U+FFFE early in a large frontmatter" 1 'a byte sequence no loader accepts' -- "$CP" "$R"
fresh "$R"; printf -- '---\nname: alpha\ndescription: fine\n---\n\nA body line\342\200\250split by a separator, which is not YAML.\n' > "$R/alpha/SKILL.md"
expect "...but only in the frontmatter: the Markdown body is not YAML" 0 '6 passed, 0 failed' -- "$CP" "$R"
fresh "$R"; printf -- '---\nname: alpha\ndescription: fine \303\274ber text \342\200\224 with a dash\n---\n' > "$R/alpha/SKILL.md"
expect "...while valid UTF-8 content passes" 0 '6 passed, 0 failed' -- "$CP" "$R"
# A Unicode space is content, not whitespace, to YAML and to this check (LC_ALL=C): appended
# to a name it stays in the name, which then does not match its directory.
fresh "$R"; printf -- '---\nname: alpha\342\200\202\ndescription: en space after the name\n---\n' > "$R/alpha/SKILL.md"
expect "a Unicode space is kept in the name" 1 "does not match its directory 'alpha'" -- "$CP" "$R"

# Optional keys are held to the same grammar: a loader rejects the whole file on any of them.
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: fine' 'allowed-tools: ['
expect "a malformed optional key" 1 "frontmatter 'allowed-tools:' value is outside the grammar" -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: fine' 'model:'
expect "an empty optional key" 1 "frontmatter 'model:' has no value" -- "$CP" "$R"
fresh "$R"; skill "$R" alpha 'name: alpha' 'description: fine' 'model: sonnet' 'model: opus'
expect "a duplicated optional key" 1 "frontmatter has 2 'model:' lines" -- "$CP" "$R"

# --- index lookup defects ---------------------------------------------------------------------
# The claim is one lookup per directory: the README that indexes it carries a row whose first
# cell is that directory's name in backticks. Every probe below is at that granularity -- the
# table-syntax probes went with the scanner they exercised (ludics-lite#75).

fresh "$R"; skill "$R" gamma 'name: gamma' 'description: Unindexed.'
expect "a skill missing from the README" 1 "skill 'gamma' is not indexed" -- "$CP" "$R"

fresh "$R"; skill "$R/routines" monthly 'name: monthly' 'description: Unindexed.'
expect "a routine missing from routines/README.md" 1 "routine 'monthly' is not indexed" -- "$CP" "$R"

# A row is a row by its FIRST cell, and the name is backticked there: the three ways a README
# can name a directory and still not index it each fail.
fresh "$R"; beta_row '| beta | The second, unbackticked. |'
expect "a row naming the skill without backticks" 1 "skill 'beta' is not indexed" -- "$CP" "$R"
fresh "$R"; beta_row '| `other` | Backticked in a later cell: `beta`. |'
expect "the name backticked in a later cell is not the first cell" 1 "skill 'beta' is not indexed" -- "$CP" "$R"
fresh "$R"; beta_row 'The `beta` skill, described in prose instead of indexed.'
expect "a backticked mention that is not a row" 1 "skill 'beta' is not indexed" -- "$CP" "$R"
# The name is matched as text and in full: a longer name containing it is a different directory,
# and a regex metacharacter in a name is that character.
fresh "$R"; beta_row '| `betas` | A longer name that contains this one. |'
expect "a row naming a longer name does not index the directory" 1 "skill 'beta' is not indexed" -- "$CP" "$R"
fresh "$R"; skill "$R" v1.2 'name: v1.2' 'description: A dotted name.'; row_after_beta '| `v1x2` | A row the dot must not match. |'
expect "a '.' in a directory name is not a wildcard" 1 "skill 'v1.2' is not indexed" -- "$CP" "$R"
fresh "$R"; skill "$R" v1.2 'name: v1.2' 'description: A dotted name.'; row_after_beta '| `v1.2` | A dotted name, indexed exactly. |'
expect "...while the exact dotted name indexes it" 0 '7 passed, 0 failed' -- "$CP" "$R"
# A backslash in a name is a backslash: the name reaches awk through the environment, so it is not
# escape-processed on the way in. Both directions of that are pinned, since an `-v` assignment
# would refuse the exactly-indexed name and accept the decoded spelling of a different one. The
# row is appended rather than inserted, which is all the lookup needs.
fresh "$R"; skill "$R" 'a\n' 'name: "a\\n"' 'description: A literal backslash in the name.'
printf '%s\n' '| `a\n` | A name carrying a backslash. |' >> "$R/README.md"
expect "a backslash in a directory name is matched literally" 0 '7 passed, 0 failed' -- "$CP" "$R"
fresh "$R"; skill "$R" 'a\tb' 'name: "a\\tb"' 'description: A backslash-t in the name.'
printf '%s\n' '| `a	b` | The decoded spelling, which names something else. |' >> "$R/README.md"
expect "...and what that backslash would decode to is a different name" 1 "skill 'a\tb' is not indexed" -- "$CP" "$R"
# GFM renders a body row without its leading pipe, so one counts here too.
fresh "$R"; beta_row '`beta` | The second, pipeless.'
expect "a pipeless row is a row" 0 '6 passed, 0 failed' -- "$CP" "$R"

fresh "$R"; rm "$R/routines/README.md"
expect "a missing index file" 1 'routines/README.md: missing' -- "$CP" "$R"

# With nothing to look up, the README is not thereby judged: the line says so rather than
# reading as a check that passed.
fresh "$R"; rm -r "$R/routines/nightly" "$R/routines/weekly"
expect "no directories to index says so, instead of passing silently" 0 'no routines/ SKILL.md directory to index' -- "$CP" "$R"

# The boundary of the shrunken claim, pinned from the other side so that what the lookup gave up
# is a decision on record rather than a hole nobody meant (ludics-lite#75). It models no table,
# so it reads neither a row that outlived its directory nor whether the row renders at all.
fresh "$R"; rm -r "$R/beta"
expect "a row that outlives its directory is no longer read" 0 '5 passed, 0 failed' -- "$CP" "$R"
fresh "$R"; { echo '```'; cat "$R/README.md"; echo '```'; } > "$R/README.f" && mv "$R/README.f" "$R/README.md"
expect "...and a fenced README still satisfies the lookup" 0 '6 passed, 0 failed' -- "$CP" "$R"

# Two defects in one run are both reported: the per-file loop does not stop at the first.
fresh "$R"; skill "$R" alpha 'description: nameless'; skill "$R/routines" weekly 'name: weekly'
out=$("$CP" "$R" 2>&1)
if grep -q "alpha/SKILL.md: frontmatter has no 'name:' line" <<<"$out" \
  && grep -q "weekly/SKILL.md: frontmatter has no 'description:' line" <<<"$out"; then
  ok "every defective file is reported, not only the first"
else ko "a second defective file went unreported -- $out"; fi

# Under Actions each failure is also an annotation on the file.
fresh "$R"; skill "$R" alpha 'name: alpah' 'description: x'
expect "GitHub annotations name the file" 1 '::error file=alpha/SKILL.md::' -- env GITHUB_ACTIONS=true "$CP" "$R"
# The bare call reads the suite-level `unset GITHUB_ACTIONS` at the top of the brace group.
fresh "$R"; skill "$R" alpha 'name: alpah' 'description: x'
out=$("$CP" "$R" 2>&1)
grep -q '::error' <<<"$out" && ko "annotations leak outside Actions" \
  || ok "...and only under Actions"

# --- fixture command membership ---------------------------------------------------------------
fixture_tree() {
  fresh "$R"
  mkdir -p "$R/alpha/scripts" "$R/alpha/hooks" "$R/issue-wave/scripts" "$R/ship-pr/scripts" "$R/.github/workflows"
  touch "$R/alpha/scripts/test-shell.sh" "$R/alpha/scripts/test-python.py" "$R/alpha/hooks/test-hook.py" \
    "$R/scripts/test-workflow-reporters.py" "$R/ship-pr/scripts/test-pr-review-hostile.py" \
    "$R/issue-wave/scripts/test-windows-driver.ps1" "$R/ship-pr/scripts/test-shell.sh"
  cat >> "$R/README.md" <<'EOF'
## Tests

alpha/scripts/test-shell.sh
python3 alpha/scripts/test-python.py
python3 alpha/hooks/test-hook.py
python3 scripts/test-workflow-reporters.py
python3 ship-pr/scripts/test-pr-review-hostile.py
./issue-wave/scripts/test-windows-driver.ps1
ship-pr/scripts/test-shell.sh
EOF
  cat > "$R/.github/workflows/skill-scripts.yml" <<'EOF'
jobs:
  unix:
    runs-on: ubuntu-latest
    steps:
      - run: alpha/scripts/test-shell.sh
      - run: python3 alpha/scripts/test-python.py
      - run: python3 alpha/hooks/test-hook.py
      - run: python3 scripts/test-workflow-reporters.py
      - run: python3 ship-pr/scripts/test-pr-review-hostile.py
      - run: ship-pr/scripts/test-shell.sh
  macos:
    runs-on: macos-latest
    steps:
      - run: alpha/scripts/test-shell.sh || { echo failed; exit 1; }
      - run: python3 alpha/scripts/test-python.py
      - run: python3 alpha/hooks/test-hook.py
      - run: ship-pr/scripts/test-shell.sh || { echo failed; exit 1; }
  windows:
    runs-on: windows-latest
    steps:
      - run: ./issue-wave/scripts/test-windows-driver.ps1
EOF
  cat > "$R/.github/workflows/windows-git-bash.yml" <<'EOF'
jobs:
  git-bash:
    runs-on: windows-latest
    defaults:
      run:
        shell: bash
    steps:
      - run: ship-pr/scripts/test-shell.sh || { echo '::error title=Git Bash suite failed::test-shell.sh'; exit 1; }
EOF
}
fixture_tree
expect "shell, Python, hook and platform-specific register passes" 0 'required CI platforms agree' -- "$CP" "$R"
for suite in alpha/scripts/test-shell.sh alpha/scripts/test-python.py alpha/hooks/test-hook.py scripts/test-workflow-reporters.py issue-wave/scripts/test-windows-driver.ps1 ship-pr/scripts/test-shell.sh; do
  fixture_tree
  # Keep prose and a longer filename: neither substitutes for a registered command.
  CP_REMOVE="$suite" awk 'index($0, ENVIRON["CP_REMOVE"]) { print "Mention: " $0; print $0 ".extra"; next } { print }' \
    "$R/README.md" > "$R/register.tmp"
  mv "$R/register.tmp" "$R/README.md"
  expect "README refuses missing $suite command" 1 "fixture '$suite' has no command line" -- "$CP" "$R"
done
# ship-pr's shell suites owe a Git Bash leg on Windows as well (ludics-lite#318); the other shell
# suites do not, which the passing tree above already shows for alpha/scripts/test-shell.sh.
for platform in ubuntu macos git-bash; do
  suites="ship-pr/scripts/test-shell.sh"
  [ "$platform" = git-bash ] || suites="alpha/scripts/test-shell.sh alpha/scripts/test-python.py alpha/hooks/test-hook.py $suites"
  wf="$R/.github/workflows/skill-scripts.yml"
  [ "$platform" != git-bash ] || wf="$R/.github/workflows/windows-git-bash.yml"
  for suite in $suites; do
    fixture_tree
    CP_REMOVE="$suite" CP_OS="$platform" awk '
      /^  [A-Za-z0-9_-]+:/ { job=$1; sub(/:$/, "", job) }
      /runs-on:/ { os=$2; sub(/-latest$/, "", os); if (job == "git-bash") os = "git-bash" }
      os == ENVIRON["CP_OS"] && index($0, ENVIRON["CP_REMOVE"]) {
        print "      # run: " ENVIRON["CP_REMOVE"]
        print "      - name: " ENVIRON["CP_REMOVE"]
        print "      - run: echo " ENVIRON["CP_REMOVE"]
        print "      - run: " ENVIRON["CP_REMOVE"] ".extra"
        next
      }
      { print }
    ' "$wf" > "$R/workflow.tmp"
    mv "$R/workflow.tmp" "$wf"
    expect "$platform refuses missing $suite execution" 1 "fixture '$suite' has no inline run command on $platform" -- "$CP" "$R"
  done
done
# The Git Bash leg is windows-git-bash.yml's git-bash JOB, not any Windows runner: the same run
# line moved into the PowerShell windows-driver job shares the runner and is still refused (PR
# #321, review round 2), and so is a job keyed git-bash that runs somewhere other than Windows, or
# one back in skill-scripts.yml, the per-push file it moved out of (ludics-lite#339).
fixture_tree
: > "$R/.github/workflows/windows-git-bash.yml"
awk '
  { print }
  /- run: \.\/issue-wave\/scripts\/test-windows-driver\.ps1/ { print "      - run: ship-pr/scripts/test-shell.sh" }
' "$R/.github/workflows/skill-scripts.yml" > "$R/workflow.tmp"
mv "$R/workflow.tmp" "$R/.github/workflows/skill-scripts.yml"
expect "a ship-pr suite run by another Windows job is no Git Bash leg" 1 \
  "fixture 'ship-pr/scripts/test-shell.sh' has no inline run command on git-bash" -- "$CP" "$R"
fixture_tree
awk '/^  git-bash:/ { gb = 1 } gb && /runs-on:/ { sub(/windows-latest/, "ubuntu-latest"); gb = 0 } { print }' \
  "$R/.github/workflows/windows-git-bash.yml" > "$R/workflow.tmp"
mv "$R/workflow.tmp" "$R/.github/workflows/windows-git-bash.yml"
expect "...nor is a job keyed git-bash on another runner" 1 \
  "fixture 'ship-pr/scripts/test-shell.sh' has no inline run command on git-bash" -- "$CP" "$R"
fixture_tree
sed 1d "$R/.github/workflows/windows-git-bash.yml" >> "$R/.github/workflows/skill-scripts.yml"
rm "$R/.github/workflows/windows-git-bash.yml"
expect "...nor is the git-bash job back in skill-scripts.yml" 1 \
  "windows-git-bash.yml: fixture 'ship-pr/scripts/test-shell.sh' has no inline run command on git-bash" -- "$CP" "$R"
for suite in scripts/test-workflow-reporters.py ship-pr/scripts/test-pr-review-hostile.py issue-wave/scripts/test-windows-driver.ps1; do
  fixture_tree
  CP_REMOVE="$suite" awk 'index($0, ENVIRON["CP_REMOVE"]) == 0' "$R/.github/workflows/skill-scripts.yml" > "$R/workflow.tmp"
  mv "$R/workflow.tmp" "$R/.github/workflows/skill-scripts.yml"
  expect "platform-specific $suite still requires its CI command" 1 "fixture '$suite' has no inline run command" -- "$CP" "$R"
done
fixture_tree
rm "$R/.github/workflows/skill-scripts.yml"
expect "fixtures require a workflow" 1 'no inline run command on ubuntu' -- "$CP" "$R"
fixture_tree
rm "$R/alpha/scripts/test-python.py"
# The lookup is one-way, as the prompt register is: stale commands require no table model.
expect "a removed fixture leaves no membership obligation" 0 '0 failed' -- "$CP" "$R"
# A suite is a .sh, .py or .ps1 file: another `test-*` file is data, and owes no register line.
fixture_tree
touch "$R/alpha/scripts/test-data.json"
expect "a test-* file that is not a suite carries no obligation" 0 'required CI platforms agree' -- "$CP" "$R"
# The README's register is its `## Tests` section: the same command line under another heading
# registers nothing.
fixture_tree
sed 's/^## Tests$/## Notes/' "$R/README.md" > "$R/register.tmp" && mv "$R/register.tmp" "$R/README.md"
expect "a command line outside the README's Tests section is not in the register" 1 \
  "fixture 'alpha/scripts/test-shell.sh' has no command line" -- "$CP" "$R"

# --- the mac-studio correctness-slot count ----------------------------------------------------
# The prompts quote a number that lives in one line of fleet-worker.sh (ludics-lite#160), so this
# tree is the real files, COPIED: a probe over invented prose would keep passing while the
# checker's spellings drifted away from the ones the prompts actually use. Every mutation below
# rewrites a copy under $TMP; nothing in the checkout is touched. The tree is a valid root on its
# own -- the real README indexes more skills than it holds, which the index lookup allows, its
# links all have their targets ($LINK_TARGETS), and it carries no fixture, so no membership
# obligation comes with it. `native-claude.md` is in it as a file the slot scan DISCOVERS rather
# than requires: it states the count and is held for it.
SRC=$(cd "$HERE/.." && pwd)
WORKER=issue-wave/scripts/fleet-worker.sh
# copy_prompts <root> <file>...: each named file of this checkout, at the path it lives in.
copy_prompts() {
  local root="$1" f; shift
  for f in "$@"; do
    mkdir -p "$root/$(dirname "$f")"
    cp "$SRC/$f" "$root/$f"
  done
}
# LINK_TARGETS: the Markdown that README.md, issue-wave/SKILL.md and each other reach by relative
# link -- the wave's reference files, shipping prompt, hook README and the Linux bootstrap's notes. The two
# real-file trees below carry them because the link check reads every such link in the prompts they
# copy, and a tree holding a linking file without its target would fail on a defect its probes are
# not about. Listed rather than discovered: discovering them means running the extraction under
# test, and copying every Markdown file instead doubles this suite's runtime, since each rebuild is
# then re-scanned in full. A link added to a copied prompt whose target is not named here fails
# LOUDLY -- on every probe of that tree at once, with the path it could not resolve in the message.
LINK_TARGETS="issue-wave/references/cli-claude.md issue-wave/references/executions.md
  issue-wave/references/native-claude.md issue-wave/references/native-codex.md
  issue-wave/references/native-workers.md issue-wave/references/separate-codex.md
  issue-wave/references/app-claude.md
  issue-wave/references/post-wave.md issue-wave/references/paired-planning.md
  issue-wave/references/linux-boxes.md issue-wave/references/wsl-boxes.md
  ship-pr/SKILL.md ship-pr/hooks/README.md scripts/install-linux.md"
# The default as the checker reads it, and a number that is not it: the probes state no literal
# count, so raising the default again leaves them testing the same thing.
# The LAST such assignment, as the shell and the checker both take it: reading every match would
# make WANT a two-line string the moment a second one landed, and the arithmetic below would end
# the suite with a syntax error before a single assertion ran. Derived independently of the
# checker -- a probe that computed its expectation with the code under test would prove nothing --
# and refused outright if it is not one plain number.
WANT=$(sed -n 's/^SLOTS=.*mac-studio=\([0-9][0-9]*\).*/\1/p' "$SRC/$WORKER" | tail -n 1)
case "$WANT" in
  '' | *[!0-9]*) ko "the slot probes need one numeric mac-studio default in $WORKER; read '$WANT'"; WANT=; ;;
esac
# Base ten explicitly: a default legitimately spelled `08` is eight to the worker and to the
# checker, and an octal token to bash arithmetic -- which would end the suite here.
OTHER=$(( 10#0${WANT:-0} + 1 ))
# A spelling used as the STALE one must not be the default's own, or the mutation would replace a
# word with itself: `slots_edit` would report that nothing changed and the probe would assert a
# refusal the tree no longer earns. Both pairs move out of the way if the default ever becomes the
# number they spell -- which is the very change this whole check exists for.
STALE=eleven;     [ "${WANT:-0}" = 11 ] && STALE=twelve
STALE_HYPHEN=twenty-six; [ "${WANT:-0}" = 26 ] && STALE_HYPHEN=twenty-seven
slots_tree() {
  rm -rf "$R"
  mkdir -p "$R/issue-wave/scripts"
  # $LINK_TARGETS unquoted on purpose: a list of paths, none of which carries a blank.
  # shellcheck disable=SC2086
  copy_prompts "$R" README.md routines/README.md issue-wave/SKILL.md $LINK_TARGETS
  cp "$SRC/$WORKER" "$R/$WORKER"
}
# slots_edit <file> <sed-expression>: rewrites one copy. An expression that matched nothing would
# leave a probe asserting a refusal the tree no longer earns, so the helper says so instead.
slots_edit() {
  sed "$2" "$R/$1" > "$R/slots.tmp" || { ko "slots_edit: sed failed on $1"; return 1; }
  cmp -s "$R/slots.tmp" "$R/$1" && { ko "slots_edit: '$2' matched nothing in $1"; return 1; }
  mv "$R/slots.tmp" "$R/$1"
}

slots_tree
expect "the prompts and fleet-worker.sh state one mac-studio slot count" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# The script moves and the prose does not: one edit at the source, every file that states the
# count refused -- the discovered `native-claude.md` among them, not just the required three.
slots_tree
slots_edit "$WORKER" "s/mac-studio=$WANT/mac-studio=$OTHER/g"
out=$("$CP" "$R" 2>&1); rc=$?
miss=
for f in README.md issue-wave/SKILL.md issue-wave/references/executions.md issue-wave/references/native-claude.md; do
  grep -qF "FAIL: $f: " <<<"$out" || miss="$miss $f"
done
[ "$rc" -eq 1 ] && [ -z "$miss" ] \
  && ok "a new default in the script alone leaves every file that states the count refused" \
  || ko "a new default in the script alone leaves every file that states the count refused (rc=$rc; silent:$miss) -- $out"

# ...and each file moving alone, in each spelling the prose uses: `mac-studio=<n>`, and the
# numeral phrase before `on mac-studio`.
slots_tree
slots_edit issue-wave/references/executions.md "s/mac-studio=$WANT/mac-studio=$OTHER/"
expect "a rewritten mac-studio=<n> is refused" 1 "states 'mac-studio=$OTHER'" -- "$CP" "$R"

slots_tree
slots_edit README.md "s/([a-z]* on$/($STALE on/"
expect "a rewritten count word is refused, wrapped across a line" 1 "README.md: spells the mac-studio slot count '$STALE'" -- "$CP" "$R"

slots_tree
slots_edit issue-wave/SKILL.md "s/([a-z]* on mac-studio/($STALE on mac-studio/"
expect "a rewritten count word is refused in the skill" 1 "SKILL.md: spells the mac-studio slot count '$STALE'" -- "$CP" "$R"

# A file nobody listed: the scan holds whatever states the count, which is what keeps a list from
# going stale behind a new quotation of the number.
slots_tree
slots_edit issue-wave/references/native-claude.md "s/([a-z]* on mac-studio/($STALE on mac-studio/"
expect "a discovered reference is held to the count too" 1 "native-claude.md: spells the mac-studio slot count '$STALE'" -- "$CP" "$R"

# The whole token, not its prefix: `<box>=<n>` takes an integer, and a value the worker would
# reject must not read as agreement because it starts with the right digit.
slots_tree
slots_edit issue-wave/references/executions.md "s/mac-studio=$WANT/mac-studio=${WANT}oops/"
expect "a malformed mac-studio=<n> is not agreement" 1 "states 'mac-studio=${WANT}oops'" -- "$CP" "$R"

# ...and the justification shape stays scoped to slot prose: an ordinary sentence of that shape,
# even dropped into the slot paragraph itself, states no slot count.
# The word before `on mac-studio` is read WHOLE and then asked whether it is a count at all. Both
# halves matter and pull opposite ways: a suffix rule reads `twenty-six` as the `six` it ends with
# and `done` as a count of `done`, while a bare vocabulary rule lets `thirteen` state a number no
# spelling is checked against -- silently, in a file nothing requires to speak.
slots_tree
slots_edit issue-wave/SKILL.md "s/([a-z]* on mac-studio/($STALE_HYPHEN on mac-studio/"
expect "a compound numeral is read whole, not by its suffix" 1 "SKILL.md: spells the mac-studio slot count '$STALE_HYPHEN'" -- "$CP" "$R"

slots_tree
slots_edit issue-wave/references/native-claude.md "s/([a-z]* on mac-studio/(${STALE_HYPHEN%%-*} on mac-studio/"
expect "a numeral past the default's own spellings is still a count" 1 "native-claude.md: spells the mac-studio slot count '${STALE_HYPHEN%%-*}'" -- "$CP" "$R"

for sentence in 'The cleanup is done on mac-studio.' 'Someone on mac-studio noticed.'; do
  slots_tree
  printf '\n%s\n' "$sentence" >> "$R/README.md"
  expect "ordinary prose ending in a number word states no count: ${sentence%% *}..." 0 'mac-studio correctness slots agree' -- "$CP" "$R"
done

# The `<N>, not <m>` justification is deliberately not a form this check reads (ludics-lite#202):
# nothing in that shape is about slots, and a window wide enough to catch the real ones reads
# ordinary comparisons beside the slot paragraph as counts. Both of these are ordinary prose.
for sentence in 'Choose one, not two modes.' 'Eleven, not three, since nothing.'; do
  slots_tree
  slots_edit README.md "s/a run-time count a worker takes/a run-time count. $sentence A worker takes/"
  expect "a numeral comparison beside the slot paragraph states no count: ${sentence%% *}..." 0 'mac-studio correctness slots agree' -- "$CP" "$R"
done

# Punctuation that closes a mention is punctuation, wherever Markdown puts it -- a correct count
# inside brackets or braces states the default, and only a non-punctuation suffix is malformed.
for wrap in '[mac-studio=%s]' '{mac-studio=%s}:' '"mac-studio=%s".'; do
  slots_tree
  printf "\nRoster $wrap here.\n" "$WANT" >> "$R/README.md"
  expect "a count closed by Markdown punctuation is the count: $wrap" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
done
slots_tree
printf '\nRoster [mac-studio=%s] here.\n' "$OTHER" >> "$R/README.md"
expect "...and a stale one inside brackets is still refused" 1 "states 'mac-studio=$OTHER'" -- "$CP" "$R"
slots_tree
printf '\nRoster mac-studio=%soops here.\n' "$WANT" >> "$R/README.md"
expect "...while a suffix that is not punctuation is still malformed" 1 "states 'mac-studio=${WANT}oops'" -- "$CP" "$R"

# The box name at a token boundary: another box's name ending in it is another box, and a roster
# that names no mac-studio has no mac-studio default to check the prompts against.
slots_tree
slots_edit "$WORKER" "s/echo mac-studio=$WANT/echo not-mac-studio=$WANT/"
expect "a box whose name merely ends in mac-studio is another box" 1 "$WORKER: SLOTS assignment states no 'mac-studio=<n>' default" -- "$CP" "$R"

# The shell keeps the LAST assignment, so this check reads that one: reading the first would
# report a default a later line replaced, and the later line is skipped as an assignment.
slots_tree
printf 'SLOTS=mac-studio=%s\n' "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "a later SLOTS assignment is the default the prompts are held to" \
  || ko "a later SLOTS assignment is the default the prompts are held to (rc=$rc) -- $out"

# The default is the assignment's VALUE: prose on the line cannot stand in for a default the
# script no longer has.
slots_tree
slots_edit "$WORKER" 's/^SLOTS=.*/SLOTS="${FLEET_BOX_CORRECTNESS_SLOTS-}" # old mac-studio=6/'
expect "a default left only in a trailing comment is no default" 1 "$WORKER: SLOTS assignment states no 'mac-studio=<n>' default" -- "$CP" "$R"
# ...and the default token is bounded at BOTH ends: a count the worker would reject is not a
# default of the digits it starts with, and the assignment scan would not catch it as prose.
slots_tree
slots_edit "$WORKER" "s/echo mac-studio=$WANT/echo mac-studio=${WANT}oops/"
expect "a malformed default is no default" 1 "$WORKER: SLOTS assignment states 'mac-studio=${WANT}oops'" -- "$CP" "$R"
# The value is read as the shell takes it, so a pair list with another box first still defaults.
slots_tree
slots_edit "$WORKER" "s|^SLOTS=.*|SLOTS=\"\${FLEET_BOX_CORRECTNESS_SLOTS-testbox=2 mac-studio=$WANT}\"|"
expect "a default behind another box's pair is still the default" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# The box name ends at a token boundary, and the count is the whole numeral PHRASE before the
# sentence, not a number word standing inside it. Each of these states something other than the
# default; a suffix rule reads them as `six`, `six` and a count of `done`.
slots_tree
slots_edit README.md 's/([a-z]* on$/(six on/;s/^mac-studio)/mac-studio-pro)/'
expect "a count about a box whose name starts with mac-studio is not this one's" 1 'README.md: states no mac-studio slot count' -- "$CP" "$R"

slots_tree
slots_edit issue-wave/references/native-claude.md 's/([a-z]* on mac-studio/(twenty six on mac-studio/'
expect "a numeral phrase is read whole, spaces and all" 1 "native-claude.md: spells the mac-studio slot count 'twenty six'" -- "$CP" "$R"
# The box name's far boundary may be the end of the text itself: a phrase closing the file, with
# no newline after it, is read like any other.
slots_tree
printf '\n%s on mac-studio' "$STALE" >> "$R/README.md"
expect "a count phrase ending the file is still read" 1 "README.md: spells the mac-studio slot count '$STALE'" -- "$CP" "$R"

# A file the scan skips before reading it is a file the scan cannot hold, so the one filter that
# stands before `slot_mentions` is pinned here. A NUL anywhere makes grep call the file binary,
# and the greps this suite runs under disagree about what that prints and where -- BSD grep says
# `Binary file … matches` on stdout, GNU grep 3.5+ says it on stderr, ugrep reports no match --
# so without `-a` this probe passes on macOS and fails on the Linux CI, which is the defect it
# is here to keep out. The NUL stands BEFORE the mention, where the binary verdict is reached
# first; the file is a discovered one, stating a count nothing requires it to state.
slots_tree
printf 'a stray \000 byte, and then:\n\n%s on mac-studio, this note says.\n' "$STALE" > "$R/notes-with-a-nul.md"
expect "a stale count in a file carrying a NUL is still refused" 1 "notes-with-a-nul.md: spells the mac-studio slot count '$STALE'" -- "$CP" "$R"

# A word carrying punctuation ends the phrase rather than joining it: the `one.` closing a
# sentence is not part of the `Six` opening the next.
slots_tree
slots_edit issue-wave/SKILL.md 's/([a-z]* on mac-studio/(the WSL boxes have one. Six on mac-studio/'
expect "a numeral across a sentence boundary does not join the phrase" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# A blank the shell does not split on does not end the assignment word either.
slots_tree
printf '%s\n' 'export FLEET_BOX_CORRECTNESS_SLOTS=testbox=2\ mac-studio=2' >> "$R/$WORKER"
expect "an override whose blank is escaped states no default" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# A heredoc body is data the script writes, not code it runs -- this one hands workers their
# briefs, and the assignment scan would not catch a `SLOTS=` line inside one as prose either.
slots_tree
printf ": <<'HD'\nSLOTS=mac-studio=%s\nHD\n" "$OTHER" >> "$R/$WORKER"
expect "a SLOTS line inside a heredoc assigns nothing" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# Prose written in the SHAPE of an assignment, inside a comment, is still prose -- and
# fleet-worker.sh's header is one of the declarations this check exists to hold in sync, so
# excusing it there would defeat the check on the file it was built around.
slots_tree
slots_edit "$WORKER" "s/^#     box (ludics-lite#157); an unnamed box has one. .mac-studio=$WANT./#     box (ludics-lite#157); an unnamed box has one. FLEET_BOX_CORRECTNESS_SLOTS=mac-studio=$OTHER/"
expect "a count in a comment is held even when it is spelled as an assignment" 1 "$WORKER: states 'mac-studio=$OTHER'" -- "$CP" "$R"
slots_tree
printf '# was: SLOTS=mac-studio=%s\n' "$OTHER" >> "$R/$WORKER"
expect "...and a commented-out assignment is a statement, not a setting" 1 "$WORKER: states 'mac-studio=$OTHER'" -- "$CP" "$R"
# The other side of that reading: a real assignment keeps its quoted value, which is part of it.
slots_tree
printf '\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 mac-studio=2" fleet-worker.sh ls\n' \
  >> "$R/issue-wave/references/executions.md"
expect "a quoted override is still an input, not a statement" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# A heredoc-like operator inside quotes opens no body either -- the other half of "what the shell
# would execute", and the same skip-to-EOF failure if it were queued.
slots_tree
printf "printf %%s '<<IGNORED'\nSLOTS=mac-studio=%s\n" "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "a heredoc-like string in quotes hides nothing after it" \
  || ko "a heredoc-like string in quotes hides nothing after it (rc=$rc) -- $out"

# A separator after an assignment-only command is not another command: the assignment persists.
slots_tree
printf 'SLOTS=mac-studio=%s ; export SLOTS\n' "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "an assignment before a separator is still the default" \
  || ko "an assignment before a separator is still the default (rc=$rc) -- $out"

# The box name is matched in lowercase, so a mention that shouts is the same mention.
slots_tree
printf '\nThe roster sets MAC-STUDIO=%s for the Mac.\n' "$WANT" >> "$R/README.md"
expect "a mention in capitals is the same statement" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
slots_tree
printf '\nThe roster sets MAC-STUDIO=%s for the Mac.\n' "$OTHER" >> "$R/README.md"
expect "...and a stale one in capitals is refused as written" 1 "README.md: states 'MAC-STUDIO=$OTHER'" -- "$CP" "$R"

# An assignment standing in front of a command is scoped to that command: the shell variable keeps
# its old value, so the default does not move.
slots_tree
printf 'SLOTS=mac-studio=%s true\n' "$OTHER" >> "$R/$WORKER"
expect "a command-prefix assignment sets no default" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# A heredoc named in a comment opens no body -- and queueing one would skip the rest of the file
# as data, hiding every assignment after it.
slots_tree
printf '# example: cat <<IGNORED\nSLOTS=mac-studio=%s\n' "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "a heredoc named in a comment hides nothing after it" \
  || ko "a heredoc named in a comment hides nothing after it (rc=$rc) -- $out"

# The scale words English joins with `and` are numerals too, so the phrase is read whole.
slots_tree
slots_edit issue-wave/references/native-claude.md 's/([a-z]* on mac-studio/(one thousand and six on mac-studio/'
expect "a scale word is part of the numeral, not a stop" 1 "native-claude.md: spells the mac-studio slot count 'one thousand and six'" -- "$CP" "$R"

# The positivity rule judges the VALUE, so it sees through a leading zero.
slots_tree
slots_edit "$WORKER" "s/echo mac-studio=$WANT/echo mac-studio=00/"
expect "a zero written with a leading zero is still zero" 1 "$WORKER: SLOTS assignment states mac-studio=0" -- "$CP" "$R"

# `and` joins a numeral phrase, and only between two numerals: the phrase is the count, while a
# bare `and` before it leaves the run where it was.
slots_tree
slots_edit issue-wave/references/native-claude.md 's/([a-z]* on mac-studio/(one hundred and six on mac-studio/'
expect "a numeral phrase joined by 'and' is read whole" 1 "native-claude.md: spells the mac-studio slot count 'one hundred and six'" -- "$CP" "$R"
slots_tree
slots_edit issue-wave/references/native-claude.md "s/([a-z]* on mac-studio/(a slot and $(sed -n 's/.*(\([a-z]*\) on mac-studio.*/\1/p' "$SRC/issue-wave/references/native-claude.md" | head -1) on mac-studio/"
expect "...while a bare 'and' before it joins nothing" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# The box-name boundary is the same on the far side of the name: `mac-studio_backup` is another box.
slots_tree
slots_edit README.md 's/([a-z]* on$/(six on/;s/^mac-studio)/mac-studio_backup)/'
expect "a count about mac-studio_backup is not this box's either" 1 'README.md: states no mac-studio slot count' -- "$CP" "$R"

# A heredoc delimiter is a word, not a shell identifier -- and a here-STRING is not a heredoc.
slots_tree
printf ': <<123\nSLOTS=mac-studio=%s\n123\n' "$OTHER" >> "$R/$WORKER"
expect "a heredoc delimited by digits is still a heredoc" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
slots_tree
printf 'read -r -a pairs <<<"$SLOTS"\nSLOTS=mac-studio=%s\n' "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "...and a here-string opens no body for the next line to hide in" \
  || ko "...and a here-string opens no body for the next line to hide in (rc=$rc) -- $out"

# A box name may hold `_` and `.` as well as `-`, so the boundary before the name is "a character
# a box name could hold": `not_mac-studio` is another box, and the roster then names no mac-studio.
slots_tree
slots_edit "$WORKER" "s/echo mac-studio=$WANT/echo not_mac-studio=$WANT/"
expect "a box name ending in mac-studio after an underscore is another box" 1 "$WORKER: SLOTS assignment states no 'mac-studio=<n>' default" -- "$CP" "$R"

# Defining a function is not running it: an assignment in a body sets nothing until something
# calls it. The control matters as much -- past the body, the script is top level again.
slots_tree
printf 'unused_helper() {\nSLOTS=mac-studio=%s\n}\n' "$OTHER" >> "$R/$WORKER"
expect "an assignment inside a function body is not the default" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
slots_tree
printf 'unused_helper() {\nx=1\n}\nSLOTS=mac-studio=%s\n' "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "...and one after the body closes is" \
  || ko "...and one after the body closes is (rc=$rc) -- $out"

# A heredoc delimiter may be quoted with a backslash as well as with quotes.
slots_tree
printf 'cat <<\\HD\nSLOTS=mac-studio=%s\nHD\n' "$OTHER" >> "$R/$WORKER"
expect "...however the heredoc delimiter is quoted" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# An assignment word may be continued onto the next line -- by a trailing backslash, or by a quote
# still open. The shell reads one word; so does this check, because the mask spans the joined text.
slots_tree
printf '\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 \\\n      mac-studio=2" fleet-worker.sh ls\n' \
  >> "$R/issue-wave/references/executions.md"
expect "an override continued onto the next line is still one assignment" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# The positive-count rule is the worker's, and it applies to every pair it reads, not just this
# box's: the spec is refused before the mac-studio entry can be used.
slots_tree
slots_edit "$WORKER" 's|^SLOTS=.*|SLOTS="rog-nv-wsl=0 mac-studio=6"|'
expect "a zero count for another box refuses the spec too" 1 "$WORKER: SLOTS assignment states 'rog-nv-wsl=0'" -- "$CP" "$R"

# The count is a NUMBER: `06` is the six the worker reads, on either side of the comparison.
slots_tree
slots_edit "$WORKER" "s/echo mac-studio=$WANT/echo mac-studio=0$WANT/"
expect "a default written with a leading zero still spells its number" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
slots_tree
slots_edit issue-wave/references/executions.md "s/mac-studio=$WANT/mac-studio=0$WANT/"
expect "...and so does a prompt that writes one" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# One command may declare several heredocs, and their bodies follow in order.
slots_tree
printf 'cat <<A <<B\nfirst\nA\nSLOTS=mac-studio=%s\nB\n' "$OTHER" >> "$R/$WORKER"
expect "a body behind a second delimiter on one line is still a body" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
# The control the queue needs: once a body ends, the script is code again.
slots_tree
printf 'cat <<A\nx\nA\nSLOTS=mac-studio=%s\n' "$OTHER" >> "$R/$WORKER"
out=$("$CP" "$R" 2>&1); rc=$?
[ "$rc" -eq 1 ] && grep -qF "defaults to mac-studio=$OTHER" <<<"$out" \
  && ok "...and an assignment after the terminator is executed again" \
  || ko "...and an assignment after the terminator is executed again (rc=$rc) -- $out"

# A LITERAL pair list is what the worker splits and validates in order, so a malformed pair
# anywhere in one refuses the spec -- the mac-studio entry behind it would never be reached.
slots_tree
slots_edit "$WORKER" 's|^SLOTS=.*|SLOTS="rog-nv-wsl=oops mac-studio=6"|'
expect "another box's malformed pair refuses the whole spec" 1 "$WORKER: SLOTS assignment states 'rog-nv-wsl=oops'" -- "$CP" "$R"
slots_tree
slots_edit "$WORKER" "s|^SLOTS=.*|SLOTS=\"rog-nv-wsl=1 mac-studio=$WANT\"|"
expect "...while a list whose pairs are all valid still defaults" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# Every mac-studio pair in the value is validated, not just the last recognizable one: the worker
# refuses the whole spec on the first malformed pair, so a good duplicate behind it is unreachable.
slots_tree
slots_edit "$WORKER" 's|^SLOTS=.*|SLOTS="mac-studio=oops mac-studio=6"|'
expect "a malformed pair is refused even with a valid one behind it" 1 "$WORKER: SLOTS assignment states 'mac-studio=oops'" -- "$CP" "$R"
# ...and where every pair is valid, the last one for the box is the default, as the registry keeps.
slots_tree
slots_edit "$WORKER" "s|^SLOTS=.*|SLOTS=\"mac-studio=$OTHER mac-studio=$WANT\"|"
expect "a box named twice takes its last count" 0 'mac-studio correctness slots agree' -- "$CP" "$R"

# The worker's own grammar: `box_correctness_slots` refuses a count below one, so a zero default
# is a roster every mac-studio slot call dies on rather than a count the prompts could agree with.
slots_tree
slots_edit "$WORKER" "s/echo mac-studio=$WANT/echo mac-studio=0/"
expect "a zero default is refused, not agreed with" 1 "$WORKER: SLOTS assignment states mac-studio=0" -- "$CP" "$R"

# An assignment of the variable is an input, not a claim about the default -- a fixture that
# configures a two-slot box says nothing about what an unconfigured box gets.
slots_tree
printf '%s\n' "FLEET_BOX_CORRECTNESS_SLOTS=mac-studio=2 $WORKER execution slot -- true" >> "$R/$WORKER"
expect "an override in front of a command states no default" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
slots_tree
printf '%s\n' 'export FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2"' >> "$R/$WORKER"
expect "...and a quoted override states none either" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
# The variable takes `<box>=<n>` PAIRS, so another box may legitimately stand first: what makes a
# mention an assignment is standing inside the assignment word, not what the characters before it
# happen to spell.
slots_tree
printf '%s\n' 'export FLEET_BOX_CORRECTNESS_SLOTS="testbox=2 mac-studio=2"' >> "$R/$WORKER"
expect "...and one behind another box's pair states none either" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
slots_tree
printf '\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 mac-studio=2" fleet-worker.sh ls\n' \
  >> "$R/issue-wave/references/executions.md"
expect "...and so does one in a document's example command" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
# Positionally, though: prose after an assignment on the same line is still prose.
slots_tree
printf '\nRun FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2" to halve it; mac-studio=%s is not the default.\n' \
  "$OTHER" >> "$R/README.md"
expect "a count beside an assignment on one line is still judged" 1 "README.md: states 'mac-studio=$OTHER'" -- "$CP" "$R"

# A path with a space in it used to split into words, and a read of a nonexistent path increments
# nothing: the file was skipped silently, under a clean pass.
slots_tree
printf 'notes\n\nmac-studio=%s slots.\n' "$OTHER" > "$R/issue-wave/references/old notes.md"
expect "a discovered path with a space is scanned, not split" 1 "old notes.md: states 'mac-studio=$OTHER'" -- "$CP" "$R"

# The root is read the same spelled with a trailing slash: a `<dir>//` prefix matched none of the
# scan's paths, which emptied it and then reported the required prompts as silent.
slots_tree
expect "a root spelled with a trailing slash reads the same" 0 'mac-studio correctness slots agree' -- "$CP" "$R/"

# A prompt that stops stating the count is how the agreement would quietly stop being checked.
slots_tree
slots_edit README.md 's/([a-z]* on$/(as configured on/'
expect "a prompt that drops the count is refused" 1 'README.md: states no mac-studio slot count' -- "$CP" "$R"

# The obligation comes from the script, as the fixtures' comes from a fixture.
fresh "$R"
out=$("$CP" "$R" 2>&1)
grep -q 'mac-studio' <<<"$out" && ko "a root without $WORKER is held to a slot count" \
  || ok "...and a root without $WORKER carries no slot obligation"

# --- the installed-routine drift guard ---------------------------------------------------------
# ludics-lite#199: each routine sync-routines.sh installs opens by running it and reading its own
# drift, and nothing but this check stops that step being edited away. Like the slot probes, the
# tree is the REAL prompts and the REAL script, copied -- a probe over invented prose would keep
# passing while the checker and the prompts drifted apart. Both READMEs come along because the
# index lookup wants them and $LINK_TARGETS because the link check does; no fixture and no
# fleet-worker.sh, so neither of those two agreements applies.
DRIFT_ROUTINES=$(sed -n 's/^LOCAL_ROUTINES="\([^"]*\)"[[:space:]]*$/\1/p' "$SRC/scripts/sync-routines.sh")
[ -n "$DRIFT_ROUTINES" ] \
  || ko "the drift probes need a one-line LOCAL_ROUTINES=\"...\" in scripts/sync-routines.sh"
DRIFT_ONE=${DRIFT_ROUTINES%% *}
# The path the prompts must invoke, read off the README's clone command the way the checker reads
# it -- independently, so a probe states no literal path and moving the checkout moves both.
DRIFT_HOME=$(sed -n 's|^git clone [^ ]*ludics-lite\.git \(~/[^ ]*\)[[:space:]]*$|\1|p' "$SRC/README.md")
DRIFT_HOME=${DRIFT_HOME%%$'\n'*}
[ -n "$DRIFT_HOME" ] \
  || ko "the drift probes need a 'git clone … ~/<dir>' line in README.md; read '$DRIFT_HOME'"
DRIFT_WANT="runs no $DRIFT_HOME/scripts/sync-routines.sh"
drift_tree() {
  rm -rf "$R"
  mkdir -p "$R/scripts"
  # shellcheck disable=SC2086
  copy_prompts "$R" README.md routines/README.md $LINK_TARGETS
  cp "$SRC/scripts/sync-routines.sh" "$R/scripts/sync-routines.sh"
  for r in $DRIFT_ROUTINES; do copy_prompts "$R" "routines/$r/SKILL.md"; done
}
# drift_edit <file> <sed-expression>: rewrites one copy, and says so if it matched nothing --
# a mutation that changed nothing leaves a probe asserting a refusal the tree no longer earns.
drift_edit() {
  sed "$2" "$R/$1" > "$R/drift.tmp" || { ko "drift_edit: sed failed on $1"; return 1; }
  cmp -s "$R/drift.tmp" "$R/$1" && { ko "drift_edit: '$2' matched nothing in $1"; return 1; }
  mv "$R/drift.tmp" "$R/$1"
}

drift_tree
expect "every installed routine's prompt runs the drift check" 0 \
  'runs it to read its own drift' -- "$CP" "$R"

# The step edited out of a prompt is the drift this check exists for: prose that stops being run
# looks exactly like prose that is.
drift_tree
drift_edit "routines/$DRIFT_ONE/SKILL.md" 's/sync-routines\.sh/the-sync-script/g'
expect "a routine that stops naming the sync script is refused" 1 \
  "routines/$DRIFT_ONE/SKILL.md: $DRIFT_WANT" -- "$CP" "$R"

# The mutation that matters, and the one a filename match would pass: delete the COMMAND and
# leave every mention of it standing. Both prompts name the script in explanatory and reporting
# prose, so this is what an edited-away guard actually looks like.
drift_tree
drift_edit "routines/$DRIFT_ONE/SKILL.md" '/^ \{4,\}[^`]*sync-routines\.sh[[:space:]]*$/d'
expect "a routine that keeps the prose and drops the command is refused" 1 \
  "routines/$DRIFT_ONE/SKILL.md: $DRIFT_WANT" -- "$CP" "$R"

# A write is not the read. `push` and `pull` install and recover; what every installed routine
# owes is the status invocation, so a line that ends in a mode argument does not satisfy it.
drift_tree
drift_edit "routines/$DRIFT_ONE/SKILL.md" 's|^\( *[^ `]*sync-routines\.sh\)$|\1 push|'
expect "an invocation that writes instead of reading is refused" 1 \
  "routines/$DRIFT_ONE/SKILL.md: $DRIFT_WANT" -- "$CP" "$R"

# ...and prose quoting the command is prose, however it is indented.
drift_tree
drift_edit "routines/$DRIFT_ONE/SKILL.md" 's|^\( *\)\([^ `]*sync-routines\.sh\)$|\1run `\2`|'
expect "an indented line quoting the command is not the command" 1 \
  "routines/$DRIFT_ONE/SKILL.md: $DRIFT_WANT" -- "$CP" "$R"

# The ways a line can hold the path without running it. Each is what somebody reaches for when
# they want the step gone but the prompt to still look like it has one -- the comment especially,
# which is how a guard is disabled rather than deleted.
while IFS='|' read -r label repl; do
  drift_tree
  drift_edit "routines/$DRIFT_ONE/SKILL.md" "s|^\\( *\\)\\([^ \`]*sync-routines\\.sh\\)$|\\1$repl|"
  expect "$label is not the command" 1 \
    "routines/$DRIFT_ONE/SKILL.md: $DRIFT_WANT" -- "$CP" "$R"
done <<'EOF'
a commented-out invocation|# \2
an invocation commented out with no space|#\2
the path as another command's argument|echo \2
...and as cat's|cat \2
the path assigned to a variable|DRIFT_COMMAND=\2
...and assigned with export|export DRIFT_COMMAND=\2
some other file of the same name|/tmp/sync-routines.sh
...and one under a same-named directory elsewhere|/tmp/scripts/sync-routines.sh
EOF

# `$HOME` names the same path `~` does; and an indented command line is four blanks or more, so
# one indented less is prose, not the command.
drift_tree
drift_edit "routines/$DRIFT_ONE/SKILL.md" 's|^\( *\)~/\([^ `]*sync-routines\.sh\)$|\1$HOME/\2|'
expect "the invocation spelled through \$HOME is the same command" 0 \
  'runs it to read its own drift' -- "$CP" "$R"
drift_tree
drift_edit "routines/$DRIFT_ONE/SKILL.md" 's|^ *\([^ `]*sync-routines\.sh\)$|   \1|'
expect "an invocation indented less than four blanks is not the command" 1 \
  "routines/$DRIFT_ONE/SKILL.md: $DRIFT_WANT" -- "$CP" "$R"

# The path is the README's to state, and the checker reads it from there rather than restating
# it: a root whose install line is gone cannot be judged, and says so instead of passing.
drift_tree
drift_edit README.md 's|^git clone .*ludics-lite\.git ~/.*$|git clone https://example.invalid/x.git|'
expect "a README with no clone destination is refused, not passed" 1 \
  'no ' -- "$CP" "$R"

# ...and a checkout cloned somewhere else is judged against THAT path, not a hardcoded one.
drift_tree
drift_edit README.md 's|\(^git clone .*ludics-lite\.git \)~/ludics-lite$|\1~/elsewhere|'
expect "the checkout path comes from the README, so moving it refuses the old invocation" 1 \
  '~/elsewhere/scripts/sync-routines.sh' -- "$CP" "$R"

# Which prompts are held is read off the script, so a name added to LOCAL_ROUTINES arrives obliged
# -- and one it installs with nothing to install from is refused rather than skipped.
drift_tree
rm -rf "$R/routines/$DRIFT_ONE"
expect "a routine the script installs with no prompt here is refused" 1 \
  "installs '$DRIFT_ONE', but this checkout has no routines/$DRIFT_ONE/SKILL.md" -- "$CP" "$R"

drift_tree
drift_edit scripts/sync-routines.sh 's/^LOCAL_ROUTINES=.*/LOCAL_ROUTINES="a b" # not the one-line shape/'
expect "a LOCAL_ROUTINES this reader cannot see is refused, not passed" 1 \
  'has no one-line LOCAL_ROUTINES' -- "$CP" "$R"

# The obligation comes from the installer, as the fixtures' comes from a fixture.
fresh "$R"
out=$("$CP" "$R" 2>&1)
grep -q 'drift' <<<"$out" && ko "a root without scripts/sync-routines.sh is held to a drift step" \
  || ok "...and a root without the sync script carries no drift obligation"

# --- the post-merge-cleanup option register ---------------------------------------------------
# ludics-lite#276 added `--regenerable` to post-merge-cleanup.sh's usage() and to ship-pr/SKILL.md
# by hand, in the PR that found the prompt's prose about the base-owner gate had been false for
# two PRs already. The tree is the REAL prompt and the REAL helper, copied, for the reason the
# slot and drift probes give: the checker's shapes are the ones the real files use, and invented
# ones would keep passing while the two drifted. Both READMEs come along for the index lookup and
# $LINK_TARGETS for the link check; no fixture, no worker, no sync script.
CLEANUP_HELPER=ship-pr/scripts/post-merge-cleanup.sh
CLEANUP_PROMPT=ship-pr/SKILL.md
CLEANUP_AGREE="$CLEANUP_PROMPT and $CLEANUP_HELPER's usage() agree"
# The helper in the tree is a STAND-IN that prints what the real helper prints: check-prompts reads
# the helper's printed usage text and nothing else of it, and since the v2 rewrite
# (ludics-lite#403) that text comes from a Python package the helper forwards to, which a copy of
# the one file would not find. So the real helper is run once, here, as check-prompts runs it, and
# the stand-in replays its stderr and exit status. The probes that mutate the helper mutate that
# TEXT -- a row added, rows removed, a placeholder dropped, the status changed -- which is the
# whole of what the checker sees, whatever renders it.
CLEANUP_USAGE_RC=0
CLEANUP_USAGE=$(bash "$SRC/$CLEANUP_HELPER" </dev/null 2>&1 >/dev/null) || CLEANUP_USAGE_RC=$?
[ "$CLEANUP_USAGE_RC" -eq 2 ] \
  || ko "the real $CLEANUP_HELPER run with no arguments exited $CLEANUP_USAGE_RC, not 2: $CLEANUP_USAGE"
cleanup_tree() {
  rm -rf "$R"
  mkdir -p "$R/ship-pr/scripts"
  # shellcheck disable=SC2086
  copy_prompts "$R" README.md routines/README.md "$CLEANUP_PROMPT" $LINK_TARGETS
  {
    printf '%s\n' '#!/usr/bin/env bash' "cat >&2 <<'CLEANUP_USAGE_TEXT'"
    printf '%s\n' "$CLEANUP_USAGE" CLEANUP_USAGE_TEXT "exit $CLEANUP_USAGE_RC"
  } >"$R/$CLEANUP_HELPER"
  chmod +x "$R/$CLEANUP_HELPER"
}
# cleanup_edit <file> <sed-expression>: rewrites one copy, and says so if it matched nothing.
cleanup_edit() {
  sed "$2" "$R/$1" > "$R/cleanup.tmp" || { ko "cleanup_edit: sed failed on $1"; return 1; }
  cmp -s "$R/cleanup.tmp" "$R/$1" && { ko "cleanup_edit: '$2' matched nothing in $1"; return 1; }
  mv "$R/cleanup.tmp" "$R/$1"
}
# cleanup_add_dry_run: lists a `--dry-run` flag in the helper's usage text, ahead of `--base`, as
# the option table renders a row with no placeholder -- the one row shape the real table does not
# carry.
cleanup_add_dry_run() {
  cleanup_edit "$CLEANUP_HELPER" "s/^  --base /  --dry-run             Report what cleanup would do and change nothing\\
  --base /"
}
# The one invocation line the mutations below rewrite, spelled the way the prompt spells it: a
# continuation line carrying two options. Read off the prompt rather than restated, so a probe
# goes stale at the edit that moves it instead of asserting over a line that is no longer there.
CLEANUP_LINE=$(grep -n -- '^  --base [^ ]* --regenerable [^ ]*$' "$SRC/$CLEANUP_PROMPT" | sed 's/:.*//')
CLEANUP_LINE=${CLEANUP_LINE%%$'\n'*}
[ -n "$CLEANUP_LINE" ] \
  || ko "the cleanup probes need a '  --base <b> --regenerable <d>' continuation line in $CLEANUP_PROMPT"

cleanup_tree
expect "the real prompt and the helper's usage() list the same options" 0 \
  "$CLEANUP_AGREE" -- "$CP" "$R"

# The drift ludics-lite#276 was: an option the helper gains that the prompt never names.
cleanup_tree
cleanup_add_dry_run
expect "an option usage() lists that the prompt never names is refused" 1 \
  "$CLEANUP_PROMPT: names no '--dry-run'" -- "$CP" "$R"

# ...and the other direction: an option the prompt passes that the helper does not take. On a
# CONTINUATION line, which is where the real prompt keeps its options, so this also proves the
# backslash is followed.
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" "${CLEANUP_LINE}s/\$/ --keep-branch/"
expect "an option the prompt passes that usage() does not list is refused" 1 \
  "$CLEANUP_PROMPT: passes '--keep-branch' to $CLEANUP_HELPER" -- "$CP" "$R"

# A renamed option fails both ways at once: the listed name is gone from the prompt, and the name
# the prompt now passes is one the helper does not take.
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" 's/--force-integrated/--force-merged/g'
expect "a renamed option is refused as missing" 1 "names no '--force-integrated'" -- "$CP" "$R"
grep -qF "passes '--force-merged'" <<<"$out" && ok "...and as passed unlisted" \
  || ko "a renamed option is not also refused as passed unlisted -- $out"

# The token whole: the prompt naming `--base-branch` does not name `--base`.
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" 's/--base\([^-]\)/--base-branch\1/g'
expect "a longer option carrying the listed one as a prefix does not name it" 1 \
  "names no '--base'" -- "$CP" "$R"

# What is attributed to the helper is its own command line. The same `--flag` on another
# command's line in a fence, or in prose, is not, so the register does not grow to cover every
# tool the prompt mentions -- `gh pr merge --delete-branch` is already there in prose.
cleanup_tree
printf '\n```bash\ngh pr merge --delete-branch --squash\n```\n\nOr pass `--no-such-flag` to nothing.\n' >> "$R/$CLEANUP_PROMPT"
expect "an option on another command's fenced line, or in prose, is nobody's" 0 \
  "$CLEANUP_AGREE" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/.claude/skills/ship-pr/scripts/test-post-merge-cleanup.sh --list\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...and the test runner, whose name ends in the helper's, is another command" 0 \
  "$CLEANUP_AGREE" -- "$CP" "$R"
# A command line outside a fence is prose quoting one.
cleanup_tree
printf '\nSome run `post-merge-cleanup.sh a b c --keep-branch` and regret it.\n' >> "$R/$CLEANUP_PROMPT"
expect "an invocation quoted in prose is not a command line" 0 "$CLEANUP_AGREE" -- "$CP" "$R"
# ...and a continuation is a trailing backslash: without it the next line is its own line, which
# names no helper and so passes nothing.
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" "$((CLEANUP_LINE - 1))s/ \\\\\$//"
cleanup_edit "$CLEANUP_PROMPT" "${CLEANUP_LINE}s/\$/ --keep-branch/"
expect "a line the backslash no longer continues passes nothing" 0 "$CLEANUP_AGREE" -- "$CP" "$R"

# The helper's command ends at the first shell separator: the `--json` of a `gh` chained after
# it is that command's, and a command chained before it contributes nothing (round 1, P2).
cleanup_tree
printf '\n```bash\ngit fetch origin && ~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --base main; gh pr view --json number\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "an option of a command chained after the helper on its line is that command's" 0 \
  "$CLEANUP_AGREE" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --base main | tee log.txt \\\n  --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...and a continuation past a separator is not the helper's either" 0 \
  "$CLEANUP_AGREE" -- "$CP" "$R"

# Round 2, P2 x6: the shell's word boundaries, as far as the reader models them. Each is a shape
# that let an unlisted option through (or refused a valid helper), and each is a line the prompt
# could plausibly come to hold.
# A second invocation after the separator is searched for too.
cleanup_tree
printf '\n```bash\ngh pr view; ~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "an invocation chained AFTER another command is still read" 1 \
  "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --base main && ~/x/post-merge-cleanup.sh a b c --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...and a second invocation of the helper on one line" 1 "passes '--keep-branch'" -- "$CP" "$R"
# A redirection's ampersand ends no command.
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c 2>&1 --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "an option after a redirection is still the helper's" 1 "passes '--keep-branch'" -- "$CP" "$R"
# A quoted command word is the command.
cleanup_tree
printf '\n```bash\n"$HOME/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh" a b c --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a quoted helper path is still the helper" 1 "passes '--keep-branch'" -- "$CP" "$R"
# A fence indented up to three blanks is a fence.
cleanup_tree
printf '\n   ```bash\n   ~/x/post-merge-cleanup.sh a b c --keep-branch\n   ```\n' >> "$R/$CLEANUP_PROMPT"
expect "an indented fence is a fence" 1 "passes '--keep-branch'" -- "$CP" "$R"
# The token is the whole word: a suffix the helper's parser refuses is not the listed prefix.
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" "${CLEANUP_LINE}s/--base main/--base_branch main/"
expect "a misspelled option is reported whole, not truncated to its listed prefix" 1 \
  "passes '--base_branch'" -- "$CP" "$R"
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" "${CLEANUP_LINE}s/--base main/--base=main/"
expect "...and so is the = spelling, which the helper does not take" 1 "passes '--base=main'" -- "$CP" "$R"
# Round 3, P2 x6: the word model. A quoted word is unquoted; the helper's name is whole whatever
# operator precedes it; the listing side uses the same token
# grammar as the invocation side; a fence closes only on a run as long as its opener; and the
# word after a valued option is its value whatever it looks like.
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c "--keep-branch"\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a quoted option word is the option" 1 "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n(post-merge-cleanup.sh a b c --keep-branch)\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a bare invocation after a shell operator is the helper" 1 "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\nout=$(~/x/post-merge-cleanup.sh a b c --keep-branch)\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...and one inside a command substitution" 1 "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" 's/--base\([^-A-Za-z0-9_]\)/--base_branch\1/g'
expect "a misspelling in prose does not name the listed option" 1 "names no '--base'" -- "$CP" "$R"
cleanup_tree
printf '\n````bash\ncat <<X\n```\nX\n~/x/post-merge-cleanup.sh a b c --keep-branch\n````\n' >> "$R/$CLEANUP_PROMPT"
expect "a three-backtick line inside a four-backtick fence does not close it" 1 \
  "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --force-integrated --confirmed-by-GitHub --regenerable --cache\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a valued option's value is its value, however it is spelled" 0 "$CLEANUP_AGREE" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --base \\\n  --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...across a continuation too" 0 "$CLEANUP_AGREE" -- "$CP" "$R"
# ...while an option usage() lists with no <value> placeholder consumes nothing.
cleanup_tree
cleanup_add_dry_run
printf '\nPass `--dry-run` to rehearse.\n\n```bash\n~/x/post-merge-cleanup.sh a b c --dry-run --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a flag option consumes no value, so the word after it is read" 1 \
  "passes '--keep-branch'" -- "$CP" "$R"

# Round 4, P2 x2: the segment is lexed as the shell lexes it, so a separator inside a quoted or
# escaped value ends nothing -- the shape that let an option past the register -- and an unquoted
# `#` starts a comment the shell passes nothing from.
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --force-integrated "confirmed; by GitHub" --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a separator inside a double-quoted value ends nothing" 1 "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --force-integrated '"'"'a | b'"'"' --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...nor inside a single-quoted one" 1 "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --force-integrated confirmed\; --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...nor an escaped one" 1 "passes '--keep-branch'" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --base main # never pass --keep-branch here\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a trailing shell comment passes nothing" 0 "$CLEANUP_AGREE" -- "$CP" "$R"
cleanup_tree
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --force-integrated "not # a comment" --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "...while a # inside a quoted value is text" 1 "passes '--keep-branch'" -- "$CP" "$R"

# The listing side is a mention, verbatim, anywhere in the prompt: the option's command lines
# deleted and its prose kept still names it. That is the residue this check states rather than
# hides -- a name present says nothing about whether the prose around it is true.
cleanup_tree
cleanup_edit "$CLEANUP_PROMPT" '/^  --base [^ ]* --regenerable /d'
expect "an option named only in prose is still named" 0 "$CLEANUP_AGREE" -- "$CP" "$R"

# The register is read off the helper's printed usage text, which it renders from the option
# table its parse loop reads (ludics-lite#332), and a text this reader sees no options in is refused
# rather than holding the prompt to nothing.
cleanup_tree
cleanup_edit "$CLEANUP_HELPER" '/^  /d'
expect "a usage() listing no options is refused, not passed" 1 \
  "$CLEANUP_HELPER: usage() lists no options" -- "$CP" "$R"
# ...and a run that is not the usage error is no listing at all: a crash's output is not read as
# an empty register, nor as a register.
cleanup_tree
cleanup_edit "$CLEANUP_HELPER" 's/^exit 2$/exit 1/'
expect "a helper whose usage error does not exit 2 is refused" 1 \
  "$CLEANUP_HELPER: run with no arguments, it printed no usage text" -- "$CP" "$R"
# The listing is the table's: a row's placeholder is both what the text prints and what the
# parser consumes, so a flag row is listed bare -- and the word after it on the prompt's command
# line is read as the next option rather than skipped as a value.
cleanup_tree
cleanup_edit "$CLEANUP_HELPER" 's/^  --regenerable <name>  /  --regenerable         /'
printf '\n```bash\n~/x/post-merge-cleanup.sh a b c --regenerable --keep-branch\n```\n' >> "$R/$CLEANUP_PROMPT"
expect "a flag row in the table is listed bare, so the word after it is an option" 1 \
  "passes '--keep-branch'" -- "$CP" "$R"

# A helper with no prompt to document it is refused; a root with no helper carries no obligation,
# as with the sync script and the worker.
cleanup_tree
rm "$R/$CLEANUP_PROMPT"
expect "a helper without its prompt is refused" 1 "has no $CLEANUP_PROMPT" -- "$CP" "$R"
fresh "$R"
out=$("$CP" "$R" 2>&1)
grep -q 'post-merge-cleanup' <<<"$out" && ko "a root without the helper is held to its option register" \
  || ok "...and a root without the helper carries no option obligation"

# --- relative links and anchors ---------------------------------------------------------------
# ludics-lite#260 cut the wave prompt and its references into sections addressed by anchor, and
# every one of those links was verified by hand, once; this is what re-verifies them. Two trees,
# for the two things there are to pin. A scratch one for the READING -- what counts as a link,
# which directory a path is read from, what a heading slugs to -- where each probe is one defect
# against the well-formed control. Then the REAL prompts, copied, for the claim that today's links
# resolve and that a moved heading or a renamed file is caught, which is the drift the check is
# for: a probe over invented headings would keep passing while the prompts' own links rotted.

links_tree() {   # a passing layout, plus a reference file for the prompts to link into
  fresh "$R"
  mkdir -p "$R/alpha/references"
  cat > "$R/alpha/references/notes.md" <<'EOF'
# Notes

## Close-out

The first one.

## Supervision, recovery and evidence

Punctuation to drop, blanks to hyphenate.

## Close-out

The second one, which GitHub numbers.

## Notes-1

An explicit suffix, standing where a repeat would want to land.

## Notes

A third collision, which has to step over the explicit one.

EOF
  # Two headings written as BYTES, which a quoted heredoc would have left as backslash text: an em
  # dash, the non-ASCII punctuation this prose is written with and GitHub drops; and a heading
  # carrying a letter GitHub keeps, whose anchor the check will not guess at -- so it contributes
  # no slug rather than the ASCII residue `caf`.
  printf '## Close \342\200\224 out\n\nPunctuation GitHub drops.\n\n' >> "$R/alpha/references/notes.md"
  printf 'A parenthesized filename.\n' > "$R/alpha/references/a_(b).md"
}
# links_nonascii <file>: appends a heading carrying a letter GitHub keeps, whose anchor this check
# will not guess at. Appended by the probes that mean it, for the same reason as the next helper.
links_nonascii() { printf '\n## Caf\303\251\n\nA letter GitHub keeps.\n' >> "$R/$1"; }
# links_unspellable: appends a heading GitHub slugs by its RENDERED text (`foo`), which is not its
# source. It goes on the END of a file on purpose -- it suppresses the numbering after it -- so
# probes about ordinary headings add it only when they mean to.
links_unspellable() { printf '\n## [Foo](https://example.invalid)\n\nInline link syntax.\n' >> "$R/$1"; }
# links_body <file> <line...>: appends Markdown to a file in the scratch tree.
links_body() { local f="$1"; shift; printf '%s\n' "$@" >> "$R/$f"; }

links_tree
links_body alpha/SKILL.md 'See [one section](references/notes.md#close-out) and [all of it](references/notes.md).'
expect "a resolving link, with an anchor and without" 0 '(2 checked)' -- "$CP" "$R"

links_tree
links_body alpha/SKILL.md 'See [what moved](references/gone.md).'
expect "a link to a file that is not there" 1 \
  'alpha/SKILL.md: link to references/gone.md resolves to no file: alpha/references/gone.md' -- "$CP" "$R"

links_tree
links_body alpha/SKILL.md 'See [what was retitled](references/notes.md#launch).'
expect "an anchor no heading slugs to" 1 \
  "link to references/notes.md#launch names no heading: alpha/references/notes.md has none whose GitHub slug is 'launch'" -- "$CP" "$R"

# The slug is GitHub's: blanks become hyphens, a hyphen already there stays, and the punctuation
# between them goes. Each half is pinned by an anchor that only holds if that half is right.
links_tree
links_body alpha/SKILL.md 'See [a slugged heading](references/notes.md#supervision-recovery-and-evidence).'
expect "punctuation is dropped and blanks become hyphens" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [a hyphen dropped too](references/notes.md#closeout).'
expect "...while a hyphen in the heading is kept, not dropped with the punctuation" 1 \
  "GitHub slug is 'closeout'" -- "$CP" "$R"

# A heading written twice is reachable twice: GitHub numbers the repeats, and a link to the second
# one is a link this check must not report as broken.
links_tree
links_body alpha/SKILL.md 'See [the second one](references/notes.md#close-out-1).'
expect "a repeated heading takes GitHub's -1 suffix" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [a third one](references/notes.md#close-out-2).'
expect "...and only as many of them as the file writes" 1 "GitHub slug is 'close-out-2'" -- "$CP" "$R"

# The anchor is compared as TEXT and in full, the way the README index lookup compares a name.
links_tree
links_body alpha/SKILL.md 'See [a prefix of one](references/notes.md#close).'
expect "an anchor that is a prefix of a slug is not that slug" 1 "GitHub slug is 'close'" -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [a pattern](references/notes.md#close.out).'
expect "a '.' in an anchor is that character, not a wildcard" 1 "GitHub slug is 'close.out'" -- "$CP" "$R"

# A path is read from the LINKING file's directory. Both directions: the root-relative spelling of
# a target that resolves is a different file, and `..` climbs out of a reference directory.
links_tree
links_body alpha/SKILL.md 'See [the root-relative spelling](alpha/references/notes.md).'
expect "a path is read from the linking file's directory, not from the root" 1 \
  'resolves to no file: alpha/alpha/references/notes.md' -- "$CP" "$R"
links_tree
links_body alpha/references/notes.md 'Back to [the prompt](../SKILL.md).'
expect "a reference file is a linking file too, and '..' climbs from it" 0 '(1 checked)' -- "$CP" "$R"
# A path that climbed out of the checkout is refused on the PATH, and never probed on the
# filesystem: `$ROOT/../outside.md` is a real path on the host, so the probe plants exactly that
# file beside the tree -- which under a filesystem test would make the link read as resolving, and
# the verdict a fact about the machine rather than about the prompts.
links_tree
printf 'Outside the checkout.\n' > "$TMP/outside.md"
links_body alpha/references/notes.md 'Out of [the checkout](../../../outside.md).'
expect "a path that climbs past the root is refused, even where that file exists" 1 \
  'resolves outside the checkout: ../outside.md' -- "$CP" "$R"
rm -f "$TMP/outside.md"

# Every file the scan reads links in is one, not just the skill prompts.
links_tree; links_body README.md 'See [nothing](missing.md).'
expect "README.md is a linking file" 1 'FAIL: README.md: link to missing.md resolves to no file: missing.md' -- "$CP" "$R"
links_tree; links_body routines/README.md 'See [nothing](missing.md).'
expect "...and routines/README.md" 1 'FAIL: routines/README.md: link to missing.md resolves to no file: routines/missing.md' -- "$CP" "$R"
links_tree; links_body routines/nightly/SKILL.md 'See [nothing](missing.md).'
expect "...and a routine prompt" 1 'FAIL: routines/nightly/SKILL.md: link to missing.md resolves to no file: routines/nightly/missing.md' -- "$CP" "$R"

# What falls outside the one shape this reads is NOT CHECKED rather than guessed at. Each target
# below names something that is not there, so a probe that passes is a probe reporting the gap it
# is meant to report -- and each gap reports nothing rather than reporting wrongly.
while IFS='|' read -r label link; do
  links_tree
  links_body alpha/SKILL.md "See $link."
  expect "outside the shape, so not read: $label" 0 '0 failed' -- "$CP" "$R"
done <<'EOF'
an http(s) URL|[released](https://example.invalid/missing.md)
another URI scheme|[write in](mailto:nobody@example.invalid)
a link carrying a title|[titled](references/gone.md "Not read")
a site-absolute path|[absolute](/references/gone.md)
a same-file anchor, which names no file|[here](#close-out)
a target that is not Markdown|[the licence](LICENSE)
EOF
links_tree
links_body alpha/SKILL.md 'See [a target on the next line](' 'references/gone.md).'
expect "outside the shape, so not read: a link split across two lines" 0 '0 failed' -- "$CP" "$R"

# There is no fenced-code scope, which is the reading's one gap that cuts both ways -- pinned from
# both sides, so it is a decision on record rather than a hole nobody meant (as with the table
# model ludics-lite#75 removed). A `#` line inside a fence reads as a heading, which only makes the
# anchor lookup more permissive; a link inside a fence is read like any other, which is stricter.
links_tree
links_body alpha/references/notes.md '```sh' '# Improvised heading' '```'
links_body alpha/SKILL.md 'See [a comment in a fence](references/notes.md#improvised-heading).'
expect "a '#' comment inside a fence reads as a heading" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md '```' 'See [an example](references/gone.md).' '```'
expect "...and a link inside a fence is read like any other" 1 \
  'link to references/gone.md resolves to no file' -- "$CP" "$R"
# The same on one line, which is the form documentation actually reaches for and the one this
# repository paid for: the README's paragraph about this check had to describe the shape rather
# than spell one. Pinned so that cost is a decision, not a surprise.
links_tree
links_body alpha/SKILL.md 'The shape read is `[label](references/gone.md)`, quoted here in prose.'
expect "...and one quoted between backticks is read as the link it spells" 1 \
  'link to references/gone.md resolves to no file' -- "$CP" "$R"

# A Markdown destination may carry balanced parentheses, so the target ends at the paren that
# closes the link and not at the first one. Cut at the first, `a_(b).md` reads as `a_(b`, fails
# the `.md` test and drops out of the scan in silence -- so a renamed parenthesized file would
# pass this check rather than be reported (round 1, P2).
links_tree
links_body alpha/SKILL.md 'See [a parenthesized name](references/a_(b).md).'
expect "a destination carrying balanced parentheses is read whole" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [a parenthesized name](references/a_(c).md).'
expect "...so a missing one is reported, not skipped" 1 \
  'resolves to no file: alpha/references/a_(c).md' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'Prose [linking](references/notes.md) and then (an aside in parentheses).'
expect "...while an aside after a link is not part of its target" 0 '(1 checked)' -- "$CP" "$R"

# GitHub numbers a repeated heading by taking the next FREE name, so an explicit `## Notes-1`
# standing between two `## Notes` pushes the second repeat to `notes-2`. A per-base counter hands
# out `notes-1` twice instead: it rejects the good link and lets one anchor answer for two
# headings (round 1, P2). The scratch file writes exactly that sequence.
links_tree
links_body alpha/SKILL.md 'See [past the explicit suffix](references/notes.md#notes-2).'
expect "a repeat steps over a heading that already holds its suffix" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [the explicit one](references/notes.md#notes-1).'
expect "...and that heading keeps its own name" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [one repeat too many](references/notes.md#notes-3).'
expect "...and no further name is handed out" 1 "GitHub slug is 'notes-3'" -- "$CP" "$R"

# Beyond ASCII the slug is knowable for General Punctuation, which GitHub drops -- and is not for a
# byte that may be a letter GitHub keeps. Dropping such a byte silently would ACCEPT the ASCII
# residue as the anchor (`#caf` for `## Cafe<acute>`), so the heading contributes no slug and the link
# is refused with the reason (round 1, P2).
links_tree
links_body alpha/SKILL.md 'See [an em dash dropped](references/notes.md#close--out).'
expect "the punctuation GitHub drops is dropped here too" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_nonascii alpha/references/notes.md
links_body alpha/SKILL.md 'See [the ASCII residue](references/notes.md#caf).'
expect "a heading carrying a letter past ASCII spells no anchor, so its residue answers for none" 1 \
  'will not spell an anchor for' -- "$CP" "$R"

# A false `](` -- the token written in prose, or a bracket pair that opens no link -- used to
# abandon the rest of the LINE, so a real broken link standing after one went unread and the run
# came out green. The scan resumes past the false candidate instead (round 2, P2).
links_tree
links_body alpha/SKILL.md 'The token ]( is documented; see [the guide](references/gone.md).'
expect "a false ]( does not abandon the link after it" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md '[Mismatched](references/notes.md and then [a real one](references/gone.md).'
expect "...nor does a destination whose parens never close" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"

# The target must be SPELLED as a path in this checkout. A percent escape is the encoding a file
# with a blank in its name would need, and decoding it is a reading this scan does not do -- so
# such a target is outside the shape and not checked, rather than probed literally and failed
# (round 2, P2). The probe plants the DECODED file, so a literal probe would refuse a link that
# GitHub resolves, and a decoding one would resolve it: neither happens, it is simply not read.
links_tree
printf 'A name needing an escape.\n' > "$R/alpha/references/my notes.md"
links_body alpha/SKILL.md 'See [an escaped name](references/my%20notes.md).'
expect "outside the shape, so not read: a percent-escaped destination" 0 '0 failed' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [an angle-bracket destination](<references/gone.md>).'
expect "outside the shape, so not read: a destination in angle brackets" 0 '0 failed' -- "$CP" "$R"

# GitHub slugs a heading by its RENDERED text; this reads the source. `## [Foo](...)` is `foo`
# there and `foohttpsexampleinvalid` here, so the source reading both refuses the right anchor and
# accepts one GitHub never creates. Such a heading spells no anchor at all (round 2, P2).
links_tree
links_unspellable alpha/references/notes.md
links_body alpha/SKILL.md 'See [the source reading](references/notes.md#foohttpsexampleinvalid).'
expect "a heading carrying inline link syntax accepts no anchor from its source" 1 \
  'will not spell an anchor for' -- "$CP" "$R"
links_tree
links_unspellable alpha/references/notes.md
links_body alpha/SKILL.md 'See [the rendered reading](references/notes.md#foo).'
expect "...and says so rather than answering for the rendered one either" 1 \
  'will not spell an anchor for' -- "$CP" "$R"
links_tree
links_body alpha/references/notes.md '## Notes [draft]' '' 'Literal brackets, which render as themselves.'
links_body alpha/SKILL.md 'See [literal brackets](references/notes.md#notes-draft).'
expect "...while literal brackets render as their source and still slug" 0 '(1 checked)' -- "$CP" "$R"

# The lexical `..` guard stops a path SPELLING its way out of the checkout; a symbolic link walks
# out without spelling anything, and `-f` would follow it -- so the target's existence, and its
# headings, would be read off the runner (round 2, P2). Refused on the path, at any component.
links_tree
printf '# Outside\n\n## Planted\n' > "$TMP/outside.md"
ln -s "$TMP/outside.md" "$R/alpha/references/linked.md"
links_body alpha/SKILL.md 'See [a link out](references/linked.md#planted).'
expect "a target that is a symbolic link is refused, not followed" 1 \
  'reached through a symbolic link: alpha/references/linked.md' -- "$CP" "$R"
links_tree
mkdir -p "$TMP/elsewhere" && printf '# Outside\n' > "$TMP/elsewhere/notes.md"
ln -s "$TMP/elsewhere" "$R/alpha/linked"
links_body alpha/SKILL.md 'See [a link out of a parent](linked/notes.md).'
expect "...and so is one reached through a symlinked parent" 1 \
  'reached through a symbolic link: alpha/linked/notes.md' -- "$CP" "$R"
rm -rf "$TMP/outside.md" "$TMP/elsewhere"

# A candidate REJECTED for any reason must not consume the line either -- round 2 fixed only the
# one whose parens never closed. `Token ]( prose [guide](missing.md).)` balances its parens around
# the real link, so the cursor jumped past the closing one and swallowed it (round 3, P2). Only an
# accepted link advances the cursor past itself now.
links_tree
links_body alpha/SKILL.md 'Token ]( prose [the guide](references/gone.md).)'
expect "a rejected candidate does not swallow the link nested inside it" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'A [titled one](references/notes.md "T") then [a real one](references/gone.md).'
expect "...and neither does a title, which is rejected for a different reason" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"

# The two shapes beyond link syntax whose RENDERED text differs from their source. Each is tested
# narrowly, so the far commoner literal readings -- where both sides agree -- keep working
# (round 3, P2).
links_tree
printf '\n## <em>Foo</em>\n\nAn HTML tag.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the source of a tag](references/notes.md#emfooem).'
expect "a heading carrying an HTML tag spells no anchor from its source" 1 \
  'will not spell an anchor for' -- "$CP" "$R"
links_tree
printf '\n## A &amp; B\n\nAn entity.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the source of an entity](references/notes.md#a-amp-b).'
expect "...and neither does one carrying a character entity" 1 \
  'will not spell an anchor for' -- "$CP" "$R"
links_tree
printf '\n## A < B and Launch & supervise\n\nLiteral, on both sides.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [literal punctuation](references/notes.md#a--b-and-launch--supervise).'
expect "...while a bare < or & is text to both readings and still slugs" 0 '(1 checked)' -- "$CP" "$R"

# A tab inside a heading is a control character GitHub REMOVES before it hyphenates spaces, so
# `## Foo<TAB>Bar` is `foobar` there; hyphenating it approved an anchor that does not exist and
# refused the one that does (round 3, P2).
links_tree
printf '\n## Foo\tBar\n\nAn internal tab.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a tab removed](references/notes.md#foobar).'
expect "an internal tab is removed, not turned into a hyphen" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## Foo\tBar\n\nAn internal tab.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a tab hyphenated](references/notes.md#foo-bar).'
expect "...so the hyphenated reading names no heading" 1 "GitHub slug is 'foo-bar'" -- "$CP" "$R"

# A heading this check will not spell still OCCUPIES a slug on GitHub, and the numbering is
# occupancy-based: `## [Foo](…)` then `## Foo` are `foo` and `foo-1` there, while this reads the
# second as `foo` (round 3, P2). What that costs is bounded, and the bound is the point: every
# slug this emits is one GitHub HAS -- for that heading, or for the earlier one it collided with
# -- so an anchor accepted here resolves there, and only the `-<n>` spelling goes unconfirmed.
# Suppressing every later slug instead was tried and taken out in round 9: it refused anchors
# rather than failing to confirm them, and a phantom heading inside a fence could trigger it.
links_tree
links_unspellable alpha/references/notes.md
printf '\n## Foo\n\nThe heading GitHub numbers past the refused one.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the name GitHub has](references/notes.md#foo).'
expect "an anchor an unspellable heading holds on GitHub still resolves here" 0 '(1 checked)' -- "$CP" "$R"
links_tree
links_unspellable alpha/references/notes.md
printf '\n## Foo\n\nThe heading GitHub numbers past the refused one.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the numbered reading](references/notes.md#foo-1).'
expect "...while the -<n> spelling goes unconfirmed, and the message names what did it" 1 \
  'leave a numbered repeat unconfirmed' -- "$CP" "$R"
links_tree
links_unspellable alpha/references/notes.md
links_body alpha/SKILL.md 'See [a heading standing before it](references/notes.md#close-out).'
expect "...and a heading BEFORE it keeps its name, which nothing later can move" 0 '(1 checked)' -- "$CP" "$R"
# The property the whole block-scope gap rests on, pinned from the side that broke it: a
# heading-shaped line inside a FENCE that the slug reader will not spell must not take the real
# headings after it down with it. Round 3's suppression did exactly that (round 9, P2).
links_tree
printf '\n```\n## [Example](https://example.invalid)\n```\n\n## After the fence\n' \
  >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [past a phantom heading](references/notes.md#after-the-fence).'
expect "an unspellable heading inside a fence refuses no anchor after it" 0 '(1 checked)' -- "$CP" "$R"

# The guards belong where the target is first TOUCHED. The prepass that builds the slug table
# probed and read anchored targets before the loop below refused them, so a link out of the
# checkout still had its host file opened and scanned (round 3, P2). The probe plants a real file
# with a real heading at both destinations, so a prepass that still read them would find the
# anchor and turn the refusal into a pass.
links_tree
printf '# Outside\n\n## Planted\n' > "$TMP/outside.md"
ln -s "$TMP/outside.md" "$R/alpha/references/linked.md"
links_body alpha/SKILL.md 'See [an anchored link out](references/linked.md#planted).'
expect "an anchored symlinked target is refused before its headings are read" 1 \
  'reached through a symbolic link: alpha/references/linked.md' -- "$CP" "$R"
links_tree
links_body alpha/references/notes.md 'See [an anchored climb out](../../../outside.md#planted).'
expect "...and so is an anchored target that climbs past the root" 1 \
  'resolves outside the checkout: ../outside.md' -- "$CP" "$R"
rm -f "$TMP/outside.md"

# A heading inside a blockquote is a heading: GFM renders `> ## Foo` with the anchor `foo`, and
# skipping it refused a link that works (round 3, P2). A list item is deliberately not read -- that
# needs the block model this file does not have -- so such a link is refused, loudly, rather than
# answered for a heading that is not there.
links_tree
printf '\n> ## Quoted heading\n>\n> In a blockquote.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a quoted heading](references/notes.md#quoted-heading).'
expect "an ATX heading inside a blockquote is a heading" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n- ## Listed heading\n\n  In a list item.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a listed heading](references/notes.md#listed-heading).'
expect "...while one inside a list item is refused rather than guessed at" 1 \
  "GitHub slug is 'listed-heading'" -- "$CP" "$R"

# Underscore emphasis is the one emphasis marker the two readings disagree on: the slugger keeps
# `_` as a word character, so `## _Foo_` is `foo` on GitHub and `_foo_` from the source. The test
# is CommonMark's flanking rule and nothing more, so the intraword underscores this repository
# would actually write in a heading keep their anchors (round 4, P2).
links_tree
printf '\n## _Foo_\n\nUnderscore emphasis.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the source of emphasis](references/notes.md#_foo_).'
expect "a heading carrying underscore emphasis spells no anchor from its source" 1 \
  'will not spell an anchor for' -- "$CP" "$R"
links_tree
printf '\n## FLEET_BOX_CORRECTNESS_SLOTS\n\nIntraword, so literal on both sides.\n' \
  >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an intraword underscore](references/notes.md#fleet_box_correctness_slots).'
expect "...while an intraword underscore is text to both readings and keeps its anchor" 0 \
  '(1 checked)' -- "$CP" "$R"

# The blockquote strip takes GFM's indentation limits with it: four spaces before the marker is an
# indented code block, not a quote, and stripping it recorded an anchor that does not exist
# (round 4, P2). Inside the quote the same limit applies again.
links_tree
printf '\n    > ## Indented quote\n\nFour spaces: code, not a container.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an indented quote](references/notes.md#indented-quote).'
expect "four spaces before a blockquote marker is code, not a heading" 1 \
  "GitHub slug is 'indented-quote'" -- "$CP" "$R"
links_tree
printf '\n>     ## Indented content\n\nCode inside the quote.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [code inside a quote](references/notes.md#indented-content).'
expect "...and so is content indented four spaces inside one" 1 \
  "GitHub slug is 'indented-content'" -- "$CP" "$R"
links_tree
printf '\n   > ## Barely quoted\n>\n> Three spaces is still a quote.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a barely indented quote](references/notes.md#barely-quoted).'
expect "...while three spaces is still a blockquote, and its heading still a heading" 0 \
  '(1 checked)' -- "$CP" "$R"

# The symlink guard on the READING side: `link_files` globs and `-f` follows, so a prompt file
# that is a symlink out of the checkout would have its links taken from the host (round 4, P2).
# Reported rather than skipped -- a prompt that is a symlink is a defect in the checkout, and
# skipping it would leave its links unread in silence.
links_tree
printf '# Outside\n\nSee [a host link](gone.md).\n' > "$TMP/outside.md"
ln -s "$TMP/outside.md" "$R/alpha/references/extra.md"
expect "a linking file reached through a symbolic link is not read" 1 \
  'alpha/references/extra.md: is reached through a symbolic link' -- "$CP" "$R"
rm -f "$TMP/outside.md"

# The other direction of the block-scope gap, pinned so it is a decision rather than a hole: a
# heading-shaped line GFM would not render -- inside an HTML comment, as inside a fence -- still
# contributes an anchor here. That can ACCEPT a link GitHub would not resolve; it refuses none,
# which is why it is the side this scan is willing to be wrong on (round 4, P2, rebutted).
links_tree
printf '\n<!--\n## Hidden\n-->\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a heading inside a comment](references/notes.md#hidden).'
expect "a heading inside an HTML comment contributes an anchor, as one inside a fence does" 0 \
  '(1 checked)' -- "$CP" "$R"

# A code span is the one construct whose CONTENT is literal text, and it is resolved rather than
# refused, because these headings are full of it. Rendering a span means three things at once
# (round 5, P2): its padding is stripped the way CommonMark strips it; its content slugs as the
# text it is; and the markup tests do not read into it, which took two latent false refusals out
# that rounds 3 and 4 had put in.
links_tree
printf '\n## ` padded `\n\nA span whose content is padded.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a padded span](references/notes.md#padded).'
expect "a padded code span renders without its padding" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## ` padded `\n\nA span whose content is padded.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the source of one](references/notes.md#-padded-).'
expect "...so the source reading, spaces and all, names no heading" 1 \
  "GitHub slug is '-padded-'" -- "$CP" "$R"
links_tree
printf '\n## `_foo_`\n\nEmphasis markers inside a span are literal.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [underscores in a span](references/notes.md#_foo_).'
expect "underscores inside a code span are literal, not emphasis" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## `<T>` and `&amp;`\n\nMarkup inside a span is literal too.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [markup in a span](references/notes.md#t-and-amp).'
expect "...and so are a tag and an entity, which the markup tests must not read into" 0 \
  '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## unclosed `run\n\nA backtick run with no match is literal.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an unclosed run](references/notes.md#unclosed-run).'
expect "...while a backtick run with no closing match is just a backtick" 0 '(1 checked)' -- "$CP" "$R"

# A routine keeps its reference files under `routines/<name>/references/`, and the second hop out
# of one was the place a missing target passed: the link FROM the prompt was checked, the links
# INSIDE the reference were not (round 5, P2). No routine keeps such a directory today, so this is
# the glob standing ahead of the first one.
links_tree
mkdir -p "$R/routines/nightly/references"
printf '# Guide\n\nSee [the second hop](gone.md).\n' > "$R/routines/nightly/references/guide.md"
expect "a routine reference file is a linking file too" 1 \
  'routines/nightly/references/guide.md: link to gone.md resolves to no file' -- "$CP" "$R"

# A backslash makes the next ASCII punctuation character literal, and a literal character is not a
# delimiter of anything -- not a code span, not emphasis, not a tag. Resolving escapes before any
# of those tests read the heading is what keeps the next escaped delimiter somebody writes from
# being a finding of its own (round 6, P2). Two of these were false REFUSALS before it.
links_tree
printf '\n## \\_Foo\\_\n\nEscaped underscores, which render as themselves.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [escaped underscores](references/notes.md#_foo_).'
expect "an escaped underscore is literal, so its heading keeps its anchor" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## \\<em\\> literal\n\nAn escaped angle bracket is not a tag.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an escaped bracket](references/notes.md#em-literal).'
expect "...and an escaped angle bracket opens no tag" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## \\`_foo_\\`\n\nEscaped backticks open no span, so the underscores are emphasis.\n' \
  >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [escaped backticks](references/notes.md#_foo_).'
expect "...while an escaped backtick opens no span, so what it held is read as emphasis" 1 \
  'will not spell an anchor for' -- "$CP" "$R"

# A byte-order mark opens a FILE, not a line, and GFM removes it before parsing anything -- so the
# first heading of a file carrying one is a heading, and leaving those bytes in front of its
# hashes refused a link that works (round 6, P2).
links_tree
printf '\357\273\277# Marked\n\n## Close-out\n' > "$R/alpha/references/marked.md"
links_body alpha/SKILL.md 'See [past a byte-order mark](references/marked.md#marked).'
expect "a byte-order mark does not hide the first heading of a file" 0 '(1 checked)' -- "$CP" "$R"

# The one space a blockquote marker takes may be written as a tab, which GFM expands to the next
# tab stop: `><TAB>## Foo` is a heading with two columns of indentation left, well inside the
# three the ATX rule allows. Leaving the tab in place hid the hashes (round 7, P2).
links_tree
printf '\n>\t## Tabbed quote\n>\n> A tab where the space would be.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a tab after the marker](references/notes.md#tabbed-quote).'
expect "a tab may stand for the space a blockquote marker takes" 0 '(1 checked)' -- "$CP" "$R"

# A carriage return is the other half of a CRLF line ending, not content -- awk splits on the LF
# and leaves it standing. It defeated the closing-hash rule outright, slugging `## Foo ##<CR>` to
# `foo-`: refusing `#foo` and accepting a `#foo-` that is not there (round 7, P2).
links_tree
printf '\n## Closed off ##\r\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [past a carriage return](references/notes.md#closed-off).'
expect "a CRLF line ending does not join the closing hashes to the heading" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## Closed off ##\r\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the reading with it](references/notes.md#closed-off-).'
expect "...so the reading that keeps it names no heading" 1 "GitHub slug is 'closed-off-'" -- "$CP" "$R"

# A case-insensitive filesystem -- the macOS default, and this suite runs on macOS and on Ubuntu
# both -- answers `-f` yes for a link whose spelling the checkout does not have, while GitHub
# serves that link as a 404. Unchecked, the same head passes on one runner and fails on the other
# (round 7, P2). The probe is written so it MEANS something on either: on a case-sensitive box the
# path does not exist at all, so the refusal is asserted by the half of the message both share.
links_tree
links_body alpha/SKILL.md 'See [a mis-cased path](references/Notes.md).'
expect "a link the checkout spells differently is refused, however the filesystem answers" 1 \
  'alpha/SKILL.md: link to references/Notes.md' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'See [the spelling it has](references/notes.md).'
expect "...while the spelling the checkout has resolves" 0 '(1 checked)' -- "$CP" "$R"

# A hidden path component: `*` alone skips every name beginning with a dot, so round 7's casing
# scan never enumerated one and read a correctly spelled path as mis-cased (round 8, P2).
links_tree
mkdir -p "$R/alpha/.refs"
printf '# Hidden\n\n## A section\n' > "$R/alpha/.refs/notes.md"
links_body alpha/SKILL.md 'See [a hidden directory](.refs/notes.md#a-section).'
expect "a hidden path component is spelled as the checkout spells it" 0 '(1 checked)' -- "$CP" "$R"
links_tree
mkdir -p "$R/alpha/.refs"
printf '# Hidden\n' > "$R/alpha/.refs/notes.md"
links_body alpha/SKILL.md 'See [a mis-cased hidden directory](.Refs/notes.md).'
expect "...and a mis-cased one is still refused" 1 \
  'alpha/SKILL.md: link to .Refs/notes.md' -- "$CP" "$R"

# A heading of pure punctuation slugs to nothing, and an empty slug is still an OCCUPANT: `## !!!`
# written twice is "" and "-1" on GitHub, so a link to `#-1` works there. Skipping both left `-1`
# out of the table and refused it (round 8, P2). The empty name itself is never reported -- no
# anchor can spell it -- but it takes its place in the numbering.
links_tree
printf '\n## !!!\n\n## !!!\n\n## !!!\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the first repeat](references/notes.md#-1) and [the second](references/notes.md#-2).'
expect "an empty slug numbers its repeats, which are anchors that work" 0 '(2 checked)' -- "$CP" "$R"
links_tree
printf '\n## !!!\n\n## !!!\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [one repeat too many](references/notes.md#-2).'
expect "...and stops where the file does" 1 "GitHub slug is '-2'" -- "$CP" "$R"

# A link opens with a LABEL. Without one, `](x.md)` standing in prose is a token somebody wrote,
# not a link Markdown renders -- and reporting its target as a broken link is the one way this
# scan can fail a file that has nothing wrong with it (round 9, P2). The balanced-paren and
# rejected-candidate fixes of rounds 2 and 3 never reached it, because a bare token with a valid
# `.md` target is accepted, not rejected.
links_tree
links_body alpha/SKILL.md 'The token ](references/gone.md) is documented, and is not a link.'
expect "a target with no opening label is not a link, so its file is not required" 0 '0 failed' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'The token ](references/gone.md) is documented; [and here](references/gone.md) it is.'
expect "...while the labelled one on the same line is still read" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"

# A heading may END at its hash run: `#` alone is an empty heading to GFM, and skipping it cost
# its successors their numbering as well as itself -- with `#` before `## !!!`, the second is `-1`
# on GitHub and was being read as the first empty slug (round 9, P2).
links_tree
printf '\n#\n\n## !!!\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [past an empty heading](references/notes.md#-1).'
expect "a heading that ends at its hash run is a heading, and occupies its slug" 0 '(1 checked)' -- "$CP" "$R"

# Code-span padding is stripped only when BOTH ends are spaces; one-sided padding is preserved, so
# `## ` foo`` is `-foo` on GitHub. Trimming the RENDERED text threw that space away -- the trim
# belongs to the ATX parse, before the inline reading, which is where GFM does it (round 9, P2).
links_tree
printf '\n## ` foo`\n\nOne-sided padding, which survives.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a preserved space](references/notes.md#-foo).'
expect "a space a code span preserves is not trimmed away after rendering" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## ` foo`\n\nOne-sided padding, which survives.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [the trimmed reading](references/notes.md#foo).'
expect "...so the trimmed reading names no heading" 1 "GitHub slug is 'foo'" -- "$CP" "$R"

# The label is the bracket THIS `]` closes, not any `[` standing earlier: `[note] then ](x.md)`
# has one before it and opens no link, so looking for any at all still failed prose that is fine
# (round 10, P2). Walked backwards, counting the pairs that close on the way.
links_tree
links_body alpha/SKILL.md 'A [note] then ](references/gone.md) as a token, not a link.'
expect "a bracket already closed is not this link's label" 0 '0 failed' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'A [note] then [a real one](references/gone.md).'
expect "...while the one that does close at it opens a link" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"

# A backslash does not escape INSIDE a code span, so the span walk and the escape reading cannot be
# two global passes: `## `\`_foo_`` opens a span at the first backtick and closes it at the one
# after the backslash, leaving `_foo_` outside as emphasis. Marking that backtick escaped paired
# the first with the LAST instead and recorded `_foo_` (round 10, P2). One walk now, left to right.
links_tree
printf '\n## `\\`_foo_`\n\nA backslash inside a span, which escapes nothing.\n' \
  >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a span holding a backslash](references/notes.md#_foo_).'
expect "a backslash inside a code span escapes nothing, so what follows is not span content" 1 \
  'will not spell an anchor for' -- "$CP" "$R"
links_tree
printf '\n## `_lit_` and ` padded `\n\nSpan contents, still literal.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [span contents](references/notes.md#_lit_-and-padded).'
expect "...while the one walk keeps both readings a span is owed" 0 '(1 checked)' -- "$CP" "$R"

# A `<` is markup only once the construct CLOSES: `## Use <Type` parses no tag and GitHub gives it
# the ordinary slug, so refusing on the opening character alone refused plain text (round 10, P2).
links_tree
printf '\n## Use <Type\n\nAn opening bracket that closes nothing.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an unclosed bracket](references/notes.md#use-type).'
expect "an incomplete HTML construct is not HTML, so its heading keeps its anchor" 0 \
  '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## Use <em>tags</em>\n\nA tag spelled whole.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a complete tag](references/notes.md#use-emtagsem).'
expect "...while a complete one still spells no anchor" 1 'will not spell an anchor for' -- "$CP" "$R"

# The blockquote marker takes ONE column of a tab's expansion, not the whole of it, and the columns
# left over are indentation: `><TAB>  ##` is four columns in, an indented code block, where
# discarding the tab left two and recorded a heading GFM does not render (round 10, P2).
links_tree
printf '\n>\t  ## Hidden by indentation\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an indented phantom](references/notes.md#hidden-by-indentation).'
expect "the columns a tab leaves after a blockquote marker are indentation" 1 \
  "GitHub slug is 'hidden-by-indentation'" -- "$CP" "$R"

# A bracket a backslash made literal opens no label, so `\[note](x.md)` is prose (round 11, P2).
# Parity, not presence: `\\[note]` is an escaped BACKSLASH followed by a real opener.
links_tree
links_body alpha/SKILL.md 'Prose with \[note](references/gone.md) escaped, which renders as text.'
expect "an escaped bracket opens no label" 0 '0 failed' -- "$CP" "$R"
links_tree
links_body alpha/SKILL.md 'Prose with \\[note](references/gone.md), where the backslash is the escaped one.'
expect "...while two backslashes escape each other and leave a real opener" 1 \
  'resolves to no file: alpha/references/gone.md' -- "$CP" "$R"

# The `]` of a candidate is read with the same parity: an escaped one closes no label either.
links_tree
links_body alpha/SKILL.md 'Prose [with an escaped closer\](references/gone.md) renders as text.'
expect "an escaped closing bracket closes no label" 0 '0 failed' -- "$CP" "$R"
# A `+` is one of the path characters the shape admits, so such a target is read and checked.
links_tree
links_body alpha/SKILL.md 'See [a plus in the name](references/c++.md).'
expect "a '+' is a path character, so its target is read" 1 \
  'resolves to no file: alpha/references/c++.md' -- "$CP" "$R"
# An ATX heading is one to six hashes followed by a blank or the line end: seven hashes, and a
# hash run glued to its text, are paragraphs to GFM and contribute no anchor.
links_tree
printf '\n####### Seven hashes\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [seven](references/notes.md#seven-hashes).'
expect "seven hashes open no heading" 1 "GitHub slug is 'seven-hashes'" -- "$CP" "$R"
links_tree
printf '\n#tagline\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a tag](references/notes.md#tagline).'
expect "...nor does a hash run glued to its text" 1 "GitHub slug is 'tagline'" -- "$CP" "$R"

# The raw-HTML forms beyond tags and comments render as markup and contribute no heading text, so
# the source reading handed `## <?target?>` the anchor `target`, which GitHub does not create
# (round 11, P2). A processing instruction, a declaration and a CDATA section, each spelled whole.
while IFS='|' read -r label heading anchor; do
  links_tree
  printf '\n## %s\n\nRaw HTML, which renders as markup.\n' "$heading" >> "$R/alpha/references/notes.md"
  links_body alpha/SKILL.md "See [$label](references/notes.md#$anchor)."
  expect "a heading that is raw HTML spells no anchor: $label" 1 \
    'will not spell an anchor for' -- "$CP" "$R"
done <<'EOF'
a processing instruction|<?target?>|target
a declaration|<!DOCTYPE html>|doctype-html
a CDATA section|<![CDATA[x]]>|cdatax
EOF
links_tree
printf '\n## A < B still text\n\nAn opening bracket that is not markup.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [text, not markup](references/notes.md#a--b-still-text).'
expect "...while a bare < among them is still text on both sides" 0 '(1 checked)' -- "$CP" "$R"

# The heading guard applies the same label test `md_links` does: `## Token ](literal)` renders no
# link and GitHub gives it the ordinary slug, where refusing on the substring alone refused plain
# text (round 12, P2).
links_tree
printf '\n## Token ](literal)\n\nA token, not a link.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a token in a heading](references/notes.md#token-literal).'
expect "a heading carrying a link-shaped token with no label keeps its anchor" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## [Real](https://example.invalid) link\n\nA link, which renders.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a real one](references/notes.md#reallinkhttpsexampleinvalid-link).'
expect "...while one carrying a real label still spells no anchor" 1 \
  'will not spell an anchor for' -- "$CP" "$R"

# A comment refuses the heading only once it CLOSES, as a tag has since round 10: `## Use <!--
# literal` renders the opener as text and has the anchor GitHub built from it (round 12, P2).
links_tree
printf '\n## Use <!-- literal\n\nAn opener that closes nothing.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [an unclosed comment](references/notes.md#use----literal).'
expect "an unclosed comment opener is text, so its heading keeps its anchor" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## Hidden <!-- gone --> here\n\nA comment spelled whole.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a closed comment](references/notes.md#hidden---gone----here).'
expect "...while a closed one still spells no anchor" 1 'will not spell an anchor for' -- "$CP" "$R"

# A character reference renders as markup only when it DECODES. The full named table is two
# thousand entries this check will not carry, so a numeric reference and the names this prose could
# plausibly write are held, and anything else reads as the literal text it renders as (round 12,
# P2). `## Rock &bogus; Roll` keeps its anchor; `&amp;` does not.
links_tree
printf '\n## Rock &bogus; Roll\n\nA name HTML does not define.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a name that decodes to nothing](references/notes.md#rock-bogus-roll).'
expect "a character reference HTML does not define is text, and keeps its anchor" 0 \
  '(1 checked)' -- "$CP" "$R"
links_tree
printf '\n## Rock &amp; Roll\n\nA name HTML defines.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [one that decodes](references/notes.md#rock-amp-roll).'
expect "...while one that decodes still spells no anchor" 1 'will not spell an anchor for' -- "$CP" "$R"
links_tree
printf '\n## Rock &#38; Roll\n\nA numeric reference, which always decodes.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [a numeric one](references/notes.md#rock-38-roll).'
expect "...and so does a numeric one, which always decodes" 1 'will not spell an anchor for' -- "$CP" "$R"

# A reference file whose name begins with a dot is a reference file: the first hop to it was
# checked and the links INSIDE it were never scanned, which is the hole round 5 closed for
# routines and round 8 for path components (round 12, P2).
links_tree
printf '# Guide\n\nSee [the second hop](gone.md).\n' > "$R/alpha/references/.guide.md"
expect "a dotted reference file is a linking file too" 1 \
  'alpha/references/.guide.md: link to gone.md resolves to no file' -- "$CP" "$R"

# The obligation comes from a link, as the fixtures' comes from a fixture: a tree with none is not
# reported as link-checked.
fresh "$R"
out=$("$CP" "$R" 2>&1)
grep -q 'relative Markdown link' <<<"$out" && ko "a tree with no link is reported as link-checked" \
  || ok "...and a tree carrying no such link takes no link obligation"

# Under Actions the failure is an annotation on the LINKING file, which is the file to edit.
links_tree
links_body alpha/SKILL.md 'See [what moved](references/gone.md).'
expect "GitHub annotations name the linking file" 1 '::error file=alpha/SKILL.md::link to references/gone.md' \
  -- env GITHUB_ACTIONS=true "$CP" "$R"

# The real prompts. The link probed is read OFF the wave prompt rather than restated here: the
# anchors ludics-lite#260 created are exactly what moves next time the sections do, and a probe
# naming one literally would go stale at that edit instead of catching it.
LINK_ALL=$(sed -n 's|.*(\(references/[A-Za-z0-9_.-]*\.md#[A-Za-z0-9_-]*\)).*|\1|p' "$SRC/issue-wave/SKILL.md")
LINK_TARGET=${LINK_ALL%%$'\n'*}
LINK_FILE=${LINK_TARGET%%#*}
[ -n "${LINK_TARGET#*#}" ] && [ -f "$SRC/issue-wave/$LINK_FILE" ] \
  || ko "the link probes need an anchored references/....md#... link in issue-wave/SKILL.md; read '$LINK_TARGET'"
# The one tree that takes EVERY Markdown file, because the real link graph is its subject. The
# other two take $LINK_TARGETS, which costs a tenth of the time over their seventy-odd rebuilds.
links_real() {
  local f
  rm -rf "$R"; mkdir -p "$R"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    copy_prompts "$R" "$f"
  done <<<"$(cd "$SRC" && find . -name .git -prune -o -name '*.md' -print | sed 's|^\./||' | sort)"
}
# links_edit <file> <sed-expression>: rewrites one copy, and says so if it matched nothing -- a
# mutation that changed nothing leaves a probe asserting a refusal the tree no longer earns.
links_edit() {
  sed "$2" "$R/$1" > "$R/links.tmp" || { ko "links_edit: sed failed on $1"; return 1; }
  cmp -s "$R/links.tmp" "$R/$1" && { ko "links_edit: '$2' matched nothing in $1"; return 1; }
  mv "$R/links.tmp" "$R/$1"
}

links_real
expect "every relative link in the real prompts resolves, anchors included" 0 \
  'anchors included' -- "$CP" "$R"

# The two drifts this check exists for, each made at the source: a section retitled, and the file
# holding it renamed. Both look exactly like a working link until somebody clicks one.
links_real
links_edit "issue-wave/$LINK_FILE" 's/^## /## Renamed /'
expect "a retitled heading is caught in the prompt that anchors into it" 1 \
  "issue-wave/SKILL.md: link to $LINK_TARGET names no heading" -- "$CP" "$R"

links_real
mv "$R/issue-wave/$LINK_FILE" "$R/issue-wave/${LINK_FILE%.md}-renamed.md"
expect "a renamed reference file is caught the same way" 1 \
  "issue-wave/SKILL.md: link to $LINK_FILE" -- "$CP" "$R"

# --- the shell checker's byte and path readings ------------------------------------------------
# The checker was a shell script until ludics-lite#403, run on macOS under the platform's own awk,
# sed and find, and its verdicts are what the port keeps. Each probe below is a reading those
# tools made that no other probe holds, found by the parity review of the port.

# nul_edit <file> <text> prefix|suffix: puts a NUL before (prefix) or after (suffix) each line of a
# scratch file that contains <text>, headings left alone. Says so when no line matched, since a
# probe over an unmutated tree asserts nothing.
nul_edit() {
  local f="$R/$1" line hit=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '#'*) printf '%s\n' "$line" ;;
      *"$2"*)
        hit=1
        if [ "$3" = prefix ]; then printf 'x\000 %s\n' "$line"; else printf '%s\000junk\n' "$line"; fi ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$f" > "$R/nul.tmp"
  [ "$hit" -eq 1 ] || { ko "nul_edit: no line of $1 contains '$2'"; return 1; }
  mv "$R/nul.tmp" "$f"
}

# A NUL ends an awk record's text: the macOS awk reads a line as a C string, so whatever follows a
# NUL on its line is not there to the index, register, slot, link and heading readers. A count
# stated only after one is no statement...
slots_tree
nul_edit issue-wave/references/executions.md mac-studio prefix
expect "a slot count stated only after a NUL is no statement" 1 \
  "FAIL: issue-wave/references/executions.md: states no mac-studio slot count" -- "$CP" "$R"
# ...a wrong one after a NUL is not held...
slots_tree
printf 'note \000 mac-studio=%s\n' "$OTHER" >> "$R/issue-wave/references/executions.md"
expect "a wrong slot count after a NUL is not read" 0 'mac-studio correctness slots agree' -- "$CP" "$R"
# ...a heading's text stops at one, and so does a line holding a link.
links_tree
printf '\n## Sec\000tail\n\nCut short.\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [it](references/notes.md#sec).'
expect "a heading's slug stops at a NUL" 0 '(1 checked)' -- "$CP" "$R"
links_tree
printf 'x\000 [gone](missing.md)\n' >> "$R/alpha/references/notes.md"
links_body alpha/SKILL.md 'See [it](references/notes.md).'
expect "a link after a NUL is not read" 0 '(1 checked)' -- "$CP" "$R"
fixture_tree
nul_edit README.md alpha/scripts/test-shell.sh suffix
expect "a register line reads up to a NUL" 0 'fixture command register and required CI platforms agree' \
  -- "$CP" "$R"
# A sed reading keeps the NUL, and the command substitution around it then drops it: the routine
# names read off LOCAL_ROUTINES are the ones with the NUL taken out.
drift_tree
nul_edit scripts/sync-routines.sh 'LOCAL_ROUTINES="' prefix
sed 's/^x\(.\) LOCAL_ROUTINES="/LOCAL_ROUTINES="\1/' "$R/scripts/sync-routines.sh" > "$R/nul.tmp" \
  && mv "$R/nul.tmp" "$R/scripts/sync-routines.sh"
expect "a NUL in LOCAL_ROUTINES is dropped from the names" 0 'runs it to read its own drift' -- "$CP" "$R"

# A count is bash arithmetic's, which wraps at 64 bits: 2^64 + n is n, and 2^64 is zero.
if [ "${WANT:-0}" -le 83 ]; then
  WRAPPED=184467440737095516$(printf '%02d' $((16 + 10#0${WANT:-0})))
  slots_tree
  slots_edit "$WORKER" "s/mac-studio=$WANT/mac-studio=$WRAPPED/g"
  expect "a default past 64 bits wraps as bash arithmetic does" 0 \
    "count say $WANT" -- "$CP" "$R"
  slots_tree
  slots_edit "$WORKER" "s/mac-studio=$WANT/mac-studio=18446744073709551616/g"
  expect "a default of 2^64 is zero" 1 \
    "SLOTS assignment states mac-studio=0; the worker requires" -- "$CP" "$R"
else
  ko "the 64-bit probes spell 2^64 + WANT for a WANT below 84; read '$WANT'"
fi

# The slot scan walked the root with `find` and cut the root back off each path with an awk `-v`
# assignment, which is escape-processed: a backslash in the root's path matched no file, so the
# scan found no statement at all.
slots_tree
rm -rf "$TMP/b\\nroot"; cp -R "$R" "$TMP/b\\nroot"
expect "a root whose path holds a backslash finds no slot statement" 1 \
  "FAIL: issue-wave/references/executions.md: states no mac-studio slot count" -- "$CP" "$TMP/b\\nroot"
rm -rf "$TMP/b\\nroot"
# ...and `find` does not descend into a root that is itself a symbolic link.
slots_tree
rm -f "$TMP/linked-root"; ln -s "$R" "$TMP/linked-root"
expect "a root that is a symbolic link finds no slot statement" 1 \
  "FAIL: issue-wave/references/executions.md: states no mac-studio slot count" -- "$CP" "$TMP/linked-root"
rm -f "$TMP/linked-root"
# The default root is `$HERE/..` named logically, so this checkout reached through a link is one.
rm -f "$TMP/checkout-link"; ln -s "$SRC" "$TMP/checkout-link"
expect "this checkout through a symbolic link finds no slot statement" 1 \
  "FAIL: issue-wave/references/executions.md: states no mac-studio slot count" \
  -- "$TMP/checkout-link/scripts/check-prompts.sh"
rm -f "$TMP/checkout-link"

# The root is entered with `cd "$ROOT" && pwd`: the logical path when it is a directory, and the
# physical one when it is not -- `lnk/../root` through a symbolic link lands where the kernel does.
rm -rf "$TMP/dotdot"; mkdir -p "$TMP/dotdot/real/x"
fresh "$TMP/dotdot/real/root"
ln -s real/x "$TMP/dotdot/lnk"
expect "a '..' through a symbolic link falls back to the physical directory" 0 '6 passed, 0 failed' \
  -- bash -c 'cd "$1" && exec "$2" lnk/../root' _ "$TMP/dotdot" "$CP"
expect "...and so does --one" 0 '1 passed, 0 failed' \
  -- bash -c 'cd "$1" && exec "$2" --one ../root/alpha' _ "$TMP/dotdot/lnk" "$CP"
rm -rf "$TMP/dotdot"

# An index that is a regular file but cannot be read is there, and indexes nothing.
fresh "$R"
rm -rf "$R/routines/nightly" "$R/routines/weekly"
chmod 000 "$R/routines/README.md"
expect "an unreadable index with nothing to index is not missing" 0 \
  'ok: routines/README.md: no routines/ SKILL.md directory to index' -- "$CP" "$R"
chmod 644 "$R/routines/README.md"

# The cleanup helper runs with no input, and its usage text is a command substitution's, which
# drops a NUL.
cleanup_tree
{ head -n 1 "$R/$CLEANUP_HELPER"
  printf '%s\n' 'if [ "$#" -eq 0 ] && read -r _; then echo "usage: stdin was read" >&2; exit 2; fi'
  tail -n +2 "$R/$CLEANUP_HELPER"; } > "$R/cleanup.tmp" && mv "$R/cleanup.tmp" "$R/$CLEANUP_HELPER"
expect "the cleanup helper is run with no input" 0 "$CLEANUP_AGREE" \
  -- bash -c 'printf "x\n" | "$1" "$2"' _ "$CP" "$R"
cleanup_tree
{ head -n 1 "$R/$CLEANUP_HELPER"
  printf '%s\n' "if [ \"\$#\" -eq 0 ]; then printf 'usage: x\\n  --base\\000x <b>\\n' >&2; exit 2; fi"
  tail -n +2 "$R/$CLEANUP_HELPER"; } > "$R/cleanup.tmp" && mv "$R/cleanup.tmp" "$R/$CLEANUP_HELPER"
expect "a NUL in the usage text is dropped, joining the name around it" 1 \
  "names no '--basex'" -- "$CP" "$R"

# --- this checkout ---------------------------------------------------------------------------
expect "this checkout's prompts pass" 0 '0 failed' -- "$CP"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
exit "$?"
}
