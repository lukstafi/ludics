"""Starting external programs: the one place in the package that does.

Every external tool -- ``gh``, ``git`` -- is run as a BINARY resolved on PATH, never replaced by an
HTTP client or a library, so the fixtures that drive the shell scripts drive the Python too: a
fake ``gh`` first on PATH answers both.

The shell bridge. The pr-review suites do not put a fake ``gh`` on PATH: they SOURCE the script
and define ``gh`` as a shell FUNCTION, whose answers read the suite's own variables. A Python
process cannot call a function of the shell that started it, so the shell's forwarder (``py_forward``
in pr-review.sh) hands it the next best thing when, and only when, one of the commands it would
run is a shell function there:

  LUDICS_BRIDGE_FUNCS  the names that are functions in the forwarding shell (``gh git``);
  LUDICS_BRIDGE_STATE  a file holding that shell's functions and variables (``declare -f``,
                       ``declare -p``) and its ``-u``/``pipefail`` options;
  LUDICS_BRIDGE_SHELL  that shell's own bash (``$BASH``), so the file is read by the bash that
                       wrote it -- bash 3.2's output in bash 3.2.

A bridged call runs ``<bash> -c '. <state>; <name> "$@"'``: a fresh shell holding the same
definitions and values the forwarder's shell had, which is what the shell implementation's
``$(gh ...)`` saw -- it, too, ran every gh call in a subshell, so a fixture already keeps
anything that must outlive one call in a FILE. With none of the three set, which is every
production run, a tool is the binary on PATH and nothing else.
"""

import os
import shutil
import subprocess
from collections.abc import Mapping, MutableMapping, Sequence
from dataclasses import dataclass

BRIDGE_FUNCS = "LUDICS_BRIDGE_FUNCS"
BRIDGE_STATE = "LUDICS_BRIDGE_STATE"
BRIDGE_SHELL = "LUDICS_BRIDGE_SHELL"
# scripts/py's note, under Git Bash only, of this interpreter's pid as Git Bash numbers it.
SHELL_PID = "LUDICS_SHELL_PID"
_shell_pid: int | None = None


@dataclass(frozen=True)
class Completed:
    """A finished process: its status and both streams, decoded as UTF-8 with surrogateescape so
    any bytes round-trip back out unchanged."""

    rc: int
    stdout: str
    stderr: str


def take_shell_pid(env: MutableMapping[str, str]) -> None:
    """Take scripts/py's ``LUDICS_SHELL_PID`` out of ``env``, keeping it for ``own_pid``: the note
    names this interpreter, and a program it runs is another process."""
    global _shell_pid
    text = env.pop(SHELL_PID, None)
    if text is not None and text.isascii() and text.isdigit():
        _shell_pid = int(text)


def own_pid() -> int:
    """This process's pid in the namespace the shell's ``kill -0`` reads, which is the one a lock
    shared with the shell implementation names: ``os.getpid()``, except under Git Bash, where a
    native interpreter's own pid is a WINDOWS pid and the shell's are MSYS pids, two numberings
    that overlap (MSYS pid 2380 and an unrelated svchost.exe of Windows pid 2380). There it is the
    MSYS pid scripts/py noted (``take_shell_pid``)."""
    return os.getpid() if _shell_pid is None else _shell_pid


def decode(data: bytes) -> str:
    return data.decode("utf-8", "surrogateescape")


def bridge_argv(name: str, args: Sequence[str], env: Mapping[str, str]) -> list[str] | None:
    """The argv that runs ``name`` through the shell bridge, or None when it is not bridged."""
    funcs = env.get(BRIDGE_FUNCS, "").split()
    state = env.get(BRIDGE_STATE, "")
    shell = env.get(BRIDGE_SHELL, "")
    if name not in funcs or not state or not shell:
        return None
    # The state's own errors (a readonly variable it cannot reassign) are the bridge's, not the
    # tool's: they must not reach the stderr the caller classifies.
    script = '. "$1" 2>/dev/null; shift; ' + name + ' "$@"'
    return [shell, "-c", script, name, state, *args]


_WINDOWS_EXECUTABLE_SUFFIXES = (".exe", ".com", ".bat", ".cmd")


def is_script(path: str) -> bool:
    """A file Windows cannot start by itself: no executable suffix, and a ``#!`` line."""
    if path.lower().endswith(_WINDOWS_EXECUTABLE_SUFFIXES):
        return False
    try:
        with open(path, "rb") as handle:
            return handle.read(2) == b"#!"
    except OSError:
        return False


