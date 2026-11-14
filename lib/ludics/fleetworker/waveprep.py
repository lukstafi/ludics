"""``wave prep``: one worker's launch prep in one call (ludics#1047).

``wave prep <wave.json> <task> --base <rev> [--issue <N> | --source <N>] [--mode none|paired|paired+critique]
[--legs <box,...>] [--allow-rival <pr>]... [--profile <name>] [--host <box>]`` makes what a worker needs before it is spawned: its
worktree and branch, its scratch directory, its standing reservations (the agent host's, and one per
GPU home box ``--legs`` names), its rendered brief, its ``execution assign`` base, and its board row.
Each wave's ``next.sh`` did this by hand, and each copy lost an exit status in a pipe, rendered the
brief after the worktree existed, and printed rival PRs without refusing on one.

THE TASK. ``<task>`` is the board's task id. A ``t<N>`` task is issue N of the wave file's
``issue_repository`` unless ``--issue`` names another; any other id (a post-wave ``p8``) is no
issue's and needs ``--source <N>``, the issue it came from: it gets no ``ISSUE`` placeholder and no
``issue=`` on its row, so a template that still speaks of closing an issue refuses to render rather
than give a no-issue task a closing keyword. The worker is ``<worker_prefix>-<N>`` (``-<task>``
for a --source task), its branch ``<kind>/<worker>``, its worktree
``<checkout>-worktrees/<worker>``, its scratch ``<wave dir>/scratch/<task>``.

THE WORKER'S KIND AND HOST (a mixed wave). ``--profile <name>`` gives the task one of the wave
file's ``profiles`` in place of the wave's own transport and kind, and ``--host <box>`` puts a CLI
worker's agent on another box than the wave's agent host (a native worker runs where its
coordinator does, so ``--host`` with a ``subagent`` transport refuses). A host that is not the
agent host is one of the wave file's ``hosts``: the worktree is then
``<hosts.<box>.checkout>-worktrees/<worker>`` and the scratch ``<hosts.<box>.scratch>/<wave>/<task>``,
both on that box. HOST, WT, SCR and CHECKOUT (the host's clone) are the task's own.

A CLI TASK (transport ``cli``) is prepared and not made. ``fleet-worker.sh launch`` makes a CLI
worker's worktree on its box and takes its standing reservation in one fenced step, so prep makes
neither: it writes the brief, the standing payloads (the host's without a ``checkout``, which
launch fills in; unreserved), the assign base and the pending row, and its manifest records what
``wave launch <wave.json> <task>`` (wavelaunch.py) needs to start the worker. Its reads skip what
only the host can answer (a remote host's worktree path and local branch); ``launch`` refuses those
on the box. Its shipped template directory is ``cli-<kind>``.

THE BRIEF is wavebrief.py's render of these parts, in this order: THE COMMON PARTS; ``tasks/<task>.md``;
with --legs, ``legs.md``, whose ``@@LEGLINES@@`` is ``leg.md`` rendered once per leg; with a --mode
other than none, ``planning-<mode>.md``; and ``tail.md`` when it exists. Every part but tail.md is
required. The NAMEs every part is given: WAVE, T (the task), N, ISSUE (``<issue_repository>#<N>``,
issue tasks only) or SOURCE (--source tasks only), REPO, ISSUE_REPO (the wave file's
issue_repository, every task), CHECKOUT (the repository's clone on the worker's host), WAVE_DIR,
WT, BR, BASE (the full SHA), BASE_ORIGIN (the verified origin at prep time, or the explicit base
revision), SCR, SCR_PARENT (the host-local, wave-shared parent of SCR), WORKER, HOST (the agent
host), MODE, PROJECT (THE PROJECT PART, only where a part names it), and the wave file's ``vars``;
``leg.md`` is given LEG (the box), LEG_ID (its reservation id), LEG_WT (the far-side worktree),
LEG_CHECKOUT and the leg's ``vars`` besides. The reservations' purposes are rendered with the same
NAMEs, PROJECT aside.

THE HOST PATH BOUNDARY. For a worker outside the wave's agent host, prep refuses the exact
``@@WAVE_DIR@@`` placeholder in every part it renders (including the selected project part,
leg parts and reservation purposes). WAVE_DIR is the coordinator's path; SCR_PARENT is shared
by this wave's workers on the worker's host. This checks placeholders in selected parts only:
not literal paths, prose, unused parts or the meaning of values supplied by wave/leg vars.
Agent-host workers may still name WAVE_DIR. Generic ``wave render`` has no host and is unchanged.

THE COMMON PARTS, the sections every worker's brief opens with. A wave directory's ``common.md`` is
all of them, whole, when it exists (a wave that writes its own brief). Else they are ``COMMON``, in
order: ``who.md``, ``where.md``, ``startup.md``, ``task.md``, ``tests.md``, ``requests.md``,
``blocking.md``, ``context.md``, ``landing.md``, ``checkpoint.md`` (only for a wave file that names
a ``review``: the review checkpoint's protocol, wavereview.py) and ``after-merge.md``. Each is the
first of: the wave directory's ``common/<part>``; the shipped part of the worker's own kind,
``issue-wave/templates/<native|cli>-<kind>/<part>``; the shipped ``issue-wave/templates/shared/<part>``.
The repository ships a kind's ``OWN`` parts (who it is, how it runs tests, how it holds a long run,
its context) for ``native-claude``, ``native-codex`` and ``cli-codex``, and the ``SHARED`` parts
once, so a rule both transports follow is stated in one file. A part found nowhere refuses, naming it: a kind with no
shipped directory (``cli-claude``) takes its own parts from the wave directory.

THE PARTS, where each other part is found (ludics#1072): the wave directory's part wins; for the
two ``PLANNING`` parts (``planning-paired.md``, ``planning-paired+critique.md``) the shipped one of
the worker's kind stands in when the wave directory has none (``native-claude`` ships them); any
other part is the wave directory's or refuses. The shipped parts are the reference brief, where
a worker's rules live (issue-wave SKILL.md's *The brief* says what a task part adds to them), and
are read by check-prompts (checkprompts/brieftemplate.py). They hold no project fact: the NAMEs they use are the built-ins
above plus ``SHIPPED_VARS`` (COORDINATOR, the coordinator's session id, and MAIN, the main branch),
which the wave file's ``vars`` supply, and PROJECT. The common parts speak of no issue (no ISSUE,
no SOURCE), so they render for a --source task; the planning parts name ISSUE, so a paired --source
task refuses on them unless the wave directory gives its own.

THE PROJECT PART, the value of PROJECT, read only when some part names ``@@PROJECT@@``: the wave
directory's ``project.md`` when it exists, else the file the wave file's ``project_part`` names,
read from the checkout at the task's base, else at the local remote-tracking default-branch tip
(``origin/<vars.MAIN>``). Prep never fetches or reads the checked-out tree. It reports the selected
path and revision. The default tip is resolved once with the base, so the origin label and
fallback refer to the same commit even if a remote-tracking ref moves meanwhile. A fallback
needs vars.MAIN and its remote-tracking commit; neither available refuses.
BASE_ORIGIN calls a base the default tip only when its SHA equals that local tip; otherwise it names the explicit revision, without guessing which sibling branch owns it. Either is
rendered first with every NAME above but PROJECT and the legs', and its result is the value. Neither
existing, or the path absent at both revisions, refuses.

IN ORDER, every read before any write:
  1. THE READS. The anchor gate (the lease and the halt, ``launch``'s ``anchor_gate``), so no
     worktree is made under another coordinator's wave. ``--base`` resolved to a full SHA in the
     checkout. The rival PRs. The worktree path, the branch in ``git worktree list``, the local
     branch and origin's branch: any one existing refuses. A prep manifest for the task refuses
     (THE RECOVERY BOUNDARY), and so does any file this prep would write that exists already (a
     payload, the assign base, the brief): the names are built from the task id and the legs'
     suffixes, and a CLI task's files must still be its own at its launch. The registry holding any of the task's standing ids, and the board
     holding the task's row, refuse. Every template part read and rendered, in memory, with the
     purposes: an unrendered placeholder refuses here, before anything is made.
  2. THE WRITES: the manifest (the identities about to be made), ``git worktree add -b``, the
     scratch ``runs/`` directory, the standing reservations by ``execution run`` (the agent host's
     first, ``<wave>-<task>-<agent_host>-iterate`` on the worktree; then each leg's
     ``<wave>-<task>-<box>-iterate`` on its far-side worktree, each with its own execution host),
     the brief (``briefs/brief-<task>.md``) and the assign base (``reserve/<task>-base.json``,
     ``execution assign``'s base: wave, worker, transport, agent_host, repository, and issue for an
     issue task; a --source task's records and base name no issue), then the
     board row with ``state=pending`` (and, with a --mode, ``plan_dir=$ISSUE_WAVE_STATE/plans/<wave>-<N>``,
     ``<wave>-<task>`` for a --source task, so two tasks of one source never share one). Each step's exit is read, never piped away, and recorded in
     the manifest once it is confirmed.
  3. ``WAVE PREP <task>: ready ...`` on stdout, exit 0.

What prep does NOT do: spawn the worker, run the launch gate (``gate --wait``, right before the
spawn, since a pass is a point in time), name an ``agent`` or mark the row launched (the spawn's
identity is the runtime's), or run the provider preflight (``preflight <box> --native-claude`` or
``--native-codex``, once per box per wave: a prerequisite, not a step).

THE RIVAL PR read, a preliminary check and not the coordinator's whole search: ``gh pr list --state
open --limit 100`` in the repository, ``--head <branch>`` for every task and ``--search <N>`` beside
it for an issue task (a number search misses a PR whose head is the branch and whose text names no
number). A rival is an open PR whose head is the branch, or (issue tasks) whose title or body
holds the token ``#<N>`` -- after a line start, a non-word character or an ``<owner>/<name>`` -- not
followed by a digit. A full page of 100 hits on either read is refused as unread, never taken as no rival.
``--allow-rival <pr>`` passes one listed PR the coordinator has judged no rival. Closed PRs, comments,
other repositories and a topic that names no number are outside it: SKILL.md keeps the coordinator's
topic search immediately before the launch.

THE BOARD read: a row is found only on a board that reads. A board that does not answer is unknown
(exit 4). A board the store refuses to show is taken as no row only when the refusal is the
store's own exit for a wave with no board yet (``boardstore.NO_BOARD_EXIT``, never its text;
``board set --create`` then starts it); any other refusal (a malformed board) refuses, before
anything is made. The far-side leg worktree is not read (no ssh): ``execution leg``
makes it on first use.

THE RECOVERY BOUNDARY. Prep is not resumable, and never deletes or concludes anything. A refusal
in the reads makes nothing. A failure in the writes prints ``WAVE PREP FAILED <task> at <step>:
<why>`` (``WAVE PREP UNKNOWN`` when the anchor, git's remote or gh did not answer), then one
``WAVE PREP MADE <task>: <what>`` line per step the manifest records as done, and the manifest's path,
and exits 1 (4). A second prep of the task refuses on that manifest; what to keep, conclude or
remove is the coordinator's call, made from those lines.

Exit: 0 ready; 1 refused or failed; 2 usage; 4 unknown.
"""

