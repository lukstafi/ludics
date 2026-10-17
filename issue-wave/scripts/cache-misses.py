#!/usr/bin/env python3
"""Report the turns of native workers (Claude Code subagents) that missed the prompt cache.

    cache-misses.py [--since YYYY-MM-DD] [--projects DIR] [--list]

A subagent's requests cache for 5 minutes from its last request, where a main session's cache for
an hour, unless the host sets `subagentPromptCacheTtl` to `1h`; without it a worker whose blocking
call returns past ~300 s pays its whole context as a cache write on the next turn
(issue-wave/references/native-claude.md, *Blocking on a run*). This reads
the transcripts under DIR (default ~/.claude/projects), `<project>/<session>/subagents/*.jsonl`,
modified on or after --since (default: today), and counts as a MISS every assistant turn after a
transcript's first whose cache write exceeds both 2000 tokens and its cache read.

Each miss is put down to what started the turn:
  resume       a message to an idle worker (SendMessage), or the turn after its SubagentHandback:
               the coordinator's timing, not the worker's, so it does not alert;
  <cause>      the tool whose result started the turn -- `bg-run wait`, `test-run wait`,
               `execution slot/hold`, `pr-review`, `bash`, or `tool:<name>` for any other tool:
               a block that ran past the cache.

Output: one summary line, `cache-misses: <m> miss turns of <t> in <n> subagent transcripts,
<w> tokens written; <b> after a block`, then one line per cause, `  <cause>: <turns> turns,
<tokens> tokens, gaps <min>-<max> s`, the gap being the time from the turn before to the result
that started this one. --list adds one line per miss: `<transcript> <timestamp> gap=<s>
written=<tokens> <cause>`. Exit 0 when no miss followed a block, 1 when one did (a wave's
close-out reports it), 2 on a usage error.
"""
import argparse
from datetime import date, datetime
import json
from pathlib import Path
import re
import sys

MIN_WRITE = 2000


def when(stamp):
    return datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp()


def cause_of(tool):
    name, command = tool
    if name == 'SubagentHandback':
        return 'resume'
    if name != 'Bash':
        return f'tool:{name}'
    for pattern, label in ((r'bg-run\.sh\s+wait\b', 'bg-run wait'),
                           (r'test-run\.sh\s+wait\b', 'test-run wait'),
                           (r'execution\s+(slot|hold)\b', 'execution slot/hold'),
                           (r'pr-review\.sh\b', 'pr-review')):
        if re.search(pattern, command):
            return label
    return 'bash'


def started_by_user(entry):
    """Whether a user entry is a message (a resume), not only tool results or a meta reminder."""
    if entry.get('isMeta'):
        return False
    content = entry.get('message', {}).get('content')
    if isinstance(content, str):
        return bool(content.strip())
    return any(isinstance(b, dict) and b.get('type') == 'text' for b in content or [])


def scan(path):
    """Yield (turns, misses) for one transcript: misses as (timestamp, gap, written, cause)."""
    seen = set()
    turns = 0
    misses = []
    last_reply = None   # timestamp of the latest assistant entry
    last_other = None   # timestamp of the latest other entry, the result that starts a turn
    tool = None         # the latest tool_use: (name, Bash command)
    resumed = False     # a user message since the latest assistant entry
    for line in path.read_text(errors='replace').splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or not entry.get('timestamp'):
            continue
        stamp = entry['timestamp']
        if entry.get('type') != 'assistant':
            last_other = when(stamp)
            if entry.get('type') == 'user' and started_by_user(entry):
                resumed = True
            continue
        message = entry.get('message', {})
        usage = message.get('usage') or {}
        if message.get('id') not in seen and usage and message.get('model') != '<synthetic>':
            seen.add(message.get('id'))
            written = usage.get('cache_creation_input_tokens') or 0
            read = usage.get('cache_read_input_tokens') or 0
            if turns and written > MIN_WRITE and written > read:
                gap = None
                if last_reply is not None and last_other is not None and last_other >= last_reply:
                    gap = last_other - last_reply
                cause = 'resume' if resumed or tool is None else cause_of(tool)
                misses.append((stamp, gap, written, cause))
            turns += 1
        for block in message.get('content') or []:
            if isinstance(block, dict) and block.get('type') == 'tool_use':
                tool = (block.get('name'), (block.get('input') or {}).get('command') or '')
        last_reply = when(stamp)
        resumed = False
    return turns, misses


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--since', type=date.fromisoformat, default=date.today())
    parser.add_argument('--projects', type=Path, default=Path.home() / '.claude' / 'projects')
    parser.add_argument('--list', action='store_true')
    args = parser.parse_args(argv)
    floor = datetime.combine(args.since, datetime.min.time()).timestamp()
    paths = sorted(p for p in args.projects.glob('*/*/subagents/*.jsonl') if p.stat().st_mtime >= floor)
    total_turns = 0
    rows = []
    for path in paths:
        turns, misses = scan(path)
        total_turns += turns
        rows += [(path, *miss) for miss in misses]
    blocks = [r for r in rows if r[4] != 'resume']
    print(f'cache-misses: {len(rows)} miss turns of {total_turns} in {len(paths)} subagent transcripts, '
          f'{sum(r[3] for r in rows)} tokens written; {len(blocks)} after a block')
    for cause in sorted({r[4] for r in rows}, key=lambda c: -sum(r[3] for r in rows if r[4] == c)):
        mine = [r for r in rows if r[4] == cause]
        gaps = [round(r[2]) for r in mine if r[2] is not None]
        span = f'{min(gaps)}-{max(gaps)} s' if gaps else 'unknown'
        print(f'  {cause}: {len(mine)} turns, {sum(r[3] for r in mine)} tokens, gaps {span}')
    if args.list:
        for path, stamp, gap, written, cause in rows:
            shown = 'unknown' if gap is None else round(gap)
            print(f'{path} {stamp} gap={shown} written={written} {cause}')
    return 1 if blocks else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
