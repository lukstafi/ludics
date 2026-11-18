"""``execution windows-witness``: a worker's ``WINDOWS_WITNESS_REQUEST`` run on its dual-boot box
(ludics#1206), the coordinator recipe #1196 wrote out (executions.md, *Coordinator recipe for a
worker's Windows witness*) as one verb:

    execution windows-witness <base.json> <message file|-> --site <site.json> --transcript <path>
                              [--script <file>]

In order: the request is reserved on the box's Linux side as an exclusive measurement (``execution
run``, as fleet-worker.sh invokes it), ``wake-lab.sh boot-windows --as=<id>`` puts the box into
Windows, the revision and the worker's script are staged there (THE STAGING), the native PowerShell
driver runs the script under its cap (THE RUN), ``wake-lab.sh boot-linux --as=<id>`` returns the box
and ``wake-lab.sh status`` must then read ``os=linux``, and only then is the record concluded
(``execution conclude``). Every child's command line and output go to the transcript, which is the
evidence; one ``WITNESS`` line per step goes to stderr.

WHAT IS READ, a fail-closed allowlist; anything outside it refuses the call (exit 2) before the
registry is asked or any box is touched:

- ``<base.json>``: ``execution assign``'s base (``reserve/<task>-base.json``, which ``wave prep``
  writes; ``assign.base_problem``). Its ``transport`` is replaced by ``coordinator``: the
  coordinator, not the worker, holds this reservation. ``wave``, ``worker``, ``agent_host``,
  ``repository`` and ``issue`` are kept, and its ``purpose`` is the fallback for the block's.
- the message (``-``: stdin): the worker's final message as the driver saved it, of which only the
  blocks are read, by ``assign.read_blocks``'s rule with the markers ``WINDOWS_WITNESS_REQUEST`` and
  ``END_WINDOWS_WITNESS_REQUEST``. Exactly one block, one JSON object of BLOCK_FIELDS only.
  Required: ``request_id`` (``[A-Za-z0-9][A-Za-z0-9._-]*``), ``linux_host`` (the box's fleet name,
  the reservation's execution host), ``windows_host`` (an ssh alias on the same row of ``wake-lab.sh
  endpoint-map`` as ``linux_host``, and not ``linux_host`` itself), ``requested_revision`` (a full
  40-hex SHA: the staging checks the commit out, and the registry checks it resolves),
  ``script`` (a string) and ``cap_seconds`` (a whole number, 1 to the site's ``max_cap_seconds``).
  Optional: ``purpose``; ``checkout`` and ``evidence``, which the brief template asks the worker
  for and which are NOT used (the Windows paths are the site's, below, so a worker never names a
  path the coordinator's box writes; they are copied into the transcript).
- the script: ``--script <file>``, else the block's ``script`` when it is the absolute path of a
  regular local file. A block whose ``script`` is the script's text needs ``--script`` (save the
  text you reviewed). Its bytes are read once, here; their sha256 is in the transcript.
- ``--site <site.json>``: one JSON object mapping a box's Linux fleet name to its Windows facts, the
  entry for ``linux_host`` of SITE_FIELDS only (the site's, never the project's or the worker's):
  ``root`` (required: the directory each witness gets a fresh ``<root>/<request_id>`` in),
  ``bash`` (Git Bash; ``C:/Program Files/Git/usr/bin/bash.exe``, the driver's default),
  ``max_cap_seconds`` (3600) and ``stage_seconds`` (900, the staging's whole ssh call), and ``wake``
  (an absolute local path; this checkout's ``scripts/wake-lab.sh``). A Windows path must match
  WINDOWS_PATH, a drive letter and then only letters, digits, blanks and ``._/\\()-``: every one of
  them reaches a cmd.exe command line inside double quotes, where a quote, ``%``, ``^``, ``&``,
  ``|``, ``<``, ``>`` or ``!`` would be read as syntax.
- ``--transcript <path>``: a fresh local file, created exclusively, beside it ``<path>.reserve.json``
  (the ``execution run`` payload), ``<path>.stage.sh`` (the staging script sent, the worker's script
  inside it) and ``<path>.conclude.json``; any of the four existing refuses the call, so an earlier
  attempt's evidence is never taken for this one's.

THE STAGING, one ssh call to ``windows_host`` (``cmd.exe /d /s /c ""<bash>" --noprofile --norc
-s"``, wake-lab's Git Bash form), the staging script on stdin, its values shell-quoted inside it, so
nothing the request names is a cmd.exe word but the request id (allowlisted above): it refuses an
existing ``<root>/<id>``, makes a fresh repository ``<root>/<id>/checkout``, fetches the one commit
from ``https://github.com/<the base's repository>.git`` (``--depth 1``: the revision the registry
checked resolves there, and no clone has to be provisioned or pruned; no credential prompt), checks it out detached with
the box's own git configuration (its ``core.autocrlf`` included, as a developer's clone there would
be: a repository that needs LF says so in its ``.gitattributes``), reads its ``HEAD`` back, writes the
worker's script, the wrapper ``witness.sh`` and this checkout's ``windows-driver.ps1`` beside it
(base64 on the wire), and prints ``observed_sha: <sha>`` last. Only that line, equal to the
revision, with exit 0, counts as staged: the record's ``observed_sha`` is what the staging read, not
a coordinator's say-so. The pinned driver closes the first half of #562 (the documented driver path
was never provisioned): every witness runs the driver of the checkout that runs the verb.

THE RUN. ``powershell -File <root>/<id>/windows-driver.ps1 -ScriptPath <root>/<id>/witness.sh
-LogPath <root>/<id>/run.log -ErrorPath <root>/<id>/run.err -CapSeconds <cap> -BashPath <bash>``,
over ssh, the local cap ``cap + 60`` (the driver owns its process-tree cap and its cleanup).
``witness.sh`` changes to the checkout, prints ``uname -s``, ``git --version`` and ``observed_sha``,
refuses (``exit: 2``) a checkout whose HEAD is not the revision, runs the worker's script with Git
Bash from the checkout's root, ``WITNESS_REVISION`` and ``WITNESS_CHECKOUT`` in its environment (the
second half of #562: the driver passes the script no arguments), and prints ``exit: <its status>``
last, the record the driver requires. The driver prints both native logs; they stay on Windows too.

THE RECOVERY. ``boot-windows`` and ``boot-linux`` run with no outer timeout (wake-lab owns its
bounded boot and BootNext cleanup, ``WAKE_LAB_BOOT_WAIT_SECONDS``), each in its own session, with
INT/TERM deferred in this process meanwhile, so a cancellation never abandons a reboot half done.
``boot-linux`` is attempted after every ``boot-windows`` attempt, whatever happened between, and
the box counts as returned only when ``boot-linux`` exits 0, ``wake-lab.sh status <linux_host>``
then prints the word ``os=linux``, and ``boot-windows`` did not exit 3.

THE FAILURE PATHS, a closed list; each is said on stderr and in the transcript:

- the reservation is refused (the registry's reason above; ``run`` exited 1, 2 or 127): nothing
  reserved, nothing booted; exit 2. ``run`` that did not answer (exit 4), timed out (120 s) or died:
  the dispatch is uncertain, nothing booted; reconcile before anything else; exit 4.
- Windows never answers (``boot-windows`` refused, failed, or reached wake-lab's boot deadline): no
  staging and no run, ``boot-linux``; once Linux is confirmed, concluded ``not-launched``; exit 1.
  ``boot-windows`` exit 3 is wake-lab's NEEDS A PERSON (a reboot or BootNext may be pending): exit 3
  even when Linux answers, the record kept.
- the staging fails or times out (a fetch that cannot reach the revision, an existing
  ``<root>/<id>``, a HEAD that is not the revision, the ssh dropped): no run, ``boot-linux``,
  concluded ``not-launched`` once Linux is confirmed; exit 1.
- the script fails, hangs or the ssh drops: the driver's status (its own timeout is 124), or 124
  for the local cap, 127 for an ssh that cannot start; ``boot-linux`` (the reboot ends whatever
  remained on Windows), then concluded ``timeout`` for 124, else ``fail``; exit 1.
- the box does not come back (``boot-linux`` refused, failed or reached its deadline, or ``status``
  does not read ``os=linux``): NEEDS A PERSON, exit 3, the record kept and never concluded; follow
  wake-lab's recovery guidance (``boot-linux --as=<id>`` once control returns), never rerun.
- INT/TERM, or a local error, after the reservation: the run is abandoned (a cancellation during a
  boot waits for that boot), Linux recovery completes, the record is kept for reconciliation from
  the transcript; exit 4 (exit 3 when Linux is not confirmed).
- the conclusion is refused or its answer lost: Linux has returned, the record stays held or
  uncertain; reconcile it from the transcript and ``<path>.conclude.json``, never rerun; exit 4.

Outside the boundary: a SIGKILL of this process, the coordinator's box losing power, or an
unreachable boot controller (keep the measurement, ``boot-linux --as=<id>`` when control returns,
prove Linux, reconcile); provisioning Windows (Git for Windows, its OpenSSH server, and a git
credential for the repository when it is private); stopping a GPU loop or any other record on the box (``execution run``
refuses the reservation instead; never suspend a record to force a reboot); the script's own
detached work (the driver supervises its foreground tree, and the reboot ends the rest); and removing
``<root>/<id>`` afterwards (it stays as evidence).

Exit: 0 the witness passed, Linux confirmed, concluded ``pass``; 1 concluded ``fail``, ``timeout``
or ``not-launched``, Linux confirmed; 2 refused, nothing reserved or touched; 3 NEEDS A PERSON,
Linux unconfirmed, the record kept; 4 reconcile: an uncertain reservation, a cancellation or local
error, or a conclusion that did not land, the record kept.
"""

