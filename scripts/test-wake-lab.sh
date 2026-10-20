#!/usr/bin/env bash
# Exercises wake-lab.sh with shim `curl`/`python3`/`ssh` on PATH -- no router, no network, no
# ssh. What it pins is what ludics-lite#31 split the script into: the tracked half (the lore, the
# router endpoints, the aliases, the dispatch) must carry no hardware addresses, and the untracked
# half (~/.config/wake-lab/hosts.sh) must be what every MAC actually comes from. It also pins the
# `--help` range, which used to be the hard-coded `2,20p` that silently truncated a grown header.
#
# Usage: test-wake-lab.sh   (exit 0 all pass, 1 otherwise)

set -uo pipefail
# Feed captured assertions with here-strings: early-exiting grep must not SIGPIPE a writer.

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape.
{
HERE=$(cd "$(dirname "$0")" && pwd)
WL="$HERE/wake-lab.sh"
EXAMPLE="$HERE/wake-lab-hosts.example.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/wake-lab-test.XXXXXX") || exit 1
# Physical path, for the same reason the other suites resolve theirs: on macOS $TMPDIR is under
# /var, a symlink to /private/var, so an unresolved $TMP and the path wake-lab.sh prints for the
# same directory are spelled differently and a comparison quietly stops matching
# (ludics-lite#208).
TMP=$(CDPATH= cd "$TMP" && pwd -P) || exit 1
# The holders this suite spawns outlive the cases that spawn them -- a holder that ended on its own
# would not be a holder -- so the cleanup ends them before it removes the directory they record
# themselves in. The guard is for the cases that fail before the shim exists.
trap 'declare -F kill_stub_holders >/dev/null 2>&1 && kill_stub_holders; rm -rf "$TMP"' EXIT

# The lab lock directory, for the WHOLE suite and not merely the cases that are about locking.
# Every `restart-wsl` here reserves its box for real, so without this the suite takes flocks under
# the developer's own ~/.local/state/wake-lab -- writing lock files into $HOME, blocking a genuine
# sweep or wake-lab run for as long as a case holds one, and (since a wedged case's orphaned `ssh`
# inherits the descriptor) leaving one held for minutes after the suite exits. Two suite runs
# overlapping then fight over the real lab's locks and fail each other's restart cases, which is
# how this was found. Exported, so every invocation below inherits it whether or not it passes
# `env`.
LOCKS="$TMP/locks"; mkdir -p "$LOCKS"
WAKE_LAB_LOCK_DIR="$LOCKS"; export WAKE_LAB_LOCK_DIR
# ...and the execution registry `status` counts reservations from (ludics-lite#359) and every
# destroyer reads before it acts (#445): a stub reader, so no case reads the real registry or asks
# the anchor box over ssh. It prints FW_LISTING, by default an empty registry, with status FW_RC;
# FW_LOCKCHECK=<box> logs to FW_LOG whether that box's lane lock was held when it was read.
cat >"$TMP/fleet-worker.sh" <<'FW'
#!/usr/bin/env bash
[ "$*" = "execution list --active --compact" ] || exit 9
if [ -n "${FW_LOCKCHECK:-}" ]; then
  if perl -e 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' \
       "$WAKE_LAB_LOCK_DIR/$FW_LOCKCHECK.lock"; then st=held; else st=free; fi
  printf 'registry read with lane=%s\n' "$st" >>"$FW_LOG"
fi
printf '%s' "${FW_LISTING-[]}"; exit "${FW_RC:-0}"
FW
chmod +x "$TMP/fleet-worker.sh"
WAKE_LAB_FLEET_WORKER="$TMP/fleet-worker.sh"; export WAKE_LAB_FLEET_WORKER

# ...and the control that the export above is really doing it. The redirection is one variable
# deep: a case that builds its own environment with `env -i`, or an explicit `env` list that drops
# this name, falls back to the real lab's directory and reserves the real lab, with nothing going
# red. So fingerprint that directory before any case runs and compare it afterwards. Contents and
# not merely names, because the hazard includes a lock file that is ALREADY there: taking a lock
# rewrites its holder line, which a listing of names would not show.
REAL_LOCK_DIR="$HOME/.local/state/wake-lab"
lock_dir_state() { # lock_dir_state <dir> -- a printable fingerprint of what that directory holds
  [ -d "$1" ] || { printf '(absent)\n'; return 0; }
  ( cd "$1" && ls -A 2>/dev/null | sort | while IFS= read -r f; do
      if [ -f "$f" ]; then printf '%s %s\n' "$f" "$(cksum <"$f" 2>/dev/null)"
      else printf '%s (not a regular file)\n' "$f"; fi
    done )
}
REAL_LOCK_BEFORE=$(lock_dir_state "$REAL_LOCK_DIR")

pass=0; fail=0; skipped=0
ok() { pass=$((pass + 1)); echo "PASS: $*"; }
ko() { fail=$((fail + 1)); echo "FAIL: $*"; }
# A case that cannot run here says so on its own line, and is counted in the summary. The
# cross-repository lock case below needs the ocannl-staging checkout, which CI does not have and
# never will -- and a check that is absent is indistinguishable from a check that passed unless
# the run says which. So an all-green run states what it did not look at.
skip() { skipped=$((skipped + 1)); printf 'SKIP: %s\n' "$*"; }
# expect <label> <want-rc> <want-substring> -- <cmd...>; leaves the output in $out.
expect() {
  local label="$1" want_rc="$2" want="$3"; shift 3; [ "$1" = -- ] && shift
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq "$want_rc" ] && grep -q -- "$want" <<<"$out"; then ok "$label"
  else ko "$label (rc=$rc want $want_rc; want /$want/) -- $out"; fi
}

# lock_holders <diff> -- the holder line of each lock file the diff names, one per line.
# The diff says a file is new or changed but not by whom, and the two readings of that call for
# opposite responses: a case that escaped WAKE_LAB_LOCK_DIR is a bug in this suite to fix, while
# a genuine cross-machine sweep that reserved a box mid-run is the lab working correctly and the
# suite merely watching. wake-lab's `lab_lock_take_fd` already writes WHO took the lock on its
# first line -- `wake-lab <what> (pid <n>, since <utc>)` -- so print that beside the diff and
# reading it stops being a manual `cat` after the fact. The suite's own pid goes in the message
# for the comparison: its cases run as its children, so a holder pid near it and gone is this
# suite escaping, while a stranger's is the sweep. Only the files the diff names, so a busy lab
# does not bury the diff. Control characters go, and a missing or empty line degrades rather than
# failing, both as `lock_holder` does -- this text goes to a terminal, and a lock a sweep is
# mid-write on has no first line yet.
lock_holders() {
  sed -n 's/^> \([^ ][^ ]*\).*/\1/p' <<<"$1" | sort -u | while IFS= read -r f; do
    local line; line=$(head -1 "$REAL_LOCK_DIR/$f" 2>/dev/null | tr -d '\000-\037')
    printf '\n  %s: %s' "$f" "${line:-(no holder line)}"
  done
}

# lab_untouched <region> -- the real lab's lock directory is exactly as the suite found it.
# Called after the cases that reserve and again at the end, so a failure names a region rather
# than the whole file.
lab_untouched() {
  local now; now=$(lock_dir_state "$REAL_LOCK_DIR")
  if [ "$now" = "$REAL_LOCK_BEFORE" ]; then
    ok "the real lab's lock directory is untouched ($1)"
  else
    local d; d=$(diff <(printf '%s\n' "$REAL_LOCK_BEFORE") <(printf '%s\n' "$now") | sed -n '1,10p')
    ko "$1 reached $REAL_LOCK_DIR: a case escaped WAKE_LAB_LOCK_DIR and reserved the real lab \
(this suite is pid $$) -- $d$(lock_holders "$d")"
  fi
}

# --- the hermeticity control is itself controlled -----------------------------------------------
# A fingerprint that cannot notice anything would pass with the export deleted, and then the two
# `lab_untouched` calls below would be decoration. Prove it notices both shapes of the hazard --
# a lock file that was not there before, and a lock file that was there and has been taken since
# (same name, rewritten holder line) -- and that it tells a missing directory from an empty one,
# which is the shape of a suite that creates the directory on a machine that had none.
probe="$TMP/lockprobe"; mkdir -p "$probe"; printf 'wake-lab restart (pid 1)\n' > "$probe/rog.lock"
probe_before=$(lock_dir_state "$probe")
printf 'wake-lab restart (pid 2)\n' > "$probe/rog.lock"
[ "$(lock_dir_state "$probe")" != "$probe_before" ] \
  && ok "the lock-directory fingerprint notices a lock that has been retaken" \
  || ko "the fingerprint cannot see a rewritten holder line, so lab_untouched proves nothing"
printf 'wake-lab restart (pid 1)\n' > "$probe/rog.lock"      # back to the fingerprinted content
[ "$(lock_dir_state "$probe")" = "$probe_before" ] \
  && ok "...and is stable when nothing has changed" \
  || ko "the fingerprint differs from itself over an unchanged directory: it would cry wolf"
: > "$probe/minix.lock"
[ "$(lock_dir_state "$probe")" != "$probe_before" ] \
  && ok "...and notices a lock file that was not there before" \
  || ko "the fingerprint cannot see a new lock file, so lab_untouched proves nothing"
[ "$(lock_dir_state "$TMP/never-created")" = "(absent)" ] && [ "$(lock_dir_state "$probe")" != "(absent)" ] \
  && ok "...and tells a directory that does not exist from one that does" \
  || ko "the fingerprint cannot tell a missing lock directory from a present one"

# And that the directory it watches is the one wake-lab.sh would fall back to: a guard aimed at
# some other path is vacuous however sharp its fingerprint. `lock-path` only prints, so asking
# with the variable unset creates nothing.
out=$(env -u WAKE_LAB_LOCK_DIR WAKE_LAB_HOSTS="$TMP/absent.sh" "$WL" lock-path minix 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$REAL_LOCK_DIR/minix.lock" ] \
  && ok "the guarded directory is the one wake-lab falls back to with no WAKE_LAB_LOCK_DIR" \
  || ko "wake-lab's default lock path is not under $REAL_LOCK_DIR (rc=$rc) -- $out; the guard watches the wrong directory"

# --- shims ------------------------------------------------------------------------------------
# curl: logs the SOAP action and the MACs it was asked about to $CURL_LOG, and answers with
# whatever $CURL_REPLY names -- `fault`, a link state, or an empty host table.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
body=""; prev=""
for a in "$@"; do case "$prev" in -d) body="$a" ;; esac; prev="$a"; done
printf '%s\n' "$body" >> "$CURL_LOG"
case "${CURL_REPLY:-active}" in
  fault) echo '<s:Envelope><s:Body><s:Fault><detail><errorDescription>NoSuchEntryInArray</errorDescription></detail></s:Fault></s:Body></s:Envelope>' ;;
  hosts) echo '<NewHostNumberOfEntries>0</NewHostNumberOfEntries>' ;;
  *)     echo '<NewActive>1</NewActive>' ;;
esac
EOF
# python3: the magic-packet sender. Logs the MAC it was handed instead of opening a socket.
cat > "$TMP/bin/python3" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null            # the inline program, read from stdin as `python3 - <mac> <bcast>`
printf 'magic %s\n' "${2:-}" >> "$CURL_LOG"
EOF
# ssh: logs `<destination> :: <command>` and answers according to $SSH_UP, a space-separated list
# of destinations that are reachable -- unset, every box is down, which is what most of the cases
# below want. $SSH_DELAY makes each probe slow, the way a real ConnectTimeout against a dark box
# is, which is what the polling deadlines have to survive. $SSH_DOWN_AFTER (with $SSH_DOWN_LIST
# naming a scratch file) makes a destination go unreachable partway through a run. $SSH_REFUSE
# names a command substring
# that fails even on a reachable destination: a Windows host that answers ssh but whose
# `wsl.exe --shutdown` fails, say. $SSH_HANG is an extended regex over the whole `<dest> :: <cmd>`
# line, and a match WEDGES instead of answering -- the 2026-09-16 shape, where the far side
# accepts the connection and the remote command never returns, which ConnectTimeout does not bound
# and only the script's own cap can end. A regex rather than a substring because the cases below
# need to wedge one box's Windows aliases while leaving its guest and its neighbour answering. It
# is an `exec sleep`, not a `sleep`, so that the cap's SIGALRM lands on the sleeping process itself
# rather than on a shell waiting for a foreground child.
# Commands that have OUTPUT the script reads, and only a reachable destination produces it:
# $SSH_TASKLIST is what `tasklist` prints, $SSH_REG is what `reg query` prints, and
# $SSH_WSL_STOPPED makes `wsl.exe --list --running` report no running distribution.
#
# The HOLDER is modelled as two processes, and that is the whole point of this shim since
# ludics-lite#192. A real hold has a local ssh client and a remote process tree, the channel
# between them is the only thing that connects the two, and the defect was that killing the client
# did NOT end the tree: Windows sshd exits without reaping its children, and a holder that never
# reads its stdin never learns the channel is gone. A shim that answered the holder command in one
# process could not express that -- killing it ended everything -- which is exactly why the suite
# passed while both boxes leaked a tree per lane.
#
# So: the shim `ssh` is the CLIENT. It starts $SSH_REMOTE_HOLDER as a separate process whose stdin
# is a fifo of its own (the channel), pumps its own stdin into that fifo, and then does nothing but
# wait for the remote -- the way a real ssh exits when its remote command does. The client's TERM
# trap kills the PUMP and never the remote, because a real client has no reach into the remote tree
# either; the remote then sees EOF and ends itself, which is the contract the new holder is built
# on. $SSH_REMOTE_LEAKS=1 makes the remote ignore that EOF and keep running, which is Windows as
# measured on 2026-09-17, and is how the cases below get a leak to detect. $SSH_HOLD_LIFE makes the
# remote exit on its own after N seconds -- a holder that DIES under the lane, which is a different
# fault from one that outlives it.
cat > "$TMP/bin/ssh" <<'EOF'
#!/usr/bin/env bash
dest=""; cmd=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift ;;
    -*) ;;
    *) if [ -z "$dest" ]; then dest="$1"; else cmd="$cmd $1"; fi ;;
  esac
  shift
done
line=$(printf '%s ::%s' "$dest" "$cmd")
printf '%s\n' "$line" >> "$SSH_LOG"
# $LOCK_PROBE names a lock file to test AT THE MOMENT each remote command is issued, which is the
# only way to observe from outside whether a reservation really spans what it claims to. A
# restarter that merely probed the lock leaves it free by the time the shutdown lands; a power
# phase that releases at `power_action` leaves it free by the time the confirmation polls. Both
# read as HELD if the reservation is right and FREE if it is not, and neither is visible from
# inside the script.
if [ -n "${LOCK_PROBE:-}" ]; then
  if perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' \
       <"$LOCK_PROBE" 2>/dev/null
  then printf 'lock FREE during%s\n' "$cmd" >> "$SSH_LOG"
  else printf 'lock HELD during%s\n' "$cmd" >> "$SSH_LOG"; fi
fi
[ -n "${SSH_DELAY:-}" ] && sleep "$SSH_DELAY"
[ -n "${SSH_HANG:-}" ] && grep -qE "$SSH_HANG" <<<"$line" && exec sleep 900
# $SSH_PARTIAL is the nastier half of a wedge: the far side answers, gets part of its output out,
# and THEN stops -- so the cap fires over a command substitution that is holding real bytes. A
# truncated `wsl --list` carries no "Ubuntu" and a truncated `ps` carries no process row, so both
# read as good news to anything that looks at the output before the status.
# $SSH_DROP is the same shape with a different ending: the connection breaks after the header,
# and ssh reports its own 255 rather than the remote command's status.
if [ -n "${SSH_DROP:-}" ] && grep -qE "$SSH_DROP" <<<"$line"; then
  case "$cmd" in
    *"--list --running"*) printf 'Windows Subsystem for Linux Distri' | perl -pe 's/(.)/$1\0/g' ;;
    *) printf '  PID COMMAND\n' ;;
  esac
  exit 255
fi
if [ -n "${SSH_PARTIAL:-}" ] && grep -qE "$SSH_PARTIAL" <<<"$line"; then
  case "$cmd" in
    *"--list --running"*) printf 'Windows Subsystem for Linux Distri' | perl -pe 's/(.)/$1\0/g' ;;
    *) printf '  PID COMMAND\n' ;;
  esac
  exec sleep 900
fi
# $SSH_DOWN_AFTER is "<regex>|<dest>": once a line matching the regex has been handled, that
# destination is unreachable for every later command -- an alias that dies mid-run, which is how a
# cleanup ends up on an endpoint the start went out on and nothing answers any more.
down_list=${SSH_DOWN_LIST:-/dev/null}
[ -s "$down_list" ] && grep -qx "$dest" "$down_list" && exit 1
if [ -n "${SSH_DOWN_AFTER:-}" ]; then
  case "$SSH_DOWN_AFTER" in *"|"*)
    grep -qE "${SSH_DOWN_AFTER%%|*}" <<<"$line" && printf '%s\n' "${SSH_DOWN_AFTER##*|}" >> "$down_list" ;;
  esac
fi
case "$cmd" in *"${SSH_REFUSE:-}"*) [ -n "${SSH_REFUSE:-}" ] && exit 1 ;; esac
up=1
for u in ${SSH_UP:-}; do [ "$u" = "$dest" ] && up=0; done
if [ "$up" = 0 ]; then
  case "$cmd" in
    # cmd.exe's echo prints everything up to the `&` verbatim, a blank before it included, so the
    # marker line is that text; $SSH_POWER_MARKER replaces it to hand the script another line.
    *WAKE_LAB_POWER_STARTED*)
      marker=${cmd#*echo }; marker=${marker%%&*}
      printf '%s\r\n' "${SSH_POWER_MARKER-$marker}"
      [ "${SSH_POWER_FAIL:-0}" = 1 ] && { echo 'Power request denied' >&2; exit 2; }
      [ "${SSH_POWER_DROP_AFTER_MARKER:-0}" = 1 ] && exit 255 ;;
  esac
  case "$cmd" in
    *tasklist*)          printf '%s\n' "${SSH_TASKLIST:-}" ;;
    *"reg query"*)       printf '%s\n' "${SSH_REG:-}" ;;
    # wsl.exe writes UTF-16LE, which is why this is piped through perl rather than printf'd: the
    # NUL-interleaved bytes are what the script's `tr -d` has to survive, and a shim that answered
    # in plain ASCII would pass a probe that cannot read a word the real one says.
    *"--list --running"*)
      if [ "${SSH_WSL_STOPPED:-0}" = 1 ]; then
        printf 'There are no running distributions.\r\n' | perl -pe 's/(.)/$1\0/g'
      else
        printf 'Windows Subsystem for Linux Distributions:\r\nUbuntu (Default)\r\n' \
          | perl -pe 's/(.)/$1\0/g'
      fi ;;
    # `ps` inside the guest, asked about one pid. The header is printed whether or not that pid
    # exists, because the real one does: it is how the script tells "no such process" from "no
    # answer at all", and a shim that printed nothing for a dead pid would let silence pass as
    # evidence.
    *"-e ps -eo pid -o args"*)
      # The guest's process list. Every remote holder records itself as guest.<pid> and clears that
      # on the way out, so the directory IS the list -- and the header is printed either way,
      # because the real one is: it is how the script tells "no such process" from "no answer".
      printf '  PID COMMAND\n'
      for g in "$SSH_HOLD_DIR"/guest.*; do
        [ -e "$g" ] || continue
        printf '%s %s\n' "${g##*.}" "$(cat "$g")"
      done ;;
    # ...and ending that guest process, which is what `unhold` falls back to. It goes by the
    # holder's command shape and not by pid, so that the match and the signal are one operation in
    # the guest: the shim reads the same guest.<pid> files, which record that shape.
    *"-e pkill -x -f "*)
      pat=${cmd##* }
      for g in "$SSH_HOLD_DIR"/guest.*; do
        [ -e "$g" ] || continue
        [ "$(cat "$g" | tr ' ' '.')" = "$pat" ] && kill "${g##*.}" 2>/dev/null
      done ;;
    *"-e sh -s "*)
      # The client. It owns the channel and the pump, and NOT the remote.
      chan="$SSH_HOLD_DIR/chan.$$"
      mkfifo "$chan" 2>/dev/null
      # `9>&- 8>&-`: the remote runs on ANOTHER MACHINE, so it cannot be holding this one's lab
      # locks. Here it is a local child of the client and would inherit them -- and the hold lock
      # rides fd 9 into the client deliberately, so a remote that kept a copy would hold that box
      # locked for as long as it ran, which for the leak cases is forever. That is a property of
      # the shim, not of the design, and it would make a release unable to take a lock the real one
      # would find free.
      "$SSH_REMOTE_HOLDER" "${cmd##* }" "$chan" 9>&- 8>&- & remote=$!
      # A pump and not an `exec`: the client has to outlive its own stdin copy so that it can be
      # signalled, and killing the pump is the only way a client can close the channel.
      # `<&0` is not redundant. bash redirects an ASYNCHRONOUS command's stdin from /dev/null
      # unless it is explicitly redirected, so a bare `cat > "$chan" &` pumps /dev/null: the
      # channel reaches EOF the instant it opens, the remote holder ends immediately, and the whole
      # suite reads as "the holder died the moment it started" with nothing wrong in the script.
      cat <&0 > "$chan" 9>&- 8>&- & pump=$!
      # The trap kills the PUMP alone. Killing the remote here would be the shim doing what
      # Windows sshd does not, and every case below that asks whether the tree ended would be
      # asking the shim instead of the script.
      trap 'printf "HOLDER-TERMED %s\n" "$$" >> "$SSH_LOG"; kill "$pump" 2>/dev/null; rm -f "$chan"; exit 143' TERM
      wait "$remote"
      kill "$pump" 2>/dev/null; rm -f "$chan" ;;
    # The holder every version before 2026-09-19 spawned, kept so that the cases about meeting one
    # can spawn a real one. It does not read its stdin, so nothing but a signal ends it -- which is
    # the defect, expressed as a shim.
    *"sleep infinity"*)  trap 'printf "HOLDER-TERMED %s\n" "$$" >> "$SSH_LOG"; kill -KILL $(jobs -p) 2>/dev/null; exit 143' TERM
                         sleep 86400 & wait ;;
  esac
fi
exit "$up"
EOF
# The remote holder: the guest shell `wsl.exe -d Ubuntu -e sh -s <token>` starts inside the VM.
# It is a separate process from the client on purpose (see the shim's own note) and nothing the
# client does can reach it -- it ends because its CHANNEL ended, which is the contract the holder
# is built on, or it does not end, which is ludics-lite#192.
cat > "$TMP/remote-holder.sh" <<'EOF'
#!/usr/bin/env bash
tok=$1; chan=$2
guest="$SSH_HOLD_DIR/guest.$$"
# What `ps -o args` in the guest would show. The token is in its argv on every side of the channel,
# which is the whole of the lane identity: without it every wsl.exe on that box looks alike.
printf 'sh -s %s\n' "$tok" > "$guest"
trap 'rm -f "$guest"; printf "HOLDER-KILLED %s\n" "$$" >> "$SSH_LOG"; exit 143' TERM
# A holder that ignores even a kill by pid: the leak nothing short of a restart-wsl can clear.
[ "${SSH_REMOTE_LEAKS:-0}" = 2 ] && trap '' TERM
# A holder that DIES under the lane, on demand -- the other fault, and not this one.
if [ "${SSH_HOLD_LIFE:-0}" != 0 ]; then
  ( sleep "$SSH_HOLD_LIFE"; kill -TERM "$$" 2>/dev/null ) &
fi
# `sh -s` reads its script off stdin and exits at EOF. The handshake is the only command it is ever
# sent: `echo $1 $$ <nonce>`, which the guest shell expands to its token, its own pid, and the
# nonce that call just made up -- so the reply cannot be an older reply, and cannot come from a
# holder that does not have our token.
while IFS= read -r line; do
  case "$line" in
    # SSH_HOLD_ANSWERS=0 is a guest shell that is running and says nothing back -- a hold that
    # fails on its observation rather than on its connection. The mute FILE is the same thing for a
    # holder that is already running: its environment was fixed when it was spawned, so a case that
    # needs a live holder to go quiet partway through -- a reuse whose handshake fails -- has to be
    # able to say so from outside it.
    echo*) [ "${SSH_HOLD_ANSWERS:-1}" = 0 ] && continue
           [ -e "$SSH_HOLD_DIR/mute" ] && continue
           set -- $line; printf '%s %s %s\n' "$tok" "$$" "$4" ;;
  esac
done < "$chan"
# EOF: the channel is gone. A real `sh` exits here.
if [ "${SSH_REMOTE_LEAKS:-0}" != 0 ]; then
  printf 'HOLDER-LEAKED %s\n' "$$" >> "$SSH_LOG"
  while :; do sleep 1; done
fi
printf 'HOLDER-EOF %s\n' "$$" >> "$SSH_LOG"
rm -f "$guest"
EOF
chmod +x "$TMP/remote-holder.sh"
chmod +x "$TMP/bin/curl" "$TMP/bin/python3" "$TMP/bin/ssh"
PATH="$TMP/bin:$PATH"; export PATH
CURL_LOG="$TMP/curl.log"; export CURL_LOG
SSH_LOG="$TMP/ssh.log"; export SSH_LOG
SSH_DOWN_LIST="$TMP/ssh-down.list"; export SSH_DOWN_LIST
SSH_REMOTE_HOLDER="$TMP/remote-holder.sh"; export SSH_REMOTE_HOLDER
SSH_HOLD_DIR="$TMP/holders"; export SSH_HOLD_DIR
mkdir -p "$SSH_HOLD_DIR"
# Holders no longer expire on their own -- that is the point of them -- so the suite has to end the
# ones its cases leave behind, or they outlive the run. Every remote holder records itself as
# guest.<pid> and clears it on the way out, so the file list IS the list of what is still running.
# SIGKILL because one of the cases deliberately runs a holder that ignores TERM.
kill_stub_holders() {
  local g
  for g in "$SSH_HOLD_DIR"/guest.*; do
    [ -e "$g" ] || continue
    kill -KILL "${g##*.}" 2>/dev/null
    rm -f "$g"
  done
}
# Every run in this suite gets a scratch lab-lock directory, exported once here rather than passed
# case by case. A case that forgot it would take the REAL lock under ~/.local/state/wake-lab --
# and a `--hold` case leaves a holder carrying that lock, which would then refuse every later
# restart in the suite and, worse, on the machine running it. Cases that need their own lock
# directory (the lab-lock block below) override it.
WAKE_LAB_LOCK_DIR="$TMP/labtest-locks"; export WAKE_LAB_LOCK_DIR
mkdir -p "$WAKE_LAB_LOCK_DIR"
: > "$CURL_LOG"; : > "$SSH_LOG"

