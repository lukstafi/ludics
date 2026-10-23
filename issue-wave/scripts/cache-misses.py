#!/usr/bin/env python3
"""Report the turns of native workers (Claude Code subagents) that missed the prompt cache.

    cache-misses.py [--since YYYY-MM-DD] [--projects DIR] [--session ID] [--list] [--idle MINUTES]

A subagent's requests cache for 5 minutes from its last request, where a main session's cache for
an hour, unless the host sets `subagentPromptCacheTtl` to `1h`; without it a worker whose blocking
call returns past ~300 s pays its whole context as a cache write on the next turn
(issue-wave/references/native-claude.md, *Blocking on a run*). This reads
the transcripts under DIR (default ~/.claude/projects), `<project>/<session>/subagents/*.jsonl`,
modified on or after --since (default: today), and counts as a MISS every assistant turn after a
transcript's first whose cache write exceeds both 2000 tokens and its cache read. --session ID reads
only that session's subagents, `<project>/ID/subagents/*.jsonl`: a coordinator's own workers, by its
session id, where the default reads every session's.

Each miss is put down to what started the turn:
  resume       a message to an idle worker (SendMessage): a turn after a reply that ended the turn
               (`stop_reason` `end_turn`; the runtime delivers the message as a meta entry, "The
               coordinator sent a message while you were working"), a user message, or the turn
               after its SubagentHandback: the coordinator's timing, not the worker's, so it does
               not alert;
  <cause>      the tool whose result started the turn -- `bg-run wait`, `test-run wait`,
               `execution slot/hold`, `pr-review`, `bash`, or `tool:<name>` for any other tool:
               a block that ran past the cache.

Output: one summary line, `cache-misses: <m> miss turns of <t> in <n> subagent transcripts,
<w> tokens written; <b> after a block`, then one line per cause, `  <cause>: <turns> turns,
<tokens> tokens, gaps <min>-<max> s`, the gap being the time from the turn before to the result
that started this one. A second line is what the transcripts' requests cost, by kind:
`cost: reads <r>, writes <w>, uncached <u>, output <o> tokens; reads <x>%, writes <y>%, uncached
<v>%, output <z>%`, the shares weighted by the input price's multiples (cache read 0.1, cache
write 2 at the 1-hour TTL and 1.25 at 5 minutes, uncached input 1, output 5); a write whose usage
does not split it by TTL is weighed at 2. Reads are each request re-reading the whole context, so
their share says how much context size times requests is costing (native-claude.md, *Keeping
workers warm*). --list adds one line per miss: `<transcript> <timestamp> gap=<s> written=<tokens>
<cause>`. --idle MINUTES adds one line per worker whose turn ended at least MINUTES ago and has
not been resumed since -- its transcript's last entry is an assistant reply that ended the turn
-- `idle <m>m <agent> context=<tokens> <description>`, the description off the transcript's
`.meta.json`; a subagent a worker spawned itself (`spawnDepth` above 1) is not listed. A worker
that has handed back is listed too: the board says which are done. Exit 0 when no miss followed a
block, 1 when one did (a wave's close-out reports it), 2 on a usage error.
"""
import argparse
from datetime import date, datetime
import json
from pathlib import Path
import re
import sys
import time

