"""``wave review``: the review checkpoint, a second reviewer's read of a worker's PR (ludics#1108).

wave-20261111-ocannl ran a checkpoint on every Codex worker's PR: a review by another model when
the PR opened, and a confirm before the merge when that review was blocking. Of 44 such reviews 12
were blocking, several on PRs the automated reviewer had approved. The coordinator did each by hand
with scripts of its own: render a prompt, spawn a reviewer, post its file, tell the worker what the
verdict meant. The last step matched the verdict line with a shell ``case``, ``*suggestions*``
matched inside ``blocking (1 blocking, 2 suggestions)``, and five blocking verdicts were told to
merge. This verb is those steps, the verdict parsed:

    wave review <wave.json> <task> <pr> <sha> --kind at-open|confirm [--issue <N> | --source <N>]
                [--dry-run | --posted <url> | --again]

WHAT IT DOES, in this order:

1. The wave file names a reviewer (``review``, wave.py's header) and ``vars.MAIN``, the base branch.
   The task is an issue's or a ``--source`` task as ``wave prep`` reads it (``waveprep.subject``).
2. ONE CALL per PR, kind and head: an exclusive ``flock`` on ``reviews/<stem>.lock``, taken without
   waiting and held to the end, so a call retried while the first still reviews refuses (exit 1)
   and neither a second reviewer runs nor a second comment is posted. A record of this PR, kind
   and head under ``<wave dir>/reviews/`` is the review already made: the reviewer is not run
   again, and a record that was posted is printed again and nothing else (THE RECOVERY BOUNDARY).
3. The lease (not the halt: a halted wave still reviews what is open).
4. GitHub: the PR is open and its head is ``<sha>``, else refused: a review of a head the PR left
   answers nobody. The head is fetched into the wave's checkout (``refs/pull/<pr>/head``; nothing is
   checked out) and must be a commit there.
5. ``confirm`` reads the newest ``at-open`` record of the PR. None refuses. One whose verdict was
   not blocking is answered ``cleared`` with no reviewer run: there is nothing to confirm.
6. The prompt, rendered through ``wavebrief.render`` from the shipped parts
   (``issue-wave/templates/review/``; a wave directory's ``review/<part>`` overrides one), then the
   project's part when there is one: ``<wave dir>/review/project.md``, else ``review.project_part``
   read from the checkout at ``origin/<MAIN>`` (the base's copy, so a PR does not write its own
   reviewer's instructions).
7. The reviewer, headless, the prompt on its stdin (``reviewer_argv``). Its final message is the
   review. READ-ONLY is its tool list, a fail-closed allowlist, not only the prompt's word: the
   file readers, ``git -C <checkout>`` with a reading verb (``GIT_READS``), ``gh`` with a reading
   one (``GH_READS``), and the filters a pipe ends in (``FILTERS``); every other command is
   refused by the CLI, the editing tools by name. What that does not stop: an allowed verb's own
   writing option (``git show --output=<file>``), and anything ``gh`` reads with the fleet's token.
8. THE VERDICT, below, and what it decides.
9. The PR is read again (step 4's check: a recorded review, a dry run's included, is never posted
   on a PR that closed or whose head moved since). Then the review is posted on the PR
   (``pr-review.sh comment --coordinator``, whose footer marks it as the wave's own post), the
   message for the worker is written, the record is written, and the row gets
   ``review=<word>@<sha8>`` (``confirm=...`` for a confirm).

THE VERDICT, a fail-closed grammar. The review's last non-blank line, trailing blanks dropped, is
the verdict line when it is, whole, one of
    VERDICT: clean                                      (or with counts, 0 blocking)
    VERDICT: suggestions                                (or with counts, 0 blocking)
    VERDICT: blocking (<n> blocking, <m> suggestions)   (the counts required)
with decimal counts. Only the blocking count decides: more than zero blocks. Anything else is
``unreadable``: no such line, another word, a count that contradicts its word (``clean (1 blocking,
...)``), a line wrapped in backticks, text after it. Unreadable is treated as blocking, never as a
merge, and the line this verb prints says ``decision=unreadable`` for the coordinator to read the
review. What is not read: the review's prose, and whether the counts match the findings written.

THE DECISION, and the message the worker is resumed with (``<wave dir>/reviews/<stem>.message.md``):
  at-open  merge       not blocking: answer the findings in the ship-pr loop, merge when it ends
           confirm     blocking: before merging, end the turn with ``CONFIRM_REQUEST <pr> <head>``
  confirm  cleared     ``MERGE CLEARED <pr> <sha>``
           findings    ``MERGE NOT CLEARED <pr> <sha>``: fix or rebut, then ``CONFIRM_REQUEST`` again
  either   unreadable  as ``confirm`` / ``findings``, saying no verdict line was read

THE RECOVERY BOUNDARY. A re-run of the same call is the recovery. The record
(``reviews/<pr>-<kind>-<sha12>.json``) is written once the review is parsed and again once it is
posted, so a call that died after the reviewer answered posts that review and does not buy another,
and a ``--dry-run``'s review is the one a later real call posts. Not recovered: a comment whose
answer was lost (``pr-review.sh comment`` exit 3 may have posted; the refusal says to read the PR,
and ``--posted <url>`` records the comment found there), and a board write that failed (a NOTE; the
record, not the row, is what a later step reads).

A NEW ROUND ON THE SAME HEAD is asked for, never inferred. A worker that answers a blocking confirm
with a rebuttal and no commit asks again at the same SHA, and so does a retry of a call whose line
was lost; nothing here can tell the two apart, and the second must not buy a review. So the same
call replays its record, and ``--again`` starts the new round: it needs a posted record of this
PR, kind and head, moves that record's files aside as ``<stem>.r<n>.*`` (the comment stays on the
PR), and reviews as a first call does. Whoever resumes the worker knows which it is: a new request
from the worker is a new round.

``--dry-run`` renders, runs the reviewer and writes the files; it takes no lease, checks the PR's
head only as a NOTE (so a merged PR can be reviewed for a trial), posts nothing and sets no row.

Exit: 0 reviewed (whatever the verdict); 1 refused; 2 usage; 4 the anchor, GitHub or the reviewer
did not answer, the reviewer's timeout included: no verdict, and nothing posted.
"""