import base64
import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from typing import IO, Any, cast

from ludics.fleetworker import assign
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import shown
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import SSH_OPTS, err

USAGE = ("execution windows-witness <base.json> <message file|-> --site <site.json> --transcript <path>"
         " [--script <file>]")
OPEN, CLOSE = "WINDOWS_WITNESS_REQUEST", "END_WINDOWS_WITNESS_REQUEST"
BLOCK_REQUIRED = ("request_id", "linux_host", "windows_host", "requested_revision", "script", "cap_seconds")
BLOCK_FIELDS = frozenset((*BLOCK_REQUIRED, "purpose", "checkout", "evidence"))
SITE_FIELDS = frozenset(("root", "bash", "max_cap_seconds", "stage_seconds", "wake"))
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
DEFAULT_BASH = "C:/Program Files/Git/usr/bin/bash.exe"
WINDOWS_PATH = re.compile(r"[A-Za-z]:[/\\][A-Za-z0-9 ._/\\()-]*")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
OBJECT_ID = re.compile(r"[0-9a-f]{40}")
REGISTRY_CAP = 120  # each `execution run` and `execution conclude`, as the recipe bounded them
STATUS_CAP = 120
SSH_SLACK = 60  # the local cap over the driver's own


@dataclass(frozen=True)
class Site:
    root: str
    bash: str
    max_cap: int
    stage_cap: int
    wake: str


