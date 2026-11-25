# Blinded A/B code-quality judging (retrospective procedure)

`fleet-worker.sh wave ab` reads the quantitative A/B comparison table. For the code itself,
[Codex model choice](../SKILL.md#codex-model-choice) pairs PRs by area before reading any diff and
runs one blind judge from **each arm's family** (a GPT/Codex judge and a Gemini/`agy` judge for the
Sol-against-Neon arms; add a Claude judge when an arm is Claude). In the 2026-11-20 retrospective
(15 pairs), each single judge preferred its own model family 9 to 6 while the 8 consensus pairs
split 4 to 4, so judging stays a human-read retrospective procedure rather than a verdict-printing
verb.

## 1. Check the comparison table first

Run `wave ab` across the waves under study and keep its JSON if you want to reuse the join without
re-querying boards:

```sh
RETRO="$HOME/.local/state/issue-wave/retro-$(date +%Y%m%d)-ab"
mkdir -p "$RETRO"
~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave ab \
  <wave1>/wave.json <wave2>/wave.json > "$RETRO/table.md"
~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave ab \
  <wave1>/wave.json <wave2>/wave.json --json > "$RETRO/ab.json"
```

Read `agent_host` balance and ten-per-arm readiness before drawing conclusions from any group.

## 2. Export blinded, area-matched pairs

Export pairs to a directory **separate** from the unblinding key (`wave ab-pairs` refuses any
`--key` inside `--out`, never overwrites an existing key or non-empty output directory, balances
A/B sides within ±1 under a recorded seed kept in `key.json` only, and prints no seed, arm labels,
or PR/issue numbers on stdout):

```sh
~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave ab-pairs \
  --from-json "$RETRO/ab.json" \
  --out "$RETRO/pairs" \
  --key "$RETRO/key.json" \
  [--group D2] [--arms '<armA>' '<armB>'] [--max-pairs 15] [--seed 20261125] [--scrub <word>]
```

You can also pass `<wave.json>...` directly instead of `--from-json` (passing wave files also feeds
their `profiles` names into the task-text scrubber). Do **not** open `$RETRO/key.json` until both
judges have finished every pair.

