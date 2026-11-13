"""The coordinator lease and the stop-the-world halt: ``claim``, ``release``, ``coordinator``, ``halt``,
``resume-launches``, ``halted``, and the anchor gate the native ``gate`` reads (fleet-worker.sh's
``cmd_claim``, ``cmd_release``, ``cmd_coordinator``, ``cmd_halt``, ``cmd_resume_launches``,
``cmd_halted``, ``anchor_gate``).

Fleet-wide state lives on one anchor box (FLEET_ANCHOR), never on whichever box the coordinator
runs on: the lease is one file there, ``$ANCHOR_STATE/COORDINATOR`` (host, token, since), and the
halt is ``$ANCHOR_STATE/HALT``. Every lease mutation runs under the lease lock
``COORDINATOR.lock`` on the anchor, taken by the prelude's ``take_lock`` (the one mkdir lock every
far side uses), so the far-side scripts below are the shell's, verbatim; this module is their near
side, and ``anchor_gate`` is what launch, unstick and close read first. An anchor that does not
answer is ``<VERB> UNREACHABLE <anchor>``, exit 4, never a verdict about the lease.
"""

import os

from ludics import cli
from ludics.fleetworker import identity
from ludics.fleetworker.config import Config, short_hostname
from ludics.fleetworker.identity import check_identity, die, my_token
from ludics.fleetworker.transport import prelude, run_on

# tiprun.HALT_READ's rule: only no entry in a searchable state directory is open. A present
# marker must be a readable regular file (links to such files work). Unread state returns at once.
HALT_STATE = r"""read_halt() {
  halt_present=0 halt_text=
  f="$ANCHOR_STATE/HALT"
  [ -d "$ANCHOR_STATE" ] && [ -x "$ANCHOR_STATE" ] || return 1
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then return 0; fi
  [ -f "$f" ] || return 1
  halt_text=$(cat "$f" 2>/dev/null) || return 1
  halt_present=1
}
"""

# Far side for the anchor: lease + halt checks. Args: verb label force token. Prints nothing when
# the coordinator may proceed; otherwise one refusal line, exit 1.
ANCHOR_GATE = HALT_STATE + r"""verb="$1" label="$2" force="$3" token="$4"
lease="$ANCHOR_STATE/COORDINATOR"
if [ ! -f "$lease" ]; then echo "$verb REFUSED $label: no coordinator lease on the anchor -- run \`fleet-worker.sh claim\` first"; exit 1; fi
held=$(sed -n 's/^token=//p' "$lease"); host=$(sed -n 's/^host=//p' "$lease"); since=$(sed -n 's/^since=//p' "$lease")
if [ -z "$token" ] || [ "$held" != "$token" ]; then
  echo "$verb REFUSED $label: coordinator lease held by $host since $since -- adopt it with \`fleet-worker.sh claim --take\` only if that coordinator is gone"; exit 1
fi
if [ "$force" != 1 ]; then
  read_halt || { printf '%s\n' "$verb REFUSED $label: cannot read HALT on $BOX; launches refused"; exit 1; }
  if [ "$halt_present" = 1 ]; then
    printf '%s\n' "$verb REFUSED $label: launches halted -- $halt_text"; exit 1
  fi
fi
"""

# Far side: take the lease lock (shared with claim --take and release), verify the caller still
# holds the lease, then run the mutation. Args: verb token lockwait, then the action's.
LEASE_MUTATION = r"""verb="$1" token="$2" lockwait="$3"; shift 3
mkdir -p "$ANCHOR_STATE" 2>/dev/null; lease="$ANCHOR_STATE/COORDINATOR"; lock="$lease.lock"
msg=$(take_lock "$lock" "$lockwait" "$verb FAILED: lease lock on $BOX") || { echo "$msg"; exit 1; }
trap 'release_lock "$lock"' EXIT
held=$(sed -n 's/^token=//p' "$lease" 2>/dev/null); hhost=$(sed -n 's/^host=//p' "$lease" 2>/dev/null)
[ -n "$token" ] && [ "$held" = "$token" ] || { echo "$verb REFUSED fleet: coordinator lease held by ${hhost:-nobody} -- not you (adopted since your gate?)"; exit 1; }
"""

