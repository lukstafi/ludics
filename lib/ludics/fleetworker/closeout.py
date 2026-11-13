"""``board close <wave> <task> [--pr <n> | --no-pr [--run <absolute-dir>]...]`` (#982, #1123):
one verb for a task's close-out once its hand-back is verified (also --agent and --evidence).

wave-20261105-ocannl's coordinator typed the same recipe about 50 times: verify the merge, ``execution
conclude --standing-handback``, ``board set``, ``board log``. Every step was safe to automate, a slip
showed up as a board disagreeing with the registry, and ``conclude`` printed about 60 lines per task
into the coordinator's context. This verb is those steps, in one line of output.

WHAT IT DOES, in this order, each read before any write:

1. The row (``board show --json``): ``repository``, the PR (``--pr``, else the row's ``pr``;
   omitted with ``--no-pr``) and ``standing`` are required, each within its takeover grammar; a missing or invalid one refuses,
   never guessed. ``standing`` is ``none`` for a task with no standing reservation.
2. With a PR, GitHub, ``gh pr view``: the PR must be MERGED with a merge commit, and its head branch the row's
   ``branch`` when the row has one (a wrong number typed is the slip this catches). The merge SHA is
   read here and nowhere else; no flag names it. A split task still refuses a different branch:
   the refusal gives an exact shell-quoted board set, to run only after verifying the split's PR.
   No branch is inferred or changed by this verb.
3. The registry: every id ``standing`` names must be this task's own record, with ``"standing": true``,
   a recorded ``checkout``, this wave, the row's ``repository`` (GitHub names compare without case)
   and, with a ``worker`` on the row, that worker: an id typed wrong must not conclude another live
   worker's reservation as passing. With a ``worker`` on the row, a standing record of this wave and
   worker still open that the row does not name refuses too: the board and the registry disagree, and
   the fix is a ``board set``. Both of a row's records (the agent host's and the GPU home box's) are
   read the same way.
4. With a PR, each standing record not yet concluded: ``execution conclude --standing-handback``, ``--verdict
   pass``, off the record's own ``checkout``. A GPU-home-box leg no batch ran under concludes
   ``not-launched`` there (execution.py's THE UNUSED LEG, #1109), and the line counts it.
5. ``board log``, one line, unless the board already holds that exact line.
6. With a PR, ``board set``: ``state`` ``merged #<n> at <sha>``, ``merge`` the full SHA, ``pr``, and ``agent`` when
   given. It comes last, so a row reads done only once every step before it landed. A row already
   holding those values is not written.

THE VERDICT. ``conclude --standing-handback`` takes no default because its verdict is the hand-back's
word. Here ``pass`` is what this verb establishes: a standing record is concluded as the worker's
life ending, and this form concludes it only for a task whose PR GitHub says merged.

With ``--no-pr``, each repeated absolute ``--run`` is read on the standing records' execution
hosts, first as test-run, then bg-run. Exactly one record must match its host and checkout; bg-run
records no checkout, so its request file must bind it to that record. Its own verdict (including
fail or an admission refusal's not-launched) concludes that record. Test-run uses standing-handback
semantics: dirty edits and a changed HEAD are recorded in evidence, not refused as certification
of one commit. An unmatched open record requires its own run unless THE UNUSED LEG
proves it never launched. ``standing=none`` needs no run. The row becomes ``done, no PR``; a row
already naming a PR or merge refuses this form. No verdict comes from hand-back prose.

THE RECOVERY BOUNDARY. A re-run after a partial close is the recovery: every step reads what stands
and does only what is missing, so a close interrupted anywhere -- between two conclusions, after a
write whose answer was lost (a board write that fails may or may not have landed) -- ends the same
when run again, and a finished close run again writes nothing and says so. It rests on three reads:
a record's ``state``, the board's log text, and the row's values. Both forms skip concluded records
on retry; the no-PR form matches their recorded handle, log and checkout without re-reading the run
(or just the bound bg-run log for a not-launched admission refusal, which has no handle/checkout).
Runs for open records must remain readable. The log line carries no timestamp or count, so a re-run
composes the same line. Not recovered: a close whose worktree was removed
before its record was concluded (``conclude`` reads the checkout's HEAD there, and its refusal stands;
conclude that record by hand, with its evidence, and re-run), and a PR number changed between runs
(a second log line, and the row takes the later one). Two concurrent runs are not serialized past
each write's own lease lock: the lease has one coordinator.

WHAT IT DOES NOT DO. It does not verify the hand-back (the coordinator reads that, and names it in
``--evidence``), read the worktree's cleanliness, remove anything, or close the issue. It concludes
no record but a standing one: any other request of this worker still open is named in the line, for
the coordinator to resolve. It removes no far-side worktree: ``farside-close`` is that step, run
after this one since it waits for the row's done word and its concluded records, and left to the
coordinator because a removal is another kind of step (the project's ``--regenerable``, a box that
may be asleep, ``ls`` first, a KEPT to act on), which must not turn a finished close into a failed
one. A row whose ``farside`` key names a worktree gets a ``NOTE`` naming that command. A task without
a merged PR or matching run evidence keeps the steps by hand.

Exit: 0 closed (or already closed); 1 refused, or a write refused -- the line says what landed, and a
re-run resumes; 2 usage; 4 the anchor or GitHub did not answer. The steps run through this
fleet-worker.sh, as ``execution tip-run``'s do, with their output captured: only this verb's line is
printed, with the last line of a refused step in it. Matching names each record's read refusal;
an unreachable host remains exit 4, even if another record matched (uniqueness is unverified).
"""