import json
import os
import re
import shlex
from dataclasses import dataclass, field
from typing import Any, cast

from ludics import cli, proc
from ludics.fleetworker.boardstore import NO_BOARD_EXIT
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import gh_timeout, listing, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.takeover import board_status, row_of
from ludics.fleetworker.transport import run
from ludics.fleetworker.wave import USAGE, Leg, Profile, Wave, load_wave, shim
from ludics.fleetworker.wavebrief import PLACEHOLDER, Part, render, write_atomically

MODES = ("none", "paired", "paired+critique")
TASK = re.compile(r"[A-Za-z][A-Za-z0-9-]*")
ISSUE_TASK = re.compile(r"t([0-9]+)")
SHA40 = re.compile(r"[0-9a-f]{40}")
PR_PAGE = 100
# THE PARTS: the shipped reference template, four directories above this module (lib/ludics/fleetworker/).
TEMPLATES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
                         "issue-wave", "templates")
# THE COMMON PARTS, in the brief's order; OWN are a kind's own, the rest are shipped once, shared.
COMMON = ("who.md", "where.md", "startup.md", "task.md", "tests.md", "requests.md", "blocking.md", "context.md",
          "landing.md", "checkpoint.md", "after-merge.md")
OWN = ("who.md", "tests.md", "blocking.md", "context.md")
SHARED = tuple(name for name in COMMON if name not in OWN)
PLANNING = ("planning-paired.md", "planning-paired+critique.md")
SHIPPED_VARS = ("COORDINATOR", "MAIN")
READY = "ready"  # the manifest's last step: every write of prep landed (wave launch starts nothing without it)


