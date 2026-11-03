"""A fake command-line tool first on PATH, for the package's unit tests.

``FakeTool("gh")`` writes an executable ``gh`` into a scratch directory. Each run appends its argv
to a log and answers it, so a test drives the code under test the way the shell suites' fixtures
drive pr-review.sh: through the binary, never by patching the Python. Use it as a context manager;
it puts its directory first on PATH for the duration and removes it afterwards.

Two ways to answer, each set by one call that also resets the log:

- ``script(*answers)``: by call order, whatever the arguments; the last answer repeats.
- ``route(*(When, Answer) pairs)``: by the arguments; the first route whose ``When`` holds answers,
  and a call no route answers gets ``otherwise`` (by default exit 99 and a "no route for" line), or,
  with ``through``, is exec'd as that real binary (a real git with one injected failure).

A fake that must do more than answer (record its stdin or cwd, hang until killed) is a suite's
own program written over the generated one, keeping this class for the directory and PATH.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from types import TracebackType
from typing import Self

_PROGRAM = """\
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps(argv) + "\\n")
with open(os.path.join(here, "script.json"), encoding="utf-8") as f:
    script = json.load(f)
if "order" in script:
    with open(os.path.join(here, "calls.jsonl"), encoding="utf-8") as log:
        n = sum(1 for _ in log) - 1
    a = script["order"][min(n, len(script["order"]) - 1)]
else:
    joined = " ".join(argv)
    for when, a in script["routes"]:
        if (argv[:len(when["prefix"])] == when["prefix"] and all(h in argv for h in when["has"])
                and all(t in joined for t in when["text"])):
            break
    else:
        if script["through"]:
            os.execv(script["through"], [os.path.basename(sys.argv[0]), *argv])
        a = script["otherwise"]
        if a is None:
            sys.stderr.write(f"fake {os.path.basename(sys.argv[0])}: no route for: {joined}\\n")
            sys.exit(99)
if a["file_flag"] and a["file_flag"] in argv[:-1]:
    with open(argv[argv.index(a["file_flag"]) + 1], "w", encoding="utf-8") as out:
        out.write(a["file_text"])
rc, out = a["rc"], a["stdout"]
sys.stderr.write(a["stderr"])
if a["jq"] and "--jq" in argv[:-1]:
    done = subprocess.run(["jq", "-r", argv[argv.index("--jq") + 1]], input=out, capture_output=True,
                          text=True)
    out = done.stdout
    sys.stderr.write(done.stderr)
    rc = done.returncode or rc
sys.stdout.write(out)
sys.exit(rc)
"""


@dataclass(frozen=True)
class Answer:
    """One run's answer. With ``file_flag``, the run also writes ``file_text`` to the file named
    by the argument after that flag, when the flag is passed (a fake ``codex``'s ``-o``). With
    ``jq``, a run passed ``--jq <filter>`` prints ``stdout`` through ``jq -r <filter>``, as gh
    applies it; a filter jq refuses fails the run with jq's exit and message."""

    rc: int = 0
    stdout: str = ""
    stderr: str = ""
    file_flag: str = ""
    file_text: str = ""
    jq: bool = False


@dataclass(frozen=True)
class When:
    """Which runs a route answers: every condition holds. ``prefix``: argv starts with these
    arguments; ``has``: each is one whole argument somewhere in argv; ``text``: each is a substring
    of argv joined by single spaces. An empty ``When`` answers every run."""

    prefix: tuple[str, ...] = ()
    has: tuple[str, ...] = ()
    text: tuple[str, ...] = ()


def _answer(a: Answer) -> dict[str, object]:
    return {"rc": a.rc, "stdout": a.stdout, "stderr": a.stderr, "file_flag": a.file_flag,
            "file_text": a.file_text, "jq": a.jq}


class FakeTool:
    def __init__(self, name: str = "gh") -> None:
        self.name = name
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix=f"ludics-fake-{name}."))
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{_PROGRAM}")
        os.chmod(path, 0o755)
        self._saved_path: str | None = None
        self.script(Answer())

    def script(self, *answers: Answer) -> None:
        """Answer the next calls with ``answers`` in order; the last repeats. Resets the log."""
        self._write({"order": [_answer(a) for a in answers]})

    def route(self, *routes: tuple[When, Answer], otherwise: Answer | None = None, through: str = "") -> None:
        """Answer each call by its arguments: the first route whose ``When`` holds. A call none
        answers gets ``otherwise``, or with ``through`` (an absolute path, never this fake) runs
        that binary with the same arguments. Resets the log."""
        if otherwise is not None and through:
            raise ValueError("route: otherwise and through are two answers to one call")
        if through and not os.path.isabs(through):
            raise ValueError(f"route: through must be an absolute path, not {through!r}")
        if through and os.path.dirname(os.path.realpath(through)) == self.dir:
            raise ValueError("route: through names this fake, which would exec itself")
        self._write({"routes": [[{"prefix": list(w.prefix), "has": list(w.has), "text": list(w.text)},
                                 _answer(a)] for w, a in routes],
                     "otherwise": None if otherwise is None else _answer(otherwise), "through": through})

    def _write(self, script: dict[str, object]) -> None:
        with open(os.path.join(self.dir, "script.json"), "w", encoding="utf-8") as f:
            json.dump(script, f)
        log = os.path.join(self.dir, "calls.jsonl")
        if os.path.exists(log):
            os.remove(log)

    def calls(self) -> list[list[str]]:
        log = os.path.join(self.dir, "calls.jsonl")
        if not os.path.exists(log):
            return []
        with open(log, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def __enter__(self) -> Self:
        self._saved_path = os.environ.get("PATH")
        os.environ["PATH"] = self.dir + os.pathsep + (self._saved_path or "")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._saved_path is None:
            os.environ.pop("PATH", None)
        else:
            os.environ["PATH"] = self._saved_path
        shutil.rmtree(self.dir, ignore_errors=True)


_HOLDER = """\
import fcntl, json, os, sys, time
descriptor = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o644)
fcntl.flock(descriptor, fcntl.LOCK_EX)
os.ftruncate(descriptor, 0)  # as record_holder does: no byte of an earlier, longer record is left
recorded = int(sys.argv[2]) or os.getpid()
os.write(descriptor, (json.dumps({"pid": recorded, "command": ["sleep", "30"], "started": time.time(),
                                  "deadline": 600, "expires": time.monotonic() + 300}) + "\\n").encode())
print("ready", flush=True)
sys.stdin.read()
"""


class SlotHolder:
    """A real process holding a slot file's flock, with a holder record of ``recorded`` (its own
    pid when 0): THE CONFIRMATION read against the kernel, not a fake. It holds until closed."""

    def __init__(self, path: str, recorded: int = 0) -> None:
        self.process = subprocess.Popen([sys.executable, "-c", _HOLDER, path, str(recorded)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        assert self.process.stdout is not None
        if self.process.stdout.readline().strip() != "ready":
            self.close()
            raise RuntimeError(f"the slot holder for {path} did not start")
        self.pid = self.process.pid

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        self.process.wait(10)
        if self.process.stdout is not None:
            self.process.stdout.close()