def windows_lookup(name: str, env: Mapping[str, str] | None = None) -> str | None:
    """PATH as Git Bash searches it: in each directory, the bare name (a ``#!`` script such as a
    suite's fake ``gh`` or ``git``) and then the name with each executable suffix, first match
    winning. ``shutil.which`` tries the suffixes only, so it passes over a fake ``gh`` to the real
    ``gh.exe`` further along PATH."""
    environ = os.environ if env is None else env
    suffixes = [s for s in environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(os.pathsep) if s]
    if os.path.dirname(name):
        # A path, not a name (the bridge's own bash, ``$BASH`` made native): the shell searches no
        # PATH for it, and the file it names is the command whatever its suffix.
        for candidate in [name, *(name + suffix.lower() for suffix in suffixes)]:
            if os.path.isfile(candidate):
                return candidate
        return None
    for directory in environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        for candidate in [name, *(name + suffix.lower() for suffix in suffixes)]:
            path = os.path.join(directory, candidate)
            if os.path.isfile(path) and (candidate != name or is_script(path)):
                return path
    return None


def command_argv(name: str, env: Mapping[str, str] | None = None) -> list[str] | None:
    """The argv prefix that runs ``name`` as the shell found it on PATH.

    Under Git Bash the shell ran a ``#!`` script on PATH -- a suite's fake ``gh`` or ``git``, a
    wrapper a box installs -- through its own exec, which reads the line; Windows cannot start such
    a file, so a native interpreter hands it to the bash on PATH, which is Git Bash's own.
    Elsewhere the file is started directly, as the shell started it."""
    environ = os.environ if env is None else env
    if os.name != "nt":
        exe = shutil.which(name, path=environ.get("PATH"))
        return None if exe is None else [exe]
    exe = windows_lookup(name, environ)
    if exe is None:
        return None
    if is_script(exe):
        shell = shutil.which("bash", path=environ.get("PATH"))
        if shell is not None:
            return [shell, exe]
    return [exe]


def windows_command_line(argv: Sequence[str]) -> str:
    """Every argument double-quoted, by the C runtime's rules. A Cygwin/MSYS program started by a
    native one parses its own command line and expands each UNQUOTED word as a glob, braces
    included -- `<oid>^{object}` arrived at a fake git as `<oid>^object`, and a GraphQL query with
    no space in it arrived at a bridged gh as two words -- so a program that Git Bash's runtime
    starts (its bash, a #! script through it) gets nothing unquoted. subprocess's own rendering
    quotes only a word with a space or a tab in it."""
    words: list[str] = []
    for arg in argv:
        out: list[str] = []
        slashes = 0
        for char in arg:
            if char == "\\":
                slashes += 1
                continue
            if char == '"':
                out.append("\\" * (2 * slashes + 1) + '"')
            else:
                out.append("\\" * slashes + char)
            slashes = 0
        out.append("\\" * (2 * slashes))
        words.append('"' + "".join(out) + '"')
    return " ".join(words)


def run_tool(
    name: str,
    args: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    cwd: str | None = None,
    stdin: int | bytes | None = None,
) -> Completed:
    """Run the tool ``name`` with ``args``, capturing both streams. stdin is inherited unless
    ``stdin`` names another: a file descriptor or ``subprocess.DEVNULL`` (the shell's
    ``</dev/null``), or bytes to feed it (a shell ``printf '%s' "$x" | tool``).

    A tool that is not on PATH completes with 127 and the shell's message, as ``gh`` would have
    in the shell implementation, so callers classify it the same way.
    """
    environ = dict(os.environ if env is None else env)
    argv = bridge_argv(name, args, environ)
    if argv is None:
        prefix = command_argv(name, environ)
        if prefix is None:
            return Completed(127, "", f"{name}: command not found\n")
        argv = [*prefix, *args]
    # Under Windows the bridge's bash, and a #! tool handed to it, are MSYS programs: each word
    # must reach them quoted (``windows_command_line``).
    spawn: list[str] | str = windows_command_line(argv) if os.name == "nt" else argv
    if isinstance(stdin, bytes):
        proc = subprocess.run(
            spawn, input=stdin, capture_output=True, env=environ, cwd=cwd, check=False
        )
    else:
        proc = subprocess.run(
            spawn, stdin=stdin, capture_output=True, env=environ, cwd=cwd, check=False
        )
    return Completed(proc.returncode, decode(proc.stdout), decode(proc.stderr))


def substitution(text: str) -> str:
    """What the shell's ``$(...)`` keeps of a command's output: every NUL byte dropped (bash drops
    them as it reads, with a warning on 5.x) and then every trailing newline."""
    return text.replace("\0", "").rstrip("\n")