@dataclass(frozen=True)
class Plan:
    """Everything the steps need, read and checked before anything is asked."""

    request_id: str
    linux_host: str
    windows_host: str
    revision: str
    cap: int
    site: Site
    fleet: str  # this checkout's fleet-worker.sh
    reserve: dict[str, Any]
    stage_script: str
    transcript: str

    @property
    def directory(self) -> str:
        return self.site.root.rstrip("/\\") + "/" + self.request_id

    @property
    def checkout(self) -> str:
        return self.directory + "/checkout"


# --- the command line and the readers ---------------------------------------------------------


@dataclass
class Args:
    base: str
    message: str
    site: str
    transcript: str
    script: str


def parse(args: list[str]) -> Args:
    positional: list[str] = []
    flags: dict[str, str] = {}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--site", "--transcript", "--script"):
            if i + 1 >= len(args) or not args[i + 1] or arg in flags:
                die(f"execution windows-witness: {arg} takes one value, once ({USAGE})")
            flags[arg] = args[i + 1]
            i += 2
        elif arg.startswith("--"):
            die(USAGE)
        else:
            positional.append(arg)
            i += 1
    if len(positional) != 2 or "--site" not in flags or "--transcript" not in flags:
        die(USAGE)
    return Args(positional[0], positional[1], flags["--site"], flags["--transcript"], flags.get("--script", ""))


