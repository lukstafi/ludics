"""``preflight`` and ``refresh``: is a box fit to run a worker, and bring its skills checkout current
(fleet-worker.sh's ``cmd_preflight``, ``preflight_script``, ``siblings_of``, ``slots_report``,
``cmd_refresh``, ``refresh_box``).

Both run on the box that will run the work, because that box's ~/.claude/skills symlinks serve
whatever its checkout holds (ludics-lite#3). The checks themselves are the far side's
(``farside.PREFLIGHT``, ``farside.REFRESH``, sharing ``farside.FRESHNESS`` so the two can never
disagree about what "current" means); this module composes them, reads the knobs that bound them,
and reports the correctness slots this configuration gives each roster box.

COORDINATOR CHECK. ``preflight <box> --planner <wave.json> [--mode none|paired|paired+critique]
[--model <m>] [--effort <e>]`` runs in the coordinator's own session on the wave's agent host.
It reads the wave's typed review setting and the explicitly selected planning mode (default none),
with peer-plan's default model and effort unless overridden. It does not infer modes from briefs,
queues or board rows. Each selected role gets one tool-free prompt in an empty temporary directory.
An absent role or executable is skipped. Success is point-in-time evidence for this process's
environment and the selected models. A refusal records no readiness; repair and repeat the same
command. This mode does not refresh skills, prepare a task or persist a readiness marker.

CLAUDE AUTH BOUNDARY. After an unsuccessful turn, read stderr and the error result's ``result`` and
``errors`` strings (or plain stdout if the CLI exited nonzero without a JSON object). Only recognized
login and credential diagnostics get the auth repair. A successful answer, other JSON fields, and
unrecognized errors are outside that classification. Raw provider output is never printed.

The bounds, each a wall-clock limit read as the shell read it (``${X:-default}``):
FLEET_PROBE_TIMEOUT (the live headless turn, 120), FLEET_FETCH_TIMEOUT (the skills fetch, 300),
FLEET_CROSS_TIMEOUT (each cross-box reach probe, 20), FLEET_GH_TIMEOUT (each GitHub call, 30) and
FLEET_REFRESH_TIMEOUT (``refresh``'s fetch, 30: it runs after every cross-box ``execution run``,
where a coordinator is waiting on it).
"""

import json
import re
import shlex
import tempfile
from pathlib import Path
from typing import cast

from ludics import agy, claude, cli, proc
from ludics.fleetworker import farside
from ludics.fleetworker.config import (
    GPU_TOKENS_DEFAULT,
    Config,
    SpecError,
    box_correctness_slots_text,
    box_gpu_tokens_text,
    fetch_timeout_s,
)
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import Done, err, is_local, prelude, run_on
from ludics.fleetworker.wave import load_wave
from ludics.peerplan import plan

# The boxes the site's slot default (config.DEFAULT_SLOTS) gives more than one slot: a spec under
# the default roster that does not name one of them collapses it to one slot (ludics-lite#329,
# #316). Spelled here as well as in the default, on purpose: the preflight fixture checks both
# directions -- the site default draws no warning, and an empty spec warns about exactly the boxes
# the site default gives more than one slot -- so a box added to one and not the other fails there.
WIDENED = ["mac-studio", "rog-nv-linux", "minix-amd-linux", "tuf-amd-linux", "macbook-pro"]

CLAUDE_AUTH = re.compile(
    r"login reached its time limit and cannot be renewed|not logged in|please run /login|"
    r"authentication_error|invalid api key|oauth token has expired|\b401 unauthorized\b",
    re.IGNORECASE,
)


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


def preflight_args(cfg: Config, box: str, codex: str, probe: str, cross: str, cli_args: list[str]) -> list[str]:
    """The far side's seven words, then the CLI args the worker will run with (ludics#539): the
    Codex probe runs with them, so a model the box's codex cannot serve refuses here."""
    return [
        codex,
        probe,
        knob(cfg, "FLEET_PROBE_TIMEOUT", "120"),
        fetch_timeout_s(cfg),
        cross,
        knob(cfg, "FLEET_CROSS_TIMEOUT", "20"),
        knob(cfg, "FLEET_GH_TIMEOUT", "30"),
        *cli_args,
    ]


def run_preflight(
    cfg: Config, box: str, codex: str, probe: str, cross: str, *, capture: bool = False, cli_args: list[str] | None = None
) -> Done:
    """The far-side preflight on the box: exit 0 with a PREFLIGHT OK line, 1 with the refusal."""
    words = preflight_args(cfg, box, codex, probe, cross, cli_args or [])
    return run_on(cfg, box, preflight_script(cfg, box), words, capture=capture)


def claude_probe_result(done: proc.Completed) -> str:
    """An empty string means success; a failure carries the bounded diagnostic above."""
    try:
        obj: object = json.loads(done.stdout)
    except ValueError:
        obj = None
    diagnostics = [done.stderr]
    if isinstance(obj, dict):
        result = cast(dict[str, object], obj)
        answer = result.get("result")
        if done.rc == 0 and result.get("is_error") is False and isinstance(answer, str) and answer.strip():
            return ""
        if result.get("is_error") is True:
            if isinstance(answer, str):
                diagnostics.append(answer)
            errors = result.get("errors")
            if isinstance(errors, list):
                diagnostics.extend(e for e in cast(list[object], errors) if isinstance(e, str))
    elif done.rc != 0:
        diagnostics.append(done.stdout)
    if any(CLAUDE_AUTH.search(line) for line in diagnostics):
        return ("claude authentication failed. Replace any rejected exported credential or unset it to use a stored login."
                " Repair on this box with `claude auth login` or use `claude setup-token` for an unattended token")
    return "claude returned no successful headless result"


