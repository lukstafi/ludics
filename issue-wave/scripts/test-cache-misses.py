#!/usr/bin/env python3
"""cache-misses.py over fixture transcripts: what counts as a miss, its cause, and the exit code."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('cache-misses.py')


def stamp(seconds):
    return f'2026-10-17T{12 + seconds // 3600}:{seconds // 60 % 60:02d}:{seconds % 60:02d}.000Z'


def reply(at, mid, read, written, tool=None, command='', stop=None, output=0, short=None):
    content = [{'type': 'text', 'text': 'ok'}]
    if tool:
        content.append({'type': 'tool_use', 'id': f'tu-{mid}', 'name': tool, 'input': {'command': command}})
    usage = {'input_tokens': 2, 'cache_read_input_tokens': read, 'cache_creation_input_tokens': written,
             'output_tokens': output}
    if short is not None:
        usage['cache_creation'] = {'ephemeral_5m_input_tokens': short, 'ephemeral_1h_input_tokens': written - short}
    message = {'id': mid, 'model': 'claude-opus-5-5', 'content': content, 'usage': usage}
    if stop:
        message['stop_reason'] = stop
    return {'type': 'assistant', 'timestamp': stamp(at) if isinstance(at, int) else at, 'message': message}


def result(at):
    return {'type': 'user', 'timestamp': stamp(at),
            'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'x', 'content': 'RUNNING'}]}}


def message(at, text, meta=False):
    entry = {'type': 'user', 'timestamp': stamp(at), 'message': {'role': 'user', 'content': text}}
    if meta:
        entry['isMeta'] = True
    return entry


def boundary(at, precomputed, before=250000, after=13000):
    meta = {'trigger': 'auto', 'preTokens': before, 'postTokens': after}
    if precomputed:
        meta['precomputed'] = True
    return {'type': 'system', 'subtype': 'compact_boundary', 'timestamp': stamp(at), 'compactMetadata': meta}


class CacheMisses(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def transcript(self, name, entries, subdir='subagents', session='session'):
        path = self.root / 'proj' / session / subdir / f'{name}.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(e) + '\n' for e in entries))
        return path

    def run_report(self, *extra):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--projects', str(self.root),
                               '--since', '2000-01-01', *extra], capture_output=True, text=True)
        return done.returncode, done.stdout

    def test_a_long_block_is_a_miss_put_down_to_its_tool(self):
        self.transcript('agent-a', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 40000, 'Bash', '~/.claude/skills/issue-wave/scripts/bg-run.sh wait /x/run-1'),
            result(541),
            reply(545, 'm2', 0, 41000, 'Bash', 'fleet-worker.sh execution slot -- dune test'),
            result(600),
            reply(602, 'm3', 41000, 300),
        ])
        rc, out = self.run_report('--list')
        self.assertEqual(rc, 1, out)
        self.assertIn('cache-misses: 1 miss turns of 3 in 1 subagent transcripts, 41000 tokens written; '
                      '1 after a block', out)
        self.assertIn('  bg-run wait: 1 turns, 41000 tokens, gaps 540-540 s', out)
        self.assertRegex(out, r'agent-a\.jsonl 2026-10-17T12:09:05\.000Z gap=540 written=41000 bg-run wait')

    def test_the_first_turn_a_warm_turn_and_a_small_write_are_no_miss(self):
        self.transcript('agent-b', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 40000, 'Bash', 'bg-run.sh wait /x/run-1'),
            result(241),
            reply(242, 'm2', 40000, 500, 'Bash', 'ls'),
            result(250),
            reply(251, 'm3', 40500, 9000, 'Read'),
            result(900),
            reply(901, 'm4', 100, 1500),
        ])
        rc, out = self.run_report()
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.splitlines()[0], 'cache-misses: 0 miss turns of 4 in 1 subagent transcripts, '
                                              '0 tokens written; 0 after a block')

    def test_a_resume_is_reported_but_does_not_alert(self):
        self.transcript('agent-c', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 40000, 'SubagentHandback'),
            result(2),
            message(1200, 'EXECUTION_ASSIGNED w-1'),
            reply(1201, 'm2', 0, 40500, 'Bash', 'echo'),
            result(1202),
            reply(1203, 'm3', 0, 40600),
        ])
        rc, out = self.run_report()
        self.assertEqual(rc, 1, out)
        self.assertIn('  resume: 1 turns, 40500 tokens', out)
        self.assertIn('  bash: 1 turns, 40600 tokens, gaps 1-1 s', out)
        self.transcript('agent-c', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 40000, 'Bash', 'bg-run.sh wait /x/run-1'),
            result(240),
            message(1200, 'go on'),
            reply(1201, 'm2', 0, 40500),
        ])
        rc, out = self.run_report()
        self.assertEqual(rc, 0, out)
        self.assertIn('1 miss turns of 2 in 1 subagent transcripts, 40500 tokens written; 0 after a block', out)

    def test_a_streamed_message_counts_once_and_main_sessions_are_not_read(self):
        long_wait = reply(1, 'm1', 0, 40000, 'Bash', 'bg-run.sh wait /x/run-1')
        self.transcript('agent-d', [message(0, 'brief'), long_wait, result(400),
                                    reply(401, 'm2', 0, 40000), reply(402, 'm2', 0, 40000, 'Bash', 'ls')])
        main = self.root / 'proj' / 'main.jsonl'
        main.write_text(json.dumps(reply(1, 'x', 0, 40000)) + '\n' + json.dumps(reply(9000, 'y', 0, 40000)) + '\n')
        rc, out = self.run_report()
        self.assertEqual(rc, 1, out)
        self.assertIn('cache-misses: 1 miss turns of 2 in 1 subagent transcripts', out)

    def test_since_skips_older_transcripts(self):
        path = self.transcript('agent-e', [message(0, 'brief'), reply(1, 'm1', 0, 40000, 'Bash', 'x'),
                                           result(400), reply(401, 'm2', 0, 40000)])
        os.utime(path, (946684800, 946684800))  # 2000-01-01
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--projects', str(self.root),
                               '--since', '2026-10-01'], capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stdout),
                         (0, 'cache-misses: 0 miss turns of 0 in 0 subagent transcripts, 0 tokens written; '
                             '0 after a block\ncost: reads 0, writes 0, uncached 0, output 0 tokens; '
                             'reads 0%, writes 0%, uncached 0%, output 0%\n'
                             'compactions: 0 (0 precomputed), 0 tokens before, 0 after\n'))

    def test_a_message_to_a_worker_whose_turn_ended_is_a_resume(self):
        # The runtime delivers SendMessage as a meta entry; the worker's last tool was a Bash wait.
        self.transcript('agent-f', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 40000, 'Bash', 'bg-run.sh wait /x/run-1'),
            result(300),
            reply(301, 'm2', 40000, 100, stop='end_turn'),
            message(3000, 'The coordinator sent a message while you were working:\nEXECUTION_CONCLUDED w-1 pass',
                    meta=True),
            reply(3001, 'm3', 0, 40200, 'Bash', 'ls'),
        ])
        rc, out = self.run_report()
        self.assertEqual(rc, 0, out)
        self.assertIn('  resume: 1 turns, 40200 tokens, gaps 2699-2699 s', out)

    def test_the_cost_line_weighs_each_kind_by_its_price(self):
        # reads 1e6 x 0.1 = 100000; writes 20000 at 1h x 2 + 40000 at 5m x 1.25 = 90000;
        # uncached 2 x 2 = 4; output 2000 x 5 = 10000: 200004 in all.
        self.transcript('agent-g', [
            message(0, 'brief'),
            reply(1, 'm1', 500000, 40000, 'Bash', 'ls', output=1000, short=40000),
            result(2),
            reply(3, 'm2', 500000, 20000, output=400),
            reply(4, 'm2', 500000, 20000, output=1000),  # the same message streamed: its latest record counts
        ])
        rc, out = self.run_report()
        self.assertEqual(out.splitlines()[1], 'cost: reads 1000000, writes 60000, uncached 4, output 2000 tokens; '
                                              'reads 50%, writes 45%, uncached 0%, output 5%')

    def test_session_reads_only_that_sessions_workers(self):
        for session in ('mine', 'other'):
            self.transcript('agent-h', [message(0, 'brief'), reply(1, 'm1', 0, 40000, 'Bash', 'x'),
                                        result(400), reply(401, 'm2', 0, 40000)], session=session)
        rc, out = self.run_report('--session', 'mine')
        self.assertIn('1 miss turns of 2 in 1 subagent transcripts', out)
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--session', '../x'], capture_output=True, text=True)
        self.assertEqual(done.returncode, 2, done.stderr)

    def test_a_compaction_is_counted_and_the_turn_after_it_is_no_miss(self):
        # The precomputed summary's own entry is stamped when it was written, before the boundary.
        summary = message(3300, 'This session is being continued from a previous conversation.')
        self.transcript('agent-i', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 250000, 'Bash', 'ls'),
            result(2),
            reply(3, 'm2', 250000, 500, stop='end_turn'),
            message(4000, 'The coordinator sent a message while you were working:\nEXECUTION_CONCLUDED w-1 pass',
                    meta=True),
            boundary(4000, precomputed=True), summary,
            reply(4002, 'm3', 0, 13500, 'Bash', 'ls'),
            result(4003),
            reply(4004, 'm4', 13500, 200),
        ])
        self.transcript('agent-j', [message(0, 'brief'), reply(1, 'm1', 0, 900000, 'Read'), result(2),
                                    boundary(3, precomputed=False, before=960000, after=9000),
                                    reply(4, 'm2', 0, 9500)])
        rc, out = self.run_report('--list')
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.splitlines()[0], 'cache-misses: 0 miss turns of 6 in 2 subagent transcripts, '
                                              '0 tokens written; 0 after a block')
        self.assertEqual(out.splitlines()[2], 'compactions: 2 (1 precomputed), 1210000 tokens before, 22000 after')
        self.assertRegex(out, r'agent-i\.jsonl 2026-10-17T13:06:40\.000Z compaction trigger=auto precomputed=yes '
                              r'before=250000 after=13000')
        self.assertRegex(out, r'agent-j\.jsonl \S+ compaction trigger=auto precomputed=no before=960000 after=9000')

    def test_a_resume_past_the_hour_without_a_compaction_is_a_miss(self):
        self.transcript('agent-k', [
            message(0, 'brief'),
            reply(1, 'm1', 0, 250000, 'Bash', 'ls'),
            result(2),
            reply(3, 'm2', 250000, 500, stop='end_turn'),
            message(3900, 'go on'),
            reply(3901, 'm3', 0, 250600),
        ])
        rc, out = self.run_report()
        self.assertEqual(rc, 0, out)
        self.assertIn('  resume: 1 turns, 250600 tokens, gaps 3897-3897 s', out)
        self.assertIn('compactions: 0 (0 precomputed)', out)

    def test_a_bad_date_is_a_usage_error(self):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--since', 'yesterday'],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2, done.stderr)


if __name__ == '__main__':
    unittest.main()