import fcntl
import glob
import json
import os
import re
from dataclasses import dataclass
from typing import Any, cast

from ludics import cli, proc
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.takeover import gh_json
from ludics.fleetworker.transport import run, substitution
from ludics.fleetworker.wave import USAGE, Review, Wave, load_wave, shim, utc_now
from ludics.fleetworker.wavebrief import Part, render, write_atomically
from ludics.fleetworker.waveprep import SHA40, TASK, TEMPLATES, subject

KINDS = ("at-open", "confirm")
SHIPPED = ("checkpoint.md", "issue.md", "source.md", "confirm.md", "verdict.md")
# The NAMEs each shipped part may use (checkprompts/brieftemplate.py renders each with exactly these).
COMMON_NAMES = frozenset({"WAVE", "KIND", "REPO", "PR", "SHA", "SHA8", "CHECKOUT", "MAIN"})
PART_NAMES: dict[str, frozenset[str]] = {
    "checkpoint.md": COMMON_NAMES,
    "issue.md": COMMON_NAMES | {"ISSUE", "ISSUE_N", "ISSUE_REPO"},
    "source.md": COMMON_NAMES | {"SOURCE", "BRIEF"},
    "confirm.md": COMMON_NAMES | {"REVIEWED_SHA", "REVIEW_FILE"},
    "verdict.md": COMMON_NAMES,
}
FETCH_TIMEOUT = 300.0
PR_NUMBER = re.compile(r"[1-9][0-9]*")
VERDICT = re.compile(r"VERDICT: (clean|suggestions|blocking)(?: \((0|[1-9][0-9]*) blocking, (0|[1-9][0-9]*) suggestions\))?")


GIT_READS = ("show", "diff", "log", "cat-file", "ls-tree", "grep", "blame", "merge-base", "rev-parse", "rev-list")
GH_READS = ("pr view", "pr diff", "issue view")
FILTERS = ("head", "tail", "wc", "grep")