import json
import os
import re
import shlex
import tempfile
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker import execution as ex
from ludics.fleetworker.execution import field, listing, record_of, recorded_checkout, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.takeover import KEYS, board_document, gh_json, row_of
from ludics.fleetworker.transport import run, substitution

USAGE = "board close <wave> <task> [--pr <n> | --no-pr [--run <absolute-dir>]...] [--agent <id>] [--evidence <text>]"
OID = re.compile(r"[0-9a-f]{40}([0-9a-f]{24})?")
PR_FIELDS = "number,state,mergeCommit,headRefName"


def refused(wave: str, task: str, why: str, rc: int = 1) -> cli.Exit:
    cli.say(f"BOARD CLOSE REFUSED {wave}: {json.dumps(task, ensure_ascii=False)}: {why}")
    return cli.Exit(rc)


def grammar_of(key: str, value: str) -> str | None:
    """The takeover grammar's word on ``value`` (None: within it)."""
    return next(rule(value) for name, rule in KEYS if name == key)


def parsed(args: list[str]) -> tuple[str, str, dict[str, str]]:
    if len(args) < 2 or not args[0] or not args[1] or args[1].startswith("--"):
        die(f"board close: expected <wave> <task> ({USAGE})")
    wave, task, rest = args[0], args[1], args[2:]
    flags: dict[str, str] = {}
    runs: list[str] = []
    while rest:
        if rest[0] == "--no-pr":
            flags["no-pr"] = "true"
            rest = rest[1:]
            continue
        if rest[0] == "--run" and len(rest) >= 2 and rest[1].startswith("/"):
            runs.append(rest[1])
            rest = rest[2:]
            continue
        if rest[0] not in ("--pr", "--agent", "--evidence") or len(rest) < 2 or not rest[1].strip():
            die(f"board close: expected {USAGE}")
        flags[rest[0][2:]] = rest[1]
        rest = rest[2:]
    if "pr" in flags and grammar_of("pr", flags["pr"]):
        die(f"board close: --pr takes a PR number ({USAGE})")
    if ("no-pr" in flags and "pr" in flags) or (runs and "no-pr" not in flags):
        die(f"board close: --run requires --no-pr, which excludes --pr ({USAGE})")
    if runs:
        flags["runs"] = json.dumps(runs)
    return wave, task, flags


def needed(wave: str, task: str, fields: dict[str, str], key: str, given: str = "") -> str:
    """A key the verb cannot go on without, within its grammar: ``given``, else the row's."""
    value = given or fields.get(key, "")
    why = grammar_of(key, value) if value else f"the row has no {key}"
    if why:
        raise refused(wave, task, f"{key}: {why}; nothing closed (board set {wave} <task> {key}=...)")
    return value


