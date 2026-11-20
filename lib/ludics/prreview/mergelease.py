"""Near side of merge.py's MERGE LEASE. Anchor replies must match the requested action.

Reads only the configured fleet anchor and its merge-lease protocol. Only a recognized acquisition
or renewal sets a deadline. An unanswered renewal leaves the current deadline in force. An
explicit loss or a reply outside the renewal allowlist invalidates the proof immediately.
"""

import os
import re
import shlex
import sys
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal
from uuid import uuid4

from ludics import cli, proc
from ludics.fleetworker.config import load_config, pin_refusal
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.transport import emit_var, far_argv
from ludics.prreview.clock import Clock
from ludics.prreview.core import fail, warn
from ludics.prreview.mergebuild import fleet_worker_path

WAIT = 1800
TTL = 120
_HEARTBEAT = 30
_POLL = 5
_CALL_TIMEOUT = 20

_Action = Literal["take", "renew", "release"]
_TAKE = re.compile(r"(?:taken(?:\t[0-9]{1,12})?|held\t[0-9]{1,12})\n")


def _lease_time() -> float:
    """Elapsed time including suspend, when the anchor on another box can expire our lease."""
    if sys.platform == "linux":
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    if sys.platform == "darwin":
        return time.clock_gettime(time.CLOCK_MONOTONIC_RAW)
    return time.time()


class MergeLease:
    def __init__(self, repo: str, pr: str) -> None:
        self.repo = repo
        self.pr = pr
        self.subject = f"{shlex.quote(repo)}#{pr}"
        self._token = uuid4().hex
        cfg = load_config(str(fleet_worker_path()), os.environ)
        if why := pin_refusal(cfg):
            fail(3, f"NOT merging {self.subject}: merge lease anchor differs from the fleet pin. {why}")
        self._anchor = shlex.quote(cfg.anchor)
        try:
            source = (Path(__file__).resolve().parents[1] / "fleetworker" / "mergelease.py").read_text(encoding="utf-8")
        except OSError as exc:
            fail(3, f"NOT merging {self.subject}: merge lease helper could not be read ({exc.strerror}).")
        self._script = (
            emit_var("ANCHOR_STATE", cfg.anchor_state) + FLEET_PYTHON
            + 'py=$(fleet_python) || exit 1\n'
            + 'exec "$py" -X utf8 -P - "$ANCHOR_STATE" "$@" <<\'MERGE_LEASE_PY\'\n'
            + source + "\nMERGE_LEASE_PY\n"
        ).encode("utf-8")
        self._cfg = cfg
        self._transport_lock = threading.Lock()
        self._stopped = threading.Event()
        self._valid_until = 0.0
        self._lost = False
        self._renewal_failure = ""

    def _call(self, action: _Action, *, timeout: float = _CALL_TIMEOUT) -> str:
        argv = far_argv(self._cfg, self._cfg.anchor, [action, self.repo, self._token, self.pr, str(TTL)])
        try:
            done = proc.run_tool(argv[0], argv[1:], stdin=self._script, timeout=timeout)
        except OSError as exc:
            fail(3, f"merge lease {action} could not reach {self._anchor} ({exc.strerror}).")
        if done.rc != 0:
            fail(3, f"merge lease {action} failed on {self._anchor} (exit {done.rc}).")
        return done.stdout

    def _take(self, clock: Clock) -> None:
        deadline = clock.time() + WAIT
        holder = ""
        while True:
            remaining = deadline - clock.time()
            if remaining < 1 and holder:
                fail(1, f"NOT merging {self.subject}: merge lease wait ran out after {WAIT}s on {self._anchor}",
                     f"while held by {shlex.quote(self.repo)}#{holder}. Re-run merge.")
            started = _lease_time()
            try:
                reply = self._call("take", timeout=min(_CALL_TIMEOUT, max(1, remaining)))
            except cli.Exit as exc:
                fail(exc.rc, f"NOT merging {self.subject}: {exc.message}")
            if _TAKE.fullmatch(reply) is None:
                fail(3, f"NOT merging {self.subject}: merge lease take received an unrecognized answer from {self._anchor}.")
            status, _, pr = reply.rstrip("\n").partition("\t")
            if status == "taken":
                self._valid_until = started + TTL - 1
                if pr:
                    warn(f"{self.subject}: took over the expired merge lease of {shlex.quote(self.repo)}#{pr}")
                return
            remaining = max(0, deadline - clock.time())
            if pr != holder:
                holder = pr
                warn(f"{self.subject}: waiting up to {int(remaining)}s for the merge lease held by {shlex.quote(self.repo)}#{pr}")
            clock.sleep(min(_POLL, remaining))

    def _renew(self) -> None:
        with self._transport_lock:
            if self._lost:
                return
            started = _lease_time()
            try:
                reply = self._call("renew")
            except cli.Exit as exc:
                self._renewal_failure = exc.message
                return
            if reply == "renewed\n":
                self._renewal_failure = ""
                self._valid_until = started + TTL - 1
            else:
                self._renewal_failure = (
                    "The anchor no longer recognizes the lease token." if reply == "lost\n"
                    else "The anchor returned an unrecognized renewal reply."
                )
                self._lost = True

    def _heartbeat(self) -> None:
        while not self._stopped.wait(_HEARTBEAT):
            self._renew()
            if self._lost:
                return

    @contextmanager
    def held(self, clock: Clock) -> Generator[None]:
        self._take(clock)
        heartbeat = threading.Thread(target=self._heartbeat, name="merge-lease", daemon=True)
        try:
            heartbeat.start()
            yield
        finally:
            self._stopped.set()
            if heartbeat.ident is not None:
                heartbeat.join()
            try:
                released = self._call("release") == "released\n"
            except cli.Exit:
                released = False
            if not released:
                warn(f"{self.subject}: merge lease release was unconfirmed on {self._anchor}, and the lease will expire")

    def verify(self) -> None:
        """Renew before the final ref read, leaving the ref read adjacent to the merge call."""
        self._renew()
        self.require_current()

    def require_current(self) -> None:
        if self._lost or _lease_time() >= self._valid_until:
            detail = f" Last renewal: {self._renewal_failure}" if self._renewal_failure else ""
            fail(3, f"NOT merging {self.subject}: merge lease ownership expired or was lost on {self._anchor}.{detail} Re-run merge.")
