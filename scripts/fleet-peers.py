#!/usr/bin/env python3
"""Provision the native SSH mesh from Mac Studio (stdlib only)."""
import argparse
import base64
from contextlib import contextmanager
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

DEFAULT_PEERS = ['mac-studio', 'rog-nv-linux', 'minix-amd-linux', 'tuf-amd-linux', 'macbook-pro']
NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9.-]*\Z')
USER = re.compile(r'[a-zA-Z_][a-zA-Z0-9_-]*\Z')
INCLUDE = 'Include ~/.ssh/fleet.conf'
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
               '-o', 'ServerAliveCountMax=2']


def run(args, timeout=60, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout,
                          check=True, **kwargs).stdout.strip()


def private_fingerprint(private):
    # ssh-keygen -l on a private key reads the .pub beside it when there is one, so fingerprint a
    # lone copy; OpenSSH keys carry their public half unencrypted, so no passphrase is asked.
    with tempfile.TemporaryDirectory() as scratch:
        copy = Path(scratch) / 'key'
        shutil.copyfile(private, copy)
        os.chmod(copy, 0o600)
        return run(['ssh-keygen', '-l', '-f', str(copy)], stdin=subprocess.DEVNULL).split()[1]


def regular(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise RuntimeError(f'Refusing nonregular file: {path}')


def key_parts(key):
    if '\n' in key or '\r' in key:
        raise ValueError('Expected one public-key line')
    fields = key.split()
    if len(fields) < 2 or fields[0] != 'ssh-ed25519':
        raise ValueError('Fleet keys must be bare Ed25519 public keys')
    with tempfile.NamedTemporaryFile(mode='w') as probe:
        probe.write(key + '\n')
        probe.flush()
        run(['ssh-keygen', '-lf', probe.name])
    return fields[:2]


@contextmanager
def locked(sshdir):
    if sshdir.is_symlink():
        raise RuntimeError(f'Refusing symlinked SSH directory: {sshdir}')
    sshdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = sshdir / '.fleet-peers.lock'
    lock.mkdir()  # Concurrent writers fail; a crash leaves a visible lock to inspect.
    try:
        yield
    finally:
        lock.rmdir()


def save(path, content):
    regular(path)
    if path.exists() and path.read_text() == content:
        os.chmod(path, 0o600)  # OpenSSH refuses a loose ~/.ssh/config even when its text is right.
        return
    if path.exists():
        backup = path.with_name(f'{path.name}.fleet-backup.{time.time_ns()}')
        shutil.copy2(path, backup)
    fd, tmp = tempfile.mkstemp(prefix='.fleet-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def collect(host, use_default, apply):
    if not NAME.fullmatch(host):
        raise ValueError('Invalid host name')
    sshdir = Path.home() / '.ssh'
    if sshdir.is_symlink():
        raise RuntimeError('Refusing symlinked ~/.ssh')
    identity = 'id_ed25519' if use_default else 'id_ed25519_fleet'
    private = sshdir / identity
    public = sshdir / (identity + '.pub')
    regular(private)
    regular(public)
    if apply:
        with locked(sshdir):
            if not private.exists():
                if use_default or public.exists():
                    raise RuntimeError(f'Missing private key {private}; create/repair it manually')
                run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(private),
                     '-C', f'{host}-fleet'])
            if use_default and private.stat().st_mode & 0o077:
                raise RuntimeError(f'{private} is readable by others, and OpenSSH refuses such a key: chmod 600 {private}')
            if use_default and not public.exists():
                raise RuntimeError(f'Missing public key {public}; recreate it: ssh-keygen -y -f {private} > {public}')
            if use_default and private_fingerprint(private) != run(['ssh-keygen', '-l', '-f', str(public)]).split()[1]:
                raise RuntimeError(f'Public/private key mismatch: {private}')
            if not use_default:
                derived = run(['ssh-keygen', '-y', '-P', '', '-f', str(private)])
                if public.exists():
                    if key_parts(public.read_text().strip()) != key_parts(derived):
                        raise RuntimeError(f'Public/private key mismatch: {private}')
                else:
                    save(public, derived + f' {host}-fleet\n')
    public_key = public.read_text().strip() if public.exists() else None
    if public_key:
        key_parts(public_key)
    host_key = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip()
    key_parts(host_key)
    user = getpass.getuser()
    if not USER.fullmatch(user):
        raise ValueError('Unsupported login username')
    return dict(host=host, user=user, key=public_key, host_key=host_key, identity=identity)