def merged_sha(cfg: Config, wave: str, task: str, repo: str, pr: str, fields: dict[str, str]) -> str:
    """The PR's merge SHA, from GitHub (the module's step 2)."""
    got = gh_json(cfg, ["pr", "view", pr, "--repo", repo, "--json", PR_FIELDS])
    if isinstance(got, str):
        raise refused(wave, task, f"{repo}#{pr} could not be read ({got}); nothing closed", 4)
    data = cast(dict[str, Any], got) if isinstance(got, dict) else {}
    if data.get("state") != "MERGED":
        raise refused(wave, task, f"{repo}#{pr} is {data.get('state')}, not merged; nothing closed")
    branch = fields.get("branch", "")
    if branch and data.get("headRefName") != branch:
        head = data.get("headRefName")
        remedy = ""
        if isinstance(head, str) and head:
            command = shlex.join(["fleet-worker.sh", "board", "set", wave, task, f"branch={head}"])
            remedy = f"; if this is the verified split-task PR, run: {command}; then retry board close"
        raise refused(wave, task, f"{repo}#{pr}'s head is {shlex.quote(str(head))}, "
                      f"the row's branch {shlex.quote(branch)}; nothing closed{remedy}")
    merge: Any = data.get("mergeCommit")
    oid = cast(dict[str, Any], merge).get("oid") if isinstance(merge, dict) else None
    if not (isinstance(oid, str) and OID.fullmatch(oid)):
        raise refused(wave, task, f"{repo}#{pr} is MERGED, and GitHub names no merge commit for it; nothing closed")
    return oid


def open_records(records: list[dict[str, Any]], wave: str, worker: str) -> list[dict[str, Any]]:
    """The records of this wave and worker not concluded."""
    return [r for r in records if field(r, "request", "wave") == wave and field(r, "request", "worker") == worker
            and r.get("state") != "concluded"]


def to_conclude(wave: str, task: str, records: list[dict[str, Any]], ids: list[str], repo: str,
                worker: str) -> tuple[list[tuple[str, str]], list[str]]:
    """The module's step 3: ``(id, checkout)`` of each named record still open, and every other
    request of this worker's still open."""
    todo: list[tuple[str, str]] = []
    for request in ids:
        record = record_of(records, request)
        if record is None:
            raise refused(wave, task, f"the row's standing names {request}, which the registry does not hold; nothing closed")
        if field(record, "request", "standing") is not True:
            raise refused(wave, task, f"the row's standing names {request}, which is no standing reservation; nothing closed")
        named = field(record, "request", "repository")
        for what, theirs, ours, same in (
            ("wave", field(record, "request", "wave"), wave, field(record, "request", "wave") == wave),
            ("repository", named, repo, isinstance(named, str) and named.casefold() == repo.casefold()),
            ("worker", field(record, "request", "worker"), worker, not worker or field(record, "request", "worker") == worker),
        ):
            if not same:
                raise refused(wave, task, f"the row's standing names {request}, whose {what} is {theirs}, not {ours}; nothing closed")
        if record.get("state") == "concluded":
            continue
        checkout = recorded_checkout(record)
        if not checkout:
            raise refused(wave, task, f"{request} records no checkout: conclude it by hand, then re-run; nothing closed")
        todo.append((request, checkout))
    left = [r for r in open_records(records, wave, worker) if r.get("request_id") not in ids] if worker else []
    stray = [str(r.get("request_id")) for r in left if field(r, "request", "standing") is True]
    if stray:
        raise refused(wave, task, f"the registry holds standing record(s) of worker {worker} the row does not name:"
                                  f" {' '.join(stray)}; nothing closed (board set {wave} <task> standing=...)")
    return todo, [str(r.get("request_id")) for r in left]


def stepped(cfg: Config, args: list[str]) -> tuple[int, str]:
    """This fleet-worker.sh with ``args``: its status and its output, captured."""
    done = run([os.path.join(cfg.here, os.path.basename(cfg.script)), *args], capture=True)
    return done.rc, substitution(done.out)


def step(cfg: Config, args: list[str]) -> tuple[int, str]:
    """``stepped``, with the last line of the output only."""
    rc, out = stepped(cfg, args)
    lines = out.splitlines()
    return rc, lines[-1] if lines else ""


def conclude_payload(cfg: Config, payload: str) -> tuple[int, str]:
    """The conclude CLI takes a file, never JSON text in argv; remove it after the child exits."""
    path = ""
    try:
        descriptor, path = tempfile.mkstemp(prefix="fw-board-close.", suffix=".json", dir=os.environ.get("TMPDIR") or "/tmp")
        with os.fdopen(descriptor, "w", encoding="utf-8") as f:
            f.write(payload + "\n")
        return stepped(cfg, ["execution", "conclude", path])
    except OSError as exc:
        return 1, f"cannot stage conclusion payload: {exc.strerror}"
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def never_ran(out: str) -> bool:
    """Whether a conclusion's output, the registry's record, reads ``not-launched``: a standing leg
    no batch ran under (step 4). Output that is no JSON object reads as a run."""
    try:
        record: Any = json.loads(out)
    except ValueError:
        return False
    return isinstance(record, dict) and cast(dict[str, Any], record).get("verdict") == "not-launched"