# The lease is one file on the anchor, created with an atomic link so two coordinators starting at
# once cannot both win, naming the holder's host and token. Args: host token take lockwait.
CLAIM = r"""host="$1" token="$2" take="$3" lockwait="$4"
mkdir -p "$ANCHOR_STATE"; lease="$ANCHOR_STATE/COORDINATOR"
record() { printf 'host=%s\ntoken=%s\nsince=%s\n' "$host" "$token" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
# Every lease mutation - first claim, idempotent re-claim, takeover - runs under one lock, so
# a claim cannot slip between a release and a queued takeover and leave two believers.
lock="$lease.lock"
msg=$(take_lock "$lock" "$lockwait" "CLAIM FAILED: lease lock on $BOX") || { echo "$msg"; exit 1; }
trap 'release_lock "$lock"' EXIT
verified() { [ "$(sed -n 's/^token=//p' "$lease" 2>/dev/null)" = "$token" ]; }
# The record is written and verified in a temp file first, then published atomically (link for
# a first claim, rename for a takeover), so a failed write never truncates a valid lease.
tmp="$lease.tmp.$$"; trap 'rm -f "$tmp"; release_lock "$lock"' EXIT
# ln/mv onto a DIRECTORY would publish the record inside it; refuse that shape outright.
[ ! -d "$lease" ] || { echo "CLAIM FAILED: could not write the lease at $lease on $BOX (a directory in its place)"; exit 1; }
staged() { record > "$tmp" 2>/dev/null && [ "$(sed -n 's/^token=//p' "$tmp" 2>/dev/null)" = "$token" ]; }
if [ ! -f "$lease" ]; then
  if staged && ln "$tmp" "$lease" 2>/dev/null && verified; then echo "CLAIMED coordinator lease on $BOX for $host"; exit 0; fi
  echo "CLAIM FAILED: could not write the lease at $lease on $BOX (a directory in its place, or unwritable)"; exit 1
fi
held=$(sed -n 's/^token=//p' "$lease"); hhost=$(sed -n 's/^host=//p' "$lease"); since=$(sed -n 's/^since=//p' "$lease")
if [ "$held" = "$token" ]; then echo "CLAIMED already held by $host since $since"; exit 0; fi
if [ "$take" = 1 ]; then
  if staged && mv -f "$tmp" "$lease" 2>/dev/null && verified; then
    echo "CLAIMED (adopted) coordinator lease on $BOX for $host -- was ${hhost:-nobody} since ${since:-never}"; exit 0
  fi
  echo "CLAIM FAILED: could not write the lease at $lease on $BOX (a directory in its place, or unwritable) -- not adopted; the previous lease is intact"; exit 1
fi
echo "CLAIM REFUSED: coordinator lease held by $hhost since $since -- a wave is in flight; adopt with --take only if that coordinator is gone"
exit 1
"""

# The token check and the removal happen under the same lock takeovers use, so a release racing an
# adoption cannot delete the successor's freshly written lease. Args: token lockwait.
RELEASE = r"""token="$1" lockwait="$2"; lease="$ANCHOR_STATE/COORDINATOR"
lock="$lease.lock"
msg=$(take_lock "$lock" "$lockwait" "RELEASE FAILED: lease lock on $BOX") || { echo "$msg -- the lease is still held"; exit 1; }
trap 'release_lock "$lock"' EXIT
[ -f "$lease" ] || { echo "RELEASE: no lease held"; exit 0; }
held=$(sed -n 's/^token=//p' "$lease"); hhost=$(sed -n 's/^host=//p' "$lease")
[ "$held" = "$token" ] || { echo "RELEASE REFUSED: lease held by $hhost, not you"; exit 1; }
if rm -f "$lease" 2>/dev/null && [ ! -e "$lease" ]; then echo "RELEASED coordinator lease on $BOX"; else echo "RELEASE FAILED: could not remove $lease on $BOX -- the lease is still held"; exit 1; fi
"""

# Who holds the lease: exit 0 me, 1 another, 3 nobody. Args: token.
COORDINATOR = r"""token="$1"; lease="$ANCHOR_STATE/COORDINATOR"
[ -f "$lease" ] || { echo "COORDINATOR: nobody holds the lease on $BOX"; exit 3; }
held=$(sed -n 's/^token=//p' "$lease"); hhost=$(sed -n 's/^host=//p' "$lease"); since=$(sed -n 's/^since=//p' "$lease")
if [ -n "$token" ] && [ "$held" = "$token" ]; then echo "COORDINATOR: you ($hhost) since $since"; exit 0; fi
echo "COORDINATOR: $hhost since $since (not you)"; exit 1
"""

# After LEASE_MUTATION. Args: reason halt-id. A halt keeps the identity of the halt it updates (the
# generation the registry binds a triage reservation to); a legacy marker with no id keeps its
# first line as the generation and has the update appended.
HALT = HALT_STATE + r"""halt="$ANCHOR_STATE/HALT"; halt_id="$2"
read_halt || { printf '%s\n' "HALT FAILED: cannot read HALT on $BOX; marker kept"; exit 1; }
if [ "$halt_present" = 1 ]; then
  existing_id=$(sed -n '1s/^[^ ]* id=\([^ ]*\) .*/\1/p' "$halt")
  if [ -z "$existing_id" ]; then
    # Legacy markers have no ID: retain their first line as the generation, append the update.
    if printf 'update %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$halt"; then
      echo "HALTED: launches refused until resume-launches -- $1"; exit 0
    fi
    echo "HALT FAILED: cannot update $halt on $BOX"; exit 1
  fi
  halt_id="$existing_id"
fi
if ! printf '%s id=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$halt_id" "$1" > "$ANCHOR_STATE/HALT" 2>/dev/null || ! read_halt || [ "$halt_present" != 1 ]; then
  echo "HALT FAILED: cannot write $ANCHOR_STATE/HALT on $BOX -- the fleet is NOT halted"; exit 1
fi
echo "HALTED: launches refused until resume-launches -- $1"
"""