def reviewer_argv(review: Review, checkout: str) -> tuple[str, list[str]]:
    """The tool and arguments that run ``review.kind`` headless, the prompt on stdin and one JSON
    object on stdout whose ``result`` is the final message, with READ-ONLY's tool list (the header,
    step 7). wave.py's ``REVIEW_KINDS`` is the allowlist; a kind without a line here cannot be parsed."""
    if review.kind == "claude":
        allowed = ([f"Bash(git -C {checkout} {verb}:*)" for verb in GIT_READS] + [f"Bash(gh {verb}:*)" for verb in GH_READS]
                   + [f"Bash({name}:*)" for name in FILTERS] + ["Read", "Grep", "Glob"])
        return "claude", ["-p", "--model", review.model, "--output-format", "json", "--no-session-persistence",
                          "--allowedTools", *allowed, "--disallowedTools", "Edit", "Write", "NotebookEdit"]
    raise AssertionError(f"no reviewer for kind {review.kind}")


@dataclass(frozen=True)
class Verdict:
    word: str  # clean, suggestions, blocking or unreadable
    blocking: int
    suggestions: int
    line: str  # the verdict line as written; "" when none was read

    @property
    def blocks(self) -> bool:
        return self.word == "unreadable" or self.blocking > 0


UNREADABLE = Verdict("unreadable", 0, 0, "")


def parse_verdict(review: str) -> Verdict:
    """THE VERDICT (the header)."""
    lines = [line.rstrip() for line in review.split("\n") if line.strip()]
    found = VERDICT.fullmatch(lines[-1]) if lines else None
    if found is None:
        return UNREADABLE
    word, counted = found.group(1), found.group(2) is not None
    blocking, suggestions = (int(found.group(2)), int(found.group(3))) if counted else (0, 0)
    if (word == "blocking" and not counted) or (word != "blocking" and blocking > 0):
        return UNREADABLE
    return Verdict(word, blocking, suggestions, lines[-1])


def decision_of(kind: str, verdict: Verdict) -> str:
    """THE DECISION (the header)."""
    if verdict.word == "unreadable":
        return "unreadable"
    if kind == "at-open":
        return "confirm" if verdict.blocks else "merge"
    return "findings" if verdict.blocks else "cleared"


class Stop(Exception):
    """A refusal or failure: its exit status and its line."""

    def __init__(self, rc: int, line: str) -> None:
        super().__init__(line)
        self.rc = rc
        self.line = line


@dataclass
class Call:
    wave: Wave
    review: Review
    task: str
    pr: str
    sha: str
    kind: str
    issue_ref: str  # "" for a --source task
    source_ref: str  # "" for an issue task
    number: str
    dry_run: bool
    posted: str  # --posted <url>: the comment an ambiguous post left, found on the PR
    again: bool = False  # --again: a new round on a head already reviewed and posted

    def path(self, *parts: str) -> str:
        return os.path.join(self.wave.directory, *parts)

    @property
    def stem(self) -> str:
        return self.path("reviews", f"{self.pr}-{self.kind}-{self.sha[:12]}")

    @property
    def where(self) -> str:
        return f"{self.wave.repository}#{self.pr} {self.kind} at {self.sha[:8]}"

    def refused(self, why: str, rc: int = 1) -> Stop:
        word = "REFUSED" if rc == 1 else "NO VERDICT"
        return Stop(rc, f"WAVE REVIEW {word} {self.task}: {self.where}: {why}")