def no_pr_payloads(cfg: Config, wave: str, task: str, records: list[dict[str, Any]], ids: list[str],
                   runs: list[str], evidence: str) -> dict[str, str]:
    """Read every source before writing. A bg-run has no checkout: its request file must bind
    it to the standing record. Unbound bg-runs cannot establish which checkout ran."""
    matched: dict[str, str] = {}
    for directory in runs:
        candidates: list[tuple[str, str]] = []
        failures: list[tuple[str, ex.Refusal]] = []
        for request in ids:
            record = record_of(records, request)
            assert record is not None  # to_conclude validated the row's ownership
            host = str(field(record, "request", "execution_host") or "")
            checkout = recorded_checkout(record)
            if not host or not checkout:
                continue
            if record.get("state") == "concluded":
                handles = ("test-run:" + ex.basename(directory), f"bg-run:{host}:{directory}")
                landed = ex.retried(record)
                if landed is not None:
                    ran = (landed.get("handle") in handles
                           and landed.get("log") in (directory + "/log", f"{host}:{directory}/log")
                           and ex.same_checkout(str(landed.get("remote_checkout", "")), checkout))
                    unlaunched = landed.get("verdict") == "not-launched" and landed.get("log") == f"{host}:{directory}/log"
                    if ran or unlaunched:
                        candidates.append((request, json.dumps(landed)))
                continue
            head = ex.observed_sha_of(cfg, record, host, checkout)
            if isinstance(head, ex.Refusal):
                failures.append((request, head))
                continue
            facts = ex.read_run(cfg, host, directory, head)
            why = facts if isinstance(facts, ex.Refusal) else ex.Refusal(
                f"run checkout {shlex.quote(facts.get('wt', ''))} is not recorded checkout {shlex.quote(checkout)}", 1)
            payload: ex.Conclusion = why
            if not isinstance(facts, ex.Refusal) and ex.same_checkout(facts.get("wt", ""), checkout):
                clause = ex.standing_run_clause(facts, directory, host)
                if isinstance(clause, ex.Refusal):
                    why = clause
                else:
                    payload = ex.Payload(ex.standing_handback(request, host, checkout, head, evidence,
                                                             clause[0], (directory, clause[1])))
            if isinstance(payload, ex.Refusal):
                bgrun = ex.bg_run_path(cfg)
                bg = ex.read_bg_run(cfg, directory, host, bgrun)
                if isinstance(bg, ex.Refusal):
                    if bg.rc == 4:
                        why = bg
                elif ex.run_request(bg) == ("id", request):
                    payload = ex.conclude_from_bg_run(cfg, directory, request, host, host, head, checkout, evidence, bgrun)
                    if isinstance(payload, ex.Refusal):
                        why = payload
            if isinstance(payload, ex.Payload):
                data = cast(dict[str, Any], json.loads(payload.json))
                if data.get("verdict") == "not-launched" or ex.same_checkout(str(data.get("remote_checkout", "")), checkout):
                    candidates.append((request, payload.json))
                    continue
            failures.append((request, why))
        unreachable = any(why.rc == 4 for _, why in failures)
        if len(candidates) != 1 or unreachable:
            detail = "; ".join(f"record {shlex.quote(request)}: {' '.join(why.text.splitlines())}" for request, why in failures)
            raise refused(wave, task, f"run {shlex.quote(directory)} matches {len(candidates)} standing records;"
                          " need exactly one box and checkout (bg-run requires its request file)"
                          + (f"; {detail}" if detail else "") + "; nothing closed", 4 if unreachable else 1)
        request, serialized = candidates[0]
        if request in matched:
            raise refused(wave, task, f"multiple runs name standing record {shlex.quote(request)}; nothing closed")
        matched[request] = serialized
    for request in ids:
        record = record_of(records, request)
        assert record is not None
        if request in matched or record.get("state") == "concluded":
            continue
        unused = ex.unused_leg(cfg, record, request, str(field(record, "request", "execution_host") or ""),
                                recorded_checkout(record), evidence)
        if unused is None:
            raise refused(wave, task, f"standing record {shlex.quote(request)} needs its own --run; nothing closed")
        matched[request] = unused
    return matched


