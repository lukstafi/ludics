"""ludics.fleetworker.transport: the coordinator's fleet configuration on the far side (ludics-lite#632),
the registry pin a fleet-worker.sh started there checks (config.pin_refusal), and a shipped program's
payload on its fd 3 (ludics-lite#636)."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Mapping
from unittest import mock

from ludics.fleetworker import board, boardstore, execution, leg, registry, tiprun
from ludics.fleetworker.config import REGISTRY_PIN, Config, load_config, pin_refusal, registry_pin
from ludics.fleetworker.transport import FORWARDED, PAYLOAD_ON_FD, Done, forwarded, prelude, run_on

SCRIPT = "/repo/issue-wave/scripts/fleet-worker.sh"
# A box's own ~/.config/fleet/env.sh, every forwarded knob set to something else.
BOX_ENV = {
    "FLEET_BOXES": "elsewhere",
    "FLEET_HOSTNAME_MAP": "*=elsewhere",
    "FLEET_ANCHOR": "nowhere",
    "FLEET_ANCHOR_STATE": "/not/the/registry",
    "FLEET_LAB_HOST": "nowhere",
    "FLEET_BOX_CORRECTNESS_SLOTS": "elsewhere=1",
    "FLEET_BOX_GPU_TOKENS": "elsewhere=1",
    "FLEET_SKILLS_REPO": "/elsewhere/skills",
}


def coordinator(**env: str) -> Config:
    return load_config(SCRIPT, {"FLEET_LOCAL_BOX": "hub", **env}, host="h")


def far_config(cfg: Config, box: str, box_env: Mapping[str, str]) -> Config:
    """What a fleet-worker.sh started by ``fleet_worker`` on the box reads: the box's environment,
    the forwarded pairs over it."""
    return load_config(SCRIPT, {**box_env, **dict(forwarded(cfg, box))}, host="far")


def run_far(cfg: Config, box: str, tail: str, env: Mapping[str, str],
            *, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    """The far side's prelude and ``tail``, run here by bash as ``bash -s`` would run it on the box."""
    bash = shutil.which("bash") or "/bin/bash"
    return subprocess.run([bash, "-s"], input=prelude(cfg, box) + tail, capture_output=True, text=True,
                          env={"PATH": os.environ.get("PATH", ""), "HOME": "/home/far", **env},
                          check=False, timeout=timeout)