@dataclass
class Prep:
    wave: Wave
    task: str
    number: str
    issue_ref: str  # "" for a --source task
    source_ref: str  # "" for an issue task
    base: str
    mode: str
    legs: list[Leg]
    allow_rival: set[str]
    state: str  # ISSUE_WAVE_STATE, as the config reads it: the plans directory's parent
    profile: str = ""  # --profile: one of the wave file's profiles; "" for the wave's own transport and kind
    host: str = ""  # --host: the worker's agent host; "" for the wave's
    worker: str = ""
    branch: str = ""
    worktree: str = ""
    scratch: str = ""
    transport: str = ""
    kind: str = ""
    model: str = ""
    effort: str = ""
    host_checkout: str = ""  # the repository's clone on the host
    base_origin: str = ""
    default_tip: str | None = None
    done: list[str] = field(default_factory=lambda: [])

    def __post_init__(self) -> None:
        chosen = self.wave.profiles[self.profile] if self.profile else Profile(self.wave.transport, self.wave.kind)
        self.transport, self.kind, self.model, self.effort = chosen.transport, chosen.kind, chosen.model, chosen.effort
        self.host = self.host or self.wave.agent_host
        place = self.wave.hosts[self.host] if self.remote else None
        self.host_checkout = place.checkout if place else self.wave.checkout
        self.worker = f"{self.wave.worker_prefix}-{self.number if self.issue_ref else self.task}"
        self.branch = f"{self.kind}/{self.worker}"
        self.worktree = f"{self.host_checkout}-worktrees/{self.worker}"
        self.scratch = (os.path.join(place.scratch, self.wave.wave, self.task) if place
                        else os.path.join(self.wave.directory, "scratch", self.task))

    @property
    def cli(self) -> bool:
        return self.transport == "cli"

    @property
    def remote(self) -> bool:
        """The worker's host is another box than the wave's agent host (the coordinator's)."""
        return self.host != self.wave.agent_host

    @property
    def boxes(self) -> list[str]:
        """The boxes the task has a standing reservation on: its host, then each leg's."""
        return [self.host, *(leg.box for leg in self.legs)]

    def standing_id(self, box: str) -> str:
        return f"{self.wave.wave}-{self.task}-{box}-iterate"

    def leg_worktree(self, leg: Leg) -> str:
        return f"{leg.checkout}-worktrees/{self.worker}-{leg.suffix}"

    def path(self, *parts: str) -> str:
        return os.path.join(self.wave.directory, *parts)

    @property
    def manifest(self) -> str:
        return self.path("prep", f"{self.task}.json")


@dataclass(frozen=True)
class Rivalry:
    """What the rival-PR read needs of a task: prep's own (``rivalry_of``), or for ``wave launch`` the
    one its manifest recorded."""
    task: str
    verb: str  # how a refusal names its caller: WAVE PREP, WAVE LAUNCH
    repository: str
    branch: str
    number: str
    issue_ref: str  # "" for a --source task
    allow_rival: frozenset[str]