def parse(args: list[str]) -> Call:
    if len(args) < 4 or any(word.startswith("--") for word in args[:4]):
        die(f"wave review: name the wave file, the task, the PR and its head; usage: {USAGE}")
    path, task, pr, sha = args[:4]
    opts = {"--kind": "", "--issue": "", "--source": "", "--posted": ""}
    dry_run = again = False
    rest = args[4:]
    i = 0
    while i < len(rest):
        word = rest[i]
        if word in ("--dry-run", "--again"):
            dry_run, again = dry_run or word == "--dry-run", again or word == "--again"
            i += 1
            continue
        if word not in opts or i + 1 >= len(rest):
            die(f"wave review: {'unknown option ' + word if word not in opts else word + ' needs a value'}; usage: {USAGE}")
        opts[word] = rest[i + 1]
        i += 2
    wave = load_wave(path, "review")
    if wave.review is None:
        die(f"wave review: {path} names no reviewer (a review object: kind, model; wave.py's header)")
    if "MAIN" not in wave.vars:
        die(f"wave review: {path} names no vars.MAIN, the base branch the reviewer reads the PR against")
    if not TASK.fullmatch(task):
        die(f"wave review: task {task!r} does not match {TASK.pattern}")
    if not PR_NUMBER.fullmatch(pr.lstrip("#")):
        die(f"wave review: a PR is its number, not {pr!r}")
    if not SHA40.fullmatch(sha):
        die(f"wave review: the head is a full commit SHA, not {sha!r}")
    if opts["--kind"] not in KINDS:
        die(f"wave review: --kind is one of {', '.join(KINDS)}, not {opts['--kind']!r}")
    if opts["--posted"] and dry_run:
        die("wave review: --posted records a comment a real call left; it takes no --dry-run")
    if again and (dry_run or opts["--posted"]):
        die("wave review: --again starts a new round, to be reviewed and posted; it takes no --dry-run and no --posted")
    number, issue_ref, source_ref = subject(wave, task, opts["--issue"], opts["--source"], "review")
    return Call(wave, wave.review, task, pr.lstrip("#"), sha, opts["--kind"], issue_ref, source_ref, number, dry_run,
                opts["--posted"], again)


# --- the record -----------------------------------------------------------------------------------

def read_record(path: str) -> dict[str, Any] | None:
    """A record this verb wrote, or None when nothing is at ``path``. One it cannot read as its own raises."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise ValueError(f"{path} is no readable review record ({exc})") from None
    verdict: Any = cast(dict[str, Any], data).get("verdict") if isinstance(data, dict) else None
    if not (isinstance(verdict, dict) and isinstance(cast(dict[str, Any], verdict).get("word"), str)):
        raise ValueError(f"{path} is no review record (no verdict)")
    return cast(dict[str, Any], data)


def verdict_of(record: dict[str, Any]) -> Verdict:
    raw = cast(dict[str, Any], record["verdict"])

    def count(key: str) -> int:
        value = raw.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    word = str(raw["word"])
    if word not in ("clean", "suggestions", "blocking"):
        return UNREADABLE
    return Verdict(word, count("blocking"), count("suggestions"), str(raw.get("line", "")))


def write_record(call: Call, verdict: Verdict, comment: str, dry_run: bool) -> None:
    write_atomically(call.stem + ".json", json.dumps({
        "task": call.task, "pr": call.pr, "kind": call.kind, "sha": call.sha, "at": utc_now(),
        "verdict": {"word": verdict.word, "blocking": verdict.blocking, "suggestions": verdict.suggestions, "line": verdict.line},
        "decision": decision_of(call.kind, verdict), "review": call.stem + ".md", "message": call.stem + ".message.md",
        "comment": comment, "dry_run": dry_run}, indent=1) + "\n")


def at_open_record(call: Call) -> dict[str, Any] | None:
    """The newest at-open record of this PR in the wave directory (step 5)."""
    found: list[dict[str, Any]] = []
    name = re.compile(re.escape(call.pr) + r"-at-open-[0-9a-f]{12}\.json")  # a record, not its <stem>.run.json
    for path in glob.glob(glob.escape(call.path("reviews")) + f"/{call.pr}-at-open-*.json"):
        if not name.fullmatch(os.path.basename(path)):
            continue
        try:
            record = read_record(path)
        except ValueError as exc:
            raise call.refused(str(exc)) from None
        if record is not None and isinstance(record.get("sha"), str) and isinstance(record.get("at"), str):
            found.append(record)
    return max(found, key=lambda r: str(r["at"])) if found else None


def set_aside(call: Call) -> None:
    """A NEW ROUND (the header): this stem's files moved to ``<stem>.r<n>.*``, the lock aside."""
    directory, base = os.path.split(call.stem)
    n = 1
    while glob.glob(glob.escape(call.stem) + f".r{n}.*"):
        n += 1
    for name in sorted(os.listdir(directory)):
        if name.startswith(base + ".") and name != base + ".lock" and not re.fullmatch(r"r[0-9]+\..*", name[len(base) + 1:]):
            os.replace(os.path.join(directory, name), os.path.join(directory, f"{base}.r{n}.{name[len(base) + 1:]}"))