class Forwarded(unittest.TestCase):
    def test_a_far_fleet_worker_resolves_every_fact_as_the_coordinator_does(self) -> None:
        cfg = coordinator(FLEET_BOXES="hub far", FLEET_ANCHOR="hub", FLEET_ANCHOR_STATE="/srv/registry",
                          FLEET_BOX_CORRECTNESS_SLOTS="far=2", FLEET_BOX_GPU_TOKENS="far=1", FLEET_LAB_HOST="far",
                          FLEET_HOSTNAME_MAP="far*=far", FLEET_SKILLS_REPO="/opt/skills")
        far = far_config(cfg, "far", BOX_ENV)
        for name in ("boxes", "hostname_map", "anchor", "anchor_state", "lab_host", "slots", "gpu_tokens", "skills_repo"):
            self.assertEqual(getattr(far, name), getattr(cfg, name), name)
        self.assertEqual(pin_refusal(far), "")

    def test_the_defaults_travel_resolved_and_unexpanded(self) -> None:
        # The default roster's slot spec is the coordinator's resolution, and an unset anchor state
        # is ISSUE_WAVE_STATE's literal $HOME path: it names a directory ON THE ANCHOR, so the box in
        # between never expands it with its own HOME.
        cfg = coordinator()
        pairs = dict(forwarded(cfg, "far"))
        self.assertEqual(list(pairs), [*FORWARDED, REGISTRY_PIN])
        self.assertEqual(pairs["FLEET_ANCHOR_STATE"], "$HOME/.local/state/issue-wave")
        self.assertEqual(pairs["FLEET_SKILLS_REPO"], "$HOME/ludics")
        far = far_config(cfg, "far", BOX_ENV)
        self.assertEqual((far.slots, far.gpu_tokens, far.anchor_state), (cfg.slots, cfg.gpu_tokens, cfg.anchor_state))
        self.assertEqual(pin_refusal(far), "")

    def test_an_empty_spec_is_a_value_and_stays_one(self) -> None:
        cfg = coordinator(FLEET_BOX_CORRECTNESS_SLOTS="", FLEET_BOX_GPU_TOKENS="")
        far = far_config(cfg, "far", BOX_ENV)
        self.assertEqual((far.slots, far.gpu_tokens), ("", ""))

    def test_the_boxes_own_knobs_never_travel(self) -> None:
        cfg = coordinator(FLEET_SLOT_STATE="/hub/slots", ISSUE_WAVE_STATE="/hub/state", FLEET_SYSTEMD_INHIBIT="x",
                          FLEET_CAFFEINATE="y", FLEET_TMUX_SOCKET="s", FLEET_COORDINATOR="c", FLEET_FETCH_TIMEOUT="1")
        names = {name for name, _ in forwarded(cfg, "far")}
        for own in ("FLEET_LOCAL_BOX", "FLEET_SLOT_STATE", "ISSUE_WAVE_STATE", "FLEET_SYSTEMD_INHIBIT",
                    "FLEET_CAFFEINATE", "FLEET_TMUX_SOCKET", "FLEET_COORDINATOR", "FLEET_FETCH_TIMEOUT"):
            self.assertNotIn(own, names)
        # ISSUE_WAVE_STATE reaches the far side only as the anchor state it defaults.
        self.assertEqual(dict(forwarded(cfg, "far"))["FLEET_ANCHOR_STATE"], "/hub/state")

    def test_a_local_anchor_travels_as_the_coordinators_box_name(self) -> None:
        cfg = coordinator(FLEET_ANCHOR="local", FLEET_LAB_HOST="local")
        pairs = dict(forwarded(cfg, "far"))
        self.assertEqual((pairs["FLEET_ANCHOR"], pairs["FLEET_LAB_HOST"]), ("hub", "hub"))
        self.assertEqual(pairs[REGISTRY_PIN], registry_pin("hub", cfg.anchor_state))
        # To the coordinator's own box, `local` means what it says.
        self.assertEqual(dict(forwarded(cfg, "hub"))["FLEET_ANCHOR"], "local")
        self.assertEqual(pin_refusal(load_config(SCRIPT, {"FLEET_LOCAL_BOX": "hub", **dict(forwarded(cfg, "hub"))}, host="h")), "")


class FleetWorker(unittest.TestCase):
    def test_only_the_started_process_gets_the_coordinators_knobs(self) -> None:
        cfg = coordinator(FLEET_ANCHOR="hub", FLEET_BOXES="hub far")
        done = run_far(cfg, "far", 'fleet_worker sh -c \'echo "$FLEET_ANCHOR|$FLEET_BOXES"\'\nprintf "shell=%s\\n" "$(printenv FLEET_ANCHOR)"\n',
                       BOX_ENV)
        self.assertEqual(done.returncode, 0, done.stderr)
        # The far shell keeps the box's own: a launch's tmux server started from it never holds them.
        self.assertEqual(done.stdout, "hub|hub far\nshell=nowhere\n")

    def test_a_local_anchor_with_no_name_to_give_refuses_the_start(self) -> None:
        cfg = load_config(SCRIPT, {"FLEET_LOCAL_BOX": "", "FLEET_ANCHOR": "local"}, host="h")
        done = run_far(cfg, "far", "fleet_worker echo started\necho \"after=$?\"\n", BOX_ENV)
        self.assertEqual(done.stdout, "after=2\n", "nothing starts, the far side goes on to say so")
        self.assertIn("fleet-worker.sh not started on far: the coordinator's FLEET_ANCHOR is local", done.stderr)
        # Its own box still runs it: `local` is the same box there.
        self.assertEqual(run_far(cfg, "local", "fleet_worker echo started\n", {}).stdout, "started\n")


    def test_the_far_sides_that_start_fleet_worker_go_through_it(self) -> None:
        # The leg's slot or hold (its nested slots inherit from it) and tip-run's slot --bg: the two
        # far sides that start a fleet-worker.sh (the shell suite drives the leg's over ssh).
        self.assertIn('fleet_worker "${wrap[@]}" -- bash "$results.sh"', leg.LEG)
        self.assertIn('dir=$(fleet_worker "$fw" execution slot --bg', tiprun.FAR)