def rivalry_of(prep: Prep) -> Rivalry:
    return Rivalry(prep.task, "WAVE PREP", prep.wave.repository, prep.branch, prep.number, prep.issue_ref, frozenset(prep.allow_rival))


class Stop(Exception):
    """A refusal or failure: its exit status and its line."""

    def __init__(self, rc: int, line: str) -> None:
        super().__init__(line)
        self.rc = rc
        self.line = line


def parse(args: list[str]) -> tuple[str, str, dict[str, Any]]:
    if len(args) < 2 or args[0].startswith("--") or args[1].startswith("--"):
        die(f"wave prep: name the wave file and the task; usage: {USAGE}")
    opts: dict[str, Any] = {"base": "", "issue": "", "source": "", "mode": "none", "legs": "", "allow_rival": set(),
                            "profile": "", "host": ""}
    rest = args[2:]
    i = 0
    while i < len(rest):
        word = rest[i]
        key = {"--base": "base", "--issue": "issue", "--source": "source", "--mode": "mode", "--legs": "legs",
               "--allow-rival": "allow_rival", "--profile": "profile", "--host": "host"}.get(word)
        if key is None or i + 1 >= len(rest):
            die(f"wave prep: {'unknown option ' + word if key is None else word + ' needs a value'}; usage: {USAGE}")
        if key == "allow_rival":
            opts[key].add(rest[i + 1].lstrip("#"))
        else:
            opts[key] = rest[i + 1]
        i += 2
    return args[0], args[1], opts


def subject(wave: Wave, task: str, issue: str, source: str, verb: str) -> tuple[str, str, str]:
    """What a task is about, as ``(number, issue_ref, source_ref)``: the issue of a ``t<N>`` task or of
    ``--issue``, or the issue a ``--source`` task came from; one ref is empty. ``wave review`` reads a
    task the same way."""
    if issue and source:
        die(f"wave {verb}: --issue and --source exclude each other")
    for given in (issue, source):
        if given and not given.isdigit():
            die(f"wave {verb}: an issue number is digits, not {given!r}")
    issue_task = ISSUE_TASK.fullmatch(task)
    if source:
        return source, "", f"{wave.issue_repository}#{source}"
    if issue or issue_task:
        number = issue or (issue_task.group(1) if issue_task else "")
        return number, f"{wave.issue_repository}#{number}", ""
    die(f"wave {verb}: task {task} is no t<N>: name its issue with --issue <N>, or with --source <N> the issue a no-issue task came from")


def build(cfg: Config, path: str, task: str, opts: dict[str, Any]) -> Prep:
    wave = load_wave(path, "prep")
    if not TASK.fullmatch(task):
        die(f"wave prep: task {task!r} does not match {TASK.pattern}")
    if opts["mode"] not in MODES:
        die(f"wave prep: --mode is one of {', '.join(MODES)}, not {opts['mode']!r}")
    if not opts["base"]:
        die("wave prep: --base <rev> is required (the verified base the worktree starts from)")
    number, issue_ref, source_ref = subject(wave, task, opts["issue"], opts["source"], "prep")
    profile, host = opts["profile"], opts["host"]
    if profile and profile not in wave.profiles:
        die(f"wave prep: --profile names {profile!r}, which the wave file's profiles do not (it has: {', '.join(wave.profiles) or 'none'})")
    transport = wave.profiles[profile].transport if profile else wave.transport
    if host and host != wave.agent_host:
        if transport != "cli":
            die(f"wave prep: --host {host} needs a cli transport: a {transport} worker runs on the agent host, {wave.agent_host}")
        if host not in wave.hosts:
            die(f"wave prep: --host names {host!r}, which the wave file's hosts do not (it has: {', '.join(wave.hosts) or 'none'})")
    legs: list[Leg] = []
    for box in [b for b in opts["legs"].split(",") if b] if opts["legs"] else []:
        if box not in wave.legs:
            die(f"wave prep: --legs names {box!r}, which the wave file's legs do not (it has: {', '.join(wave.legs) or 'none'})")
        if box == (host or wave.agent_host) or any(leg.box == box for leg in legs):
            die(f"wave prep: --legs names {box} twice, or the worker's own host")
        legs.append(wave.legs[box])
    return Prep(wave, task, number, issue_ref, source_ref, opts["base"], opts["mode"], legs, opts["allow_rival"],
                cfg.path(cfg.state), profile, host)


def git(prep: Prep, *args: str, timeout: float | None = None) -> proc.Completed:
    return proc.run_tool("git", ["-C", prep.wave.checkout, *args], timeout=timeout)


# --- the reads ------------------------------------------------------------------------------------

