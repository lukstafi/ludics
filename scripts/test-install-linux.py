#!/usr/bin/env python3
"""Isolated bootstrap safety checks; never installs packages or contacts the fleet."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install-linux.sh').resolve()
SETUP_JQ = SCRIPT.parents[1] / '.github/actions/setup-jq/action.yml'


class BootstrapSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def run_shell(self, body, success=True):
        result = subprocess.run(
            ['bash', '-c', 'source "$1"; cd "$2"; ' + body, 'test', str(SCRIPT), str(self.root)],
            text=True, capture_output=True, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_import_has_no_install_side_effects(self):
        self.run_shell(':')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_skill_link_rerun(self):
        self.run_shell('mkdir src; link_skill "$PWD/src" "$PWD/link"; link_skill "$PWD/src" "$PWD/link"')
        self.assertTrue((self.root / 'link').is_symlink())
        self.assertEqual(list((self.root / 'src').iterdir()), [])

    def test_skill_link_through_compat_symlink_accepted(self):
        self.run_shell('mkdir -p new/skill; ln -s new old; ln -s "$PWD/old/skill" link; link_skill "$PWD/new/skill" "$PWD/link"')
        self.assertEqual(os.readlink(self.root / 'link'), str(self.root / 'old/skill'))

    def test_skill_link_to_other_directory_refused(self):
        self.run_shell('mkdir -p new/skill other; ln -s "$PWD/other" link; link_skill "$PWD/new/skill" "$PWD/link"', False)
        self.assertEqual(os.readlink(self.root / 'link'), str(self.root / 'other'))

    def test_real_skill_directory_preserved(self):
        self.run_shell('mkdir src link; echo KEEP > link/local; link_skill "$PWD/src" "$PWD/link"', False)
        self.assertEqual((self.root / 'link/local').read_text(), 'KEEP\n')

    def test_wrong_symlink_preserved(self):
        self.run_shell('ln -s missing link; link_skill "$PWD/src" "$PWD/link"', False)
        self.assertEqual(os.readlink(self.root / 'link'), 'missing')

    def test_new_startup_and_idempotence(self):
        self.run_shell("source_at_start rc 'export FLEET_LOCAL_BOX=native'; source_at_start rc 'export FLEET_LOCAL_BOX=native'")
        self.assertEqual((self.root / 'rc').read_text(), 'export FLEET_LOCAL_BOX=native\n')
        self.assertEqual(list(self.root.glob('*.fleet-backup.*')), [])

    def test_startup_precedes_early_return_and_backs_up(self):
        (self.root / 'rc').write_text('return\n')
        (self.root / 'rc').chmod(0o640)
        self.run_shell("source_at_start rc 'export FLEET_LOCAL_BOX=native'; source_at_start rc 'export FLEET_LOCAL_BOX=native'; source rc; test \"$FLEET_LOCAL_BOX\" = native")
        backups = list(self.root.glob('rc.fleet-backup.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'return\n')
        self.assertEqual((self.root / 'rc').stat().st_mode & 0o777, 0o640)

    def test_startup_symlink_preserved(self):
        self.run_shell("echo KEEP > real; ln -s real rc; source_at_start rc 'source env'", False)
        self.assertEqual((self.root / 'real').read_text(), 'KEEP\n')

    def test_append_line_ends_the_file_once(self):
        (self.root / 'env.sh').write_text('export A=1')
        self.run_shell("append_line env.sh '. token'; append_line env.sh '. token'")
        self.assertEqual((self.root / 'env.sh').read_text(), 'export A=1\n. token\n')

    def test_append_line_moves_an_earlier_copy_last(self):
        (self.root / 'env.sh').write_text('. token\nexport GH_TOKEN=stale\n')
        (self.root / 'env.sh').chmod(0o640)
        self.run_shell("append_line env.sh '. token'")
        self.assertEqual((self.root / 'env.sh').read_text(), 'export GH_TOKEN=stale\n. token\n')
        self.assertEqual((self.root / 'env.sh').stat().st_mode & 0o777, 0o640)

    def test_drop_line_removes_only_that_line_and_keeps_the_mode(self):
        (self.root / 'env.sh').write_text('export A=1\n. token\nexport B=2\n. token\n')
        (self.root / 'env.sh').chmod(0o640)
        self.run_shell("drop_line env.sh '. token'; drop_line env.sh '. token'; drop_line absent '. token'")
        self.assertEqual((self.root / 'env.sh').read_text(), 'export A=1\nexport B=2\n')
        self.assertEqual((self.root / 'env.sh').stat().st_mode & 0o777, 0o640)
        self.assertFalse((self.root / 'absent').exists())

    def test_drop_line_never_follows_a_symlink_and_refuses_an_unreadable_file(self):
        self.run_shell("printf '. token\\n' > real; ln -s real link; drop_line link '. token'")
        self.assertEqual((self.root / 'real').read_text(), '. token\n')
        (self.root / 'env.sh').write_text('. token\n')
        (self.root / 'env.sh').chmod(0o200)
        self.run_shell("drop_line env.sh '. token'", False)
        (self.root / 'env.sh').chmod(0o600)
        self.assertEqual((self.root / 'env.sh').read_text(), '. token\n')

    def test_store_gh_token_feeds_the_file_token_on_stdin_with_no_token_variable(self):
        # ludics-lite#567: gh refuses to log in while GH_TOKEN or GITHUB_TOKEN is set, and the
        # token must never be an argument; the fake gh records what it was given.
        (self.root / 'bin').mkdir()
        (self.root / 'bin/gh').write_text(
            '#!/bin/sh\nprintf "%s\\n" "$*" > "$REC.args"\n'
            'printf "%s|%s\\n" "${GH_TOKEN+set}" "${GITHUB_TOKEN+set}" > "$REC.env"\ncat > "$REC.stdin"\n')
        (self.root / 'bin/gh').chmod(0o755)
        (self.root / 'tok.sh').write_text('export GH_TOKEN=ghp_fixture\n')
        self.run_shell('export PATH="$PWD/bin:$PATH" REC="$PWD/rec" GH_TOKEN=ghp_session GITHUB_TOKEN=ghp_session; '
                       'store_gh_token "$PWD/tok.sh"')
        self.assertEqual((self.root / 'rec.args').read_text(),
                         'auth login -h github.com --with-token --insecure-storage\n')
        self.assertEqual((self.root / 'rec.env').read_text(), '|\n')
        self.assertEqual((self.root / 'rec.stdin').read_text(), 'ghp_fixture\n')

    def test_startup_line_below_an_early_return_moves_first(self):
        (self.root / 'rc').write_text('return\nsource env\n')
        self.run_shell("source_at_start rc 'source env'")
        self.assertEqual((self.root / 'rc').read_text(), 'source env\nreturn\n')

    def test_append_line_refuses_an_unreadable_file_without_truncating_it(self):
        (self.root / 'env.sh').write_text('export FLEET_LOCAL_BOX=rog\n')
        (self.root / 'env.sh').chmod(0o200)
        self.run_shell("append_line env.sh '. token'", False)
        (self.root / 'env.sh').chmod(0o600)
        self.assertEqual((self.root / 'env.sh').read_text(), 'export FLEET_LOCAL_BOX=rog\n')

    def test_startup_symlink_already_first_is_accepted(self):
        self.run_shell("printf 'source env\\nreturn\\n' > real; ln -s real rc; source_at_start rc 'source env'")
        self.assertEqual((self.root / 'real').read_text(), 'source env\nreturn\n')

    def test_key_pair_matches_needs_two_readable_matching_halves(self):
        self.run_shell("scratch=$PWD; ssh-keygen -q -t ed25519 -N '' -f good; key_pair_matches good good.pub; "
                       "echo junk > bad; echo junk > bad.pub; ! key_pair_matches bad bad.pub; "
                       "ssh-keygen -q -t ed25519 -N '' -f other; ! key_pair_matches good other.pub")

    def test_private_key_mode_ok_refuses_a_key_others_can_read(self):
        self.run_shell("touch k; chmod 600 k; private_key_mode_ok k; chmod 400 k; private_key_mode_ok k; "
                       "chmod 644 k; ! private_key_mode_ok k; chmod 640 k; ! private_key_mode_ok k")

    def test_private_fingerprint_ignores_the_sibling_public_key(self):
        self.run_shell("scratch=$PWD; ssh-keygen -q -t ed25519 -N pw -f a; ssh-keygen -q -t ed25519 -N '' -f b; "
                       "mv b.pub a.pub; test \"$(private_fingerprint a)\" != \"$(ssh-keygen -l -f a.pub | awk '{print $2}')\"; "
                       "rm b; ssh-keygen -q -t ed25519 -N '' -f c; test \"$(private_fingerprint c)\" = \"$(ssh-keygen -l -f c.pub | awk '{print $2}')\"")

    def test_append_line_never_follows_a_symlink_or_creates(self):
        self.run_shell("echo KEEP > real; ln -s real env.sh; append_line env.sh '. token'")
        self.assertEqual((self.root / 'real').read_text(), 'KEEP\n')
        self.run_shell("append_line missing '. token'", False)
        self.assertFalse((self.root / 'missing').exists())

    def test_wrong_repository_preserved(self):
        self.run_shell('git init -q repo; git -C repo remote add origin https://github.com/other/repo.git; clone_if_missing lukstafi/ludics "$PWD/repo"', False)
        self.assertTrue((self.root / 'repo/.git').is_dir())

    def test_former_repository_name_accepted(self):
        self.run_shell('git init -q repo; git -C repo remote add origin https://github.com/lukstafi/ludics-lite.git; clone_if_missing lukstafi/ludics "$PWD/repo" lukstafi/ludics-lite')
        self.run_shell('git init -q repo2; git -C repo2 remote add origin https://github.com/lukstafi/ludics-lite.git; clone_if_missing lukstafi/ludics "$PWD/repo2"', False)

    def test_dirty_repository_preserved(self):
        self.run_shell('git init -q repo; git -C repo remote add origin https://github.com/lukstafi/ludics.git; echo KEEP > repo/local; clone_if_missing lukstafi/ludics "$PWD/repo"')
        self.assertEqual((self.root / 'repo/local').read_text(), 'KEEP\n')

    def test_download_failure_does_not_execute(self):
        self.run_shell('scratch=$PWD; curl() { return 22; }; installer nonexistent-fleet-test https://example.invalid bash', False)
        self.assertEqual(list(self.root.iterdir()), [])

    def make_console_key(self):
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f',
                        str(self.root / 'console')], check=True, capture_output=True)
        return (self.root / 'console.pub').read_text().strip()

    def test_console_key_rerun(self):
        key = self.make_console_key()
        self.run_shell('key=$(cat console.pub); authorize_console_key "$key" "$PWD/ssh"; authorize_console_key "$key" "$PWD/ssh"')
        authorized = self.root / 'ssh/authorized_keys'
        self.assertEqual(authorized.read_text(), key + '\n')
        self.assertEqual(authorized.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'ssh').stat().st_mode & 0o777, 0o700)

    def test_existing_key_restrictions_preserved(self):
        key = self.make_console_key()
        (self.root / 'ssh').mkdir()
        authorized = self.root / 'ssh/authorized_keys'
        original = 'restrict ' + key  # Deliberately no trailing newline.
        authorized.write_text(original)
        self.run_shell('key=$(cat console.pub); authorize_console_key "$key" "$PWD/ssh"')
        self.assertEqual(authorized.read_text(), original)

    def test_console_key_append_preserves_existing_file(self):
        key = self.make_console_key()
        (self.root / 'ssh').mkdir()
        authorized = self.root / 'ssh/authorized_keys'
        authorized.write_text('# existing configuration')
        self.run_shell('key=$(cat console.pub); authorize_console_key "$key" "$PWD/ssh"')
        self.assertEqual(authorized.read_text(), '# existing configuration\n' + key + '\n')

    def test_invalid_console_key_preserves_authorization(self):
        (self.root / 'ssh').mkdir()
        authorized = self.root / 'ssh/authorized_keys'
        authorized.write_text('# KEEP\n')
        self.run_shell('authorize_console_key "ssh-ed25519 invalid" "$PWD/ssh"', False)
        self.assertEqual(authorized.read_text(), '# KEEP\n')
        self.assertEqual(list((self.root / 'ssh').glob('key-check.*')), [])

    def test_authorized_keys_symlink_refused(self):
        self.make_console_key()
        self.run_shell('mkdir ssh; echo KEEP > real; ln -s ../real ssh/authorized_keys; key=$(cat console.pub); authorize_console_key "$key" "$PWD/ssh"', False)
        self.assertEqual((self.root / 'real').read_text(), 'KEEP\n')

    def test_inhibit_rule_names_user_and_action(self):
        rule = self.run_shell('inhibit_rule lukstafi').stdout
        self.assertIn('subject.user == "lukstafi"', rule)
        self.assertIn('action.id == "org.freedesktop.login1.inhibit-block-sleep"', rule)

    def test_inhibit_rule_refuses_injected_user(self):
        self.run_shell('inhibit_rule \'x" || true || "\'', False)

    def test_inhibit_grant_installs_only_on_difference(self):
        stub = 'scratch=$PWD; sudo() { echo "$*" >> calls; [ "$1" != cmp ] || return "$CMP_RC"; }; id() { echo lukstafi; }; '
        self.run_shell(stub + 'CMP_RC=0 install_inhibit_grant')
        self.assertNotIn('install -m', (self.root / 'calls').read_text())
        self.run_shell(stub + 'CMP_RC=1 install_inhibit_grant')
        self.assertIn('install -m 644', (self.root / 'calls').read_text())

    def test_lid_dropin_ignores_lid_on_external_power_only(self):
        conf = self.run_shell('lid_dropin').stdout
        self.assertIn('[Login]\nHandleLidSwitchExternalPower=ignore\n', conf)
        self.assertNotIn('HandleLidSwitch=', conf)

    def test_has_lid_follows_the_acpi_button(self):
        self.run_shell('mkdir -p lid/LID0; FLEET_LID_GLOB="$PWD/lid/*" has_lid')
        self.run_shell('FLEET_LID_GLOB="$PWD/nolid/*" has_lid', False)

    def test_lid_dropin_installs_on_difference_and_reloads_every_run(self):
        stub = 'scratch=$PWD; sudo() { echo "$*" >> calls; [ "$1" != cmp ] || return "$CMP_RC"; }; '
        self.run_shell(stub + 'CMP_RC=0 install_lid_dropin')
        self.assertNotIn('install -D', (self.root / 'calls').read_text())
        self.assertIn('systemctl reload systemd-logind', (self.root / 'calls').read_text())
        self.run_shell(stub + 'CMP_RC=1 install_lid_dropin')
        calls = (self.root / 'calls').read_text()
        self.assertIn('install -D -m 644', calls)
        self.assertIn('systemctl reload systemd-logind', calls)

    def test_wake_timer_wakes_the_system_at_the_given_time(self):
        timer = self.run_shell('wake_timer 06:58').stdout
        self.assertIn('[Timer]\nOnCalendar=*-*-* 06:58:00\nWakeSystem=true\n', timer)
        self.assertIn('Persistent=false\n', timer)
        self.assertIn('[Install]\nWantedBy=timers.target\n', timer)

    def test_wake_timer_refuses_a_malformed_time(self):
        for bad in ['7:00', '24:00', '06:60', '06:58; rm -rf /', '']:
            self.run_shell('wake_timer ' + repr(bad), False)

    def test_wake_service_runs_nothing(self):
        service = self.run_shell('wake_service').stdout
        self.assertIn('[Service]\nType=oneshot\nExecStart=/bin/true\n', service)

    def test_wake_timer_installs_on_difference_and_reloads_every_run(self):
        stub = 'scratch=$PWD; sudo() { echo "$*" >> calls; [ "$1" != cmp ] || return "$CMP_RC"; }; '
        self.run_shell(stub + 'CMP_RC=0 install_wake_timer 06:58')
        calls = (self.root / 'calls').read_text()
        self.assertNotIn('install -D', calls)
        self.assertLess(calls.index('daemon-reload'), calls.index('enable --now fleet-sweep-wake.timer'))
        (self.root / 'calls').unlink()
        self.run_shell(stub + 'CMP_RC=1 install_wake_timer 06:58')
        calls = (self.root / 'calls').read_text()
        self.assertIn('install -D -m 644 ' + str(self.root) + '/fleet-sweep-wake.timer /etc/systemd/system/fleet-sweep-wake.timer', calls)
        self.assertIn('install -D -m 644 ' + str(self.root) + '/fleet-sweep-wake.service /etc/systemd/system/fleet-sweep-wake.service', calls)
        self.assertLess(calls.index('daemon-reload'), calls.index('enable --now'))
        self.assertIn('OnCalendar=*-*-* 06:58:00', (self.root / 'fleet-sweep-wake.timer').read_text())

    def test_wake_timer_install_refuses_a_malformed_time_before_sudo(self):
        stub = 'scratch=$PWD; sudo() { echo "$*" >> calls; }; '
        self.run_shell(stub + 'install_wake_timer 7am', False)
        self.assertFalse((self.root / 'calls').exists())

    def test_wake_timer_default_precedes_the_sweep(self):
        self.assertEqual(self.run_shell('echo "$DEFAULT_WAKE_TIME"').stdout, '06:55\n')
        self.run_shell('valid_wake_time "$DEFAULT_WAKE_TIME"')

    def test_wake_timer_only_installs_the_default_or_a_given_time(self):
        stub = 'uname() { echo Linux; }; sudo() { echo "$*" >> calls; [ "$1" != cmp ] || return 1; }; '
        self.run_shell(stub + 'wake_timer_only; cp "$scratch/fleet-sweep-wake.timer" default.timer')
        self.assertIn('OnCalendar=*-*-* 06:55:00', (self.root / 'default.timer').read_text())
        self.assertIn('systemctl enable --now fleet-sweep-wake.timer', (self.root / 'calls').read_text())
        self.run_shell(stub + 'wake_timer_only 06:40; cp "$scratch/fleet-sweep-wake.timer" given.timer')
        self.assertIn('OnCalendar=*-*-* 06:40:00', (self.root / 'given.timer').read_text())

    def test_wake_timer_only_refuses_before_sudo(self):
        stub = 'uname() { echo Linux; }; sudo() { echo "$*" >> calls; }; '
        self.run_shell(stub + 'wake_timer_only 6am', False)
        self.run_shell(stub + 'wake_timer_only 06:55 extra', False)
        self.run_shell('sudo() { echo "$*" >> calls; }; uname() { echo Darwin; }; wake_timer_only', False)
        self.assertFalse((self.root / 'calls').exists())

    def test_librocwmma_pin_blocks_the_distro_package(self):
        pin = self.run_shell('librocwmma_pin').stdout
        self.assertIn('Package: librocwmma-dev\nPin: release *\nPin-Priority: -1\n', pin)

    ROCWMMA_STUB = ('scratch=$PWD; sudo() { echo "$*" >> calls; [ "$1" != cmp ] || return "$CMP_RC"; }; '
                    'git() { echo "git $*" >> calls; d=${@: -1}; mkdir -p "$d/library/include/rocwmma/internal"; '
                    'touch "$d/library/include/rocwmma/rocwmma.hpp"; [ -n "${PARTIAL-}" ] || '
                    'touch "$d/library/include/rocwmma/internal/types.hpp"; }; ')

    def test_rocwmma_installs_the_full_upstream_tree_and_pins_the_package(self):
        self.run_shell(self.ROCWMMA_STUB + 'CMP_RC=1 install_rocwmma')
        calls = (self.root / 'calls').read_text()
        self.assertIn('--branch rocm-7.1.0 https://github.com/ROCm/rocWMMA.git', calls)
        self.assertIn('install -D -m 644 ' + str(self.root) + '/no-librocwmma-dev /etc/apt/preferences.d/no-librocwmma-dev', calls)
        self.assertIn('cp -r ' + str(self.root) + '/rocWMMA/library/include/rocwmma/. /usr/include/rocwmma/', calls)

    def test_rocwmma_pin_rewritten_only_on_difference(self):
        self.run_shell(self.ROCWMMA_STUB + 'CMP_RC=0 install_rocwmma')
        self.assertNotIn('install -D -m 644', (self.root / 'calls').read_text())

    def test_rocwmma_refuses_a_tree_without_internal_before_copying(self):
        self.run_shell(self.ROCWMMA_STUB + 'PARTIAL=1 CMP_RC=1 install_rocwmma', False)
        calls = (self.root / 'calls').read_text()
        self.assertNotIn('/usr/include/rocwmma', calls)
        self.assertNotIn('preferences.d', calls)

    # A stub curl writes FAKE_JQ's bytes; the test sets the pinned sum to those bytes' own, so the
    # sum check is exercised without a download. sudo is recorded, never run.
    JQ_STUB = ('scratch=$PWD; FAKE_JQ=$PWD/fake-jq; printf "#!/bin/sh\\necho jq-fake\\n" > "$FAKE_JQ"; chmod +x "$FAKE_JQ"; '
               'curl() { echo "curl $*" >> calls; cp "$FAKE_JQ" "${@: -1}"; }; '
               'sudo() { echo "$*" >> calls; [ "$1" != install ] || command install "${@:2}"; }; '
               'uname() { echo x86_64; }; JQ_DEST=$PWD/bin/jq; mkdir -p bin; ')

    def test_jq_pin_matches_ci(self):
        action = SETUP_JQ.read_text()
        version = self.run_shell('echo "$JQ_VERSION"').stdout.strip()
        self.assertIn('\n        version=' + version + '\n', action)
        amd64 = self.run_shell('echo "$JQ_SHA256_amd64"').stdout.strip()
        arm64 = self.run_shell('echo "$JQ_SHA256_arm64"').stdout.strip()
        self.assertRegex(action, r'Linux/X64\) asset=jq-linux-amd64 sum=' + re.escape(amd64) + r' ')
        self.assertRegex(action, r'Linux/ARM64\) asset=jq-linux-arm64 sum=' + re.escape(arm64) + r' ')
        self.assertTrue(version.startswith('1.8.'), version)

    def test_jq_arch_maps_the_fleet_machines_and_refuses_others(self):
        self.assertEqual(self.run_shell('jq_arch x86_64; echo; jq_arch aarch64').stdout, 'amd64\narm64')
        self.run_shell('jq_arch riscv64', False)

    def test_jq_installs_a_verified_download(self):
        self.run_shell(self.JQ_STUB + 'JQ_SHA256_amd64=$(sha256_of "$FAKE_JQ"); install_jq')
        calls = (self.root / 'calls').read_text()
        self.assertIn('/releases/download/jq-1.8.2/jq-linux-amd64', calls)
        self.assertIn('install -m 755 ' + str(self.root) + '/jq ' + str(self.root) + '/bin/jq', calls)
        self.assertEqual((self.root / 'bin/jq').read_text(), '#!/bin/sh\necho jq-fake\n')

    def test_jq_refuses_a_download_that_misses_its_sum_before_sudo(self):
        self.run_shell(self.JQ_STUB + 'install_jq', False)
        self.assertNotIn('install -m', (self.root / 'calls').read_text())
        self.assertFalse((self.root / 'bin/jq').exists())

    def test_jq_rerun_with_the_pinned_binary_in_place_downloads_nothing(self):
        self.run_shell(self.JQ_STUB + 'cp "$FAKE_JQ" bin/jq; JQ_SHA256_amd64=$(sha256_of "$FAKE_JQ"); install_jq')
        self.assertFalse((self.root / 'calls').exists())

    def test_jq_only_refuses_before_sudo(self):
        stub = 'sudo() { echo "$*" >> calls; }; curl() { echo "$*" >> calls; }; '
        self.run_shell(stub + 'uname() { echo Darwin; }; jq_only', False)
        self.run_shell(stub + 'uname() { echo Linux; }; jq_only extra', False)
        self.assertFalse((self.root / 'calls').exists())

    # The shared benchmark venv (ludics-lite#537), dry: a fake venv python records pip installs in
    # <venv>/installed (what its freeze prints) and passes the smoke unless FAKE_SMOKE_FAIL is set or
    # <venv>/smoke-fails exists. python3 makes those venvs and answers the version and include
    # questions; anything else reaches the real python3 (the stub fixture_digest.py, os.replace).
    # ssh and scp read a fake anchor directory, and every external call lands in calls.
    FAKE_VENV_PYTHON = r"""#!/bin/sh