HOLD_LOCK_GUARD = r"""
hold_lock_guard() {
  perl -MFcntl=:flock -e '
    open my $dir, "<", $ARGV[0] or exit 1;
    flock($dir, LOCK_EX) or exit 2;
    open my $ready, ">", $ARGV[1] or exit 3;
    close $ready;
    sleep 8;
  ' "$1" "$1.ready" >/dev/null 2>&1 &
  guard=$!
  for _ in $(seq 40); do [ -f "$1.ready" ] && return 0; sleep 0.1; done
  return 1
}
"""


class TakeLock(unittest.TestCase):
    def test_release_after_failed_mkdir_is_retried_with_zero_wait(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, "lock")
            os.mkdir(lock)
            done = run_far(coordinator(), "far", r"""
mkdir() {
  command mkdir "$@" && return 0
  rmdir "$1" || exit 2
  return 1
}
take_lock "$LOCK" 0 fixture || exit $?
test -f "$LOCK/pid" && test -f "$LOCK/start"
""", {"LOCK": lock}, timeout=5)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(done.stdout, "")

    def test_uncreatable_lock_exhausts_three_retries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            parent = os.path.join(tmp, "file")
            with open(parent, "w", encoding="utf-8"):
                pass
            done = run_far(coordinator(), "far", r"""
attempts=0
mkdir() {
  attempts=$((attempts + 1))
  command mkdir "$@"
}
take_lock "$LOCK" 0 fixture
rc=$?
printf 'attempts=%s\n' "$attempts"
exit "$rc"
""", {"LOCK": os.path.join(parent, "lock")}, timeout=5)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertRegex(done.stdout, r"^fixture: cannot create lock .* \(unwritable\?\)\n")
        self.assertTrue(done.stdout.endswith("\nattempts=4\n"), done.stdout)

    def test_rechecks_an_ownerless_lock_that_becomes_fresh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, "lock")
            os.mkdir(lock)
            done = run_far(coordinator(), "far", r"""
mtime() {
  if [ ! -e "$LOCK.observed" ]; then
    # The directory changes after this read snapshots its old age.
    touch "$LOCK" "$LOCK.observed" || return 1
    printf '1\n'
  else
    now
  fi
}
take_lock "$LOCK" 0 fixture
rc=$?
test -f "$LOCK.observed" && test ! -e "$LOCK/pid" && test ! -e "$LOCK/start" || exit 8
exit "$rc"
""", {"LOCK": lock}, timeout=5)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("held for 0s", done.stdout)

    def test_guard_failure_preserves_a_stale_lock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, "lock")
            done = run_far(coordinator(), "far", r"""
mkdir "$LOCK" || exit 8
printf '%s\n' "$$" > "$LOCK/pid"
printf '%s\n' 'stale start' > "$LOCK/start"
perl() { return 1; }
take_lock "$LOCK" 0 fixture
rc=$?
test "$(cat "$LOCK/pid")" = "$$" && test "$(cat "$LOCK/start")" = 'stale start' || exit 8
exit "$rc"
""", {"LOCK": lock}, timeout=5)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("directory flock or metadata write failed", done.stdout)

    def test_busy_guard_charges_the_contenders_wait(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, "lock")
            done = run_far(coordinator(), "far", HOLD_LOCK_GUARD + r"""
mkdir "$LOCK" || exit 8
printf '%s\n' "$$" > "$LOCK/pid"
printf '%s\n' 'stale start' > "$LOCK/start"
hold_lock_guard "$LOCK" || exit 8
take_lock "$LOCK" 0 reclaim; reclaim_rc=$?
# The uutils mkdir race can send a contender directly to registration.
mkdir() { return 0; }
take_lock "$LOCK" 0 register; register_rc=$?
alive=0; kill -0 "$guard" 2>/dev/null && alive=1
kill "$guard" 2>/dev/null
wait "$guard" 2>/dev/null
[ "$reclaim_rc" = 1 ] && [ "$register_rc" = 1 ] && [ "$alive" = 1 ] || exit 8
test "$(cat "$LOCK/pid")" = "$$" && test "$(cat "$LOCK/start")" = 'stale start'
""", {"LOCK": lock}, timeout=15)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertRegex(done.stdout, r"(?m)^reclaim: .* held by pid [0-9]+ for 0s")
        self.assertRegex(done.stdout, r"(?m)^register: .* held by pid [0-9]+ for 0s")

    def test_busy_guard_does_not_leave_a_successful_mkdir_behind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, "lock")
            done = run_far(coordinator(), "far", HOLD_LOCK_GUARD + r"""
mkdir() {
  command mkdir "$@" || return 1
  hold_lock_guard "$1" || exit 8
  trap 'kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null' EXIT
}
take_lock "$LOCK" 0 first; first_rc=$?
test "$first_rc" = 1 && test ! -e "$LOCK" || exit 8
unset -f mkdir
# The next claimant can use a new inode even while the guard on the old inode is held.
kill -0 "$guard" && take_lock "$LOCK" 0 successor || exit 8
test -s "$LOCK/pid" && test -s "$LOCK/start" && release_lock "$LOCK"
""", {"LOCK": lock}, timeout=15)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertRegex(done.stdout, r"^first: .* held for 0s")

    def test_relative_paths_work_for_registration_and_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            done = run_far(coordinator(), "far", r"""
CDPATH= cd "$WORK" && mkdir "relative state" || exit 8
lock="relative state/lock"
take_lock "$lock" 0 fixture || exit $?
test -s "$lock/pid" && test -s "$lock/start" || exit 8
release_lock "$lock" && test ! -e "$lock"
""", {"WORK": tmp}, timeout=5)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(done.stdout, "")