def default_tip(prep: Prep) -> str | None:
    main = prep.wave.vars.get("MAIN")
    if not main:
        return None
    tip = git(prep, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{main}^{{commit}}")
    sha = tip.stdout.strip()
    return sha if tip.rc == 0 and SHA40.fullmatch(sha) else None


def resolve_base(prep: Prep) -> None:
    done = git(prep, "rev-parse", "--verify", "--quiet", f"{prep.base}^{{commit}}")
    sha = done.stdout.strip()
    if done.rc != 0 or not SHA40.fullmatch(sha):
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: --base {prep.base} is no commit in {prep.wave.checkout} (fetch first?)")
    prep.base_origin = f"explicit revision {prep.base} at prep"
    prep.base = sha
    prep.default_tip = default_tip(prep)
    if prep.default_tip == sha:
        prep.base_origin = f"origin/{prep.wave.vars['MAIN']} at prep"


def rival_token(number: str) -> re.Pattern[str]:
    return re.compile(rf"(?:^|[^\w&]|[\w.-]/[\w.-]+)#{number}(?![0-9])")


def rivals_of(prs: list[dict[str, Any]], prep: Rivalry) -> list[str]:
    token = rival_token(prep.number)
    found: list[str] = []
    for pr in prs:
        number = str(pr.get("number"))
        if number in prep.allow_rival:
            continue
        head = pr.get("headRefName")
        words = f"{pr.get('title') or ''}\n{pr.get('body') or ''}"
        if head == prep.branch or (prep.issue_ref and token.search(words)):
            found.append(f"#{number} {str(pr.get('title') or '')[:80]}")
    return found


def open_prs(cfg: Config, prep: Rivalry, select: list[str]) -> list[dict[str, Any]]:
    """One ``gh pr list --state open`` read, or Stop: unread, or a full page (never taken as all)."""
    done = proc.run_tool("gh", ["pr", "list", "--repo", prep.repository, "--state", "open", *select, "--limit",
                                str(PR_PAGE), "--json", "number,title,body,headRefName"], timeout=gh_timeout(cfg))
    try:
        prs: Any = json.loads(done.stdout) if done.rc == 0 else None
    except ValueError:
        prs = None
    if not isinstance(prs, list):
        raise Stop(4, f"{prep.verb} UNKNOWN {prep.task}: the open PRs of {prep.repository} could not be read"
                      f" (gh {' '.join(select)}: exit {done.rc}: {done.stderr.strip()[-200:]}); nothing made")
    listed = [cast(dict[str, Any], p) for p in cast(list[Any], prs) if isinstance(p, dict)]
    if len(listed) >= PR_PAGE:
        raise Stop(1, f"{prep.verb} REFUSED {prep.task}: {len(listed)} open PRs match {' '.join(select)}, a full page;"
                      " read them by hand")
    return listed


def check_rivals(cfg: Config, prep: Rivalry) -> None:
    # The head read always, since a search for the number does not find a PR whose head is the
    # branch and whose text names no number; an issue task's number search beside it.
    listed = open_prs(cfg, prep, ["--head", prep.branch])
    if prep.issue_ref:
        seen = {str(p.get("number")) for p in listed}
        listed += [p for p in open_prs(cfg, prep, ["--search", prep.number]) if str(p.get("number")) not in seen]
    rivals = rivals_of(listed, prep)
    if rivals:
        raise Stop(1, f"{prep.verb} REFUSED {prep.task}: open rival PR(s) {'; '.join(rivals)} -- adopt one instead of"
                      " a competitor, or pass --allow-rival <pr> for one that is no rival")


def check_fresh(prep: Prep) -> None:
    if not prep.remote:  # a remote host's worktree and local branch are its launch's to refuse, on the box
        if os.path.lexists(prep.worktree):
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the worktree path {prep.worktree} exists")
        listed = git(prep, "worktree", "list", "--porcelain")
        if listed.rc != 0:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: git worktree list failed in {prep.wave.checkout}: {listed.stderr.strip()}")
        if f"branch refs/heads/{prep.branch}" in listed.stdout.split("\n"):
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: branch {prep.branch} is checked out in another worktree")
        if git(prep, "show-ref", "--verify", "--quiet", f"refs/heads/{prep.branch}").rc == 0:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: branch {prep.branch} exists in {prep.wave.checkout}")
    remote = git(prep, "ls-remote", "--heads", "origin", f"refs/heads/{prep.branch}", timeout=60)
    if remote.rc != 0:
        raise Stop(4, f"WAVE PREP UNKNOWN {prep.task}: origin's branches could not be read ({remote.stderr.strip()[-200:]}); nothing made")
    if remote.stdout.strip():
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: branch {prep.branch} exists on origin (an earlier attempt pushed it)")
    if os.path.lexists(prep.manifest):
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: a prep manifest {prep.manifest} exists (an earlier prep; its"
                      " WAVE PREP MADE lines say what it made)")
    for path in artifacts(prep):
        if os.path.lexists(path):
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: {path} exists, a file this prep would write: another task's"
                          " (a task id that ends in a leg's suffix or in -base shares the name) or an earlier prep's; nothing made")


def artifacts(prep: Prep) -> list[str]:
    """Every file prep writes under the wave directory besides its manifest: the payloads, the assign
    base and the brief. A CLI task's must last until its launch, so none may be another task's."""
    names = [f"{prep.task}.json", *(f"{prep.task}-{leg.suffix}.json" for leg in prep.legs), f"{prep.task}-base.json"]
    return [*(prep.path("reserve", name) for name in names), prep.path("briefs", f"brief-{prep.task}.md")]


def check_registry(cfg: Config, prep: Prep) -> None:
    listed = listing(cfg)
    records = records_of(listed.out) if listed.rc == 0 else None
    if records is None:
        raise Stop(4, f"WAVE PREP UNKNOWN {prep.task}: the anchor's registry could not be read; nothing made")
    held = {str(r.get("request_id")).lower() for r in records}
    for box in prep.boxes:
        if prep.standing_id(box).lower() in held:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the registry holds {prep.standing_id(box)} already")