def add_authorized(existing, keys):
    result = existing
    for key in keys:
        kind, blob = key_parts(key)
        # Preserve existing options (including restrict/from/command): do not append
        # an unrestricted duplicate when a restricted entry already authorizes it.
        present = False
        for line in result.splitlines():
            if line.lstrip().startswith('#'):
                continue
            fields = line.split()
            if any(fields[i:i+2] == [kind, blob] for i in range(len(fields)-1)):
                present = True
                break
        if not present:
            if result and not result.endswith('\n'):
                result += '\n'
            result += key + '\n'
    return result


def install_mesh(own, roster, sshdir=None):
    sshdir = sshdir or Path.home() / '.ssh'
    peers = [peer for peer in roster if peer['host'] != own['host']]
    for peer in roster:
        if not NAME.fullmatch(peer['host']) or not USER.fullmatch(peer['user']):
            raise ValueError('Invalid peer identity')
        key_parts(peer['key'])
        key_parts(peer['host_key'])
    if own['identity'] not in ('id_ed25519', 'id_ed25519_fleet'):
        raise ValueError('Unexpected identity filename')
    with locked(sshdir):
        auth = sshdir / 'authorized_keys'
        config = sshdir / 'config'
        managed = sshdir / 'fleet.conf'
        known = sshdir / 'fleet_known_hosts'
        for path in (auth, config, managed, known, sshdir / 'known_hosts'):
            regular(path)
        # Do not silently replace a host key previously trusted by this machine.
        for peer in peers:
            expected = key_parts(peer['host_key'])
            for path in (known, sshdir / 'known_hosts'):
                if not path.exists():
                    continue
                query = subprocess.run(['ssh-keygen', '-F', peer['host'], '-f', str(path)],
                                       text=True, capture_output=True, timeout=10)
                if query.returncode not in (0, 1):
                    raise RuntimeError(query.stderr)
                for line in query.stdout.splitlines():
                    if line.startswith('#'):
                        continue
                    fields = line.split()
                    if fields and fields[0].startswith('@'):
                        raise RuntimeError(f'Host-key marker for {peer["host"]} in {path}; inspect manually')
                    if len(fields) >= 3 and fields[1] == expected[0] and fields[1:3] != expected:
                        raise RuntimeError(f'Host key changed for {peer["host"]} in {path}; inspect manually')
        previous = config.read_text() if config.exists() else ''
        # Our include must precede broad Host * defaults (OpenSSH uses first values).
        previous = '\n'.join(line for line in previous.splitlines() if line.strip() != INCLUDE)
        new_config = INCLUDE + '\n' + previous + ('\n' if previous else '')
        lines = ['# Managed by ludics/scripts/fleet-peers.py.']
        hosts = []
        for peer in peers:
            lines.extend([f'Host {peer["host"]}', f'  HostName {peer["host"]}',
                          f'  User {peer["user"]}', f'  IdentityFile ~/.ssh/{own["identity"]}',
                          '  IdentitiesOnly yes',
                          '  UserKnownHostsFile ~/.ssh/fleet_known_hosts ~/.ssh/known_hosts',
                          '  StrictHostKeyChecking yes'])
            hosts.append(peer['host'] + ' ' + ' '.join(key_parts(peer['host_key'])))
        lines.append('Host *')  # End the last peer block before the caller config resumes.
        save(auth, add_authorized(auth.read_text() if auth.exists() else '',
                                  [peer['key'] for peer in peers]))
        save(known, '\n'.join(hosts) + '\n')
        save(managed, '\n'.join(lines) + '\n')
        save(config, new_config)
        sshdir.chmod(0o700)
        auth.chmod(0o600)
    return {'installed': own['host']}