# After LEASE_MUTATION.
RESUME = r"""f="$ANCHOR_STATE/HALT"
if [ -f "$f" ]; then
  was=$(cat "$f"); rm -f "$f" 2>/dev/null
  [ ! -e "$f" ] || { echo "RESUME-LAUNCHES FAILED: cannot remove $f on $BOX -- still halted"; exit 1; }
  echo "RESUMED launches (was: $was)"
else echo "launches were not halted"; fi
"""

HALTED = HALT_STATE + r"""read_halt || { printf '%s\n' "HALTED: cannot read HALT on $BOX; launches refused"; exit 1; }
if [ "$halt_present" = 1 ]; then printf '%s\n' "HALTED $halt_text"; exit 1; fi
printf '%s\n' "launches open"
"""


def _anchor(cfg: Config, script: str, args: list[str], unreachable_line: str) -> int:
    done = run_on(cfg, cfg.anchor, prelude(cfg, cfg.anchor) + script, args)
    if done.unreachable:
        cli.say(unreachable_line)
        return 4
    return done.rc


def anchor_gate(cfg: Config, verb: str, label: str, force: bool) -> int:
    """0 proceed, 1 refused (its line printed), 4 the anchor did not answer."""
    check_identity(cfg)
    return _anchor(
        cfg,
        ANCHOR_GATE,
        [verb, label, "1" if force else "0", my_token(cfg)],
        f"{verb} REFUSED {label}: anchor {cfg.anchor} unreachable (lease and halt live there)",
    )


def _persist_token(path: str) -> None:
    """Create the token file once, never over an existing one: two first claims of one identity
    race to create it, and the loser reads the winner's (the shell's noclobber)."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError:
        pass
    token = identity.gen_uuid()
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    except OSError:
        return
    with os.fdopen(descriptor, "w", encoding="utf-8") as f:
        f.write(token + "\n")


def _nonempty_file(path: str) -> bool:
    """``[ -s path ]``."""
    try:
        return os.path.getsize(path) > 0
    except OSError:
        return False


def cmd_claim(cfg: Config, args: list[str]) -> int:
    ident = check_identity(cfg)
    take = False
    for arg in args:
        if arg != "--take":
            die(f"claim: unknown option {arg}")
        take = True
    tf = identity.token_file(cfg)
    if not _nonempty_file(tf):
        _persist_token(tf)
    if not _nonempty_file(tf):
        cli.say(f"CLAIM REFUSED: cannot persist this coordinator's token at {tf}")
        return 1
    return _anchor(
        cfg,
        CLAIM,
        [f"{short_hostname()}/{ident}", my_token(cfg), "1" if take else "0", cfg.lock_wait],
        f"CLAIM UNREACHABLE {cfg.anchor}",
    )


def cmd_release(cfg: Config, args: list[str]) -> int:
    del args  # the shell's release took no options and ignored any it was given
    check_identity(cfg)
    return _anchor(cfg, RELEASE, [my_token(cfg), cfg.lock_wait], f"RELEASE UNREACHABLE {cfg.anchor}")


def cmd_coordinator(cfg: Config, args: list[str]) -> int:
    del args
    check_identity(cfg)
    return _anchor(cfg, COORDINATOR, [my_token(cfg)], f"COORDINATOR UNREACHABLE {cfg.anchor}")


def cmd_halt(cfg: Config, args: list[str]) -> int:
    reason = " ".join(args)
    if not reason:
        die("halt: give the reason (what regressed, who owns the fix)")
    halt_id = identity.gen_uuid()
    check_identity(cfg)
    return _anchor(
        cfg,
        LEASE_MUTATION + HALT,
        ["HALT", my_token(cfg), cfg.lock_wait, reason, halt_id],
        f"HALT UNREACHABLE {cfg.anchor}",
    )


def cmd_resume_launches(cfg: Config, args: list[str]) -> int:
    del args
    check_identity(cfg)
    return _anchor(
        cfg,
        LEASE_MUTATION + RESUME,
        ["RESUME-LAUNCHES", my_token(cfg), cfg.lock_wait],
        f"RESUME-LAUNCHES UNREACHABLE {cfg.anchor}",
    )


def cmd_halted(cfg: Config, args: list[str]) -> int:
    del args
    return _anchor(cfg, HALTED, [], f"HALTED? UNREACHABLE {cfg.anchor}")

