"""``wave loop``: a restartable integration-loop driver around ``execution tip-run`` (ludics#1047).

``wave loop <wave.json> <name> [--resume-after <request id>]`` keeps one loop of the wave file's
``loops`` running: each run at the tip of the loop's branch, the next once the tip moves, until a
red, a stop file or an outcome it cannot read. Each wave's ``loop.sh`` did this by hand, and a
restart orphaned the run in flight: the new start allocated the next id, yielded to its own
predecessor's record on the box, and slept forever while nothing waited on the old run. This one
reads its own records first.

THE LOOP'S REQUESTS are tip-run's (tiprun.py's header): the payload, ``<wave dir>/logs/loop-<name>.json``,
is ``{wave, worker: coordinator, transport: coordinator, purpose, agent_host, execution_host: box,
repository, kind: correctness}``, with ``"integration": true`` only when the loop says so (a GPU
loop's records are informative and must not carry it); the ids are ``<wave>-<name>-<n>``
(``--id-prefix <wave>-<name>``); the command, checkout, branch and ``--cpu`` are the loop's.

ONE DRIVER per loop: an exclusive ``flock`` on ``logs/loop-<name>.lock``, taken without waiting; a
second driver refuses (exit 1). The OS drops it with its holder, so a killed driver leaves none.

THE RECOVERY, before anything starts. Read: the registry records whose id is
``<wave>-<name>-<n>`` (ignoring case, as the registry compares ids), and nothing else of it.
  - Exactly one outstanding (not ``concluded``), ``running`` with a ``bg-run:<box>:<dir>`` handle
    and a full ``observed_sha`` (what a started tip-run records): the driver waits on that run and
    starts nothing -- a restart never makes a second run.
  - Any other outstanding shape -- a record ``reserved``, ``launching``, ``uncertain`` or
    ``suspended``, a running one with another handle, or two outstanding -- is ``LOOP UNKNOWN``,
    exit 4: a start that died half-way is the coordinator's to reconcile.
  - Nothing outstanding: the newest concluded record that is not ``not-launched``, when its verdict
    is not ``pass``, refuses (``LOOP RED <id> (recorded) ...`` or ``LOOP CANCELLED``, exit 1) unless
    ``--resume-after <id>`` names that record: a restart alone is no permission to pass a red or a
    run someone stopped. Past that record, the next run judges the current tip at once, even at the red SHA.
    A targeted rerun pass is no integration verdict and does not clear this explicit restart gate.
THE TARGETED RERUN: ``wave loop <wave.json> <name> --rerun <red id> -- <command>`` reads only
this loop's numbered records, requiring the named record to be concluded fail/timeout with a full
observed SHA. It starts one plain tip-run at that SHA, with the configured loop's box, checkout,
purpose and CPU setting, a separate ``<wave>-<name>-rerun`` id prefix and payload file, and NEVER
an integration field. It accepts no payload overrides. The caller supplies the narrowed command;
its coverage and repeat semantics are the coordinator's judgment, not inspected here. Wait with
``execution tip-run --wait <id>``. No automatic retry or resume-launches: triage must finish first.

THE LAST JUDGED commit is the ``observed_sha`` of the newest record whose verdict is ``pass``,
``fail`` or ``timeout``, a fail-closed allowlist: a ``not-launched`` record (a yield, which carries
the tip's SHA all the same) and a ``cancelled`` one judged nothing, so their commit is run again.

EACH STEP, while no stop file (``<wave dir>/loops.stop`` for every loop, ``loop-<name>.stop`` for
this one) exists -- read before each step and between waits, so a stop lands within one wait's
bound; a stopped driver leaves its run running, and the next driver resumes it:
  1. The tip, read here (``revision.branch_head``, tip-run's own read). Unread is a note and a
     ``poll``: never taken as current or moved.
  2. At the last judged commit: wait ``poll`` seconds. Past it: ``execution tip-run <payload> --tip
     <branch> --id-prefix <wave>-<name> --checkout <dir> [--cpu] -- <command>``.
     ``TIP-RUN STARTED`` (exit 0): wait. ``NOT STARTED`` (exit 1, the box busy or the tip unread
     there): a note and a ``poll``. Anything else: ``LOOP UNKNOWN``, exit 4 (2 on its usage).
  3. The wait: ``execution tip-run --wait <id>``, re-issued while it exits 3 (RUNNING). Exit 0's
     ``TIP-RUN CONCLUDED <id> <verdict> <box> <sha> <dir>``: ``pass`` makes the sha the last judged
     and goes to step 1 at once; ``fail`` or ``timeout`` is ``LOOP RED``, exit 1; ``cancelled`` is
     ``LOOP CANCELLED``, exit 1; ``not-launched`` (the slot refused at once) a note and a ``poll``.
     Any other exit, or a line not of that shape, is ``LOOP UNKNOWN``, exit 4.
What it reads of tip-run: its exit status and those lines (``TIP-RUN STARTED`` and ``TIP-RUN
CONCLUDED``, by their leading words and field count), and on a red the ``TIP-RUN HALT <id>`` line
naming the run (tiprun.py, THE HALT NOTE), whose words after the id end the ``LOOP RED`` line after
`` -- ``, a note that changes nothing else; nothing else of its output, which passes through on
stderr. The yield to workers' records, the halt's admission of a loop run and the
backend pin are tip-run's own.

A RED is the coordinator's: the driver never halts launches. Issue-wave SKILL.md's *On a red at the
tip* checks for a later merge that fixed the red BEFORE the halt, and that attribution is the
coordinator's judgment; the ``LOOP RED`` line names the section, and its exit is the cue.

Every line is timestamped, printed on stdout and appended to ``logs/loop-<name>.log`` (the line
``wave heartbeat`` reports). Run it where its exit wakes the coordinator: a Claude coordinator's
Bash ``run_in_background``, a native Codex coordinator's managed foreground session
(native-codex.md, *Local managed command sessions*).

Exit: 0 stopped by a stop file; 1 red, cancelled, refused at recovery, or another driver holds the
loop; 2 usage; 4 unknown.
"""

