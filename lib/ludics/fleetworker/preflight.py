"""``preflight`` and ``refresh``: is a box fit to run a worker, and bring its skills checkout current
(fleet-worker.sh's ``cmd_preflight``, ``preflight_script``, ``siblings_of``, ``slots_report``,
``cmd_refresh``, ``refresh_box``).

Both run on the box that will run the work, because that box's ~/.claude/skills symlinks serve
whatever its checkout holds (ludics-lite#3). The checks themselves are the far side's
(``farside.PREFLIGHT``, ``farside.REFRESH``, sharing ``farside.FRESHNESS`` so the two can never
disagree about what "current" means); this module composes them, reads the knobs that bound them,
and reports the correctness slots this configuration gives each roster box.

The bounds, each a wall-clock limit read as the shell read it (``${X:-default}``):
FLEET_PROBE_TIMEOUT (the live headless turn, 120), FLEET_FETCH_TIMEOUT (the skills fetch, 300),
FLEET_CROSS_TIMEOUT (each cross-box reach probe, 20), FLEET_GH_TIMEOUT (each GitHub call, 30) and
FLEET_REFRESH_TIMEOUT (``refresh``'s fetch, 30: it runs after every cross-box ``execution run``,
where a coordinator is waiting on it).
"""

from ludics import cli
from ludics.fleetworker import farside
from ludics.fleetworker.config import (
    GPU_TOKENS_DEFAULT,
    Config,
    SpecError,
    box_correctness_slots_text,
    box_gpu_tokens_text,
)
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import Done, err, is_local, prelude, run_on

# The boxes the site's slot default (config.DEFAULT_SLOTS) gives more than one slot: a spec under
# the default roster that does not name one of them collapses it to one slot (ludics-lite#329,
# #316). Spelled here as well as in the default, on purpose: the preflight fixture checks both
# directions -- the site default draws no warning, and an empty spec warns about exactly the boxes
# the site default gives more than one slot -- so a box added to one and not the other fails there.
WIDENED = ["mac-studio", "rog-nv-linux", "minix-amd-linux", "tuf-amd-linux", "macbook-pro"]


def knob(cfg: Config, name: str, default: str) -> str:
    """``${NAME:-default}``."""
    return cfg.env.get(name) or default


def siblings_of(cfg: Config, box: str) -> str:
    """The fleet minus one box: what that box's preflight probes ssh to. ``local`` and the
    coordinator's own name both stand for the box running this, so neither is a sibling of itself."""
    out = [b for b in cfg.boxes.split() if b != box and not (is_local(cfg, box) and is_local(cfg, b))]
    return " ".join(out)


def preflight_script(cfg: Config, box: str) -> str:
    return (
        prelude(cfg, box)
        + farside.FRESHNESS
        + farside.ghprobe(knob(cfg, "FLEET_GH_TIMEOUT", "30"))
        + farside.FLEET_PYTHON
        + farside.PREFLIGHT
    )


def preflight_args(cfg: Config, box: str, codex: str, probe: str, cross: str) -> list[str]:
    return [
        codex,
        probe,
        knob(cfg, "FLEET_PROBE_TIMEOUT", "120"),
        knob(cfg, "FLEET_FETCH_TIMEOUT", "300"),
        cross,
        knob(cfg, "FLEET_CROSS_TIMEOUT", "20"),
        knob(cfg, "FLEET_GH_TIMEOUT", "30"),
    ]


def run_preflight(cfg: Config, box: str, codex: str, probe: str, cross: str, *, capture: bool = False) -> Done:
    """The far-side preflight on the box: exit 0 with a PREFLIGHT OK line, 1 with the refusal."""
    return run_on(cfg, box, preflight_script(cfg, box), preflight_args(cfg, box, codex, probe, cross), capture=capture)


def cmd_preflight(cfg: Config, args: list[str]) -> int:
    box = args[0] if args else ""
    if not box:
        die("preflight: which box?")
    codex, probe, cross = "0", "1", siblings_of(cfg, box)
    for arg in args[1:]:
        match arg:
            case "--codex":
                codex = "1"
            case "--native-codex":
                codex = "native"
            case "--native-claude":
                codex = "native-claude"
            case "--no-probe":
                probe = "0"
            case "--no-cross":
                cross = ""
            case _:
                die(f"preflight: unknown option {arg}")
    done = run_preflight(cfg, box, codex, probe, cross)
    if done.unreachable:
        cli.say(f"PREFLIGHT UNREACHABLE {box}")
        slots_report(cfg)
        return 4
    slots_report(cfg)
    return done.rc