def check_board(cfg: Config, prep: Prep) -> None:
    doc = board_status(cfg, prep.wave.wave)
    if doc == 4:
        raise Stop(4, f"WAVE PREP UNKNOWN {prep.task}: the board of {prep.wave.wave} could not be read; nothing made")
    if isinstance(doc, int) and doc != NO_BOARD_EXIT:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the board of {prep.wave.wave} could not be read (above), and"
                      " it is not a wave with no board yet; nothing made")
    if isinstance(doc, dict) and row_of(doc, prep.task) is not None:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the board of {prep.wave.wave} has a row for {prep.task}")


# --- the render -----------------------------------------------------------------------------------

def values_of(prep: Prep) -> dict[str, str]:
    values = dict(prep.wave.vars)
    values.update({"WAVE": prep.wave.wave, "T": prep.task, "N": prep.number, "REPO": prep.wave.repository,
                   "ISSUE_REPO": prep.wave.issue_repository, "CHECKOUT": prep.host_checkout,
                   "WAVE_DIR": prep.wave.directory, "WT": prep.worktree, "BR": prep.branch, "BASE": prep.base,
                   # Pure rendering callers can supply a Prep without resolving repository refs.
                   "BASE_ORIGIN": prep.base_origin or f"explicit commit {prep.base}", "SCR": prep.scratch, "WORKER": prep.worker,
                   "SCR_PARENT": os.path.dirname(prep.scratch), "HOST": prep.host, "MODE": prep.mode})
    if prep.issue_ref:
        values["ISSUE"] = prep.issue_ref
    else:
        values["SOURCE"] = prep.source_ref
    return values


def leg_values(prep: Prep, leg: Leg) -> dict[str, str]:
    return {**values_of(prep), **leg.vars, "LEG": leg.box, "LEG_ID": prep.standing_id(leg.box),
            "LEG_WT": prep.leg_worktree(leg), "LEG_CHECKOUT": leg.checkout}


def shipped_dir(kind: str, cli: bool = False) -> str:
    return os.path.join(TEMPLATES, f"{'cli' if cli else 'native'}-{kind}")


def read_or_none(prep: Prep, path: str) -> Part | None:
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return Part(path, f.read())
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: cannot read {path} ({exc.strerror})")


def common_parts(prep: Prep) -> list[Part]:
    """THE COMMON PARTS (the header)."""
    whole = read_or_none(prep, prep.path("common.md"))
    if whole is not None:
        return [whole]
    parts: list[Part] = []
    for name in COMMON:
        if name == "checkpoint.md" and prep.wave.review is None:
            continue
        places = [prep.path("common", name), os.path.join(shipped_dir(prep.kind, prep.cli), name),
                  os.path.join(TEMPLATES, "shared", name)]
        found = next((p for p in (read_or_none(prep, place) for place in places) if p is not None), None)
        if found is None:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the common part {name} exists nowhere: not {prep.path('common.md')}"
                          f" (the whole of them), nor {', nor '.join(places)}")
        parts.append(found)
    return parts


def part(prep: Prep, *name: str, required: bool = True) -> Part | None:
    """The wave directory's part, else (a PLANNING part) the shipped one, else None or Stop (THE PARTS)."""
    path = prep.path(*name)
    found = read_or_none(prep, path)
    if found is not None:
        return found
    rel = "/".join(name)
    shipped = os.path.join(shipped_dir(prep.kind, prep.cli), rel) if rel in PLANNING else ""
    found = read_or_none(prep, shipped) if shipped else None
    if found is None and required:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the template part {path} does not exist"
                      + (f", nor the shipped {shipped}" if shipped else ""))
    return found


def names(parts: list[Part]) -> set[str]:
    return {m.group(1) for p in parts for m in PLACEHOLDER.finditer(p.text)}


def project_value(prep: Prep) -> str:
    """THE PROJECT PART: wave project.md, else project_part at the base, else the default tip."""
    own = read_or_none(prep, prep.path("project.md"))
    if own is None:
        where = prep.wave.project_part
        if not where:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: a part names @@PROJECT@@, and neither"
                          f" {prep.path('project.md')} exists nor does the wave file name a project_part")
        revision, source = prep.base, "base"
        shown = git(prep, "show", f"{revision}:{where}")
        if shown.rc != 0:
            main = prep.wave.vars.get("MAIN")
            tip = prep.default_tip
            if tip is None:
                raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the project part {shlex.quote(where)} cannot be read in"
                              f" {shlex.quote(prep.wave.checkout)} at base {prep.base}; fallback needs vars.MAIN"
                              " and its origin remote-tracking commit (fetch first?)")
            revision, source = tip, f"origin/{main} fallback"
            shown = git(prep, "show", f"{revision}:{where}")
            if shown.rc != 0:
                raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the project part {shlex.quote(where)} cannot be read in"
                              f" {shlex.quote(prep.wave.checkout)} at base {prep.base} or {source} {revision}"
                              f" ({shown.stderr.strip()[-200:]})")
        own = Part(f"{os.path.join(prep.wave.checkout, where)} at {revision}", shown.stdout)
        cli.say(f"WAVE PREP {prep.task}: project part {shlex.quote(where)} at {revision} ({source})")
    else:
        cli.say(f"WAVE PREP {prep.task}: project part {shlex.quote(own.name)} (wave override)")
    return rendered(prep, [own], values_of(prep)).rstrip("\n")


