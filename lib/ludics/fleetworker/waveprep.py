"""``wave prep``: one native worker's launch prep in one call (ludics#1047).

``wave prep <wave.json> <task> --base <rev> [--issue <N> | --source <N>] [--mode none|paired|paired+critique]
[--legs <box,...>] [--allow-rival <pr>]...`` makes what a worker needs before it is spawned: its
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

THE BRIEF is wavebrief.py's render of these parts, in this order: ``common.md``; ``tasks/<task>.md``;
with --legs, ``legs.md``, whose ``@@LEGLINES@@`` is ``leg.md`` rendered once per leg; with a --mode
other than none, ``planning-<mode>.md``; and ``tail.md`` when it exists. Every part but tail.md is
required. The NAMEs every part is given: WAVE, T (the task), N, ISSUE (``<issue_repository>#<N>``,
issue tasks only) or SOURCE (--source tasks only), REPO, ISSUE_REPO (the wave file's
issue_repository, every task), CHECKOUT (the wave file's checkout), WAVE_DIR, WT, BR, BASE (the full
SHA), SCR, WORKER, HOST (the agent host), MODE, PROJECT (THE PROJECT PART, only where a part names
it), and the wave file's ``vars``; ``leg.md`` is given LEG (the box), LEG_ID (its reservation id),
LEG_WT (the far-side worktree), LEG_CHECKOUT and the leg's ``vars`` besides. The reservations'
purposes are rendered with the same NAMEs, PROJECT aside.

THE PARTS, where each is found (ludics#1072): the wave directory's part wins; for the three parts
the repository ships, ``SHIPPED`` (``common.md``, ``planning-paired.md``,
``planning-paired+critique.md``), the shipped one under ``issue-wave/templates/native-<kind>/`` of
this checkout stands in when the wave directory has none; any other part, and a shipped part for a
kind with no shipped template (codex today), is the wave directory's or refuses. The shipped parts
are the reference native-Claude brief, kept in step with issue-wave SKILL.md's *The brief* and read
by check-prompts (checkprompts/brieftemplate.py). They hold no project fact: the NAMEs they use are
the built-ins above plus ``SHIPPED_VARS`` (COORDINATOR, the coordinator's session id, and MAIN, the
main branch), which the wave file's ``vars`` supply, and PROJECT. ``common.md`` speaks of no issue
(no ISSUE, no SOURCE), so it renders for a --source task; the planning parts name ISSUE, so a paired
--source task refuses on them unless the wave directory gives its own.

THE PROJECT PART, the value of PROJECT, read only when some part names ``@@PROJECT@@``: the wave
directory's ``project.md`` when it exists, else the file the wave file's ``project_part`` names,
read from the checkout at the task's base (``git show <base>:<path>``, so a project's own brief
section is the one its worker starts from, never a branch someone has checked out there). Either is
rendered first with every NAME above but PROJECT and the legs', and its result is the value. Neither
existing, or the path absent at the base, refuses.

IN ORDER, every read before any write:
  1. THE READS. The anchor gate (the lease and the halt, ``launch``'s ``anchor_gate``), so no
     worktree is made under another coordinator's wave. ``--base`` resolved to a full SHA in the
     checkout. The rival PRs. The worktree path, the branch in ``git worktree list``, the local
     branch and origin's branch: any one existing refuses. A prep manifest for the task refuses
     (THE RECOVERY BOUNDARY). The registry holding any of the task's standing ids, and the board
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
from ludics.fleetworker.wave import USAGE, Leg, Wave, load_wave, shim
from ludics.fleetworker.wavebrief import PLACEHOLDER, Part, render, write_atomically

MODES = ("none", "paired", "paired+critique")
TASK = re.compile(r"[A-Za-z][A-Za-z0-9-]*")
ISSUE_TASK = re.compile(r"t([0-9]+)")
SHA40 = re.compile(r"[0-9a-f]{40}")
PR_PAGE = 100
# THE PARTS: the shipped reference template, four directories above this module (lib/ludics/fleetworker/).
TEMPLATES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
                         "issue-wave", "templates")
SHIPPED = ("common.md", "planning-paired.md", "planning-paired+critique.md")
SHIPPED_VARS = ("COORDINATOR", "MAIN")


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
    worker: str = ""
    branch: str = ""
    worktree: str = ""
    scratch: str = ""
    done: list[str] = field(default_factory=lambda: [])

    def __post_init__(self) -> None:
        self.worker = f"{self.wave.worker_prefix}-{self.number if self.issue_ref else self.task}"
        self.branch = f"{self.wave.kind}/{self.worker}"
        self.worktree = f"{self.wave.checkout}-worktrees/{self.worker}"
        self.scratch = os.path.join(self.wave.directory, "scratch", self.task)

    def standing_id(self, box: str) -> str:
        return f"{self.wave.wave}-{self.task}-{box}-iterate"

    def leg_worktree(self, leg: Leg) -> str:
        return f"{leg.checkout}-worktrees/{self.worker}-{leg.suffix}"

    def path(self, *parts: str) -> str:
        return os.path.join(self.wave.directory, *parts)

    @property
    def manifest(self) -> str:
        return self.path("prep", f"{self.task}.json")


class Stop(Exception):
    """A refusal or failure: its exit status and its line."""

    def __init__(self, rc: int, line: str) -> None:
        super().__init__(line)
        self.rc = rc
        self.line = line


def parse(args: list[str]) -> tuple[str, str, dict[str, Any]]:
    if len(args) < 2 or args[0].startswith("--") or args[1].startswith("--"):
        die(f"wave prep: name the wave file and the task; usage: {USAGE}")
    opts: dict[str, Any] = {"base": "", "issue": "", "source": "", "mode": "none", "legs": "", "allow_rival": set()}
    rest = args[2:]
    i = 0
    while i < len(rest):
        word = rest[i]
        key = {"--base": "base", "--issue": "issue", "--source": "source", "--mode": "mode", "--legs": "legs",
               "--allow-rival": "allow_rival"}.get(word)
        if key is None or i + 1 >= len(rest):
            die(f"wave prep: {'unknown option ' + word if key is None else word + ' needs a value'}; usage: {USAGE}")
        if key == "allow_rival":
            opts[key].add(rest[i + 1].lstrip("#"))
        else:
            opts[key] = rest[i + 1]
        i += 2
    return args[0], args[1], opts


def build(cfg: Config, path: str, task: str, opts: dict[str, Any]) -> Prep:
    wave = load_wave(path, "prep")
    if not TASK.fullmatch(task):
        die(f"wave prep: task {task!r} does not match {TASK.pattern}")
    if opts["mode"] not in MODES:
        die(f"wave prep: --mode is one of {', '.join(MODES)}, not {opts['mode']!r}")
    if not opts["base"]:
        die("wave prep: --base <rev> is required (the verified base the worktree starts from)")
    if opts["issue"] and opts["source"]:
        die("wave prep: --issue and --source exclude each other")
    for given in (opts["issue"], opts["source"]):
        if given and not given.isdigit():
            die(f"wave prep: an issue number is digits, not {given!r}")
    issue_task = ISSUE_TASK.fullmatch(task)
    if opts["source"]:
        number, issue_ref, source_ref = opts["source"], "", f"{wave.issue_repository}#{opts['source']}"
    elif opts["issue"] or issue_task:
        number = opts["issue"] or (issue_task.group(1) if issue_task else "")
        issue_ref, source_ref = f"{wave.issue_repository}#{number}", ""
    else:
        die(f"wave prep: task {task} is no t<N>: name its issue with --issue <N>, or with --source <N> the issue a no-issue task came from")
    legs: list[Leg] = []
    for box in [b for b in opts["legs"].split(",") if b] if opts["legs"] else []:
        if box not in wave.legs:
            die(f"wave prep: --legs names {box!r}, which the wave file's legs do not (it has: {', '.join(wave.legs) or 'none'})")
        if box == wave.agent_host or any(leg.box == box for leg in legs):
            die(f"wave prep: --legs names {box} twice, or the agent host itself")
        legs.append(wave.legs[box])
    return Prep(wave, task, number, issue_ref, source_ref, opts["base"], opts["mode"], legs, opts["allow_rival"],
                cfg.path(cfg.state))


def git(prep: Prep, *args: str, timeout: float | None = None) -> proc.Completed:
    return proc.run_tool("git", ["-C", prep.wave.checkout, *args], timeout=timeout)


# --- the reads ------------------------------------------------------------------------------------

def resolve_base(prep: Prep) -> None:
    done = git(prep, "rev-parse", "--verify", "--quiet", f"{prep.base}^{{commit}}")
    sha = done.stdout.strip()
    if done.rc != 0 or not SHA40.fullmatch(sha):
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: --base {prep.base} is no commit in {prep.wave.checkout} (fetch first?)")
    prep.base = sha


def rival_token(number: str) -> re.Pattern[str]:
    return re.compile(rf"(?:^|[^\w&]|[\w.-]/[\w.-]+)#{number}(?![0-9])")


def rivals_of(prs: list[dict[str, Any]], prep: Prep) -> list[str]:
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


def open_prs(cfg: Config, prep: Prep, select: list[str]) -> list[dict[str, Any]]:
    """One ``gh pr list --state open`` read, or Stop: unread, or a full page (never taken as all)."""
    done = proc.run_tool("gh", ["pr", "list", "--repo", prep.wave.repository, "--state", "open", *select, "--limit",
                                str(PR_PAGE), "--json", "number,title,body,headRefName"], timeout=gh_timeout(cfg))
    try:
        prs: Any = json.loads(done.stdout) if done.rc == 0 else None
    except ValueError:
        prs = None
    if not isinstance(prs, list):
        raise Stop(4, f"WAVE PREP UNKNOWN {prep.task}: the open PRs of {prep.wave.repository} could not be read"
                      f" (gh {' '.join(select)}: exit {done.rc}: {done.stderr.strip()[-200:]}); nothing made")
    listed = [cast(dict[str, Any], p) for p in cast(list[Any], prs) if isinstance(p, dict)]
    if len(listed) >= PR_PAGE:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: {len(listed)} open PRs match {' '.join(select)}, a full page;"
                      " read them by hand")
    return listed


def check_rivals(cfg: Config, prep: Prep) -> None:
    # The head read always, since a search for the number does not find a PR whose head is the
    # branch and whose text names no number; an issue task's number search beside it.
    listed = open_prs(cfg, prep, ["--head", prep.branch])
    if prep.issue_ref:
        seen = {str(p.get("number")) for p in listed}
        listed += [p for p in open_prs(cfg, prep, ["--search", prep.number]) if str(p.get("number")) not in seen]
    rivals = rivals_of(listed, prep)
    if rivals:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: open rival PR(s) {'; '.join(rivals)} -- adopt one instead of"
                      " a competitor, or pass --allow-rival <pr> for one that is no rival")


def check_fresh(prep: Prep) -> None:
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


def check_registry(cfg: Config, prep: Prep) -> None:
    listed = listing(cfg)
    records = records_of(listed.out) if listed.rc == 0 else None
    if records is None:
        raise Stop(4, f"WAVE PREP UNKNOWN {prep.task}: the anchor's registry could not be read; nothing made")
    held = {str(r.get("request_id")).lower() for r in records}
    for box in [prep.wave.agent_host, *(leg.box for leg in prep.legs)]:
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
                   "ISSUE_REPO": prep.wave.issue_repository, "CHECKOUT": prep.wave.checkout,
                   "WAVE_DIR": prep.wave.directory, "WT": prep.worktree, "BR": prep.branch, "BASE": prep.base, "SCR": prep.scratch, "WORKER": prep.worker,
                   "HOST": prep.wave.agent_host, "MODE": prep.mode})
    if prep.issue_ref:
        values["ISSUE"] = prep.issue_ref
    else:
        values["SOURCE"] = prep.source_ref
    return values


def leg_values(prep: Prep, leg: Leg) -> dict[str, str]:
    return {**values_of(prep), **leg.vars, "LEG": leg.box, "LEG_ID": prep.standing_id(leg.box),
            "LEG_WT": prep.leg_worktree(leg), "LEG_CHECKOUT": leg.checkout}


def shipped_dir(kind: str) -> str:
    return os.path.join(TEMPLATES, f"native-{kind}")


def read_or_none(prep: Prep, path: str) -> Part | None:
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return Part(path, f.read())
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: cannot read {path} ({exc.strerror})")


def part(prep: Prep, *name: str, required: bool = True) -> Part | None:
    """The wave directory's part, else (a SHIPPED part) the shipped one, else None or Stop (THE PARTS)."""
    path = prep.path(*name)
    found = read_or_none(prep, path)
    if found is not None:
        return found
    rel = "/".join(name)
    shipped = os.path.join(shipped_dir(prep.wave.kind), rel) if rel in SHIPPED else ""
    found = read_or_none(prep, shipped) if shipped else None
    if found is None and required:
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the template part {path} does not exist"
                      + (f", nor the shipped {shipped}" if shipped else ""))
    return found