def read_text(path: str, what: str) -> str:
    try:
        if path == "-":
            return sys.stdin.read()
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return f.read()
    except OSError as exc:
        die(f"execution windows-witness: cannot read {what} {shown(path)}: {exc.strerror}")


def read_json(path: str, what: str) -> Any:
    try:
        return json.loads(read_text(path, what))
    except ValueError:
        die(f"execution windows-witness: {what} {shown(path)} is not JSON")


def whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def block_problem(block: Any) -> str | None:
    """THE BLOCK (the header's allowlist, all but the endpoint map and the site's cap)."""
    if not isinstance(block, dict):
        return "the block is not one JSON object"
    fields = cast(dict[str, Any], block)
    unknown = sorted(set(fields) - BLOCK_FIELDS)
    if unknown:
        return f"the block names {', '.join(unknown)}; it takes only {', '.join(sorted(BLOCK_FIELDS))}"
    for key in BLOCK_REQUIRED:
        if key != "cap_seconds" and not (isinstance(fields.get(key), str) and fields[key]):
            return f"the block must give {key}, a nonempty string"
    for key in ("request_id", "linux_host", "windows_host"):
        if not NAME.fullmatch(fields[key]):
            return f"{key} must match {NAME.pattern}"
    if fields["linux_host"] == fields["windows_host"]:
        return "windows_host must be the box's Windows alias, not its linux_host"
    if not OBJECT_ID.fullmatch(fields["requested_revision"]):
        return "requested_revision must be a full 40-hex SHA: the staging checks that one commit out"
    if not whole(fields.get("cap_seconds")):
        return "cap_seconds must be a positive whole number"
    for key in ("purpose", "checkout", "evidence"):
        if key in fields and not isinstance(fields[key], str):
            return f"{key} must be a string"
    return None


def windows_path(value: Any) -> bool:
    return isinstance(value, str) and bool(WINDOWS_PATH.fullmatch(value)) and not value.endswith(("/", "\\"))


def site_entry(site: Any, host: str, default_wake: str) -> Site | str:
    """THE SITE (the header): the entry for ``host``, or why it is refused."""
    if not isinstance(site, dict):
        return "the site is not one JSON object"
    entry = cast(dict[str, Any], site).get(host)
    if not isinstance(entry, dict):
        return f"the site names no entry for {host}"
    fields = cast(dict[str, Any], entry)
    unknown = sorted(set(fields) - SITE_FIELDS)
    if unknown:
        return f"the site's {host} names {', '.join(unknown)}; it takes only {', '.join(sorted(SITE_FIELDS))}"
    paths: dict[str, Any] = {"bash": DEFAULT_BASH, **{key: fields[key] for key in ("root", "bash") if key in fields}}
    if isinstance(paths.get("root"), str):
        paths["root"] = paths["root"].rstrip("/\\")  # always followed by /<name>, never by a quote
    for key in ("root", "bash"):
        if not windows_path(paths.get(key)):
            return (f"the site's {host}.{key} must be a Windows path, a drive letter and then only letters,"
                    " digits, blanks and ._/\\()-" + (" (the program, no trailing separator)" if key == "bash" else ""))
    for key in ("max_cap_seconds", "stage_seconds"):
        if key in fields and not whole(fields[key]):
            return f"the site's {host}.{key} must be a positive whole number"
    wake = fields.get("wake", default_wake)
    if not (isinstance(wake, str) and os.path.isabs(wake)):
        return f"the site's {host}.wake must be an absolute local path"
    return Site(paths["root"], paths["bash"],
                fields.get("max_cap_seconds", 3600), fields.get("stage_seconds", 900), wake)


def endpoint_problem(map_text: str, linux_host: str, windows_host: str) -> str | None:
    """``windows_host`` on ``linux_host``'s row of ``wake-lab.sh endpoint-map`` (a box, then its
    aliases), or why not: a witness boots one box and must reach that same box's Windows."""
    for line in map_text.split("\n"):
        words = line.split()
        if words and linux_host in words:
            if windows_host in words[1:]:
                return None
            return f"windows_host {windows_host} is not an alias of {linux_host}'s box ({' '.join(words)})"
    return f"linux_host {linux_host} is on no row of the endpoint map"