def probe_coordinator_turn(tool: str, model: str, effort: str, timeout: int) -> str:
    """Run an initial headless turn, keeping any resulting files out of the wave and checkout."""
    prompt = "Reply with the single word ok. Do not use tools.\n"
    with tempfile.TemporaryDirectory(prefix="fleet-planner-probe-") as directory:
        answer = Path(directory) / "answer"
        stdin = prompt.encode()
        if tool == "claude":
            try:
                argv = claude.readonly_argv(model, claude.BuiltinTools(""), effort=effort, persist=False)
            except ValueError as exc:
                return str(exc)
        elif tool == "agy":
            # The real planner and reviewer need tool access. This prompt needs no approvals.
            argv = ["--model", model, "--input-format", "stream-json", "--output-format", "stream-json",
                    "--settings", '{"toolPermission":"strict"}']
            stdin = agy.message(prompt)
        else:
            argv = ["exec", "--json", "-m", model, "-c", f"model_reasoning_effort={effort}",
                    "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-o", str(answer), "-"]
        try:
            done = proc.run_tool(tool, argv, cwd=directory, stdin=stdin, timeout=timeout)
        except OSError as exc:
            return f"{tool} could not start ({exc.strerror})"
        if done.rc == 124:
            return f"{tool} headless probe timed out after {timeout}s"
        if tool == "claude":
            return claude_probe_result(done)
        if done.rc == 0 and (agy.result(done.stdout)[0] if tool == "agy"
                             else answer.is_file() and answer.read_text(encoding="utf-8").strip()):
            return ""
        return f"{tool} returned no successful headless result (exit {done.rc})"


def coordinator_preflight(cfg: Config, box: str, args: list[str]) -> int:
    from ludics.fleetworker.waveprep import MODES  # prep's execution reads also use worker preflight

    if not args or len(args) % 2 == 0 or args[0].startswith("--"):
        die("preflight --planner: give the wave file, optionally followed by --mode, --model and --effort with values")
    options: dict[str, str] = {}
    for name, value in zip(args[1::2], args[2::2], strict=True):
        if name not in ("--mode", "--model", "--effort") or name in options or not value or value.startswith("--"):
            die(f"preflight --planner: invalid option or value for {shlex.quote(name)}")
        options[name] = value
    mode = options.get("--mode", "none")
    if mode not in MODES:
        die(f"preflight --planner: --mode must be one of {', '.join(MODES)}")
    if mode == "none" and ("--model" in options or "--effort" in options):
        die("preflight --planner: --model and --effort require a paired --mode")
    wave = load_wave(args[0], "preflight --planner")
    if not is_local(cfg, box) or not is_local(cfg, wave.agent_host):
        die(f"preflight --planner: run on the wave's coordinator box {shlex.quote(wave.agent_host)}")

    roles: list[tuple[str, str, str, str]] = []
    if mode != "none":
        model = options.get("--model", plan.DEFAULT_MODEL)
        tool = "claude" if plan.is_claude(model) else "agy" if plan.is_gemini(model) else "codex"
        roles.append(("planner", tool, model, options.get("--effort", plan.DEFAULT_EFFORT)))
    if wave.review is not None:
        roles.append(("reviewer", "claude" if wave.review.kind == "claude" else "agy", wave.review.model, ""))
    if not roles:
        return 0

    bound = knob(cfg, "FLEET_PROBE_TIMEOUT", "120")
    if not re.fullmatch(r"[1-9][0-9]*", bound):
        die(f"preflight --planner: FLEET_PROBE_TIMEOUT must be positive whole seconds, got {shlex.quote(bound)}")
    refused = False
    for role, tool, model, effort in roles:
        label = f"{shlex.quote(wave.agent_host)} {role} ({tool} {shlex.quote(model)})"
        if proc.command_argv(tool) is None:
            cli.say(f"PREFLIGHT SKIP {label}: {tool} is absent from PATH")
            continue
        why = probe_coordinator_turn(tool, model, effort, int(bound))
        if why:
            err(f"PREFLIGHT REFUSED {label}: {why}")
            refused = True
        else:
            cli.say(f"PREFLIGHT OK {label}")
    return int(refused)


def cmd_preflight(cfg: Config, args: list[str]) -> int:
    box = args[0] if args else ""
    if not box:
        die("preflight: which box?")
    if args[1:2] == ["--planner"]:
        return coordinator_preflight(cfg, box, args[2:])
    codex, probe, cross = "0", "1", siblings_of(cfg, box)
    cli_args: list[str] = []
    rest = args[1:]
    if "--" in rest:
        cli_args = rest[rest.index("--") + 1 :]
        rest = rest[: rest.index("--")]
    for arg in rest:
        match arg:
            case "--codex":
                codex = "1"
            case "--gemini":
                codex = "gemini"
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
    if cli_args and codex not in ("1", "gemini"):
        die("preflight: -- <args> goes with --codex or --gemini (the args a Codex or Gemini CLI worker will run with)")
    done = run_preflight(cfg, box, codex, probe, cross, cli_args=cli_args)
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
