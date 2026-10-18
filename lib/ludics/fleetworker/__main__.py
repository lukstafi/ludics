"""``scripts/py -m ludics.fleetworker <fleet-worker.sh path> <verb> <args...>``

What fleet-worker.sh runs for every verb, before the shell reads any configuration of its own: the
script's path as it was invoked (``"$0"``, from which the checkout and its sibling scripts are
found, and whose header is the usage text), then the verb and its arguments exactly as given. Every
knob is read from the environment, as the shell read it (``ludics.fleetworker.config``).

Every verb is served here (ludics-lite#403): the coordinator lease (claim, release, coordinator),
the halt (halt, resume-launches, halted), the native gate (gate), every ``execution`` action, the
preflight and refresh (``preflight``), a CLI worker's life (``workers``: launch, attach, status,
log, unstick, close, ls) and the supervision reads (``supervision``: load, prs). The one answer
fleet-worker.sh still gives itself is ``execution slot --probe``, which must answer on a box with no
Python >= 3.12 (THE PROBE WITHOUT PYTHON, in fleet-worker.sh). Under a coordinator's far side,
every verb first checks the registry pin (``config.pin_refusal``, ludics-lite#632).
"""

import os
import re
import sys

from ludics import cli
from ludics.fleetworker import execution, gate, lease, preflight, supervision, workers
from ludics.fleetworker.config import Config, load_config, pin_refusal
from ludics.fleetworker.identity import PROG, die

VERBS = (
    "preflight",
    "refresh",
    "gate",
    "launch",
    "attach",
    "status",
    "log",
    "unstick",
    "close",
    "ls",
    "load",
    "prs",
    "execution",
    "halt",
    "resume-launches",
    "halted",
    "claim",
    "release",
    "coordinator",
)


def usage_text(script: str) -> str:
    """``sed -n '/^# Usage:/,/^# Exit:/p' "$0" | sed 's/^# \\{0,1\\}//'``: the script header's usage
    block, from its ``# Usage:`` line through its ``# Exit:`` line, the comment marks dropped."""
    try:
        with open(script, encoding="utf-8", errors="surrogateescape") as f:
            lines = f.read().split("\n")
    except OSError:
        return ""
    out: list[str] = []
    inside = False
    for line in lines:
        if not inside and line.startswith("# Usage:"):
            inside = True
        elif not inside:
            continue
        out.append(re.sub(r"^# ?", "", line))
        if line.startswith("# Exit:") and len(out) > 1:
            inside = False
    return "".join(line + "\n" for line in out)


def usage(cfg: Config) -> int:
    sys.stdout.flush()
    sys.stderr.write(usage_text(cfg.script))
    sys.stderr.flush()
    return 2


def dispatch(argv: list[str]) -> int:
    if not argv:
        die("usage: python -m ludics.fleetworker <fleet-worker.sh path> <verb> [args...]")
    cfg = load_config(argv[0], os.environ)
    refusal = pin_refusal(cfg)
    if refusal:
        # Under a coordinator's far side, a box that would read another registry than the
        # coordinator's refuses every verb before it reads anything (ludics-lite#632).
        cli.exit_with(1, refusal)
    verb = argv[1] if len(argv) > 1 else ""
    rest = argv[2:]
    match verb:
        case "preflight":
            return preflight.cmd_preflight(cfg, rest)
        case "refresh":
            return preflight.cmd_refresh(cfg, rest)
        case "gate":
            return gate.cmd_gate(cfg, rest)
        case "launch":
            return workers.cmd_launch(cfg, rest)
        case "attach":
            return workers.cmd_attach(cfg, rest)
        case "status":
            return workers.cmd_status(cfg, rest)
        case "log":
            return workers.cmd_log(cfg, rest)
        case "unstick":
            return workers.cmd_unstick(cfg, rest)
        case "close":
            return workers.cmd_close(cfg, rest)
        case "ls":
            return workers.cmd_ls(cfg, rest)
        case "load":
            return supervision.cmd_load(cfg, rest)
        case "prs":
            return supervision.cmd_prs(cfg, rest)
        case "execution":
            return execution.cmd_execution(cfg, rest)
        case "halt":
            return lease.cmd_halt(cfg, rest)
        case "resume-launches":
            return lease.cmd_resume_launches(cfg, rest)
        case "halted":
            return lease.cmd_halted(cfg, rest)
        case "claim":
            return lease.cmd_claim(cfg, rest)
        case "release":
            return lease.cmd_release(cfg, rest)
        case "coordinator":
            return lease.cmd_coordinator(cfg, rest)
        case _:
            return usage(cfg)


def main() -> int:
    # The caller's PYTHONPATH comes back before anything runs (cli.main), so a batch under
    # `execution slot`/`hold` sees the environment it was given; a reader that goes away ends the
    # verb by SIGPIPE, as it ended the shell (cli.die_of_sigpipe).
    return cli.main(PROG, dispatch)


if __name__ == "__main__":
    sys.exit(main())