d=$(cd "$(dirname "$0")/.." && pwd -P)
case "$1" in
  -m) shift 2; case "$1" in
        install) shift; echo "pip install $*" >> "$CALLS"
                 [ -z "${FAKE_PIP_FAIL-}" ] || exit 1
                 for a; do case $a in *==*) echo "$a" >> "$d/installed";; esac; done ;;
        freeze) cat "$d/installed" 2>/dev/null ;;
      esac ;;
  -c) echo "${FAKE_VENV_MINOR:-3.14}" ;;
  -X) echo "smoke $d $5" >> "$CALLS"; [ ! -e "$d/smoke-fails" ] && [ -z "${FAKE_SMOKE_FAIL-}" ] ;;
esac
"""
    FAKE_DIGEST_TOOL = r"""import hashlib, sys
args = sys.argv[1:]
digests, fixture = args[args.index('--digests') + 1], args[-1]
sha = hashlib.sha256(open(fixture, 'rb').read()).hexdigest()
ok = any(line.split()[:1] == [sha] for line in open(digests) if not line.startswith('#'))
print(fixture, 'MATCH' if ok else 'MISMATCH')
sys.exit(0 if ok else 1)
"""
    BENCH_STUB = (
        'BENCH_VENV=$PWD/venvs/ocannl-bench; BENCH_CHECKOUT=$PWD/ocannl; scratch=$PWD/scratch; '
        'export CALLS=$PWD/calls FAKE_PY=$PWD/fake-python; FAKE_INCLUDE=$PWD/include; ANCHOR=$PWD/anchor; '
        'FAKE_LSPCI=${FAKE_LSPCI-"02:00.0 VGA compatible controller: NVIDIA Corporation GB205M"}; '
        'python3() { if [ "$1" = -m ] && [ "$2" = venv ]; then echo "venv $3" >> "$CALLS"; mkdir -p "$3/bin"; '
        'cp "$FAKE_PY" "$3/bin/python"; return; fi; '
        'if [ "$1" = -c ] && [[ $2 == *INCLUDEPY* ]]; then echo "$FAKE_INCLUDE"; return; fi; '
        'if [ "$1" = -c ] && [[ $2 == *version_info* ]]; then echo 3.14; return; fi; command python3 "$@"; }; '
        'lspci() { printf "%s\\n" "$FAKE_LSPCI"; }; '
        'rocminfo() { printf "  Name:                    AMD Ryzen AI\\n  Name:                    %s\\n" "${FAKE_GFX:-gfx1102}"; }; '
        'timeout() { shift; "$@"; }; flock() { echo "flock $*" >> "$CALLS"; }; '
        'sudo() { echo "sudo $*" >> "$CALLS"; [ "$1" != -n ] || return "${SUDO_N_RC:-1}"; '
        '[ "$1" != apt-get ] || touch "$FAKE_INCLUDE/Python.h"; }; '
        'ssh() { echo "ssh $*" >> "$CALLS"; (cd "$ANCHOR/benchmarks/fixtures" && find . -maxdepth 1 -type f -name "*.safetensors" -print0); }; '
        'scp() { echo "scp $*" >> "$CALLS"; local a dest=${@: -1}; '
        'for a; do case $a in *:*) cp "$ANCHOR/${a#*:ocannl-staging/}" "$dest";; esac; done; }; '
        'mkvenv() { local d=$1; shift; mkdir -p "$d/bin"; cp "$FAKE_PY" "$d/bin/python"; printf "%s\\n" "$@" > "$d/installed"; }; ')
    NVIDIA_PINS = 'numpy==2.5.3 safetensors==0.8.0 tinygrad==0.14.0 torch==2.14.0+cu130'

    def bench_setup(self, fixtures=('a', 'b'), recorded=('a', 'b')):
        import hashlib
        (self.root / 'fake-python').write_text(self.FAKE_VENV_PYTHON)
        (self.root / 'fake-python').chmod(0o755)
        for d in ['scratch', 'include', 'anchor/benchmarks/fixtures', 'venvs', 'ocannl/benchmarks/fixtures']:
            (self.root / d).mkdir(parents=True, exist_ok=True)
        (self.root / 'include/Python.h').write_text('')
        (self.root / 'anchor/benchmarks/fixture_digest.py').write_text(self.FAKE_DIGEST_TOOL)
        rows = ['# measurement-boxes: m4-max']
        for name in fixtures:
            body = ('fixture ' + name + '\n').encode()
            (self.root / 'anchor/benchmarks/fixtures' / (name + '.safetensors')).write_bytes(body)
            if name in recorded:
                rows.append(hashlib.sha256(body).hexdigest() + '  ' + str(len(body)) + '  '
                            + name + '.safetensors  m4-max  content-v1')
        (self.root / 'anchor/benchmarks/fixtures/DIGESTS.txt').write_text('\n'.join(rows) + '\n')
        # The box's own record is stale: the anchor's is the one a copy is checked against.
        (self.root / 'ocannl/benchmarks/fixtures/DIGESTS.txt').write_text('# measurement-boxes: m4-max\n')

    def calls(self):
        path = self.root / 'calls'
        return path.read_text() if path.exists() else ''

    def venv_dirs(self):
        return sorted(p.name for p in (self.root / 'venvs').iterdir())

    def test_bench_torch_index_per_gpu(self):
        out = self.run_shell('bench_torch_spec nvidia; bench_torch_spec amd gfx1102; '
                             'bench_torch_spec amd gfx1151; bench_torch_spec amd; bench_torch_spec cpu').stdout
        self.assertEqual(out, 'cu130 2.14.0+cu130\nrocm7.1 2.13.0+rocm7.1\nrocm7.2 2.14.1+rocm7.2\n'
                              'rocm7.1 2.13.0+rocm7.1\ncpu 2.14.0+cpu\n')
        self.run_shell('bench_torch_spec none', False)

    def test_bench_gpu_detect_reads_the_display_devices(self):
        stub = 'lspci() { printf "%s\\n" "$@" "${DEV[@]}"; }; '
        rog = ('00:02.0 VGA compatible controller: Intel Corporation Arrow Lake-S',
               '02:00.0 VGA compatible controller: NVIDIA Corporation GB205M')
        cases = [(rog, 'nvidia'),
                 (('c5:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo',), 'amd'),
                 (('00:02.0 VGA compatible controller: Intel Corporation',), 'cpu')]
        for devices, gpu in cases:
            body = stub + 'DEV=(' + ' '.join(repr(d) for d in devices) + '); bench_gpu_detect'
            self.assertEqual(self.run_shell(body).stdout, gpu + '\n')
        both = stub + 'DEV=("01:00.0 VGA: NVIDIA Corporation" "02:00.0 VGA: Advanced Micro Devices"); bench_gpu_detect'
        self.run_shell(both, False)
        gfx = self.run_shell('rocminfo() { printf "  Name:   AMD Ryzen AI Max\\n  Name:   gfx1151\\n  Name:   amdgcn-amd-amdhsa--gfx1151\\n"; }; bench_amd_gfx')
        self.assertEqual(gfx.stdout, 'gfx1151\n')

    def test_bench_fresh_box_builds_swaps_records_links_and_copies(self):
        self.bench_setup()
        out = self.run_shell(self.BENCH_STUB + 'bench_provision').stdout
        calls = self.calls()
        self.assertIn('pip install -q --disable-pip-version-check numpy==2.5.3 safetensors==0.8.0 tinygrad==0.14.0\n', calls)
        self.assertIn('--index-url https://download.pytorch.org/whl/cu130 torch==2.14.0+cu130\n', calls)
        venv = self.root / 'venvs/ocannl-bench'
        self.assertTrue(venv.is_symlink())
        fresh = os.readlink(venv)
        self.assertRegex(fresh, r'^ocannl-bench-\d{8}T\d{6}Z\.')
        self.assertIn('smoke ' + str((self.root / 'venvs' / fresh).resolve()) + ' nvidia', calls)
        self.assertLess(calls.index('smoke '), calls.index('ssh '))
        self.assertEqual((self.root / 'venvs/ocannl-bench.requirements.txt').read_text(),
                         self.NVIDIA_PINS.replace(' ', '\n') + '\n')
        self.assertEqual(os.readlink(self.root / 'ocannl/benchmarks/.venv'), str(venv))
        fixtures = self.root / 'ocannl/benchmarks/fixtures'
        self.assertEqual((fixtures / 'a.safetensors').read_text(), 'fixture a\n')
        self.assertEqual((fixtures / 'b.safetensors').read_text(), 'fixture b\n')
        self.assertEqual([p.name for p in fixtures.glob('.incoming*')], [])
        self.assertNotIn('WARNING', out)

    def test_bench_amd_index_follows_the_gfx(self):
        self.bench_setup()
        amd = 'FAKE_LSPCI="c5:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI]"; '
        self.run_shell(amd + self.BENCH_STUB + 'bench_provision')
        self.assertIn('--index-url https://download.pytorch.org/whl/rocm7.1 torch==2.13.0+rocm7.1\n', self.calls())
        self.assertRegex(self.calls(), r'smoke \S+ amd\n')
        self.run_shell(amd + 'FAKE_GFX=gfx1151; ' + self.BENCH_STUB + 'bench_provision')
        self.assertIn('--index-url https://download.pytorch.org/whl/rocm7.2 torch==2.14.1+rocm7.2\n', self.calls())
        self.run_shell(self.BENCH_STUB + 'bench_provision cpu')
        self.assertIn('--index-url https://download.pytorch.org/whl/cpu torch==2.14.0+cpu\n', self.calls())

    def test_bench_venv_on_the_pins_that_passes_the_smoke_is_left_alone(self):
        self.bench_setup()
        self.run_shell(self.BENCH_STUB + 'bench_provision')
        venv = self.root / 'venvs/ocannl-bench'
        target = os.readlink(venv)
        req = self.root / 'venvs/ocannl-bench.requirements.txt'
        stamp = req.stat().st_mtime_ns
        (self.root / 'calls').unlink()
        self.run_shell(self.BENCH_STUB + 'bench_provision')
        calls = self.calls()
        self.assertNotIn('pip install', calls)
        self.assertNotIn('venv ', calls)
        self.assertNotIn('scp ', calls)
        self.assertIn('smoke ', calls)
        self.assertEqual(os.readlink(venv), target)
        self.assertEqual(req.stat().st_mtime_ns, stamp)
        self.assertEqual(self.venv_dirs(), sorted(['ocannl-bench', target, 'ocannl-bench.lock',
                                                   'ocannl-bench.requirements.txt']))

    def test_bench_hand_built_venv_on_the_pins_is_left_a_real_directory(self):
        self.bench_setup()
        self.run_shell(self.BENCH_STUB + 'mkvenv "$BENCH_VENV" ' + self.NVIDIA_PINS + '; bench_provision')
        self.assertNotIn('pip install', self.calls())
        self.assertFalse((self.root / 'venvs/ocannl-bench').is_symlink())

    def test_bench_failed_smoke_leaves_the_old_venv(self):
        self.bench_setup()
        old = 'mkvenv "$BENCH_VENV" numpy==2.5.3 torch==2.13.0+rocm7.1; echo KEEP > "$BENCH_VENV.requirements.txt"; '
        result = self.run_shell(self.BENCH_STUB + old + 'uname() { echo Linux; }; FAKE_SMOKE_FAIL=1 bench_venv_only nvidia', False)
        self.assertIn('failed the nvidia smoke', result.stderr)
        self.assertIn('pip install', self.calls())
        venv = self.root / 'venvs/ocannl-bench'
        self.assertFalse(venv.is_symlink())
        self.assertEqual((venv / 'installed').read_text(), 'numpy==2.5.3\ntorch==2.13.0+rocm7.1\n')
        self.assertEqual(self.venv_dirs(), ['ocannl-bench', 'ocannl-bench.lock', 'ocannl-bench.requirements.txt'])
        self.assertEqual((self.root / 'venvs/ocannl-bench.requirements.txt').read_text(), 'KEEP\n')
        self.assertFalse((self.root / 'ocannl/benchmarks/.venv').exists())

    def test_bench_failed_install_leaves_the_old_venv(self):
        self.bench_setup()
        old = 'mkvenv "$BENCH_VENV" numpy==2.5.3; '
        result = self.run_shell(self.BENCH_STUB + old + 'uname() { echo Linux; }; FAKE_PIP_FAIL=1 bench_venv_only nvidia', False)
        self.assertIn('is unchanged', result.stderr)
        self.assertEqual(self.venv_dirs(), ['ocannl-bench', 'ocannl-bench.lock'])

    def test_bench_matching_venv_that_fails_the_smoke_is_rebuilt_and_kept_for_rollback(self):
        self.bench_setup()
        self.run_shell(self.BENCH_STUB + 'mkvenv "$BENCH_VENV" ' + self.NVIDIA_PINS +
                       '; touch "$BENCH_VENV/smoke-fails"; bench_provision')
        self.assertIn('pip install', self.calls())
        dirs = self.venv_dirs()
        retired = [d for d in dirs if d.startswith('ocannl-bench-retired-')]
        self.assertEqual(len(retired), 1)
        self.assertTrue((self.root / 'venvs' / retired[0] / 'smoke-fails').exists())
        self.assertTrue((self.root / 'venvs/ocannl-bench').is_symlink())

    def test_bench_rebuild_keeps_only_the_previous_venv(self):
        self.bench_setup()
        self.run_shell(self.BENCH_STUB + 'mkvenv "$BENCH_VENV" numpy==2.5.3; bench_provision')
        first = os.readlink(self.root / 'venvs/ocannl-bench')
        self.run_shell(self.BENCH_STUB + 'bench_provision cpu')
        second = os.readlink(self.root / 'venvs/ocannl-bench')
        self.assertNotEqual(first, second)
        self.assertEqual(self.venv_dirs(), sorted(['ocannl-bench', first, second, 'ocannl-bench.lock',
                                                   'ocannl-bench.requirements.txt']))
        self.assertIn('torch==2.14.0+cpu', (self.root / 'venvs/ocannl-bench.requirements.txt').read_text())

    def test_bench_fixtures_install_only_recorded_bytes_and_never_replace(self):
        self.bench_setup(fixtures=('a', 'b', 'c'), recorded=('a', 'b'))
        fixtures = self.root / 'ocannl/benchmarks/fixtures'
        (fixtures / 'a.safetensors').write_text('this box own bytes\n')
        result = self.run_shell(self.BENCH_STUB + 'bench_provision', False)
        self.assertIn('matching nothing', result.stderr)
        self.assertIn('c.safetensors', result.stderr)
        self.assertEqual((fixtures / 'a.safetensors').read_text(), 'this box own bytes\n')
        self.assertEqual((fixtures / 'b.safetensors').read_text(), 'fixture b\n')
        self.assertFalse((fixtures / 'c.safetensors').exists())
        self.assertNotIn('a.safetensors', ''.join(l for l in self.calls().splitlines() if l.startswith('scp')))
        self.assertEqual([p.name for p in fixtures.glob('.incoming*')], [])

    def test_bench_fixture_names_outside_the_allowlist_are_refused(self):
        self.bench_setup()
        (self.root / 'anchor/benchmarks/fixtures/bad name.safetensors').write_text('x\n')
        result = self.run_shell(self.BENCH_STUB + 'bench_provision', False)
        self.assertIn('Refusing anchor fixture name', result.stderr)
        self.assertEqual([p.name for p in (self.root / 'ocannl/benchmarks/fixtures').glob('.incoming*')], [])

    def test_bench_without_the_checkout_skips_link_and_fixtures(self):
        self.bench_setup()
        out = self.run_shell(self.BENCH_STUB + 'BENCH_CHECKOUT=$PWD/none; bench_provision').stdout
        self.assertIn('skipping', out)
        self.assertNotIn('ssh ', self.calls())

    def test_bench_foreign_checkout_venv_is_left_with_a_warning(self):
        self.bench_setup()
        (self.root / 'ocannl/benchmarks/.venv').mkdir()
        out = self.run_shell(self.BENCH_STUB + 'bench_provision').stdout
        self.assertIn('WARNING: ' + str(self.root) + '/ocannl/benchmarks/.venv is not a symlink', out)
        self.assertTrue((self.root / 'ocannl/benchmarks/.venv').is_dir())

    def test_bench_dev_headers_installed_with_sudo_else_named(self):
        self.bench_setup()
        (self.root / 'include/Python.h').unlink()
        out = self.run_shell(self.BENCH_STUB + 'bench_provision').stdout
        self.assertNotIn('apt-get', self.calls())
        self.assertIn('WARNING: No ' + str(self.root) + '/include/Python.h', out)
        self.assertIn('sudo apt-get install -y python3-dev', out)
        out = self.run_shell(self.BENCH_STUB + 'SUDO_N_RC=0 bench_provision').stdout
        self.assertIn('sudo apt-get install -y python3-dev', self.calls())
        self.assertNotIn('WARNING', out)

    def test_bench_venv_only_refuses_before_any_work(self):
        stub = self.BENCH_STUB + 'uname() { echo Linux; }; '
        self.run_shell(stub + 'bench_venv_only rocm', False)
        self.run_shell(stub + 'bench_venv_only nvidia extra', False)
        self.run_shell(self.BENCH_STUB + 'uname() { echo Darwin; }; bench_venv_only', False)
        self.assertEqual(self.calls(), '')

    # The box check (ludics-lite#641): origin is a real git repository whose benchmarks/check-box.sh
    # records where it ran from and its arguments, then exits FAKE_CHECK_RC; the box's checkout holds
    # a stale one that must never run.
    FAKE_CHECK_BOX = r"""#!/bin/sh