# A host table with obviously fake addresses, in the shape the example file documents.
cat > "$TMP/hosts.sh" <<'EOF'
mac_of() { case "$1" in
  rog)   echo aa:bb:cc:00:00:01 aa:bb:cc:00:00:02 ;;
  minix) echo aa:bb:cc:00:00:03 aa:bb:cc:00:00:04 ;;
  *) return 1 ;; esac; }
eth_mac_of() { case "$1" in
  rog)   echo aa:bb:cc:00:00:02 ;;
  minix) echo aa:bb:cc:00:00:04 ;;
  *) return 1 ;; esac; }
ip_of() { case "$1" in
  rog)   echo 10.0.0.1 ;;
  minix) echo 10.0.0.2 ;;
  *) return 1 ;; esac; }
kind_of() { case "$1" in
  rog|minix) echo wsl ;;
  *) return 1 ;; esac; }
EOF

# --- the site file is required, and is the only source of hardware addresses -------------------
: > "$CURL_LOG"
expect "a missing host table refuses, naming the path it looked at" 1 "no host table at $TMP/absent.sh" -- \
  env WAKE_LAB_HOSTS="$TMP/absent.sh" "$WL" status rog
grep -q 'wake-lab-hosts.example.sh' <<<"$out" \
  && ok "...and points at the template" || ko "the refusal does not name the template -- $out"
[ ! -s "$CURL_LOG" ] && ok "...before it talks to the router" || ko "it reached the router without a host table: $(cat "$CURL_LOG")"

printf 'mac_of() { echo aa:bb:cc:00:00:01; }\n' > "$TMP/partial.sh"
expect "a host table missing eth_mac_of refuses, naming the function" 1 "defines no eth_mac_of" -- \
  env WAKE_LAB_HOSTS="$TMP/partial.sh" "$WL" status rog
printf 'mac_of() { echo x; }\neth_mac_of() { echo x; }\n' > "$TMP/no-ip.sh"
expect "...and so does one missing ip_of" 1 "defines no ip_of" -- \
  env WAKE_LAB_HOSTS="$TMP/no-ip.sh" "$WL" status rog
sed '/^kind_of()/,$d' "$TMP/hosts.sh" > "$TMP/no-kind.sh"
expect "...and one missing kind_of" 1 "defines no kind_of" -- \
  env WAKE_LAB_HOSTS="$TMP/no-kind.sh" "$WL" status rog
printf 'mac_of() { case in esac; }\n' > "$TMP/broken.sh"
expect "a host table that will not parse refuses too" 1 "wake-lab.sh:" -- \
  env WAKE_LAB_HOSTS="$TMP/broken.sh" "$WL" status rog

: > "$CURL_LOG"
expect "the wake path sends both of the site file's MACs" 0 "aa:bb:cc:00:00:02" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" rog
grep -q 'aa:bb:cc:00:00:01' <<<"$out" \
  && ok "...including the Wi-Fi one" || ko "the first MAC never reached the router -- $out"
grep -q 'WakeOnLANByMACAddress' "$CURL_LOG" \
  && ok "...through the router's WoL action" || ko "no WoL SOAP call: $(cat "$CURL_LOG")"
grep -q '^magic aa:bb:cc:00:00:02$' "$CURL_LOG" \
  && ok "...and as a direct magic packet" || ko "no direct packet for the Ethernet MAC: $(cat "$CURL_LOG")"

: > "$CURL_LOG"
expect "status asks the router about the site file's Ethernet MAC alone" 0 "rog    router-active=1" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" status rog
grep -q 'aa:bb:cc:00:00:02' "$CURL_LOG" && ! grep -q 'aa:bb:cc:00:00:01' "$CURL_LOG" \
  && ok "...not about the Wi-Fi one" || ko "router_active used the wrong MAC: $(cat "$CURL_LOG")"
# The column is named for what it reads, the router's NewActive bit, and never for the NIC's link
# state: `eth-link=1` minutes after a shutdown was read as physical link when it was a stale DHCP
# lease (ludics-lite#56). The footer is where a reader of the table learns that, and that behind
# the LAN switch (2026-10-12) neither value says whether a powered-off NIC is WoL-armed.
grep -q "NewActive bit for the Ethernet MAC, not the NIC's link state" <<<"$out" \
  && ok "...and says the column is the router's NewActive bit, not link state" \
  || ko "status does not say what router-active reads -- $out"
grep -q 'stale DHCP lease' <<<"$out" && grep -q 'neither value says whether the NIC is WoL-armed' <<<"$out" \
  && ok "...warning of a stale lease, and that the bit says nothing about WoL readiness" \
  || ko "status does not carry the stale-lease and WoL-readiness caveat -- $out"
grep -qE 'eth-link|(^|[^-])link=' <<<"$out" \
  && ko "the old link column name resurfaced in status -- $out" \
  || ok "...and nothing in the table is still called link"

# A target the table does not answer for refuses the whole run, before any packet: the boxes it
# DOES know must not be woken while a later target turns out to be missing, and the dispatch loop's
# exit status would have reported that partial operation as a success.
: > "$CURL_LOG"
expect "a box the site file does not know refuses the run" 1 "not in the host table" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" nosuch
expect "...naming every missing target, with a known one alongside" 1 "nosuch alsomissing" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" rog nosuch alsomissing
[ ! -s "$CURL_LOG" ] && ok "...before waking the box it does know" \
  || ko "a partial wake went out before the refusal: $(cat "$CURL_LOG")"

# --- the WSL kick reaches the Windows side by whichever alias answers ---------------------------
# After a cold boot the LAN alias answers within seconds and tailscaled lags a minute or more, so a
# kick that knew only the Tailscale alias failed on exactly the wake wait_for had just declared
# finished -- and the WSL poll behind it could then only time out, losing the box's backend for the
# day. `kick-wsl` also polls, so the budget is cut to a second here.
kick() { env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="$1" "$WL" kick-wsl rog; }
: > "$SSH_LOG"
out=$(kick "rog-lan rog-nv-wsl" 2>&1)
grep -q 'wsl started on rog (via rog-lan)' <<<"$out" \
  && ok "the WSL kick goes through the LAN alias when Tailscale has not caught up" \
  || ko "the kick did not use the LAN alias -- $out"
grep -q '^rog-lan :: wsl.exe' "$SSH_LOG" \
  && ok "...carrying the wsl.exe start command" || ko "no wsl.exe over rog-lan: $(cat "$SSH_LOG")"
out=$(kick "rog-nv-win rog-nv-wsl" 2>&1)
grep -q 'wsl started on rog (via rog-nv-win)' <<<"$out" \
  && ok "...and falls back to the Tailscale alias when the LAN one is silent" \
  || ko "no fallback to the Tailscale alias -- $out"
out=$(kick "" 2>&1)
grep -q 'wsl kick FAILED on rog' <<<"$out" \
  && ok "...and reports a box no endpoint answers for" || ko "a kick with nothing up did not fail -- $out"

# --- restart-wsl shuts the VM down on the Windows host before starting it ---------------------
# A VM kept alive across a host sleep/resume can carry a degraded dxg bridge that fails under the
# sweep's parallel width while every single-process probe passes (ludics-lite#60). The cure is a
# new VM, and `wsl --shutdown` belongs on the Windows side: issued inside the VM it kills the
# session issuing it. So the restart rides the same -lan/-win aliases as the kick, never -wsl.
restart() { env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="$1" "$WL" restart-wsl rog; }
: > "$SSH_LOG"
out=$(restart "rog-lan rog-nv-wsl" 2>&1)
grep -q 'wsl shut down on rog (via rog-lan)' <<<"$out" \
  && grep -q 'wsl started on rog (via rog-lan)' <<<"$out" \
  && ok "restart-wsl shuts the VM down and starts it again, over the LAN alias" \
  || ko "restart-wsl did not report a shutdown and a start -- $out"
awk '/^rog-lan :: wsl.exe --shutdown$/ { s = NR } /^rog-lan :: wsl.exe -d Ubuntu/ { t = NR } END { exit !(s && t && s < t) }' "$SSH_LOG" \
  && ok "...issuing wsl.exe --shutdown on the Windows host before the start" \
  || ko "no shutdown ahead of the start over rog-lan: $(cat "$SSH_LOG")"
grep -q '^rog-nv-wsl :: wsl.exe' "$SSH_LOG" \
  && ko "a wsl.exe command reached the -wsl guest, where a shutdown kills its own session: $(cat "$SSH_LOG")" \
  || ok "...and never through the -wsl guest"
out=$(restart "" 2>&1)
grep -q 'wsl restart FAILED on rog' <<<"$out" \
  && ok "...and reports a box no endpoint answers for as a failed restart" || ko "a restart with nothing up did not fail -- $out"
