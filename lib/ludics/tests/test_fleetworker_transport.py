"""ludics.fleetworker.transport: the coordinator's fleet configuration on the far side (ludics-lite#632),
and the registry pin a fleet-worker.sh started there checks (config.pin_refusal)."""

import os
import shutil
import subprocess
import unittest
from collections.abc import Mapping

from ludics.fleetworker import leg, tiprun
from ludics.fleetworker.config import REGISTRY_PIN, Config, load_config, pin_refusal, registry_pin
from ludics.fleetworker.transport import FORWARDED, forwarded, prelude

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


def run_far(cfg: Config, box: str, tail: str, env: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
    """The far side's prelude and ``tail``, run here by bash as ``bash -s`` would run it on the box."""
    bash = shutil.which("bash") or "/bin/bash"
    return subprocess.run([bash, "-s"], input=prelude(cfg, box) + tail, capture_output=True, text=True,
                          env={"PATH": os.environ.get("PATH", ""), "HOME": "/home/far", **env}, check=False)


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
        self.assertEqual(pairs["FLEET_SKILLS_REPO"], "$HOME/ludics-lite")
        far = far_config(cfg, "far", BOX_ENV)
        self.assertEqual((far.slots, far.gpu_tokens, far.anchor_state), (cfg.slots, cfg.gpu_tokens, cfg.anchor_state))
        self.assertEqual(pin_refusal(far), "")

    def test_an_empty_spec_is_a_value_and_stays_one(self) -> None:
        cfg = coordinator(FLEET_BOX_CORRECTNESS_SLOTS="", FLEET_BOX_GPU_TOKENS="")
        far = far_config(cfg, "far", BOX_ENV)
        self.assertEqual((far.slots, far.gpu_tokens), ("", ""))

    def test_the_boxes_own_knobs_never_travel(self) -> None:
        cfg = coordinator(FLEET_SLOT_STATE="/hub/slots", ISSUE_WAVE_STATE="/hub/state", FLEET_SYSTEMD_INHIBIT="x",
                          FLEET_TMUX_SOCKET="s", FLEET_COORDINATOR="c", FLEET_FETCH_TIMEOUT="1")
        names = {name for name, _ in forwarded(cfg, "far")}
        for own in ("FLEET_LOCAL_BOX", "FLEET_SLOT_STATE", "ISSUE_WAVE_STATE", "FLEET_SYSTEMD_INHIBIT",
                    "FLEET_TMUX_SOCKET", "FLEET_COORDINATOR", "FLEET_FETCH_TIMEOUT"):
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


if __name__ == "__main__":
    unittest.main()