# --- the reads ------------------------------------------------------------------------------------

def check_head(cfg: Config, call: Call) -> None:
    """Step 4's GitHub read. Under --dry-run a difference is a NOTE."""
    got = gh_json(cfg, ["pr", "view", call.pr, "--repo", call.wave.repository, "--json", "state,headRefOid"])
    if isinstance(got, str):
        raise call.refused(f"the PR could not be read ({got})", 4)
    data = cast(dict[str, Any], got) if isinstance(got, dict) else {}
    state, head = data.get("state"), data.get("headRefOid")
    why = (f"the PR is {state}, not open" if state != "OPEN" else
           f"the PR's head is {head}, not {call.sha}: a review answers the head the worker asked at" if head != call.sha else "")
    if why and not call.dry_run:
        raise call.refused(f"{why}; nothing reviewed")
    if why:
        cli.say(f"WAVE REVIEW NOTE {call.task}: {why} (--dry-run goes on)")


def git(call: Call, *args: str, timeout: float | None = None) -> proc.Completed:
    return proc.run_tool("git", ["-C", call.wave.checkout, *args], timeout=timeout)


def fetch_head(call: Call) -> None:
    """Step 4's fetch: the head a commit of the checkout, nothing checked out."""
    if git(call, "cat-file", "-e", f"{call.sha}^{{commit}}").rc == 0:
        return
    done = git(call, "fetch", "-q", "origin", f"refs/pull/{call.pr}/head", timeout=FETCH_TIMEOUT)
    if done.rc != 0:
        raise call.refused(f"refs/pull/{call.pr}/head could not be fetched into {call.wave.checkout}"
                           f" ({done.stderr.strip()[-200:]})", 4)
    if git(call, "cat-file", "-e", f"{call.sha}^{{commit}}").rc != 0:
        raise call.refused(f"{call.sha} is no commit of {call.wave.checkout} after fetching refs/pull/{call.pr}/head")


def read_part(call: Call, name: str) -> Part:
    """A part: the wave directory's ``review/<name>``, else the shipped one."""
    for path in (call.path("review", name), os.path.join(TEMPLATES, "review", name)):
        try:
            with open(path, encoding="utf-8", errors="surrogateescape") as f:
                return Part(path, f.read())
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise call.refused(f"cannot read {path} ({exc.strerror})") from None
    raise call.refused(f"the shipped part {os.path.join(TEMPLATES, 'review', name)} is missing")


def project_part(call: Call) -> Part | None:
    """Step 6's project part, or None when the wave has none."""
    own = call.path("review", "project.md")
    try:
        with open(own, encoding="utf-8", errors="surrogateescape") as f:
            return Part(own, f.read())
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise call.refused(f"cannot read {own} ({exc.strerror})") from None
    where = call.review.project_part
    if not where:
        return None
    rev = f"origin/{call.wave.vars['MAIN']}"
    shown = git(call, "show", f"{rev}:{where}")
    if shown.rc != 0:
        raise call.refused(f"the project's review part {where} cannot be read in {call.wave.checkout} at {rev}"
                           f" ({shown.stderr.strip()[-200:]})")
    return Part(f"{os.path.join(call.wave.checkout, where)} at {rev}", shown.stdout)