def script_bytes(block: dict[str, Any], flag: str) -> bytes:
    path = flag or block["script"]
    if not flag and not (os.path.isabs(path) and "\n" not in path and os.path.isfile(path)):
        die("execution windows-witness: the block's script is not the absolute path of a local file;"
            " save the script you reviewed and name it with --script")
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as exc:
        die(f"execution windows-witness: cannot read the script {shown(path)}: {exc.strerror}")
    if not data.strip():
        die(f"execution windows-witness: the script {shown(path)} is empty")
    return data


# --- what runs on Windows -----------------------------------------------------------------------


def cmd_line(inner: str) -> str:
    """One command through cmd.exe, as wake-lab sends its Git Bash probe: ``/s`` strips exactly the
    outer quotes, so the inner quotes stay the program's."""
    return f'cmd.exe /d /s /c "{inner}"'


def stage_command(site: Site) -> str:
    return cmd_line(f'"{site.bash}" --noprofile --norc -s')


def run_command(plan: Plan) -> str:
    d = plan.directory
    return cmd_line(
        f'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{d}/windows-driver.ps1"'
        f' -ScriptPath "{d}/witness.sh" -LogPath "{d}/run.log" -ErrorPath "{d}/run.err"'
        f' -CapSeconds {plan.cap} -BashPath "{plan.site.bash}"'
    )


GIT_BASH_PATH = 'export PATH="/usr/bin:/mingw64/bin:$PATH"\n'


def witness_script(checkout: str, revision: str, script: str) -> str:
    """The driver's ``-ScriptPath``: THE RUN's wrapper (the header)."""
    q = shlex.quote
    return (
        GIT_BASH_PATH
        + f"cd {q(checkout)} || {{ printf 'exit: %s\\n' 2; exit 2; }}\n"
        + "printf 'uname -s: %s\\n' \"$(uname -s)\"\n"
        + "printf 'git --version: %s\\n' \"$(git --version)\"\n"
        + "observed=$(git rev-parse HEAD)\n"
        + "printf 'observed_sha: %s\\n' \"$observed\"\n"
        + f"if [ \"$observed\" != {q(revision)} ]; then printf 'exit: %s\\n' 2; exit 2; fi\n"
        + f"WITNESS_REVISION={q(revision)} WITNESS_CHECKOUT={q(checkout)} \"$BASH\" --noprofile --norc {q(script)}\n"
        + "rc=$?\n"
        + "printf 'exit: %s\\n' \"$rc\"\n"
        + 'exit "$rc"\n'
    )


def staging_script(site: Site, request_id: str, revision: str, url: str, script: bytes, driver: bytes) -> str:
    """THE STAGING (the header): Git Bash on Windows reads this on stdin."""
    q = shlex.quote
    directory = site.root + "/" + request_id
    checkout = directory + "/checkout"
    files = (("script.sh", script), ("witness.sh", witness_script(checkout, revision, directory + "/script.sh").encode()),
             ("windows-driver.ps1", driver))
    lines = [
        "set -u",
        GIT_BASH_PATH.rstrip("\n"),
        "export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never  # no credential prompt in an ssh session",
        "fail() { printf 'WITNESS STAGE FAILED: %s\\n' \"$1\"; exit 1; }",
        f"root={q(site.root)} url={q(url)} sha={q(revision)} dir={q(directory)}",
        '[ ! -e "$dir" ] || fail "$dir exists: a request id is staged once"',
        'mkdir -p "$root" && mkdir "$dir" || fail "cannot make $dir"',
        'git init --quiet "$dir/checkout" || fail "cannot make a repository at $dir/checkout"',
        'git -C "$dir/checkout" fetch --quiet --no-tags --depth 1 "$url" "$sha" || fail "cannot fetch $sha from $url"',
        'git -C "$dir/checkout" checkout --quiet --detach FETCH_HEAD || fail "cannot check $sha out"',
        'observed=$(git -C "$dir/checkout" rev-parse HEAD) || fail "cannot read the checkout\'s HEAD"',
        '[ "$observed" = "$sha" ] || fail "the checkout is at $observed, not $sha"',
    ]
    for name, data in files:
        encoded = base64.b64encode(data).decode("ascii")
        lines.append(f"printf '%s' '{encoded}' | base64 -d > \"$dir\"/{name} || fail 'cannot write {name}'")
    lines.append("printf 'observed_sha: %s\\n' \"$observed\"")
    return "\n".join(lines) + "\n"


