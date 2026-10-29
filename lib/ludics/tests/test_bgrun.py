"""ludics.bgrun: bg-run.sh wait's verdict line, read in one place (ludics-lite#826).

Every verdict form, the finished-earlier marker included, through both readers -- ``parse`` and
the shell form ``SHELL_VERDICT`` that ``conclude --from-bg-run``'s far side runs -- from one table,
so the two cannot disagree; then the lines the real bg-run.sh prints, one directory per verdict,
so the table is the writer's and not this file's.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

from ludics import bgrun
from ludics.bgrun import Word

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
BG_RUN = os.path.join(ROOT, "issue-wave", "scripts", "bg-run.sh")
BASH = shutil.which("bash") or "bash"

STAMP = "(finished earlier, at 2026-10-28T15:04:05Z)"

# (line, exit, word, status, earlier): what each reader must make of the line with that exit.
READS: tuple[tuple[str, int, Word | None, int | None, bool], ...] = (
    ("rc=0", 0, Word.RC, 0, False),
    ("rc=1", 0, Word.RC, 1, False),
    ("rc=143", 0, Word.RC, 143, False),
    (f"rc=0 {STAMP}", 0, Word.RC, 0, True),
    (f"rc=7 {STAMP}", 0, Word.RC, 7, True),
    ("rc=4 (finished earlier)", 0, Word.RC, 4, True),  # no time: finished_at found none
    ("rc=0 something a later bg-run.sh adds", 0, Word.RC, 0, False),
    ("RUNNING after 540 s of --within 540", 3, Word.RUNNING, None, False),
    ("STARTING after 0 s of --within 0", 4, Word.STARTING, None, False),
    ("DIED", 5, Word.DIED, None, False),
    ("STOPPED by bg-run.sh stop before the command returned", 7, Word.STOPPED, None, False),
    ("RUNNING", 3, Word.RUNNING, None, False),  # the word alone is the verdict
    # No verdict: the word is not the exit's...
    ("rc=0", 3, None, None, False),
    (f"rc=0 {STAMP}", 7, None, None, False),
    ("RUNNING after 1 s of --within 1", 0, None, None, False),
    ("DIED", 7, None, None, False),
    ("STOPPED by bg-run.sh stop before the command returned", 5, None, None, False),
    # ...or the line states none.
    ("", 0, None, None, False),
    ("rc=", 0, None, None, False),
    ("rc", 0, None, None, False),
    ("rc=x", 0, None, None, False),
    ("rc=0x", 0, None, None, False),
    ("rc=-1", 0, None, None, False),
    ("rc=0\t(finished earlier)", 0, None, None, False),  # the word ends at a blank, not a tab
    (" rc=0", 0, None, None, False),
    ("running after 1 s", 3, None, None, False),
    ("RUNNING:", 3, None, None, False),
    ("REFUSED: no", 6, None, None, False),
    ("usage: bg-run.sh wait <dir> [--within <seconds>]", 2, None, None, False),
    ("NOT RUNNING: rc=0, the command has finished; nothing was signalled", 1, None, None, False),
    ("bg-run: still waiting after 120 s of --within 540 (the run is live)", 3, None, None, False),
)


def shell_read(line: str, exit_status: int) -> tuple[int, str, str, str]:
    """``bg_verdict "$line" "$exit"`` under bash: its status, bg_word, bg_status, bg_earlier."""
    script = bgrun.SHELL_VERDICT + 'bg_verdict "$1" "$2"; r=$?\nprintf "%s|%s|%s|%s" "$r" "$bg_word" "$bg_status" "$bg_earlier"\n'
    done = subprocess.run([BASH, "-c", script, "bg", line, str(exit_status)], capture_output=True, text=True, check=True)
    r, word, status, earlier = done.stdout.split("|")
    return int(r), word, status, earlier


class Parse(unittest.TestCase):
    def test_every_form(self) -> None:
        for line, exit_status, word, status, earlier in READS:
            with self.subTest(line=line, exit=exit_status):
                got = bgrun.parse(line, exit_status)
                if word is None:
                    self.assertIsNone(got)
                    continue
                assert got is not None, line
                self.assertEqual((got.word, got.status, got.earlier, got.line), (word, status, earlier, line))

    def test_without_the_exit_only_the_line_decides(self) -> None:
        got = bgrun.parse(f"rc=3 {STAMP}")
        assert got is not None
        self.assertEqual((got.word, got.status, got.earlier), (Word.RC, 3, True))
        self.assertIsNone(bgrun.parse("rc=x"))
        for word in Word:
            if word is not Word.RC:
                parsed = bgrun.parse(f"{word.value} and the rest")
                self.assertEqual(parsed.word if parsed else None, word)

    def test_the_exit_table_is_the_writers(self) -> None:
        self.assertEqual({w.value: c for w, c in bgrun.EXIT_OF.items()},
                         {"rc": 0, "RUNNING": 3, "STARTING": 4, "DIED": 5, "STOPPED": 7})


class ShellForm(unittest.TestCase):
    def test_the_shell_form_reads_every_line_as_parse_does(self) -> None:
        for line, exit_status, word, status, earlier in READS:
            with self.subTest(line=line, exit=exit_status):
                want = (1, "", "", "") if word is None else (
                    0, word.value, "" if status is None else str(status), "1" if earlier else "")
                self.assertEqual(shell_read(line, exit_status), want)


class TheWriter(unittest.TestCase):
    """The lines bg-run.sh itself prints, one directory per verdict, read by both readers."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-bgrun-test."))
        self.addCleanup(shutil.rmtree, self.root)
        self.n = 0

    def run_dir(self, **files: str) -> str:
        self.n += 1
        d = os.path.join(self.root, f"run-{self.n}")
        os.makedirs(d)
        for name, text in files.items():
            with open(os.path.join(d, name), "w") as f:
                f.write(text)
        return d

    def wait(self, d: str, within: str = "0") -> tuple[str, int]:
        env = {**os.environ, "BG_RUN_HEARTBEAT": "0", "BG_RUN_POLL": "1"}
        done = subprocess.run([BG_RUN, "wait", d, "--within", within], capture_output=True, text=True, env=env, check=False)
        return done.stdout.rstrip("\n"), done.returncode

    def read(self, d: str, want: Word, within: str = "0") -> bgrun.Verdict:
        line, exit_status = self.wait(d, within)
        got = bgrun.parse(line, exit_status)
        self.assertIsNotNone(got, f"{line!r} (exit {exit_status})")
        assert got is not None
        self.assertEqual(got.word, want, line)
        shell = shell_read(line, exit_status)
        self.assertEqual(shell[:3], (0, got.word.value, "" if got.status is None else str(got.status)), line)
        self.assertEqual(shell[3], "1" if got.earlier else "")
        return got

    def test_every_verdict_bg_run_prints(self) -> None:
        dead = subprocess.Popen(["true"])
        dead.wait()
        self.read(self.run_dir(), Word.STARTING)
        self.read(self.run_dir(pid=f"{os.getpid()}\n"), Word.RUNNING)
        self.read(self.run_dir(pid=f"{dead.pid}\n"), Word.DIED)
        self.read(self.run_dir(pid=f"{dead.pid}\n", stopped="process group 1\n"), Word.STOPPED)
        # A run that finishes while the wait watches it prints the bare rc; a second wait finds it
        # already there and adds the marker -- the same word and status (ludics-lite#816).
        d = self.run_dir()
        late = subprocess.Popen(["sh", "-c", 'sleep 1; echo 3 > "$1/rc"', "late", d])
        with open(os.path.join(d, "pid"), "w") as f:
            f.write(f"{late.pid}\n")
        fresh = self.read(d, Word.RC, within="20")
        late.wait()
        self.assertEqual((fresh.status, fresh.earlier, fresh.line), (3, False, "rc=3"))
        earlier = self.read(d, Word.RC)
        self.assertEqual((earlier.status, earlier.earlier), (3, True))
        self.assertTrue(earlier.line.startswith("rc=3 (finished earlier"), earlier.line)


if __name__ == "__main__":
    unittest.main()