def rendered(prep: Prep, parts: list[Part], values: dict[str, str]) -> str:
    if prep.remote:
        for item in parts:
            if "WAVE_DIR" in names([item]):
                raise Stop(1, f"WAVE PREP REFUSED {prep.task}: {shlex.quote(item.name)} names @@WAVE_DIR@@, a path on"
                              f" {shlex.quote(prep.wave.agent_host)}, but this worker runs on {shlex.quote(prep.host)};"
                              " use @@SCR_PARENT@@ for the host-local wave scratch parent; nothing made")
    result = render(parts, values)
    if isinstance(result, list):
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: " + "; ".join(result) + "; nothing made")
    return result


def brief_text(prep: Prep) -> str:
    parts = [*common_parts(prep), *(p for p in (part(prep, "tasks", f"{prep.task}.md"),) if p)]
    if prep.legs:
        item = part(prep, "leg.md")
        assert item is not None
        lines = "".join(rendered(prep, [item], leg_values(prep, leg)) for leg in prep.legs).rstrip("\n")
        legs = part(prep, "legs.md")
        assert legs is not None
        parts.append(Part(legs.name, rendered(prep, [legs], {**values_of(prep), "LEGLINES": lines})))
    if prep.mode != "none":
        planning = part(prep, f"planning-{prep.mode}.md")
        assert planning is not None
        parts.append(planning)
    tail = part(prep, "tail.md", required=False)
    if tail is not None:
        parts.append(tail)
    values = values_of(prep)
    if "PROJECT" in names(parts):
        values["PROJECT"] = project_value(prep)
    return rendered(prep, parts, values)


def reservation(prep: Prep, box: str, checkout: str, purpose: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "request_id": prep.standing_id(box), "wave": prep.wave.wave, "worker": prep.worker, "transport": prep.transport,
        "purpose": purpose, "agent_host": prep.host, "execution_host": box, "repository": prep.wave.repository,
        "requested_revision": prep.base, "kind": "correctness", "standing": True}
    if checkout:  # a CLI worker's own record names none: launch fills in the worktree it made (A CLI TASK)
        payload["checkout"] = checkout
    if prep.issue_ref:  # a --source task is no issue's work: its records name none (prs --wave reads them)
        payload["issue"] = prep.issue_ref
    return payload


def reservations(prep: Prep) -> list[tuple[str, dict[str, Any]]]:
    """(file name, payload): the worker's host's first, then each leg's."""
    own = Part("the wave file's standing_purpose", prep.wave.standing_purpose)
    out = [(f"{prep.task}.json", reservation(prep, prep.host, "" if prep.cli else prep.worktree,
                                             rendered(prep, [own], values_of(prep)).rstrip("\n")))]
    for leg in prep.legs:
        text = Part(f"legs.{leg.box}.purpose", leg.purpose)
        out.append((f"{prep.task}-{leg.suffix}.json", reservation(prep, leg.box, prep.leg_worktree(leg),
                                                                  rendered(prep, [text], leg_values(prep, leg)).rstrip("\n"))))
    return out


# --- the writes -----------------------------------------------------------------------------------

def record(prep: Prep, step: str) -> None:
    prep.done.append(step)
    os.makedirs(os.path.dirname(prep.manifest), exist_ok=True)
    write_atomically(prep.manifest, json.dumps({
        "task": prep.task, "wave": prep.wave.wave, "worker": prep.worker, "branch": prep.branch, "base": prep.base,
        "worktree": prep.worktree, "standing": [prep.standing_id(b) for b in prep.boxes],
        # THE LAUNCH RECORD: everything ``wave launch`` does for a CLI task, as prepared here. It reads
        # this and re-derives nothing from the wave file, so no later edit of that file can make it
        # launch one thing and reserve or record another (wavelaunch.py).
        "launch": {
            "wave": prep.wave.wave, "repository": prep.wave.repository, "main": prep.wave.vars.get("MAIN", ""),
            "transport": prep.transport, "kind": prep.kind, "model": prep.model, "effort": prep.effort,
            "host": prep.host, "remote": prep.remote, "host_checkout": prep.host_checkout, "scratch": prep.scratch,
            "worker": prep.worker, "branch": prep.branch, "base": prep.base, "worktree": prep.worktree,
            "number": prep.number, "issue_ref": prep.issue_ref, "allow_rival": sorted(prep.allow_rival),
            "standing": prep.standing_id(prep.host),
            "legs": [{"box": leg.box, "suffix": leg.suffix, "worktree": prep.leg_worktree(leg), "standing": prep.standing_id(leg.box)}
                     for leg in prep.legs]},
        "done": prep.done}, indent=1) + "\n")