def verify_mesh(own, roster):
    results = []
    for peer in roster:
        if peer['host'] == own['host']:
            continue
        try:
            actual = run(['ssh', '-n', *SSH_OPTIONS, peer['host'], 'id -un'])
            if actual != peer['user']:
                raise RuntimeError(f'Expected {peer["user"]}, got {actual}')
            results.append({'from': own['host'], 'to': peer['host'], 'ok': True})
        except (subprocess.SubprocessError, RuntimeError) as error:
            results.append({'from': own['host'], 'to': peer['host'], 'ok': False,
                            'error': str(error) + ': ' + str(getattr(error, 'stderr', '')).strip()})
    return results


def invoke(target, action, payload):
    if target is None:
        return globals()[action](**payload)
    # Code and data travel on stdin through an already authenticated SSH connection.
    # Public metadata only; private key files are never transferred between machines.
    data = base64.b64encode(json.dumps(payload).encode()).decode()
    program = Path(__file__).read_text().split("\nif __name__ == '__main__':")[0]
    program += f'\nprint(json.dumps({action}(**json.loads(base64.b64decode({data!r})))))\n'
    return json.loads(run(['ssh', *SSH_OPTIONS, target, 'python3 -'], input=program, timeout=240))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='generate missing worker keys and exchange public keys')
    parser.add_argument('--peer', action='append', help='mesh member HOST or USER@HOST; repeat to replace default roster')
    args = parser.parse_args()
    status = json.loads(run(['tailscale', 'status', '--json']))
    coordinator = status['Self']['DNSName'].rstrip('.').split('.')[0]
    if coordinator != 'mac-studio':
        parser.error('Run this on mac-studio; from your mobile console, SSH to mac-studio first')
    targets = []
    peers = list(args.peer or DEFAULT_PEERS)
    for target in peers:
        parts = target.split('@')
        if len(parts) > 2 or not NAME.fullmatch(parts[-1]) or (len(parts) == 2 and not USER.fullmatch(parts[0])):
            parser.error(f'Invalid peer: {target}')
        host = parts[-1]
        if host == 'local':
            parser.error("'local' is fleet-worker.sh's name for the box it runs on, not a mesh member")
        if host == 'macbook-air':
            parser.error('macbook-air is a console, not a mesh member; no incoming fleet access is granted')
        if any(name == host for name, _ in targets):
            parser.error(f'Duplicate peer: {target}')
        if host == coordinator and len(parts) == 2 and parts[0] != getpass.getuser():
            parser.error('Local member must use the current coordinator user')
        targets.append((host, None if host == coordinator else target))
    if not any(host == coordinator for host, _ in targets):
        parser.error(f'The mesh must include the coordinator, {coordinator}')
    if len(targets) < 2:
        parser.error('At least two mesh members are required')
    print('Coordinator:', coordinator, flush=True)
    print('Mesh members:', ', '.join(name for name, _ in targets), flush=True)
    print('Worker fleet keys stay on their machines and have no passphrase for unattended SSH.', flush=True)
    roster = []
    for host, target in targets:
        item = invoke(target, 'collect', dict(host=host, use_default=host == 'mac-studio', apply=args.apply))
        roster.append(item)
        print(f'{host}: user={item["user"]}, key={item["identity"]}, ' +
              ('public key present' if item['key'] else 'missing; --apply will create it'), flush=True)
    if not args.apply:
        print('Read-only plan complete. Run again with --apply to exchange keys and verify every direction.')
        return
    missing = [item['host'] for item in roster if not item['key']]
    if missing:
        raise RuntimeError('No public key collected for ' + ', '.join(missing) + '; nothing was installed')
    for item, (_, target) in zip(roster, targets):
        invoke(target, 'install_mesh', dict(own=item, roster=roster))
        print('Configured:', item['host'], flush=True)
    failures = []
    for item, (_, target) in zip(roster, targets):
        for result in invoke(target, 'verify_mesh', dict(own=item, roster=roster)):
            print(('PASS' if result['ok'] else 'FAIL') + f' {result["from"]} -> {result["to"]}' +
                  (': ' + result['error'] if not result['ok'] else ''), flush=True)
            if not result['ok']:
                failures.append(result)
    if failures:
        raise RuntimeError('Some connections failed; inspect errors and rerun. Existing access was retained.')
    print(f'All {len(roster) * (len(roster)-1)} directed SSH connections passed.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'fleet-peers: {error}\n{getattr(error, "stderr", "")}', file=sys.stderr)
        sys.exit(1)
