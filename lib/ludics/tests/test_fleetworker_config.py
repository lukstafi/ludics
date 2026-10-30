"""ludics.fleetworker.config: fleet-worker.sh's knobs, read as its prelude read them."""

import unittest

from ludics.fleetworker.config import (
    DEFAULT_SLOTS,
    SpecError,
    box_correctness_slots,
    box_gpu_tokens,
    detect_local_box,
    load_config,
    local_path,
)

SCRIPT = "/repo/issue-wave/scripts/fleet-worker.sh"


class Knobs(unittest.TestCase):
    def test_the_site_slot_default_follows_the_roster_as_a_word_set(self) -> None:
        # ludics-lite#329: an exported roster equal to the default, in any order or spacing or
        # over several lines, is the default roster; a custom one has one slot everywhere.
        for boxes in (None, "tuf-amd-linux  mac-studio macbook-pro\nminix-amd-linux rog-nv-linux mac-studio"):
            env = {} if boxes is None else {"FLEET_BOXES": boxes}
            cfg = load_config(SCRIPT, env, host="h")
            self.assertTrue(cfg.default_roster, boxes)
            self.assertEqual(cfg.slots, DEFAULT_SLOTS)
            self.assertEqual(box_correctness_slots(cfg, "mac-studio"), 6)
            self.assertEqual(box_correctness_slots(cfg, "macbook-pro"), 4)
        custom = load_config(SCRIPT, {"FLEET_BOXES": "mac-studio rog-nv-linux"}, host="h")
        self.assertEqual((custom.slots, custom.gpu_tokens), ("", ""))
        self.assertEqual(box_correctness_slots(custom, "mac-studio"), 1)
        # The roster before the MacBook joined (ludics#538), as every env.sh exported it, is a
        # custom one now: why the rollout drops FLEET_BOXES from each env.sh.
        legacy = load_config(SCRIPT, {"FLEET_BOXES": "mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux"}, host="h")
        self.assertFalse(legacy.default_roster)

    def test_a_set_but_empty_spec_or_box_name_is_a_value_not_an_absence(self) -> None:
        cfg = load_config(SCRIPT, {"FLEET_BOX_CORRECTNESS_SLOTS": "", "FLEET_LOCAL_BOX": ""}, host="mac-studio")
        self.assertEqual(cfg.slots, "")
        self.assertEqual(cfg.local_box, "")
        # ...where an empty FLEET_ANCHOR (`:-`) takes the default.
        self.assertEqual(load_config(SCRIPT, {"FLEET_ANCHOR": ""}, host="h").anchor, "mac-studio")

    def test_the_hostname_map_is_globs_first_match_wins_on_the_lowercased_host(self) -> None:
        self.assertEqual(detect_local_box("nomatch*=other luk*=mac-studio *=wrong", "LukaszsacStudio"), "mac-studio")
        self.assertEqual(detect_local_box("nomatch*=testbox", "rog"), "")
        self.assertEqual(detect_local_box("noequals rog=rog-nv-linux", "rog"), "rog-nv-linux")
        cfg = load_config(SCRIPT, {}, host="LukaszsacStudio")
        self.assertEqual(cfg.local_box, "mac-studio")
        # The M4 Pro MacBook by its macOS host name (ludics#538), and never the macbook-air
        # console, which is outside the fleet.
        self.assertEqual(load_config(SCRIPT, {}, host="Lukaszs-MacBook-Pro").local_box, "macbook-pro")
        self.assertEqual(load_config(SCRIPT, {}, host="Lukaszs-MacBook-Air").local_box, "")

    def test_the_checkout_is_physical_and_here_is_the_scripts_directory(self) -> None:
        cfg = load_config("/tmp/../tmp/x/issue-wave/scripts/fleet-worker.sh", {}, host="h")
        self.assertTrue(cfg.here.endswith("/x/issue-wave/scripts"))
        self.assertTrue(cfg.checkout.endswith("/x"))

    def test_local_path_expands_only_a_leading_literal_home(self) -> None:
        env = {"HOME": "/home/u"}
        self.assertEqual(local_path("$HOME/.local/state", env), "/home/u/.local/state")
        self.assertEqual(local_path("/abs/$HOME/x", env), "/abs/$HOME/x")


class Specs(unittest.TestCase):
    def test_a_repeated_box_keeps_its_last_value_as_the_registry_does(self) -> None:
        cfg = load_config(SCRIPT, {"FLEET_BOXES": "testbox other", "FLEET_BOX_CORRECTNESS_SLOTS": "testbox=6 testbox=1"}, host="h")
        self.assertEqual(box_correctness_slots(cfg, "testbox"), 1)

    def test_a_malformed_entry_anywhere_refuses(self) -> None:
        for spec, want in (
            ("testbox=2 other=0", "FLEET_BOX_CORRECTNESS_SLOTS entry must be <box>=<positive n>: other=0"),
            ("testbox=x", "must be <box>=<positive n>: testbox=x"),
            ("testbox", "must be <box>=<positive n>: testbox"),
            ("testbox=2 stale-box=1", "FLEET_BOX_CORRECTNESS_SLOTS names stale-box, which is not in FLEET_BOXES"),
        ):
            cfg = load_config(SCRIPT, {"FLEET_BOXES": "testbox other", "FLEET_BOX_CORRECTNESS_SLOTS": spec}, host="h")
            with self.assertRaises(SpecError) as caught:
                box_correctness_slots(cfg, "testbox")
            self.assertIn(want, str(caught.exception))

    def test_gpu_tokens_default_to_one_per_slot_and_need_a_valid_slot_spec(self) -> None:
        env = {"FLEET_BOXES": "testbox other", "FLEET_BOX_CORRECTNESS_SLOTS": "testbox=3"}
        self.assertEqual(box_gpu_tokens(load_config(SCRIPT, env, host="h"), "testbox"), 3)
        narrowed = load_config(SCRIPT, {**env, "FLEET_BOX_GPU_TOKENS": "testbox=1"}, host="h")
        self.assertEqual(box_gpu_tokens(narrowed, "testbox"), 1)
        broken = load_config(SCRIPT, {**env, "FLEET_BOX_CORRECTNESS_SLOTS": "testbox=0"}, host="h")
        with self.assertRaises(SpecError):
            box_gpu_tokens(broken, "testbox")


if __name__ == "__main__":
    unittest.main()
