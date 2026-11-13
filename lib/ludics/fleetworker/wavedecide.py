"""``wave decide`` and ``wave decisions``: a design decision recorded where the maintainer will read it.

A wave takes design decisions without the maintainer in the loop: a recommendation posted before
launch, a call made at night when a worker escalates. wave-20261111-ocannl merged a solver change
that way, on two independent plans and four backends, and the only trace was a comment on the
issue. The maintainer's rule (2026-11-13) is that the wave does not hold such a change, and that
every decision taken is surfaced: on the issue, by a label, and in a ledger the project keeps.

    wave decide <wave.json> <issue number> --tier 2|mid-wave|3 --call <one line> --body-file <file>
                --by <model> [--task <task>] [--posted <url>]
    wave decisions <wave.json>

WHAT ``decide`` DOES, in this order:

1. THE TIER says whose decision it is, and the body's first line must agree, since a comment's
   heading is how the next wave's decision gate tells a wave's own post from a maintainer decision
   (issue-wave SKILL.md, *Decision gate*):
     2         the wave's recommendation before launch, veto-able
     mid-wave  a call the coordinator took during the wave (an escalation answered, a plan approved)
     3         the maintainer's answer, posted on their behalf
   A tier-3 body starts ``## Decision update (maintainer, via the wave coordinator)``. A body of any
   other tier that starts with ``## Decision`` is refused: it would read as the maintainer's.
2. A record of this issue and call BY THE SAME AUTHORITY (the maintainer for tier 3, the wave for
   the other two) in ``<wave dir>/decisions.jsonl`` is the decision already made: it is printed
   again, and nothing is posted twice. The maintainer's answer to a call the wave recorded is
   another decision, in the wave's own words or not: it is posted and recorded.
3. The lease (not the halt).
4. The comment, on ``<issue_repository>#<N>`` through ``pr-review.sh comment``: with
   ``--coordinator <model>``, whose footer marks the wave's own post, for tiers 2 and mid-wave;
   plain for tier 3, whose heading says whose it is. An ambiguous post (exit 3) refuses with exit
   4: read the issue, and re-run with ``--posted <url>`` when the comment is there.
5. The label ``design-joint`` on the issue (``gh issue edit --add-label``). A tracker without the
   label is a ``NOTE``, not a refusal: the record is what the ledger reads.
6. The record, appended to ``decisions.jsonl``: when, the issue, the tier, the task, the call, who
   decided (``maintainer``, or ``coordinator of <wave> (<model>)``), the comment's URL, and the
   status a ledger row starts with: ``ok`` for the maintainer's own, ``unreviewed`` for the wave's.

``decisions`` prints the wave's records as the rows of the project's ledger, newest first:
``| date | issue | the call | who decided | comment | status |``, under that header. A wave's own
record that the maintainer's record of the same issue and call answers is not printed: the
maintainer's row is the decision, and the wave's would stay ``unreviewed`` beside it. The coordinator
adds them to the project's ledger file in ONE close-out commit per wave, so the ledger is no file
every worker appends to. Which file that is, and its review, are the project's.

What neither verb reads: the decision's merits, the body past its first line, or the ledger file.

Exit: 0 recorded (or already); 1 refused; 2 usage; 4 the anchor or GitHub did not answer.
"""

import json
import os
import re
from typing import Any, cast

from ludics import cli, proc
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import gh_timeout
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.transport import run, substitution
from ludics.fleetworker.wave import REVIEW_NAME, USAGE, Wave, load_wave, utc_now
from ludics.fleetworker.waveprep import TASK

TIERS = ("2", "mid-wave", "3")
MAINTAINER_HEADING = "## Decision update (maintainer, via the wave coordinator)"
LABEL = "design-joint"
HEADER = "| date | issue | the call | who decided | comment | status |\n| --- | --- | --- | --- | --- | --- |"


def ledger_path(wave: Wave) -> str:
    return os.path.join(wave.directory, "decisions.jsonl")


def records_of(wave: Wave) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with open(ledger_path(wave), encoding="utf-8") as f:
            for line in f:
                try:
                    entry: Any = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict):
                    out.append(cast(dict[str, Any], entry))
    except FileNotFoundError:
        pass
    return out


def maintainers(entry: dict[str, Any]) -> bool:
    """The record is the maintainer's own decision, not the wave's."""
    return entry.get("tier") == "3"


def refused(issue: str, why: str, rc: int = 1) -> int:
    cli.say(f"WAVE DECIDE {'REFUSED' if rc == 1 else 'UNKNOWN'} {issue}: {why}")
    return rc


