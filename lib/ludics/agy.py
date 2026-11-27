"""One headless turn of Antigravity's ``agy`` (Gemini) for a role whose writes must not land
anywhere that matters: the review checkpoint's ``gemini`` reviewer (fleetworker/wavereview.py) and
the paired planner's ``gemini-...`` planner (peerplan/plan.py).

A CLONE, NOT A PERMISSION RULE. agy's permission rules cannot hold an agent to reading (probed on
agy 1.5.14, 2026-11-21): headless, its default mode ran ``touch``, ``rm -rf`` and file writes
unprompted; a deny rule matches only a named command; allow rules admit nothing under
``toolPermission: strict``. So the turn runs with every tool approved
(``--dangerously-skip-permissions``) in a disposable local clone (``clone``), its working directory:
whatever it writes lands in a copy nobody reads, and the checkout it was cloned from, a
coordinator's and on this repository the served skills checkout, is never its directory. The clone
has no remote, so a stray ``git push`` has nowhere to go. Its objects are copies, not hardlinks
(``--no-hardlinks``), so nothing done to the clone's files can reach the source's; no hook runs
while it is made or restored (``core.hooksPath`` is ``/dev/null``: a checkout of a PR's tree would
otherwise run a ``post-checkout`` hook in the caller's process), and every git command here and in
the turn runs with Git's repository-selection variables scrubbed (``environment``), so an
inherited ``GIT_DIR`` cannot point them at another repository. A clone carries an ownership mark
(``.git/ludics-clone``, naming its owner), and only a clone carrying its owner's mark is removed by
a caller that holds just a recorded path (``owned``). What a clone does not stop (posting on
GitHub, pushing by URL, running a suite outside the run-time slots) is the prompt's to forbid, as
the local Codex review's ``NO_TESTS`` line forbids suites. ``--sandbox`` is not used: it cuts the
network these roles read GitHub through, and on an Ubuntu box with
``kernel.apparmor_restrict_unprivileged_userns = 1`` agy logs ``Terminal sandbox unavailable`` and
runs unconfined anyway (minix-amd-linux, 2026-11-21).

THE TURN: the prompt is one stream-json user message on stdin (an argument would meet Linux's
128 KiB bound on one argv string), ASCII-escaped so an undecodable byte reaches agy as valid JSON.
agy keeps about the first 191 KB of one message (a 400 KB message kept 191,391 bytes behind a
``<truncated N bytes>`` marker, the end of the prompt lost), so a caller holds its prompt under
``MESSAGE_BOUND``. The answer is the stream's last ``result`` event: its ``response`` when
``status`` is ``SUCCESS``, the response is not blank and nothing was denied. Its
``conversation_id`` resumes the conversation (``--conversation``), and a resumed turn runs in the
same directory, since agy scopes conversations to their workspace.

RESPONSE TRIMMING shares the turn resets, delta assembly, completion order and exact LF-boundary
suffix check of farside.LOG_LAST_RESULT (#1308). An ``init`` or ``result`` clears the step state.
Only string ``text_delta`` fields on ``agent_response`` updates with finite numeric indices contribute
to the last nonblank step seen reaching ``DONE``. In Python the finite check excludes non-JSON
numbers accepted by the decoder. Preserve the whole response if the removed prefix starts a
plan or a checkpoint review on any LF-delimited line. After optional spaces or tabs, the only
protected lines are those starting with ``PLAN_READY`` or ``END_PLAN_READY``, and whole checkpoint
headings as defined by ``prreview.checkpoint.HEADING``, with trailing whitespace allowed.
This protects the envelopes these callers save. A REVIEW (``result(stdout, review=True)``, the
checkpoint's reader) trims only to a step that itself holds such a whole heading line: a step
without one keeps the whole response, so a split review whose heading is missing or malformed and
whose final step is only its verdict keeps the findings of its earlier steps (#1381). That is an
allowlist on the heading, not a reading of the step's prose: an unheaded review keeps any wait
chatter above it, which ``checkpoint.headed`` then heads like the rest. The jq reader protects
wave driver markers for CLI worker handoffs. Other event types, marker words and prose play no
part in this selection.
"""

import json
import math
import os
import shutil
import subprocess
from typing import Any, cast

from ludics import proc
from ludics.peerplan.transcript import CLOSE as PLAN_CLOSE, OPEN as PLAN_OPEN
from ludics.prreview.checkpoint import HEADING as CHECKPOINT_HEADING

MARK = "ludics-clone"
NO_HOOKS = ["-c", f"core.hooksPath={os.devnull}", "-c", "advice.detachedHead=false"]

# The UTF-8 bytes one agy message may take whole: under the ~191 KB cut (the header), with a margin.
MESSAGE_BOUND = 180_000


def size(text: str) -> int:
    return len(text.encode("utf-8", "surrogateescape"))


def argv(model: str, conversation: str = "", effort: str = "") -> list[str]:
    """One stream-json turn with every tool approved (the header: the clone is the bound)."""
    words = ["--model", model, *(["--effort", effort] if effort else []),
             "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"]
    return words + (["--conversation", conversation] if conversation else [])


def message(prompt: str) -> bytes:
    """The prompt as agy's one stream-json user message, read to EOF."""
    return (json.dumps({"event": "user", "message": {"content": prompt}}) + "\n").encode("ascii")


def _heading(line: str) -> bool:
    return CHECKPOINT_HEADING.fullmatch(line.lstrip(" \t").rstrip()) is not None


