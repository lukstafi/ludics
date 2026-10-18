"""fleet-worker.sh's source-time constants, read from the environment as the shell's prelude reads them.

Every knob is documented in fleet-worker.sh's header (the ``Env:`` block); the comments there carry
the incident history behind each default. What is ported here, and from where:

  Config / load_config     the assignments at the top of the shell's brace group (HOSTNAME_MAP,
                           LOCAL_BOX, ANCHOR, LAB_HOST, BOXES, DEFAULT_ROSTER, SLOTS, GPU_TOKENS,
                           SKILLS_REPO, STATE, SLOT_STATE, INHIBIT, ANCHOR_STATE, TMUX_SOCKET,
                           FEEDER_WAIT, CHECKOUT), with ``${X:-d}`` and ``${X-d}`` kept apart:
                           an empty FLEET_LOCAL_BOX or slot spec is a value, not an absence
  detect_local_box         ``detect_local_box``
  roster_words             ``roster_words``
  local_path               ``local_path``
  in_roster / box_spec_count / box_correctness_slots / box_gpu_tokens
                           the ``<box>=<n>`` spec readers, the registry's grammar (a repeated box
                           keeps its LAST value, as the registry's dict does)

The script's own path is the forwarder's first argument (``"$0"``): ``here`` is its directory as
``cd "$(dirname "$0")" && pwd`` gives it (logical), and ``checkout`` the skills checkout by its
PHYSICAL path, as ``cd -P "$(dirname "$0")/../.."`` gives it -- the script is reached through the
``~/.claude/skills/issue-wave`` symlink, and ship-pr's and wake-lab's scripts are found from there.
"""

import fnmatch
import json
import os
import shlex
import socket
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast

DEFAULT_BOXES = "mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux"
DEFAULT_HOSTNAME_MAP = (
    "*mac-studio*=mac-studio lukaszsacstudio*=mac-studio rog-nv*=rog-nv-linux rog=rog-nv-linux "
    "minix*=minix-amd-linux tuf*=tuf-amd-linux"
)
DEFAULT_SLOTS = "mac-studio=6 rog-nv-linux=4 minix-amd-linux=4 tuf-amd-linux=3"
GPU_TOKENS_DEFAULT = "rog-nv-linux=2"


def _or_default(env: Mapping[str, str], name: str, default: str) -> str:
    """``${NAME:-default}``: unset and empty both take the default."""
    return env.get(name) or default


def _unset_default(env: Mapping[str, str], name: str, default: str) -> str:
    """``${NAME-default}``: only an UNSET variable takes the default; empty is a value."""
    value = env.get(name)
    return default if value is None else value


def short_hostname() -> str:
    """``hostname -s``: the host name up to its first dot."""
    return socket.gethostname().split(".")[0]


def detect_local_box(hostname_map: str, host: str) -> str:
    """The first ``<glob>=<box>`` pair whose glob matches the lowercased short host name."""
    lowered = host.lower()
    for pair in hostname_map.split():
        if "=" not in pair:
            continue
        pattern, _, box = pair.partition("=")
        if fnmatch.fnmatchcase(lowered, pattern):
            return box
    return ""


def roster_words(roster: str) -> list[str]:
    """A roster as a word SET, sorted: order, spacing, lines and repeats ignored (ludics-lite#329)."""
    return sorted(set(roster.split()))


def local_path(value: str, env: Mapping[str, str]) -> str:
    """A configured path expanded on THIS box: a leading literal ``$HOME/`` becomes HOME."""
    if value.startswith("$HOME/"):
        return env.get("HOME", "") + "/" + value[len("$HOME/") :]
    return value


@dataclass(frozen=True)
class Config:
    script: str
    here: str
    checkout: str
    hostname_map: str
    local_box: str
    anchor: str
    lab_host: str
    boxes: str
    default_roster: bool
    slots: str
    gpu_tokens: str
    skills_repo: str
    state: str
    slot_state: str
    inhibit: str
    anchor_state: str
    tmux_socket: str
    feeder_wait: str
    lock_wait: str
    env: Mapping[str, str]

    def path(self, value: str) -> str:
        return local_path(value, self.env)


def load_config(script: str, env: Mapping[str, str], host: str | None = None) -> Config:
    hostname_map = _or_default(env, "FLEET_HOSTNAME_MAP", DEFAULT_HOSTNAME_MAP)
    if "FLEET_LOCAL_BOX" in env:
        local_box = env["FLEET_LOCAL_BOX"]
    else:
        local_box = detect_local_box(hostname_map, short_hostname() if host is None else host)
    boxes = _or_default(env, "FLEET_BOXES", DEFAULT_BOXES)
    default_roster = roster_words(boxes) == roster_words(DEFAULT_BOXES)
    state = _or_default(env, "ISSUE_WAVE_STATE", "$HOME/.local/state/issue-wave")
    directory = os.path.dirname(script) or "."
    return Config(
        script=script,
        here=os.path.abspath(directory),
        checkout=os.path.realpath(os.path.join(directory, "..", "..")),
        hostname_map=hostname_map,
        local_box=local_box,
        anchor=_or_default(env, "FLEET_ANCHOR", "mac-studio"),
        lab_host=_or_default(env, "FLEET_LAB_HOST", "mac-studio"),
        boxes=boxes,
        default_roster=default_roster,
        slots=_unset_default(
            env, "FLEET_BOX_CORRECTNESS_SLOTS", DEFAULT_SLOTS if default_roster else ""
        ),
        gpu_tokens=_unset_default(
            env, "FLEET_BOX_GPU_TOKENS", GPU_TOKENS_DEFAULT if default_roster else ""
        ),
        skills_repo=_or_default(env, "FLEET_SKILLS_REPO", "$HOME/ludics-lite"),
        state=state,
        slot_state=_or_default(env, "FLEET_SLOT_STATE", "$HOME/.local/state/fleet-execution-slots"),
        inhibit=_or_default(env, "FLEET_SYSTEMD_INHIBIT", "systemd-inhibit"),
        anchor_state=_or_default(env, "FLEET_ANCHOR_STATE", state),
        tmux_socket=env.get("FLEET_TMUX_SOCKET", ""),
        feeder_wait=_or_default(env, "FLEET_FEEDER_WAIT", "10"),
        lock_wait=_or_default(env, "FLEET_LOCK_WAIT", "10"),
        env=env,
    )