class Pin(unittest.TestCase):
    def test_a_box_that_resolves_another_registry_refuses(self) -> None:
        pin = registry_pin("hub", "/srv/registry")
        self.assertEqual(pin_refusal(load_config(SCRIPT, {REGISTRY_PIN: pin, "FLEET_ANCHOR": "hub", "FLEET_ANCHOR_STATE": "/srv/registry"}, host="h")), "")
        moved = pin_refusal(load_config(SCRIPT, {REGISTRY_PIN: pin, "FLEET_ANCHOR": "nowhere", "FLEET_ANCHOR_STATE": "/srv/registry"}, host="h"))
        self.assertIn("as anchor nowhere, state /srv/registry, but the coordinator that started it reads anchor hub, state /srv/registry", moved)
        restated = pin_refusal(load_config(SCRIPT, {REGISTRY_PIN: pin, "FLEET_ANCHOR": "hub", "ISSUE_WAVE_STATE": "/other"}, host="h"))
        self.assertIn("state /other, but", restated)

    def test_no_pin_is_no_check(self) -> None:
        self.assertEqual(pin_refusal(load_config(SCRIPT, {"FLEET_ANCHOR": "anything"}, host="h")), "")

    def test_a_local_anchor_on_the_named_box_is_that_box(self) -> None:
        env = {REGISTRY_PIN: registry_pin("hub", "$HOME/.local/state/issue-wave"), "FLEET_ANCHOR": "local", "FLEET_LOCAL_BOX": "hub"}
        self.assertEqual(pin_refusal(load_config(SCRIPT, env, host="h")), "")

    def test_an_unreadable_pin_refuses(self) -> None:
        for pin in ("", "not json", '["hub"]', '["hub", 1]', '{"a": "b"}', '["a", "b", "c"]'):
            refusal = pin_refusal(load_config(SCRIPT, {REGISTRY_PIN: pin}, host="h"))
            self.assertIn("an unreadable pin", refusal, pin)


