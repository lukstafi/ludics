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
            text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_import_has_no_install_side_effects(self):
        self.run_shell(':')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_skill_link_rerun(self):
        self.run_shell('mkdir src; link_skill "$PWD/src" "$PWD/link"; link_skill "$PWD/src" "$PWD/link"')
        self.assertTrue((self.root / 'link').is_symlink())
        self.assertEqual(list((self.root / 'src').iterdir()), [])

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
        self.run_shell('git init -q repo; git -C repo remote add origin https://github.com/other/repo.git; clone_if_missing lukstafi/ludics-lite "$PWD/repo"', False)
        self.assertTrue((self.root / 'repo/.git').is_dir())

    def test_dirty_repository_preserved(self):
        self.run_shell('git init -q repo; git -C repo remote add origin https://github.com/lukstafi/ludics-lite.git; echo KEEP > repo/local; clone_if_missing lukstafi/ludics-lite "$PWD/repo"')
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

    def test_endpoint_names_exclude_the_local_sentinel(self):
        self.run_shell('valid_endpoint rog-nv-linux && ! valid_endpoint local && ! valid_endpoint macbook-air && ! valid_endpoint user@host')

    def test_unknown_option(self):
        result = subprocess.run(['bash', str(SCRIPT), '--bogus'], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