# --- the registry pin (ludics-lite#632) ------------------------------------------------------

# Set BY a coordinator's far side in the environment of every fleet-worker.sh it starts on a box
# (``transport.prelude``'s ``fleet_worker``), never by hand: the registry that coordinator reads,
# as ``registry_pin`` spells it. Every process below inherits it, so a fleet-worker.sh started
# anywhere under that far side -- the slot, a runner's nested slot -- refuses rather than read
# another registry, whatever re-set FLEET_ANCHOR or FLEET_ANCHOR_STATE in between.
REGISTRY_PIN = "FLEET_REGISTRY_PIN"


def anchor_name(cfg: Config) -> str:
    """The anchor as a fleet name: ``local`` is this box's own name, when it has one."""
    return cfg.local_box if cfg.anchor == "local" and cfg.local_box else cfg.anchor


def registry_pin(anchor: str, anchor_state: str) -> str:
    """The registry's location, one value: the anchor's fleet name and the state path there."""
    return json.dumps([anchor, anchor_state])


def _pin_pair(pin: str) -> tuple[str, str] | None:
    try:
        decoded: Any = json.loads(pin)
    except ValueError:
        return None
    if not isinstance(decoded, list):
        return None
    items = cast(list[Any], decoded)
    if len(items) != 2 or not all(isinstance(item, str) for item in items):
        return None
    return (cast(str, items[0]), cast(str, items[1]))


def pin_refusal(cfg: Config) -> str:
    """Empty when no pin is set or this box resolves the pinned registry; else the refusal. The
    boundary, fail-closed: a pin that is not exactly a JSON array of two strings refuses too."""
    pin = cfg.env.get(REGISTRY_PIN)
    if pin is None:
        return ""
    here = (anchor_name(cfg), cfg.anchor_state)
    pinned = _pin_pair(pin)
    if pinned == here:
        return ""
    theirs = f"an unreadable pin {shlex.quote(pin)}" if pinned is None else \
        f"anchor {shlex.quote(pinned[0])}, state {shlex.quote(pinned[1])}"
    return (
        f"REFUSED: this box resolves the execution registry as anchor {shlex.quote(here[0])}, state"
        f" {shlex.quote(here[1])}, but the coordinator that started it reads {theirs} ({REGISTRY_PIN},"
        " ludics-lite#632): something between them re-set FLEET_ANCHOR or FLEET_ANCHOR_STATE, so nothing"
        " here reads the registry"
    )


# --- the <box>=<n> specs ---------------------------------------------------------------------


class SpecError(Exception):
    """A malformed slot or token spec: the message is the refusal's reason."""


def in_roster(cfg: Config, name: str) -> bool:
    """Is ``name`` an exact FLEET_BOXES entry?"""
    return name in cfg.boxes.split()


def box_spec_text(cfg: Config, variable: str, spec: str, box: str, default: str) -> str:
    """The shared reader of the two ``<box>=<n>`` specs: the box's count as the spec spells it
    (``007`` stays ``007``, as the shell echoed it), or ``default``."""
    found = default
    for pair in spec.split():
        name, sep, count = pair.partition("=")
        if not sep or not count.isdigit() or not count.isascii() or int(count) < 1:
            raise SpecError(f"{variable} entry must be <box>=<positive n>: {pair}")
        if not in_roster(cfg, name):
            raise SpecError(f"{variable} names {name}, which is not in FLEET_BOXES")
        if name == box:
            found = count
    return found


def box_spec_count(cfg: Config, variable: str, spec: str, box: str, default: int) -> int:
    """``box_spec_text`` as a number."""
    return int(box_spec_text(cfg, variable, spec, box, str(default)))


def box_correctness_slots(cfg: Config, box: str) -> int:
    return box_spec_count(cfg, "FLEET_BOX_CORRECTNESS_SLOTS", cfg.slots, box, 1)


def box_gpu_tokens(cfg: Config, box: str) -> int:
    """How many of the box's slots may hold its GPU at once; one per slot where the spec is silent."""
    return int(box_gpu_tokens_text(cfg, box))


def box_correctness_slots_text(cfg: Config, box: str) -> str:
    return box_spec_text(cfg, "FLEET_BOX_CORRECTNESS_SLOTS", cfg.slots, box, "1")


def box_gpu_tokens_text(cfg: Config, box: str) -> str:
    """The token count as the spec spells it, or the slot count's spelling where it is silent."""
    slots = box_correctness_slots_text(cfg, box)
    return box_spec_text(cfg, "FLEET_BOX_GPU_TOKENS", cfg.gpu_tokens, box, slots)