# A restart's success is the restart's own status, never the guest's liveness: when the shutdown
# fails, the -wsl guest that still answers is the OLD VM, and `wsl up` over it would send the sweep
# onto exactly the degraded bridge the restart exists to replace. Two shapes of that: no Windows
# endpoint answers while the guest does, and the endpoints answer but the shutdown itself fails.
out=$(restart "rog-nv-wsl" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl restart FAILED on: rog' <<<"$out" && ! grep -q 'wsl up' <<<"$out" \
  && ok "a restart no Windows endpoint carried is not 'wsl up' just because the old guest answers (rc=$rc)" \
  || ko "a failed restart over a live old guest read as success (rc=$rc) -- $out"
: > "$SSH_LOG"
out=$(env SSH_REFUSE=--shutdown WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-win rog-nv-wsl" "$WL" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl restart FAILED on: rog (shutdown refused' <<<"$out" && ! grep -q 'wsl up' <<<"$out" \
  && ok "...nor is one whose wsl.exe --shutdown failed on every alias that answered, and it says which phase (rc=$rc)" \
  || ko "a refused shutdown over a live old guest read as success, or did not name the phase (rc=$rc) -- $out"
grep -q 'wsl.exe -d Ubuntu' "$SSH_LOG" \
  && ko "a start was issued after the shutdown failed, onto the old VM: $(cat "$SSH_LOG")" \
  || ok "...and no start is issued onto the VM the shutdown left standing"
grep -q 'wsl restart FAILED on: rog' <<<"${out##*$'\n'}" \
  && ok "...with the failure as the last line, where the sweep routine reads its verdict" \
  || ko "the failure is not the last line -- $out"
# The kick keeps its meaning -- start if not running -- so a `--wait --wsl` on a box the user is
# working on never kills a live VM; `--restart-wsl` is the spelling that does.
: > "$SSH_LOG"; kick "rog-lan rog-nv-wsl" >/dev/null 2>&1
grep -q -- '--shutdown' "$SSH_LOG" && ko "kick-wsl issued a shutdown: $(cat "$SSH_LOG")" \
  || ok "kick-wsl never shuts a VM down"
wake_wsl() { env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-wsl" "$WL" --wait "$1" rog; }
: > "$SSH_LOG"; out=$(wake_wsl --wsl 2>&1)
grep -q 'wsl up' <<<"$out" && ! grep -q -- '--shutdown' "$SSH_LOG" \
  && ok "...and neither does --wait --wsl" || ko "--wait --wsl shut a VM down, or never started one -- $out; $(cat "$SSH_LOG")"
# ludics-lite#637: WAKE_LAB_ANCHOR's allowlist guards the one place it is spliced, a native-Linux
# box's anchor leg. An all-WSL wait asks no leg, so an anchor spelled outside it (an IPv6 literal)
# is no reason to refuse that wait; the run says the leg was not checked instead.
: > "$SSH_LOG"; out=$(env WAKE_LAB_ANCHOR=2001:db8::1 WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 \
  WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-wsl" "$WL" --wait --wsl rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q '^all up$' <<<"${out##*$'\n'}" && ! grep -q 'not a plain ssh destination' <<<"$out" \
  && grep -q '^anchor leg not checked on rog: its kind is wsl' <<<"$out" && ! grep -q '2001:db8' "$SSH_LOG" \
  && ok "an all-WSL --wait is not refused for an anchor it never asks, and says the leg was not checked (rc=$rc)" \
  || ko "an all-WSL --wait was refused for, or spliced, an anchor no leg asks (rc=$rc) -- $out; $(cat "$SSH_LOG")"
: > "$SSH_LOG"; out=$(wake_wsl --restart-wsl 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl shut down on rog (via rog-lan)' <<<"$out" && grep -q 'wsl up' <<<"$out" \
  && grep -q '^all up$' <<<"${out##*$'\n'}" && grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ok "--wait --restart-wsl shuts the VM down after the wake and starts a fresh one, ending in all up (rc=$rc)" \
  || ko "--wait --restart-wsl did not restart the VM, or did not end in all up (rc=$rc) -- $out; $(cat "$SSH_LOG")"
# The wake path's final verdict is the wake's AND the WSL step's: with the boxes up and the
# restart failed, `all up` with exit 0 would hand the sweep the old VM, so the WSL failure is the
# last line and the exit status is nonzero.
: > "$SSH_LOG"; out=$(env SSH_REFUSE=--shutdown WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-wsl" "$WL" --wait --restart-wsl rog 2>&1); rc=$?
grep -q 'wsl restart FAILED on: rog' <<<"$out" && ! grep -q 'wsl up' <<<"$out" \
  && ok "...and in the wake path too, a failed shutdown over a live old guest is never 'wsl up'" \
  || ko "the wake path reported wsl up over a VM it failed to shut down -- $out"
[ "$rc" -ne 0 ] && ! grep -q '^all up$' <<<"$out" && grep -q 'wsl restart FAILED on: rog' <<<"${out##*$'\n'}" \
  && ok "...nor 'all up': the restart failure is the wake's last line and its exit status (rc=$rc)" \
  || ko "the wake path said all up, or exited 0, over a failed restart (rc=$rc) -- $out"
# A start that fails AFTER the shutdown went through is the opposite diagnosis: there is no VM at
# all, old or new, and telling the operator the old one still answers would be wrong twice over.
: > "$SSH_LOG"
out=$(env SSH_REFUSE='-d Ubuntu' WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-win rog-nv-wsl" "$WL" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl shut down on rog (via rog-lan)' <<<"$out" \
  && grep -q 'wsl restart FAILED on: rog (shut down, then the start failed' <<<"${out##*$'\n'}" \
  && ! grep -q 'old VM' <<<"$out" \
  && ok "a start that fails after the shutdown is reported as a start failure, never as the old VM answering (rc=$rc)" \
  || ko "a failed start after a shutdown was misreported (rc=$rc) -- $out"
# The step's third failing shape: every wsl.exe command succeeded, and the fresh guest never
# answered within the poll budget. `wsl still down` is a backend the sweep cannot test, so it is a
# failure of the step, from the verb's exit status and from the wake path's final verdict alike.
: > "$SSH_LOG"; out=$(restart "rog-lan rog-nv-win" 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q 'wsl up' <<<"$out" && grep -q 'wsl still down after 0 min on: rog' <<<"${out##*$'\n'}" \
  && ok "a restarted guest that never answers is a failed restart-wsl, its last line saying so (rc=$rc)" \
  || ko "a guest that never answered read as a successful restart (rc=$rc) -- $out"
grep -q '^rog-lan :: wsl.exe -d Ubuntu' "$SSH_LOG" && ok "...after the start really was issued" \
  || ko "the start was never issued, so the case pins nothing: $(cat "$SSH_LOG")"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-win" "$WL" --wait --restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q '^all up$' <<<"$out" && grep -q 'NOT all up: wsl still down after 0 min on: rog' <<<"${out##*$'\n'}" \
  && ok "...and the wake path over it is NOT all up, exit nonzero, with the poll timeout as its last line (rc=$rc)" \
  || ko "the wake path said all up, or exited 0, over a guest that never answered (rc=$rc) -- $out"
# The poll's verdict is aggregate; the report is per box. With two boxes started and one guest
# late, only that one is still down -- the other is up and its backend is testable today.
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan minix-lan rog-nv-wsl" "$WL" restart-wsl rog minix 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q '^wsl up on: rog$' <<<"$out" && grep -q 'wsl still down after 0 min on: minix$' <<<"${out##*$'\n'}" \
  && ok "one late guest is reported alone, and its neighbour as up (rc=$rc)" \
  || ko "the poll's aggregate failure was pinned on every started box (rc=$rc) -- $out"
# ludics-lite#445: the restart is a destroyer, so it refuses a box an outstanding exclusive
# measurement names (on any endpoint of its row), reading the registry only once it holds the box's
# lab locks; `--as` spares the caller's own, `--force` skips the check, and an unreadable registry
# refuses. The refusal is a phase of its own, and nothing reaches the measured box's Windows host.
measured='[{"request_id":"m-445","request":{"execution_host":"rog-nv-wsl","kind":"measurement"},"state":"running"}]'
FW_LOG="$TMP/fw.log"; export FW_LOG
: > "$SSH_LOG"; : > "$FW_LOG"
out=$(env FW_LISTING="$measured" FW_LOCKCHECK=rog WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
  SSH_UP="rog-lan minix-lan rog-nv-wsl minix-amd-wsl" "$WL" restart-wsl rog minix 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'measurement: m-445 (running)' <<<"$out" \
  && grep -q 'wsl restart REFUSED on rog: an exclusive measurement reservation names it' <<<"$out" \
  && grep -q '^wsl restart REFUSED on: rog (an exclusive measurement holds the box' <<<"$out" \
  && grep -q '^wsl up on: minix$' <<<"$out" \
  && ok "restart-wsl refuses the measured box and restarts its unmeasured neighbour (rc=$rc)" \
  || ko "restart-wsl took a measured box, or its neighbour with it (rc=$rc) -- $out"
grep -q '^rog-' "$SSH_LOG" && ko "a command reached the measured box: $(grep '^rog-' "$SSH_LOG")" \
  || ok "...and nothing reaches the measured box"
grep -q '^minix-lan :: wsl.exe --shutdown$' "$SSH_LOG" && ok "...while its neighbour's VM is restarted" \
  || ko "the neighbour was not restarted: $(cat "$SSH_LOG")"
grep -qx 'registry read with lane=held' "$FW_LOG" && ! grep -q 'lane=free' "$FW_LOG" \
  && ok "...having read the registry while it held the box's lane lock" \
  || ko "the registry was read with rog's lane lock free: $(cat "$FW_LOG")"
for f in rog.lock rog.hold.lock; do
  perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <"$WAKE_LAB_LOCK_DIR/$f" \
    && ok "...and the measured box's $f is free again" || ko "a refused restart kept rog's $f"
done
: > "$SSH_LOG"
out=$(env FW_LISTING="$measured" WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_WSL_WAIT_SECONDS=1 \
  SSH_UP="rog-lan rog-nv-wsl" "$WL" --wait --restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q '^NOT all up: wsl restart REFUSED on: rog (an exclusive measurement' <<<"${out##*$'\n'}" \
  && ! grep -q -- '--shutdown' "$SSH_LOG" \
  && ok "--wait --restart-wsl refuses it as well, its last line saying so (rc=$rc)" \
  || ko "--wait --restart-wsl over a measured box (rc=$rc) -- $out; $(cat "$SSH_LOG")"
: > "$SSH_LOG"
out=$(env FW_LISTING="$measured" WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
  SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl --as=m-445 rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ok "--as=<its request_id> lets the measurement's owner restart its guest (rc=$rc)" \
  || ko "--as did not spare the caller's own measurement (rc=$rc) -- $out"
: > "$SSH_LOG"
out=$(env FW_LISTING='[{"request_id":"c-445","request":{"execution_host":"rog-nv-linux","kind":"correctness"},"state":"running"}]' \
  WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ok "a correctness reservation does not refuse the restart (rc=$rc)" \
  || ko "a correctness reservation refused the restart (rc=$rc) -- $out"
: > "$SSH_LOG"
out=$(env FW_RC=4 WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q "wsl restart REFUSED on rog: the fleet's execution registry could not be read" <<<"$out" \
  && ! grep -q -- '--shutdown' "$SSH_LOG" \
  && ok "an unreadable registry refuses the restart (rc=$rc)" \
  || ko "the restart went ahead over an unreadable registry (rc=$rc) -- $out"
: > "$SSH_LOG"
out=$(env FW_LISTING="$measured" WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
  SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl --force rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ok "--force restarts a measured box anyway (rc=$rc)" || ko "--force was refused (rc=$rc) -- $out"
# The kick path holds the same line: a kick no Windows endpoint carried is a failed kick, whatever
# the guest answers, so `wsl up` there is the kick's own success and not the poll's.
out=$(kick "rog-nv-wsl" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl kick FAILED on: rog' <<<"$out" && ! grep -q 'wsl up' <<<"$out" \
  && ok "kick-wsl reports its own failure over a live guest as well (rc=$rc)" \
  || ko "a failed kick over a live guest read as success (rc=$rc) -- $out"

# --- --hold: the VM is kept alive by a wsl.exe on the WINDOWS side, by nothing else --------------
# A kick returns at once and the VM then shuts down under whatever runs inside it: the 2026-09-15
# sweep's hip unit died 76 s into an unheld VM that had powered off 18 s after its kick
# (ludics-lite#155). An ssh session INSIDE the guest does not hold it, so the holder is a
# Windows-side `wsl.exe -d Ubuntu -e sh -s <token>`, and the VM counts as up only once that holder
# has SAID ITS TOKEN BACK from inside the guest -- a holder that failed to start is the exact state
# the flag exists to rule out, and counting wsl.exe in `tasklist`, which is what this observed
# until 2026-09-19, was true of the owner's console shell too (ludics-lite#184 (a)).
# A holder carries its box's lab lock for as long as it lives (that is the point: another
# session's restart is then refused rather than destroying the lane). In this suite that means a
# case which leaves a holder running would refuse every later case on that box, so each case that
# does not continue from a previous holder starts from a clean state AND a free lock. Unlinking
# the lock file is enough: the flock belongs to the inode, so the next take creates a new one.
reset_hold_state() {
  local rec
  # The recorded LOCAL processes go too, and by record rather than by pattern: a holder's sidecar
  # carries its box's hold lock for as long as it lives, so one left running by a case refuses
  # every reservation in the cases after it -- which reads as a restart being refused by a lock
  # nobody took, in a block that has nothing to do with holds. Fields 1 and 4 are the client and
  # its sidecar. By record and not by a scan of the process table, because that table is shared
  # with whatever else runs on this machine, including another copy of this suite.
  # Each field is checked for being a real pid before it is signalled, and `0` is the reason why:
  # a legacy record carries `0` in the sidecar field, and `kill 0` signals the caller's whole
  # PROCESS GROUP -- which is this suite. It killed the run outright, silently, three cases later
  # than the record that caused it.
  local p sc
  for rec in "$TMP/state"/hold-*.pid; do
    [ -e "$rec" ] || continue
    p=$(awk '{ print $1 }' "$rec"); sc=$(awk '{ print $4 }' "$rec")
    case "$p" in ''|0|*[!0-9]*) ;; *) kill "$p" 2>/dev/null ;; esac
    case "$sc" in ''|0|*[!0-9]*) ;; *) kill "$sc" 2>/dev/null ;; esac
  done
  kill_stub_holders
  rm -rf "$TMP/state"
  rm -f "$WAKE_LAB_LOCK_DIR"/*.lock
}

held_kick() { # held_kick <ssh-up> <answers?> [reg output] [holder lifetime] -- kick-wsl --hold rog
  # The default lifetime is 0, which here means "does not expire": the holder ends when its channel
  # does and at no other time, so a case that wants one dying under the lane asks for it.
  # WAKE_LAB_HOLD_WAIT_SECONDS is the handshake's wait and not a settle any more -- there is
  # nothing left to settle, because the token cannot come back before the holder is running.
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=3 \
      WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="$1" \
      SSH_HOLD_ANSWERS="$2" SSH_REG="${3:-}" SSH_HOLD_LIFE="${4:-0}" "$WL" kick-wsl --hold rog
}
# The release has remote work of its own now -- it asks the VM whether the guest shell is gone --
# so the box has to be reachable for an unhold to be able to observe anything. The case that wants
# an unreachable one says so.
unhold() {
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="${1:-rog-lan}" \
      "$WL" unhold rog
}
# `kill -0` alone is not a liveness test: a killed orphan whose init does not reap it promptly --
# a container's PID 1, typically -- stays a zombie and answers it, which would read as "unhold did
# not kill the holder" when it did.
alive() { # alive <pid>
  local st
  [ -n "$1" ] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  st=$(ps -o state= -p "$1" 2>/dev/null)
  case "$st" in ''|*Z*) return 1 ;; esac
  return 0
}
# What the second argument of held_kick means now. It used to be a `tasklist` reading, which was
# the observation until 2026-09-19 and which #155's acceptance run showed certifying nothing: both
# lab boxes already had a wsl.exe on the Windows side with no holder of ours running. The
# observation is the token now, so the interesting axis is whether the holder answers it.
HOLDER_ANSWERS=1        # the guest shell starts and says its token back
HOLDER_SILENT=0         # ...and here it does not, which is a hold that failed

reset_hold_state; : > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder started on rog (via rog-lan' <<<"$out" \
  && grep -q 'wsl holder observed on rog' <<<"$out" && grep -q 'wsl up' <<<"$out" \
  && ok "kick-wsl --hold spawns a Windows-side holder, observes it, and only then is the VM up (rc=$rc)" \
  || ko "kick-wsl --hold did not spawn and observe a holder (rc=$rc) -- $out"
grep -qE '^rog-lan :: wsl\.exe -d Ubuntu -e sh -s wlh-[A-Za-z0-9-]+$' "$SSH_LOG" \
  && ok "...as a shell reading the channel, over the alias that carried the kick" \
  || ko "the holder command is not a tokened sh -s over rog-lan: $(cat "$SSH_LOG")"
# Never a sized sleep: a lane is several units with their own caps plus preparation outside them,
# so a holder sized to the expected run expires under the last unit, silently (issue comment of
# 2026-09-15). A lane ends by unhold. A shell waiting for input cannot expire at all, which is a
# stronger version of the same property -- but the scan stays, because the payload is one edit away
# from being a sleep again.
grep -qE 'sleep [0-9]' "$SSH_LOG" \
  && ko "the holder was sized with a fixed sleep, which expires under the last unit: $(cat "$SSH_LOG")" \
  || ok "...never a fixed sleep N"
grep -qE '^rog-nv-wsl :: .*(sh -s|ps -o args|--list --running)' "$SSH_LOG" \
  && ko "a holder command reached the -wsl guest, where it would die with the VM it holds: $(cat "$SSH_LOG")" \
  || ok "...and never inside the guest, which would die with the VM it is meant to hold"
# The observation is the token and nothing else. `tasklist` is not merely unnecessary now, it is
# WRONG: #155's acceptance run found both lab boxes already showing a wsl.exe with no holder of
# ours running, so a hold that consulted it would still be reading a probe that cannot fail.
grep -q 'tasklist' "$SSH_LOG" \
  && ko "the hold still reads tasklist, which was true on both boxes with nothing of ours running: $(cat "$SSH_LOG")" \
  || ok "...with no tasklist reading anywhere in the hold"
grep -qE 'wsl holder observed on rog \(guest shell [0-9]+ in the VM answered its token' <<<"$out" \
  && ok "...and what the hold reports is a token that came back THROUGH the VM, with the pid that sent it" \
  || ko "the hold did not report a token answered from inside the guest -- $out"
# The token is this lane's identity, so it has to be in the record as well as in the payload: it is
# what lets a later `unhold`, in another shell, tell our holder from any other wsl.exe on that box.
rec=$(cat "$TMP/state/hold-rog.pid" 2>/dev/null)
tok=$(awk '{ print $5 }' <<<"$rec"); gpid=$(awk '{ print $6 }' <<<"$rec")
case "$rec" in
  *"wlh-"*) ok "...and the record carries the lane's token ($tok) and its guest pid ($gpid)" ;;
  *) ko "the record does not carry the lane's identity: $rec" ;;
esac
grep -q -- "$tok" "$SSH_LOG" \
  && ok "...the same token the holder was spawned with, so the record names THAT holder" \
  || ko "the recorded token is not the one in the payload: $rec; $(cat "$SSH_LOG")"
# The control that makes the case above mean something: a plain kick holds nothing.
: > "$SSH_LOG"; kick "rog-lan rog-nv-wsl" >/dev/null 2>&1
grep -q -- '-e sh -s' "$SSH_LOG" && ko "a kick without --hold spawned a holder: $(cat "$SSH_LOG")" \
  || ok "a kick without --hold spawns no holder"

# The whole point of observing: with the guest answering but NO wsl.exe on the Windows side, the
# old code's `wsl up` would hand the sweep a VM nothing holds.
reset_hold_state; : > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_SILENT" 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q 'wsl up' <<<"$out" \
  && grep -q 'wsl HOLD FAILED on: rog' <<<"${out##*$'\n'}" \
  && ok "a VM whose holder is not observed on the Windows side is never 'wsl up', and says so last (rc=$rc)" \
  || ko "an unheld VM read as up (rc=$rc) -- $out"
[ ! -f "$TMP/state/hold-rog.pid" ] \
  && ok "...and the failed holder is not left recorded for a later unhold to believe in" \
  || ko "a failed hold left a pid file behind: $(cat "$TMP/state/hold-rog.pid")"
# ...and the VM does not stay up unheld. The sweep's lanes probe the -wsl guest themselves, so a
# reachable-but-unheld guest runs a GPU unit that then dies mid-run -- the exact failure being
# fixed. A VM THIS run created is shut down again, so the unit records honest non-coverage.
reset_hold_state; : > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=1 \
 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_SILENT" "$WL" restart-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl shut down on rog (via rog-lan): a fresh VM that cannot be held' <<<"$out" \
  && awk '/^rog-lan :: wsl.exe -d Ubuntu -e true$/ { t = NR } /^rog-lan :: wsl.exe --shutdown$/ { s = NR } END { exit !(t && s && t < s) }' "$SSH_LOG" \
  && ok "a fresh VM whose hold failed is shut down again rather than left for the sweep (rc=$rc)" \
  || ko "an unheld fresh VM was left running (rc=$rc) -- $out; $(cat "$SSH_LOG")"
grep -q 'so it was shut down again: those units record no coverage' <<<"${out##*$'\n'}" \
  && ok "...and the verdict line says the VM is gone, which is what the routine reads" \
  || ko "the verdict did not report the shutdown -- $out"
# The cleanup tries every alias, not just the one the start went out on: that alias is often
# exactly what went wrong during the hold, and one endpoint going quiet must not leave a reachable
# unheld VM up. Here the LAN side dies the moment the observation runs.
reset_hold_state; : > "$SSH_LOG"; : > "$SSH_DOWN_LIST"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=1 \
 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-win" \
      SSH_HOLD_ANSWERS="$HOLDER_SILENT" SSH_DOWN_AFTER='sh -s|rog-lan' \
      "$WL" restart-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl shut down on rog (via rog-nv-win)' <<<"$out" \
  && grep -q 'so it was shut down again' <<<"${out##*$'\n'}" \
  && ok "an unheld VM is shut down over the other alias when the first one has gone quiet (rc=$rc)" \
  || ko "the cleanup gave up on one alias and left the VM up (rc=$rc) -- $out"
: > "$SSH_DOWN_LIST"

# But never a VM that was already there: on a plain kick the guest may be the owner's, and taking
# it away over a failed hold of ours would be a nasty surprise.
reset_hold_state; : > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_SILENT" 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q -- '--shutdown' "$SSH_LOG" \
  && ok "...while a plain kick-wsl --hold never shuts down a VM it did not create (rc=$rc)" \
  || ko "a failed hold shut down a VM this run did not create (rc=$rc) -- $(cat "$SSH_LOG")"
# ...and then the verdict must NOT claim a shutdown that did not happen. This is the sweep
# routine's own retry command: an operator told the VM is gone leaves a reachable unheld guest for
# the lanes to find, and its unit dies mid-run.
grep -q 'the VM is up and UNHELD and was not shut down: do not sweep that box' <<<"${out##*$'\n'}" \
  && ! grep -q 'shut down again' <<<"$out" \
  && ok "...and the verdict says the guest is still up and unheld, never that it was shut down" \
  || ko "the verdict claimed a shutdown that never happened -- $out"

# unhold ends the holder explicitly, which is the only way a lane ends.
reset_hold_state; : > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1)
hold_pid=$(cut -d' ' -f1 "$TMP/state/hold-rog.pid" 2>/dev/null)
if [ -n "$hold_pid" ] && alive "$hold_pid"; then
  ok "the holder is a live process while the lane runs (pid $hold_pid)"
else
  ko "the holder was not running after a successful hold (pid ${hold_pid:-none}) -- $out"
fi
out=$(unhold 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q "wsl holder released on rog (pid $hold_pid killed" <<<"$out" \
  && ok "...and unhold kills it, naming the pid (rc=$rc)" || ko "unhold did not release the holder (rc=$rc) -- $out"
for _ in 1 2 3 4 5; do alive "$hold_pid" || break; sleep 1; done
alive "$hold_pid" \
  && ko "unhold reported a kill the holder survived (pid $hold_pid)" \
  || ok "...and the holder really is gone"
[ ! -f "$TMP/state/hold-rog.pid" ] && ok "...leaving no pid file behind" \
  || ko "unhold left the pid file in place"

# --- the teardown: the holder ends with its CHANNEL, and unhold claims only what it observed -----
# ludics-lite#192. Windows sshd does not reap the command tree when the client is killed: its
# session process exits without taking its children, and the old holder -- a `sleep infinity` that
# never touched its stdio -- had no way to notice, so a dead channel produced no EPIPE and no exit.
# Every unhold on live hardware left one cmd.exe + two wsl.exe + a guest sleep behind, while
# saying "the VM is unheld from now on". These fixtures could not have caught it: a shim that
# answers the holder command in ONE process ends everything when it is killed. This one models the
# client and the remote separately and gives the client no reach into the remote, so what ends the
# remote here is what has to end it on the box -- EOF on a channel nobody writes to any more.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
: > "$SSH_LOG"
out=$(unhold 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q "its guest shell (pid $guest) is gone from the VM, observed over rog-lan" <<<"$out" \
  && ok "unhold observes the guest shell gone from the VM before it claims anything (rc=$rc)" \
  || ko "unhold claimed a release it did not observe (rc=$rc) -- $out"
grep -q "HOLDER-EOF $guest" "$SSH_LOG" \
  && ok "...and what ended the remote was its CHANNEL reaching EOF, not anything that reached it" \
  || ko "the remote holder did not end on EOF: $(cat "$SSH_LOG")"
# By OUR guest pid, over the alias the RECORD names. "No wsl.exe on that box" was never available
# as evidence -- on both lab boxes it was false with nothing of ours running -- so the question the
# release asks is about this lane's process and no other.
grep -q "^rog-lan :: wsl.exe -d Ubuntu -e ps -eo pid -o args$" "$SSH_LOG" \
  && ok "...asked of the VM itself, over the alias the record names" \
  || ko "the release did not ask the VM for its process list: $(cat "$SSH_LOG")"
# By TOKEN, not by the recorded pid: a hold whose handshake never answered has a token in its
# payload and no guest pid to have recorded, and that is the holder most in need of being found.
grep -q 'ps -eo pid -o args' "$SSH_LOG" && ! grep -q -- '-p [0-9]' "$SSH_LOG" \
  && ok "...for the whole list, which a holder with no recorded guest pid can still be found in" \
  || ko "the release can only ask about a pid it recorded: $(cat "$SSH_LOG")"

# ...and asking must never START the VM. `wsl.exe -e` boots a stopped distro, so a release that
# went straight to the guest would bring up the box it had just let go -- and a distro that is not
# running has already answered the question, because a guest shell cannot outlive its guest.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      SSH_WSL_STOPPED=1 "$WL" unhold rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'is gone from the VM, observed over rog-lan' <<<"$out" \
  && ok "a stopped distro answers the whole question, and the release says so (rc=$rc)" \
  || ko "a stopped distro was not read as a holder gone (rc=$rc) -- $out"
grep -q -- 'wsl.exe -d Ubuntu -e' "$SSH_LOG" \
  && ko "the release ran a command inside a stopped VM, which boots it: $(cat "$SSH_LOG")" \
  || ok "...without running anything in the guest, which would have booted the VM it just released"

# A holder that OUTLIVES its channel is the defect itself, reproduced: SSH_REMOTE_LEAKS makes the
# remote ignore EOF exactly as the Windows tree did. The release must not repeat the old sentence
# over it. It has a pid in that VM and a token to recognize it by -- which is what #184 (b) is for,
# and which is the whole difference from 2026-09-17, when the only cure on record was a
# host-global restart-wsl that destroys every other session on the box.
reset_hold_state
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
    WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
    SSH_REMOTE_LEAKS=1 "$WL" kick-wsl --hold rog >/dev/null 2>&1
guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      WAKE_LAB_HOLD_TEARDOWN_SECONDS=4 "$WL" unhold rog 2>&1); rc=$?
grep -q "guest shell (pid $guest) is STILL RUNNING in the VM" <<<"$out" \
  && ok "a holder that outlived its channel is caught rather than reported as a release" \
  || ko "a leaked holder was reported as a clean release (rc=$rc) -- $out"
[ "$rc" -eq 0 ] && grep -q 'ended: the guest shell is gone' <<<"$out" \
  && ok "...and ended by pid over the recorded alias, which the token is what makes possible (rc=$rc)" \
  || ko "the leaked holder was not ended (rc=$rc) -- $out"
ls "$SSH_HOLD_DIR"/guest.* >/dev/null 2>&1 \
  && ko "the guest shell is still running after unhold: $(cat "$SSH_HOLD_DIR"/guest.* 2>/dev/null)" \
  || ok "...leaving nothing of ours in the VM"

# ...and when even that does not end it, the box IS still pinned, and the one thing the release
# must not do is say otherwise. rc 3 and not rc 2: the lane's results are fine, the BOX is not,
# and a sweep told rc 2 would discard good work over a box it should be complaining about.
reset_hold_state
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
    WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
    SSH_REMOTE_LEAKS=2 "$WL" kick-wsl --hold rog >/dev/null 2>&1
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      WAKE_LAB_HOLD_TEARDOWN_SECONDS=4 "$WL" unhold rog 2>&1); rc=$?
[ "$rc" -eq 3 ] && grep -q 'is still pinned by a holder of ours' <<<"$out" \
  && ok "a holder that survives even the kill leaves rc 3 and says the box is still pinned (rc=$rc)" \
  || ko "a pinned box was not reported as one (rc=$rc) -- $out"
grep -q 'the VM is unheld from now on' <<<"$out" \
  && ko "the release still claims the VM is unheld while a holder of ours runs in it -- $out" \
  || ok "...and never says the VM is unheld, which is the sentence #192 was filed about"
reset_hold_state

# An unverified teardown keeps its record, and says so in its exit status. The box going quiet
# between the kill and the probe is exactly when the guest pid and token matter most: they are the
# only things that could ever end that tree short of a restart-wsl, and a release that deleted them
# while printing a warning would leave a retry with nothing to work from (review round 1, P1).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
tok=$(awk '{ print $5 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold rog 2>&1); rc=$?
[ "$rc" -eq 3 ] && grep -q 'did not answer, so this does NOT claim the VM is unheld' <<<"$out" \
  && ok "a release that could not reach the box leaves rc 3, not a clean 0 (rc=$rc)" \
  || ko "an unverified teardown reported success (rc=$rc) -- $out"
grep -q "$tok" "$TMP/state/hold-rog.pid" 2>/dev/null && grep -q " $guest " "$TMP/state/hold-rog.pid" 2>/dev/null \
  && ok "...and KEEPS the guest pid and token, which are what a retry would need" \
  || ko "the unverified release threw away the identity that could end the tree: $(cat "$TMP/state/hold-rog.pid" 2>/dev/null)"
# ...and the retry, once the box answers, finishes the job off that record rather than reading the
# leftover as a completed release and clearing it.
out=$(unhold 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q "guest shell (pid $guest) is gone from the VM" <<<"$out" \
  && ok "...so a later unhold picks the job up and confirms the VM over the record it kept (rc=$rc)" \
  || ko "the retry did not finish the unverified teardown (rc=$rc) -- $out"
[ ! -f "$TMP/state/hold-rog.pid" ] \
  && ok "...and only then is the record cleared" \
  || ko "a confirmed release left its record behind"

# A release must remove only ITS OWN state. Between the kill and the cleanup it now asks the VM a
# question that takes time, and the hold lock went with the sidecar at the top -- so another
# session's --hold can take the box and write its record, fifo and stdout file at those very paths
# inside that window. Unlinking them would leave that holder running, locked and UNRECORDED, with
# an open fifo that does not even notice (review round 1, P1).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
( env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" SSH_DELAY=3 \
      "$WL" unhold rog > "$TMP/slow-unhold.out" 2>&1 ) &
slow=$!
sleep 2
# The competing run: its record names a different holder and a different token.
printf '777777 rog-lan %s 0 wlh-other-0-0 424242 protected\n' "$(date +%s)" > "$TMP/state/hold-rog.pid"
: > "$TMP/state/hold-rog.out"; rm -f "$TMP/state/hold-rog.in"; mkfifo "$TMP/state/hold-rog.in"
if alive "$slow"; then
  wait "$slow"
  [ -f "$TMP/state/hold-rog.pid" ] && grep -q 'wlh-other-0-0' "$TMP/state/hold-rog.pid" \
    && ok "a release leaves alone a record that has come to name another run's holder" \
    || ko "the release deleted the next run's record: $(cat "$TMP/slow-unhold.out")"
  [ -p "$TMP/state/hold-rog.in" ] \
    && ok "...and its channel with it, which an open fifo would not have survived losing" \
    || ko "the release unlinked the next run's channel: $(cat "$TMP/slow-unhold.out")"
  grep -q "now names another run's holder" "$TMP/slow-unhold.out" \
    && ok "...and says so rather than leaving the swap unremarked" \
    || ko "the release said nothing about the record it declined to remove: $(cat "$TMP/slow-unhold.out")"
else
  wait "$slow"
  ko "the case did not stage its window: the unhold finished before the competing record was written"
fi
rm -f "$TMP/state/hold-rog.pid" "$TMP/state/hold-rog.in" "$TMP/state/hold-rog.out"

# A reuse that recovers a guest pid the original --hold never got to record must write it back: the
# interrupted run left a record with pid 0, and without the write-back the eventual unhold takes
# the no-pid path and cannot check the VM or end a survivor by pid (review round 1, P2).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
real_guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid")
awk '{ $6 = 0; print }' "$TMP/state/hold-rog.pid" > "$TMP/state/hold-rog.pid.new"
mv "$TMP/state/hold-rog.pid.new" "$TMP/state/hold-rog.pid"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q "guest shell $real_guest answered its token" <<<"$out" \
  && ok "a reuse recovers the guest pid of a record whose handshake never completed (rc=$rc)" \
  || ko "the reuse did not re-prove the holder (rc=$rc) -- $out"
# ...and REPORTS it without writing it back. This path holds no lock -- the holder it is reusing
# owns the box's -- so a rewrite here can resurrect a record an overlapping unhold has just
# cleared, or land on the record of whichever run took the freed lock next (review round 3->4).
# It is safe to drop because the cleanup probe asks by TOKEN: a record with guest pid 0 names its
# holder just as well as one without.
[ "$(awk '{ print $6 }' "$TMP/state/hold-rog.pid")" = 0 ] \
  && ok "...and does not write it back into a record it cannot hold a lock over" \
  || ko "the reuse rewrote a record it is not serialized against: $(cat "$TMP/state/hold-rog.pid")"
out=$(unhold 2>&1); rc=$?
# No pid in the message, and that is the point: with none recorded and none found (the shell is
# gone), there is no pid to name -- while the VERDICT still comes from the token probe, which is
# what a record with guest pid 0 is now enough for.
[ "$rc" -eq 0 ] && grep -q 'is gone from the VM, observed over rog-lan' <<<"$out" \
  && ok "...and the release still confirms the VM by token, with no pid recorded (rc=$rc)" \
  || ko "the release could not confirm without a recorded pid (rc=$rc) -- $out"
reset_hold_state

# Both record writes are CHECKED. The second one is not stageable from here -- it needs the state
# directory to stop being writable between the claim and the handshake -- so the guard is on the
# invocation, the way the ps -ww one is: an unchecked write would report a hold established over a
# record with no guest pid in it, which is the one thing the release cannot work without (review
# round 1, P2). Continuations are joined first, since the redirection sits on a later line.
unchecked=$(sed -e :a -e '/\\$/N; s/\\\n//; ta' "$WL" | grep -n 'printf .*> "\$f"' | grep -v '!  *printf\|! printf')
[ -z "$unchecked" ] \
  && ok "every write of the holder's record is checked, so no hold is reported over an unusable one" \
  || ko "a record write goes unchecked: $unchecked"

# A CAPPED probe establishes nothing, whatever it printed first. `capped` kills the wedged command
# and the substitution keeps the bytes that arrived before it did: a `wsl --list` cut off before
# "Ubuntu" and a `ps` cut off before its process row both look exactly like "gone" to anything that
# reads the output without the status. Reporting that as a verified release would delete the guest
# pid and token over a holder that may still be running (review round 2, P1).
for probe in 'list --running' 'ps -eo pid'; do
  reset_hold_state
  held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
  out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
        WAKE_LAB_PROBE_CAP=2 SSH_PARTIAL="$probe" "$WL" unhold rog 2>&1); rc=$?
  [ "$rc" -eq 3 ] && grep -q 'did not answer, so this does NOT claim the VM is unheld' <<<"$out" \
    && [ -f "$TMP/state/hold-rog.pid" ] \
    && ok "a '$probe' probe that printed and then wedged is unverified, not a release (rc=$rc)" \
    || ko "partial output from a capped '$probe' was read as a verified release (rc=$rc) -- $out"
done
reset_hold_state

# ...and the same rule after the by-pid kill: if the box goes quiet there, whether the kill landed
# is unknown, which is not the same as a holder confirmed still running and is certainly not a
# release. Both keep the record; only one of them is a fact (review round 2, P1).
reset_hold_state
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
    WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
    SSH_REMOTE_LEAKS=1 "$WL" kick-wsl --hold rog >/dev/null 2>&1
guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
: > "$SSH_DOWN_LIST"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      WAKE_LAB_HOLD_TEARDOWN_SECONDS=4 SSH_DOWN_AFTER='-e pkill|rog-lan' "$WL" unhold rog 2>&1); rc=$?
[ "$rc" -eq 3 ] && grep -q 'stopped answering, so whether that kill landed is unknown' <<<"$out" \
  && ok "a post-kill probe that cannot reach the box is unknown, not a confirmed survivor (rc=$rc)" \
  || ko "an unreachable post-kill probe was classified as a confirmed leak (rc=$rc) -- $out"
[ -f "$TMP/state/hold-rog.pid" ] && grep -q " $guest " "$TMP/state/hold-rog.pid" \
  && ok "...and it keeps the record, which is what a retry would finish the job from" \
  || ko "the record was deleted after an unknown kill: $(ls "$TMP/state")"
: > "$SSH_DOWN_LIST"; reset_hold_state

# The compare-and-delete is SERIALIZED, not merely careful: the identity check and the unlink are
# two operations, so the release takes the box's hold lock for the whole stretch -- the same lock a
# holder carries, and the one the sidecar has just dropped. A `--hold` arriving mid-release is then
# refused by the interlock instead of racing it (review round 2, P1).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
slow_sidecar=$(awk '{ print $4 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
( env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" SSH_DELAY=3 \
      "$WL" unhold rog > "$TMP/slow-unhold2.out" 2>&1 ) &
slow=$!
# Synchronize on the LOCK, not on the clock: the release cannot take it until the holder it killed
# is really gone, and `kill -0` can keep answering past a fixed sleep -- so a timed wait can launch
# the competitor into a window that has not opened, where winning the lock is legitimate and the
# case fails for the wrong reason (review round 3, P2, reproduced by the reviewer).
# The sidecar holds that lock until it sees its holder go, and it looks with `kill -0` -- which a
# ZOMBIE answers. The holder here is orphaned when wake-lab exits, so on a system whose PID 1 does
# not reap promptly (a container) it stays a zombie, the sidecar never lets go, and the competing
# hold below would be refused by a stale lock rather than by the release. The reviewer hit exactly
# that. So the fixture ends the sidecar itself if the lock has not come free (review round 6, P2).
locked=0
for i in $(seq 1 20); do
  grep -q '^wake-lab unhold (pid' "$WAKE_LAB_LOCK_DIR/rog.hold.lock" 2>/dev/null && { locked=1; break; }
  [ "$i" = 5 ] && [ -n "$slow_sidecar" ] && kill "$slow_sidecar" 2>/dev/null
  sleep 1
done
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
if [ "$locked" = 1 ] && alive "$slow"; then
  wait "$slow"
  [ "$rc" -ne 0 ] && grep -q 'already spoken for' <<<"$out" && grep -q 'unhold (pid' <<<"$out" \
    && ok "a --hold arriving mid-release is refused by the lock the release holds (rc=$rc)" \
    || ko "a --hold raced a release instead of being refused by it (rc=$rc) -- $out"
else
  wait "$slow"
  ko "the case did not stage its window: the release never held the lock while the hold ran"
fi
reset_hold_state

# A release that could not confirm keeps its record AND its marker, so the next --hold meets an
# unfinished release rather than stale state. It must not simply delete them and start a second
# holder: the first one would be untracked, still pinning the VM, and would outlive the release of
# the one about to be spawned. It finishes the old job first (review round 2, P1).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
old_guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold rog >/dev/null 2>&1
[ -f "$TMP/state/hold-rog.pid" ] && [ -f "$TMP/state/hold-rog.releasing" ] \
  && ok "an unconfirmed release leaves both its record and its marker for the next run to find" \
  || ko "the unconfirmed release did not leave its pending state behind"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'confirming the VM is free of it before taking the box' <<<"$out" \
  && grep -q "guest shell (pid $old_guest) is gone from the VM" <<<"$out" \
  && ok "...and the next --hold finishes it before taking the box (rc=$rc)" \
  || ko "a new hold ignored the pending release (rc=$rc) -- $out"
grep -q 'wsl holder observed on rog' <<<"$out" \
  && ok "...then takes the box normally once the VM says the old holder is gone" \
  || ko "the hold did not proceed after finishing the pending release -- $out"
unhold >/dev/null 2>&1; reset_hold_state

# ...and when the old holder is NOT gone, the new hold is refused rather than stacking a second
# one over a survivor nothing records.
reset_hold_state
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
    WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
    SSH_REMOTE_LEAKS=2 "$WL" kick-wsl --hold rog >/dev/null 2>&1
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold rog >/dev/null 2>&1
: > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'may still be running in the VM' <<<"$out" \
  && ! grep -q -- '-e sh -s' "$SSH_LOG" \
  && ok "a hold over a survivor of an unfinished release is refused, and spawns nothing (rc=$rc)" \
  || ko "a second holder was stacked over an untracked survivor (rc=$rc) -- $out; $(cat "$SSH_LOG")"
reset_hold_state

# A hold whose handshake never answered is the holder most in need of an identity, not least: the
# guest shell may have started anyway, and if it survives its channel -- the #192 shape -- killing
# the client and deleting the record leaves it pinning the VM with nothing naming it, while every
# later unhold reports no holder recorded. So the failed path asks the VM by token before it
# discards anything (review round 3, P1).
reset_hold_state
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=2 \
      WAKE_LAB_HOLD_TEARDOWN_SECONDS=4 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_SILENT" SSH_REMOTE_LEAKS=2 "$WL" kick-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'Its record is KEPT' <<<"$out" \
  && grep -q 'wlh-' "$TMP/state/hold-rog.pid" 2>/dev/null \
  && ok "a failed hold whose guest shell survived keeps the token that names it (rc=$rc)" \
  || ko "a failed hold discarded the identity of a survivor (rc=$rc) -- $out"
# ...and that retained token is usable: the release finds the process by it, with no guest pid ever
# having been recorded, where the old code would have said there was no holder at all.
out=$(unhold 2>&1); rc=$?
[ "$rc" -eq 3 ] && grep -q 'still pinned by a holder of ours' <<<"$out" \
  && ! grep -q 'no wsl holder recorded' <<<"$out" \
  && ok "...and a later unhold names that survivor by token, rather than reporting no holder (rc=$rc)" \
  || ko "the retained token did not let the release find the survivor (rc=$rc) -- $out"
reset_hold_state

# ...and neither is a connection that DROPS after the header. ssh returns its own 255 for that,
# which is not the remote command's status and says nothing about the VM -- but the header is
# already in the command substitution, so anything reading output before status accepts it, finds
# no token, and calls the holder gone (review round 4, P1).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      SSH_DROP='ps -eo pid' "$WL" unhold rog 2>&1); rc=$?
[ "$rc" -eq 3 ] && grep -q 'did not answer, so this does NOT claim the VM is unheld' <<<"$out" \
  && [ -f "$TMP/state/hold-rog.pid" ] \
  && ok "a probe whose connection dropped after the header is unverified, not a release (rc=$rc)" \
  || ko "an ssh error status was consumed as a complete probe (rc=$rc) -- $out"
reset_hold_state

# ...and the confirmation is gated on the RECORD, not on the release marker beside it. The marker
# can fail to be written (a state filesystem briefly full) and it is absent entirely when a holder
# DIED rather than being released -- the #237 shape, whose orphan the lore says nothing can name.
# Either way a record carrying a token could mean a holder of ours is still in that VM, and that is
# the only question a new hold has to answer before discarding it (review round 5, P1).
reset_hold_state
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
    WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
    SSH_REMOTE_LEAKS=2 "$WL" kick-wsl --hold rog >/dev/null 2>&1
# The holder dies with no unhold at all, so nothing writes a marker -- and its remote survives.
kill "$(awk '{ print $1 }' "$TMP/state/hold-rog.pid")" 2>/dev/null
for _ in 1 2 3 4 5; do alive "$(awk '{ print $1 }' "$TMP/state/hold-rog.pid")" || break; sleep 1; done
rm -f "$TMP/state/hold-rog.releasing"
# The hold lock goes with the holder, but its sidecar only notices on its next poll -- and it looks
# with `kill -0`, which a ZOMBIE answers, so where PID 1 does not reap promptly it never lets go.
# Ending it explicitly is what makes this case behave the same in a container as on a Mac, and the
# loop has a postcondition so a lock that never frees fails the case instead of quietly turning it
# into a test of a stale refusal (review round 8, P2, reproduced by the reviewer).
kill "$(awk '{ print $4 }' "$TMP/state/hold-rog.pid" 2>/dev/null)" 2>/dev/null
lock_free=0
for _ in $(seq 1 15); do
  if ( exec 7>>"$WAKE_LAB_LOCK_DIR/rog.hold.lock"
       perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7 ); then
    lock_free=1; break
  fi
  sleep 1
done
[ "$lock_free" = 1 ] \
  || ko "the dead holder's sidecar never released rog's hold lock, so the case below tests a stale refusal"
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
      WAKE_LAB_HOLD_TEARDOWN_SECONDS=4 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" "$WL" kick-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'has a holder on record whose client is gone' <<<"$out" \
  && grep -q 'may still be running in the VM' <<<"$out" \
  && ! grep -q -- '-e sh -s' "$SSH_LOG" \
  && ok "a tokened record with NO marker still blocks a new hold over a survivor (rc=$rc)" \
  || ko "a hold discarded a tokened record without confirming the VM (rc=$rc) -- $out; $(cat "$SSH_LOG")"
reset_hold_state

# A live holder with a release marker beside it is one being ended right now: `unhold` writes that
# marker before it signals the client. Reusing it hands the lane a holder that disappears under it
# moments later, and returns 0 while doing so (review round 15, P1).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
: > "$TMP/state/hold-rog.releasing"
: > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'being released right now' <<<"$out" \
  && ! grep -q -- '-e sh -s' "$SSH_LOG" \
  && ok "a hold over a holder being released is refused, not reused (rc=$rc)" \
  || ko "a hold reused a holder an unhold was about to kill (rc=$rc) -- $out"
rm -f "$TMP/state/hold-rog.releasing"
unhold >/dev/null 2>&1; reset_hold_state

# A holder taken with --force never held the box's hold lock, so nothing refused another session's
# restart-wsl while it ran. That is a property of the LANE, read long afterwards by whoever cleans
# it up, so it goes in the record and not only in the line that scrolled past at the time (#184 b).
reset_hold_state
printf 'wake-lab --hold (pid 999, since 20260919T000000Z)\n' > "$WAKE_LAB_LOCK_DIR/rog.hold.lock"
perl -e 'use Fcntl ":flock"; open(F, "+<", $ARGV[0]) or die; flock(F, LOCK_EX | LOCK_NB) or die;
         print "held\n"; sleep 300' "$WAKE_LAB_LOCK_DIR/rog.hold.lock" > "$TMP/extlock.out" 2>&1 &
extlock=$!
for _ in 1 2 3 4 5; do grep -q held "$TMP/extlock.out" 2>/dev/null && break; sleep 1; done
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
      WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
      "$WL" kick-wsl --hold --force rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'proceeds WITHOUT the hold lock (--force)' <<<"$out" \
  && ok "--force takes a hold over another session's lock, and says so (rc=$rc)" \
  || ko "--force did not take the hold over a held lock (rc=$rc) -- $out; $(cat "$TMP/extlock.out")"
awk '{ print $7 }' "$TMP/state/hold-rog.pid" 2>/dev/null | grep -qx unprotected \
  && ok "...and the record says the box was never protected, for whoever reads it later" \
  || ko "a --force holder is recorded as protected: $(cat "$TMP/state/hold-rog.pid" 2>/dev/null)"
out=$(unhold 2>&1)
grep -q 'taken with --force and never held' <<<"$out" \
  && ok "...and the release says it too, which is where a lane's cleanup reads it" \
  || ko "the release did not report an unprotected hold -- $out"

# ...and a later --hold over that unprotected holder does not merely warn about it. Returning
# success there would have start_wsl report the VM as held while another session's restart-wsl can
# still take it mid-lane, which is the one claim --hold exists to make truthfully. The lock the
# forced run could not get is often free by later, and a live holder can be given a new
# lock-carrying sidecar over its existing pid (review round 7, P1).
reset_hold_state
printf 'wake-lab --hold (pid 999, since 20260919T000000Z)\n' > "$WAKE_LAB_LOCK_DIR/rog.hold.lock"
perl -e 'use Fcntl ":flock"; open(F, "+<", $ARGV[0]) or die; flock(F, LOCK_EX | LOCK_NB) or die;
         print "held\n"; sleep 300' "$WAKE_LAB_LOCK_DIR/rog.hold.lock" > "$TMP/extlock2.out" 2>&1 &
extlock2=$!
for _ in 1 2 3 4 5; do grep -q held "$TMP/extlock2.out" 2>/dev/null && break; sleep 1; done
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
    WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
    "$WL" kick-wsl --hold --force rog >/dev/null 2>&1
# ...and while that lock is STILL held, an ordinary --hold over the unprotected holder is refused
# rather than reported as a successful hold: `wsl up` is read as "the VM is held", and this one can
# still be destroyed mid-lane by another session's restart-wsl (review round 9, P1).
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'carries no' <<<"$out" && ! grep -q '^wsl up$' <<<"$out" \
  && ok "a reuse that cannot repair a --force holder's protection is refused, not reported up (rc=$rc)" \
  || ko "an unprotected holder was reported as a held VM (rc=$rc) -- $out"
# ...unless this run says --force too, which is how a caller accepts an unprotected box.
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=5 \
      WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
      "$WL" kick-wsl --hold --force rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'NOT protected' <<<"$out" \
  && ok "...while --force accepts it and says what it is accepting (rc=$rc)" \
  || ko "--force did not carry the unprotected reuse (rc=$rc) -- $out"
# The lock's owner goes away, as the run that held it would at the end of its own lane.
kill "$extlock2" 2>/dev/null; wait "$extlock2" 2>/dev/null
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'has now taken rog.s hold lock for it' <<<"$out" \
  && [ "$(awk '{ print $7 }' "$TMP/state/hold-rog.pid")" = protected ] \
  && ok "a reuse takes the lock a --force holder never had, and records that it is protected (rc=$rc)" \
  || ko "an unprotected holder was reused as a protected one (rc=$rc) -- $out; $(cat "$TMP/state/hold-rog.pid")"
# ...and the protection is real, not a word in a file: the box is now refused to a destroyer.
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_STATE_DIR="$TMP/state" \
      SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'REFUSED' <<<"$out" \
  && ok "...so another session's restart-wsl is refused over a holder that used to be unprotected" \
  || ko "the newly taken hold lock refuses nothing (rc=$rc) -- $out"
unhold >/dev/null 2>&1
kill "$extlock" 2>/dev/null; wait "$extlock" 2>/dev/null
rm -f "$WAKE_LAB_LOCK_DIR"/*.lock

# The hold-lock sidecar is identified by ITS OWN holder, not by the tag every lane on this machine
# shares. A stale record whose sidecar number has been recycled onto a SIBLING box's sidecar would
# otherwise release that box's hold lock, leaving a live lane's VM open to another session's
# restart-wsl -- the 2026-09-16 failure, reached through a cleanup (#184 b).
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
rog_sidecar=$(awk '{ print $4 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
printf '999999 minix-lan %s %s wlh-stale-0-0 0 protected\n' "$(date +%s)" "$rog_sidecar" \
  > "$TMP/state/hold-minix.pid"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold minix >/dev/null 2>&1
alive "$rog_sidecar" \
  && ok "one box's stale record does not kill another box's sidecar, which carries its hold lock" \
  || ko "unhold minix killed rog's sidecar (pid $rog_sidecar) and unlocked a live lane's box"
if ( exec 7>>"$WAKE_LAB_LOCK_DIR/rog.hold.lock"
     perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7 ); then
  ko "...and rog's hold lock went with it: another session's restart-wsl would now take that VM"
else
  ok "...so rog's hold lock is still held and its VM is still protected"
fi
unhold >/dev/null 2>&1

# A hold taken by an OLDER version of this script: no token, a payload that does not read its
# stdin, and therefore a tree that will outlive its channel whatever this run does. A lane is a
# sequence of commands and the script is updated between them, so this record is a shape that will
# actually turn up -- and the one thing that must not happen is for it to be treated as a stale
# record naming somebody else's process, or as a holder this script can speak for.
reset_hold_state
mkdir -p "$TMP/state"
SSH_UP="rog-lan" ssh -o BatchMode=yes rog-lan wsl.exe -d Ubuntu -e sleep infinity &
legacy=$!
sleep 1
# Four fields: the record shape before the token, the guest pid and the protection flag existed.
printf '%s rog-lan %s 0\n' "$legacy" "$(date +%s)" > "$TMP/state/hold-rog.pid"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'predates the token handshake' <<<"$out" \
  && ok "a holder from before the handshake is not claimed as observed (rc=$rc)" \
  || ko "a legacy holder was reported as proved (rc=$rc) -- $out"
alive "$legacy" \
  && ok "...and it is left running, not killed as a record naming something else" \
  || ko "the legacy holder was killed as an unrecognized process"
out=$(unhold 2>&1); rc=$?
# rc 3, not 0: the release ended the client it could reach and cannot say the box is free, and a
# caller reading 0 there treats a possibly pinned VM as clean -- which the runbook now does
# explicitly (review round 11, P1).
[ "$rc" -eq 3 ] && grep -q 'carries no token' <<<"$out" \
  && ! grep -q 'is gone from the VM' <<<"$out" \
  && ok "...and its release ends it, says it cannot tell whether the tree went, and exits 3 (rc=$rc)" \
  || ko "the legacy release claimed an observation it cannot make (rc=$rc) -- $out"
for _ in 1 2 3 4 5; do alive "$legacy" || break; sleep 1; done
alive "$legacy" && ko "the legacy holder survived its unhold" \
  || ok "...having really ended the client it could reach"
# Reaped, not merely killed: this is a background job of the SUITE's shell, and the concurrency
# cases below `wait` for every one of them. A legacy holder left unreaped is a `sleep 86400` that
# the next bare `wait` blocks on for the rest of the run.
kill "$legacy" 2>/dev/null; wait "$legacy" 2>/dev/null
reset_hold_state
# A lane's cleanup runs on the way out of a FAILED lane too, so unhold over nothing is not an error.
expect "unhold with no holder recorded says so and still succeeds" 0 "no wsl holder recorded for rog" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold rog
# Cleanup must not be blocked by configuration: the holder is a local pid, and a site file that
# went missing after the lane started would otherwise strand the one process that pins the VM.
reset_hold_state
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1)
stranded=$(cut -d' ' -f1 "$TMP/state/hold-rog.pid" 2>/dev/null)
# SSH_UP because the claim is about the missing TABLE: the release's own observation goes to the
# alias the record names, which it reads from that record and not from the site file, so a box that
# answers is what lets this case fail for the reason it is about.
out=$(env WAKE_LAB_HOSTS="$TMP/absent.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      "$WL" unhold rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder released on rog' <<<"$out" \
  && ok "unhold releases the holder even with no host table, which it needs nothing from (rc=$rc)" \
  || ko "a missing site file stranded the holder (rc=$rc) -- $out"
for _ in 1 2 3 4 5; do alive "$stranded" || break; sleep 1; done
alive "$stranded" && ko "...but the holder survived" || ok "...and the holder is gone"
# The site kind can change after a WSL lane began. Its recorded holder still belongs to that
# lane, regardless of which OS the next boot selects.
sed 's/rog|minix) echo wsl/rog|minix) echo linux/' "$TMP/hosts.sh" > "$TMP/hosts-linux.sh"
reset_hold_state
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1)
stranded=$(cut -d' ' -f1 "$TMP/state/hold-rog.pid" 2>/dev/null)
out=$(env WAKE_LAB_HOSTS="$TMP/hosts-linux.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      "$WL" unhold rog 2>&1); rc=$?
for _ in 1 2 3 4 5; do alive "$stranded" || break; sleep 1; done
[ "$rc" -eq 0 ] && grep -q 'wsl holder released on rog' <<<"$out" && ! alive "$stranded" \
  && ok "unhold releases a recorded WSL holder after the box kind changes to linux (rc=$rc)" \
  || ko "a linux kind stranded its earlier WSL holder (rc=$rc) -- $out"
mkdir -p "$TMP/state"; printf '999999\n' > "$TMP/state/hold-rog.pid"
# A holder found already dead is a lane that lost its box with nobody noticing -- the very failure
# --hold exists to prevent -- so it is reported as a FAULT and leaves rc 2, never as a release. On
# 2026-09-18 both holders died ~30-38 min into a lane, unhold called it a release, and the run read
# as clean; the boxes stayed up by luck. rc 2 and not 1 so a cleanup can tell this from an ordinary
# failure of the unhold command.
expect "...and a holder that had already died is reported as an ANOMALY, not as a release" 2 "ANOMALY: wsl holder on rog had already exited" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts-linux.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold rog
grep -q 'stopped being RESERVED' <<<"$out" \
  && ok "...and says what it cost the lane -- the lab lock -- not merely that a pid was gone" \
  || ko "the anomaly does not say the box stopped being reserved when the holder died -- $out"
[ ! -f "$TMP/state/hold-rog.pid" ] && ok "...and its stale pid file is cleared" \
  || ko "a dead holder's pid file survived unhold"
# An unhold is not atomic -- it kills the holder, then removes the record -- so an interruption
# between the two (or a second unhold overlapping the first, which the routine now invites by
# telling a run whose unhold has not come back to chase it) leaves a record naming a pid that
# unhold itself deliberately ended. Reporting that as a lost holder would mark valid lane results
# suspect, so the release writes its intent down BEFORE the kill and a retry reads it.
# A TOKENED leftover, which is what a modern interrupted release leaves: the retry re-probes the
# VM over that token, finds nothing of ours (no such guest here), and only then calls it complete.
# A tokenless leftover is a different answer now -- nothing can check it, so it stays unverified --
# and that is the legacy shape, tested with the legacy holder further down.
mkdir -p "$TMP/state"
printf '999999 rog-lan 1 0 wlh-gone-0-0 4242 protected\n' > "$TMP/state/hold-rog.pid"
: > "$TMP/state/hold-rog.releasing"
expect "an interrupted unhold's leftover record is a completed release, not a lost holder" 0 "was already ended by an earlier unhold" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog
grep -q 'ANOMALY' <<<"$out" \
  && ko "a deliberate release was reported as a lost holder -- $out" \
  || ok "...and raises no anomaly, so the lane's results are not called suspect"
[ ! -f "$TMP/state/hold-rog.releasing" ] && ok "...and the release marker is cleared with the record" \
  || ko "the release marker survived unhold"
# ...and that marker must not outlive its lane: left in place it would mask the loss of the NEXT
# holder, which is the one thing this reporting exists to catch.
reset_hold_state
mkdir -p "$TMP/state"; : > "$TMP/state/hold-rog.releasing"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1)
[ ! -f "$TMP/state/hold-rog.releasing" ] \
  && ok "a fresh hold clears a stale release marker, so the next lost holder is still reported" \
  || ko "a stale release marker survived a fresh hold -- it would mask the next loss -- $out"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1
# Two unholds racing over one box must never report an intentional release as a loss. The marker
# alone does not close this: the record can vanish between one run's entry and its own checks,
# which is why an absent record is read as "a release completed" rather than as evidence. Note what
# this case can and cannot do -- it runs the pair concurrently and cannot prove it ever hit the
# window, so the guarantee rests on that argument and this is the regression net under it. It also
# cannot fail spuriously in the other direction: the only things that fail it, an ANOMALY line and
# an rc 2, are both the bug itself.
race_bad=0
for i in 1 2 3; do
  reset_hold_state
  held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
  ( env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      "$WL" unhold rog > "$TMP/race-a" 2>&1; echo $? > "$TMP/race-a.rc" ) &
  ( env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" \
      "$WL" unhold rog > "$TMP/race-b" 2>&1; echo $? > "$TMP/race-b.rc" ) &
  wait
  if grep -q 'ANOMALY' "$TMP/race-a" "$TMP/race-b" 2>/dev/null; then
    race_bad=$((race_bad + 1)); echo "  race $i raised an anomaly: $(cat "$TMP/race-a" "$TMP/race-b")"
  fi
  for half in a b; do
    [ "$(cat "$TMP/race-$half.rc" 2>/dev/null)" = 2 ] && race_bad=$((race_bad + 1))
  done
done
[ "$race_bad" -eq 0 ] \
  && ok "overlapping unholds never report a deliberate release as a lost holder" \
  || ko "overlapping unholds reported an intentional release as a loss ($race_bad of 6 halves)"
# ...and the pair really did release something, so the case above is not passing on two no-ops.
if grep -q 'wsl holder released on rog' "$TMP/race-a" "$TMP/race-b" 2>/dev/null; then
  ok "...and the racing pair between them released the holder"
else
  ko "neither half of the race released anything -- $(cat "$TMP/race-a" "$TMP/race-b" 2>/dev/null)"
fi
[ ! -f "$TMP/state/hold-rog.pid" ] && [ ! -f "$TMP/state/hold-rog.releasing" ] \
  && ok "...and leaves neither the record nor the marker behind" \
  || ko "a raced unhold left state behind for the next lane to trip on"
# Every box's holder runs the same payload, so a signature that did not include the destination
# would let one box's stale file kill another box's LIVE holder -- dropping that lane silently.
reset_hold_state
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1)
rog_pid=$(cut -d' ' -f1 "$TMP/state/hold-rog.pid" 2>/dev/null)
printf '%s minix-lan\n' "$rog_pid" > "$TMP/state/hold-minix.pid"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold minix 2>&1)
grep -q 'had already exited' <<<"$out" && alive "$rog_pid" \
  && ok "a stale file for one box does not kill another box's live holder" \
  || ko "unhold minix killed rog's holder, or claimed it as its own -- $out"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1
# The pid file outlives the shell that wrote it, and pids are reused: a stale one whose number has
# been taken over by something else must not get that process killed.
sleep 30 & innocent=$!
printf '%s\n' "$innocent" > "$TMP/state/hold-rog.pid"
expect "a stale pid reused by an unrelated process is not killed as a holder" 2 "had already exited" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold rog
alive "$innocent" && ok "...and that process is still running" \
  || ko "unhold killed a process that merely inherited the holder's pid"
kill "$innocent" 2>/dev/null; wait "$innocent" 2>/dev/null
# A --hold that holds nothing is a lane that believes it is held and is not.
: > "$CURL_LOG"
expect "--hold without a WSL start is refused rather than ignored" 1 "hold needs a WSL start" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" --hold rog
[ ! -s "$CURL_LOG" ] && ok "...before anything is sent" || ko "the refused run still woke the box: $(cat "$CURL_LOG")"
# The wake path starts WSL only under --wait, so `--wsl --hold` without it holds nothing either --
# and it is the shape an operator is most likely to type.
: > "$CURL_LOG"
expect "...and so is --wsl --hold without --wait, which never reaches the WSL start" 1 "hold needs a WSL start" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" --wsl --hold rog
expect "...and --restart-wsl --hold without --wait" 1 "hold needs a WSL start" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" --restart-wsl --hold rog
[ ! -s "$CURL_LOG" ] && ok "...both before any packet goes out" || ko "a refused held wake still woke the box: $(cat "$CURL_LOG")"

# An unrecordable holder is a leaked one: nothing would ever unhold it, and the VM would stay
# pinned until the box reboots.
# A state path UNDER a regular file, not a mode-555 directory: root ignores the mode bits, and
# this suite runs as root in a container often enough that the case would fail there for the
# runner's uid rather than for the defect it pins.
reset_hold_state; : > "$TMP/notadir"
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=1 \
 WAKE_LAB_STATE_DIR="$TMP/notadir/state" \
      SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" \
      "$WL" kick-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl HOLD FAILED on: rog' <<<"$out" \
  && grep -q 'could NOT be recorded at .*; nothing was started' <<<"$out" \
  && ok "a holder that cannot be recorded fails the hold, and is never spawned to begin with (rc=$rc)" \
  || ko "an unrecordable holder did not fail the hold, or was spawned before its record (rc=$rc) -- $out"
# The wording is the evidence for the ordering: the record is claimed (noclobber) BEFORE the ssh
# exists, so there is no window in which a holder runs that nothing can unhold. Spawning first and
# killing on a failed write leaves that window, and says "killed rather than leaked" instead.
grep -q -- '-e sh -s' "$SSH_LOG" \
  && ko "a holder was spawned before its record was claimed: $(cat "$SSH_LOG")" \
  || ok "...with no holder command issued at all"
rm -f "$TMP/notadir"
# The same claim serializes two --hold runs for one box: the second reuses the live holder rather
# than spawning a second one whose pid the first would never see.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
: > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder already running for rog' <<<"$out" \
  && ! grep -q -- '-e sh -s' "$SSH_LOG" \
  && ok "a second --hold over a live holder reuses it and spawns no second one (rc=$rc)" \
  || ko "a second --hold spawned another holder (rc=$rc) -- $out; $(cat "$SSH_LOG")"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# `wsl --shutdown` is HOST-GLOBAL, so a restart on a held box destroys the VM the holder is keeping
# alive, and the holder with it -- the 2026-09-16 loss, from inside the flag meant to prevent it.
# The holder carries that box's HOLD LOCK (ludics-lite#168): it inherits the descriptor, so the
# flock lives as long as the holder and the next restart is refused by the same interlock that
# protects every other tool. A plain kick stays available because it has no shutdown to refuse and
# is the recovery command for a box with no VM.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
lane_pid=$(cut -d' ' -f1 "$TMP/state/hold-rog.pid" 2>/dev/null)
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=1 \
 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" "$WL" restart-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q -- '--shutdown' "$SSH_LOG" \
  && grep -q "wsl restart REFUSED on: rog (a lab lock is held" <<<"${out##*$'\n'}" \
  && grep -q 'wake-lab --hold' <<<"$out" && alive "$lane_pid" \
  && ok "a restart is refused on a box a holder is keeping alive, before any host-global shutdown (rc=$rc)" \
  || ko "a restart tore down a held VM (rc=$rc) -- $out; $(cat "$SSH_LOG")"

# ...and the refusal names the HOLD, not the restart whose descriptor the hold inherited. Before
# ludics-lite#224 the line read `wake-lab restart (pid <restarter>, ...)` for the whole life of the
# lane: a finished command and an exited pid, quoted at every later refusal here and in every
# `skip (box ... reserved by ...)` the sweep published.
hold_line=$(head -1 "$WAKE_LAB_LOCK_DIR/rog.hold.lock" 2>/dev/null)
case "$hold_line" in
  *"wake-lab --hold (pid $lane_pid,"*)
    ok "...and the hold lock's line names the holder that is actually there" ;;
  *) ko "the hold lock's line does not name the live holder (pid $lane_pid): $hold_line" ;;
esac

# The point of the split (ludics-lite#224): a hold says "do not destroy this VM", never "nobody
# else may work here", so the LANE lock -- the one a sweep takes, and the one `lock-path` answers
# -- is left FREE by a hold. The routine holds both boxes in step 1 and sweeps them in step 2 of
# the same session; while one file said both things, every remote lane waited out its 300s
# LAB_LOCK_WAIT against that routine's own holder and skipped, and three backends went uncovered.
lane_lock=$(env WAKE_LAB_HOSTS="$TMP/absent.sh" WAKE_LAB_LOCK_DIR="$WAKE_LAB_LOCK_DIR" "$WL" lock-path rog)
[ "$lane_lock" = "$WAKE_LAB_LOCK_DIR/rog.lock" ] \
  && ok "...and lock-path answers the LANE lock, which is the one a harness takes" \
  || ko "lock-path does not answer the lane lock path -- $lane_lock"
# Taken exactly as the sweep takes it, in a child so the suite keeps none of it.
if ( exec 7>>"$lane_lock"
     perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7 ); then
  ok "...so a sweep lane can still reserve the box its own holder is keeping alive"
else
  ko "a --hold holder still occupies the lane lock: the sweep it exists to serve would skip \
(holder $(head -1 "$lane_lock" 2>/dev/null))"
fi
alive "$lane_pid" \
  && ok "...with the holder still running, so the VM it protects is not the price of that" \
  || ko "the holder died while the lane lock was being taken"
: > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder already running for rog' <<<"$out" && ! grep -q -- '--shutdown' "$SSH_LOG" \
  && ok "...while a plain kick-wsl --hold on the same box is still allowed and reuses the holder (rc=$rc)" \
  || ko "the refusal also blocked the recovery kick (rc=$rc) -- $out"
# ...and unhold gives the box back: the kill releases the flock with it, so the restart that was
# refused a moment ago goes through with nothing to reclaim.
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_STATE_DIR="$TMP/state" \
      SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ! grep -q 'REFUSED' <<<"$out" \
  && ok "...and unhold gives the box back: the lock dies with the holder it was taken by (rc=$rc)" \
  || ko "the lock outlived the holder unhold killed (rc=$rc) -- $out"

# A holder that another run is in the middle of creating is an EMPTY record, between its claim and
# its pid write. Clearing that as stale would let both runs spawn a holder with one pid recorded --
# the race the claim exists to prevent -- so a fresh empty claim is refused, and only an abandoned
# one (older than a minute: its creator died inside a single fork) is cleared.
reset_hold_state; mkdir -p "$TMP/state"; : > "$TMP/state/hold-rog.pid"
: > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'is being created by another run' <<<"$out" && ! grep -q -- '-e sh -s' "$SSH_LOG" \
  && ok "a claim another run is still filling in is not cleared, and no second holder is spawned (rc=$rc)" \
  || ko "an in-progress claim was taken over (rc=$rc) -- $out; $(cat "$SSH_LOG")"
touch -t 202001010000 "$TMP/state/hold-rog.pid"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder started on rog' <<<"$out" \
  && ok "...while an abandoned claim is taken over rather than blocking the hold forever (rc=$rc)" \
  || ko "an abandoned claim blocked the hold (rc=$rc) -- $out"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# A holder this call merely REUSED belongs to an earlier invocation that may still be protecting a
# running lane. A failed probe here must not kill it: that would unhold that lane's VM, which is
# the failure the flag exists to prevent, caused by a retry.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
other_pid=$(cut -d' ' -f1 "$TMP/state/hold-rog.pid" 2>/dev/null)
# The earlier run's holder goes quiet -- a guest that is running and not answering, which is what
# a reuse's failed handshake looks like from here. Muting it is the only way to fail the RETRY's
# probe: SSH_HOLD_ANSWERS is fixed in the holder's environment when it is spawned, and this holder
# was spawned answering.
: > "$SSH_HOLD_DIR/mute"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" 2>&1); rc=$?
rm -f "$SSH_HOLD_DIR/mute"
[ "$rc" -ne 0 ] && grep -q 'belongs to an earlier run: left running and recorded' <<<"$out" \
  && alive "$other_pid" && [ -s "$TMP/state/hold-rog.pid" ] \
  && ok "a failed hold does not kill a holder it reused from an earlier run (rc=$rc)" \
  || ko "a failed retry unheld the earlier run's VM (rc=$rc) -- $out"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# A REUSED holder is observed over the alias the RECORD names, not over the one this invocation
# happens to be kicking on (ludics-lite#184 (b)). The two come apart whenever the first alias stops
# answering mid-lane, which is the case that matters: the holder's channel is the holder's channel,
# and a probe sent down some other route is evidence about a different connection to the same box.
# Here the hold is taken over rog-lan, rog-lan then goes dark, and the second --hold rides
# rog-nv-win -- and still has to prove THAT holder is alive, down the channel it already has.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
first_guest=$(awk '{ print $6 }' "$TMP/state/hold-rog.pid" 2>/dev/null)
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=30 \
 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-nv-win rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" "$WL" kick-wsl --hold rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder already running for rog (pid .*, via rog-lan)' <<<"$out" \
  && grep -q "answered its token over rog-lan" <<<"$out" \
  && ok "a reused holder is observed over the alias its record names, not the one this kick rode (rc=$rc)" \
  || ko "the reuse path observed over the wrong alias (rc=$rc) -- $out"
# ...and it is the same holder, proved fresh: the reply carries a nonce this invocation made up, so
# a holder that had died would fail here rather than pass on the line it printed when it started.
grep -q "answered its token over rog-lan" <<<"$out" \
  && grep -q "guest shell $first_guest answered" <<<"$out" \
  && ok "...and the answer comes from the same guest shell ($first_guest) that the record names" \
  || ko "the reuse path did not re-prove the recorded holder -- $out"
grep -q -- '-e sh -s' "$SSH_LOG" \
  && ko "the reuse path spawned a second holder: $(cat "$SSH_LOG")" \
  || ok "...with no second holder spawned"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# The wake path carries the hold too, and its final verdict is the hold's as well.
wake_hold() { # wake_hold <answers?>
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_WSL_WAIT_SECONDS=1 \
      WAKE_LAB_HOLD_WAIT_SECONDS=1 WAKE_LAB_STATE_DIR="$TMP/state" \
      SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$1" \
      "$WL" --wait --restart-wsl --hold rog
}
reset_hold_state
out=$(wake_hold "$HOLDER_ANSWERS" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'wsl holder observed on rog' <<<"$out" && grep -q '^all up$' <<<"${out##*$'\n'}" \
  && ok "--wait --restart-wsl --hold ends in all up with the holder observed (rc=$rc)" \
  || ko "the wake path did not hold the fresh VM (rc=$rc) -- $out"
# And this is step 1 of the cross-machine sweep routine, verbatim, so the state it leaves behind is
# what step 2 meets: the LANE lock free for the sweep, the HOLD lock carried by the holder. The
# restart itself takes both -- it is a destroyer -- so the lane lock has to be given back when the
# restart returns AND must not have travelled to the holder it spawned, which inherits every
# descriptor the restart's own subshell left open. Both halves are asserted, because a holder
# holding a released lane lock looks exactly like a released one from the parent (ludics-lite#224).
if ( exec 7>>"$WAKE_LAB_LOCK_DIR/rog.lock"
     perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7 ); then
  ok "...leaving the lane lock free, so the sweep it woke the box for can reserve it"
else
  ko "step 1 left its own lane lock held: step 2 would skip every unit on that box \
(holder $(head -1 "$WAKE_LAB_LOCK_DIR/rog.lock" 2>/dev/null))"
fi
if ( exec 7>>"$WAKE_LAB_LOCK_DIR/rog.hold.lock"
     perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7 ); then
  ko "...but nothing holds the hold lock, so another session's restart-wsl would take the VM"
else
  ok "...while the hold lock IS held, so another session's restart-wsl is still refused"
fi
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1
reset_hold_state
out=$(wake_hold "$HOLDER_SILENT" 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q '^all up$' <<<"$out" && grep -q 'NOT all up: wsl HOLD FAILED on: rog' <<<"${out##*$'\n'}" \
  && ok "...and is NOT all up when nothing holds the VM it just started (rc=$rc)" \
  || ko "the wake path said all up over an unheld VM (rc=$rc) -- $out"

# --- the Windows Update window ------------------------------------------------------------------
# KB5129195 restarted minix 21 min into its hip unit on 2026-09-15: active hours were 10:00-01:00
# and the sweep runs in the morning. The registry values are readable in advance from the -win
# side, so a feature update that resets them is a warning before the sweep, not a lost unit after.
# reg.exe writes CRLF, and Windows OpenSSH passes it through: a parser that leaves the \r on the
# value matches neither the hex nor the decimal shape, and every real box would read as an
# unreadable registry. So the fixture is CRLF, like the real thing.
reg_out() { # reg_out <start> <end> <smart> -- as `reg query` prints the key, CRLF included
  printf 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\r\n'
  printf '    ActiveHoursStart    REG_DWORD    %s\r\n' "$1"
  printf '    ActiveHoursEnd    REG_DWORD    %s\r\n' "$2"
  printf '    SmartActiveHoursState    REG_DWORD    %s\r\n' "$3"
}
reset_hold_state; : > "$SSH_LOG"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0xa 0x1 0x0)" 2>&1)
grep -q 'ACTIVE HOURS WARNING on rog: sweep window 7-11 falls outside active hours 10-1' <<<"$out" \
  && grep -q 'uncovered hours: 7 8 9' <<<"$out" \
  && ok "the preflight warns when the sweep window falls outside active hours, naming the hours" \
  || ko "no active-hours warning for a 10-1 window against a 7-11 sweep -- $out"
grep -q 'reg query "HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings"' "$SSH_LOG" \
  && ok "...read from the UX\\Settings key on the Windows side" \
  || ko "the active-hours check did not query the registry key: $(cat "$SSH_LOG")"
# A warning whose repair has to be reconstructed from a registry path is one that gets read and
# left: nothing re-applies the values, so the line names the tracked script that writes them back.
grep -q 'repair with scripts/enable-active-hours-windows.ps1 on the box (elevated PowerShell)' <<<"$out" \
  && ok "...and points the repair at the tracked active-hours script" \
  || ko "the active-hours warning does not name scripts/enable-active-hours-windows.ps1 -- $out"
[ -f "$HERE/enable-active-hours-windows.ps1" ] \
  && ok "...which is tracked where the warning says it is" \
  || ko "the warning names scripts/enable-active-hours-windows.ps1, which is not in the checkout"
# The advice is one constant now, and pinning one use of it would leave the other three free to
# drift. Every warning about the BOX's own values carries it, whichever branch printed it.
for fixture in '0x18 0x18 0x0' '0x6 0x6 0x0' '0x6 0x0 0x1'; do
  # shellcheck disable=SC2086 # the fixture is three fields, deliberately split
  branch=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out $fixture)" 2>&1)
  grep -q 'ACTIVE HOURS WARNING' <<<"$branch" \
    && grep -q 'repair with scripts/enable-active-hours-windows.ps1 on the box (elevated PowerShell)' <<<"$branch" \
    && ok "...on every branch that warns about the box's values ($fixture)" \
    || ko "the active-hours warning for $fixture carries no repair advice -- $branch"
done
# ...and the two that deliberately do not: a malformed WAKE_LAB_SWEEP_HOURS is a misconfiguration
# on THIS side, where the Windows script would change nothing, and an unreadable registry knows of
# no setting to repair. Pinning the constant's reach means pinning where it stops, too.
out=$(env WAKE_LAB_SWEEP_HOURS=morning WAKE_LAB_HOSTS="$TMP/hosts.sh" SSH_UP="rog-lan" \
      SSH_REG="$(reg_out 0x6 0x0 0x0)" "$WL" status rog 2>&1)
grep -q "WAKE_LAB_SWEEP_HOURS='morning' is not" <<<"$out" \
  && ! grep -q 'enable-active-hours-windows.ps1' <<<"$out" \
  && ok "...but a sweep-window misconfiguration on this side does not point at the box's script" \
  || ko "the WAKE_LAB_SWEEP_HOURS warning names a repair on the box -- $out"
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "" 2>&1)
grep -q 'could not read ActiveHoursStart/End' <<<"$out" \
  && ! grep -q 'enable-active-hours-windows.ps1' <<<"$out" \
  && ok "...and an unreadable registry names no repair, knowing of no setting to fix" \
  || ko "the unreadable-registry warning claimed a repair -- $out"
# The quiet path: the 6-to-0 maximum the boxes now pin covers a morning sweep, and a check that
# warned there too would be one nobody reads.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0x6 0x0 0x0)" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'active hours on rog: 6-0 cover the sweep window 7-11 (smart=0)' <<<"$out" \
  && ! grep -q 'ACTIVE HOURS WARNING' <<<"$out" \
  && ok "...and is quiet under the 6-to-0 maximum the boxes pin, reporting what it read (rc=$rc)" \
  || ko "the covered case warned, or said nothing about what it read (rc=$rc) -- $out"
# Smart active hours means Windows moves the window itself, so the pinned values are not in force.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0x6 0x0 0x1)" 2>&1)
grep -q 'SmartActiveHoursState=1 lets Windows move them' <<<"$out" \
  && ok "...but warns when SmartActiveHoursState is on, whatever the values say" \
  || ko "a covered window with smart active hours on went unremarked -- $out"
# A window that wraps midnight is read on both sides of it.
out=$(env WAKE_LAB_SWEEP_HOURS=23-2 WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
      WAKE_LAB_HOLD_WAIT_SECONDS=1 \
      WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" SSH_REG="$(reg_out 0x6 0x0 0x0)" \
      "$WL" kick-wsl --hold rog 2>&1)
grep -q 'uncovered hours: 0 1' <<<"$out" && ! grep -q 'uncovered hours:.*23' <<<"$out" \
  && ok "...and a sweep window that wraps midnight is judged hour by hour across it" \
  || ko "a wrapping sweep window was misjudged -- $out"
# `08-11` is the natural way to write a morning window, and bash reads a leading zero as octal:
# the arithmetic would die on the 8 and abort a check that promises only to warn.
out=$(env WAKE_LAB_SWEEP_HOURS=08-11 WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
      WAKE_LAB_HOLD_WAIT_SECONDS=1 WAKE_LAB_STATE_DIR="$TMP/state" \
      SSH_UP="rog-lan rog-nv-wsl" SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" SSH_REG="$(reg_out 0xa 0x1 0x0)" \
 "$WL" kick-wsl --hold rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'uncovered hours: 8 9' <<<"$out" && ! grep -qi 'value too great\|base' <<<"$out" \
  && ok "...and a zero-padded sweep window is read as decimal, not as octal (rc=$rc)" \
  || ko "a zero-padded window aborted the warn-only check (rc=$rc) -- $out"
# A window that is not a pair of clock hours is a configuration finding, not an hour to judge:
# `7`, `7--11` and `24-25` all survived a check that read only the two extracted endpoints.
# Equal endpoints are an EMPTY range, the end being exclusive -- not a one-hour window.
out=$(env WAKE_LAB_SWEEP_HOURS=7-7 WAKE_LAB_HOSTS="$TMP/hosts.sh" SSH_UP="rog-lan" \
      SSH_REG="$(reg_out 0x6 0x0 0x0)" "$WL" status rog 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q "WAKE_LAB_SWEEP_HOURS='7-7' is an empty range" <<<"$out" \
  && ! grep -q 'cover the sweep window' <<<"$out" \
  && ok "an empty sweep window is reported as empty, not judged as one hour (rc=$rc)" \
  || ko "7-7 was silently read as a one-hour window (rc=$rc) -- $out"
for bad in 7 7--11 24-25 morning; do
  out=$(env WAKE_LAB_SWEEP_HOURS="$bad" WAKE_LAB_HOSTS="$TMP/hosts.sh" SSH_UP="rog-lan" \
        SSH_REG="$(reg_out 0x6 0x0 0x0)" "$WL" status rog 2>&1); rc=$?
  [ "$rc" -eq 0 ] && grep -q "WAKE_LAB_SWEEP_HOURS='$bad' is not" <<<"$out" \
    && ! grep -q 'uncovered hours' <<<"$out" \
    && ok "a malformed sweep window ($bad) is reported as malformed, not judged (rc=$rc)" \
    || ko "the sweep window '$bad' was accepted (rc=$rc) -- $out"
done
# Equal endpoints are not a 24-hour window: Windows allows at most 18 hours, so 6-6 is a reset or
# malformed setting, and reading it as "every hour protected" would print the quiet line over a box
# with no protection at all.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0x6 0x6 0x0)" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'a span Windows cannot mean' <<<"$out" && ! grep -q 'cover the sweep window' <<<"$out" \
  && ok "equal active-hours endpoints are a warning, not a day-long window (rc=$rc)" \
  || ko "6-6 was read as full coverage (rc=$rc) -- $out"
# The same bound from the other side: Windows allows at most 18 hours, so 1-23 is as impossible as
# 6-6, and it covers the sweep window on paper -- which is how an invalid setting would stay quiet.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0x1 0x17 0x0)" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'active hours read as 1-23, a span Windows cannot mean' <<<"$out" \
  && ! grep -q 'cover the sweep window' <<<"$out" \
  && ok "...and so is a span longer than the 18 h Windows maximum (rc=$rc)" \
  || ko "a 22-hour active window was read as coverage (rc=$rc) -- $out"
# The pinned maximum itself must stay quiet: 6-0 is exactly 18 h.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0x6 0x0 0x0)" 2>&1)
grep -q 'active hours on rog: 6-0 cover the sweep window' <<<"$out" && ! grep -q 'cannot mean' <<<"$out" \
  && ok "...while the 18 h maximum the boxes pin is still the quiet path" \
  || ko "the 6-to-0 window the boxes pin was rejected -- $out"
# Numeric is not valid: 24-24 reaches the equal-endpoint branch, which would call every hour
# covered and print the quiet line over a box whose update protection is nonsense.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "$(reg_out 0x18 0x18 0x0)" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'active hours read as 24-24, which are not clock hours' <<<"$out" \
  && ! grep -q 'cover the sweep window' <<<"$out" \
  && ok "...and registry values that are not clock hours are a warning, not a covered window (rc=$rc)" \
  || ko "24-24 was read as a covered window (rc=$rc) -- $out"
# Unreadable is its own answer: the box may still be swept, but nothing is known about its updates.
out=$(held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" "" 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -q 'ACTIVE HOURS WARNING on rog: could not read ActiveHoursStart/End' <<<"$out" \
  && ok "an unreadable registry warns without failing the hold (rc=$rc)" \
  || ko "an unreadable registry was silent, or failed the hold (rc=$rc) -- $out"

# status reports the same window, which is where a human asks whether the fleet is fit for tonight.
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" SSH_UP="rog-lan" SSH_REG="$(reg_out 0xa 0x1 0x0)" "$WL" status rog 2>&1)
grep -q 'Windows Update window' <<<"$out" \
  && grep -q 'ACTIVE HOURS WARNING on rog: sweep window 7-11 falls outside active hours 10-1' <<<"$out" \
  && ok "status carries the active-hours reading for each box" \
  || ko "status does not report the update window -- $out"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" status rog 2>&1)
grep -q 'active hours on rog: not read (no Windows endpoint answered)' <<<"$out" \
  && ! grep -q 'ACTIVE HOURS WARNING' <<<"$out" \
  && ok "...and a box that is down has no reading rather than a warning about its settings" \
  || ko "status warned about the settings of a box it could not reach -- $out"

# A start probe that wedges on one alias must not leave the holder pointed at the OTHER one: on
# the kick path the loop tries the Tailscale alias next, and when that start fails the box is
# still reported up (the wedged start may well have worked), so the holder has to ride the alias
# whose start actually went out.
reset_hold_state; : > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=1 \
 WAKE_LAB_WSL_START_CAP=2 WAKE_LAB_PROBE_CAP=3 \
      WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" SSH_HANG='rog-lan :: wsl\.exe -d Ubuntu -e true' \
      SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" "$WL" kick-wsl --hold rog 2>&1); rc=$?
grep -qE '^rog-lan :: wsl\.exe -d Ubuntu -e sh -s wlh-' "$SSH_LOG" \
  && ok "the holder rides the alias whose start went out, not the one that answered nothing" \
  || ko "the holder was put on the wrong alias after a capped start (rc=$rc) -- $out; $(cat "$SSH_LOG")"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# Every remote command the RELEASE adds is capped, for the reason the kick's are: ConnectTimeout
# bounds the connect, not the remote command, so an accepted session whose `wsl.exe --list` never
# returns would hang the one command that has to work when everything else is wedged -- unhold is
# how a lane ends, and a lane that cannot end leaves the box held. The shim wedges with
# `exec sleep 900`, so a run that FINISHES at all proves the cap fired.
# The hold itself no longer has a capped probe to test: its observation is the handshake, which
# travels down a channel that already exists and asks the network for nothing.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
started=$SECONDS
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_PROBE_CAP=2 WAKE_LAB_STATE_DIR="$TMP/state" \
      SSH_UP="rog-lan" SSH_HANG='list --running' "$WL" unhold rog 2>&1); rc=$?
elapsed=$((SECONDS - started))
[ "$rc" -eq 3 ] && [ "$elapsed" -lt 90 ] && grep -q 'wsl holder released on rog' <<<"$out" \
  && ok "a wedged wsl --list is cut short rather than hanging the unhold (${elapsed}s, rc=$rc)" \
  || ko "the release's observation was not capped (rc=$rc, ${elapsed}s) -- $out"
# ...and a cap that fired is NOT evidence. The release ran, the box said nothing, and the one thing
# it must not do is fill that silence in with the sentence #192 was filed about.
grep -q 'did not answer, so this does NOT claim the VM is unheld' <<<"$out" \
  && ok "...and a probe that told it nothing is reported as nothing, not as an unheld VM" \
  || ko "a wedged observation was read as a released VM -- $out"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# A caller that READS the command's output must not wait for the lane. The holder and the process
# that keeps its lab lock both outlive the command by design, so anything of theirs still holding
# the caller's pipe hangs `kick-wsl --hold | tee log` — or any `$( )` around it, which is how this
# suite calls it — for the whole life of the lane. The lock process is exec'd for exactly that
# reason: a forked shell keeps bash's own descriptors, a caller's pipe among them, while an exec
# sheds them (they are close-on-exec) and keeps only the lock's own fd.
reset_hold_state
started=$SECONDS
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=1 \
 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
    SSH_HOLD_ANSWERS="$HOLDER_ANSWERS" "$WL" kick-wsl --hold rog 2>&1 | cat >/dev/null
elapsed=$((SECONDS - started))
[ "$elapsed" -lt 20 ] \
  && ok "a held lane does not hold its caller's pipe open behind it (${elapsed}s against a 45s holder)" \
  || ko "reading the command's output waited for the holder (${elapsed}s): something of the lane's holds the pipe"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1

# A handshake the wait cuts short is not a handshake served: nothing has come back through the VM,
# so the hold must fail rather than report a holder observed -- and, because that failed hold
# SPAWNED something, it must leave nothing of it behind. A failed hold that leaks a guest process
# is the same defect as ludics-lite#192 one step earlier: a VM pinned by a process no record names.
reset_hold_state
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_HOLD_WAIT_SECONDS=2 \
 WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan rog-nv-wsl" \
      SSH_HOLD_ANSWERS="$HOLDER_SILENT" "$WL" kick-wsl --hold rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && ! grep -q 'holder observed on rog' <<<"$out" \
  && grep -q 'wsl HOLD FAILED on: rog' <<<"$out" \
  && ok "a handshake the wait cut short is not reported as a holder observed (rc=$rc)" \
  || ko "an unanswered handshake read as success (rc=$rc) -- $out"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -z "$(echo "$SSH_HOLD_DIR"/guest.*)" ] && break
  ls "$SSH_HOLD_DIR"/guest.* >/dev/null 2>&1 || break
  sleep 1
done
ls "$SSH_HOLD_DIR"/guest.* >/dev/null 2>&1 \
  && ko "a failed hold left a guest shell running in the VM: $(cat "$SSH_HOLD_DIR"/guest.* 2>/dev/null)" \
  || ok "...and the guest shell it spawned ended with the channel it was reached over"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1
# ...and the lock process is identified before it is signalled, exactly as the holder is: a record
# outlives both, and by the time anyone runs `unhold` the number may belong to something else.
reset_hold_state
held_kick "rog-lan rog-nv-wsl" "$HOLDER_ANSWERS" >/dev/null 2>&1
sc_pid=$(cut -d' ' -f4 "$TMP/state/hold-rog.pid" 2>/dev/null)
sleep 30 & bystander=$!
printf '%s rog-lan %s %s\n' "$(cut -d' ' -f1 "$TMP/state/hold-rog.pid")" "$(date +%s)" "$bystander" \
  > "$TMP/state/hold-rog.pid"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" SSH_UP="rog-lan" "$WL" unhold rog >/dev/null 2>&1
alive "$bystander" \
  && ok "a recorded lock pid that is not the lock process is left alone by unhold" \
  || ko "unhold killed an unrelated process recorded as the lock"
kill "$bystander" 2>/dev/null; kill "$sc_pid" 2>/dev/null; reset_hold_state

# The holder's signature is read from `ps`, and macOS `ps` truncates the argument list to the
# output width unless it is asked not to. This command line runs well past 79 columns, so a
# truncated reading matches nothing and every live holder would look like somebody else's process
# -- a false negative that fails the hold and deletes the record without killing the holder. The
# fixture cannot make a pipe narrow, so the guard is on the invocation itself.
grep -q 'ps -ww -o args=' "$HERE/wake-lab-wsl.sh" \
  && ok "the holder signature is read with ps -ww, which macOS does not truncate" \
  || ko "ps is called without -ww: on macOS the signature is cut off and no holder is ever recognized"
# Leave no holder running into the cases below: a live holder carries its box's lab lock, which is
# the point of the design, and the restart cases that follow would be refused by it.
for b in rog minix; do
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_STATE_DIR="$TMP/state" "$WL" unhold "$b" >/dev/null 2>&1
done
reset_hold_state

# --- a wedged wsl.exe is bounded, and the guest is what settles it ------------------------------
# 2026-09-16: `--wait --restart-wsl rog minix` ran 2h40m without exiting. ssh's ConnectTimeout
# bounds the TCP connect alone, so once the Windows side accepted the connection and `wsl.exe -d
# Ubuntu -e true` wedged, the ssh had no upper bound at all -- and the scheduled sweep that called
# it hung behind it. Each remote command now runs under a wall-clock cap. The caps are cut to a
# few seconds here; the shim wedges with `exec sleep 900`, so a run that still finishes proves the
# cap fired and nothing else.
hang() { # hang <regex> <up-list> <verb...> -- a restart with some remote commands wedged
  local re=$1 up=$2; shift 2
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
      WAKE_LAB_WSL_SHUTDOWN_CAP=3 WAKE_LAB_WSL_START_CAP=3 \
      SSH_HANG="$re" SSH_UP="$up" "$WL" "$@"
}
# The incident's own shape, and its own resolution: the start probe never returns, and the VM has
# in fact started -- `uptime -p` inside rog's guest matched the restart to the minute while the
# Windows-side probe was still stuck. So the cap is not a failure. The guest is asked directly over
# the -wsl alias, which answered instantly throughout that morning, and its answer is the verdict.
: > "$SSH_LOG"; started=$SECONDS
out=$(hang '^rog-lan :: wsl\.exe -d Ubuntu' "rog-lan rog-nv-win rog-nv-wsl" restart-wsl rog 2>&1); rc=$?
elapsed=$((SECONDS - started))
[ "$elapsed" -lt 30 ] && ok "a wedged start probe is cut short by its cap instead of hanging (${elapsed}s)" \
  || ko "the run took ${elapsed}s against a 3s cap: the remote command is still unbounded"
[ "$rc" -eq 0 ] && grep -q 'wsl start probe timed out after 3s on rog (via rog-lan); the guest answers, so the VM is up' <<<"$out" \
  && grep -q 'wsl up' <<<"$out" \
  && ok "...and a guest that answers over its own alias settles it as up, not as a failed restart (rc=$rc)" \
  || ko "a capped start probe over a live guest did not read as up (rc=$rc) -- $out"
grep -q '^rog-nv-wsl :: exit 0$' "$SSH_LOG" \
  && ok "...having really asked the guest, over the -wsl alias the wedged Windows side is not on" \
  || ko "the guest was never probed after the cap fired: $(cat "$SSH_LOG")"
# With no guest answering there is no verdict yet, and the poll already has one: it asks the guest,
# on its own deadline. What must NOT happen is a fall through to the next alias -- in the restart
# path that is a second `wsl --shutdown`, tearing down the VM the wedged start may just have booted.
: > "$SSH_LOG"
out=$(hang 'wsl\.exe -d Ubuntu' "rog-lan rog-nv-win" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'leaving the verdict to the guest poll' <<<"$out" \
  && grep -q 'wsl still down after 0 min on: rog' <<<"${out##*$'\n'}" && ! grep -q 'wsl up' <<<"$out" \
  && ok "...while a capped start with a silent guest is left to the poll, which fails it (rc=$rc)" \
  || ko "a capped start with no guest answering was not left to the poll (rc=$rc) -- $out"
[ "$(grep -c -- 'wsl.exe --shutdown' "$SSH_LOG")" -eq 1 ] \
  && ok "...and no second shutdown is issued onto the VM that start may have booted" \
  || ko "the capped start retried the whole restart on the next alias: $(cat "$SSH_LOG")"
# A wedged `wsl --shutdown` is the dangerous one: its status says nothing, and the restart's whole
# invariant is that no live old VM survives it. So the guest decides again -- and here it decides
# against. A guest still answering means the teardown has not taken, this alias has not carried the
# restart, and no start may be issued onto the VM left standing.
: > "$SSH_LOG"
out=$(hang 'wsl\.exe --shutdown' "rog-lan rog-nv-win rog-nv-wsl" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'wsl shutdown TIMED OUT after 3s on rog (via rog-lan); the guest still answers, so the old VM stands' <<<"$out" \
  && grep -q 'wsl restart FAILED on: rog (shutdown refused' <<<"${out##*$'\n'}" && ! grep -q 'wsl up' <<<"$out" \
  && ok "a wedged shutdown over a guest that still answers is a failed restart, never 'wsl up' (rc=$rc)" \
  || ko "a capped shutdown over a live old guest read as success (rc=$rc) -- $out"
grep -q 'wsl.exe -d Ubuntu' "$SSH_LOG" \
  && ko "a start was issued onto the VM the capped shutdown left standing: $(cat "$SSH_LOG")" \
  || ok "...and no start is issued onto it"
# A SILENT guest is not the opposite evidence, and reading it that way was a real defect (PR #165
# round 1, P1). The -wsl alias rides tailscaled inside the guest, which this suite's own subject
# documents as lagging minutes behind a running VM, so "no guest answers" is the everyday reading
# of a VM that is perfectly alive. Starting on it attaches to the old VM and then reports the
# fresh restart the sweep waits for -- the stale bridge restart-wsl exists to replace. So a capped
# shutdown is unconfirmed whichever way the guest goes, and NO start may follow it on that alias.
: > "$SSH_LOG"
out=$(hang 'wsl\.exe --shutdown' "rog-lan rog-nv-win" restart-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'no guest answers, but a silent guest is not a stopped VM — the teardown is unconfirmed' <<<"$out" \
  && ! grep -q 'wsl up' <<<"$out" && grep -q 'wsl restart FAILED on: rog (shutdown refused' <<<"${out##*$'\n'}" \
  && ok "a capped shutdown is unconfirmed even with a silent guest, and fails the restart (rc=$rc)" \
  || ko "a capped shutdown with a silent guest was treated as a teardown (rc=$rc) -- $out"
grep -q 'wsl.exe -d Ubuntu' "$SSH_LOG" \
  && ko "a start was issued after a shutdown that was never confirmed: $(cat "$SSH_LOG")" \
  || ok "...issuing no start on evidence that cannot tell a stopped VM from a lagging tailscaled"
grep -c -- 'wsl.exe --shutdown' "$SSH_LOG" | grep -qx 2 \
  && ok "...and retrying the whole restart on the other alias first" \
  || ko "the capped shutdown did not fall through to the second alias: $(cat "$SSH_LOG")"

# A plain kick has no shutdown to repeat and a second start is idempotent, so a wedged LAN side
# must not cost the box the start its Tailscale alias would have carried (PR #165 round 1, P2).
# The restart path keeps the opposite rule, pinned above: it must NOT fall through.
# The guest must be SILENT here: a guest that answers settles the cap on the spot, and the
# fallback this pins exists only for the case where nothing has answered yet. The poll then fails
# the step (no guest ever answers in this fixture), so the evidence is the start on the second
# alias, not the exit status.
: > "$SSH_LOG"
out=$(hang '^rog-lan :: wsl\.exe -d Ubuntu' "rog-lan rog-nv-win" kick-wsl rog 2>&1)
grep -q 'wsl started on rog (via rog-nv-win)' <<<"$out" \
  && grep -q '^rog-nv-win :: wsl.exe -d Ubuntu' "$SSH_LOG" \
  && ok "a plain kick whose start wedges on one alias is carried by the other" \
  || ko "a wedged plain kick never tried the second alias -- $out; $(cat "$SSH_LOG")"
# And when every alias wedges, the cap is still not a failure: the poll gets the box.
: > "$SSH_LOG"
out=$(hang 'wsl\.exe -d Ubuntu' "rog-lan rog-nv-win" kick-wsl rog 2>&1); rc=$?
[ "$rc" -ne 0 ] && grep -q 'start probe timed out on every alias on rog' <<<"$out" \
  && grep -q 'wsl still down after 0 min on: rog' <<<"${out##*$'\n'}" \
  && ok "...and a kick that wedges on every alias is left to the poll, not called a failed kick (rc=$rc)" \
  || ko "a kick wedged on every alias was not handed to the poll (rc=$rc) -- $out"

# --- one wedged box must not cost its neighbours their restart ----------------------------------
# The second half of the 2026-09-16 damage. The loop over boxes was serialized, so while rog's
# probe hung minix never got a restart at all: its VM sat eleven hours old and the sweep's hip unit
# went red on exactly the stale-dxg condition restart-wsl exists to clear (ludics-lite#60).
: > "$SSH_LOG"
out=$(hang '^rog-(lan|nv-win) :: wsl\.exe' "rog-lan rog-nv-win minix-lan minix-amd-wsl" restart-wsl rog minix 2>&1); rc=$?
grep -q '^minix-lan :: wsl.exe --shutdown$' "$SSH_LOG" && grep -q '^minix-lan :: wsl.exe -d Ubuntu' "$SSH_LOG" \
  && ok "a box whose Windows side wedges does not stop its neighbour getting its restart" \
  || ko "minix never got its restart while rog was wedged: $(cat "$SSH_LOG")"
# rog's own outcome is a shutdown failure -- its capped shutdown is unconfirmed on both aliases,
# which is the P1 rule above -- while minix's is a clean restart. Each box is named for what
# happened to IT; the wedge is not charged to the neighbour.
[ "$rc" -ne 0 ] && grep -q '^wsl up on: minix$' <<<"$out" && grep -q 'wsl restart FAILED on: rog' <<<"$out" \
  && ok "...and the report still names each box's own outcome (rc=$rc)" \
  || ko "the wedged box's outcome was pinned on its neighbour (rc=$rc) -- $out"
# ...and they really are kicked at once, not merely bounded one after another: two boxes wedged
# against a 12s cap cost one cap between them concurrently and two serialized. The numbers have to
# respect the poll's 5s granularity, because a guest probe that misses its first round adds
# exactly one of those to either arm: concurrent is 12s or 17s, serialized 24s or 29s, so 20s is
# the only threshold with a clear margin on both sides. And PROBE_CAP is left at its default, as
# it is in the wedge cases above -- shrinking it to a couple of seconds is what makes that missed
# round likely in the first place: on a loaded machine the shim's own fork can outlast a 3s cap,
# and the probe then fails for reasons that have nothing to do with what is being measured.
started=$SECONDS
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_WSL_START_CAP=12 \
    SSH_HANG='wsl\.exe -d Ubuntu' SSH_UP="rog-lan minix-lan rog-nv-wsl minix-amd-wsl" \
    "$WL" kick-wsl rog minix 2>&1); rc=$?
elapsed=$((SECONDS - started))
[ "$rc" -eq 0 ] && grep -q '^wsl up$' <<<"$out" \
  && ok "two wedged start probes both fall back to their own guest (rc=$rc)" \
  || ko "the two-box fallback did not end in wsl up (rc=$rc) -- $out"
[ "$elapsed" -lt 20 ] && ok "...costing one cap between them, not one each (${elapsed}s)" \
  || ko "the kick still runs box by box: ${elapsed}s for two boxes against a 12s cap"

# --- a capped call leaves nothing of itself behind ----------------------------------------------
# capped()'s watchdog naps in a child. Killing the watchdog alone left that nap orphaned for the
# rest of its interval -- two minutes, at the default start cap -- holding an inherited copy of
# every descriptor the run had open. Stray processes were the visible half; the half that bites is
# that an inherited descriptor keeps its resource alive after the caller has dropped it, which is
# how this surfaced against the lab lock. The caps here are absurd values (3117/3118/3119) so a
# survivor is unmistakably one of ours and no real sleep can be mistaken for it.
naps() { ps -eo pid,command 2>/dev/null | awk '/sleep 311[789]$/ { print $1 }'; }
reap_naps() { local p; for p in $(naps); do kill -KILL "$p" 2>/dev/null; done; }
# The negative control first: a scan that cannot fail proves nothing. This is exactly the old
# shape -- a watchdog whose sleep runs in its foreground, killed outright -- and it must leave a
# survivor, or the assertion below is vacuous. The command is `sleep 1` rather than something
# instant on purpose: a watchdog whose command finishes immediately is killed before it ever forks
# its nap, so the control leaves no orphan and proves nothing. An instant command here once
# reported zero orphans and nearly confirmed that the leak did not exist.
reap_naps
( cmd_pid=""; sleep 1 & cmd_pid=$!
  { sleep 3117; } >/dev/null 2>&1 & dog=$!
  wait "$cmd_pid"; kill -KILL "$dog" 2>/dev/null; wait "$dog" 2>/dev/null ) >/dev/null 2>&1
[ "$(naps | wc -l | tr -d ' ')" -ge 1 ] \
  && ok "the stray-nap scan catches a watchdog killed without its sleep" \
  || ko "the stray-nap scan sees nothing even for the leaking shape, so its verdict below is vacuous"
reap_naps
# A restart makes several capped calls -- a shutdown, a start, and the probes around them -- and
# every one of them must come back with its watchdog fully reaped.
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 \
    WAKE_LAB_WSL_SHUTDOWN_CAP=3118 WAKE_LAB_WSL_START_CAP=3117 WAKE_LAB_PROBE_CAP=3119 \
    SSH_UP="rog-lan rog-nv-wsl" "$WL" restart-wsl rog >/dev/null 2>&1
[ "$(naps | wc -l | tr -d ' ')" -eq 0 ] \
  && ok "...and a restart's capped calls leave no nap of their own behind" \
  || ko "a capped call orphaned its watchdog's sleep: $(ps -eo pid,command | awk '/sleep 311[789]$/')"
reap_naps
# The same when the cap actually FIRES: the watchdog is then mid-grace, napping again, and the old
# shape leaked that second sleep just as readily as the first.
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 WAKE_LAB_WSL_START_CAP=2 \
    WAKE_LAB_WSL_SHUTDOWN_CAP=3118 WAKE_LAB_PROBE_CAP=3119 \
    SSH_HANG='wsl\.exe -d Ubuntu' SSH_UP="rog-lan rog-nv-win" "$WL" restart-wsl rog >/dev/null 2>&1
[ "$(naps | wc -l | tr -d ' ')" -eq 0 ] \
  && ok "...nor does one whose cap fired and whose watchdog was mid-grace" \
  || ko "a fired cap orphaned its grace sleep: $(ps -eo pid,command | awk '/sleep 311[789]$/')"
reap_naps

# --- the lab lock stops a restart destroying someone else's VM ----------------------------------
# 2026-09-16, the third and most expensive shape of the same day: `wsl.exe --shutdown` is
# host-global, so a restart issued while the cross-machine sweep was 13 minutes into rog-nv/cuda
# and minix/hip destroyed both VMs and both units. The sweep recorded `error`, which reads as a box
# fault, and it was misattributed to the GPU autotune tests for two days. The lock is the interlock
# that was missing; these cases pin that it actually refuses, and that it refuses ONLY the
# destructive path.
# Held the way the sweep holds it: a descriptor kept open, flock taken by a perl that exits. The
# lock belongs to the open file description, so it outlives that perl and dies with this shell --
# which is the property the whole contract rests on, so take it here exactly as the real holder does
# rather than simulating a held lock with a flag file.
hold_lock() { # hold_lock <box> <description>
  printf '%s\n' "$2" > "$LOCKS/$1.lock"
  eval "exec $3>>\"$LOCKS/$1.lock\""
  perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&"$3"
}
wl_locked() { # wl_locked <args...> -- a run with both boxes' guests answering and the lock dir live
  # `8>&-`: the checker must not inherit the HOLDER's descriptor. An flock lives until every
  # descriptor onto that open file description is closed, so a child that inherited one keeps the
  # lock alive after the holder let go -- and wake-lab's own `capped` leaves its watchdog `sleep`
  # orphaned for the length of the cap, which would hold this test's lock for two minutes after
  # `exec 8>&-`. In production the checker is a separate process that never had the descriptor at
  # all, so closing it here is what models the real thing; the case below pins the property itself.
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_WSL_WAIT_SECONDS=1 \
      SSH_UP="rog-lan minix-lan rog-nv-wsl minix-amd-wsl" "$WL" "$@" 2>&1 8>&-
}
if hold_lock minix 'sweep 20260916T074913Z (pid 999, since 20260916T074913Z)' 8; then
  ok "the lab lock can be taken the way a harness takes it"
else
  ko "could not take a test lab lock -- the cases below prove nothing"
fi

: > "$SSH_LOG"
out=$(wl_locked restart-wsl rog minix); rc=$?
grep -q '^minix-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ko "a held box was shut down anyway -- the interlock does not hold: $(cat "$SSH_LOG")" \
  || ok "a restart does not shut down a box whose lab lock is held"
[ "$rc" -ne 0 ] && grep -q 'REFUSED on: minix' <<<"$out" \
  && ok "...and the step FAILS rather than reporting a fresh VM it did not make (rc=$rc)" \
  || ko "a refused box did not fail the step (rc=$rc) -- $out"
grep -q 'sweep 20260916T074913Z' <<<"$out" \
  && ok "...and the refusal names the holder, so the operator knows what to wait for" \
  || ko "the refusal does not say who holds the box -- $out"
# The neighbour rule of the wedge cases above, applied to the lock: one held box must not cost the
# others their restart, and `wsl up` must never appear unqualified over a box that was refused.
grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ok "...and its neighbour still gets its restart" \
  || ko "a held box cost its neighbour the restart: $(cat "$SSH_LOG")"
grep -q '^wsl up$' <<<"$out" \
  && ko "the run claimed a blanket 'wsl up' over a refused box -- $out" \
  || ok "...and the verdict is never a blanket 'wsl up' while a box was refused"

# --force is the override, and it is the ONLY thing that takes a held box.
: > "$SSH_LOG"
out=$(wl_locked restart-wsl --force minix); rc=$?
[ "$rc" -eq 0 ] && grep -q '^minix-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && ok "--force takes a held box anyway (rc=$rc)" \
  || ko "--force did not override the lock (rc=$rc) -- $out"

# A plain kick starts a VM that is already running as a no-op: it cannot cost a holder anything,
# and gating it would make `kick-wsl` -- the recovery command for a box with no VM at all --
# refusable at exactly the moment it is needed.
: > "$SSH_LOG"
out=$(wl_locked kick-wsl minix); rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'shutdown' "$SSH_LOG" \
  && ok "a plain kick is not gated by the lock, and still shuts nothing down (rc=$rc)" \
  || ko "the lock gated a non-destructive kick (rc=$rc) -- $out $(cat "$SSH_LOG")"

# A free box is the ordinary case and must be untouched by any of this.
: > "$SSH_LOG"
out=$(wl_locked restart-wsl rog); rc=$?
[ "$rc" -eq 0 ] && grep -q '^wsl up$' <<<"$out" \
  && ok "a box whose lock is free restarts exactly as before (rc=$rc)" \
  || ko "the lock broke the ordinary restart (rc=$rc) -- $out"

# An INHERITED descriptor holds the lock too, and that is the semantics to want rather than a
# wart: a child still talking to the box means the box is still in use, so it stays reserved. It is
# also the sweep's own run lock's behaviour, where an orphaned dune keeping the worktree locked is
# documented as correct. The consequence to know is that a holder's lock outlives it for as long as
# any inheriting child runs, and `--force` is the way past one that has outstayed its welcome.
sleep 30 8>&8 &
inheritor=$!
exec 8>&-
out=$(wl_locked restart-wsl minix); rc=$?
[ "$rc" -ne 0 ] && grep -q 'REFUSED on: minix' <<<"$out" \
  && ok "a child that inherited the descriptor keeps the box reserved (rc=$rc)" \
  || ko "the lock died while an inheriting child was still running (rc=$rc) -- $out"
expect "...and --force is the way past it" 0 "wsl up" -- \
  env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_WSL_WAIT_SECONDS=1 \
      SSH_UP="rog-lan minix-lan rog-nv-wsl minix-amd-wsl" "$WL" restart-wsl --force minix

# Released with the holder: the sweep's lock dies with the sweep however it dies, which is why
# there is nothing to reclaim after a crash.
kill -KILL "$inheritor" 2>/dev/null; wait "$inheritor" 2>/dev/null
out=$(wl_locked restart-wsl minix); rc=$?
[ "$rc" -eq 0 ] \
  && ok "...and a lock whose holders are all gone stops refusing, with nothing to reclaim (rc=$rc)" \
  || ko "a released lock still refuses (rc=$rc) -- $out"

# The reservation is HELD ACROSS the shutdown, not checked before it. A restarter that only probes
# the lock leaves a window between its check and its `wsl.exe --shutdown` — and a holder that
# reserves the box inside that window is destroyed by a restart that had already decided it was
# allowed to proceed, which is the exact race the interlock exists to close. Observed from the far
# side: the ssh shim tests the lock at the instant the shutdown is issued.
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_WSL_WAIT_SECONDS=1 \
    SSH_UP="rog-lan minix-lan rog-nv-wsl minix-amd-wsl" LOCK_PROBE="$LOCKS/rog.lock" \
    "$WL" restart-wsl rog 2>&1 8>&-); rc=$?
grep -q '^lock HELD during .*--shutdown$' "$SSH_LOG" \
  && ok "the box stays reserved for the length of its own restart (rc=$rc)" \
  || ko "the lock was free when the shutdown landed — the check/act race is open: $(cat "$SSH_LOG")"

# Power actions take the box away just as surely: hibernate terminates the VM outright, `down` is a
# full host shutdown, and `sleep` suspends the host under whatever is running on it.
if hold_lock minix 'sweep 20260916T074913Z (pid 999, since 20260916T074913Z)' 8; then
  ok "the lab lock can be retaken for the power-action cases"
else
  ko "could not retake a test lab lock -- the power cases below prove nothing"
fi
for verb in hibernate down sleep; do
  : > "$SSH_LOG"
  out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
      SSH_UP="minix-lan minix-amd-win" "$WL" "$verb" minix 2>&1 8>&-); rc=$?
  if [ "$rc" -ne 0 ] && grep -q "$verb REFUSED on: minix" <<<"$out" && ! grep -q 'shutdown /\|SetSuspendState' "$SSH_LOG"; then
    ok "$verb refuses a reserved box, and sends nothing (rc=$rc)"
  else
    ko "$verb went through on a reserved box (rc=$rc) -- $out $(cat "$SSH_LOG")"
  fi
done
# ...and a refused box is not then polled for the DOWN signal, which would report the holder's
# live machine as a failure to go down.
grep -q 'confirming' <<<"$out" \
  && ko "a refused box was polled for the down signal -- $out" \
  || ok "...and a refused box is not confirmed down"
# --force is the same override here as everywhere else.
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="minix-lan minix-amd-win" "$WL" hibernate --force minix 2>&1 8>&-); rc=$?
grep -q 'shutdown /h' "$SSH_LOG" \
  && ok "--force hibernates a reserved box anyway (rc=$rc)" \
  || ko "--force did not override the lock for a power action (rc=$rc) -- $out $(cat "$SSH_LOG")"
# A free box is unaffected.
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-lan rog-nv-win" "$WL" hibernate rog 2>&1 8>&-); rc=$?
grep -q 'shutdown /h' "$SSH_LOG" && grep -q 'confirming' <<<"$out" \
  && ok "a box whose lock is free hibernates exactly as before (rc=$rc)" \
  || ko "the lock broke the ordinary power action (rc=$rc) -- $out $(cat "$SSH_LOG")"
# A site table still naming WSL can outlive a boot into native Linux. The Windows SSH alias
# then fails before the command starts; probing only Windows afterward must not call that sleep.
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-nv-linux" "$WL" sleep rog 2>&1 8>&-); rc=$?
[ "$rc" -eq 1 ] && grep -q 'Windows power command did not start' <<<"$out" \
  && ! grep -q 'confirming' <<<"$out" \
  && ok "a WSL-configured box booted into native Linux cannot report a successful sleep" \
  || ko "a missing Windows endpoint was treated as a power transition (rc=$rc) -- $out"
rm -f "$TMP/power-down.list"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-nv-win" SSH_POWER_DROP_AFTER_MARKER=1 \
    SSH_DOWN_LIST="$TMP/power-down.list" SSH_DOWN_AFTER='WAKE_LAB_POWER_STARTED|rog-nv-win' \
    "$WL" sleep rog 2>&1 8>&-); rc=$?
[ "$rc" -eq 0 ] && grep -q 'unconfirmed (connection dropped or timed out)' <<<"$out" \
  && grep -q 'confirming' <<<"$out" \
  && ok "a dropped Windows power connection is provisional only after its start marker" \
  || ko "a started Windows sleep was lost on SSH disconnect (rc=$rc) -- $out"
# cmd.exe keeps a blank before `&` in what `echo` prints (#394): the command has none, and the
# marker line is read with its trailing blanks and `\r` stripped, so `MARKER \r\n` still counts...
grep -q 'echo WAKE_LAB_POWER_STARTED& ' "$SSH_LOG" && ! grep -q 'echo WAKE_LAB_POWER_STARTED &' "$SSH_LOG" \
  && ok "the Windows power command puts no blank between its start marker and \`&\`" \
  || ko "the Windows power command's marker carries a blank before \`&\` -- $(cat "$SSH_LOG")"
rm -f "$TMP/power-down.list"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-nv-win" SSH_POWER_DROP_AFTER_MARKER=1 SSH_POWER_MARKER='WAKE_LAB_POWER_STARTED ' \
    SSH_DOWN_LIST="$TMP/power-down.list" SSH_DOWN_AFTER='WAKE_LAB_POWER_STARTED|rog-nv-win' \
    "$WL" sleep rog 2>&1 8>&-); rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'did not start' <<<"$out" && grep -q 'confirming' <<<"$out" \
  && ok "a start marker returned with a trailing blank still counts as started (rc=$rc)" \
  || ko "a started Windows sleep was refused over the marker's trailing blank (rc=$rc) -- $out"
# ...and the match is still exact: a line that merely contains the marker is not it.
rm -f "$TMP/power-down.list"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-nv-win" SSH_POWER_DROP_AFTER_MARKER=1 SSH_POWER_MARKER='WAKE_LAB_POWER_STARTED & shutdown /h' \
    SSH_DOWN_LIST="$TMP/power-down.list" SSH_DOWN_AFTER='WAKE_LAB_POWER_STARTED|rog-nv-win' \
    "$WL" hibernate rog 2>&1 8>&-); rc=$?
[ "$rc" -eq 1 ] && grep -q 'Windows power command did not start' <<<"$out" && ! grep -q 'confirming' <<<"$out" \
  && ok "...while a line that only contains the marker is still not the marker" \
  || ko "the marker match accepted a line that is not the marker (rc=$rc) -- $out"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-lan rog-nv-win" SSH_POWER_FAIL=1 "$WL" hibernate rog 2>&1 8>&-); rc=$?
[ "$rc" -eq 1 ] && grep -q 'hibernate FAILED on rog (command exited 2)' <<<"$out" \
  && ! grep -q 'confirming' <<<"$out" \
  && ok "a definite Windows power refusal fails even after its start marker" \
  || ko "a refused Windows power command looked successful (rc=$rc) -- $out"
exec 8>&-

# The reservation spans the EFFECT, not the command. A dropped ssh means the suspend was
# INITIATED; until the box actually goes down it still answers, so a reservation released when
# `power_action` returns lets another harness take the lock and start work the pending transition
# destroys. Observed the same way as the restart race: the shim tests the lock as each command is
# issued, and the CONFIRMATION probes come after the power command — so the last reading is the one
# that says whether the box was still reserved while it was going down.
: > "$SSH_LOG"
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    SSH_UP="rog-lan rog-nv-win" LOCK_PROBE="$LOCKS/rog.lock" \
    "$WL" hibernate rog 2>&1 8>&-); rc=$?
grep -q 'shutdown /h' "$SSH_LOG" \
  && ok "a free box is hibernated (rc=$rc)" \
  || ko "the power action never went out (rc=$rc) -- $out $(cat "$SSH_LOG")"
# More than one reading (so the confirmation really did probe after the power command), and not
# one of them free.
[ "$(grep -c '^lock ' "$SSH_LOG")" -gt 1 ] && ! grep -q '^lock FREE' "$SSH_LOG" \
  && ok "...and stays reserved through the confirmation, not just the command" \
  || ko "the reservation was released before the box was down: $(grep '^lock ' "$SSH_LOG")"

# Every reservation belongs to the process that ACTS, not to a chain of ancestors. An earlier
# version reserved box N at recursion level N, each level a subshell, so killing the top-level
# command released the FIRST box's lock while the surviving descendant went on issuing and
# confirming its suspend — freeing a box whose power transition was still pending, which is the
# whole hazard the reservation exists to prevent. Killing the command must free every box or none.
file_free() { # file_free <path> — true iff nothing holds that lock file
  [ -e "$1" ] || return 0
  perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <"$1" 2>/dev/null
}
# A destroyer takes BOTH of a box's locks, so "reserved" means neither is free: a phase that held
# only the lane lock would leave the VM destroyable by a concurrent `--hold`, and one that held
# only the hold lock would leave a sweep lane free to start work the pending suspend destroys.
lock_free() { # lock_free <box> — true iff nothing holds EITHER of that box's locks
  file_free "$LOCKS/$1.lock" && file_free "$LOCKS/$1.hold.lock"
}
: > "$SSH_LOG"
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=60 \
    SSH_UP="rog-lan rog-nv-win minix-lan minix-amd-win" \
    "$WL" hibernate rog minix >"$TMP/phase.out" 2>&1 8>&- &
phase_pid=$!
# Wait for the phase to have reserved both boxes and reached its confirmation loop.
phase_deadline=$((SECONDS + 20))
while lock_free rog || lock_free minix; do
  [ "$SECONDS" -ge "$phase_deadline" ] && break
  sleep 1
done
if ! lock_free rog && ! lock_free minix; then
  ok "a multi-box power command reserves every box it acts on"
else
  ko "the phase did not hold both boxes (rog free=$(lock_free rog && echo yes || echo no), minix free=$(lock_free minix && echo yes || echo no))"
fi
kill "$phase_pid" 2>/dev/null
wait "$phase_pid" 2>/dev/null
# A moment for any child that inherited the descriptors to go with it -- confirm_down's `sleep` is
# one, and the inherited-descriptor rule above is why it counts.
kill_deadline=$((SECONDS + 20))
while ! lock_free rog || ! lock_free minix; do
  [ "$SECONDS" -ge "$kill_deadline" ] && break
  sleep 1
done
if lock_free rog && lock_free minix; then
  ok "...and killing it frees every one of them, not just the outermost"
else
  ko "a box stayed reserved after the command was killed (rog free=$(lock_free rog && echo yes || echo no), minix free=$(lock_free minix && echo yes || echo no))"
fi

# ludics-lite#445: a power phase reads the registry once it holds every box, and a measured box
# among them is let go at once -- both of its locks, while the phase goes on acting on the others.
: > "$SSH_LOG"
env FW_LISTING='[{"request_id":"m-445","request":{"execution_host":"rog-nv-win","kind":"measurement"},"state":"running"}]' \
    WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=60 \
    SSH_UP="rog-lan rog-nv-win minix-lan minix-amd-win" \
    "$WL" hibernate rog minix >"$TMP/phase.out" 2>&1 8>&- &
phase_pid=$!
phase_deadline=$((SECONDS + 20))
while lock_free minix || ! grep -q 'hibernate REFUSED on rog' "$TMP/phase.out"; do
  [ "$SECONDS" -ge "$phase_deadline" ] && break
  sleep 1
done
if ! lock_free minix && lock_free rog; then
  ok "a power phase lets a measured box go at once while it still acts on its neighbour"
else
  ko "measured rog or acting minix held wrongly mid-phase (rog free=$(lock_free rog && echo yes || echo no), minix free=$(lock_free minix && echo yes || echo no)) -- $(cat "$TMP/phase.out")"
fi
grep -q '^rog-' "$SSH_LOG" && ko "the phase sent a command to the measured box: $(grep '^rog-' "$SSH_LOG")" \
  || ok "...and sends nothing to the measured box"
kill "$phase_pid" 2>/dev/null
wait "$phase_pid" 2>/dev/null
kill_deadline=$((SECONDS + 20))
while ! lock_free minix; do [ "$SECONDS" -ge "$kill_deadline" ] && break; sleep 1; done

# Half a reservation is worse than none. A destroyer takes the lane lock first and the hold lock
# second, and if the second is refused -- a `--hold` holder is on that box -- it must give the
# first one back: a lane lock kept by a command that is not going to act would block the very sweep
# the holder was taken for, which is the deadlock ludics-lite#224 is about, re-entered from the
# other side.
printf 'wake-lab --hold (pid 999, since 20260918T050814Z)\n' > "$LOCKS/minix.hold.lock"
exec 7>>"$LOCKS/minix.hold.lock"
if perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7; then
  ok "a box's hold lock can be taken the way a holder takes it"
else
  ko "could not take a test hold lock -- the cases below prove nothing"
fi
: > "$SSH_LOG"
out=$(wl_locked restart-wsl minix); rc=$?
[ "$rc" -ne 0 ] && ! grep -q '^minix-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
  && grep -q 'wake-lab --hold (pid 999' <<<"$out" \
  && ok "a restart is refused by the HOLD lock alone, with the lane lock free (rc=$rc)" \
  || ko "a held VM was restarted with no lane on the box (rc=$rc) -- $out; $(cat "$SSH_LOG")"
# `-e` as well as free: `file_free` calls a lock file that does not exist free, so the assertion
# without it would also pass over a destroyer that never opened the lane lock at all -- which is
# not what is being claimed, and would hide the take going missing.
[ -e "$LOCKS/minix.lock" ] && file_free "$LOCKS/minix.lock" \
  && ok "...and the lane lock it took on the way to that refusal is given back" \
  || ko "a refused destroyer kept the lane lock, or never took it: $(head -1 "$LOCKS/minix.lock" 2>/dev/null)"
exec 7>&-
# Nothing of the suite's own is left holding it, so the box is ordinary again.
out=$(wl_locked restart-wsl minix); rc=$?
[ "$rc" -eq 0 ] \
  && ok "...and the box restarts normally once the hold is released (rc=$rc)" \
  || ko "the released hold lock still refuses (rc=$rc) -- $out"

# Three boxes in ONE command, which is where bash 3.2's descriptor ceiling bites: a destroyer holds
# two descriptors per box, and bash parks a redirection's displaced fd on the first free one at or
# above 10 -- so a reservation that counted up into 10 opened its lock onto the slot holding this
# shell's stderr and had it closed again underneath, reporting the box as somebody else's. Every
# lock descriptor therefore stays below 10, and the whole host table has to fit.
cat > "$TMP/hosts3.sh" <<'HOSTS3'
mac_of() { case "$1" in
  rog)   echo aa:bb:cc:00:00:01 ;;
  minix) echo aa:bb:cc:00:00:03 ;;
  tuf)  echo aa:bb:cc:00:00:05 ;;
  *) return 1 ;; esac; }
eth_mac_of() { mac_of "$1"; }
ip_of() { case "$1" in
  rog)   echo 10.0.0.1 ;;
  minix) echo 10.0.0.2 ;;
  tuf)  echo 10.0.0.3 ;;
  *) return 1 ;; esac; }
kind_of() { case "$1" in
  rog|minix|tuf) echo wsl ;;
  *) return 1 ;; esac; }
HOSTS3
out=$(env WAKE_LAB_HOSTS="$TMP/hosts3.sh" "$WL" status all 2>&1); rc=$?
[ "$rc" -eq 0 ] && grep -Eq '^tuf[[:space:]]' <<<"$out" && ! grep -Eq '^asus[[:space:]]' <<<"$out" \
  && ok "all expands to the renamed TUF box, with no separate ASUS target" \
  || ko "all still uses a stale laptop name (rc=$rc) -- $out"
env WAKE_LAB_HOSTS="$TMP/hosts3.sh" WAKE_LAB_LOCK_DIR="$LOCKS" WAKE_LAB_DOWN_WAIT_SECONDS=60 \
    SSH_UP="rog-lan rog-nv-win minix-lan minix-amd-win tuf-amd-win" \
    "$WL" hibernate rog minix tuf >"$TMP/phase3.out" 2>&1 8>&- &
phase3_pid=$!
phase3_deadline=$((SECONDS + 20))
while lock_free rog || lock_free minix || lock_free tuf; do
  [ "$SECONDS" -ge "$phase3_deadline" ] && break
  sleep 1
done
if ! lock_free rog && ! lock_free minix && ! lock_free tuf; then
  ok "all three boxes of the host table are reserved by one command, both locks each"
else
  ko "a third box could not be reserved -- the descriptors ran into bash's save slot (rog=$(lock_free rog && echo free || echo held), minix=$(lock_free minix && echo free || echo held), tuf=$(lock_free tuf && echo free || echo held))"
fi
grep -q 'REFUSED' "$TMP/phase3.out" \
  && ko "a box of the table was refused for want of a descriptor: $(grep REFUSED "$TMP/phase3.out")" \
  || ok "...and none of them was refused for want of one"
kill "$phase3_pid" 2>/dev/null
wait "$phase3_pid" 2>/dev/null
kill3_deadline=$((SECONDS + 20))
while ! lock_free rog || ! lock_free minix || ! lock_free tuf; do
  [ "$SECONDS" -ge "$kill3_deadline" ] && break
  sleep 1
done

# The path is the whole contract with the sweep, so it must not need the site table: the harness
# asking where to put its flock runs from a checkout with no business holding this lab's MACs.
out=$(env WAKE_LAB_HOSTS="$TMP/absent.sh" WAKE_LAB_LOCK_DIR="$LOCKS" "$WL" lock-path minix 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$LOCKS/minix.lock" ] \
  && ok "lock-path answers without the site file, at the path the holder must take (rc=$rc)" \
  || ko "lock-path did not answer the contract path without hosts.sh (rc=$rc) -- $out"

# --- the lock contract with the ocannl sweep, compared across the two repositories ---------------
# Every case above pins this side against a literal; none of them compares the two sides, and the
# interlock is an agreement between two repositories that nothing enforces. This script refuses to
# destroy a box whose lock is held, and ocannl-staging's `tools/sweep.sh` takes that lock itself.
# Which box an ssh alias reserves the sweep reads from this repository (its `lab_box_of` looks the
# alias up in `wake-lab.sh endpoint-map`'s answer, staging ac1dbc153); the rest it holds by hand, so
# three facts have to stay equal: the directory, the `<box>.lock` filename, and the box NAME that
# lookup yields. Every way they drift is silent in the safe-looking direction -- the two
# sides simply stop meeting, this script finds no lock, and a restart destroys a VM mid-sweep. That
# is the 2026-09-16 incident, which was read as a GPU fault for two days (ludics-lite#170).
#
# Three things make this a check and not a restatement.
#
# It reads the revision the sweep routine RUNS, which is `origin/master`: that routine extracts
# `tools` and `benchmarks` from it with `git archive` precisely because the checkout is often on a
# WIP branch (routines/ocannl-cross-machine-sweep/SKILL.md, "Always use origin/master's copy"). So
# the checkout is located as a GIT REPOSITORY and `git show` decides whether the file exists -- a
# WIP branch that moved or deleted `tools/sweep.sh` must not read as "no sweep here".
#
# It RUNS the sweep's own `take_lab_lock` rather than rebuilding its path from snippets, under a
# HOME of its own, and looks at which file appeared. A reconstruction agrees with itself even when
# the real code has moved on -- a stale assignment nothing uses would satisfy it. The file set is
# compared WHOLE, so the sweep taking anything besides the lane lock fails here too.
#
# And it pins the SYNCHRONISATION, not just the path: a lock file without a live flock stops
# nothing. The last two cases hold each side's real lock for real and check the other side's real
# behaviour against it -- which is the only form in which the contract is actually true, and which
# also covers `WAKE_LAB_LOCK_DIR` meaning the same thing to both (they redirect the sweep and read
# the result through this script).
#
# The anchors are REQUIRED to match exactly once, so a rename fails loudly instead of leaving the
# check quietly examining nothing (ludics-lite#188). Two of them are the lane's call site: nothing
# short of running a sweep can execute it, so that it still composes `lab_box_of` with
# `take_lab_lock` is held as a required core rather than proven. Three more are the same for the
# map lab_box_of reads: this suite fills LAB_MAP from `endpoint-map` itself (sweep_lock), so that
# the sweep still defines `lab_map`, fills LAB_MAP in it from `"$WAKE_LAB" endpoint-map`, and calls
# it at startup is held as a required core too, not exercised. The staging checkout is read
# strictly read-only: `git show` of a ref, never a branch, a fetch or a write.
STAGING=${OCANNL_STAGING:-$HOME/ocannl-staging}
created() { # created <dir> -- every regular file under it, relative and shell-quoted, one line
  local f out=""
  while IFS= read -r -d '' f; do out="$out $(printf '%q' "${f#"$1"/}")"; done \
    < <(find "$1" -type f -print0 2>/dev/null)
  printf '%s' "${out# }"
}
# What the fragment copied out of the sweep runs with, and ALL it runs with: sweep_env builds the
# environment of every run of it from exactly these names, and the run starts from `env -i`, so
# nothing ambient reaches it -- neither a variable of this suite's shell nor one a child process
# (`perl`, `date`) would read from its environment.
#   PATH                     this suite's, shims included
#   HOME, WAKE_LAB_LOCK_DIR  the inputs of the fragment's LAB_LOCK_DIR line, set (or left unset)
#                            per case
#   LAB_LOCK_WAIT            take_lab_lock's wait: small, so a contended case fails in seconds
#   LAB_MAP                  lab_box_of's table, which the sweep's lab_map fills from
#                            `wake-lab.sh endpoint-map`; SWEEP_MAP is this checkout's answer to it
#   stamp                    the run stamp take_lab_lock writes into its advisory holder line
# And it runs under `set -uo pipefail`, the sweep's own options (an anchor below holds the sweep
# to that line), so a read of
# anything else on a path a case executes is `<name>: unbound variable` on the holder's stderr,
# which sweep_hold_stop reports by name -- whether it is read plainly, behind a branch that did
# not run, through an arithmetic value, in a subshell or in a command substitution, since bash
# itself decides. That is what this suite missed when lab_box_of came to read LAB_MAP: the copy did
# not carry it, the box resolved empty, and five cases reported that as the two repositories
# disagreeing (ludics-lite#469). Out of bounds: a read on a path no case executes, which cannot
# change what a case reports, and a child process reading its environment itself (`printenv`, a
# perl `%ENV`, `date`'s TZ), which sees only the names above. The reads `set -u` lets through
# unset are fragment_defaulted's.
SWEEP_MAP=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" "$WL" endpoint-map 2>&1); sweep_map_rc=$?
sweep_env() { # sweep_env <lock-dir|-> <home> -- sets SWEEP_ENV, the `env -i` arguments of a run
  SWEEP_ENV=(PATH="$PATH" HOME="$2" LAB_LOCK_WAIT=2 LAB_MAP="$SWEEP_MAP" stamp=test-wake-lab)
  [ "$1" = - ] || SWEEP_ENV+=(WAKE_LAB_LOCK_DIR="$1")
}
# The variables bash itself defines in that clean environment, asked of the bash that runs the
# fragment: `env -i` cannot make them unset, and some it takes from the environment when the sweep
# has one (SHELL, PWD, SHLVL, TERM) or from whatever its caller ran last (PIPESTATUS, REPLY,
# BASH_REMATCH), so a read of one is a read set -u cannot see. Asked from inside a function, after
# a pipeline, a `[[ =~ ]]`, a bare `read` and, on bash 4 and later, a `mapfile` and a `coproc`, since
# bash creates those variables only when something first sets them.
SWEEP_SHELL_VARS=()
while IFS= read -r v; do SWEEP_SHELL_VARS+=("$v"); done \
  < <(env -i PATH="$PATH" bash -c 'probe() {
        true | true; [[ a =~ a ]]; read -r <<<x
        if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then mapfile -t <<<x; eval "coproc { :; }; wait"; fi
        compgen -v
      }; probe' 2>/dev/null)
# fragment_defaulted <fragment> <bound-name...> -- <bash-variable...> -- each name the fragment
# reads in a form `set -u` lets through unset and that is not bound, one per line, and
# `refused <construct>` for what would blind the run. The forms, as a closed list: `${name-w}` and
# `${name:-w}`, the same with `=`, `+` and `?`, on a name or an array element; a whole-array
# `${name[@]}` or `${name[*]}` (`#` or not), which bash 4.4 and later expand to nothing when unset
# even under `set -u`; every `-v name` set test, wherever it sits in the test (after whitespace,
# `(`, `!`, `&&` or `||`, spaced or not); and any mention of a
# bash variable, as a whole word, since bash defines it even under `env -i`. Each would quietly
# take a value or a branch where the sweep had another, which is ludics-lite#469's shape again
# with the error swallowed. SECONDS is bound by the callers, being bash's own clock in any
# environment. It reads logical lines, a backslash-newline joined first, as bash parses them.
# Refused outright: `${!`, whose target no reader of the text can name; a `-v` whose
# operand is neither a bare name nor an awk-style `name=value` (quoted, or computed); anything that
# could turn `set -u` off -- a `set` given a `+` option or a computed argument, or any mention of
# `nounset`; and code the text does not show, `eval`, `source` and a `.` command. It reads the
# whole fragment text, comments and quoted spans included, so an occurrence is over-reported, never
# missed -- a whole-array read of the fragment's own `local` array included, which is loud. Out of
# bounds: anything else that asks whether a name is set (`declare -p`, `compgen -v`); a nounset
# failure the fragment itself silences and recovers from (`( ... ) 2>/dev/null || fallback`); and
# the process the fragment runs in, as opposed to its variables -- `$0`, `$$`, `$?` on entry, the
# working directory, umask and open descriptors are this suite's, not the sweep's; and a command
# word assembled from quoted pieces (`s''et +u`). This is a tripwire for a copied function that
# quietly gains an input, the drift ludics-lite#469 met, not a sandbox for code written to evade it.
fragment_defaulted() {
  perl -e '
    my ($file, @rest) = @ARGV;
    my (@bound, @shell);
    my $into = \@bound;
    for (@rest) { if ($_ eq "--") { $into = \@shell } else { push @$into, $_ } }
    my %ok = map { $_ => 1 } @bound;
    my $shell = join "|", map { quotemeta } grep { !$ok{$_} } @shell;
    my %seen;
    my $id = qr/[A-Za-z_][A-Za-z0-9_]*/;
    open my $fh, "<", $file or die "$file: $!\n";
    my $text = do { local $/; <$fh> };
    close $fh or die "$file: $!\n";
    # Logical lines, as bash reads them: a backslash-newline is removed before parsing.
    $text =~ s/\\\n//g;
    for (split /\n/, $text) {
      my @refused;
      push @refused, "\${!" if /\$\{!/;
      push @refused, $1 while /\b(set[ \t][^\n;|&]*?[+\$][^\n;|&]*?)[ \t]*(?=$|[;|&}])/g;
      push @refused, "nounset" if /\bnounset\b/;
      push @refused, $1 while /(?<![\w.-])(eval|source)(?![\w-])/g;
      push @refused, "." if /(?:^|[;&|{(]|\b(?:then|do|else))[ \t]*\.[ \t]/;
      my @names = (/\$\{($id)(?:\[[^\]]*\])?:?[-=+?]/g, /\$\{#?($id)\[[@*]\]/g);
      push @names, /(?<!\w)($shell)(?!\w)/g if $shell ne "";
      for my $v (/(?:^|[\s(!&|])-v[ \t]+([^\s\]]+)/g) {
        next if $v =~ /^$id=/;
        if ($v =~ /^$id$/) { push @names, $v } else { push @refused, "-v $v" }
      }
      for (@refused) { print "refused $_\n" unless $seen{"refused $_"}++ }
      for my $n (@names) { print "$n\n" unless $ok{$n} || $seen{$n}++ }
    }' "$@"
}
# The negative control, which needs no staging checkout and so runs in CI too: a check that cannot
# fail proves nothing. Each planted_* reads one name nothing binds, in a way the copy step's old
# anchors could not see, and must be reported by name; planted_bound reads only what sweep_env
# binds and must run clean. The text check must report exactly the defaulted, indirect, `-v`,
# whole-array and bash-variable reads and the refusals, and neither awk's `-v a=` nor SECONDS.
cat >"$TMP/planted-fragment.sh" <<'EOF'
PLANTED_TOP=${PLANTED_DEFAULTED:-fallback}
planted_plain() { printf '%s\n' "$LAB_MAP $PLANTED_PLAIN"; }
planted_branch() { false && PLANTED_BRANCH=1; printf '%s\n' "$PLANTED_BRANCH"; }
planted_arith() { local n=PLANTED_ARITH; printf '%s\n' "$((n + 1))"; }
planted_subst() { printf '%s\n' "$(printf '%s' "$PLANTED_SUBST")"; }
planted_bound() { local box=$1; printf '%s\n' "$LAB_MAP $stamp $HOME ${box:0:1} $((SECONDS + LAB_LOCK_WAIT))"; }
planted_indirect() { local r=LAB_MAP; printf '%s\n' "${!r}"; }
planted_tested() { [ -v PLANTED_TESTED ] && printf '%s\n' set; }
planted_awk() { awk -v a="$1" '{ print a }' </dev/null; }
planted_array() { printf '%s\n' "${PLANTED_ARRAY[@]}"; }
planted_unguarded() { set +u; }
planted_computed() { [ -v "$PLANTED_NAME" ] && printf '%s\n' set; }
planted_compound() { [ -n "$LAB_MAP" -a -v PLANTED_COMPOUND ] && printf '%s\n' set; }
planted_shell() { [ "$SHELL" = /bin/zsh ] && printf '%s\n' zsh; }
planted_status() { [ "${PIPESTATUS[0]}" = 1 ] && printf '%s\n' failed; }
planted_optset() { local o=u; set +$o; }
planted_eval() { eval "$PLANTED_CODE"; }
planted_continued() {
  set \
-o pipefail +u
}
EOF
sweep_env "$LOCKS" "$TMP/sweep-home-planted"
for planted in plain branch arith subst; do
  name=PLANTED_$(printf '%s' "$planted" | tr '[:lower:]' '[:upper:]')
  out=$(env -i "${SWEEP_ENV[@]}" bash -uo pipefail -c '. "$1"; "$2"' _ "$TMP/planted-fragment.sh" \
    "planted_$planted" 2>&1)
  grep -q "$name: unbound variable" <<<"$out" \
    && ok "a planted fragment reading $name (planted_$planted) is reported by name" \
    || ko "a planted fragment's unbound read in planted_$planted went unreported -- $out"
done
out=$(env -i "${SWEEP_ENV[@]}" bash -uo pipefail -c '. "$1"; planted_bound rog' _ "$TMP/planted-fragment.sh" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'unbound variable' <<<"$out" \
  && ok "...while one reading only what sweep_env binds runs clean (rc=$rc)" \
  || ko "a planted fragment reading only bound names failed under sweep_env (rc=$rc) -- $out"
sweep_env "$LOCKS" "$HOME"
if out=$(fragment_defaulted "$TMP/planted-fragment.sh" "${SWEEP_ENV[@]%%=*}" SECONDS -- \
           ${SWEEP_SHELL_VARS[@]+"${SWEEP_SHELL_VARS[@]}"}); then
  want=$(printf '%s\n' PLANTED_DEFAULTED 'refused ${!' PLANTED_TESTED PLANTED_ARRAY \
    'refused set +u' 'refused -v "$PLANTED_NAME"' PLANTED_COMPOUND SHELL PIPESTATUS \
    'refused set +$o' 'refused eval' 'refused set -o pipefail +u')
  [ "$out" = "$want" ] \
    && ok "the text check reports exactly the planted reads set -u lets through unset" \
    || ko "the text check is off on the planted fragment -- want [$want], got [$out]"
else
  ko "the text check did not run on the planted fragment -- $out"
fi
# ...and a `-v` behind an unspaced `||`, which bash 3.2 cannot even parse inside `[[ ]]`, so it is
# planted as text the check reads but nothing sources.
printf '%s\n' '[[ -z x||-v PLANTED_UNSPACED ]]' >"$TMP/planted-text.sh"
out=$(fragment_defaulted "$TMP/planted-text.sh" "${SWEEP_ENV[@]%%=*}")
[ "$out" = PLANTED_UNSPACED ] \
  && ok "...including a -v set test behind an unspaced ||" \
  || ko "the text check missed a -v set test behind an unspaced || -- got [$out]"
# With <ready> and <keep>, the lock is HELD until <keep> is removed, and the waiting happens inside
# the very shell that took it: take_lab_lock's flock belongs to the open file description behind
# its fd 8, so it dies with that shell. A wait wrapped AROUND this function holds nothing -- which
# is not a hypothetical, it is what the first draft of the end-to-end case below did, and it failed
# against a correct sweep because the lock was already gone by the time wake-lab looked.
sweep_lock() { # sweep_lock <lock-dir|-> <home> <ssh-alias> [<ready> <keep>]
  ( sweep_env "$1" "$2"
    # Its OWN process group, so the watchdog below can kill the whole tree. Killing the wrapper
    # alone leaves whatever it was blocked in -- a `sleep`, a blocking flock -- orphaned WITH the
    # inherited lock descriptor, and an flock lives until every descriptor onto that open file
    # description is closed. That is not a new hazard here: it is the one the stray-nap cases above
    # exist for, and it surfaced against this very lab lock. `perl` rather than `set -m`, which
    # would make the shell print job-control notices into the suite's output.
    # ...and it RECORDS that group rather than letting the caller assume it. `$!` is the pid of
    # the job bash started, which is not reliably the process that ends up leading the group: how
    # many levels of subshell survive between them is a bash optimization, not a contract. The
    # first draft killed `-$!`, that named no group, the kill was a no-op and the `wait` behind it
    # never returned -- the suite wedged for 20 minutes. So the leader writes its own pgid down.
    exec env -i "${SWEEP_ENV[@]}" perl -e 'setpgrp(0,0);
                  open my $fh, ">", $ARGV[0] or die $!; print $fh "$$\n"; close $fh;
                  shift @ARGV; exec @ARGV or die $!' \
      "$TMP/sweep-pgid" \
      bash -uo pipefail -c '. "$1" || exit 2
                take_lab_lock "$(lab_box_of "$2")" || exit 1
                [ -n "$3" ] || exit 0
                : > "$3"
                while [ -e "$4" ]; do sleep 1; done' \
      _ "$TMP/sweep-lock.sh" "$3" "${4:-}" "${5:-}" )
}
# EVERY call into that imported helper goes through these two, so every one of them runs in the
# background behind a deadline and is terminated when the deadline passes. `take_lab_lock` is
# foreign code this suite does not control: a future sweep that reintroduced a blocking wait which
# no longer observes LAB_LOCK_WAIT would otherwise hang this suite outright instead of reporting
# the regression the cases below exist to report. Holding rather than returning is also what lets
# a caller prove the lock is REAL, since the flock lives exactly as long as the shell that took it.
SUITE_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
sweep_hold_start() { # sweep_hold_start <lock-dir|-> <home> <ssh-alias> -- 0 iff it is now holding
  rm -f "$TMP/sweep-ready" "$TMP/sweep-pgid"; : > "$TMP/sweep-keep"
  sweep_lock "$1" "$2" "$3" "$TMP/sweep-ready" "$TMP/sweep-keep" >"$TMP/sweep-holder.log" 2>&1 &
  sweep_holder=$!
  local deadline=$((SECONDS + 30))
  # `kill -0` as well as the clock: a helper that REFUSED the lock has already exited, and waiting
  # the full deadline out for it would turn every negative case into a 30-second one.
  while [ ! -e "$TMP/sweep-ready" ] && kill -0 "$sweep_holder" 2>/dev/null \
        && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
  [ -e "$TMP/sweep-ready" ]
}
sweep_hold_stop() { # sweep_hold_stop -- let the holder go, and do not return until it is gone
  local deadline=$((SECONDS + 15))
  rm -f "$TMP/sweep-keep"
  while kill -0 "$sweep_holder" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
  # The recorded group first -- that is what reaches a `sleep` or a blocking flock the helper was
  # stuck in, holding an inherited lock descriptor. Never this suite's own group, however the file
  # got its contents. Then the job itself, which is what makes the `wait` below terminate.
  local pgid; pgid=$(cat "$TMP/sweep-pgid" 2>/dev/null)
  case $pgid in
    ''|*[!0-9]*) ;;
    "$SUITE_PGID") ko "the sweep holder recorded this suite's own process group ($pgid); not killing it" ;;
    *) kill -KILL -"$pgid" 2>/dev/null ;;
  esac
  kill -KILL "$sweep_holder" 2>/dev/null
  wait "$sweep_holder" 2>/dev/null
  # The kernel closes a killed holder's descriptor a moment after the kill returns, and the next
  # case takes the same lock, so do not hand it back until it is really free. The LANE lock only:
  # `lock_free` would also test `<box>.hold.lock`, which the held-hold-lock case above is holding
  # ON PURPOSE across this call, so waiting on it would burn the whole deadline every single run.
  deadline=$((SECONDS + 15))
  while ! file_free "$LOCKS/rog.lock" && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
  # The fragment ran under set -u (sweep_env): a name it read that nothing bound is on its stderr.
  ! grep -q 'unbound variable' "$TMP/sweep-holder.log" 2>/dev/null \
    || ko "the fragment copied out of origin/master's sweep read a variable this suite does not \
bind, so the case around this ran it on an input nobody set (ludics-lite#469) -- bind it in \
sweep_env, or copy its definition: $(grep 'unbound variable' "$TMP/sweep-holder.log" | tr '\n' ';')"
}
if ! git -C "$STAGING" rev-parse --git-dir >/dev/null 2>&1; then
  skip "the cross-repository lock contract is UNCHECKED: no ocannl-staging git checkout at \
$STAGING (set OCANNL_STAGING)"
elif ! git -C "$STAGING" show origin/master:tools/sweep.sh >"$TMP/sweep-master.sh" \
     2>"$TMP/sweep-master.err"; then
  ko "cannot read origin/master:tools/sweep.sh out of $STAGING, which is the revision the sweep \
routine archives and runs -- $(tr -d '\000-\037' <"$TMP/sweep-master.err")"
else
  # The sweep's text is tools/sweep.sh plus the tools/lab-map.sh it sources (staging 3ec51c31e moved
  # lab_map, lab_box_of and lab_contract_check there; ludics-lite#706). Which files make it up is
  # the sweep's own source line to say, read from origin/master like the rest: no such line is an
  # older sweep that still defines them itself, and its text is sweep.sh alone. The line names one
  # spelling; any other way of loading lab-map.sh reads as none, and the anchors below then miss in
  # sweep.sh alone -- a loud failure, never a check quietly run against the wrong text. The
  # anchors read the two files as ONE text, so each must still match exactly once across both: a
  # definition left behind in sweep.sh beside its lab-map.sh copy fails too.
  lab_map_source='^\. "\$SWEEP_TOOLS/lab-map\.sh"$'
  SWEEP=$TMP/sweep-text.sh
  anchors=1
  n=$(grep -c -- "$lab_map_source" "$TMP/sweep-master.sh")
  if [ "$n" -eq 0 ]; then
    sweep_files=tools/sweep.sh
    cp "$TMP/sweep-master.sh" "$SWEEP"
  elif [ "$n" -ne 1 ]; then
    anchors=0
    ko "origin/master's tools/sweep.sh has $n lines matching /$lab_map_source/, not 0 or 1 -- \
which copy of the lab map functions the sweep runs is no longer one this suite can tell"
  elif ! git -C "$STAGING" show origin/master:tools/lab-map.sh >"$TMP/lab-map-master.sh" \
       2>"$TMP/sweep-master.err"; then
    anchors=0
    ko "origin/master's tools/sweep.sh sources tools/lab-map.sh, but it cannot be read out of \
$STAGING -- $(tr -d '\000-\037' <"$TMP/sweep-master.err")"
  else
    sweep_files="tools/sweep.sh with the tools/lab-map.sh it sources"
    # A newline between them, so a file without a final one cannot join a line across the seam.
    { cat "$TMP/sweep-master.sh"; printf '\n'; cat "$TMP/lab-map-master.sh"; } >"$SWEEP"
  fi
  if [ "$anchors" -eq 1 ]; then
    for anchor in '^LAB_LOCK_DIR=' '^lab_box_of() {' '^take_lab_lock() {' \
                  '^[[:space:]]*lab_box=\$(lab_box_of ' '^[[:space:]]*take_lab_lock "\$lab_box"' \
                  '^lab_map() {' '^[[:space:]]*ask_capped LAB_MAP [0-9][0-9]* "\$WAKE_LAB" endpoint-map' \
                  '[[:space:]{;]lab_map[;[:space:]]' '^set -uo pipefail$'; do
      n=$(grep -c -- "$anchor" "$SWEEP")
      [ "$n" -eq 1 ] || { anchors=0
        ko "origin/master's sweep ($sweep_files) has $n lines matching /$anchor/, not 1 -- the lane \
no longer takes its lock, fills the map it reads or sets its shell options the way the cases below \
assume, so they would stop being about the live sweep"; }
    done
  fi
  if [ "$anchors" -eq 1 ]; then
    { grep '^LAB_LOCK_DIR=' "$SWEEP"
      sed -n '/^lab_box_of() {/,/^}/p' "$SWEEP"
      sed -n '/^take_lab_lock() {/,/^}/p' "$SWEEP"
    } >"$TMP/sweep-lock.sh"
    # The reads set -u lets through unset, before anything runs. The check's own status first:
    # one that died before printing would otherwise read as a fragment with nothing to report.
    sweep_env "$LOCKS" "$HOME"
    if [ "${#SWEEP_SHELL_VARS[@]}" -eq 0 ]; then
      anchors=0
      ko "the bash that runs the fragment listed no variables of its own (compgen -v), so the text \
check could not tell which reads of them set -u would let through"
    elif ! defaulted=$(fragment_defaulted "$TMP/sweep-lock.sh" "${SWEEP_ENV[@]%%=*}" SECONDS -- \
                         "${SWEEP_SHELL_VARS[@]}" 2>&1); then
      anchors=0
      ko "the text check over the fragment copied out of origin/master's sweep did not run to \
completion, so nothing says which names it reads past set -u -- ${defaulted//$'\n'/; }"
    elif [ -n "$defaulted" ]; then
      anchors=0
      ko "the fragment copied out of origin/master's sweep asks whether names are set that this \
suite does not bind, which set -u cannot catch, so the cases below would quietly run on the \
fallback (ludics-lite#469) -- bind it in sweep_env, or copy its definition: ${defaulted//$'\n'/; }"
    elif [ "$sweep_map_rc" -ne 0 ] || [ -z "$SWEEP_MAP" ]; then
      anchors=0
      ko "wake-lab endpoint-map gave no map for the sweep's lab_box_of (rc=$sweep_map_rc) -- \
$SWEEP_MAP"
    fi
  fi
  if [ "$anchors" -eq 1 ]; then
    for pair in rog-nv-wsl:rog minix-amd-wsl:minix; do
      sshalias=${pair%%:*}; box=${pair##*:}
      # A HOME of its own per box: the sweep derives its directory from $HOME, so this keeps the
      # run off this machine's real lab AND proves the path is derived rather than hard-coded.
      home="$TMP/sweep-home-$box"; mkdir -p "$home"
      sweep_hold_start - "$home" "$sshalias"; rc=$?
      mine=$(env -u WAKE_LAB_LOCK_DIR HOME="$home" WAKE_LAB_HOSTS="$TMP/absent.sh" \
        "$WL" lock-path "$box" 2>&1); mine_rc=$?
      rel=".local/state/wake-lab/$box.lock"
      # lock-path's own status is part of the claim: printing the right path and exiting nonzero is
      # a broken public command, and comparing only the text would report it as agreement.
      if [ "$rc" -eq 0 ] && [ "$mine_rc" -eq 0 ] \
         && [ "$(created "$home")" = "$(printf '%q' "$rel")" ] \
         && [ "$mine" = "$home/$rel" ]; then
        ok "the lock the sweep really takes for $sshalias is the one lock-path answers for $box"
      else
        ko "the two repositories disagree about $sshalias (rc=$rc): the sweep's own take_lab_lock \
left [$(created "$home")] under its HOME, while wake-lab answers '$mine' (rc=$mine_rc) for box \
$box -- the \
interlock is off, and nothing else in either repository would say so. \
$(cat "$TMP/sweep-holder.log" 2>/dev/null)"
      fi
      sweep_hold_stop
    done

    # Both live cases below reserve rog under $LOCKS, so wait out any descriptor a case above left
    # orphaned rather than racing it: a lock this suite still holds would make either one lie.
    sweep_deadline=$((SECONDS + 20))
    while ! lock_free rog && [ "$SECONDS" -lt "$sweep_deadline" ]; do sleep 1; done

    # The negative fact, added when the lock split in two (ludics-lite#224), checked as BEHAVIOUR.
    # The sweep must not honour `<box>.hold.lock`: the cross-machine routine holds both GPU boxes
    # with `--hold` and then sweeps them, so a sweep that waited for the hold lock would wait out
    # its own caller. That is #224, and it presented as three backends with zero coverage rather
    # than as a lock bug. Hold the hold lock exactly as a holder does -- a descriptor kept open,
    # the flock taken by a perl that exits -- and require the sweep to take its lane lock anyway.
    # Behaviour rather than a text scan, because honouring it need not mention it: a wildcard over
    # `$box.*.lock`, or a suffix assembled at run time, would pass any scan for the literal.
    # An exit status alone would not do it: a take_lab_lock that returned 0 WITHOUT the lane lock
    # whenever the hold lock was contended would satisfy it, and the end-to-end case below runs
    # with no hold lock held, so nothing else would expose that. Keep the helper alive and require
    # a competing non-blocking flock on the LANE lock to be refused.
    : > "$LOCKS/rog.lock"
    exec 7>>"$LOCKS/rog.hold.lock"
    if ! perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7; then
      ko "this suite could not take rog's HOLD lock, so the case below would prove nothing"
    else
      if sweep_hold_start "$LOCKS" "$TMP/sweep-home-rog" rog-nv-wsl \
         && ! file_free "$LOCKS/rog.lock"; then
        ok "the sweep still takes its lane lock while the box's HOLD lock is held, as #224 requires"
      else
        ko "the sweep does not hold rog's LANE lock while rog.hold.lock is held: it is honouring \
the hold lock, so a box the routine holds can no longer sweep itself and its lanes skip \
(ludics-lite#224). $(cat "$TMP/sweep-holder.log" 2>/dev/null)"
      fi
      sweep_hold_stop
    fi
    exec 7>&-

    # ...and the whole interlock, end to end, each side running its own real code. The sweep's own
    # take_lab_lock holds the box in a live process; this script's own destroyer must then be
    # refused. A lock FILE at an agreed path proves nothing on its own -- what wake-lab is refused
    # by is a live flock -- so this is the case that makes the path comparisons above mean
    # something, and the one that would go red if either side stopped locking for real.
    if ! sweep_hold_start "$LOCKS" "$TMP/sweep-home-rog" rog-nv-wsl; then
      ko "the sweep's take_lab_lock did not take rog's lane lock under $LOCKS within its deadline, \
so the interlock could not be exercised end to end. $(cat "$TMP/sweep-holder.log" 2>/dev/null)"
    elif ! file_free "$LOCKS/rog.hold.lock"; then
      ko "rog's HOLD lock is held as well, so a refusal below would not be attributable to the \
sweep's LANE lock -- the case would pass without proving anything"
    else
      : > "$SSH_LOG"
      out=$(wl_locked restart-wsl rog); rc=$?
      [ "$rc" -ne 0 ] && grep -q 'REFUSED on: rog' <<<"$out" \
        && ! grep -q '^rog-lan :: wsl.exe --shutdown$' "$SSH_LOG" \
        && ok "a restart is refused while the SWEEP'S OWN take_lab_lock holds the box (rc=$rc)" \
        || ko "the sweep held rog's lane lock and this script destroyed the VM anyway (rc=$rc) -- \
the interlock the two repositories exist to keep is not working: $out $(cat "$SSH_LOG")"
      grep -q 'ocannl sweep' <<<"$out" \
        && ok "...and the refusal names the sweep, so the operator knows what to wait for" \
        || ko "the refusal does not name the sweep as the holder -- $out"
    fi
    sweep_hold_stop
  fi
fi

# Everything above this line is what reserves: every `restart-wsl`, every power command, every
# lock case. Check here as well as at the end, so an escape is attributed to that region.
lab_untouched "the restart, power and lock cases"

# --- the polling loops are bounded by elapsed time, not by iteration count -----------------------
# Every probe of a dark box burns its ConnectTimeout, so an iteration budget was a wall-clock lie:
# 36 rounds of a "3 minute" WSL wait ran for nine when the probes were slow. Three-second probes
# against a one-second budget: a loop counting iterations would run for minutes here.
started=$SECONDS
env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WSL_WAIT_SECONDS=1 SSH_DELAY=3 "$WL" kick-wsl rog >/dev/null 2>&1
elapsed=$((SECONDS - started))
[ "$elapsed" -lt 30 ] && ok "a WSL wait with slow probes honours its deadline (${elapsed}s)" \
  || ko "the WSL wait ran ${elapsed}s against a 1s budget: it is still counting iterations"
started=$SECONDS
out=$(env WAKE_LAB_HOSTS="$TMP/hosts.sh" WAKE_LAB_WAIT_SECONDS=1 SSH_DELAY=3 "$WL" --wait rog 2>&1); wake_rc=$?
elapsed=$((SECONDS - started))
[ "$elapsed" -lt 30 ] && ok "...and so does the wake wait (${elapsed}s)" \
  || ko "the wake wait ran ${elapsed}s against a 1s budget: it is still counting iterations"
grep -q 'did NOT wake: rog' <<<"$out" \
  && ok "...reporting the box that never came up" || ko "no 'did NOT wake' after the budget -- $out"
grep -q 'scripts/enable-wol-windows.ps1' <<<"$out" \
  && ok "...and points failure advice at the tracked Windows repair script" \
  || ko "wake failure advice does not name scripts/enable-wol-windows.ps1 -- $out"
[ "$wake_rc" -ne 0 ] && ok "...and exits nonzero (rc=$wake_rc)" || ko "a wake that timed out exited 0"

# --- the two commands that need no site data --------------------------------------------------
# --help and --list are what you reach for on a box where the table has yet to be installed, so
# they must work before it exists.
expect "--help works with no host table" 0 "Drive the home-lab machines" -- \
  env WAKE_LAB_HOSTS="$TMP/absent.sh" "$WL" --help
expect "--list works with no host table" 0 "active" -- \
  env CURL_REPLY=hosts WAKE_LAB_HOSTS="$TMP/absent.sh" "$WL" --list

# --- the --help range ---------------------------------------------------------------------------
# Computed here in awk against the script itself: the whole leading comment block, ending at the
# first non-comment line. A range that stops earlier -- the `2,20p` this replaced -- drops the
# lines a header grew, and does it silently.
head_block=$(awk 'NR == 1 { next } !/^#/ { exit } { print }' "$WL")
help_out=$(env WAKE_LAB_HOSTS="$TMP/absent.sh" "$WL" --help)
[ "$help_out" = "$head_block" ] && ok "--help prints the header block entire, to its last line" \
  || ko "--help is not the header block: $(diff <(printf '%s\n' "$head_block") <(printf '%s\n' "$help_out") | sed -n '1,5p')"
grep -q 'set -u' <<<"$help_out" \
  && ko "--help ran past the header into the script" || ok "...and stops at the first non-comment line"
[ "$(printf '%s\n' "$head_block" | wc -l)" -gt 19 ] \
  && ok "...on a header already longer than the old 2,20p range" \
  || ko "the header is short enough that the old truncating range would still pass; the guard above proves nothing"

# --- the example table is a working one ---------------------------------------------------------
expect "the example host table satisfies the contract" 0 "router-active=1" -- \
  env WAKE_LAB_HOSTS="$EXAMPLE" "$WL" status rog

# --- no hardware addresses in the repository ----------------------------------------------------
# The point of the split. Anything MAC-shaped in a tracked file is a leak, except the example
# file's 00:00:00 placeholders (and this script's own aa:bb:cc fixtures, which name no hardware).
# Both separators, because magic_packet() strips `:` and `-` alike: a MAC pasted in with hyphens,
# the spelling Windows prints, is every bit as much a leak as the colon-separated one, and a guard
# that reads only half of what the script accepts promises more than it checks. Each hit is printed as `file:line:<address>`,
# so the placeholder filter can anchor on the address itself: a line carrying both a placeholder
# and a real MAC still reports the real one.
mac_hits() { # mac_hits <file...> -- the MAC-shaped literals in those files, placeholders aside
  grep -oHInEi -- '([0-9a-f]{2}[:-]){5}[0-9a-f]{2}' "$@" 2>/dev/null \
    | grep -vEi '(00[:-]00[:-]00|aa[:-]bb[:-]cc)([:-][0-9a-f]{2}){3}$'
}
# The negative control: a scan that cannot fail proves nothing, and this one is two greps deep.
# Assembled at runtime, because a real-shaped address written out here would be a hit itself.
for sep in : -; do
  leak_mac=$(printf 'de%sad%sbe%sef%s12%s34' "$sep" "$sep" "$sep" "$sep" "$sep")
  printf 'eth_mac_of() { echo %s; }\n' "$leak_mac" > "$TMP/leaky.sh"
  [ -n "$(mac_hits "$TMP/leaky.sh")" ] && ok "the MAC scan catches a real-shaped address ($sep)" \
    || ko "the MAC scan does not catch $leak_mac, so its verdict below means nothing"
done
[ -z "$(mac_hits "$EXAMPLE")" ] && ok "...and passes the example file's placeholders" \
  || ko "the example file carries a non-placeholder MAC: $(mac_hits "$EXAMPLE")"
# The template's IPs are site data too if they are the author's leases. RFC 5737's 192.0.2.0/24 is
# the documentation range; anything in a private range here is a real address someone copied in.
ex_ips=$(grep -oE '\b(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]+\.[0-9]+\b' "$EXAMPLE")
[ -z "$ex_ips" ] && ok "...and the example's IPs are documentation addresses, not a real LAN" \
  || ko "the example file carries private-range addresses: $ex_ips"

# tracked_paths <checkout> -- its tracked files, absolute, NUL-delimited.
# NUL-delimited because every line-based Git rendering C-quotes a pathname carrying a newline, a
# quote, a backslash or -- under the default core.quotePath -- any non-ASCII byte, and the quoted
# rendering names no file on disk. A line-based read would hand `[ -f ]` a miss and leave that
# file unscanned, while the verdict below still said the repository carries no address.
tracked_paths() {
  local root="$1" f
  (cd "$root" && git ls-files -z 2>/dev/null) | while IFS= read -r -d '' f; do
    printf '%s\0' "$root/$f"
  done
}
# macs_under <checkout> -- the leaks in what that checkout tracks.
macs_under() {
  local f
  while IFS= read -r -d '' f; do
    [ -f "$f" ] && mac_hits "$f"
  done < <(tracked_paths "$1")
}
# The C-quoting control, for the same reason as the address control above: a scan that cannot
# reach a quoted name proves nothing about the names this repository might grow. The fixture
# carries both a newline and a non-ASCII byte, so it is quoted whatever core.quotePath says.
quoted_repo="$TMP/quoted-name-repo"
mkdir -p "$quoted_repo" &&
  git -C "$quoted_repo" init -q 2>/dev/null &&
  git -C "$quoted_repo" config user.email wake@lab.test &&
  git -C "$quoted_repo" config user.name wake-lab-test || exit 1
quoted_name=$(printf 'conf\nig-con\303\251.sh')
printf 'eth_mac_of() { echo %s; }\n' \
  "$(printf 'de%sad%sbe%sef%s12%s34' : : : : :)" >"$quoted_repo/$quoted_name"
git -C "$quoted_repo" add -A >/dev/null 2>&1
git -C "$quoted_repo" commit -qm 'a tracked name git quotes' >/dev/null 2>&1
case "$(git -C "$quoted_repo" ls-files)" in
'"'*) ok "the C-quoting fixture is a name git renders quoted" ;;
*) ko "the fixture is not quoted, so the scan below proves nothing about quoted names" ;;
esac
[ -n "$(macs_under "$quoted_repo")" ] \
  && ok "...and the MAC scan reaches a tracked file whose name git quotes" \
  || ko "the MAC scan skips a tracked file whose name git quotes -- it would miss a leak there"

# Tracked files, so a leak is judged by what the repository would publish. Before the first
# commit of a new script `git ls-files` does not list it yet; scan scripts/ as well, always.
ROOT_DIR=$(cd "$HERE/.." && pwd)
tracked_count=0
while IFS= read -r -d '' f; do tracked_count=$((tracked_count + 1)); done < <(tracked_paths "$ROOT_DIR")
[ "$tracked_count" -gt 0 ] && ok "the repository's tracked files are readable to scan" \
  || ko "git ls-files came back empty -- the scan below covers only scripts/"
leaks=$( { macs_under "$ROOT_DIR"; for f in "$HERE"/*.sh; do [ -f "$f" ] && mac_hits "$f"; done; } \
  | sort -u)
if [ -z "$leaks" ]; then ok "no MAC address is tracked in the repository"
else ko "MAC-shaped literals in tracked files:"; printf '%s\n' "$leaks"; fi

lab_untouched "the suite as a whole"

echo
echo "$pass passed, $fail failed, $skipped skipped"
[ "$fail" -eq 0 ]
exit "$?"
}