def slots_report(cfg: Config) -> None:
    """One PREFLIGHT SLOTS line with the correctness slot count this configuration gives every
    roster box -- what the registry admits (every reservation carries this spec) and what
    ``execution slot`` takes on this machine; a remote box's own batches read that box's
    environment. The count showed nowhere but in a batch's own slot line, so when an exported
    default roster dropped mac-studio to one slot, nine workers serialized on one flock with every
    preflight passing (ludics-lite#329). Under the default roster, a spec that does not name a box
    the slot default widens is that collapse for that box, and is one warning on stderr per box; a
    spec naming the box explicitly, even at one slot, is someone's choice and is not. A box whose
    GPU tokens are fewer than its slots shows them as ``<box>=<slots>(gpu=<tokens>)``
    (ludics-lite#391), and a token spec that leaves out a box the site's token default narrows is
    the same kind of warning. Never changes the preflight's verdict."""
    out = ""
    for b in cfg.boxes.split():
        try:
            n = box_correctness_slots_text(cfg, b)
        except SpecError as exc:
            err(f"PREFLIGHT SLOTS WARNING: {exc}; every `execution slot` and reservation under it refuses")
            return
        try:
            t = box_gpu_tokens_text(cfg, b)
        except SpecError as exc:
            err(f"PREFLIGHT SLOTS WARNING: {exc}; every `execution slot` refuses")
            return
        # The GPU tokens only where they bind (ludics-lite#391): fewer than the slots.
        out += f" {b}={n}(gpu={t})" if int(t) < int(n) else f" {b}={n}"
    env = cfg.env
    if "FLEET_BOX_CORRECTNESS_SLOTS" in env:
        src = "FLEET_BOX_CORRECTNESS_SLOTS"
    elif cfg.default_roster:
        src = "site default"
    else:
        src = "custom roster: one slot each"
    if "FLEET_BOX_GPU_TOKENS" in env:
        src += "; FLEET_BOX_GPU_TOKENS"
    cli.say(f"PREFLIGHT SLOTS{out} ({src})")
    if not cfg.default_roster:
        return
    named = {pair.partition("=")[0] for pair in cfg.slots.split()}
    for b in WIDENED:
        if b not in named:
            err(
                f'PREFLIGHT SLOTS WARNING: the default roster, but FLEET_BOX_CORRECTNESS_SLOTS="{cfg.slots}" does not'
                f" name {b}, which falls to one slot (the site default gives it more); every correctness batch there"
                " serializes"
            )
    # The mirror image for the token pool: a GPU-token spec that leaves out a box the site default
    # holds to fewer GPU batches than slots lets every slot there hold the GPU -- rog-nv-linux's
    # measured CUDA_ERROR_OUT_OF_MEMORY shape. Only when the box has more slots than that default.
    tokened = {pair.partition("=")[0] for pair in cfg.gpu_tokens.split()}
    for pair in GPU_TOKENS_DEFAULT.split():
        b, _, t = pair.partition("=")
        if b in tokened:
            continue
        try:
            n = box_correctness_slots_text(cfg, b)
        except SpecError:
            continue  # the roster loop above has already warned, and returned
        if int(n) > int(t):
            err(
                f'PREFLIGHT SLOTS WARNING: the default roster, but FLEET_BOX_GPU_TOKENS="{cfg.gpu_tokens}" does not'
                f" name {b}, so all {n} of its slots may hold its GPU at once (the site default allows {t}); GPU"
                " batches there can run out of device memory"
            )


def refresh_box(cfg: Config, box: str, *, to_stderr: bool = False) -> int:
    """The far-side refresh on one box: its line on stdout (stderr with ``to_stderr``, as the
    refresh after an ``execution run`` prints it beside the record), exit 0/1, or 4 with a REFRESH
    UNREACHABLE line when the box did not answer (asleep, off the network: not checked)."""
    script = prelude(cfg, box) + farside.FRESHNESS + farside.REFRESH
    done = run_on(cfg, box, script, [knob(cfg, "FLEET_REFRESH_TIMEOUT", "30")], stdout_to_stderr=to_stderr)
    if done.unreachable:
        line = f"REFRESH UNREACHABLE {box}: its skills checkout was not checked"
        if to_stderr:
            err(line)
        else:
            cli.say(line)
        return 4
    return done.rc


def cmd_refresh(cfg: Config, args: list[str]) -> int:
    """``refresh <box>...``: bring each box's skills checkout to origin/main, or report why not.
    Exit 1 when any box was not refreshed, else 4 when any did not answer, else 0."""
    if not args:
        die("refresh: which box(es)?")
    for box in args:
        if box.startswith("-"):
            die(f"refresh: unknown option {box}")
    worst = 0
    for box in args:
        rc = refresh_box(cfg, box)
        if rc == 1 or (rc != 0 and worst == 0):
            worst = rc
    return worst