def prompt_of(call: Call, earlier: dict[str, Any] | None) -> str:
    """Step 6: the rendered prompt."""
    values = {"WAVE": call.wave.wave, "KIND": call.kind, "REPO": call.wave.repository, "PR": call.pr, "SHA": call.sha,
              "SHA8": call.sha[:8], "CHECKOUT": call.wave.checkout, "MAIN": call.wave.vars["MAIN"]}
    parts = [read_part(call, "checkpoint.md")]
    if call.issue_ref:
        values |= {"ISSUE": call.issue_ref, "ISSUE_N": call.number, "ISSUE_REPO": call.wave.issue_repository}
        parts.append(read_part(call, "issue.md"))
    else:
        brief = call.path("briefs", f"brief-{call.task}.md")
        if not os.path.isfile(brief):
            raise call.refused(f"a --source task is judged against its brief, and {brief} is no file")
        values |= {"SOURCE": call.source_ref, "BRIEF": brief}
        parts.append(read_part(call, "source.md"))
    project = project_part(call)
    if project is not None:
        parts.append(project)
    if earlier is not None:
        values |= {"REVIEWED_SHA": str(earlier["sha"]), "REVIEW_FILE": str(earlier.get("review", ""))}
        parts.append(read_part(call, "confirm.md"))
    parts.append(read_part(call, "verdict.md"))
    result = render(parts, values)
    if isinstance(result, list):
        raise call.refused("the prompt does not render: " + "; ".join(result))
    return result