def cmd_decide(cfg: Config, args: list[str]) -> int:
    if len(args) < 2 or args[0].startswith("--") or not args[1].lstrip("#").isdigit():
        die(f"wave decide: name the wave file and the issue's number; usage: {USAGE}")
    opts = {"--tier": "", "--call": "", "--body-file": "", "--by": "", "--task": "", "--posted": ""}
    rest = args[2:]
    while rest:
        if rest[0] not in opts or len(rest) < 2:
            die(f"wave decide: {'unknown option ' + rest[0] if rest[0] not in opts else rest[0] + ' needs a value'}; usage: {USAGE}")
        opts[rest[0]] = rest[1]
        rest = rest[2:]
    wave = load_wave(args[0], "decide")
    tier, call, by, task = opts["--tier"], " ".join(opts["--call"].split()), opts["--by"], opts["--task"]
    if tier not in TIERS:
        die(f"wave decide: --tier is one of {', '.join(TIERS)}, not {tier!r}")
    if not call:
        die("wave decide: --call takes the decision in one line (the ledger's row)")
    if not REVIEW_NAME.fullmatch(by):
        die("wave decide: --by takes the coordinator's model, as letters, digits, spaces and . _ + / - (e.g. 'Claude Opus 5.5')")
    if task and not TASK.fullmatch(task):
        die(f"wave decide: --task {task!r} does not match {TASK.pattern}")
    try:
        with open(opts["--body-file"], encoding="utf-8") as f:
            body = f.read()
    except OSError as exc:
        die(f"wave decide: --body-file {opts['--body-file']!r} cannot be read ({exc.strerror})")
    issue = f"{wave.issue_repository}#{args[1].lstrip('#')}"
    first = next((line.strip() for line in body.splitlines() if line.strip()), "")
    if tier == "3" and first != MAINTAINER_HEADING:
        return refused(issue, f"a tier-3 body starts with the line {MAINTAINER_HEADING!r}: the heading says whose decision it is")
    if tier != "3" and re.match(r"#+\s*Decision\b", first):
        return refused(issue, f"a tier-{tier} body starts {first[:60]!r}, which reads as the maintainer's decision; head it as the"
                              " wave's own (a recommendation, the coordinator's decision)")
    for entry in records_of(wave):
        if entry.get("issue") == issue and entry.get("call") == call and maintainers(entry) == (tier == "3"):
            cli.say(f"WAVE DECIDE {issue}: already recorded ({entry.get('url')}); nothing posted")
            return 0
    gated = anchor_gate(cfg, "WAVE DECIDE", issue, True)
    if gated != 0:
        return gated
    url = opts["--posted"]
    if not url:
        helper = os.path.join(cfg.checkout, "ship-pr", "scripts", "pr-review.sh")
        done = run([helper, "comment", issue, "--body-file", opts["--body-file"], *([] if tier == "3" else ["--coordinator", by])],
                   capture=True)
        lines = substitution(done.out).splitlines()
        url = lines[-1].strip() if lines else ""
        if done.rc == 3:
            return refused(issue, "pr-review.sh comment exit 3: the comment may or may not be posted. Read the issue; when it is"
                                  " there, re-run with --posted <its URL>, else re-run as is", 4)
        if done.rc != 0 or not url.startswith("https://"):
            return refused(issue, f"pr-review.sh comment exit {done.rc}: nothing posted, nothing recorded")
    labelled = proc.run_tool("gh", ["issue", "edit", issue.rsplit("#", 1)[1], "--repo", wave.issue_repository, "--add-label", LABEL],
                             timeout=gh_timeout(cfg))
    if labelled.rc != 0:
        cli.say(f"WAVE DECIDE NOTE {issue}: the label {LABEL} was not added (gh exit {labelled.rc}: {labelled.stderr.strip()[-160:]})")
    entry = {"at": utc_now(), "issue": issue, "tier": tier, "task": task, "call": call,
             "who": "maintainer" if tier == "3" else f"coordinator of {wave.wave} ({by})", "url": url,
             "status": "ok" if tier == "3" else "unreviewed"}
    with open(ledger_path(wave), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    cli.say(f"WAVE DECIDE {issue}: tier {tier} recorded as {entry['status']}: {call} ({url})")
    return 0


def cell(text: str) -> str:
    """A table cell: one line, its pipes escaped."""
    return " ".join(text.split()).replace("|", "\\|")


def cmd_decisions(cfg: Config, args: list[str]) -> int:
    if len(args) != 1 or args[0].startswith("--"):
        die(f"wave decisions: name the wave file; usage: {USAGE}")
    wave = load_wave(args[0], "decisions")
    every = records_of(wave)
    answered = {(e.get("issue"), e.get("call")) for e in every if maintainers(e)}
    kept = [e for e in every if maintainers(e) or (e.get("issue"), e.get("call")) not in answered]
    # Newest first; records of one second keep the file's order, its last line the newest.
    records = [e for _, _, e in sorted(((str(e.get("at", "")), n, e) for n, e in enumerate(kept)), key=lambda t: t[:2], reverse=True)]
    if not records:
        cli.say(f"WAVE DECISIONS {wave.wave}: none recorded")
        return 0
    cli.say(HEADER)
    for entry in records:
        cli.say(f"| {str(entry.get('at', ''))[:10]} | {cell(str(entry.get('issue', '')))} | {cell(str(entry.get('call', '')))} |"
                f" {cell(str(entry.get('who', '')))} | [comment]({entry.get('url', '')}) | {cell(str(entry.get('status', '')))} |")
    return 0