def cmd_close(cfg: Config, args: list[str]) -> int:
    wave, task, flags = parsed(args)
    doc = board_document(cfg, wave)
    if isinstance(doc, int):
        return doc
    row = row_of(doc, task)
    if row is None:
        cli.say(f"BOARD REFUSED: no task {json.dumps(task, ensure_ascii=False)} on the board of {wave}")
        return 1
    raw: Any = row.get("fields")
    fields = {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()} if isinstance(raw, dict) else {}
    repo = needed(wave, task, fields, "repository")
    no_pr = "no-pr" in flags
    if no_pr and (fields.get("pr") or fields.get("merge")):
        raise refused(wave, task, "--no-pr refuses a row with pr or merge; nothing closed")
    pr = "" if no_pr else needed(wave, task, fields, "pr", flags.get("pr", ""))
    standing = needed(wave, task, fields, "standing")
    ids = [word for word in standing.split() if word != "none"]
    sha = "" if no_pr else merged_sha(cfg, wave, task, repo, pr, fields)
    done = listing(cfg)
    if done.unreachable:
        raise refused(wave, task, f"the registry on {cfg.anchor} did not answer; nothing closed", 4)
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        raise refused(wave, task, f"the registry on {cfg.anchor} could not be read; nothing closed")
    todo, others = to_conclude(wave, task, records, ids, repo, fields.get("worker", ""))
    agent = flags.get("agent") or fields.get("agent", "")
    outcome = "done, no PR" if no_pr else f"{repo}#{pr} merged at {sha}"
    evidence = outcome + ("; verdict from run records" if no_pr else ", read from GitHub")
    evidence += f"; hand-back of {agent}" if agent else ""
    evidence += f"; {flags['evidence']}" if flags.get("evidence") else ""
    payloads = no_pr_payloads(cfg, wave, task, records, ids, json.loads(flags.get("runs", "[]")), evidence) if no_pr else {}
    landed: list[str] = []

    def stopped(what: str, rc: int, said: str) -> cli.Exit:
        where = f"{len(landed)} concluded here, " if landed else ""
        return refused(wave, task, f"{what} exit {rc} ({said}); {where}the row is not set; a re-run resumes", 4 if rc == 4 else 1)

    unused: list[str] = []
    for request, checkout in todo:
        if no_pr:
            rc, out = conclude_payload(cfg, payloads[request])
        else:
            rc, out = stepped(cfg, ["execution", "conclude", "--standing-handback", "--request", request,
                                    "--observed-from", checkout, "--evidence", evidence, "--verdict", "pass"])
        if rc != 0:
            raise stopped(f"conclude {request}", rc, out.splitlines()[-1] if out else "")
        landed.append(request)
        if never_ran(out):
            unused.append(request)
    line = f"{task}: closed, {outcome}; standing: {' '.join(ids) or 'none'}"
    log: Any = doc.get("log")
    logged = isinstance(log, list) and any(isinstance(e, dict) and cast(dict[str, Any], e).get("text") == line for e in cast(list[Any], log))
    if not logged:
        rc, said = step(cfg, ["board", "log", wave, line])
        if rc != 0:
            raise stopped("board log", rc, said)
    wanted = {"state": f"merged #{pr} at {sha[:12]}", "merge": sha, "pr": pr, **({"agent": agent} if agent else {})}
    if no_pr:
        wanted = {"state": "done, no PR", **({"agent": agent} if agent else {})}
    changed = [f"{key}={value}" for key, value in wanted.items() if fields.get(key) != value]
    if changed:
        rc, said = step(cfg, ["board", "set", wave, task, *changed])
        if rc != 0:
            raise stopped("board set", rc, said)
    wrote = landed or not logged or changed
    idle = f" ({len(unused)} never used: not-launched)" if unused else ""
    tail = (f"{len(landed)} standing concluded{idle}, {len(ids) - len(todo)} already; row {'set' if changed else 'as it was'}"
            if wrote else "already closed")
    note = f"; NOTE still open: {' '.join(others)}" if others else ""
    far = [word for word in fields.get("farside", "").split() if word != "none"]
    note += f"; NOTE {len(far)} far-side worktree(s): farside-close {wave} --task {task}" if far else ""
    summary = outcome if no_pr else f"merged {repo}#{pr} at {sha[:12]}"
    cli.say(f"BOARD CLOSE {wave}: {json.dumps(task, ensure_ascii=False)} {summary}; {tail}{note}")
    return 0