def names(parts: list[Part]) -> set[str]:
    return {m.group(1) for p in parts for m in PLACEHOLDER.finditer(p.text)}


def project_value(prep: Prep) -> str:
    """THE PROJECT PART, rendered: the wave directory's project.md, else project_part at the base."""
    own = read_or_none(prep, prep.path("project.md"))
    if own is None:
        where = prep.wave.project_part
        if not where:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: a part names @@PROJECT@@, and neither"
                          f" {prep.path('project.md')} exists nor does the wave file name a project_part")
        shown = git(prep, "show", f"{prep.base}:{where}")
        if shown.rc != 0:
            raise Stop(1, f"WAVE PREP REFUSED {prep.task}: the project part {where} cannot be read in"
                          f" {prep.wave.checkout} at {prep.base} ({shown.stderr.strip()[-200:]})")
        own = Part(f"{os.path.join(prep.wave.checkout, where)} at {prep.base[:12]}", shown.stdout)
    return rendered(prep, [own], values_of(prep)).rstrip("\n")


def rendered(prep: Prep, parts: list[Part], values: dict[str, str]) -> str:
    result = render(parts, values)
    if isinstance(result, list):
        raise Stop(1, f"WAVE PREP REFUSED {prep.task}: " + "; ".join(result) + "; nothing made")
    return result


