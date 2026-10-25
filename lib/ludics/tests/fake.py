"""A fake command-line tool first on PATH, for the package's unit tests.

``FakeTool("gh")`` writes an executable ``gh`` into a scratch directory. Each run appends its argv
to a log and answers with the next scripted ``Answer`` (the last one repeats), so a test drives
the code under test the way the shell suites' fixtures drive pr-review.sh: through the binary,
never by patching the Python. Use it as a context manager; it puts its directory first on PATH
for the duration and removes it afterwards.
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
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
with open(os.path.join(here, "calls.jsonl"), encoding="utf-8") as log:
    n = sum(1 for _ in log) - 1
with open(os.path.join(here, "script.json"), encoding="utf-8") as f:
    answers = json.load(f)
a = answers[min(n, len(answers) - 1)]
if a["file_flag"] and a["file_flag"] in sys.argv[1:-1]:
    with open(sys.argv[sys.argv.index(a["file_flag"]) + 1], "w", encoding="utf-8") as out:
        out.write(a["file_text"])
sys.stdout.write(a["stdout"])
sys.stderr.write(a["stderr"])
sys.exit(a["rc"])
"""


@dataclass(frozen=True)
class Answer:
    """One run's answer. With ``file_flag``, the run also writes ``file_text`` to the file named
    by the argument after that flag, when the flag is passed (a fake ``codex``'s ``-o``)."""

    rc: int = 0
    stdout: str = ""
    stderr: str = ""
    file_flag: str = ""
    file_text: str = ""


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
        with open(os.path.join(self.dir, "script.json"), "w", encoding="utf-8") as f:
            json.dump([{"rc": a.rc, "stdout": a.stdout, "stderr": a.stderr, "file_flag": a.file_flag,
                       "file_text": a.file_text} for a in answers], f)
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