import fcntl
import json
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TextIO

from ludics import cli
from ludics.fleetworker import revision
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import field, gh_timeout, listing, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.tiprun import started_run
from ludics.fleetworker.transport import Done, run
from ludics.fleetworker.wave import USAGE, Loop, Wave, load_wave, loop_log, shim
from ludics.fleetworker.wavebrief import write_atomically

JUDGED = ("pass", "fail", "timeout")
SHA40 = re.compile(r"[0-9a-f]{40}")
STARTED = re.compile(r"TIP-RUN STARTED (\S+) (\S+) ([0-9a-f]{40}) (\S.*)")
CONCLUDED = re.compile(r"TIP-RUN CONCLUDED (\S+) (\S+) (\S+) (\S+) (\S.*)")  # a run directory may hold spaces

sleep: Callable[[float], None] = time.sleep  # the tests' seam


class End(Exception):
    def __init__(self, rc: int) -> None:
        super().__init__(rc)
        self.rc = rc


@dataclass
class Driver:
    cfg: Config
    wave: Wave
    loop: Loop
    log: TextIO
    last: str = ""  # the last judged commit

    @property
    def prefix(self) -> str:
        return f"{self.wave.wave}-{self.loop.name}"

    @property
    def payload(self) -> str:
        return os.path.join(self.wave.directory, "logs", f"loop-{self.loop.name}.json")

    def say(self, text: str) -> None:
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} LOOP {self.loop.name} {text}"
        cli.say(line)
        self.log.write(line + "\n")
        self.log.flush()

    def end(self, rc: int, text: str) -> End:
        self.say(text)
        return End(rc)

    def stopped(self) -> bool:
        # lexists (#1076): a stop file that is a dangling or looping link is there; exists() said
        # it was not. The wave directory is searchable, since this loop's log is open under it.
        return any(os.path.lexists(os.path.join(self.wave.directory, f))
                   for f in ("loops.stop", f"loop-{self.loop.name}.stop"))

    def fleet(self, *args: str) -> Done:
        return run([shim(self.cfg), *args], capture=True)

    # --- recovery -----------------------------------------------------------------------------

    def mine(self) -> list[dict[str, Any]]:
        listed = listing(self.cfg)
        records = records_of(listed.out) if listed.rc == 0 else None
        if records is None:
            raise self.end(4, f"UNKNOWN: the anchor's registry could not be read (exit {listed.rc}); nothing started")
        pattern = re.compile(re.escape(self.prefix) + r"-([0-9]+)", re.IGNORECASE)
        numbered: list[tuple[int, dict[str, Any]]] = []
        for r in records:
            rid = r.get("request_id")
            found = pattern.fullmatch(rid) if isinstance(rid, str) else None
            if found:
                numbered.append((int(found.group(1)), r))
        return [r for _, r in sorted(numbered, key=lambda pair: pair[0])]

    def recover(self, resume_after: str) -> str | None:
        """The id of the run to wait on, or None to go to the tip; sets the last judged commit."""
        mine = self.mine()
        outstanding = [r for r in mine if r.get("state") != "concluded"]
        judged = [r for r in mine if r.get("state") == "concluded" and r.get("verdict") in JUDGED
                  and isinstance(r.get("observed_sha"), str)]
        self.last = str(judged[-1]["observed_sha"]) if judged else ""
        if outstanding:
            shapes = ", ".join(f"{r.get('request_id')} ({r.get('state')})" for r in outstanding)
            only = outstanding[0]
            if len(outstanding) > 1 or only.get("state") != "running" or isinstance(started_run(only), str):
                raise self.end(4, f"UNKNOWN: outstanding {shapes} is not one run tip-run started; reconcile it, nothing started")
            self.say(f"RESUME {only.get('request_id')}: running on {field(only, 'request', 'execution_host')}, waiting on it")
            return str(only.get("request_id"))
        latest = [r for r in mine if r.get("verdict") != "not-launched"]
        if latest and latest[-1].get("verdict") != "pass":
            rid, verdict = str(latest[-1].get("request_id")), str(latest[-1].get("verdict"))
            if rid.lower() != resume_after.lower():
                word = "CANCELLED" if verdict == "cancelled" else "RED"
                raise self.end(1, f"{word} {rid} (recorded, {verdict} at {latest[-1].get('observed_sha')}): triage it"
                                  f" (SKILL.md, *On a red at the tip*), then restart with --resume-after {rid}")
            self.say(f"RESUME past {rid} ({verdict}), as --resume-after names it")
            self.last = ""  # explicit recovery judges the current tip again
        if self.last:
            self.say(f"RESUME last judged {self.last}")
        return None

    def rerun(self, red_id: str, command: list[str]) -> int:
        red = next((r for r in self.mine() if str(r.get("request_id")).lower() == red_id.lower()), None)
        if (red is None or red.get("state") != "concluded" or red.get("verdict") not in ("fail", "timeout")
                or not isinstance(red.get("observed_sha"), str) or not SHA40.fullmatch(red["observed_sha"])):
            die("wave loop --rerun: name this loop's concluded fail/timeout record with a full observed SHA")
        payload = payload_of(self.wave, self.loop)
        payload.pop("integration", None)
        payload["requested_revision"] = red["observed_sha"]
        path = os.path.join(self.wave.directory, "logs", f"loop-{self.loop.name}-rerun.json")
        write_atomically(path, json.dumps(payload, separators=(",", ":")) + "\n")
        done = self.fleet("execution", "tip-run", path, "--id-prefix", self.prefix + "-rerun",
                          "--checkout", self.loop.checkout, *(["--cpu"] if self.loop.cpu else []), "--", *command)
        cli.say(done.out.rstrip("\n"))
        return done.rc

    # --- the steps ----------------------------------------------------------------------------

    def start(self, tip: str) -> str | None:
        """The started run's id, or None after a yield."""
        args = ["execution", "tip-run", self.payload, "--tip", self.loop.tip, "--id-prefix", self.prefix,
                "--checkout", self.loop.checkout, *(["--cpu"] if self.loop.cpu else []), "--", *self.loop.command]
        done = self.fleet(*args)
        lines = done.out.split("\n")
        if done.rc == 0:
            for line in lines:
                found = STARTED.fullmatch(line)
                if found:
                    self.say(f"STARTED {found.group(1)} on {found.group(2)} at {found.group(3)}")
                    return found.group(1)
            raise self.end(4, f"UNKNOWN: tip-run exited 0 with no TIP-RUN STARTED line: {done.out.strip()[-300:]!r}")
        if done.rc == 1:
            said = next((l for l in lines if l.startswith("TIP-RUN NOT STARTED ")), done.out.strip()[-300:])
            self.say(f"NOT STARTED at {tip}: {said}")
            return None
        raise self.end(2 if done.rc == 2 else 4, f"UNKNOWN: tip-run exited {done.rc}: {done.out.strip()[-300:]!r}")

    def wait(self, request_id: str) -> bool:
        """True when the run passed; False after a not-launched end; End otherwise."""
        while True:
            if self.stopped():
                raise self.end(0, f"STOPPED (stop file), {request_id} left running: a restart resumes it")
            done = self.fleet("execution", "tip-run", "--wait", request_id)
            if done.rc == 3:
                continue
            found = next((m for l in done.out.split("\n") if (m := CONCLUDED.fullmatch(l)) and m.group(1) == request_id), None)
            if done.rc != 0 or found is None:
                raise self.end(4, f"UNKNOWN: tip-run --wait {request_id} exited {done.rc}: {done.out.strip()[-300:]!r}")
            verdict, sha = found.group(2), found.group(4)
            if verdict == "pass" and SHA40.fullmatch(sha):
                self.last = sha
                self.say(f"PASS {request_id} at {sha}")
                return True
            if verdict in ("fail", "timeout"):
                # tip-run's THE HALT NOTE, carried onto the RED line the coordinator reads.
                halt = f"TIP-RUN HALT {request_id} "
                note = next((l[len(halt):] for l in done.out.split("\n") if l.startswith(halt)), "")
                raise self.end(1, f"RED {request_id} ({verdict} at {sha}, log {found.group(5)}): the coordinator's"
                                  " *On a red at the tip* (SKILL.md), then restart with --resume-after " + request_id
                                  + (f" -- {note}" if note else ""))
            if verdict == "cancelled":
                raise self.end(1, f"CANCELLED {request_id} at {sha}: restart with --resume-after {request_id} to go on")
            if verdict == "not-launched":
                self.say(f"NOT STARTED {request_id}: concluded not-launched")
                return False
            raise self.end(4, f"UNKNOWN: {request_id} concluded {verdict!r}")

    def drive(self, resume_after: str) -> int:
        try:
            pending = self.recover(resume_after)
            while True:
                if self.stopped():
                    raise self.end(0, "STOPPED (stop file)")
                if pending is not None:
                    if not self.wait(pending):
                        sleep(self.loop.poll)
                    pending = None
                    continue
                tip = revision.branch_head(self.wave.repository, self.loop.tip, gh_timeout(self.cfg))
                if not isinstance(tip, str):
                    self.say(f"NOTE the tip of {self.loop.tip} is unread ({tip[0]}); polling")
                    sleep(self.loop.poll)
                    continue
                if tip == self.last:
                    sleep(self.loop.poll)
                    continue
                pending = self.start(tip)
                if pending is None:
                    sleep(self.loop.poll)
        except End as end:
            return end.rc