def brief_text(prep: Prep) -> str:
    parts = [p for p in (part(prep, "common.md"), part(prep, "tasks", f"{prep.task}.md")) if p]
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
        "request_id": prep.standing_id(box), "wave": prep.wave.wave, "worker": prep.worker, "transport": prep.wave.transport,
        "purpose": purpose, "agent_host": prep.wave.agent_host, "execution_host": box, "repository": prep.wave.repository,
        "requested_revision": prep.base, "kind": "correctness", "standing": True, "checkout": checkout}
    if prep.issue_ref:  # a --source task is no issue's work: its records name none (prs --wave reads them)
        payload["issue"] = prep.issue_ref
    return payload


def reservations(prep: Prep) -> list[tuple[str, dict[str, Any]]]:
    """(file name, payload): the agent host's first, then each leg's."""
    own = Part("the wave file's standing_purpose", prep.wave.standing_purpose)
    out = [(f"{prep.task}.json", reservation(prep, prep.wave.agent_host, prep.worktree,
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
        "worktree": prep.worktree, "standing": [prep.standing_id(b) for b in [prep.wave.agent_host, *(l.box for l in prep.legs)]],
        "done": prep.done}, indent=1) + "\n")


def board_fields(prep: Prep, brief: str) -> list[str]:
    hosts = [prep.wave.agent_host, *(leg.box for leg in prep.legs)]
    fields = [f"issue={prep.issue_ref}" if prep.issue_ref else f"source={prep.source_ref}",
              f"repository={prep.wave.repository}", f"worktree={prep.worktree}", f"branch={prep.branch}",
              f"base={prep.base}", f"transport={prep.wave.transport}", f"kind={prep.wave.kind}",
              f"agent_host={prep.wave.agent_host}", f"exec_hosts={','.join(hosts)}", f"brief={brief}",
              f"brief_host={prep.wave.agent_host}", f"worker={prep.worker}",
              f"standing={' '.join(prep.standing_id(h) for h in hosts)}", "requests=none",
              f"runs={os.path.join(prep.scratch, 'runs')}", "state=pending"]
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
    added = git(prep, "worktree", "add", "-q", "-b", prep.branch, prep.worktree, prep.base)
    if added.rc != 0:
        raise fail("worktree", f"git worktree add exited {added.rc}: {added.stderr.strip()[-300:]}")
    record(prep, f"worktree {prep.worktree} on branch {prep.branch} at {prep.base}")
    try:
        os.makedirs(os.path.join(prep.scratch, "runs"), exist_ok=True)
        os.makedirs(prep.path("reserve"), exist_ok=True)
        os.makedirs(prep.path("briefs"), exist_ok=True)
    except OSError as exc:
        raise fail("scratch", f"cannot make the wave's directories ({exc.strerror})")
    record(prep, f"scratch {os.path.join(prep.scratch, 'runs')}")
    script = shim(cfg)
    for name, payload in payloads:
        path = prep.path("reserve", name)
        try:
            write_atomically(path, json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
        except OSError as exc:
            raise fail("reservation", f"cannot write {path} ({exc.strerror})")
        rc = run([script, "execution", "run", path], stdout_to_stderr=True).rc
        if rc != 0:
            raise fail("reservation", f"execution run {path} exited {rc} (above)", 4 if rc == 4 else 1)
        record(prep, f"standing reservation {payload['request_id']} on {payload['execution_host']} ({path})")
    brief_path = prep.path("briefs", f"brief-{prep.task}.md")
    base_path = prep.path("reserve", f"{prep.task}-base.json")
    base = {"wave": prep.wave.wave, "worker": prep.worker, "transport": prep.wave.transport,
            "agent_host": prep.wave.agent_host, "repository": prep.wave.repository}
    if prep.issue_ref:
        base["issue"] = prep.issue_ref
    try:
        write_atomically(brief_path, brief)
        write_atomically(base_path, json.dumps(base, separators=(",", ":"), ensure_ascii=False) + "\n")
    except OSError as exc:
        raise fail("brief", f"cannot write the brief or the assign base ({exc.strerror})")
    record(prep, f"brief {brief_path} and assign base {base_path}")
    fields = board_fields(prep, brief_path)
    rc = run([script, "board", "set", "--create", prep.wave.wave, prep.task, *fields], stdout_to_stderr=True).rc
    if rc != 0:
        raise fail("board", f"board set exited {rc} (above)", 4 if rc == 4 else 1)
    record(prep, f"board row {prep.wave.wave} {prep.task} (state=pending)")


def cmd_prep(cfg: Config, args: list[str]) -> int:
    path, task, opts = parse(args)
    prep = build(cfg, path, task, opts)
    try:
        gated = anchor_gate(cfg, "WAVE PREP", task, False)
        if gated != 0:
            return gated
        resolve_base(prep)
        check_fresh(prep)
        check_rivals(cfg, prep)
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
            if step != "manifest":
                cli.say(f"WAVE PREP MADE {task}: {step}")
        cli.say(f"WAVE PREP MADE {task}: the manifest {prep.manifest}" if prep.done else f"WAVE PREP MADE {task}: nothing")
        return stop.rc if isinstance(stop, Stop) else 1
    standing = " ".join(prep.standing_id(b) for b in [prep.wave.agent_host, *(leg.box for leg in prep.legs)])
    cli.say(f"WAVE PREP {task}: ready: brief {prep.path('briefs', f'brief-{task}.md')} worktree {prep.worktree}"
            f" branch {prep.branch} base {prep.base} standing {standing}")
    return 0
