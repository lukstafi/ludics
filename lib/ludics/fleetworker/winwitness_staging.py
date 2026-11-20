"""Read the coordinator's Windows site entry and render the scripts described in
``fleetworker/winwitness.py``. The Git Bash fixture imports these functions from native Windows
Python, so the staging code depends only on the standard library.
"""

import base64
import os
import re
import shlex
from dataclasses import dataclass
from typing import Any, cast

SITE_FIELDS = frozenset(("windows_host", "root", "bash", "max_cap_seconds", "stage_seconds", "staging_line_endings", "wake"))
DEFAULT_BASH = "C:/Program Files/Git/usr/bin/bash.exe"
WINDOWS_PATH = re.compile(r"[A-Za-z]:[/\\][A-Za-z0-9 ._/\\()-]*")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


@dataclass(frozen=True)
class Site:
    windows_host: str
    root: str
    bash: str
    max_cap: int
    stage_cap: int
    wake: str
    staging_lf: bool = False


def whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


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
    if not (isinstance(fields.get("windows_host"), str) and NAME.fullmatch(fields["windows_host"])):
        return f"the site's {host}.windows_host must be the box's native Windows ssh alias, matching {NAME.pattern}"
    for key in ("max_cap_seconds", "stage_seconds"):
        if key in fields and not whole(fields[key]):
            return f"the site's {host}.{key} must be a positive whole number"
    staging_lf = fields.get("staging_line_endings") == "lf"
    if "staging_line_endings" in fields and not staging_lf:
        return f"the site's {host}.staging_line_endings must be the string 'lf' if present"
    wake = fields.get("wake", default_wake)
    if not (isinstance(wake, str) and os.path.isabs(wake)):
        return f"the site's {host}.wake must be an absolute local path"
    return Site(fields["windows_host"], paths["root"], paths["bash"],
                fields.get("max_cap_seconds", 3600), fields.get("stage_seconds", 900), wake, staging_lf=staging_lf)


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
        + "printf '\\nexit: %s\\n' \"$rc\"\n"  # its own line, after output with no final newline
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
    ]
    lines.extend((
        'git -C "$dir/checkout" fetch --quiet --no-tags --depth 1 "$url" "$sha" || fail "cannot fetch $sha from $url"',
        'git -C "$dir/checkout" checkout --quiet --detach FETCH_HEAD || fail "cannot check $sha out"',
        'observed=$(git -C "$dir/checkout" rev-parse HEAD) || fail "cannot read the checkout\'s HEAD"',
        '[ "$observed" = "$sha" ] || fail "the checkout is at $observed, not $sha"',
    ))
    for name, data in files:
        encoded = base64.b64encode(data).decode("ascii")
        lines.append(f"printf '%s' '{encoded}' | base64 -d > \"$dir\"/{name} || fail 'cannot write {name}'")
    lines.append("printf 'observed_sha: %s\\n' \"$observed\"")
    return "\n".join(lines) + "\n"


def staged_sha(rc: int, out: str, revision: str) -> bool:
    lines = [line.rstrip("\r") for line in out.split("\n") if line.strip()]
    return rc == 0 and bool(lines) and lines[-1] == "observed_sha: " + revision