def board_fields(prep: Prep, brief: str) -> list[str]:
    hosts = prep.boxes
    fields = [f"issue={prep.issue_ref}" if prep.issue_ref else f"source={prep.source_ref}",
              f"repository={prep.wave.repository}", f"worktree={prep.worktree}", f"branch={prep.branch}",
              f"base={prep.base}", f"transport={prep.transport}", f"kind={prep.kind}",
              f"agent_host={prep.host}", f"exec_hosts={','.join(hosts)}", f"brief={brief}",
              f"brief_host={prep.wave.agent_host}", f"worker={prep.worker}",
              f"standing={' '.join(prep.standing_id(h) for h in hosts)}", "requests=none",
              f"runs={os.path.join(prep.scratch, 'runs')}", "state=pending"]
    if prep.model:
        fields.append(f"model={prep.model}" + (f"/{prep.effort}" if prep.effort else ""))
    if prep.mode != "none":
        plan = f"{prep.wave.wave}-{prep.number if prep.issue_ref else prep.task}"
        fields += [f"planning={prep.mode}", f"plan_dir={os.path.join(prep.state, 'plans', plan)}"]
    if prep.legs:
        fields.append("farside=" + " ".join(f"{leg.box}:{prep.leg_worktree(leg)}" for leg in prep.legs))
    return fields


def write(cfg: Config, prep: Prep, brief: str, payloads: list[tuple[str, dict[str, Any]]]) -> None:
    def fail(step: str, why: str, rc: int = 1) -> Stop:
        word = "UNKNOWN" if rc == 4 else "FAILED"
        return Stop(rc, f"WAVE PREP {word} {prep.task} at {step}: {why}")

    record(prep, "manifest")
    if not prep.cli:
        added = git(prep, "worktree", "add", "-q", "-b", prep.branch, prep.worktree, prep.base)
        if added.rc != 0:
            raise fail("worktree", f"git worktree add exited {added.rc}: {added.stderr.strip()[-300:]}")
        record(prep, f"worktree {prep.worktree} on branch {prep.branch} at {prep.base}")
    try:
        if not prep.remote:
            os.makedirs(os.path.join(prep.scratch, "runs"), exist_ok=True)
        os.makedirs(prep.path("reserve"), exist_ok=True)
        os.makedirs(prep.path("briefs"), exist_ok=True)
    except OSError as exc:
        raise fail("scratch", f"cannot make the wave's directories ({exc.strerror})")
    if not prep.remote:
        record(prep, f"scratch {os.path.join(prep.scratch, 'runs')}")
    script = shim(cfg)
    for name, payload in payloads:
        path = prep.path("reserve", name)
        try:
            write_atomically(path, json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
        except OSError as exc:
            raise fail("reservation", f"cannot write {path} ({exc.strerror})")
        if prep.cli:
            record(prep, f"standing payload {payload['request_id']} for {payload['execution_host']} ({path}), unreserved")
            continue
        rc = run([script, "execution", "run", path], stdout_to_stderr=True).rc
        if rc != 0:
            raise fail("reservation", f"execution run {path} exited {rc} (above)", 4 if rc == 4 else 1)
        record(prep, f"standing reservation {payload['request_id']} on {payload['execution_host']} ({path})")
    brief_path = prep.path("briefs", f"brief-{prep.task}.md")
    base_path = prep.path("reserve", f"{prep.task}-base.json")
    base = {"wave": prep.wave.wave, "worker": prep.worker, "transport": prep.transport,
            "agent_host": prep.host, "repository": prep.wave.repository}
    if prep.issue_ref:
        base["issue"] = prep.issue_ref
    try:
        write_atomically(brief_path, brief)
        write_atomically(base_path, json.dumps(base, separators=(",", ":"), ensure_ascii=False) + "\n")
    except OSError as exc:
        raise fail("brief", f"cannot write the brief or the assign base ({exc.strerror})")
    record(prep, f"brief {brief_path} and assign base {base_path}")
    fields = board_fields(prep, brief_path)
    rc = run([script, "board", "set", "--create", "--new-row", prep.wave.wave, prep.task, *fields], stdout_to_stderr=True).rc
    if rc != 0:
        raise fail("board", f"board set exited {rc} (above)", 4 if rc == 4 else 1)
    record(prep, f"board row {prep.wave.wave} {prep.task} (state=pending)")
    record(prep, READY)


def cmd_prep(cfg: Config, args: list[str]) -> int:
    path, task, opts = parse(args)
    prep = build(cfg, path, task, opts)
    try:
        gated = anchor_gate(cfg, "WAVE PREP", task, False)
        if gated != 0:
            return gated
        resolve_base(prep)
        check_fresh(prep)
        check_rivals(cfg, rivalry_of(prep))
        check_registry(cfg, prep)
        check_board(cfg, prep)
        brief = brief_text(prep)
        payloads = reservations(prep)
    except Stop as stop:
        cli.say(stop.line)
        return stop.rc
    try:
        write(cfg, prep, brief, payloads)
    except (Stop, OSError) as stop:
        line = stop.line if isinstance(stop, Stop) else f"WAVE PREP FAILED {task}: {stop}"
        cli.say(line)
        for step in prep.done:
            if step not in ("manifest", READY):
                cli.say(f"WAVE PREP MADE {task}: {step}")
        cli.say(f"WAVE PREP MADE {task}: the manifest {prep.manifest}" if prep.done else f"WAVE PREP MADE {task}: nothing")
        return stop.rc if isinstance(stop, Stop) else 1
    standing = " ".join(prep.standing_id(b) for b in prep.boxes)
    cli.say(f"WAVE PREP {task}: ready: brief {prep.path('briefs', f'brief-{task}.md')} worktree {prep.worktree}"
            f" branch {prep.branch} base {prep.base} standing {standing}"
            + (f" (a CLI worker on {prep.host}, nothing made or reserved yet: wave launch starts it)" if prep.cli else ""))
    return 0
