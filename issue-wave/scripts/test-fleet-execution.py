#!/usr/bin/env python3
"""Exercise the actual shell/anchor transitions without SSH or real fleet state."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SCRIPT = Path(__file__).with_name('fleet-worker.sh')
# The execution registry the anchor runs, wherever this checkout keeps it: the v2 package module
# once fleet-execution.py is folded into lib/ludics (ludics-lite#403), else the standalone helper.
# The in-process cases below load it with runpy and drive it by its positional argv, which the fold
# keeps; neither path existing fails them loudly, never silently. It runs under THIS interpreter,
# not a bare `python3`, since the package module needs Python >= 3.12.
CHECKOUT = SCRIPT.resolve().parents[2]
PACKAGED_REGISTRY = CHECKOUT / 'lib' / 'ludics' / 'fleetworker' / 'registry.py'
REGISTRY = PACKAGED_REGISTRY if PACKAGED_REGISTRY.exists() else SCRIPT.with_name('fleet-execution.py')
# A measurement on a lab box probes that box's lane lock (ludics-lite#445), and the real endpoint
# map makes `rog` and `rog-nv-linux` lab boxes, so no case may reach the real lab's lock directory:
# every subprocess below inherits this one.
LAB_LOCKS = tempfile.TemporaryDirectory(prefix='fleet-lab-locks-')
os.environ['WAKE_LAB_LOCK_DIR'] = LAB_LOCKS.name
# Before it reads that lock, it verifies the anchor is the lab host and has a wake-lab site file
# (ludics-lite#454). Every fixture anchor below is `local` on the box `fixture`, declared here as the
# lab host, and the site file is a fixture's too: no case may read the real one.
LAB_SITE = Path(LAB_LOCKS.name) / 'hosts.sh'
LAB_SITE.write_text('# wake-lab site file fixture: never sourced by the registry\n')
os.environ['WAKE_LAB_HOSTS'] = str(LAB_SITE)
os.environ['FLEET_LAB_HOST'] = 'fixture'
# A dispatch to another box refreshes that box's skills checkout over ssh (ludics-lite#362), and the
# fixture rosters name real fleet aliases (`rog`, `mac`): no case may reach a real box. Every
# subprocess below inherits this PATH, whose `ssh` answers as a box that never answered (255, ssh's
# own transport failure) and logs what it was asked, so the refresh is still exercised up to the
# wire and read as REFRESH UNREACHABLE, never run.
SSH_SHIM = tempfile.TemporaryDirectory(prefix='fleet-ssh-shim-')
SSH_LOG = Path(SSH_SHIM.name) / 'calls'
(Path(SSH_SHIM.name) / 'ssh').write_text(
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SSH_SHIM_LOG"\ncat > /dev/null\n'
    'echo "ssh: shim: no real box is reached from this suite" >&2\nexit 255\n')
(Path(SSH_SHIM.name) / 'ssh').chmod(0o755)
os.environ['SSH_SHIM_LOG'] = str(SSH_LOG)
# Every observed_sha a payload names is checked on GitHub before the anchor is asked (ludics-lite
# #561), and the fixtures name made-up SHAs in a made-up `owner/repo`: no case may ask the real
# GitHub. This `gh` answers that one call as GitHub does for a commit it has (the SHA back) and
# refuses any other; test-fleet-worker.sh exercises the refusals.
(Path(SSH_SHIM.name) / 'gh').write_text(
    '#!/bin/sh\ncase "$*" in "api --hostname github.com repos/"*/*"/commits/"*" -q .sha")\n'
    '  p=$4; echo "${p##*/}"; exit 0 ;; esac\necho "gh shim: unexpected call: $*" >&2\nexit 2\n')
(Path(SSH_SHIM.name) / 'gh').chmod(0o755)
os.environ['PATH'] = SSH_SHIM.name + os.pathsep + os.environ['PATH']
with tempfile.TemporaryDirectory(prefix='fleet-execution-') as temporary:
    root = Path(temporary)
    env = {**os.environ, 'FLEET_ANCHOR': 'local', 'FLEET_LOCAL_BOX': 'fixture',
           'ISSUE_WAVE_STATE': str(root), 'FLEET_ANCHOR_STATE': str(root),
           'FLEET_COORDINATOR': 'first', 'FLEET_LOCK_WAIT': '10',
           'FLEET_BOXES': 'rog minix other another case-one case-two'}

    def run(*args, owner='first', expected=0):
        result = subprocess.run(['bash', str(SCRIPT), *args], env={**env, 'FLEET_COORDINATOR': owner},
                                text=True, capture_output=True, timeout=20)
        assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
        return result.stdout

    def change(action, data, owner='first', expected=0):
        with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input') as stream:
            json.dump(data, stream)
            stream.flush()
            return run('execution', action, stream.name, owner=owner, expected=expected)

    def request(identity, host='rog'):
        return dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                    issue='owner/repo#129', purpose='fixture', agent_host='mac', execution_host=host,
                    repository='owner/repo', requested_revision='origin/main', kind='correctness')

    def records():
        return {r['request_id']: r for r in json.loads(run('execution', 'list'))}

    run('claim')
    change('reserve', {**request('bad-triage'), 'triage_reason': True}, expected=1)
    change('reserve', {**request('premarked'), 'triage_reason': 'future triage'}, expected=1)
    assert records() == {}
    mixed_case = request('CaseJob', 'case-one')
    change('reserve', mixed_case)
    case_record = records()['CaseJob']
    case_bytes = (root / 'executions' / 'CaseJob.json').read_bytes()
    change('reserve', request('casejob', 'case-two'), expected=1)
    assert records() == {'CaseJob': case_record}
    for operation in ['dispatch', 'record', 'reconcile', 'conclude']:
        change(operation, dict(request_id='casejob', evidence='must not alias'), expected=1)
        assert (root / 'executions' / 'CaseJob.json').read_bytes() == case_bytes
    change('reserve', mixed_case)
    change('conclude', dict(request_id='CaseJob', verdict='not-launched',
                           log='/logs/case-check', evidence='fixture never dispatched'))
    assert json.loads(run('execution', 'list', '--active', '--compact')) == []
    # Host-local CLI and remote native requests contend for the same box, regardless of
    # transport/residence. The same issue can independently reserve another box.
    competitors = {
        "worker-rog": {**request("worker-rog"), "transport": "cli", "agent_host": "rog"},
        "integration-rog": request("integration-rog"),
    }
    def contend(identity):
        try:
            change('reserve', competitors[identity])
            return identity
        except AssertionError as exc:
            assert 'box owned by' in str(exc), exc
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        winners = [name for name in pool.map(contend, ['worker-rog', 'integration-rog']) if name]
    assert len(winners) == 1
    identity = winners[0]
    change('reserve', request('minix', 'minix'))
    first = records()[identity]
    assert first['request'] == competitors[identity]
    assert records()['minix']['request']['issue'] == first['request']['issue']
    loser = next(name for name in competitors if name != identity)
    change('reserve', competitors[loser], expected=1)
    assert loser not in records()
    owner_bytes = (root / 'executions' / (identity + '.json')).read_bytes()
    for alias in ['ROG', 'rog-alias']:
        change('reserve', request('wrong-host', alias), expected=1)
        assert (root / 'executions' / (identity + '.json')).read_bytes() == owner_bytes
    sibling_path = root / 'executions' / 'minix.json'
    sibling_bytes = sibling_path.read_bytes()
    # A malformed unrelated owner must block dispatch of an otherwise valid request.
    for missing in ['request', 'lease_token', 'history']:
        broken = json.loads(sibling_bytes)
        del broken[missing]
        sibling_path.write_text(json.dumps(broken))
        change('dispatch', dict(request_id=identity, evidence='must fail closed'), expected=1)
        assert json.loads((root / 'executions' / (identity + '.json')).read_text()) == first
    broken = json.loads(sibling_bytes)
    del broken['request']['execution_host']
    sibling_path.write_text(json.dumps(broken))
    change('dispatch', dict(request_id=identity, evidence='unknown sibling box'), expected=1)
    sibling_path.write_bytes(sibling_bytes)
    legacy = json.loads(sibling_bytes)
    legacy['request']['execution_host'] = 'old-minix-alias'
    sibling_path.write_text(json.dumps(legacy))
    change('dispatch', dict(request_id=identity, evidence='unknown legacy ownership'), expected=1)
    change('reconcile', dict(request_id='minix', state='reserved', evidence='legacy record remains reconcilable'))
    assert records()['minix']['request']['execution_host'] == 'old-minix-alias'
    sibling_path.write_bytes(sibling_bytes)
    change('reserve', competitors[identity])
    assert records()[identity] == first
    assert len(records()) == 3 and first['state'] == 'reserved'
    # Routine supervision needs outstanding ownership, not an ever-growing history dump.
    # Exercise the public shell path and retain default list's full audit records.
    ledger_before = {p.name: p.read_bytes() for p in (root / 'executions').glob('*.json')}
    full = json.loads(run('execution', 'list', owner='reader'))
    active = json.loads(run('execution', 'list', '--active', owner='reader'))
    assert {r['request_id'] for r in active} == {identity, 'minix'}
    compact = json.loads(run('execution', 'list', '--compact', owner='reader'))
    assert compact == [{k: v for k, v in r.items() if k not in {'history', 'lease_token'}}
                       for r in full]
    active_compact = json.loads(run('execution', 'list', '--active', '--compact'))
    assert active_compact == [r for r in compact if r['state'] != 'concluded']
    assert json.loads(run('execution', 'list', '--compact', '--active')) == active_compact
    assert all('history' in r and 'lease_token' in r for r in full)
    run('execution', 'list', '--actve', expected=2)
    assert ledger_before == {p.name: p.read_bytes() for p in (root / 'executions').glob('*.json')}
    # Filtering a terminal record must not hide corruption from the reader.
    terminal_path = root / 'executions' / 'CaseJob.json'
    broken = json.loads(terminal_path.read_bytes())
    del broken['history']
    terminal_path.write_text(json.dumps(broken))
    run('execution', 'list', '--active', '--compact', expected=1)
    terminal_path.write_bytes(ledger_before['CaseJob.json'])
    change('reserve', {**request(identity), 'purpose': 'different'}, expected=1)
    change('dispatch', dict(request_id=identity, evidence='about to invoke runner'))
    change('dispatch', dict(request_id=identity, evidence='blind retry'), expected=1)
    change('record', dict(request_id=identity, state='uncertain', evidence='SSH disconnected'))
    change('reserve', request('conflict'), expected=1)
    run('claim', '--take', owner='second')
    change('record', dict(request_id=identity, state='running', evidence='stale writer'), expected=1)
    assert records()[identity]['state'] == 'uncertain'
    change('dispatch', dict(request_id='minix', evidence='new coordinator'), owner='second', expected=1)
    change('reconcile', dict(request_id='minix', state='reserved', evidence='runner ledger proves no launch'), owner='second')
    for state in ['running', 'uncertain']:
        change('record', dict(request_id='minix', state=state, evidence='no dispatch'), owner='second', expected=1)
    change('reconcile', dict(request_id='minix', state='uncertain', evidence='prelaunch outcome unclear'), owner='second')
    change('reconcile', dict(request_id='minix', state='reserved', evidence='runner ledger proves no launch'), owner='second')
    run('halt', 'regression triage', owner='second')
    change('dispatch', dict(request_id='minix', evidence='ordinary halted'), owner='second', expected=1)
    change('reserve', request('halted', 'other'), owner='second', expected=1)
    triage = {**request('triage', 'other'), 'triage_reason': 'named regression verification'}
    change('reserve', triage, owner='second')
    change('reserve', {**request('second-triage', 'another'), 'triage_reason': 'another'}, owner='second', expected=1)
    old_halt = records()['triage']['halt_identity']
    run('halt', 'updated regression reason', owner='second')
    assert old_halt in (root / 'HALT').read_text()
    change('reserve', {**request('reason-update-triage', 'another'), 'triage_reason': 'second slot'}, owner='second', expected=1)
    run('claim', '--take', owner='third')
    run('halt', 'adopted regression reason', owner='third')
    assert old_halt in (root / 'HALT').read_text()
    change('reconcile', dict(request_id='triage', state='reserved', evidence='adopter verified no launch'), owner='third')
    change('dispatch', dict(request_id='triage', evidence='same generation after adoption'), owner='third')
    # No runner was invoked by this fixture: reset through explicit evidence reconciliation.
    change('reconcile', dict(request_id='triage', state='reserved', evidence='fixture never invoked runner'), owner='third')
    run('claim', '--take', owner='second')
    change('reconcile', dict(request_id='triage', state='reserved', evidence='ownership returned; no runner'), owner='second')
    run('resume-launches', owner='second')
    change('dispatch', dict(request_id='triage', evidence='ended halt'), owner='second', expected=1)
    # Identical reasons, even within one second, still create distinct halt generations.
    run('halt', 'regression triage', owner='second')
    change('dispatch', dict(request_id='triage', evidence='stale exception'), owner='second', expected=1)
    change('reserve', {**request('occupied-old-box', 'other'), 'triage_reason': 'new halt'}, owner='second', expected=1)
    new_triage = {**request('current-triage', 'another'), 'triage_reason': 'current regression'}
    change('reserve', new_triage, owner='second')
    assert records()['current-triage']['halt_identity'] != old_halt
    change('dispatch', dict(request_id='current-triage', evidence='current triage runner invocation'), owner='second')
    change('conclude', dict(request_id=identity, verdict='pass', evidence='worker handed back', log='worker.log'), owner='second', expected=1)
    for verdict in ['pass', 'fail', 'timeout', 'cancelled']:
        name = identity if verdict == 'pass' else verdict
        if verdict != 'pass':
            run('resume-launches', owner='second')
            change('reserve', request(name), owner='second')
            change('dispatch', dict(request_id=name, evidence='runner starting'), owner='second')
        result = dict(request_id=name, verdict=verdict, evidence='runner terminal record; process stopped',
                      log='/logs/' + name, observed_sha='a'*40, remote_checkout='/work/' + name,
                      handle='runner-' + name)
        change('conclude', result, owner='second')
        change('conclude', result, owner='second')
        assert records()[name]['verdict'] == verdict
        assert records()[name]['log'] == '/logs/' + name
    change('conclude', dict(request_id='minix', verdict='not-launched', log='/logs/reconciliation',
                            evidence='verified invocation never began'), owner='second')
    change('record', dict(request_id='triage', state='uncertain', observed_sha='main', evidence='bad SHA'), owner='second', expected=1)
    # Real durable records survive ownership change; no timeout or worker status frees them.
    assert records()['triage']['state'] == 'reserved'
    assert records()['current-triage']['state'] == 'launching'
    print('PASS: conflicts, independent boxes, idempotency, adoption, halt, uncertainty and terminal evidence')

# `execution run` (reserve + dispatch under one lock) and per-box correctness slots
# (ludics-lite#157): measurement stays exclusive, correctness shares up to the box's slots.
with tempfile.TemporaryDirectory(prefix='fleet-slots-') as temporary:
    root = Path(temporary)
    env = {**os.environ, 'FLEET_ANCHOR': 'local', 'FLEET_LOCAL_BOX': 'fixture',
           'ISSUE_WAVE_STATE': str(root), 'FLEET_ANCHOR_STATE': str(root),
           'FLEET_COORDINATOR': 'first', 'FLEET_LOCK_WAIT': '10',
           'FLEET_BOXES': 'mac rog minix', 'FLEET_BOX_CORRECTNESS_SLOTS': 'mac=3 rog=1'}

    def run(*args, expected=0, **extra):
        result = subprocess.run(['bash', str(SCRIPT), *args], env={**env, **extra},
                                text=True, capture_output=True, timeout=20)
        assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
        return result.stdout + result.stderr

    def change(action, data, expected=0, **extra):
        with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input') as stream:
            json.dump(data, stream)
            stream.flush()
            return run('execution', action, stream.name, expected=expected, **extra)

    def request(identity, host='mac', kind='correctness'):
        return dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                    issue='owner/repo#157', purpose='fixture', agent_host='mac', execution_host=host,
                    repository='owner/repo', requested_revision='origin/main', kind=kind)

    def records():
        return {r['request_id']: r for r in json.loads(run('execution', 'list'))}

    run('claim')
    # run: one call leaves the record dispatched, with both steps in its history.
    change('run', {**request('run-1'), 'evidence': 'invoking the runner now'})
    first = records()['run-1']
    assert first['state'] == 'launching', first
    # ...and the refresh after it reached for the execution host through the suite's ssh shim alone.
    assert ' mac bash -s -- ' in SSH_LOG.read_text(), SSH_LOG.read_text() if SSH_LOG.exists() else 'no ssh call'
    assert [e['action'] for e in first['history']] == ['reserve', 'dispatch'], first['history']
    assert first['history'][1]['data'] == {'request_id': 'run-1', 'evidence': 'invoking the runner now'}
    assert first['request'] == request('run-1'), first['request']
    # A repeated run never repeats a launch, and a changed request is a different assignment.
    out = change('run', request('run-1'), expected=1)
    assert 'already dispatched' in out, out
    out = change('run', {**request('run-1'), 'purpose': 'other'}, expected=1)
    assert 'different assignment' in out, out
    assert records()['run-1'] == first
    out = change('run', {**request('run-bad'), 'evidence': ''}, expected=1)
    assert 'evidence' in out and 'run-bad' not in records(), out
    # run on a plain reservation dispatches it; the default dispatch evidence names the step.
    change('reserve', request('run-2'))
    change('run', request('run-2'))
    second = records()['run-2']
    assert second['state'] == 'launching' and [e['action'] for e in second['history']] == ['reserve', 'dispatch']
    assert 'execution run' in second['history'][1]['data']['evidence']
    # Three correctness slots on mac: the third fits, the fourth is refused naming the owners.
    change('run', request('run-3'))
    out = change('run', request('run-4'), expected=1)
    assert 'box owned by' in out and 'correctness slots 3/3 on mac' in out, out
    assert 'run-4' not in records()
    # A standing iteration record (ludics-lite#160) is ownership and evidence, not a running
    # batch: it is admitted past a full box and never fills a slot itself. The slots are taken
    # at run time instead, by `fleet-worker.sh execution slot` around each batch.
    change('run', {**request('iterate-4'), 'standing': True, 'checkout': '/wt/iterate-4'})
    assert records()['iterate-4']['request']['standing'] is True
    out = change('run', request('run-4b'), expected=1)
    assert 'correctness slots 3/3 on mac' in out, out
    assert 'run-4b' not in records()
    change('run', {**request('iterate-5'), 'standing': True, 'checkout': '/wt/iterate-5'})
    # It names its worker's checkout (ludics-lite#731), kept beside the request, never in it.
    assert records()['iterate-5']['checkout'] == '/wt/iterate-5' and 'checkout' not in records()['iterate-5']['request']
    out = change('run', {**request('iterate-6'), 'standing': True}, expected=1)
    assert 'a standing reservation must name its checkout' in out and 'iterate-6' not in records(), out
    # It is loud, not read off the `-iterate` id convention: only `true`, only on correctness.
    out = change('run', {**request('standing-bad'), 'standing': 'yes'}, expected=1)
    assert 'standing must be true when present' in out and 'standing-bad' not in records(), out
    out = change('run', {**request('standing-measure', 'minix', kind='measurement'), 'standing': True}, expected=1)
    assert 'only a correctness reservation can be standing' in out, out
    # An integration run (ludics-lite#401) is a claim the base gate acts on: only `true`, and only
    # on a coordinator's non-standing correctness request. (Its admission and the gate reading it
    # are exercised end to end in test-fleet-worker.sh.)
    coordinator = {**request('integ-bad'), 'transport': 'coordinator'}
    out = change('run', {**coordinator, 'integration': 'yes'}, expected=1)
    assert 'integration must be true when present' in out and 'integ-bad' not in records(), out
    for bad in ({**request('integ-bad'), 'integration': True},
                {**coordinator, 'kind': 'measurement', 'execution_host': 'minix', 'integration': True},
                {**coordinator, 'standing': True, 'integration': True}):
        out = change('run', bad, expected=1)
        assert "only a coordinator's non-standing correctness reservation can be an integration run" in out, out
        assert 'integ-bad' not in records(), out
    change('conclude', dict(request_id='iterate-4', verdict='not-launched', log='/logs/iterate-4',
                            evidence='fixture concluded the standing record at hand-back'))
    change('conclude', dict(request_id='iterate-5', verdict='not-launched', log='/logs/iterate-5',
                            evidence='fixture concluded the standing record at hand-back'))
    # Measurement needs the box to itself, and holds it exclusively once it has it.
    out = change('reserve', request('measure-mac', kind='measurement'), expected=1)
    assert 'measurement needs mac to itself' in out, out
    change('reserve', request('measure-minix', 'minix', kind='measurement'))
    out = change('reserve', request('check-minix', 'minix'), expected=1)
    assert 'a measurement holds minix exclusively' in out, out
    out = change('reserve', request('measure-minix-2', 'minix', kind='measurement'), expected=1)
    assert 'measurement needs minix to itself' in out, out
    # rog has one slot: the second correctness request is refused as before.
    change('reserve', request('check-rog', 'rog'))
    out = change('reserve', request('check-rog-2', 'rog'), expected=1)
    assert 'box owned by' in out and 'correctness slots 1/1 on rog' in out, out
    # An unnamed box has one slot; a malformed spec or one naming a box outside the roster is refused.
    change('reserve', request('lone-rog', 'rog'), expected=1)
    out = change('reserve', request('spec-bad', 'minix'), expected=1, FLEET_BOX_CORRECTNESS_SLOTS='mac=x')
    assert '<box>=<positive n>' in out, out
    out = change('reserve', request('spec-bad', 'minix'), expected=1, FLEET_BOX_CORRECTNESS_SLOTS='other=2')
    assert 'not in FLEET_BOXES' in out, out
    # Evidence naming a box binds to the reserved one, and the binding leaves no field in the record.
    terminal = dict(request_id='run-1', verdict='pass', evidence='runner terminal record; process stopped',
                    log='/logs/run-1', observed_sha='b' * 40, remote_checkout='/work/run-1', handle='runner-run-1')
    out = change('conclude', {**terminal, 'execution_host': 'rog'}, expected=1)
    assert 'evidence from rog cannot conclude an assignment reserved on mac' in out, out
    out = change('conclude', {**terminal, 'execution_host': ''}, expected=1)
    assert records()['run-1']['state'] == 'launching'
    # A concluded correctness run frees its slot.
    change('conclude', {**terminal, 'execution_host': 'mac'})
    assert 'execution_host' not in records()['run-1']['history'][-1]['data']
    change('conclude', terminal)   # the identical retry, without the binding, is still harmless
    change('run', request('run-4'))
    assert records()['run-4']['state'] == 'launching'
    # Under a halt an ordinary run is refused whole (nothing reserved), the named triage run dispatches.
    change('conclude', dict(request_id='measure-minix', verdict='not-launched', log='/logs/measure',
                            evidence='fixture never dispatched'))
    run('halt', 'regression triage')
    out = change('run', request('halted-run', 'minix'), expected=1)
    assert 'fleet halted' in out and 'halted-run' not in records(), out
    change('run', {**request('triage-run', 'minix'), 'triage_reason': 'named regression verification'})
    triage = records()['triage-run']
    assert triage['state'] == 'launching' and triage['halt_identity'], triage
    run('resume-launches')
    print('PASS: execution run, correctness slots, standing records, exclusive measurement, halt')

# One roster entry per physical box (ludics-lite#395): wake-lab.sh's endpoint map says which ssh
# aliases are one box, and a roster naming two of them is refused before it can split a
# measurement's exclusivity. Reads and conclusions stay available under such a roster.
import shutil


def one_entry_per_box():
    # A function, so its env and request helpers do not replace the module-level ones below.
    with tempfile.TemporaryDirectory(prefix='fleet-one-box-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'FLEET_ANCHOR': 'local', 'FLEET_LOCAL_BOX': 'fixture',
               'ISSUE_WAVE_STATE': str(root), 'FLEET_ANCHOR_STATE': str(root),
               'FLEET_COORDINATOR': 'first', 'FLEET_LOCK_WAIT': '10'}
        env.pop('FLEET_BOXES', None)
        env.pop('FLEET_BOX_CORRECTNESS_SLOTS', None)

        def run(*args, expected=0, script=SCRIPT, **extra):
            result = subprocess.run(['bash', str(script), *args], env={**env, **extra},
                                    text=True, capture_output=True, timeout=20)
            assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
            return result.stdout, result.stderr

        def change(action, data, expected=0, script=SCRIPT, **extra):
            with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input') as stream:
                json.dump(data, stream)
                stream.flush()
                return run('execution', action, stream.name, expected=expected, script=script, **extra)

        def request(identity, host, kind='measurement'):
            return dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                        issue='owner/repo#395', purpose='fixture', agent_host='mac', execution_host=host,
                        repository='owner/repo', requested_revision='origin/main', kind=kind)

        def records():
            return {r['request_id']: r for r in json.loads(run('execution', 'list')[0])}

        run('claim')
        # The default roster, unset and exported alike, keeps passing, with no warning.
        out, err = change('reserve', request('measure-rog', 'rog-nv-linux'))
        assert 'WARNING' not in err, err
        out, err = change('reserve', request('measure-minix', 'minix-amd-linux'),
                          FLEET_BOXES='mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux')
        assert 'WARNING' not in err, err
        # Two aliases of rog: the refusal names both entries and the box, whichever alias is asked for,
        # for reserve, run and dispatch alike, and nothing is written.
        split = 'mac-studio rog-nv-linux rog-nv-wsl minix-amd-linux'
        want = 'FLEET_BOXES lists rog-nv-linux and rog-nv-wsl, two aliases of the one box rog'
        for action, host in [('reserve', 'rog-nv-wsl'), ('run', 'rog-nv-wsl'), ('reserve', 'mac-studio')]:
            out, err = change(action, request('split-' + action + '-' + host, host), expected=1, FLEET_BOXES=split)
            assert want in err, err
        change('reserve', request('check-mac', 'mac-studio', 'correctness'))
        out, err = change('dispatch', dict(request_id='check-mac', evidence='fixture dispatch'),
                          expected=1, FLEET_BOXES=split)
        assert want in err, err
        # The Windows host and its LAN route, the box's own name, and a case variant are one box too.
        for roster, pair in [('mac-studio minix-amd-win minix-lan', 'minix-amd-win and minix-lan, two aliases of the one box minix'),
                             ('mac-studio tuf tuf-amd-linux', 'tuf and tuf-amd-linux, two aliases of the one box tuf'),
                             ('mac-studio ROG-NV-WSL rog-nv-linux', 'ROG-NV-WSL and rog-nv-linux, two aliases of the one box rog'),
                             ('mac-studio Mac-Studio', 'mac-studio and Mac-Studio, two aliases of the one box mac-studio')]:
            out, err = change('reserve', request('split-case', 'mac-studio', 'correctness'), expected=1, FLEET_BOXES=roster)
            assert pair in err, (roster, err)
        assert not [identity for identity in records() if identity.startswith('split-')], records()
        # A repeated identical entry is the same entry, not two aliases.
        change('reserve', request('check-mac', 'mac-studio', 'correctness'), FLEET_BOXES='mac-studio mac-studio rog-nv-linux minix-amd-linux')
        # Reads and conclusions stay available under the split roster.
        run('execution', 'list', FLEET_BOXES=split)
        change('conclude', dict(request_id='measure-rog', verdict='not-launched', log='/logs/rog',
                                evidence='fixture never dispatched'), FLEET_BOXES=split)
        assert records()['measure-rog']['state'] == 'concluded'
        # Reached through a skills symlink, as installed (~/.claude/skills/issue-wave -> the
        # checkout's issue-wave), the map is still found: `..` must leave the symlink's target.
        skills = root / 'skills'
        skills.mkdir()
        (skills / 'issue-wave').symlink_to(SCRIPT.resolve().parent.parent)
        out, err = change('reserve', request('linked-split', 'rog-nv-wsl'), expected=1, FLEET_BOXES=split,
                          script=skills / 'issue-wave' / 'scripts' / 'fleet-worker.sh')
        assert want in err and 'WARNING' not in err, err
        # A checkout with no wake-lab.sh degrades loudly: one warning, and the roster check keeps to
        # exact entries up to case, so the split roster is admitted as it was before #395.
        bare = root / 'bare'
        (bare / 'issue-wave' / 'scripts').mkdir(parents=True)
        # The script and what it runs: the standalone registry while there is one, and the
        # interpreter wrapper and package a ported subcommand forwards to (ludics-lite#403).
        for name in ['fleet-worker.sh', 'fleet-execution.py']:
            if SCRIPT.with_name(name).exists():
                shutil.copy(SCRIPT.with_name(name), bare / 'issue-wave' / 'scripts' / name)
        (bare / 'scripts').mkdir()
        shutil.copy(CHECKOUT / 'scripts' / 'py', bare / 'scripts' / 'py')
        shutil.copytree(CHECKOUT / 'lib', bare / 'lib', ignore=shutil.ignore_patterns('__pycache__'))
        copied = bare / 'issue-wave' / 'scripts' / 'fleet-worker.sh'
        with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input') as stream:
            json.dump(request('bare-wsl', 'rog-nv-wsl'), stream)
            stream.flush()
            out, err = run('execution', 'reserve', stream.name, script=copied, FLEET_BOXES=split)
            assert 'EXECUTION WARNING: no endpoint map' in err and 'wake-lab.sh is missing' in err, err
            # A wake-lab.sh that refuses its own map refuses the reservation instead.
            (bare / 'scripts' / 'wake-lab.sh').write_text('echo "wake-lab.sh: the endpoint map is inconsistent" >&2; exit 1\n')
            out, err = run('execution', 'reserve', stream.name, script=copied, expected=1,
                           FLEET_BOXES='mac-studio')
            assert 'the endpoint map is inconsistent' in err and 'endpoint-map failed' in err, err
        assert 'bare-wsl' in records()
        # The helper refuses a map naming one alias on two rows, rather than picking a box.
        with tempfile.TemporaryDirectory(prefix='fleet-map-') as state:
            result = subprocess.run([sys.executable, str(REGISTRY), state, 'reserve',
                                     'owner', 'token', json.dumps(request('bad-map', 'mac-studio')), 'mac-studio',
                                     '', 'rog rog-nv-linux\nnova rog-nv-linux'], text=True, capture_output=True)
            assert result.returncode == 1 and 'puts rog-nv-linux on both rog and nova' in result.stderr, result
        print('PASS: one roster entry per physical box, from the endpoint map; a missing map degrades loudly')


one_entry_per_box()

# ludics-lite#445: a measurement refuses a box whose lab LANE lock is held -- what a running sweep
# lane looks like, since the sweep owns no record -- at reserve, run and dispatch alike, naming the
# holder's line; and it holds that lock shared while it writes, so a lane cannot start between the
# check and the record the lane then reads.
import fcntl


def lane_lock_interlock():
    with tempfile.TemporaryDirectory(prefix='fleet-lane-lock-') as temporary:
        root = Path(temporary)
        locks = root / 'locks'
        env = {**os.environ, 'FLEET_ANCHOR': 'local', 'FLEET_LOCAL_BOX': 'fixture',
               'ISSUE_WAVE_STATE': str(root), 'FLEET_ANCHOR_STATE': str(root),
               'FLEET_COORDINATOR': 'first', 'FLEET_LOCK_WAIT': '10', 'WAKE_LAB_LOCK_DIR': str(locks),
               'FLEET_BOXES': 'mac-studio rog-nv-linux minix-amd-linux'}
        env.pop('FLEET_BOX_CORRECTNESS_SLOTS', None)

        def change(action, data, expected=0, **extra):
            with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input') as stream:
                json.dump(data, stream)
                stream.flush()
                result = subprocess.run(['bash', str(SCRIPT), 'execution', action, stream.name],
                                        env={**env, **extra}, text=True, capture_output=True, timeout=20)
            assert result.returncode == expected, (action, data, result.returncode, result.stdout, result.stderr)
            return result.stderr

        def request(identity, host, kind='measurement'):
            return dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                        issue='owner/repo#445', purpose='fixture', agent_host='mac', execution_host=host,
                        repository='owner/repo', requested_revision='origin/main', kind=kind)

        def records():
            out = subprocess.run(['bash', str(SCRIPT), 'execution', 'list'], env=env, text=True,
                                 capture_output=True, timeout=20, check=True).stdout
            return {r['request_id']: r for r in json.loads(out)}

        def lane_free(box):
            with open(locks / (box + '.lock'), 'a') as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return False
                return True

        holder = 'ocannl sweep 20260928T050000Z (pid 4242, since 20260928T050001Z)'
        want = f'rog-nv-linux is lab box rog, whose lane lock is held by {holder}'

        def hold_lane():
            locks.mkdir(exist_ok=True)
            lane = open(locks / 'rog.lock', 'a')
            fcntl.flock(lane, fcntl.LOCK_EX | fcntl.LOCK_NB)
            lane.truncate(0)
            lane.write(holder + '\n')
            lane.flush()
            return lane

        subprocess.run(['bash', str(SCRIPT), 'claim'], env=env, capture_output=True, timeout=20, check=True)
        lane = hold_lane()
        for action in ['reserve', 'run']:
            err = change(action, request('lane-' + action, 'rog-nv-linux'), expected=1)
            assert want in err, err
        # Any endpoint of the box is the box.
        err = change('reserve', request('lane-win', 'rog-nv-win'), expected=1,
                     FLEET_BOXES='mac-studio rog-nv-win minix-amd-linux')
        assert 'rog-nv-win is lab box rog, whose lane lock is held by ' + holder in err, err
        assert not [identity for identity in records() if identity.startswith('lane-')], records()
        # Only a measurement reads it: a correctness run shares the box with a lane as before, and
        # another box's measurement, or one on a host that is no lab box, is not refused.
        change('reserve', request('lane-check', 'rog-nv-linux', 'correctness'))
        change('reserve', request('measure-minix', 'minix-amd-linux'))
        change('reserve', request('measure-mac', 'mac-studio'))
        assert not (locks / 'mac-studio.lock').exists()
        lane.close()
        change('conclude', dict(request_id='lane-check', verdict='not-launched', log='/logs/check',
                                evidence='fixture never dispatched'))
        # Released, the same measurement is admitted, and the helper leaves the lock free behind it.
        change('reserve', request('lane-reserve', 'rog-nv-linux'))
        assert records()['lane-reserve']['state'] == 'reserved'
        assert lane_free('rog')
        # Dispatch rechecks, and so does the dispatch step of `run` on a reserved record.
        lane = hold_lane()
        err = change('dispatch', dict(request_id='lane-reserve', evidence='fixture dispatch'), expected=1)
        assert want in err, err
        err = change('run', request('lane-reserve', 'rog-nv-linux'), expected=1)
        assert want in err, err
        assert records()['lane-reserve']['state'] == 'reserved'
        lane.close()
        change('dispatch', dict(request_id='lane-reserve', evidence='fixture dispatch'))
        assert records()['lane-reserve']['state'] == 'launching'
    print('PASS: a measurement refuses a box whose lab lane lock is held, at reserve, run and dispatch')


lane_lock_interlock()


# ludics-lite#454: the lane lock the registry reads is in the ANCHOR's lock directory, the lab's only
# when the anchor is the machine that runs wake-lab.sh and the sweep. So a measurement on a lab box
# is refused, naming both machines, when FLEET_LAB_HOST names another box than the anchor, and
# refused, naming the path, when the anchor has no wake-lab site file -- with the lane FREE, before
# the lock is opened (no lock file appears), at reserve, run and dispatch alike.
def lab_host_identity():
    with tempfile.TemporaryDirectory(prefix='fleet-lab-host-') as temporary:
        root = Path(temporary)
        locks = root / 'locks'
        env = {**os.environ, 'FLEET_ANCHOR': 'local', 'FLEET_LOCAL_BOX': 'fixture',
               'ISSUE_WAVE_STATE': str(root), 'FLEET_ANCHOR_STATE': str(root),
               'FLEET_COORDINATOR': 'first', 'FLEET_LOCK_WAIT': '10', 'WAKE_LAB_LOCK_DIR': str(locks),
               'FLEET_BOXES': 'mac-studio rog-nv-linux minix-amd-linux'}
        env.pop('FLEET_BOX_CORRECTNESS_SLOTS', None)

        def change(action, data, expected=0, **extra):
            with tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input') as stream:
                json.dump(data, stream)
                stream.flush()
                result = subprocess.run(['bash', str(SCRIPT), 'execution', action, stream.name],
                                        env={**env, **extra}, text=True, capture_output=True, timeout=20)
            assert result.returncode == expected, (action, data, result.returncode, result.stdout, result.stderr)
            return result.stderr

        def request(identity, host, kind='measurement'):
            return dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                        issue='owner/repo#454', purpose='fixture', agent_host='mac', execution_host=host,
                        repository='owner/repo', requested_revision='origin/main', kind=kind)

        def records():
            out = subprocess.run(['bash', str(SCRIPT), 'execution', 'list'], env=env, text=True,
                                 capture_output=True, timeout=20, check=True).stdout
            return {r['request_id']: r for r in json.loads(out)}

        moved = ('rog-nv-linux is lab box rog, whose lane lock is a flock on the lab host mac-studio '
                 "(FLEET_LAB_HOST), but this registry, on the anchor fixture (FLEET_ANCHOR), reads fixture's "
                 'lock directory')
        subprocess.run(['bash', str(SCRIPT), 'claim'], env=env, capture_output=True, timeout=20, check=True)
        for action in ['reserve', 'run']:
            err = change(action, request('moved-' + action, 'rog-nv-linux'), expected=1, FLEET_LAB_HOST='mac-studio')
            assert moved in err, err
        # The default lab host is mac-studio, so an anchor elsewhere that declares nothing is refused too.
        err = change('reserve', request('moved-default', 'rog-nv-linux'), expected=1,
                     **{'FLEET_LAB_HOST': ''})
        assert moved in err, err
        assert not records() and not (locks / 'rog.lock').exists(), (records(), list(locks.glob('*')))
        # Only a measurement on a lab box asks: a correctness run there, and a measurement on a host
        # that is no lab box, are admitted under the same mismatch.
        change('reserve', request('moved-check', 'rog-nv-linux', 'correctness'), FLEET_LAB_HOST='mac-studio')
        change('reserve', request('moved-mac', 'mac-studio'), FLEET_LAB_HOST='mac-studio')
        # One name up to case is the anchor; dispatch asks again, and the record stays reserved.
        change('reserve', request('lab-minix', 'minix-amd-linux'), FLEET_LAB_HOST='FIXTURE')
        err = change('dispatch', dict(request_id='lab-minix', evidence='fixture dispatch'), expected=1,
                     FLEET_LAB_HOST='mac-studio')
        assert moved.replace('rog-nv-linux is lab box rog', 'minix-amd-linux is lab box minix') in err, err
        # Declared, but with no site file the anchor cannot be the machine that drives the lab.
        absent = root / 'no-site' / 'hosts.sh'
        err = change('dispatch', dict(request_id='lab-minix', evidence='fixture dispatch'), expected=1,
                     WAKE_LAB_HOSTS=str(absent))
        assert (f'minix-amd-linux is lab box minix, and the anchor fixture, declared the lab host, has no '
                f'readable wake-lab site file ({absent})') in err, err
        assert records()['lab-minix']['state'] == 'reserved'
        change('dispatch', dict(request_id='lab-minix', evidence='fixture dispatch'))
        assert records()['lab-minix']['state'] == 'launching'
        # A caller that passes no identity is refused rather than read as the lab host.
        with tempfile.TemporaryDirectory(prefix='fleet-lab-bare-') as state:
            result = subprocess.run([sys.executable, str(REGISTRY), state, 'reserve',
                                     'owner', 'token', json.dumps(request('bare', 'rog-nv-linux')),
                                     'rog-nv-linux', '', 'rog rog-nv-linux'], text=True, capture_output=True)
            assert result.returncode == 1 and "the anchor's and lab host's names were not passed" in result.stderr, result
    print('PASS: a lab-box measurement refuses an anchor that is not the declared lab host or has no site file')


lab_host_identity()


# ludics-lite#481: the measurement window. `execution window <box>` reserves and dispatches a
# measurement on a box whose outstanding records are all standing, suspends those (a state of their
# own, naming the window), and the measurement's conclusion restores them whatever its verdict.
def measurement_window():
    with tempfile.TemporaryDirectory(prefix='fleet-window-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'FLEET_ANCHOR': 'local', 'FLEET_LOCAL_BOX': 'fixture',
               'ISSUE_WAVE_STATE': str(root), 'FLEET_ANCHOR_STATE': str(root),
               'FLEET_COORDINATOR': 'first', 'FLEET_LOCK_WAIT': '10', 'FLEET_BOXES': 'mac rog'}
        env.pop('FLEET_BOX_CORRECTNESS_SLOTS', None)

        def run(*args, expected=0, owner='first'):
            result = subprocess.run(['bash', str(SCRIPT), *args], env={**env, 'FLEET_COORDINATOR': owner},
                                    text=True, capture_output=True, timeout=20)
            assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
            return result.stdout, result.stderr

        def payload(data):
            stream = tempfile.NamedTemporaryFile(mode='w', dir=root, suffix='.input', delete=False)
            json.dump(data, stream)
            stream.close()
            return stream.name

        def change(action, data, expected=0, owner='first'):
            return run('execution', action, payload(data), expected=expected, owner=owner)

        # --no-gap: these windows open back to back over standing records by design, and the gap a
        # window waits out after the box's last measurement (ludics-lite#667) is test-fleet-worker.sh's
        # case (THE GAP) and the registry unit tests'.
        def window(data, box='mac', expected=0, owner='first'):
            return run('execution', 'window', '--no-gap', box, payload(data), expected=expected, owner=owner)

        def request(identity, host='mac', kind='correctness', standing=False):
            data = dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                        issue='owner/repo#481', purpose='fixture', agent_host='mac', execution_host=host,
                        repository='owner/repo', requested_revision='origin/main', kind=kind)
            return {**data, 'standing': True, 'checkout': f'/wt/{identity}'} if standing else data

        def records():
            return {r['request_id']: r for r in json.loads(run('execution', 'list')[0])}

        def done(identity, verdict='pass', owner='first'):
            result = dict(request_id=identity, verdict=verdict, evidence='runner terminal record; process stopped',
                          log='/logs/' + identity)
            if verdict != 'not-launched':
                result.update(observed_sha='c' * 40, remote_checkout='/work/' + identity, handle='runner-' + identity)
            return change('conclude', result, owner=owner)

        run('claim')
        change('run', request('iterate-a', standing=True))           # launching
        change('reserve', request('iterate-b', standing=True))       # reserved
        change('run', request('iterate-rog', 'rog', standing=True))  # another box: never suspended
        # A plain measurement is still refused beside standing records, and says what opens the box.
        out, err = change('run', request('plain', kind='measurement'), expected=1)
        assert 'measurement needs mac to itself; every one is standing' in err and 'execution window' in err, err
        # The window is for a measurement, on the box it names, beside nothing but standing records.
        out, err = window(request('not-measure'), expected=1)
        assert 'kind must be measurement' in err, err
        out, err = window(request('elsewhere', 'rog', kind='measurement'), expected=1)
        assert 'the window is for mac, but the measurement names rog' in err, err
        out, err = run('execution', 'window', 'mac', expected=2)
        assert 'execution window [--no-gap] [--deadline <seconds>] <box> <measurement reserve.json>' in err, err
        change('run', request('assigned'))
        out, err = window(request('blocked', kind='measurement'), expected=1)
        assert 'request=assigned' in err and 'suspends only standing reservations' in err, err
        assert {'not-measure', 'elsewhere', 'blocked'}.isdisjoint(records())
        done('assigned')
        before = records()

        def open_window(identity, owner='first'):
            out, err = window({**request(identity, kind='measurement'), 'evidence': 'invoking the runner'}, owner=owner)
            record = json.loads(out)
            assert record['request_id'] == identity and record['window'] is True, record
            assert record['state'] == 'launching', record
            assert [e['action'] for e in record['history']] == ['reserve', 'dispatch'], record['history']
            return err

        err = open_window('window-1')
        assert 'EXECUTION WINDOW mac: window-1 open; suspended iterate-a, iterate-b' in err, err
        now = records()
        for name, former in [('iterate-a', 'launching'), ('iterate-b', 'reserved')]:
            r = now[name]
            assert (r['state'], r['suspended_by'], r['suspended_from']) == ('suspended', 'window-1', former), r
            assert r['history'][-1]['action'] == 'suspend' and r['lease_token'] == before[name]['lease_token'], r
        assert now['iterate-rog'] == before['iterate-rog']
        # Routine supervision tells a suspended reservation apart, and names its window.
        compact = {r['request_id']: r for r in json.loads(run('execution', 'list', '--active', '--compact')[0])}
        assert compact['iterate-a']['state'] == 'suspended' and compact['iterate-a']['suspended_by'] == 'window-1'
        assert compact['iterate-rog']['state'] == 'launching' and 'suspended_by' not in compact['iterate-rog']
        assert compact['window-1']['window'] is True and 'history' not in compact['window-1']
        # One window at a time: a second is refused naming the open one, and nothing else gets in.
        out, err = window(request('window-x', kind='measurement'), expected=1)
        assert 'measurement window window-1 is already open on mac' in err, err
        out, err = change('run', request('during'), expected=1)
        assert 'a measurement holds mac exclusively' in err, err
        # A standing reservation taken during the window is queued into it, not refused.
        out, err = change('run', request('iterate-c', standing=True))
        queued = json.loads(out)
        assert (queued['state'], queued['suspended_by'], queued['suspended_from']) == ('suspended', 'window-1', 'launching'), queued
        assert [e['action'] for e in queued['history']] == ['reserve', 'dispatch', 'suspend'], queued['history']
        # ...and the box being measured is not refreshed for it.
        assert 'REFRESH DEFERRED mac: measurement window window-1 is measuring there' in err and err.count('REFRESH') == 1, err
        # The window owns a suspended record's state: no dispatch, record or reconcile.
        for action, extra in [('dispatch', {}), ('record', {'state': 'running'}), ('reconcile', {'state': 'reserved'})]:
            out, err = change(action, dict(request_id='iterate-b', evidence='fixture', **extra), expected=1)
            assert 'iterate-b is suspended by measurement window window-1' in err, (action, err)
        # A retried window never dispatches again, and finishes a suspension a crash left undone.
        partial = json.loads((root / 'executions' / 'iterate-b.json').read_text())
        (root / 'executions' / 'iterate-b.json').write_text(json.dumps(before['iterate-b']))
        out, err = window({**request('window-1', kind='measurement'), 'evidence': 'invoking the runner'})
        assert json.loads(out) == records()['window-1'] and 'suspended iterate-a, iterate-b, iterate-c' in err, err
        assert records()['iterate-b']['state'] == 'suspended'
        assert [e['action'] for e in records()['window-1']['history']] == ['reserve', 'dispatch']
        assert partial['suspended_from'] == records()['iterate-b']['suspended_from']
        # A worker handing back mid-window concludes its suspended reservation, which then stays so.
        done('iterate-c', 'not-launched')
        assert 'suspended_by' not in records()['iterate-c']
        # Adoption: the window and its suspensions survive `claim --take`, and the new coordinator's
        # conclusion of the measurement restores them.
        run('claim', '--take', owner='second')
        survived = records()
        assert survived['window-1']['state'] == 'launching'
        assert all(survived[n]['state'] == 'suspended' for n in ['iterate-a', 'iterate-b'])
        out, err = done('window-1', 'pass', owner='second')
        assert 'EXECUTION WINDOW mac: window-1 concluded; restored iterate-a (launching), iterate-b (reserved)' in err, err
        after = records()
        assert after['iterate-c']['state'] == 'concluded'
        for name, former in [('iterate-a', 'launching'), ('iterate-b', 'reserved')]:
            r = after[name]
            assert r['state'] == former and 'suspended_by' not in r and 'suspended_from' not in r, r
            assert r['history'][-1]['action'] == 'restore', r['history']
            assert r['history'][-1]['data']['evidence'] == 'measurement window window-1 concluded pass', r['history']
        # No new request ids: the same records, restored. And a restored record works again.
        assert set(after) - set(before) == {'window-1', 'iterate-c'}, set(after)
        change('reconcile', dict(request_id='iterate-b', state='reserved', evidence='adopted; nothing ran'), owner='second')
        change('dispatch', dict(request_id='iterate-b', evidence='fixture dispatch'), owner='second')
        run('claim', '--take')
        change('reconcile', dict(request_id='iterate-b', state='running', evidence='adopted back'))
        # Suspend and restore across every other conclusion.
        for verdict in ['fail', 'timeout', 'cancelled', 'not-launched']:
            open_window('window-' + verdict)
            assert all(records()[n]['state'] == 'suspended' for n in ['iterate-a', 'iterate-b'])
            out, err = done('window-' + verdict, verdict)
            assert f'window-{verdict} concluded; restored iterate-a (launching), iterate-b (running)' in err, err
            assert records()['iterate-b']['history'][-1]['data']['evidence'].endswith('concluded ' + verdict)
        # Each box's window is its own; a box with no standing record left opens one suspending nothing.
        out, err = window(request('window-rog', 'rog', kind='measurement'), box='rog')
        assert 'EXECUTION WINDOW rog: window-rog open; suspended iterate-rog' in err, err
        assert records()['iterate-a']['state'] == 'launching'
        done('iterate-rog', 'not-launched')
        out, err = done('window-rog')
        assert 'restored' not in err, err
        out, err = window(request('window-rog-2', 'rog', kind='measurement'), box='rog')
        assert 'suspended nothing (no standing reservation on the box)' in err, err
        done('window-rog-2', 'not-launched')
        # The registry refuses a malformed suspension rather than read past it.
        path = root / 'executions' / 'iterate-a.json'
        good = path.read_bytes()
        for fields in [dict(state='suspended', suspended_by='window-1'),
                       dict(suspended_by='window-1', suspended_from='launching')]:
            path.write_text(json.dumps({**json.loads(good), **fields}))
            out, err = run('execution', 'list', '--active', '--compact', expected=1)
            assert 'suspended_from must be a nonempty string' in err or 'suspension fields on a record' in err, err
        path.write_bytes(good)
    print('PASS: measurement window: suspend, restore on every verdict, queue, adoption, one at a time')


measurement_window()


# Exercise real fsync calls and their publication order, including first directory creation.
import runpy
import stat
import io
from contextlib import redirect_stdout
from unittest.mock import patch

# Its own roster and payload: the module-level `env` and `request` belong to whichever block last
# bound them, which a block added above this one changes (#412).
with tempfile.TemporaryDirectory(prefix='fleet-durable-') as temporary:
    roster = 'mac'
    payload = dict(request_id='durable', wave='wave', worker='durable', transport='subagent',
                   issue='owner/repo#157', purpose='fixture', agent_host='mac', execution_host='mac',
                   repository='owner/repo', requested_revision='origin/main', kind='correctness')
    events = []
    real_sync, real_replace = os.fsync, os.replace

    def sync(descriptor):
        events.append('directory' if stat.S_ISDIR(os.fstat(descriptor).st_mode) else 'file')
        return real_sync(descriptor)

    def replace(source, target):
        events.append('replace')
        return real_replace(source, target)

    with patch('sys.argv', ['helper', temporary, 'reserve', 'owner', 'token', json.dumps(payload), roster]), \
            patch('os.fsync', side_effect=sync), patch('os.replace', side_effect=replace):
        with redirect_stdout(io.StringIO()):
            runpy.run_path(str(REGISTRY))
    assert events == ['directory', 'file', 'replace', 'directory'], events
    events.clear()
    with patch('sys.argv', ['helper', temporary, 'reserve', 'owner', 'token', json.dumps(payload), roster]), \
            patch('os.fsync', side_effect=sync), redirect_stdout(io.StringIO()):
        runpy.run_path(str(REGISTRY))
    assert events == ['directory', 'directory'], events
    print('PASS: parent and record directory synced around atomic publication')

# ludics-lite#445, continued: a measurement holds its box's lane lock across the record's
# publication, so a lane taking it EXCLUSIVE at the moment of the atomic replace is refused.
with tempfile.TemporaryDirectory(prefix='fleet-lane-held-') as temporary:
    locks = Path(temporary) / 'locks'
    payload = dict(request_id='held', wave='wave', worker='held', transport='subagent',
                   issue='owner/repo#445', purpose='fixture', agent_host='mac', execution_host='rog-nv-linux',
                   repository='owner/repo', requested_revision='origin/main', kind='measurement')
    seen = []
    real_replace = os.replace

    def replace(source, target):
        with open(locks / 'rog.lock', 'a') as lane:
            try:
                fcntl.flock(lane, fcntl.LOCK_EX | fcntl.LOCK_NB)
                seen.append('free')
            except BlockingIOError:
                seen.append('held')
        return real_replace(source, target)

    with patch('sys.argv', ['helper', temporary, 'reserve', 'owner', 'token', json.dumps(payload),
                            'rog-nv-linux', '', 'rog rog-nv-linux rog-nv-wsl', 'mac-studio', 'mac-studio']), \
            patch.dict(os.environ, {'WAKE_LAB_LOCK_DIR': str(locks)}), \
            patch('os.replace', side_effect=replace), redirect_stdout(io.StringIO()):
        helper = runpy.run_path(str(REGISTRY))
    for descriptor in helper['LANE_LOCKS']:
        os.close(descriptor)
    assert seen == ['held'], seen
    print('PASS: the measurement holds the lane lock while its record is published')

# ludics-lite#481, continued: the window's publication order. A crash between its records may leave
# the window open with some standing records not yet suspended, or some restored early -- never a
# record suspended by a measurement that is not outstanding -- and a retry finishes the rest.
with tempfile.TemporaryDirectory(prefix='fleet-window-order-') as temporary:
    executions = Path(temporary) / 'executions'
    real_replace = os.replace

    def helper(action, data, crash_after=None):
        """Run the helper in process; with `crash_after`, the os.replace after that many raises."""
        published = []

        def replace(source, target):
            if crash_after is not None and len(published) == crash_after:
                raise OSError('fixture crash between records')
            published.append(Path(target).stem)
            return real_replace(source, target)

        try:
            with patch('sys.argv', ['helper', temporary, action, 'owner', 'token', json.dumps(data), 'mac']), \
                    patch('os.replace', side_effect=replace), redirect_stdout(io.StringIO()):
                runpy.run_path(str(REGISTRY))
            assert crash_after is None, published
        except SystemExit as exit:
            assert crash_after is not None and exit.code == 1 and len(published) == crash_after, (exit, published)
        return published

    def request(identity, kind='correctness', standing=True):
        data = dict(request_id=identity, wave='wave', worker=identity, transport='subagent',
                    issue='owner/repo#481', purpose='fixture', agent_host='mac', execution_host='mac',
                    repository='owner/repo', requested_revision='origin/main', kind=kind)
        return {**data, 'standing': True, 'checkout': f'/wt/{identity}'} if standing else data

    def records():
        return {path.stem: json.loads(path.read_text()) for path in executions.glob('*.json')}

    def invariant():
        """No record is suspended by a measurement that is not outstanding."""
        now = records()
        for r in now.values():
            if r['state'] == 'suspended':
                window = now.get(r['suspended_by'])
                assert window and window['state'] != 'concluded', (r['request_id'], window)

    helper('run', request('iterate-a'))
    helper('reserve', request('iterate-b'))
    measurement = {'box': 'mac', 'request': request('measure', 'measurement', standing=False)}
    # The window crashes right after its first record is published: the measurement, outstanding.
    assert helper('window', measurement, crash_after=1) == ['measure'], records()
    invariant()
    assert records()['measure']['state'] == 'launching'
    assert [records()[n]['state'] for n in ['iterate-a', 'iterate-b']] == ['launching', 'reserved']
    # A retried window finishes the suspensions without a second dispatch.
    assert helper('window', measurement) == ['iterate-a', 'iterate-b']
    invariant()
    assert [e['action'] for e in records()['measure']['history']] == ['reserve', 'dispatch']
    assert all(records()[n]['state'] == 'suspended' for n in ['iterate-a', 'iterate-b'])
    # The conclusion crashes right after its first record is published: one restoration, while
    # the measurement is still outstanding and the other record still suspended by it.
    conclusion = dict(request_id='measure', verdict='not-launched', evidence='fixture', log='/logs/measure')
    assert helper('conclude', conclusion, crash_after=1) == ['iterate-a'], records()
    invariant()
    assert records()['measure']['state'] == 'launching'
    assert [records()[n]['state'] for n in ['iterate-a', 'iterate-b']] == ['launching', 'suspended']
    # A retried conclusion restores the rest and concludes.
    assert helper('conclude', conclusion) == ['iterate-b', 'measure']
    invariant()
    assert [records()[n]['state'] for n in ['measure', 'iterate-a', 'iterate-b']] == ['concluded', 'launching', 'reserved']
    assert records()['iterate-b']['history'][-1]['action'] == 'restore'
    print('PASS: a crash between window records leaves nothing suspended by an absent measurement; a retry finishes')
calls = SSH_LOG.read_text().splitlines() if SSH_LOG.exists() else []
assert calls and all(' bash -s -- ' in call for call in calls), calls
print('PASS: every cross-box refresh went to the suite\'s ssh shim (%d calls), never to a real box' % len(calls))
