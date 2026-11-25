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
A/B sides within ±1 under a recorded seed, and prints no arm labels or PR/issue numbers on stdout):

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
`lib/ludics/fleetworker/waveabpairs.py`; PR bodies, PR titles, PR/issue numbers, branch names, and
commit messages are omitted.

## 3. Render the judge prompt and run one judge per family

The judge prompt template ships at `issue-wave/templates/ab/judge.md` (beside
`issue-wave/templates/review/`). Render it per pair with `fleet-worker.sh wave render` — never
inline the diffs into the prompt (large inlined diffs exceed `agy`'s ~191 KB message cut; see
`lib/ludics/agy.py`).

### GPT (Codex) judge — read-only sandbox

Check `~/.codex/models_cache.json` on the box for the current model ID. Always pass **`< /dev/null`**
so `codex exec` does not hang waiting on stdin (in the 2026-11-20 retrospective, omitting it stalled
the first judge for ten minutes):

```sh
PAIR_DIR="$RETRO/pairs/$PAIR"
~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave render \
  --set REPO="$REPO" --set CHECKOUT="$CO" --set DIR="$PAIR_DIR" --set PAIR="$PAIR" \
  --out "$PAIR_DIR/codex-prompt.md" \
  ~/ludics/issue-wave/templates/ab/judge.md

codex exec -m gpt-6.2-sol -c model_reasoning_effort=high -s read-only \
  -C "$CO" --ephemeral -o "$PAIR_DIR/codex-verdict.json" \
  "$(cat "$PAIR_DIR/codex-prompt.md")" < /dev/null > "$PAIR_DIR/codex.log" 2>&1
```

### Gemini (`agy`) judge — disposable local clone

`agy`'s permission rules cannot hold a headless turn to read-only (`lib/ludics/agy.py`), so run it
in a disposable local clone of `$CO` with hooks disabled and no `origin` remote — never in the
served checkout (`~/ludics` or `~/ocannl-staging`). Render `CHECKOUT` pointing at that clone, feed
the prompt as one `stream-json` user message on stdin, extract the final `result.response` JSON,
and remove the clone afterward:

```sh
CLONE=$(mktemp -d "${TMPDIR:-/tmp}/ab-judge-clone.XXXXXX")
git -c core.hooksPath=/dev/null clone -q --no-checkout --no-hardlinks "$CO" "$CLONE"
git -C "$CLONE" -c core.hooksPath=/dev/null -c advice.detachedHead=false checkout -q --detach "origin/$MAIN"
git -C "$CLONE" remote remove origin

~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave render \
  --set REPO="$REPO" --set CHECKOUT="$CLONE" --set DIR="$PAIR_DIR" --set PAIR="$PAIR" \
  --out "$PAIR_DIR/gemini-prompt.md" \
  ~/ludics/issue-wave/templates/ab/judge.md

~/ludics/scripts/py -c 'import json, sys; print(json.dumps({"event": "user", "message": {"content": open(sys.argv[1], encoding="utf-8").read()}}))' \
  "$PAIR_DIR/gemini-prompt.md" \
  | (cd "$CLONE" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
      agy --model gemini-4-neon-high --input-format stream-json --output-format stream-json \
      --dangerously-skip-permissions) \
  > "$PAIR_DIR/gemini-stream.jsonl" 2> "$PAIR_DIR/gemini.err"

~/ludics/scripts/py -c 'import sys; from ludics import agy; text, _, why = agy.result(open(sys.argv[1], encoding="utf-8").read()); sys.exit(why) if why else print(text)' \
  "$PAIR_DIR/gemini-stream.jsonl" > "$PAIR_DIR/gemini-verdict.json"

rm -rf "$CLONE"
```

### Claude judge (when an arm is Claude, or as a third-family check)

```sh
~/.claude/skills/issue-wave/scripts/fleet-worker.sh wave render \
  --set REPO="$REPO" --set CHECKOUT="$CO" --set DIR="$PAIR_DIR" --set PAIR="$PAIR" \
  --out "$PAIR_DIR/claude-prompt.md" \
  ~/ludics/issue-wave/templates/ab/judge.md

(cd "$CO" && claude -p "$(cat "$PAIR_DIR/claude-prompt.md")" --model opus \
  --strict-mcp-config --allowedTools "Read" "Grep" "Glob" \
  --add-dir "$PAIR_DIR" --output-format json < /dev/null) \
  > "$PAIR_DIR/claude-run.json" 2> "$PAIR_DIR/claude.err"
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