def _response_text(response: str, step: str, review: bool) -> str:
    if not step or not response.endswith(step):
        return response
    prefix = response[:-len(step)]
    if prefix and not (prefix.endswith("\n") or step.startswith("\n")):
        return response
    for line in prefix.split("\n"):
        if line.lstrip(" \t").startswith((PLAN_OPEN, PLAN_CLOSE)) or _heading(line):
            return response
    if review and not any(_heading(line) for line in step.split("\n")):
        return response
    return step


def result(stdout: str, review: bool = False) -> tuple[str, str, str]:
    """The turn's final message, its conversation id, and "" or why there is no message.
    ``review``: the checkpoint's reader (RESPONSE TRIMMING, the header)."""
    final: dict[str, Any] = {}
    conversation = ""
    buffers: dict[int | float, list[str]] = {}
    completed = last_completed = ""
    for raw in stdout.split("\n"):  # one event per LF line (never splitlines: U+0085 is JSON text)
        try:
            event: Any = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        fields = cast(dict[str, Any], event)
        cid = fields.get("conversation_id")
        if isinstance(cid, str) and cid:
            conversation = cid
        kind = fields.get("event")
        if kind == "init":
            buffers.clear()
            completed = ""
        elif kind == "step_update":
            step = fields.get("step_update")
            if not isinstance(step, dict):
                continue
            update = cast(dict[str, Any], step)
            index, delta = update.get("step_index"), update.get("text_delta")
            if update.get("step_type") != "agent_response":
                continue
            if type(index) is not int and type(index) is not float:
                continue
            if type(index) is float and not math.isfinite(index):
                continue
            if isinstance(delta, str):
                buffers.setdefault(index, []).append(delta)
            if update.get("state") == "DONE":
                whole = "".join(buffers.get(index, ()))
                if whole.strip():
                    completed = whole
        elif kind == "result":
            found: Any = fields.get("result")
            final = cast(dict[str, Any], found) if isinstance(found, dict) else {}
            last_completed = completed
            buffers.clear()
            completed = ""
            cid = final.get("conversation_id")
            if isinstance(cid, str) and cid:
                conversation = cid
    text, denied = final.get("response"), final.get("denied_actions")
    if isinstance(denied, list) and denied:
        names = [str(cast(dict[str, Any], d).get("action")) for d in cast(list[Any], denied) if isinstance(d, dict)]
        return "", conversation, f"agy refused it a permission ({', '.join(names) or 'unnamed'}), which ends its turn"
    if final.get("status") != "SUCCESS" or not (isinstance(text, str) and text.strip()):
        return "", conversation, f"its result is {final.get('status') or 'missing'} with no response"
    return _response_text(text, last_completed, review), conversation, ""


def environment() -> dict[str, str]:
    """This process's environment without Git's repository-selection variables (``git rev-parse
    --local-env-vars``: GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE ...), for every git command of a
    clone's setup and for the turn itself."""
    env = dict(os.environ)
    done = proc.run_tool("git", ["rev-parse", "--local-env-vars"], stdin=subprocess.DEVNULL, env=env)
    names = done.stdout.split() if done.rc == 0 else ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                                                     "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"]
    for name in names:
        env.pop(name, None)
    return env


def _steps(steps: list[list[str]]) -> str:
    env = environment()
    for step in steps:
        done = proc.run_tool("git", step, stdin=subprocess.DEVNULL, env=env)
        if done.rc != 0:
            return f"git {' '.join(w for w in step if not w.startswith('core.') and w != '-c')[:120]} failed (exit {done.rc}):" \
                   f" {done.stderr.strip()[-200:]}"
    return ""


def clone(source: str, rev: str, dest: str, owner: str, refs: dict[str, str] | None = None) -> str:
    """A disposable local clone of ``source`` at ``rev`` (detached), with no remote, marked as
    ``owner``'s; ``refs`` are set in it by name (``origin/<main>`` as ``source`` has it, which the
    clone would otherwise map from ``source``'s own branches). "" when it was made, else why not,
    with nothing left at ``dest``."""
    steps = [[*NO_HOOKS, "clone", "-q", "--no-checkout", "--no-hardlinks", "--origin", "origin", source, dest],
             ["-C", dest, *NO_HOOKS, "checkout", "-q", "--detach", rev], ["-C", dest, "remote", "remove", "origin"]]
    steps += [["-C", dest, "update-ref", name, sha] for name, sha in (refs or {}).items()]
    why = _steps(steps)
    if not why:
        try:
            with open(os.path.join(dest, ".git", MARK), "w", encoding="utf-8") as f:
                f.write(owner + "\n")
        except OSError as exc:
            why = f"cannot mark the clone ({exc.strerror})"
    if why:
        shutil.rmtree(dest, ignore_errors=True)
    return why


def owned(dest: str, owner: str) -> bool:
    """Whether ``dest`` is a clone ``clone`` made for ``owner`` (its mark names it)."""
    try:
        with open(os.path.join(dest, ".git", MARK), encoding="utf-8") as f:
            return f.read().strip() == owner
    except OSError:
        return False


def restore(dest: str, rev: str) -> str:
    """The clone put back to ``rev`` exactly, whatever a turn did to it: "" or why not."""
    return _steps([["-C", dest, *NO_HOOKS, "checkout", "-q", "-f", "--detach", rev],
                   ["-C", dest, *NO_HOOKS, "reset", "-q", "--hard", rev], ["-C", dest, "clean", "-q", "-ffdx"]])
