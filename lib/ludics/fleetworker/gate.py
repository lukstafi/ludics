"""``gate``: the point-in-time check before a native worker's dispatch -- lease and halt on the
anchor, the target's base CI, and the lease and halt again (fleet-worker.sh's ``cmd_gate``,
``base_gate``, ``base_checker``, ``integration_records``).

Not a reservation: it reads, and a refusal blocks the dispatch. The base verdict is ship-pr's
``pr-review.sh base``, run on the coordinator (where gh is authenticated), found from this
checkout's physical root. Its clocks are pinned here so the ceiling cannot drift from them
(ludics-lite#175): the ceiling is the absence grace plus one poll interval.

``launch`` reads the same gate, with the commit it fetched as ``expected``: the target branch's
tip must still be that commit once the verdict is in, or the worker would start from a base the
verdict never judged.

The read passes ``--advisory-red <file>`` (ludics-lite#651): a workflow red only in jobs the
repository's own ``.github/ship-pr-advisory-checks`` names is the checker's to take out of the
verdict, and at a green it writes those jobs to the file; the gate prints one ``ADVISORY-RED``
line per job when it admits. The file is read as an allowlist: at a green, a JSON array of
objects whose ``job`` is a non-empty string and whose ``sha`` is 40 lower-case hex, and nothing
else -- an empty, unwritten or malformed file refuses the gate.
"""

import json
import os
import shlex
import re
import tempfile
import urllib.parse
from typing import Any, cast

from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import field, listing, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.transport import err, run, substitution

BASE_ABSENT_GRACE = 300
BASE_POLL_INTERVAL = 60
BASE_WAIT = BASE_ABSENT_GRACE + BASE_POLL_INTERVAL

# Gate policy and bounds are not inherited from an unrelated ship-pr operation; connection, auth,
# state paths and review-only settings are kept.
UNSET_FOR_CHECKER = (
    "SHIP_PR_ADVISORY_CHECKS",
    "SHIP_PR_TEST_SOURCE_ONLY",
    "SHIP_PR_CHECKS_WAIT",
    "SHIP_PR_CHECKS_HEARTBEAT",
    "SHIP_PR_API_ATTEMPTS",
    "SHIP_PR_API_BACKOFF",
)


def _checker_env(cfg: Config) -> dict[str, str]:
    env = {k: v for k, v in cfg.env.items() if k not in UNSET_FOR_CHECKER}
    env["SHIP_PR_BASE_ABSENT_GRACE"] = str(BASE_ABSENT_GRACE)
    env["SHIP_PR_CHECKS_INTERVAL"] = str(BASE_POLL_INTERVAL)
    return env


def base_checker(cfg: Config, argv: list[str]) -> int:
    """Run the checker with the gate's own policy, its stdout on our stderr."""
    return run(argv, env=_checker_env(cfg), stdout_to_stderr=True).rc


def base_checker_read(cfg: Config, argv: list[str]) -> str | None:
    """Run the checker with the gate's own policy for what it prints: ``$(base_checker ...)``,
    None when it failed."""
    done = run(argv, env=_checker_env(cfg), capture=True)
    return substitution(done.out) if done.rc == 0 else None


def uri(text: str) -> str:
    """jq's ``@uri``: every byte outside ``[A-Za-z0-9-_.~]`` percent-encoded, upper-case hex."""
    return urllib.parse.quote(text.encode("utf-8", "surrogateescape"), safe="-_.~")


def _ascii_downcase(text: str) -> str:
    return text.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