class ShippedPayload(unittest.TestCase):
    """ludics-lite#636: a shipped program's payload rides the far-side script to its fd 3, never one
    argv word, so a payload past Linux's 128 KiB single-argument cap reaches the anchor whole."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-shipped-test."))
        self.cfg = coordinator(FLEET_ANCHOR="local", FLEET_ANCHOR_STATE=self.root)
        # The far side's interpreter is this one, whatever the box's PATH offers.
        self.env = mock.patch.dict(os.environ, {"LUDICS_PY_CANDIDATES": sys.executable})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        shutil.rmtree(self.root)

    def registry(self, action: str, payload: object) -> Done:
        script = prelude(self.cfg, "local") + "shift 3\n" + execution.registry_command(execution.registry_source(), json.dumps(payload))
        args = ["EXECUTION", "x", "x", action, "owner", "token", PAYLOAD_ON_FD, "mac"]
        self.assertLess(max(len(a) for a in args), 64)
        return run_on(self.cfg, "local", script, args, capture=True)

    def test_a_200_kib_evidence_concludes_a_record_through_the_far_side(self) -> None:
        reserve = dict(request_id="big", wave="w", worker="big", transport="subagent", issue="o/r#1", purpose="unit",
                       agent_host="mac", execution_host="mac", repository="o/r", requested_revision="origin/main",
                       kind="correctness")
        self.assertEqual(self.registry("reserve", reserve).rc, 0)
        evidence = "x" * (200 * 1024)
        done = self.registry("conclude", dict(request_id="big", verdict="not-launched", log="/dev/null", evidence=evidence))
        self.assertEqual(done.rc, 0, done.out[-400:])
        record = json.loads(done.out)
        self.assertEqual((record["state"], record["history"][-1]["data"]["evidence"]), ("concluded", evidence))

    def test_hostile_payload_text_round_trips_and_nothing_in_it_runs(self) -> None:
        # Every line the far side's here-documents end at, a line break, the shell's metacharacters
        # and text past ASCII, inside one board value of over 128 KiB.
        hostile = "\nFLEET_BOARD_PY_PAYLOAD\nFLEET_BOARD_PY\n'q' \"dq\" $(touch pwned) `touch pwned` \\ ü\n" * 2000
        self.assertGreater(len(hostile), 128 * 1024)
        raw = json.dumps({"wave": "w", "create": True, "fields": [["k", hostile]]})
        script = prelude(self.cfg, "local") + "shift 3\n" + board.store_command(raw)
        done = run_on(self.cfg, "local", script, ["BOARD", "x", "x", "note", "coord", PAYLOAD_ON_FD], capture=True)
        self.assertEqual(done.rc, 0, done.out)
        with open(os.path.join(self.root, "boards", "w.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["notes"]["k"], hostile)
        self.assertFalse(os.path.exists("pwned") or os.path.exists(os.path.join(self.root, "pwned")))

    def test_the_payload_word_with_no_fd_3_is_a_refusal(self) -> None:
        calls = (([registry.__file__, self.root, "list", "o", "t", PAYLOAD_ON_FD, "mac"], "EXECUTION"),
                 ([boardstore.__file__, self.root, "show", "o", PAYLOAD_ON_FD], "BOARD"))
        for argv, label in calls:
            # subprocess closes every descriptor past stderr, so fd 3 is not open in the child.
            done = subprocess.run([sys.executable, *argv], capture_output=True, text=True, check=False)
            self.assertEqual(done.returncode, 1, done.stderr)
            self.assertIn(f"{label} REFUSED: payload `-` names file descriptor 3, which cannot be read", done.stderr)

    def test_the_callers_put_only_the_payload_word_on_argv(self) -> None:
        with mock.patch.object(board, "run_on", return_value=Done(0, "")) as sent, \
                mock.patch.object(board, "check_identity"), mock.patch.object(board, "my_token", return_value="t"), \
                mock.patch.object(board, "coordinator_id", return_value="c"):
            board.cmd_board(self.cfg, ["log", "w", "y" * 200_000])
        _, _, script, argv = sent.call_args.args
        self.assertEqual(argv[-1], PAYLOAD_ON_FD)
        self.assertIn("y" * 200_000, script)
        with mock.patch.object(execution, "run_on", return_value=Done(0, "[]")) as sent:
            execution.listing(self.cfg)
        self.assertEqual(sent.call_args.args[3][6], PAYLOAD_ON_FD)


if __name__ == "__main__":
    unittest.main()