# --- the steps ----------------------------------------------------------------------------------


class Log:
    """The transcript: each child's argv and cap, its output, its return code."""

    def __init__(self, f: IO[str]) -> None:
        self.f = f

    def note(self, text: str) -> None:
        self.f.write(text + "\n")
        self.f.flush()

    def call(self, argv: list[str], cap: int | None, *, isolated: bool = False, stdin: str | None = None,
             capture: bool = False) -> tuple[int, str]:
        """``argv`` with its output in the transcript; (its status, its stdout when ``capture``,
        which is copied to the transcript too). 124 is the cap, 127 a program that cannot start."""
        self.note(json.dumps({"argv": argv, "cap": cap}))
        out = ""
        try:
            if not capture:
                rc = subprocess.run(argv, stdout=self.f, stderr=self.f, timeout=cap, start_new_session=isolated).returncode
            else:
                done = subprocess.run(argv, input=(stdin or "").encode("utf-8", "surrogateescape"), stdout=subprocess.PIPE,
                                      stderr=self.f, timeout=cap, start_new_session=isolated)
                out = done.stdout.decode("utf-8", "surrogateescape")
                self.f.write(out if out.endswith("\n") or not out else out + "\n")
                rc = done.returncode
        except subprocess.TimeoutExpired:
            rc = 124
        except OSError as exc:
            self.note(str(exc))
            rc = 127
        self.note("returncode: " + str(rc))
        return rc, out


def step(name: str, text: str) -> None:
    err(f"WITNESS {name}: {text}")


@contextmanager
def deferred(pending: list[int]) -> Generator[None]:
    """INT and TERM recorded, not raised, while a boot runs (THE RECOVERY)."""

    def defer(signum: int, frame: Any) -> None:
        pending.append(signum)

    term = signal.signal(signal.SIGTERM, defer)
    intr = signal.signal(signal.SIGINT, defer)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, term)
        signal.signal(signal.SIGINT, intr)


def staged_sha(rc: int, out: str, revision: str) -> bool:
    lines = [line.rstrip("\r") for line in out.split("\n") if line.strip()]
    return rc == 0 and bool(lines) and lines[-1] == "observed_sha: " + revision


def linux_confirmed(log: Log, plan: Plan, boot: int) -> bool:
    """THE RECOVERY: boot-linux, then status reading ``os=linux``; never after a boot-windows 3."""
    rc, _ = log.call([plan.site.wake, "boot-linux", "--as=" + plan.request_id, plan.linux_host], None, isolated=True)
    step("boot-linux", f"exit {rc}")
    if rc != 0:
        return False
    status, out = log.call([plan.site.wake, "status", plan.linux_host], STATUS_CAP, capture=True)
    on_linux = status == 0 and "os=linux" in out.split()
    step("status", "os=linux" if on_linux else f"exit {status}, os=linux not read")
    return on_linux and boot != 3