def payload_of(wave: Wave, loop: Loop) -> dict[str, Any]:
    payload: dict[str, Any] = {"wave": wave.wave, "worker": "coordinator", "transport": "coordinator",
                               "purpose": loop.purpose, "agent_host": wave.agent_host, "execution_host": loop.box,
                               "repository": wave.repository, "kind": "correctness"}
    if loop.integration:
        payload["integration"] = True
    return payload


def cmd_loop(cfg: Config, args: list[str]) -> int:
    if len(args) < 2 or args[0].startswith("--") or args[1].startswith("--"):
        die(f"wave loop: name the wave file and the loop; usage: {USAGE}")
    resume_after = ""
    rerun_id = ""
    command: list[str] = []
    if len(args) >= 6 and args[2] == "--rerun" and args[3] and args[4] == "--":
        rerun_id, command = args[3], args[5:]
    elif args[2:]:
        if len(args) != 4 or args[2] != "--resume-after" or not args[3]:
            die(f"wave loop: takes --resume-after <request id> or --rerun <red id> -- <command>; usage: {USAGE}")
        resume_after = args[3]
    wave = load_wave(args[0], "loop")
    loop = wave.loops.get(args[1])
    if loop is None:
        die(f"wave loop: the wave file has no loop {args[1]!r} (it has: {', '.join(wave.loops) or 'none'})")
    logs = os.path.join(wave.directory, "logs")
    try:
        os.makedirs(logs, exist_ok=True)
        lock = open(os.path.join(logs, f"loop-{loop.name}.lock"), "a", encoding="utf-8")
    except OSError as exc:
        die(f"wave loop: cannot open the loop's lock in {logs} ({exc.strerror})")
    with lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            cli.say(f"LOOP {loop.name} REFUSED: another driver holds {lock.name}")
            return 1
        with open(loop_log(wave, loop.name), "a", encoding="utf-8") as log:
            driver = Driver(cfg, wave, loop, log)
            if rerun_id:
                try:
                    return driver.rerun(rerun_id, command)
                except End as end:
                    return end.rc
            write_atomically(driver.payload, json.dumps(payload_of(wave, loop), separators=(",", ":")) + "\n")
            return driver.drive(resume_after)