printf '%s\n' "$0" "$@" > "$CHECK_ARGS"
echo "check-box: stub: ${FAKE_CHECK_RC:-0}"
exit "${FAKE_CHECK_RC:-0}"
"""

    def check_setup(self):
        self.bench_setup()
        origin = self.root / 'origin'
        (origin / 'benchmarks').mkdir(parents=True)
        (origin / 'benchmarks/check-box.sh').write_text(self.FAKE_CHECK_BOX)
        (origin / 'README').write_text('not checked out\n')
        git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C']
        subprocess.run(git + [str(origin), 'init', '-q'], check=True)
        subprocess.run(git + [str(origin), 'add', '.'], check=True)
        subprocess.run(git + [str(origin), 'commit', '-q', '-m', 'tip'], check=True)
        self.tip_sha = subprocess.run(['git', '-C', str(origin), 'rev-parse', 'HEAD'], check=True,
                                      capture_output=True, text=True).stdout.strip()
        checkout = self.root / 'ocannl'
        (checkout / 'benchmarks/check-box.sh').write_text('#!/bin/sh\necho stale > "$CHECK_ARGS"\n')
        subprocess.run(['git', '-C', str(checkout), 'init', '-q'], check=True)
        subprocess.run(['git', '-C', str(checkout), 'remote', 'add', 'origin', 'file://' + str(origin)], check=True)
        return ('export CHECK_ARGS=$PWD/check-args FLEET_LOCAL_BOX=${ENDPOINT-minix-amd-linux}; '
                + self.BENCH_STUB + 'uname() { echo Linux; }; ')

    def check_args(self):
        path = self.root / 'check-args'
        return path.read_text().splitlines() if path.exists() else None

    def test_bench_measurement_box_maps_the_linux_endpoints_and_refuses_others(self):
        out = self.run_shell('for e in rog-nv-linux minix-amd-linux tuf-amd-linux; do bench_measurement_box "$e"; done').stdout
        self.assertEqual(out, 'rog-nv\nminix\ntuf\n')
        for endpoint in ['mac-studio', 'minix', 'rog-nv', '']:
            self.run_shell('bench_measurement_box ' + repr(endpoint), False)

    def test_bench_venv_ends_with_check_box_from_origin_tip(self):
        stub = self.check_setup()
        result = self.run_shell(stub + 'bench_venv_only')
        args = self.check_args()
        self.assertTrue(args[0].endswith('/ocannl-tip/benchmarks/check-box.sh'), args)
        self.assertEqual(args[1:], ['--box', 'minix', '--box-only', '--venv', str(self.root / 'venvs/ocannl-bench'),
                                    '--fixture-dir', str(self.root / 'ocannl/benchmarks/fixtures')])
        self.assertFalse(Path(args[0]).exists(), 'the tip clone outlived the run')
        self.assertIn(self.tip_sha, result.stdout)
        self.assertTrue(result.stdout.endswith('Box check: minix READY.\n'), result.stdout)
        self.assertLess(self.calls().index('smoke '), self.calls().index('ssh '))

    def test_bench_check_gap_and_harness_error_set_the_exit_status(self):
        stub = self.check_setup()
        result = self.run_shell(stub + 'FAKE_CHECK_RC=1 bench_venv_only', False)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn('Box check: minix GAP (exit 3)', result.stdout)
        self.assertTrue((self.root / 'venvs/ocannl-bench').is_symlink(), 'the GAP undid the provisioning')
        result = self.run_shell(stub + 'FAKE_CHECK_RC=2 bench_venv_only', False)
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        self.assertIn('Box check NOT RUN (exit 4): check-box.sh exited 2', result.stdout)

    def test_bench_check_not_run_without_an_endpoint_a_store_or_a_tip(self):
        stub = self.check_setup()
        for env, why in [('ENDPOINT=mac-studio; ', 'fleet endpoint mac-studio (FLEET_LOCAL_BOX) has no measurement-box ID'),
                         ('ENDPOINT=; ', "fleet endpoint '' (FLEET_LOCAL_BOX) has no"),
                         ('git -C ocannl remote set-url origin "file://$PWD/nowhere"; ', 'cannot check out benchmarks/check-box.sh')]:
            result = self.run_shell(env + stub + 'bench_venv_only', False)
            self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
            self.assertIn('Box check NOT RUN (exit 4): ' + why, result.stdout)
            self.assertIsNone(self.check_args())
            self.assertTrue((self.root / 'venvs/ocannl-bench').is_symlink())
        result = self.run_shell(stub + 'BENCH_CHECKOUT=$PWD/none; bench_venv_only', False)
        self.assertEqual(result.returncode, 4)
        self.assertIn('no fixture store', result.stdout)

    def test_endpoint_names_exclude_the_local_sentinel(self):
        self.run_shell('valid_endpoint rog-nv-linux && ! valid_endpoint local && ! valid_endpoint macbook-air && ! valid_endpoint user@host')

    def test_unknown_option(self):
        result = subprocess.run(['bash', str(SCRIPT), '--bogus'], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