def run_reviewer(call: Call, prompt: str) -> str:
    """Step 7: the reviewer's final message."""
    tool, argv = reviewer_argv(call.review, call.wave.checkout)
    done = proc.run_tool(tool, argv, cwd=call.wave.directory, stdin=prompt.encode("utf-8", "surrogateescape"),
                         timeout=float(call.review.timeout))
    with open(call.stem + ".run.json", "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(done.stdout)
    if done.rc != 0:
        raise call.refused(f"the reviewer ({tool}) exited {done.rc} ({done.stderr.strip()[-300:]}); its output is"
                           f" {call.stem}.run.json", 4)
    try:
        answer: Any = json.loads(done.stdout)
    except ValueError:
        answer = None
    data = cast(dict[str, Any], answer) if isinstance(answer, dict) else {}
    result = data.get("result")
    if data.get("is_error") is not False or not (isinstance(result, str) and result.strip()):
        raise call.refused(f"the reviewer ({tool}) ended with no final message; its output is {call.stem}.run.json", 4)
    return result.strip() + "\n"


# --- the writes -----------------------------------------------------------------------------------

def message_of(call: Call, verdict: Verdict, comment: str) -> str:
    """THE DECISION's message for the worker."""
    said = verdict.line or "The review ended on no readable verdict line, so it is taken as blocking."
    where = f"Review checkpoint ({call.kind}) of {call.wave.repository}#{call.pr} at {call.sha}: {comment or 'not posted (a dry run)'}"
    ask = f"end your turn with `CONFIRM_REQUEST {call.pr} <head sha>` as the last line of your final message"
    if call.kind == "at-open":
        if verdict.blocks:
            body = ("The verdict is blocking. Fix or rebut each blocking finding in your ship-pr loop and reply on the PR."
                    f" Before merging, {ask}.")
        else:
            body = ("The verdict is not blocking. Answer its findings with the reviewer's round in your ship-pr loop (fix or"
                    " rebut each, and reply on the PR), and merge when the loop ends, with no CONFIRM_REQUEST.")
        return f"REVIEW_POSTED {call.pr} {call.sha}\n{said}\n\n{where}\n\n{body}\n"
    if verdict.blocks:
        return (f"MERGE NOT CLEARED {call.pr} {call.sha}\n{said}\n\n{where}\n\nBlocking findings remain. Fix or rebut each and"
                f" reply on the PR, then {ask}.\n")
    return (f"MERGE CLEARED {call.pr} {call.sha}\n{said}\n\n{where}\n\nMerge this head as ship-pr says. A push after this"
            " message is a new head: ask again before merging it.\n")


def post(cfg: Config, call: Call) -> str:
    """Step 9's comment: its URL."""
    helper = os.path.join(cfg.checkout, "ship-pr", "scripts", "pr-review.sh")
    done = run([helper, "comment", f"{call.wave.repository}#{call.pr}", "--body-file", call.stem + ".md",
                "--coordinator", f"{call.review.label} review checkpoint"], capture=True)
    lines = substitution(done.out).splitlines()
    url = lines[-1].strip() if lines else ""
    if done.rc == 0 and url.startswith("https://"):
        return url
    if done.rc == 3:
        raise call.refused(f"pr-review.sh comment exit 3: the review may or may not be posted. Read the PR; when it is"
                           f" there, re-run with --posted <its URL>, else re-run as is. The review is {call.stem}.md", 4)
    raise call.refused(f"pr-review.sh comment exit {done.rc}: the review is not posted; it is {call.stem}.md,"
                       " and a re-run posts it without another review")


def line_of(call: Call, verdict: Verdict, comment: str) -> str:
    return (f"WAVE REVIEW {call.task}: {call.where}: verdict={verdict.word} blocking={verdict.blocking}"
            f" suggestions={verdict.suggestions} decision={decision_of(call.kind, verdict)} comment={comment or '-'}"
            f" message={call.stem}.message.md")


def reviewed(cfg: Config, call: Call) -> int:
    os.makedirs(call.path("reviews"), exist_ok=True)
    with open(call.stem + ".lock", "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise call.refused(f"another call is reviewing this head (it holds {lock.name}); wait for its line") from None
        return reviewed_locked(cfg, call)


def reviewed_locked(cfg: Config, call: Call) -> int:
    try:
        record = read_record(call.stem + ".json")
    except ValueError as exc:
        raise call.refused(str(exc)) from None
    comment = str(record.get("comment") or "") if record is not None else ""
    if call.posted and record is None:
        raise call.refused(f"--posted names a comment, and no review of this head is recorded ({call.stem}.json)")
    if call.again:
        if not comment:
            raise call.refused("--again starts a new round after a posted review, and this head has none posted"
                               f" ({call.stem}.json); run the call without it")
        try:
            set_aside(call)
        except OSError as exc:
            raise call.refused(f"cannot set the earlier round's files aside ({exc.strerror}); nothing reviewed") from None
        record, comment = None, ""
    if record is not None and (comment or call.dry_run):
        cli.say(line_of(call, verdict_of(record), comment) + " (already reviewed; --again starts a new round on this head)")
        return 0
    if not call.dry_run:
        gated = anchor_gate(cfg, "WAVE REVIEW", call.task, True)
        if gated != 0:
            return gated
    if record is not None:
        verdict = verdict_of(record)
    else:
        check_head(cfg, call)
        fetch_head(call)
        earlier = at_open_record(call) if call.kind == "confirm" else None
        if call.kind == "confirm" and earlier is None:
            raise call.refused(f"no at-open review of #{call.pr} is recorded under {call.path('reviews')}; nothing to confirm")
        if earlier is not None and not verdict_of(earlier).blocks:
            review = (f"### Review checkpoint (confirm): head {call.sha[:8]}\n\nThe at-open review, at"
                      f" {str(earlier['sha'])[:8]}, was not blocking, so there is nothing to confirm.\n\nVERDICT: clean\n")
        else:
            prompt = prompt_of(call, earlier)
            write_atomically(call.stem + ".prompt.md", prompt)
            review = run_reviewer(call, prompt)
        verdict = parse_verdict(review)
        write_atomically(call.stem + ".md", review)
        write_record(call, verdict, "", call.dry_run)
    if not call.dry_run:
        check_head(cfg, call)
        comment = call.posted or post(cfg, call)
    write_atomically(call.stem + ".message.md", message_of(call, verdict, comment))
    write_record(call, verdict, comment, call.dry_run)
    if not call.dry_run:
        key = "review" if call.kind == "at-open" else "confirm"
        rc = run([shim(cfg), "board", "set", call.wave.wave, call.task, f"{key}={verdict.word}@{call.sha[:8]}"],
                 stdout_to_stderr=True).rc
        if rc != 0:
            cli.say(f"WAVE REVIEW NOTE {call.task}: board set exited {rc}; the row does not carry this review (the record does)")
    cli.say(line_of(call, verdict, comment))
    return 0


def cmd_review(cfg: Config, args: list[str]) -> int:
    call = parse(args)
    try:
        return reviewed(cfg, call)
    except Stop as stop:
        cli.say(stop.line)
        return stop.rc