def _tsv(fields: list[str]) -> str:
    """jq's ``@tsv``."""
    escaped = [f.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r") for f in fields]
    return "\t".join(escaped)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


def integration_rows(records: list[dict[str, Any]], repo: str) -> str:
    """The registry's INTEGRATION RECORDS for the repository (ludics-lite#401): concluded, pass or
    fail at an exact observed SHA, a coordinator's non-standing correctness run marked
    ``"integration": true``, the repository compared without case. One
    ``<sha>\\t<verdict>\\t<request id>\\t<concluded at>`` row each."""
    rows: list[str] = []
    for r in records:
        sha = r.get("observed_sha")
        if not (
            r.get("state") == "concluded"
            and r.get("verdict") in ("pass", "fail")
            and field(r, "request", "integration") is True
            and field(r, "request", "transport") == "coordinator"
            and field(r, "request", "kind") == "correctness"
            and isinstance(field(r, "request", "repository"), str)
            and _ascii_downcase(field(r, "request", "repository")) == _ascii_downcase(repo)
            and field(r, "request", "standing") in (None, False)
            and isinstance(sha, str)
            and re.fullmatch(r"[0-9a-f]{40}", sha)
        ):
            continue
        rows.append(_tsv([sha, _text(r.get("verdict")), _text(r.get("request_id")), _text(r.get("updated_at"))]))
    return "\n".join(rows)


def integration_records(cfg: Config, repo: str) -> str | None:
    """The rows, or None when the registry could not be read (which refuses the gate: a failed
    record there would outrank a green PR head)."""
    done = listing(cfg)
    if done.rc != 0:
        return None
    records = records_of(done.out)
    if records is None:
        return None
    return integration_rows(records, repo)


def stage_records(rows: str) -> str | None:
    """The rows in a scratch file, whole, or None (and no file): an empty or cut file is valid
    input to the checker, and a record lost in the write would let a green head stand for a failed tip."""
    path = ""
    try:
        descriptor, path = tempfile.mkstemp(prefix="fw-integration.", dir=os.environ.get("TMPDIR") or "/tmp")
        with os.fdopen(descriptor, "w", encoding="utf-8", errors="surrogateescape") as f:
            f.write(rows + "\n")
        return path
    except OSError:
        if path:
            _remove(path)
        return None


def advisory_red_jobs(text: str) -> list[tuple[str, str]] | None:
    """The checker's ``--advisory-red`` file at a green: ``(job, sha)`` per job it took out of the
    verdict, ``[]`` for none, or None for anything that is not that array (the module's
    allowlist), which refuses the gate."""
    try:
        doc: object = json.loads(text)
    except ValueError:
        return None
    if not isinstance(doc, list):
        return None
    jobs: list[tuple[str, str]] = []
    for row in cast(list[object], doc):
        if not isinstance(row, dict):
            return None
        fields = cast(dict[object, object], row)
        job, sha = fields.get("job"), fields.get("sha")
        if not (isinstance(job, str) and job and isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)):
            return None
        jobs.append((job, sha))
    return jobs


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return f.read()
    except OSError:
        return None


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def base_gate(cfg: Config, target: str, branch: str, force: bool, reason: str, expected: str = "") -> int:
    """0 the base may be built on, 1 refused (its line on stderr); a usage error dies (2). With
    ``expected`` (launch's fetched base), the branch's tip must still be that commit."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", target):
        die("base gate: --target-repo <owner/repo> required")
    if reason and not force:
        die("base gate: --allow-red-base requires --force for a triage worker")
    if branch.startswith("-") or "\n" in branch:
        die("base gate: invalid --base-branch")
    helper = os.path.join(cfg.checkout, "ship-pr", "scripts", "pr-review.sh")
    if not (os.path.exists(helper) and os.access(helper, os.X_OK)):
        err(f"BASE REFUSED: coordinator base checker missing: {helper}")
        return 1
    where = f"{target} {branch or 'default branch'}"
    rows = integration_records(cfg, target)
    if rows is None:
        err(
            f"BASE REFUSED: {where}: the execution registry could not be read, so whether an integration"
            " record judges its tip is unknown; dispatch blocked"
        )
        return 1
    # The ordinary base read may carry an older green while the tip is running: --wait, bounded by
    # the derived ceiling, and --interim (ludics-lite#308), which names a green PR head meanwhile.
    # And --advisory-red (ludics-lite#651): the repository's own advisory file decides a red that
    # is only in jobs it names, and the checker writes those jobs to this file at a green.
    advisory = stage_records("")
    if advisory is None:
        err(f"BASE REFUSED: {where}: cannot stage the checker's advisory-red file; dispatch blocked")
        return 1
    argv = [helper, "--repo", target, "base"] + ([branch] if branch else []) + [f"--wait={BASE_WAIT}", "--interim"]
    argv += ["--advisory-red", advisory]
    records = ""
    if rows:
        staged = stage_records(rows)
        if staged is None:
            _remove(advisory)
            err(f"BASE REFUSED: {where}: cannot stage the integration records; dispatch blocked")
            return 1
        records = staged
        argv += ["--integration-records", records]
    rc = base_checker(cfg, argv)
    if records:
        _remove(records)
    text = _read(advisory)
    _remove(advisory)
    admitted: list[tuple[str, str]] = []
    # The records were a snapshot, and the read can wait minutes: a green is taken only over the
    # records it was given (review round 6 of #401).
    if rc == 0:
        later = integration_records(cfg, target)
        if later is None:
            err(f"BASE REFUSED: {where}: the execution registry could not be re-read after the verdict; dispatch blocked")
            return 1
        if later != rows:
            err(
                f"BASE REFUSED: {where}: an integration record for it concluded during the read, which the"
                " verdict did not see; re-run the gate"
            )
            return 1
        jobs = advisory_red_jobs(text) if text is not None else None
        if jobs is None:
            err(
                f"BASE REFUSED: {where}: the checker's green came without a readable advisory-red record"
                " (its --advisory-red file is empty, unwritten or malformed); dispatch blocked"
            )
            return 1
        admitted = jobs
    if rc == 1 and force and reason:
        err(f"BASE TRIAGE OVERRIDE: {where}: {reason}")
        rc = 0
    if rc != 0:
        err(f"BASE REFUSED: {where} (base checker exit {rc}); dispatch blocked")
        return 1
    if expected:
        tip = base_checker_read(cfg, [helper, "--repo", target, "retry", "--read", "api", f"repos/{target}/commits/{uri(branch)}", "--jq", ".sha"])
        if tip is None:
            err(f"BASE REFUSED: cannot confirm {target} {branch} after verdict")
            return 1
        if not re.fullmatch(r"[0-9a-f]{40}", tip):
            err("BASE REFUSED: invalid target tip")
            return 1
        if tip != expected:
            err(f"BASE REFUSED: {target} {branch} moved or differs from fetched base {expected} (now {tip}); dispatch blocked")
            return 1
    for job, sha in admitted:
        err(f"ADVISORY-RED: {shlex.quote(job)} at {sha}; launching")
    return 0


def cmd_gate(cfg: Config, args: list[str]) -> int:
    force, target, branch, reason = False, "", "", ""
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--allow-red-base":
            if i + 1 >= len(args) or not re.search(r"[^ \t\n\r\f\v]", args[i + 1]):
                die("base gate: --allow-red-base requires a triage reason")
            reason = args[i + 1]
            i += 1
        elif arg == "--force":
            force = True
        elif arg in ("--target-repo", "--base-branch"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"gate: expected value for {arg}")
            if arg == "--target-repo":
                target = args[i + 1]
            else:
                branch = args[i + 1]
            i += 1
        else:
            die("gate: expected --target-repo <owner/repo> [--base-branch <branch>] [--force]")
        i += 1
    rc = anchor_gate(cfg, "GATE", "native-worker", force)
    if rc != 0:
        return rc
    rc = base_gate(cfg, target, branch, force, reason)
    if rc != 0:
        return rc
    return anchor_gate(cfg, "GATE", "native-worker", force)

