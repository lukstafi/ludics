"""The installed-routine drift guard (ludics-lite#199).

A local scheduled task runs from a COPY under ~/.claude/scheduled-tasks, and a copy drifts from this
checkout in silence. The guard lives inside the prompts -- each installed routine opens by running
scripts/sync-routines.sh and reading its own verdict -- and prose does not fail a test when somebody
edits it away. So this pins that it is there.

WHICH prompts are held is read off the script that installs them: its one-line ``LOCAL_ROUTINES``
assignment. WHAT is required is the COMMAND, not a mention: a Markdown indented-code line (four
blanks or more) whose whole content is THE path to this checkout's copy of the script, in status
mode, and nothing else -- so ``echo``/``cat`` arguments, an assignment, a commented-out line, a
backticked quotation, a ``push``/``pull`` argument and a same-basename path elsewhere all fail. The
checkout's ``~/<dir>`` half is read off the README's own clone command, never restated here, and
``$HOME`` is accepted for ``~``.
"""

import re

from ludics.checkprompts.bytes_view import WS_CLASS, lat, records, ws_split
from ludics.checkprompts.tree import Report, Tree

SYNC_SCRIPT = "scripts/sync-routines.sh"
CLONE_LINE = re.compile(
    r"git clone [^ ]*ludics\.git (~/[A-Za-z0-9_.\-]+)" + WS_CLASS + "*"
)
LOCAL_ROUTINES = re.compile(r'LOCAL_ROUTINES="([^"]*)"' + WS_CLASS + "*")


def checkout_path(tree: Tree) -> str:
    """Where the README's install section clones this repository to, or empty when it has no such
    line (or there is no README)."""
    if not tree.is_file("README.md"):
        return ""
    for line in records(tree.read("README.md") or ""):
        m = CLONE_LINE.fullmatch(line)
        if m is not None:
            return m.group(1)
    return ""


def check_drift_guard(report: Report, tree: Tree) -> None:
    # A root without the sync script installs nothing, so it carries no obligation.
    if not tree.is_file(SYNC_SCRIPT):
        return
    home = checkout_path(tree)
    if not home:
        report.ko(
            "README.md",
            lat("no 'git clone … ~/<dir>' line to read the checkout path from; the routines'")
            + " drift step cannot be checked",
        )
        return
    invocation = re.compile(
        r" {4,}(?:~|\$HOME)/"
        + re.escape(home[2:])
        + "/"
        + re.escape(SYNC_SCRIPT)
        + WS_CLASS
        + "*"
    )
    found = [
        m.group(1)
        for line in records(tree.read(SYNC_SCRIPT) or "")
        if (m := LOCAL_ROUTINES.fullmatch(line)) is not None
    ]
    # Read by sed, which keeps a NUL, into a command substitution, which drops it.
    names = "\n".join(found).replace("\0", "").rstrip("\n")
    if not names:
        # Not a pass: the obligation exists and this reader cannot see who carries it.
        report.ko(
            SYNC_SCRIPT, 'has no one-line LOCAL_ROUTINES="..." naming the routines it installs'
        )
        return
    bad = False
    for routine in ws_split(names):
        if not routine:
            continue
        f = f"routines/{routine}/SKILL.md"
        if not tree.is_file(f):
            report.ko(SYNC_SCRIPT, f"installs '{routine}', but this checkout has no {f} to install from")
            bad = True
            continue
        # The shell read the prompt through `$(cat …)`, which drops a NUL.
        lines = records((tree.read(f) or "").replace("\0", ""))
        if not any(invocation.fullmatch(line) for line in lines):
            report.ko(
                f,
                f"runs no {home}/{SYNC_SCRIPT}: an installed routine reads its own drift with an"
                " indented command line invoking THAT path in status mode (ludics-lite#199)",
            )
            bad = True
    if not bad:
        report.ok(f"every routine {SYNC_SCRIPT} installs runs it to read its own drift")