def execute(plan: Plan, f: IO[str]) -> int:
    """The steps, from the reservation to the conclusion (the header's order and exits), the
    transcript ``f`` already created, ``<transcript>.reserve.json`` written."""
    log = Log(f)
    log.note("windows-witness " + plan.request_id + ": " + json.dumps({
        "linux_host": plan.linux_host, "windows_host": plan.windows_host, "revision": plan.revision,
        "cap_seconds": plan.cap, "site": asdict(plan.site)}))
    step("transcript", plan.transcript)
    try:
        rc, _ = log.call([plan.fleet, "execution", "run", plan.transcript + ".reserve.json"], REGISTRY_CAP)
    except KeyboardInterrupt:
        rc = 130
    if rc != 0:
        refused = rc in (1, 2, 127)
        log.note("NOT RESERVED: " + ("refused; nothing booted" if refused else "uncertain dispatch; reconcile, never retry blind"))
        step("reserve", f"execution run exited {rc}: " + ("refused (the reason is in the transcript); nothing reserved, nothing booted" if refused
             else "the dispatch is uncertain; nothing booted; read execution list and reconcile before anything else"))
        return 2 if refused else 4
    step("reserve", f"{plan.request_id} reserved on {plan.linux_host}")
    boot, launched, observed, verdict_rc = 2, False, "", 2
    pending: list[int] = []
    failure = ""
    try:
        with deferred(pending):
            boot, _ = log.call([plan.site.wake, "boot-windows", "--as=" + plan.request_id, plan.linux_host], None, isolated=True)
        step("boot-windows", f"exit {boot}")
        if pending:
            raise KeyboardInterrupt("cancelled during boot-windows")
        if boot == 0:
            staged, out = log.call(["ssh", *SSH_OPTS, plan.windows_host, stage_command(plan.site)], plan.site.stage_cap,
                                   stdin=plan.stage_script, capture=True)
            if staged_sha(staged, out, plan.revision):
                observed = plan.revision
                step("stage", f"{plan.checkout} at {observed}")
                launched = True
                verdict_rc, _ = log.call(["ssh", *SSH_OPTS, plan.windows_host, run_command(plan)], plan.cap + SSH_SLACK)
                step("run", f"driver exit {verdict_rc}")
            else:
                step("stage", f"exit {staged}, no observed_sha line for {plan.revision}: not launched")
    except (KeyboardInterrupt, Exception) as exc:  # the run is abandoned; recovery still runs
        failure = f"{type(exc).__name__}: {exc}"
        log.note("INTERRUPTED: " + failure)
        step("interrupted", failure + "; returning the box to Linux")
    with deferred(pending):
        recovered = linux_confirmed(log, plan, boot)
    if not recovered:
        log.note("NEEDS A PERSON: Linux/BootNext recovery unconfirmed; the reservation is kept; reconcile")
        step("NEEDS A PERSON", f"{plan.linux_host} is not confirmed back on Linux; {plan.request_id} kept;"
             f" wake-lab.sh boot-linux --as={plan.request_id} {plan.linux_host} once control returns, then reconcile")
        return 3
    if failure or pending:
        log.note("CANCELLED: Linux confirmed; the reservation is kept for reconciliation")
        step("reconcile", f"Linux confirmed; {plan.request_id} kept, not concluded; reconcile from {plan.transcript}")
        return 4
    verdict = ("pass" if verdict_rc == 0 else "timeout" if verdict_rc == 124 else "fail") if launched else "not-launched"
    conclusion: dict[str, Any] = {"request_id": plan.request_id, "verdict": verdict, "log": plan.transcript}
    if launched:
        conclusion.update({"observed_sha": observed, "remote_checkout": plan.checkout,
                           "handle": "windows-driver:" + plan.request_id})
        conclusion["evidence"] = (
            f"execution windows-witness: native driver exit {verdict_rc} on {plan.windows_host}; staged"
            f" {plan.checkout} read back at {observed}; native logs {plan.directory}/run.log and run.err;"
            f" boot-linux and wake-lab status confirmed Linux; transcript {plan.transcript}")
    else:
        conclusion["evidence"] = (
            f"execution windows-witness: not launched (boot-windows exit {boot}"
            + (", staging failed" if boot == 0 else "") + f"); boot-linux and wake-lab status confirmed Linux;"
            f" transcript {plan.transcript}")
    path = plan.transcript + ".conclude.json"
    with open(path, "x", encoding="utf-8") as out_file:
        json.dump(conclusion, out_file)
    try:
        concluded, _ = log.call([plan.fleet, "execution", "conclude", path], REGISTRY_CAP)
    except KeyboardInterrupt:
        concluded = 130
    if concluded != 0:
        log.note("CONCLUSION NOT LANDED: reconcile from the transcript; never rerun the witness")
        step("conclude", f"exited {concluded}; Linux confirmed; reconcile {plan.request_id} from {shown(path)}, never rerun")
        return 4
    step("concluded", f"{plan.request_id} {verdict}")
    return 0 if verdict == "pass" else 1


# --- the verb -----------------------------------------------------------------------------------