`wave ab-pairs` writes `$RETRO/pairs/manifest.json` (blinded pair ID, repository, tier group) and,
for each pair `<PAIR>`, `$RETRO/pairs/<PAIR>/{A-task.md, A.diff, B-task.md, B.diff}`. Issue titles,
bodies, and pre-launch comments are scrubbed by the closed list in
`lib/ludics/fleetworker/waveabpairs.py`, and self-references to each task's own issue/PR/wave/task
(including short `<repo>#N` forms and GitHub issue/PR URLs) are redacted from both task prose and
diffs; PR bodies, PR titles, branch names, and commit messages are omitted. **Blinding residual:**
the local checkout (`$CO` / `$CLONE`) is not scrubbed, so merged files and repository docs (such as
`issue-wave/SKILL.md`'s split rule in `ludics`) remain present if a judge ignores the prompt's
blind rules; this residual is accepted by the procedure rather than masked away.

## 3. Render the judge prompt and run one judge per family

The judge prompt template ships at `issue-wave/templates/ab/judge.md` (beside
`issue-wave/templates/review/`). Render it per pair with `fleet-worker.sh wave render` — never
inline the diffs into the prompt (large inlined diffs exceed `agy`'s ~191 KB message cut; see
`lib/ludics/agy.py`).

**Keep `$PAIR_DIR` read-only and separate from judge outputs.** Never write a judge's prompt, log,
or verdict inside `$RETRO/pairs/$PAIR`; write each judge family's outputs under its own directory
(`$RETRO/judges/<family>/$PAIR/`) so a later judge cannot read an earlier judge's verdict.

### GPT (Codex) judge — read-only sandbox

Check `~/.codex/models_cache.json` on the box for the current model ID. Always pass **`< /dev/null`**
so `codex exec` does not hang waiting on stdin (in the 2026-11-20 retrospective, omitting it stalled
the first judge for ten minutes):

```sh
PAIR_DIR="$RETRO/pairs/$PAIR"
OUT_CODEX="$RETRO/judges/codex/$PAIR"
mkdir -p "$OUT_CODEX"

~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave render \
  --set REPO="$REPO" --set CHECKOUT="$CO" --set DIR="$PAIR_DIR" --set PAIR="$PAIR" \
  --out "$OUT_CODEX/prompt.md" \
  ~/ludics/issue-wave/templates/ab/judge.md

codex exec -m gpt-6.2-sol -c model_reasoning_effort=high -s read-only \
  -C "$CO" --ephemeral -o "$OUT_CODEX/verdict.json" \
  "$(cat "$OUT_CODEX/prompt.md")" < /dev/null > "$OUT_CODEX/codex.log" 2>&1
```

### Gemini (`agy`) judge — disposable local clone

`agy`'s permission rules cannot hold a headless turn to read-only (`lib/ludics/agy.py`), so create
a disposable local clone through `ludics.agy.clone` (which scrubs Git's repository-selection
variables before every git command, disables hooks, and removes `origin` — never run `agy` in the
served checkout `~/ludics` or `~/ocannl-staging`). Stop immediately if clone setup fails, render
`CHECKOUT` pointing at that clone, feed the prompt as one `stream-json` user message on stdin,
extract the final `result.response` JSON, and remove the clone afterward:

```sh
PAIR_DIR="$RETRO/pairs/$PAIR"
OUT_GEMINI="$RETRO/judges/gemini/$PAIR"
mkdir -p "$OUT_GEMINI"
CLONE=$(mktemp -d "${TMPDIR:-/tmp}/ab-judge-clone.XXXXXX")
rmdir "$CLONE"

~/ludics/scripts/py -c '
import subprocess, sys
from ludics import agy
co, ref, dest = sys.argv[1], sys.argv[2], sys.argv[3]
# Resolve the exact commit SHA in the source checkout first (agy.clone resolves refs inside the
# fresh clone, where origin/<main> maps from the source local branch rather than its remote ref).
res = subprocess.run(["git", "-C", co, "rev-parse", "--verify", f"{ref}^{{commit}}"],
                     env=agy.environment(), capture_output=True, text=True)
if res.returncode != 0:
    sys.exit(f"cannot resolve {ref} in {co}: {res.stderr.strip()}")
why = agy.clone(co, res.stdout.strip(), dest, "ab-judge")
if why:
    sys.exit(why)
' "$CO" "HEAD" "$CLONE" &&
~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave render \
  --set REPO="$REPO" --set CHECKOUT="$CLONE" --set DIR="$PAIR_DIR" --set PAIR="$PAIR" \
  --out "$OUT_GEMINI/prompt.md" \
  ~/ludics/issue-wave/templates/ab/judge.md &&
~/ludics/scripts/py -c '
import os, subprocess, sys
from ludics import agy
prompt = open(sys.argv[1], encoding="utf-8").read()
if agy.size(prompt) > agy.MESSAGE_BOUND:
    sys.exit(f"prompt exceeds agy.MESSAGE_BOUND ({agy.MESSAGE_BOUND})")
with open(sys.argv[3], "w", encoding="utf-8") as out, open(sys.argv[4], "w", encoding="utf-8") as err:
    rc = subprocess.run(["agy", *agy.argv(sys.argv[5])], cwd=sys.argv[2], input=agy.message(prompt),
                        env=agy.environment(), stdout=out, stderr=err).returncode
sys.exit(rc)
' "$OUT_GEMINI/prompt.md" "$CLONE" "$OUT_GEMINI/stream.jsonl" "$OUT_GEMINI/gemini.err" "gemini-4-neon-high" &&
~/ludics/scripts/py -c '
import sys
from ludics import agy
text, _, why = agy.result(open(sys.argv[1], encoding="utf-8").read())
if why:
    sys.exit(why)
print(text)
' "$OUT_GEMINI/stream.jsonl" > "$OUT_GEMINI/verdict.json"

rm -rf "$CLONE"
```

### Claude judge (when an arm is Claude, or as a third-family check)

Use `--tools Read,Grep,Glob` (removing all write/shell built-ins rather than only preapproving a
subset) with `--strict-mcp-config`:

```sh
PAIR_DIR="$RETRO/pairs/$PAIR"
OUT_CLAUDE="$RETRO/judges/claude/$PAIR"
mkdir -p "$OUT_CLAUDE"

~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave render \
  --set REPO="$REPO" --set CHECKOUT="$CO" --set DIR="$PAIR_DIR" --set PAIR="$PAIR" \
  --out "$OUT_CLAUDE/prompt.md" \
  ~/ludics/issue-wave/templates/ab/judge.md

(cd "$CO" && claude -p "$(cat "$OUT_CLAUDE/prompt.md")" --model opus \
  --strict-mcp-config --tools Read,Grep,Glob \
  --add-dir "$PAIR_DIR" --output-format json < /dev/null) \
  > "$OUT_CLAUDE/run.json" 2> "$OUT_CLAUDE/claude.err"
```

## 4. Unblind and read the result

Only after all judges finish every pair, join each judge's `prefer`, `margin`, and six dimension
scores (`correctness`, `design`, `tests`, `clarity`, `debt`, `scope`) against `$RETRO/key.json`:

1. **Check own-family bias first.** Count how often each judge preferred its own arm versus the
   other arm, and separate **consensus pairs** (both judges agree) from **split pairs**.
2. **Read the evidence, not just the tally.** Read `strengths`, `weaknesses`, `debt_items`, and
   `why` on both consensus and split pairs alongside `key.json`'s `readings` (whether the tier
   group reached ten per arm) and the `wave ab` metrics table.
3. **Keep the caveat.** Paired tasks share an area but are different issues; treat the blind
   reading as qualitative evidence paired with the quantitative table, never as an automated vote.