MIN_WRITE = 2000
# Multiples of the input price: a cache read, a cache write at each TTL, uncached input, output.
WEIGHTS = {'reads': 0.1, 'writes_1h': 2.0, 'writes_5m': 1.25, 'uncached': 1.0, 'output': 5.0}


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
    """(turns, misses, cost, last) for one transcript: misses as (timestamp, gap, written, cause),
    cost as token counts by WEIGHTS key, last as (timestamp, context) when the transcript ends on a
    reply that ended the turn, else None."""
    seen = set()
    turns = 0
    misses = []
    cost = dict.fromkeys(WEIGHTS, 0)
    last = None
    last_reply = None   # timestamp of the latest assistant entry
    last_other = None   # timestamp of the latest other entry, the result that starts a turn
    tool = None         # the latest tool_use: (name, Bash command)
    resumed = False     # a user message since the latest assistant entry
    ended = False       # the latest assistant entry ended the turn: only a message starts the next
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
            last = None
            if entry.get('type') == 'user' and started_by_user(entry):
                resumed = True
            continue
        message = entry.get('message', {})
        usage = message.get('usage') or {}
        if message.get('id') not in seen and usage and message.get('model') != '<synthetic>':
            seen.add(message.get('id'))
            written = usage.get('cache_creation_input_tokens') or 0
            read = usage.get('cache_read_input_tokens') or 0
            short = (usage.get('cache_creation') or {}).get('ephemeral_5m_input_tokens') or 0
            cost['reads'] += read
            cost['writes_5m'] += min(short, written)
            cost['writes_1h'] += written - min(short, written)
            cost['uncached'] += usage.get('input_tokens') or 0
            cost['output'] += usage.get('output_tokens') or 0
            if turns and written > MIN_WRITE and written > read:
                gap = None
                if last_reply is not None and last_other is not None and last_other >= last_reply:
                    gap = last_other - last_reply
                cause = 'resume' if resumed or ended or tool is None else cause_of(tool)
                misses.append((stamp, gap, written, cause))
            turns += 1
        for block in message.get('content') or []:
            if isinstance(block, dict) and block.get('type') == 'tool_use':
                tool = (block.get('name'), (block.get('input') or {}).get('command') or '')
        last_reply = when(stamp)
        resumed = False
        ended = message.get('stop_reason') == 'end_turn'
        if ended:
            last = (when(stamp), sum(usage.get(k) or 0 for k in
                                     ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')))
        elif message.get('stop_reason'):
            last = None
    return turns, misses, cost, last


def worker_meta(path):
    """The transcript's `.meta.json` as a dict, or {} when it is missing or unreadable."""
    try:
        meta = json.loads(path.with_suffix('.meta.json').read_text())
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) else {}


def cost_line(cost):
    weighed = {'reads': cost['reads'] * WEIGHTS['reads'],
               'writes': cost['writes_1h'] * WEIGHTS['writes_1h'] + cost['writes_5m'] * WEIGHTS['writes_5m'],
               'uncached': cost['uncached'] * WEIGHTS['uncached'],
               'output': cost['output'] * WEIGHTS['output']}
    total = sum(weighed.values()) or 1
    shares = ', '.join(f'{k} {round(100 * v / total)}%' for k, v in weighed.items())
    return (f"cost: reads {cost['reads']}, writes {cost['writes_1h'] + cost['writes_5m']}, "
            f"uncached {cost['uncached']}, output {cost['output']} tokens; {shares}")


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--since', type=date.fromisoformat, default=date.today())
    parser.add_argument('--projects', type=Path, default=Path.home() / '.claude' / 'projects')
    parser.add_argument('--session', type=lambda v: v if re.fullmatch(r'[A-Za-z0-9_-]+', v)
                        else parser.error(f'--session: not a session id: {v!r}'))
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--idle', type=int, metavar='MINUTES')
    args = parser.parse_args(argv)
    floor = datetime.combine(args.since, datetime.min.time()).timestamp()
    paths = sorted(p for p in args.projects.glob(f'*/{args.session or "*"}/subagents/*.jsonl') if p.stat().st_mtime >= floor)
    total_turns = 0
    rows = []
    total_cost = dict.fromkeys(WEIGHTS, 0)
    idle = []
    now = time.time()
    for path in paths:
        turns, misses, cost, last = scan(path)
        total_turns += turns
        rows += [(path, *miss) for miss in misses]
        for key in total_cost:
            total_cost[key] += cost[key]
        if args.idle is not None and last and now - last[0] >= 60 * args.idle:
            meta = worker_meta(path)
            depth = meta.get('spawnDepth')
            if not (isinstance(depth, int) and depth > 1):
                idle.append((now - last[0], path.stem, last[1], str(meta.get('description') or '-')))
    blocks = [r for r in rows if r[4] != 'resume']
    print(f'cache-misses: {len(rows)} miss turns of {total_turns} in {len(paths)} subagent transcripts, '
          f'{sum(r[3] for r in rows)} tokens written; {len(blocks)} after a block')
    print(cost_line(total_cost))
    for cause in sorted({r[4] for r in rows}, key=lambda c: -sum(r[3] for r in rows if r[4] == c)):
        mine = [r for r in rows if r[4] == cause]
        gaps = [round(r[2]) for r in mine if r[2] is not None]
        span = f'{min(gaps)}-{max(gaps)} s' if gaps else 'unknown'
        print(f'  {cause}: {len(mine)} turns, {sum(r[3] for r in mine)} tokens, gaps {span}')
    if args.list:
        for path, stamp, gap, written, cause in rows:
            shown = 'unknown' if gap is None else round(gap)
            print(f'{path} {stamp} gap={shown} written={written} {cause}')
    for age, agent, context, description in sorted(idle, reverse=True):
        print(f'idle {round(age / 60)}m {agent} context={context} {description}')
    return 1 if blocks else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