def plan_of(cfg: Config, args: list[str], *, read_map: Callable[[str], str | None] | None = None) -> Plan:
    """Every read and check of WHAT IS READ, in order; a usage death (exit 2) on the first refusal."""
    parsed = parse(args)
    base = read_json(parsed.base, "the base")
    problem = assign.base_problem(base)
    if problem:
        die(f"execution windows-witness: {problem} ({shown(parsed.base)})")
    if not REPOSITORY.fullmatch(base["repository"]):
        die(f"execution windows-witness: the base's repository must be <owner>/<name> on GitHub ({shown(parsed.base)})")
    blocks = assign.read_blocks(read_text(parsed.message, "the message"), OPEN, CLOSE)
    if isinstance(blocks, str):
        die(f"execution windows-witness: {blocks} in {shown(parsed.message)}")
    if len(blocks) != 1:
        die(f"execution windows-witness: {len(blocks)} blocks in {shown(parsed.message)}; one witness per call")
    problem = block_problem(blocks[0])
    if problem:
        die(f"execution windows-witness: {problem}")
    block = cast(dict[str, Any], blocks[0])
    site = site_entry(read_json(parsed.site, "the site"), block["linux_host"], os.path.join(cfg.checkout, "scripts", "wake-lab.sh"))
    if isinstance(site, str):
        die(f"execution windows-witness: {site} ({shown(parsed.site)})")
    if block["cap_seconds"] > site.max_cap:
        die(f"execution windows-witness: cap_seconds {block['cap_seconds']} is past the site's max_cap_seconds {site.max_cap}")
    for path in (parsed.transcript, *(parsed.transcript + suffix for suffix in (".reserve.json", ".stage.sh", ".conclude.json"))):
        if os.path.lexists(path):
            die(f"execution windows-witness: {shown(path)} exists; name a fresh transcript")
    script = script_bytes(block, parsed.script)
    driver_path = os.path.join(cfg.checkout, "issue-wave", "scripts", "windows-driver.ps1")
    try:
        with open(driver_path, "rb") as f:
            driver = f.read()
    except OSError as exc:
        die(f"execution windows-witness: cannot read {shown(driver_path)}: {exc.strerror}")
    map_text = (read_map or endpoint_map)(site.wake)
    if map_text is None:
        die(f"execution windows-witness: {shown(site.wake)} endpoint-map failed")
    problem = endpoint_problem(map_text, block["linux_host"], block["windows_host"])
    if problem:
        die(f"execution windows-witness: {problem}")
    request = {key: base[key] for key in assign.BASE_FIELDS if key in base and key != "purpose"}
    request.update({"transport": "coordinator", "request_id": block["request_id"], "execution_host": block["linux_host"],
                    "kind": "measurement", "requested_revision": block["requested_revision"],
                    "purpose": block.get("purpose") or base.get("purpose") or f"Windows witness on {block['windows_host']}"})
    reserve = {**request, "evidence": (f"reserved by execution windows-witness for {block['windows_host']};"
                                       f" script sha256 {hashlib.sha256(script).hexdigest()}; transcript {parsed.transcript}")}
    return Plan(block["request_id"], block["linux_host"], block["windows_host"], block["requested_revision"],
                block["cap_seconds"], site, os.path.join(cfg.here, os.path.basename(cfg.script)), reserve,
                staging_script(site, block["request_id"], block["requested_revision"],
                               f"https://github.com/{base['repository']}.git", script, driver),
                os.path.abspath(parsed.transcript))


def endpoint_map(wake: str) -> str | None:
    try:
        done = subprocess.run(["bash", wake, "endpoint-map"], stdout=subprocess.PIPE, timeout=STATUS_CAP)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.decode("utf-8", "surrogateescape") if done.returncode == 0 else None


def interrupted(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt(f"signal {signum}")


def cmd_windows_witness(cfg: Config, args: list[str]) -> int:
    plan = plan_of(cfg, args)
    try:
        for path, text in ((plan.transcript + ".reserve.json", json.dumps(plan.reserve, separators=(",", ":")) + "\n"),
                           (plan.transcript + ".stage.sh", plan.stage_script)):
            with open(path, "x", encoding="utf-8") as f:
                f.write(text)
        transcript = open(plan.transcript, "x", encoding="utf-8")
    except OSError as exc:
        die(f"execution windows-witness: cannot write {shown(plan.transcript)} and its side files: {exc.strerror};"
            " nothing reserved")
    term = signal.signal(signal.SIGTERM, interrupted)
    try:
        with transcript:
            return execute(plan, transcript)
    finally:
        signal.signal(signal.SIGTERM, term)
