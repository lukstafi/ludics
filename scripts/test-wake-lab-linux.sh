#!/usr/bin/env bash
# Native Linux path: run the core from a directory with no WSL adapter.
set -u
{
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/wake-lab-linux.XXXXXX") || exit 1
tmp=$(CDPATH= cd "$tmp" && pwd -P) || exit 1
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cp "$here/wake-lab.sh" "$tmp/wake-lab.sh"
cat >"$tmp/hosts.sh" <<'HOSTS'
mac_of() { [ "$1" = tuf ] && echo aa:bb:cc:00:00:06; }
eth_mac_of() { return 1; } # TUF has no Wake-on-LAN NIC: neither wired NIC wakes it (2026-10-12).
ip_of() { [ "$1" = tuf ] && echo 192.0.2.32; }
kind_of() { [ "$1" = tuf ] && echo linux; }
HOSTS
cat >"$tmp/bin/ssh" <<'SSH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SSH_LOG"
case "$*" in
  *systemctl*)
    [ "${SSH_POWER_FAIL:-0}" = 1 ] && { echo 'Access denied' >&2; exit 2; }
    # systemd 259's refusal under --check-inhibitors=yes: the holder is NOT on the last line.
    if [ "${SSH_INHIBITED:-0}" = 1 ]; then
      echo WAKE_LAB_POWER_STARTED
      echo 'Operation inhibited by "fleet-worker" (PID 4242 "systemd-inhibit", user lukstafi), reason is "tuf-amd-linux slot 1 of 1: run".' >&2
      echo 'Please retry operation after closing inhibitors and logging out other users.' >&2
      echo "Alternatively, ignore inhibitors and users with 'systemctl suspend -i'." >&2
      exit 1
    fi
    [ "${SSH_NO_MARKER:-0}" = 1 ] || echo WAKE_LAB_POWER_STARTED
    exit 255 ;; # SSH drops when the machine suspends or shuts down.
  *systemd-inhibit*)
    [ "${SSH_INHIBIT_FAIL:-0}" = 1 ] && exit 1
    printf '%s' "${SSH_INHIBITORS:-}"; exit 0 ;;
  *' true || exit '*)
    # The anchor leg (ludics-lite#617), asked ON the box: the box answers or it is ssh's own 255,
    # and then the box's own ssh to the anchor fails the first $SSH_ANCHOR_AFTER times it is asked
    # (counted in this log, this ask included), with the status the probe's `|| exit` names: a
    # leg still coming up after a wake.
    # $SSH_ANCHOR_HANG_AFTER=<n> wedges every ask after the n-th instead, the way a far side that
    # accepted the connection and never answered does: only the script's cap ends it.
    [ "${SSH_UP:-0}" = 1 ] || exit 255
    asks=$(grep -c -- ' true || exit ' "$SSH_LOG")
    [ -n "${SSH_ANCHOR_HANG_AFTER:-}" ] && [ "$asks" -gt "$SSH_ANCHOR_HANG_AFTER" ] && exec sleep 60
    [ "$asks" -gt "${SSH_ANCHOR_AFTER:-0}" ] && exit 0
    all=$*; exit "${all##* }" ;;
esac
case " $* " in
  *' tuf-amd-linux '*) [ "${SSH_UP:-0}" = 1 ] ;;
  *' tuf-amd-win '*) [ "${SSH_UP:-0}" = tuf-amd-win ] ;;
  *' tuf-amd-wsl '*) [ "${SSH_UP:-0}" = tuf-amd-wsl ] ;;
  *' rog-nv-linux '*) [ "${SSH_UP:-0}" = rog-nv-linux ] ;;
  *' rog-nv-win '*) [ "${SSH_UP:-0}" = rog-nv-win ] ;;
  *' rog-nv-wsl '*) [ "${SSH_UP:-0}" = rog-nv-wsl ] ;;
  *) for a in "$@"; do [ "$a" = "${SSH_UP:-}" ] && exit 0; done; exit 1 ;;
esac
SSH
# The router and the magic packet log to the same file as ssh, so an empty log is "nothing sent".
cat >"$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$SSH_LOG"
printf '<NewActive>1</NewActive>\n'
CURL
cat >"$tmp/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >>"$SSH_LOG"
exit 0
PYTHON
chmod +x "$tmp/bin"/*
# A stub registry reader, printing FW_LISTING (by default an empty registry) with status FW_RC.
# FW_HANG=leader wedges the reader itself; FW_HANG=orphan leaves a descendant holding its stdout
# after it exits, the shape of an ssh stuck inside the real reader's pipeline. Either way the
# descendant's pid goes to FW_PIDFILE so the case can see that status reaped it. FW_LOCKCHECK=<box>
# logs whether that box's lane lock was held at the moment the registry was read (#445).
cat >"$tmp/fleet-worker.sh" <<'FW'
#!/usr/bin/env bash
[ "$*" = "execution list --active --compact" ] || exit 9
if [ -n "${FW_LOCKCHECK:-}" ]; then
  if perl -e 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' \
       "$WAKE_LAB_LOCK_DIR/$FW_LOCKCHECK.lock"; then st=held; else st=free; fi
  printf 'registry read with lane=%s\n' "$st" >>"$SSH_LOG"
fi
case "${FW_HANG:-}" in
  leader) sleep 60 & echo $! >"$FW_PIDFILE"; wait ;;
  orphan) sleep 60 & echo $! >"$FW_PIDFILE" ;;
esac
printf '%s' "${FW_LISTING-[]}"; exit "${FW_RC:-0}"
FW
chmod +x "$tmp/fleet-worker.sh"
# WAKE_LAB_FLEET_WORKER: status and every destroyer read the execution registry (#445), and this
# suite must not read the real one; the stub's default is an empty registry.
export PATH="$tmp/bin:$PATH" SSH_LOG="$tmp/ssh.log" WAKE_LAB_HOSTS="$tmp/hosts.sh" WAKE_LAB_LOCK_DIR="$tmp/locks" \
  WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh"
mkdir -p "$WAKE_LAB_LOCK_DIR"
fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=$((fail+1)); fi; }
out=$(SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'Linux status reports the reached OS without loading the adapter' '[ "$rc" = 0 ] && [[ "$out" == *"os=linux  linux=UP"* ]] && [[ "$out" != *"Windows Update"* ]]'
check 'Linux status counts no sleep blocks on a box with none' '[[ "$out" == *"sleep-blocks=0"* ]] && [[ "$out" != *"block: "* ]]'
# The real listing's shape (systemd 259, rog-nv-linux): GNOME's handle-* blocks are on every
# logged-in desktop and refuse no power verb, so only the sleep holder may be counted.
listing='fleet-worker 1000 lukstafi 86901 systemd-inhibit sleep:idle                                               tuf-amd-linux slot 1 of 1: bash -c x                        block
lukstafi     1000 lukstafi 6032  gsd-power       handle-lid-switch                                        External monitor attached or configuration changed recently block
lukstafi     1000 lukstafi 6030  gsd-media-keys  handle-power-key:handle-suspend-key:handle-hibernate-key GNOME handling keypresses                                   block
'
out=$(SSH_UP=1 SSH_INHIBITORS="$listing" "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'Linux status shows the live sleep block inhibitor and who holds it' '[ "$rc" = 0 ] && [[ "$out" == *"sleep-blocks=1"* ]] && [[ "$out" == *"block: fleet-worker 1000 lukstafi 86901 systemd-inhibit sleep:idle tuf-amd-linux slot 1 of 1"* ]]'
check '...and leaves out the desktop key and lid blocks that refuse no verb' '[[ "$out" != *"gsd-media-keys"* ]] && [[ "$out" != *"gsd-power"* ]]'
out=$(SSH_UP=1 SSH_INHIBIT_FAIL=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'an unreadable inhibitor listing is unknown, not none' '[ "$rc" = 0 ] && [[ "$out" == *"sleep-blocks=?"* ]]'
# ludics-lite#359: status asks each lab lock's flock, because the text outlives the holder. The
# lane lock is held the way the sweep holds it (a descriptor kept open, flock taken by a perl that
# exits), and `7>&-` keeps status from inheriting it. The hold lock's line names a dead holder.
sl="$tmp/status-locks"; mkdir -p "$sl"
printf 'ocannl sweep 20260924T051741Z (pid 76065, since 20260924T051742Z)\n' >"$sl/tuf.lock"
printf 'wake-lab sleep (pid 63477, since 20260923T220025Z)\n' >"$sl/tuf.hold.lock"
perl -e 'utime time - 93784, time - 93784, $ARGV[0]' "$sl/tuf.hold.lock"
lock_sums=$(cksum "$sl/tuf.lock" "$sl/tuf.hold.lock")
lock_free() { perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <"$1"; }
exec 7>>"$sl/tuf.lock"
perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7; took=$?
check 'control: the suite holds the lane lock' '[ "$took" = 0 ] && ! lock_free "$sl/tuf.lock"'
out=$(WAKE_LAB_LOCK_DIR="$sl" SSH_UP=1 "$tmp/wake-lab.sh" status tuf 7>&- 2>&1); rc=$?
check 'a held lane lock reads held, with its holder line and the age of that line' '[ "$rc" = 0 ] && [[ "$out" == *"lane-lock=held"* ]] && [[ "$out" == *"lane lock: held by ocannl sweep 20260924T051741Z (pid 76065, since 20260924T051742Z) (line written "[0-9]*"s ago)"* ]]'
check 'a free lock with a leftover line reads free, showing the line as stale text with its age' '[[ "$out" == *"hold-lock=free"* ]] && [[ "$out" == *"hold lock: free, stale text (written 1d02h ago): wake-lab sleep (pid 63477, since 20260923T220025Z)"* ]]'
check '...and status left both files as it found them' '[ "$(cksum "$sl/tuf.lock" "$sl/tuf.hold.lock")" = "$lock_sums" ]'
check '...and the lane lock still held by its holder' '! lock_free "$sl/tuf.lock"'
exec 7>&-
out=$(WAKE_LAB_LOCK_DIR="$sl" SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'once its holder lets go, the same lane lock reads free with its line as stale text' '[ "$rc" = 0 ] && [[ "$out" == *"lane-lock=free"* ]] && [[ "$out" == *"lane lock: free, stale text (written "*"ocannl sweep 20260924T051741Z"* ]]'
rm -f "$sl/tuf.lock" "$sl/tuf.hold.lock"
out=$(WAKE_LAB_LOCK_DIR="$sl" SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'with no lock files both locks read free, with no detail line' '[ "$rc" = 0 ] && [[ "$out" == *"lane-lock=free  hold-lock=free"* ]] && [[ "$out" != *" lock: "* ]]'
check '...and status created no lock file' '[ -z "$(ls -A "$sl")" ]'
# The reservations column, from the stub registry reader above; `?` whenever the registry was not read.
listing='[{"request_id":"w-359-tuf-1","request":{"execution_host":"tuf-amd-linux"},"state":"launching"},
{"request_id":"w-359-mac","request":{"execution_host":"mac-studio"},"state":"running"},
{"request_id":"w-360-tuf-2","request":{"execution_host":"tuf-amd-linux"},"state":"dispatched"}]'
out=$(WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING="$listing" SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'status counts the active reservations naming the box, and lists them' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=2"* ]] && [[ "$out" == *"reservation: w-359-tuf-1 (launching)"* ]] && [[ "$out" == *"reservation: w-360-tuf-2 (dispatched)"* ]] && [[ "$out" != *"w-359-mac"* ]]'
out=$(WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING='[]' SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'an empty registry is zero reservations' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=0"* ]] && [[ "$out" != *"reservation: "* ]]'
out=$(WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING='[]' FW_RC=4 SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'an unreachable registry is unknown, not zero' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=?"* ]]'
out=$(WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING='EXECUTION REFUSED' SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'a registry listing that is not a JSON list is unknown, not zero' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=?"* ]]'
out=$(WAKE_LAB_FLEET_WORKER="$tmp/absent-fleet-worker.sh" SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'a missing registry reader is unknown, not zero' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=?"* ]]'
# A wedged leader is cut short, so its registry is unread (`?`); a leader that finished gave its
# answer ('[]', so 0) and only its straggler is reaped.
for hang in leader:? orphan:0; do
  want=${hang#*:}; hang=${hang%%:*}
  rm -f "$tmp/fw.pid"; started=$SECONDS
  out=$(WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING='[]' FW_HANG=$hang FW_PIDFILE="$tmp/fw.pid" \
    WAKE_LAB_PROBE_CAP=2 SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?; took=$((SECONDS - started))
  fw_pid=$(cat "$tmp/fw.pid" 2>/dev/null)
  check "a registry reader whose $hang wedges is cut at the cap, its whole tree with it" '[ "$rc" = 0 ] && [ "$took" -lt 20 ] && [ -n "$fw_pid" ] && ! kill -0 "$fw_pid" 2>/dev/null && [[ "$out" == *"reservations=$want"* ]]'
  [ -z "$fw_pid" ] || kill "$fw_pid" 2>/dev/null
done
out=$(SSH_UP=tuf-amd-win "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'Linux-configured TUF reports an alternate Windows boot' '[ "$rc" = 0 ] && [[ "$out" == *"os=windows"* ]]'
out=$(SSH_UP=tuf-amd-wsl "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'Linux-configured TUF reports an alternate WSL guest' '[ "$rc" = 0 ] && [[ "$out" == *"os=wsl"* ]]'
cat >"$tmp/rog-hosts.sh" <<'HOSTS'
mac_of() { [ "$1" = rog ] && echo aa:bb:cc:00:00:02; }
eth_mac_of() { mac_of "$1"; }
ip_of() { [ "$1" = rog ] && echo 192.0.2.30; }
kind_of() { [ "$1" = rog ] && echo linux; }
HOSTS
out=$(WAKE_LAB_HOSTS="$tmp/rog-hosts.sh" SSH_UP=rog-nv-win "$tmp/wake-lab.sh" status rog 2>&1); rc=$?
check 'Linux-configured dual boot reports Windows when Windows answered' '[ "$rc" = 0 ] && [[ "$out" == *"os=windows"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/rog-hosts.sh" SSH_UP=rog-nv-wsl "$tmp/wake-lab.sh" status rog 2>&1); rc=$?
check 'Linux-configured dual boot reports WSL when its guest answered' '[ "$rc" = 0 ] && [[ "$out" == *"os=wsl"* ]]'
# ludics-lite#320: a bare `status` is a read of the whole lab, so it shows tuf -- no Wake-on-LAN and
# woken by hand, often the one box awake -- beside rog and minix. Nothing else has a default: a bare
# `wake-lab.sh`, typed to see the usage, woke rog and minix on 2026-09-24.
cat >"$tmp/lab-hosts.sh" <<'HOSTS'
mac_of() { case "$1" in rog) echo aa:bb:cc:00:00:02 ;; minix) echo aa:bb:cc:00:00:03 ;; tuf) echo aa:bb:cc:00:00:06 ;; *) return 1 ;; esac; }
eth_mac_of() { case "$1" in rog|minix) mac_of "$1" ;; *) return 1 ;; esac; }
ip_of() { case "$1" in rog) echo 192.0.2.30 ;; minix) echo 192.0.2.31 ;; tuf) echo 192.0.2.32 ;; *) return 1 ;; esac; }
kind_of() { case "$1" in rog|minix|tuf) echo linux ;; *) return 1 ;; esac; }
HOSTS
out=$(WAKE_LAB_HOSTS="$tmp/lab-hosts.sh" SSH_UP=1 "$tmp/wake-lab.sh" status 2>&1); rc=$?
check 'bare status reads all three boxes, tuf included' '[ "$rc" = 0 ] && [[ "$out" == *"
rog "*"os=--"* ]] && [[ "$out" == *"
minix "*"os=--"* ]] && [[ "$out" == *"
tuf "*"os=linux  linux=UP"* ]]'
# Every verb but status, given no box, prints the usage and exits 2 with nothing sent: no router
# query, no packet, no ssh, no lock. '' is the bare invocation; `--wait --wsl` is a wake with flags
# and still no box. The box-free unhold and lock-path are refused too, before they read anything.
for verb in '' '--wait --wsl' sleep hibernate down kick-wsl restart-wsl 'kick-wsl --hold' unhold lock-path; do
  : >"$SSH_LOG"; rm -f "$WAKE_LAB_LOCK_DIR"/*.lock
  # shellcheck disable=SC2086 # the flag forms split on purpose
  out=$(WAKE_LAB_HOSTS="$tmp/lab-hosts.sh" SSH_UP=1 WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 \
    "$tmp/wake-lab.sh" $verb 2>&1); rc=$?
  check "${verb:-a bare wake-lab.sh} with no box prints the usage, exits 2 and sends nothing" \
    '[ "$rc" = 2 ] && [[ "$out" == *"nothing was sent"* ]] && [[ "$out" == *"# Usage:"* ]] && [ ! -s "$SSH_LOG" ] && ! ls "$WAKE_LAB_LOCK_DIR" 2>/dev/null | grep -q .'
done
check '...and the refusal names the verb as typed' '[[ "$out" == *"lock-path needs a box"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/lab-hosts.sh" "$tmp/wake-lab.sh" restart-wsl 2>&1)
check '...restart-wsl included, which runs as kick-wsl' '[[ "$out" == *"restart-wsl needs a box"* ]]'
: >"$SSH_LOG"
out=$(WAKE_LAB_HOSTS="$tmp/lab-hosts.sh" "$tmp/wake-lab.sh" rog minix 2>&1); rc=$?
check 'control: naming rog and minix wakes both, the same run that refused bare' '[ "$rc" = 0 ] && [[ "$out" == *"rog:"* ]] && [[ "$out" == *"minix:"* ]] && [[ "$out" != *"tuf:"* ]] && grep -q aa:bb:cc:00:00:02 "$SSH_LOG" && grep -q aa:bb:cc:00:00:03 "$SSH_LOG"'
out=$("$tmp/wake-lab.sh" status 2>&1); rc=$?
check 'bare status over a table that does not know rog and minix refuses rather than shrinking' '[ "$rc" = 1 ] && [[ "$out" == *"not in the host table"*"rog minix"* ]]'
out=$("$tmp/wake-lab.sh" unhold tuf 2>&1); rc=$?
check 'Linux unhold is a no-op without the adapter' '[ "$rc" = 0 ] && [[ "$out" == *"no holder needed"* ]]'
out=$("$tmp/wake-lab.sh" tuf 2>&1); rc=$?
check 'TUF, with no Wake-on-LAN NIC, refuses WoL with manual-wake guidance' '[ "$rc" = 1 ] && [[ "$out" == *"wake it manually"* ]]'
: >"$SSH_LOG"
out=$(SSH_UP=1 WAKE_LAB_WAIT_SECONDS=1 "$tmp/wake-lab.sh" --wait --wsl --hold tuf 2>&1); rc=$?
check 'Linux wait needs no WSL kick or holder and explains manual wake' '[ "$rc" = 0 ] && [[ "$out" == *"all up"* ]] && [[ "$out" == *"no holder needed"* ]] && [[ "$out" == *"wake it manually"* ]] && ! grep -q wsl.exe "$SSH_LOG"'
# ludics-lite#617: a box that answers is up only once its OWN ssh to the anchor works, which in the
# first minute after a wake it may not. The leg is asked on the box, non-interactively, and polled.
check '...and is up only once the box itself reaches the anchor, asked non-interactively on the box' '[[ "$out" == *"anchor leg to mac-studio: tuf=OK"* ]] && grep -q -- "-o BatchMode=yes .*tuf-amd-linux ssh -o BatchMode=yes .* mac-studio true || exit 3$" "$SSH_LOG"'
: >"$SSH_LOG"
out=$(SSH_UP=1 SSH_ANCHOR_AFTER=2 WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_ANCHOR_WAIT_SECONDS=60 WAKE_LAB_ANCHOR_POLL_SECONDS=0 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?; last=${out##*$'\n'}
check 'a box whose anchor leg comes up late is waited for, then all up' '[ "$rc" = 0 ] && [ "$last" = "all up" ] && [[ "$out" == *"anchor leg to mac-studio: tuf=--"*"anchor leg to mac-studio: tuf=OK"* ]] && [ "$(grep -c " mac-studio true || exit " "$SSH_LOG")" = 3 ]'
: >"$SSH_LOG"
out=$(SSH_UP=1 SSH_ANCHOR_AFTER=1000 WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_ANCHOR_WAIT_SECONDS=1 WAKE_LAB_ANCHOR_POLL_SECONDS=0 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?; last=${out##*$'\n'}
want_leg="anchor leg NOT up on tuf: tuf-amd-linux answers, but its own 'ssh -o BatchMode=yes mac-studio true' still failed"
check 'an anchor leg that never comes up is NOT all up, naming that leg and not the wake' '[ "$rc" = 1 ] && [ "$last" = "NOT all up: no ssh to mac-studio yet from: tuf (see above)" ] && [[ "$out" == *"$want_leg"* ]] && ! grep -qx "all up" <<<"$out" && [[ "$out" != *"did NOT wake"* ]]'
: >"$SSH_LOG"
started=$SECONDS
out=$(SSH_UP=1 SSH_ANCHOR_AFTER=1000 SSH_ANCHOR_HANG_AFTER=1 WAKE_LAB_WAIT_SECONDS=1 WAKE_LAB_ANCHOR_WAIT_SECONDS=3 WAKE_LAB_ANCHOR_POLL_SECONDS=1 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?; took=$((SECONDS - started))
check '...and an ask that wedges after the first is cut at the time left, not at the 20s probe cap' '[ "$rc" = 1 ] && [ "$took" -lt 12 ] && [[ "$out" == *"anchor leg NOT up on tuf: its last check through tuf-amd-linux did not return within its "[1-3]"s cap"* ]]'
: >"$SSH_LOG"
out=$(SSH_UP=0 WAKE_LAB_WAIT_SECONDS=0 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?
check 'a box that never answered is reported not woken, and its anchor leg is never asked' '[ "$rc" = 1 ] && [[ "$out" == *"did NOT wake: tuf"* ]] && ! grep -q " true || exit " "$SSH_LOG" && [[ "$out" != *"anchor leg"* ]]'
: >"$SSH_LOG"
out=$(SSH_UP=1 WAKE_LAB_ANCHOR=hub.lan WAKE_LAB_WAIT_SECONDS=1 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?
check 'WAKE_LAB_ANCHOR names the anchor the box is asked to reach' '[ "$rc" = 0 ] && [[ "$out" == *"anchor leg to hub.lan: tuf=OK"* ]] && grep -q " hub.lan true || exit 3$" "$SSH_LOG" && ! grep -q "mac-studio" "$SSH_LOG"'
: >"$SSH_LOG"
for anchor in local tuf tuf-amd-linux; do
  : >"$SSH_LOG"
  out=$(SSH_UP=1 SSH_ANCHOR_AFTER=1000 WAKE_LAB_ANCHOR=$anchor WAKE_LAB_WAIT_SECONDS=1 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?
  check "an anchor that is the box itself ($anchor) has no leg to ask, as fleet-worker reads it without ssh" '[ "$rc" = 0 ] && [[ "$out" == *"anchor leg not asked on tuf: the anchor $anchor is that box itself"* ]] && ! grep -q " true || exit " "$SSH_LOG"'
done
: >"$SSH_LOG"
out=$(SSH_UP=1 WAKE_LAB_ANCHOR= WAKE_LAB_WAIT_SECONDS=1 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?
check '...and set empty turns the leg off, saying so' '[ "$rc" = 0 ] && [[ "$out" == *"anchor leg not checked: WAKE_LAB_ANCHOR is empty"* ]] && ! grep -q " true || exit " "$SSH_LOG"'
: >"$SSH_LOG"
out=$(SSH_UP=1 WAKE_LAB_ANCHOR='hub; touch x' WAKE_LAB_WAIT_SECONDS=1 "$tmp/wake-lab.sh" --wait tuf 2>&1); rc=$?
check 'an anchor that is not a plain ssh destination is refused before anything is sent' '[ "$rc" = 1 ] && [[ "$out" == *"is not a plain ssh destination; nothing was sent"* ]] && [ ! -s "$SSH_LOG" ]'
: >"$SSH_LOG"
out=$(SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check 'Linux sleep uses inhibitor-aware systemctl under both lab locks' '[ "$rc" = 0 ] && grep -q -- "--check-inhibitors=yes suspend" "$SSH_LOG" && [ -e "$WAKE_LAB_LOCK_DIR/tuf.lock" ] && [ -e "$WAKE_LAB_LOCK_DIR/tuf.hold.lock" ]'
out=$(SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" hibernate tuf 2>&1); rc=$?
check 'Linux hibernate uses systemctl' '[ "$rc" = 0 ] && grep -q "systemctl --no-ask-password hibernate" "$SSH_LOG"'
out=$(SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" down tuf 2>&1); rc=$?
check 'Linux shutdown uses systemctl' '[ "$rc" = 0 ] && grep -q "systemctl --no-ask-password poweroff" "$SSH_LOG"'
out=$(SSH_POWER_FAIL=1 SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check 'definite Linux power refusal is visible and fails immediately' '[ "$rc" = 1 ] && [[ "$out" == *"sleep FAILED on tuf"* ]] && [[ "$out" != *"confirming..."* ]]'
out=$(SSH_INHIBITED=1 SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check 'a sleep refused by a block inhibitor names the holder and is a refusal' '[ "$rc" = 1 ] && [[ "$out" == *"Operation inhibited by \"fleet-worker\""* ]] && [[ "$out" == *"sleep REFUSED on tuf by a block inhibitor"* ]] && [[ "$out" != *"confirming..."* ]]'
out=$(SSH_NO_MARKER=1 SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check 'SSH disconnect before the command marker is a failure' '[ "$rc" = 1 ] && [[ "$out" == *"before the remote power command started"* ]] && [[ "$out" != *"confirming..."* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/rog-hosts.sh" SSH_NO_MARKER=1 SSH_UP=rog-nv-win WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep rog 2>&1); rc=$?
check 'a Linux-configured box booted into Windows cannot report successful sleep' '[ "$rc" = 1 ] && [[ "$out" == *"before the remote power command started"* ]]'
# ludics-lite#445: a destroyer refuses a box an outstanding exclusive measurement names, on any
# endpoint of its row, and reads the registry only once it holds the box's lab locks. The caller's
# own measurement (--as) and --force pass; a correctness reservation is not read; an unreadable
# registry refuses. A refused box's locks are let go again, and nothing is sent to it.
measured='[{"request_id":"m-445","request":{"execution_host":"tuf-amd-linux","kind":"measurement"},"state":"running"}]'
: >"$SSH_LOG"
out=$(FW_LISTING="$measured" FW_LOCKCHECK=tuf SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check 'sleep refuses a box an exclusive measurement names, naming the reservation' '[ "$rc" = 1 ] && [[ "$out" == *"measurement: m-445 (running)"* ]] && [[ "$out" == *"sleep REFUSED on tuf: an exclusive measurement reservation names it"* ]] && [[ "$out" == *"sleep REFUSED on: tuf (an exclusive measurement holds the box"*"--as=<request_id>"* ]] && [[ "$out" != *"confirming..."* ]]'
check '...sends nothing to it, and let its lab locks go again' '! grep -q systemctl "$SSH_LOG" && lock_free "$WAKE_LAB_LOCK_DIR/tuf.lock" && lock_free "$WAKE_LAB_LOCK_DIR/tuf.hold.lock"'
check '...having read the registry while it held the box'"'"'s lane lock' 'grep -qx "registry read with lane=held" "$SSH_LOG"'
for verb in hibernate down; do
  : >"$SSH_LOG"
  out=$(FW_LISTING="$measured" SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" "$verb" tuf 2>&1); rc=$?
  check "$verb refuses a measured box too" '[ "$rc" = 1 ] && [[ "$out" == *"$verb REFUSED on tuf: an exclusive measurement reservation names it"* ]] && ! grep -q systemctl "$SSH_LOG"'
done
: >"$SSH_LOG"
out=$(FW_LISTING='[{"request_id":"m-445-win","request":{"execution_host":"tuf-amd-win","kind":"measurement"},"state":"reserved"}]' \
  SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check '...on any endpoint of the box'"'"'s row' '[ "$rc" = 1 ] && [[ "$out" == *"measurement: m-445-win (reserved)"* ]] && ! grep -q systemctl "$SSH_LOG"'
: >"$SSH_LOG"
out=$(FW_LISTING='[{"request_id":"c-445","request":{"execution_host":"tuf-amd-linux","kind":"correctness"},"state":"running"}]' \
  SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
check 'a correctness reservation does not refuse a destroyer' '[ "$rc" = 0 ] && grep -q -- "--check-inhibitors=yes suspend" "$SSH_LOG"'
: >"$SSH_LOG"
out=$(FW_LISTING="$measured" SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep --as=m-445 tuf 2>&1); rc=$?
check '--as=<its request_id> lets the measurement'"'"'s own owner put the box to sleep' '[ "$rc" = 0 ] && grep -q -- "--check-inhibitors=yes suspend" "$SSH_LOG"'
: >"$SSH_LOG"
out=$(FW_LISTING="$measured" SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep --as=m-other tuf 2>&1); rc=$?
check '...and --as naming another reservation spares nothing' '[ "$rc" = 1 ] && [[ "$out" == *"measurement: m-445 (running)"* ]] && ! grep -q systemctl "$SSH_LOG"'
for fw in "FW_RC=4" "WAKE_LAB_FLEET_WORKER=$tmp/absent-fleet-worker.sh" "FW_LISTING=EXECUTION REFUSED"; do
  : >"$SSH_LOG"
  out=$(env "$fw" SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep tuf 2>&1); rc=$?
  check "a registry that cannot be read refuses the destroyer (${fw##*/})" '[ "$rc" = 1 ] && [[ "$out" == *"sleep REFUSED on tuf: the fleet'"'"'s execution registry could not be read"* ]] && ! grep -q systemctl "$SSH_LOG"'
done
: >"$SSH_LOG"
out=$(FW_LISTING="$measured" SSH_UP=0 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/wake-lab.sh" sleep --force tuf 2>&1); rc=$?
check '--force takes a measured box anyway' '[ "$rc" = 0 ] && grep -q -- "--check-inhibitors=yes suspend" "$SSH_LOG"'
cp "$here/wake-lab-wsl.sh" "$tmp/wake-lab-wsl.sh"
sed 's/echo linux/echo wsl/' "$tmp/hosts.sh" >"$tmp/tuf-wsl.sh"
out=$(WAKE_LAB_HOSTS="$tmp/tuf-wsl.sh" SSH_UP=tuf-amd-win "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'the renamed TUF keeps its Windows endpoint when configured for WSL' '[ "$rc" = 0 ] && [[ "$out" == *"win=UP"* ]] && [[ "$out" == *"wsl=--"* ]] && [[ "$out" == *"os=windows"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/tuf-wsl.sh" SSH_UP=tuf-amd-wsl "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'TUF WSL status requires a responding guest' '[ "$rc" = 0 ] && [[ "$out" == *"wsl=UP"* ]] && [[ "$out" == *"os=wsl"* ]]'
listing='[{"request_id":"w-359-guest","request":{"execution_host":"tuf-amd-wsl"},"state":"launching"},
{"request_id":"w-359-native","request":{"execution_host":"tuf-amd-linux"},"state":"launching"}]'
out=$(WAKE_LAB_HOSTS="$tmp/tuf-wsl.sh" WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING="$listing" SSH_UP=tuf-amd-wsl "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'a WSL box counts reservations naming its guest as well as its native endpoint' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=2"* ]] && [[ "$out" == *"reservation: w-359-guest (launching)"* ]]'
# ...and so does a Linux-configured box, on every endpoint its row of the map lists (#314), since
# the booted OS is not always the configured one; another box's endpoint is never counted.
listing='[{"request_id":"w-314-guest","request":{"execution_host":"tuf-amd-wsl"},"state":"launching"},
{"request_id":"w-314-win","request":{"execution_host":"tuf-amd-win"},"state":"launching"},
{"request_id":"w-314-native","request":{"execution_host":"tuf-amd-linux"},"state":"launching"},
{"request_id":"w-314-rog","request":{"execution_host":"rog-nv-wsl"},"state":"launching"}]'
out=$(WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING="$listing" SSH_UP=1 "$tmp/wake-lab.sh" status tuf 2>&1); rc=$?
check 'a Linux box counts reservations on every endpoint of its row, and no other box'"'"'s' '[ "$rc" = 0 ] && [[ "$out" == *"reservations=3"* ]] && [[ "$out" == *"reservation: w-314-win (launching)"* ]] && [[ "$out" != *"w-314-rog"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/tuf-wsl.sh" SSH_UP=tuf-amd-win WAKE_LAB_WSL_WAIT_SECONDS=0 "$tmp/wake-lab.sh" kick-wsl tuf 2>&1); rc=$?
check 'TUF kick cannot report WSL up without its guest endpoint answering' '[ "$rc" != 0 ] && [[ "$out" == *"wsl still down"* ]] && [[ "$out" != *"wsl up"* ]]'
# ludics-lite#314: every alias comes from ONE endpoint map, and an incomplete row is refused before
# anything is sent -- whatever the box's kind, since a Linux-configured dual-boot box still probes
# its Windows endpoints in status. tuf's row without its guest alias is the first review finding on
# the asus -> tuf rename (PR #313): its Windows endpoint then passed WSL validation with no guest.
mkdir "$tmp/no-guest"
cp "$tmp/wake-lab-wsl.sh" "$tmp/no-guest/wake-lab-wsl.sh"
sed 's/ wsl=tuf-amd-wsl//' "$tmp/wake-lab.sh" >"$tmp/no-guest/wake-lab.sh"; chmod +x "$tmp/no-guest/wake-lab.sh"
check 'the fixture really took the guest alias out of the map' '! cmp -s "$tmp/wake-lab.sh" "$tmp/no-guest/wake-lab.sh"'
out=$(WAKE_LAB_HOSTS="$tmp/tuf-wsl.sh" SSH_UP=tuf-amd-win "$tmp/no-guest/wake-lab.sh" status tuf 2>&1); rc=$?
check 'WSL kind refuses a map row without a guest endpoint' '[ "$rc" = 1 ] && [[ "$out" == *"a Windows endpoint (tuf-amd-win) with no WSL guest alias"* ]]'
: >"$SSH_LOG"; rm -f "$WAKE_LAB_LOCK_DIR/tuf.lock" "$WAKE_LAB_LOCK_DIR/tuf.hold.lock"
out=$(SSH_UP=1 WAKE_LAB_DOWN_WAIT_SECONDS=0 "$tmp/no-guest/wake-lab.sh" sleep tuf 2>&1); rc=$?
check '...and so does Linux kind, before any power operation or lock' '[ "$rc" = 1 ] && [[ "$out" == *"no WSL guest alias"*"nothing was sent"* ]] && [ ! -s "$SSH_LOG" ] && [ ! -e "$WAKE_LAB_LOCK_DIR/tuf.lock" ]'
# A NEWLY ADDED dual-boot box, `nova`, is one row in the map plus its site entries. With a complete
# row, status finds its alternate boots from that row alone -- the second #313 finding was a status
# whose Windows probe listed the box names by hand, and so skipped the renamed box.
cat >"$tmp/nova-hosts.sh" <<'HOSTS'
mac_of() { [ "$1" = nova ] && echo aa:bb:cc:00:00:07; }
eth_mac_of() { mac_of "$1"; }
ip_of() { [ "$1" = nova ] && echo 192.0.2.33; }
kind_of() { [ "$1" = nova ] && echo linux; }
HOSTS
nova_map() { # nova_map <dir> <row> -- a copy of the scripts whose endpoint map gains <row>
  mkdir -p "$tmp/$1"
  cp "$tmp/wake-lab-wsl.sh" "$tmp/$1/wake-lab-wsl.sh"
  awk -v row="  \"$2\"" '{ print } /^  "tuf +linux=/ { print row }' \
    "$tmp/wake-lab.sh" >"$tmp/$1/wake-lab.sh"
  chmod +x "$tmp/$1/wake-lab.sh"
  grep -qxF "  \"$2\"" "$tmp/$1/wake-lab.sh"
}
check 'the added-box fixture inserts its row into the map' 'nova_map nova "nova linux=nova-x-linux win=nova-x-win wsl=nova-x-wsl lan=nova-lan"'
out=$(WAKE_LAB_HOSTS="$tmp/nova-hosts.sh" SSH_UP=nova-x-linux "$tmp/nova/wake-lab.sh" status nova 2>&1); rc=$?
check 'an added box answers on the Linux endpoint of its row' '[ "$rc" = 0 ] && [[ "$out" == *"nova "*"os=linux  linux=UP"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/nova-hosts.sh" SSH_UP=nova-x-win "$tmp/nova/wake-lab.sh" status nova 2>&1); rc=$?
check '...and status probes its alternate Windows boot from the row' '[ "$rc" = 0 ] && [[ "$out" == *"os=windows  linux=--  win=UP"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/nova-hosts.sh" SSH_UP=nova-x-wsl "$tmp/nova/wake-lab.sh" status nova 2>&1); rc=$?
check '...and its alternate WSL guest' '[ "$rc" = 0 ] && [[ "$out" == *"os=wsl  linux=--  wsl=UP"* ]]'
sed 's/echo linux/echo wsl/' "$tmp/nova-hosts.sh" >"$tmp/nova-wsl.sh"
out=$(WAKE_LAB_HOSTS="$tmp/nova-wsl.sh" SSH_UP=nova-lan "$tmp/nova/wake-lab.sh" status nova 2>&1); rc=$?
check '...and, set to WSL, its LAN route' '[ "$rc" = 0 ] && [[ "$out" == *"lan=UP  win=--  wsl=--"*"os=windows"* ]]'
# Each way the addition can be wrong, as a new row or a half-done rename leaves it: first the row
# alone, then the map as a whole. Every one is refused, says what is wrong, and sends nothing: no
# router query, no packet, no ssh, no lock.
row_bad='incomplete ssh endpoints for nova'
map_bad='the endpoint map is inconsistent'
n=0
while IFS='|' read -r row head want; do
  n=$((n + 1))
  if ! nova_map "nova-bad-$n" "$row"; then check "incomplete-row fixture $n was inserted" false; continue; fi
  case "$head" in row) head=$row_bad ;; map) head=$map_bad ;; esac
  for verb in '' sleep; do   # '' is the bare wake, which has no verb word
    : >"$SSH_LOG"; rm -f "$WAKE_LAB_LOCK_DIR"/*.lock
    out=$(WAKE_LAB_HOSTS="$tmp/nova-hosts.sh" SSH_UP=nova-x-linux WAKE_LAB_DOWN_WAIT_SECONDS=0 \
      "$tmp/nova-bad-$n/wake-lab.sh" ${verb:+"$verb"} nova 2>&1); rc=$?
    check "an added row with $want is refused before ${verb:-wake} sends anything" \
      '[ "$rc" = 1 ] && [[ "$out" == *"$head"*"$want"*"nothing was sent"* ]] && [ ! -s "$SSH_LOG" ] && ! ls "$WAKE_LAB_LOCK_DIR" | grep -q .'
  done
done <<'ROWS'
nova linux=nova-x-linux win=nova-x-win|row|a Windows endpoint (nova-x-win) with no WSL guest alias
nova linux=nova-x-linux wsl=nova-x-wsl|row|a WSL guest (nova-x-wsl) with no Windows host
nova linux=nova-x-linux lan=nova-lan|row|a LAN route (nova-lan) with no Windows endpoint
nova linux=nova-x-linux win=nova-x-win wsl=nova-x-wsl lan=nova-x-lan|row|the LAN route nova-x-lan is not nova-lan
nova linux=nova-x-linux win=nova-y-win wsl=nova-x-wsl|row|nova-y-win does not share the stem nova-x
nova linux=nova-x-linux win=nova-x-win wsl=nova-x-guest|row|nova-x-guest does not end in -wsl
nova linux=nova-x-linux wn=nova-x-win|row|unknown endpoint wn
nova linux=nova-x-linux linux=nova-y-linux|row|linux is listed twice
nova win=nova-x-win wsl=nova-x-wsl|row|no linux ssh endpoint for a linux box
nova linux=-V-linux win=-V-win wsl=-V-wsl|row|linux=-V-linux is not a plain ssh alias
nova linux=tuf-amd-linux win=tuf-amd-win wsl=tuf-amd-wsl|map|the alias tuf-amd-linux is on both tuf and nova
tuf linux=nova-x-linux|map|tuf has two rows
-nova linux=nova-x-linux|map|the box name -nova is not a plain name
down linux=down-x-linux|map|the box name down is a command word
ROWS
check 'every incomplete-row fixture ran' '[ "$n" = 14 ]'
# The command words check_map refuses are the ones the argument parser takes: every verb in the
# parser's case arms, and `all`. Read off the script, so a verb added there without adding it to
# check_map goes red here.
parsed=$(sed -n '/^case "\${1:-}" in$/,/^esac$/p' "$here/wake-lab.sh" | sed -n 's/^  \([a-z|-]*\)).*/\1/p' | tr '|' '\n' | sort -u)
refused=$(sed -n '/^check_map() {/,/^}/p' "$here/wake-lab.sh" | sed -n 's/^      \([a-z|-]*\))$/\1/p' | tr '|' '\n' | grep -vx all | sort -u)
check 'check_map refuses every verb the argument parser takes' '[ -n "$parsed" ] && [ "$parsed" = "$refused" ]'
# `endpoint-map` (ludics-lite#395) is the map as data for fleet-worker.sh's roster check: each row
# as the box and its aliases, with no site table and no box, and only for a map every rule passes.
: >"$SSH_LOG"
out=$(WAKE_LAB_HOSTS="$tmp/absent.sh" "$tmp/wake-lab.sh" endpoint-map 2>&1); rc=$?
check 'endpoint-map prints each row as the box and its aliases, with no site table and nothing sent' \
  '[ "$rc" = 0 ] && [ "$out" = "rog rog-nv-linux rog-nv-win rog-nv-wsl rog-lan
minix minix-amd-linux minix-amd-win minix-amd-wsl minix-lan
tuf tuf-amd-linux tuf-amd-win tuf-amd-wsl" ] && [ ! -s "$SSH_LOG" ]'
out=$(WAKE_LAB_HOSTS="$tmp/absent.sh" "$tmp/wake-lab.sh" endpoint-map rog 2>&1); rc=$?
check '...takes no box' '[ "$rc" = 2 ] && [[ "$out" == *"endpoint-map takes no arguments"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/absent.sh" "$tmp/nova-bad-11/wake-lab.sh" endpoint-map 2>/dev/null); rc=$?
err=$(WAKE_LAB_HOSTS="$tmp/absent.sh" "$tmp/nova-bad-11/wake-lab.sh" endpoint-map 2>&1 >/dev/null)
check '...and answers nothing for a map with one alias on two boxes' '[ "$rc" = 1 ] && [ -z "$out" ] && [[ "$err" == *"$map_bad"*"tuf-amd-linux is on both tuf and nova"* ]]'
out=$(WAKE_LAB_HOSTS="$tmp/absent.sh" "$tmp/nova-bad-1/wake-lab.sh" endpoint-map 2>/dev/null); rc=$?
err=$(WAKE_LAB_HOSTS="$tmp/absent.sh" "$tmp/nova-bad-1/wake-lab.sh" endpoint-map 2>&1 >/dev/null)
check '...or for an incomplete row' '[ "$rc" = 1 ] && [ -z "$out" ] && [[ "$err" == *"$row_bad"*"no WSL guest alias"* ]]'
# A RENAMED box is its row renamed and nothing else: `all` and a bare status expand to the map's
# rows, so no other list in the script still names the old box and refuses it as unknown.
mkdir "$tmp/renamed"
cp "$tmp/wake-lab-wsl.sh" "$tmp/renamed/wake-lab-wsl.sh"
sed 's/^  "tuf   linux=tuf-amd-linux   win=tuf-amd-win   wsl=tuf-amd-wsl"/  "puf   linux=puf-amd-linux   win=puf-amd-win   wsl=puf-amd-wsl"/' \
  "$tmp/wake-lab.sh" >"$tmp/renamed/wake-lab.sh"; chmod +x "$tmp/renamed/wake-lab.sh"
sed 's/tuf/puf/g' "$tmp/lab-hosts.sh" >"$tmp/renamed-hosts.sh"
check 'the rename fixture renamed the row' 'grep -q "\"puf   linux=puf-amd-linux" "$tmp/renamed/wake-lab.sh" && ! grep -q "\"tuf " "$tmp/renamed/wake-lab.sh"'
for form in '' all; do
  out=$(WAKE_LAB_HOSTS="$tmp/renamed-hosts.sh" SSH_UP=puf-amd-linux "$tmp/renamed/wake-lab.sh" status ${form:+"$form"} 2>&1); rc=$?
  check "status ${form:-(bare)} reads the renamed box from its row" '[ "$rc" = 0 ] && [[ "$out" == *"
puf "*"os=linux  linux=UP"* ]] && [[ "$out" == *"
rog "* ]] && [[ "$out" != *"tuf"* ]]'
done
cat >"$tmp/other-linux.sh" <<'HOSTS'
mac_of() { [ "$1" = other ] && echo aa:bb:cc:00:00:05; }
eth_mac_of() { return 1; }
ip_of() { [ "$1" = other ] && echo 192.0.2.29; }
kind_of() { [ "$1" = other ] && echo linux; }
HOSTS
out=$(WAKE_LAB_HOSTS="$tmp/other-linux.sh" "$tmp/wake-lab.sh" status other 2>&1); rc=$?
check 'a box the site table knows and the endpoint map does not is refused' '[ "$rc" = 1 ] && [[ "$out" == *"no ssh endpoints for other"* ]]'
sed 's/echo linux/echo wsl/' "$tmp/other-linux.sh" >"$tmp/other-wsl.sh"
out=$(WAKE_LAB_HOSTS="$tmp/other-wsl.sh" "$tmp/wake-lab.sh" status other 2>&1); rc=$?
check '...whatever its kind' '[ "$rc" = 1 ] && [[ "$out" == *"no ssh endpoints for other"* ]]'
sed 's/echo linux/echo unknown/' "$tmp/hosts.sh" >"$tmp/bad.sh"
out=$(WAKE_LAB_HOSTS="$tmp/bad.sh" "$tmp/wake-lab.sh" tuf 2>&1); rc=$?
check 'invalid kind refuses before WoL' '[ "$rc" = 1 ] && [[ "$out" == *"invalid kind for tuf"* ]]'
# ludics-lite#353: boot-windows / boot-linux. The fixture box is rog, whose booted OS lives in a
# state file the ssh stub reads and the stub's reboot rewrites: `linux`, `windows` or `dark`. A
# reboot leaves the box dark for BOOT_DARK probes (four by default: two polls of both Windows routes,
# enough for the sustained outage the boot verbs wait for) before its target answers, as a real one does, and the
# stub records at each reboot whether the box's two lab locks were held at that moment.
mkdir -p "$tmp/bootbin"
cat >"$tmp/bootbin/ssh" <<'SSH'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
alias=$1; shift; cmd="$*"
printf '%s %s\n' "$alias" "$cmd" >>"$SSH_LOG"
held() { perl -e 'use Fcntl ":flock"; open(my $f, "<", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$1" || echo held; }
locks() { printf 'locks lane=%s hold=%s\n' "$(held "$WAKE_LAB_LOCK_DIR/rog.lock")" "$(held "$WAKE_LAB_LOCK_DIR/rog.hold.lock")" >>"$SSH_LOG"; }
reboot_to() { echo dark >"$BOOT_STATE"; echo "$1" >"$BOOT_STATE.pending"; }
if [ -e "$BOOT_STATE.pending" ]; then   # BOOT_DARK dark probes (default 1), then the reboot's target
  echo x >>"$BOOT_STATE.dark-seen"
  if [ "$(wc -l <"$BOOT_STATE.dark-seen")" -gt "${BOOT_DARK:-4}" ]; then
    mv "$BOOT_STATE.pending" "$BOOT_STATE"; rm -f "$BOOT_STATE.dark-seen"
  fi
fi
# BOOT_FLAKE: one Linux probe after the reboot command fails, as a flaky ssh does, box still up
if [ "$alias" = rog-nv-linux ] && [ -e "$BOOT_STATE.flake" ]; then rm -f "$BOOT_STATE.flake"; exit 255; fi
case "$alias:$(cat "$BOOT_STATE")" in
  rog-nv-linux:linux|rog-nv-win:windows|rog-lan:windows) ;;
  *) exit 255 ;;
esac
sudo_ok() { case "${BOOT_SUDO:-ok}" in ok) return 0 ;; "$1") return 0 ;; esac; echo 'sudo: a password is required' >&2; exit 1; }
case "$cmd" in
  'exit 0') exit 0 ;;
  *systemd-inhibit*) printf '%s' "${BOOT_INHIBITORS:-}"; exit 0 ;;
  *'efibootmgr 2>/dev/null || sudo -n efibootmgr') printf '%s\n' "$BOOT_LISTING"; exit 0 ;;
  'sudo -n -l systemctl reboot') sudo_ok nobootnext; echo /usr/bin/systemctl reboot; exit 0 ;;
  'sudo -n efibootmgr --bootnext '*)
    sudo_ok noreboot; echo "${cmd##* }" >"$BOOT_STATE.next"
    [ "${BOOT_NEXT_DROP:-0}" = 1 ] && exit 255   # written, and the answer lost on the way back
    printf 'BootNext: %s\n' "${BOOT_READBACK:-${cmd##* }}"; printf '%s\n' "$BOOT_LISTING"; exit 0 ;;
  'sudo -n efibootmgr --delete-bootnext'*)   # ...and the read-back finds none, unless BOOT_UNDO=fail
    [ "${BOOT_UNDO:-ok}" = fail ] && exit 1; rm -f "$BOOT_STATE.next"; exit 0 ;;
  *'echo WAKE_LAB_POWER_STARTED; exec sudo -n systemctl reboot')
    [ "${BOOT_FIRMWARE:-}" = wedge ] && { echo reboot-wedged >>"$SSH_LOG"; sleep 20; exit 255; }   # never returns in time
    locks; echo WAKE_LAB_POWER_STARTED; sudo_ok nobootnext
    case "${BOOT_FIRMWARE:-honor}" in
      honor) if [ -e "$BOOT_STATE.next" ]; then reboot_to windows; else reboot_to linux; fi ;;
      ignore) reboot_to linux ;;
      hang) reboot_to dark ;;
      noop) [ "${BOOT_FLAKE:-0}" = 1 ] && : >"$BOOT_STATE.flake"; exit 0 ;;   # returned, and nothing happened
    esac
    rm -f "$BOOT_STATE.next"; exit 255 ;;
  *'echo WAKE_LAB_POWER_STARTED& shutdown /r /f /t 0'*)
    # With the blank rog's cmd.exe returned when the command had one before its `&` (2026-09-24).
    locks; printf 'WAKE_LAB_POWER_STARTED \r\n'
    if [ "${BOOT_WIN_SCHEDULED:-0}" = 1 ]; then   # a restart already pending: this one is refused, that one happens
      printf 'A system shutdown has already been scheduled.(1190)\r\n' >&2
      [ "${BOOT_WIN_RESTART:-linux}" = noop ] || reboot_to "${BOOT_WIN_RESTART:-linux}"; exit 1
    fi
    [ "${BOOT_WIN_RESTART:-linux}" = noop ] || reboot_to "${BOOT_WIN_RESTART:-linux}"; exit 0 ;;
  *'bash.exe'*)
    gb=${BOOT_GITBASH:-native}
    # late: not yet on the first call after Windows answers, as a Git Bash still starting would be
    if [ "$gb" = late ]; then echo x >>"$BOOT_STATE.gb"; [ "$(wc -l <"$BOOT_STATE.gb")" -gt 1 ] && gb=native; fi
    case "$gb" in
      native) printf 'MINGW64_NT-10.0-26100\r\ngit version 2.51.0.windows.1\r\n' ;;
      *) printf 'Linux\r\ngit version 2.43.0\r\n' ;;
    esac; exit 0 ;;
esac
echo "boot stub: unexpected command: $cmd" >&2; exit 99
SSH
# The magic packet wakes a dark box into Ubuntu, its BootOrder's first entry.
cat >"$tmp/bootbin/python3" <<'PYTHON'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >>"$SSH_LOG"
[ "$(cat "$BOOT_STATE")" = dark ] && [ ! -e "$BOOT_STATE.pending" ] && echo "${BOOT_WAKE_TO:-linux}" >"$BOOT_STATE"
exit 0
PYTHON
chmod +x "$tmp/bootbin"/*
bl="$tmp/boot-locks"; mkdir -p "$bl"
tab=$'\t'
BOOT_LISTING_DEFAULT="BootCurrent: 0001
Timeout: 1 seconds
BootOrder: 0001,0003,0002
Boot0001* ubuntu${tab}HD(1,GPT,aaaa)/File(\\EFI\\ubuntu\\shimx64.efi)
Boot0002* Windows Boot Manager (old disk)${tab}HD(1,GPT,bbbb)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)
Boot0003* Windows Boot Manager${tab}HD(1,GPT,cccc)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)"
# Every run is under the caller's own exclusive reservation, w-own, unless BOOT_AS_ID says otherwise
# (empty: no --as at all); FW_LISTING is the registry, by default that reservation alone.
OWN='{"request_id":"w-own","request":{"execution_host":"rog-nv-linux","kind":"measurement"},"state":"running"}'
boot_run() { # boot_run <initial state> <wake-lab args...> -- sets out, rc and took; the log starts empty
  local st=$1 verb=$2; shift 2
  local as=${BOOT_AS_ID-w-own}
  set -- "$verb" ${as:+"--as=$as"} "$@"
  : >"$SSH_LOG"; rm -f "$tmp/boot.state".*; echo "$st" >"$tmp/boot.state"
  local started=$SECONDS
  out=$(PATH="$tmp/bootbin:$PATH" BOOT_STATE="$tmp/boot.state" WAKE_LAB_LOCK_DIR="$bl" \
    WAKE_LAB_HOSTS="${BOOT_HOSTS:-$tmp/rog-hosts.sh}" BOOT_LISTING="${BOOT_LISTING-$BOOT_LISTING_DEFAULT}" \
    WAKE_LAB_BOOT_WAIT_SECONDS="${BOOT_WAIT:-3}" WAKE_LAB_BOOT_POLL_SECONDS=0 WAKE_LAB_WAIT_SECONDS=0 \
    WAKE_LAB_DOWN_WAIT_SECONDS=0 WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING="${FW_LISTING-[$OWN]}" \
    "$tmp/wake-lab.sh" "$@" 7>&- 2>&1); rc=$?
  took=$((SECONDS - started))
}
nsel() { grep -c 'efibootmgr --bootnext' "$SSH_LOG"; }
boot_run linux boot-windows rog
check 'boot-windows reboots a box in Ubuntu into Windows and verifies its native Git Bash' '[ "$rc" = 0 ] && [[ "$out" == *"Windows answers"*"s after the reboot"* ]] && [[ "$out" == *"rog: in Windows, native Git Bash answers on rog-lan"* ]] && [[ "$out" == *"MINGW64_NT"* ]] && [ "$(cat "$tmp/boot.state")" = windows ]'
check '...selecting the one Windows Boot Manager entry from the listing, for one boot, and nothing else' '[ "$(nsel)" = 1 ] && grep -qx "rog-nv-linux sudo -n efibootmgr --bootnext 0003" "$SSH_LOG" && [[ "$out" == *"BootNext=0003 (Windows Boot Manager) for one boot; BootOrder untouched"* ]] && ! grep -Eq -- "--bootorder|efibootmgr .*-o |grub|--delete-bootnext" "$SSH_LOG"'
check '...with both of its lab locks held at the moment of the reboot' 'grep -qx "locks lane=held hold=held" "$SSH_LOG"'
check '...and both released when it returns' 'lock_free "$bl/rog.lock" && lock_free "$bl/rog.hold.lock"'
boot_run windows boot-windows rog
check 'boot-windows on a box already in Windows verifies Git Bash and reboots nothing' '[ "$rc" = 0 ] && [[ "$out" == *"already in Windows; no reboot"* ]] && [[ "$out" == *"native Git Bash answers"* ]] && ! grep -q "systemctl reboot\|efibootmgr" "$SSH_LOG"'
boot_run dark boot-windows rog
check 'boot-windows on a dark box wakes it into Ubuntu first, then reboots it into Windows' '[ "$rc" = 0 ] && grep -q "^python3 " "$SSH_LOG" && [[ "$out" == *"waking it into Ubuntu"* ]] && [ "$(nsel)" = 1 ] && [ "$(cat "$tmp/boot.state")" = windows ]'
BOOT_FIRMWARE=hang boot_run linux boot-windows rog
check 'a Windows endpoint that never answers is a loud NEEDS A PERSON (exit 3), never a silent wait' '[ "$rc" = 3 ] && [[ "$out" == *"NEEDS A PERSON: rog answers in NEITHER OS"*"BitLocker recovery prompt"* ]] && [[ "$out" == *"rog: linux=down windows=down"* ]] && [ "$took" -lt 60 ]'
BOOT_FIRMWARE=ignore boot_run linux boot-windows rog
check 'a box that comes back in Ubuntu reads as firmware that ignored BootNext' '[ "$rc" = 1 ] && [[ "$out" == *"came back in Ubuntu, so the firmware ignored BootNext"* ]]'
BOOT_FIRMWARE=noop boot_run linux boot-windows rog
check 'an accepted reboot after which Ubuntu still answers is NEEDS A PERSON, with the selection taken back' '[ "$rc" = 3 ] && [[ "$out" == *"NEEDS A PERSON: rog accepted its reboot but Ubuntu still answers"* ]] && grep -q -- "--delete-bootnext" "$SSH_LOG" && [ ! -e "$tmp/boot.state.next" ] && [[ "$out" == *"no BootNext left set"* ]]'
BOOT_FIRMWARE=noop BOOT_FLAKE=1 boot_run linux boot-windows rog
check 'one failed probe after the reboot is not the reboot: a box that never went down is NEEDS A PERSON, not firmware that ignored BootNext' '[ "$rc" = 3 ] && [[ "$out" == *"rog=DOWN"*"rog=up"* ]] && [[ "$out" == *"accepted its reboot but Ubuntu still answers"* ]] && [[ "$out" != *"firmware ignored"* ]] && [ ! -e "$tmp/boot.state.next" ]'
BOOT_UNDO=fail BOOT_READBACK=0001 boot_run linux boot-windows rog
check 'a selection that cannot be verified gone is NEEDS A PERSON, not an ordinary refusal' '[ "$rc" = 3 ] && [[ "$out" == *"BootNext could NOT be verified gone"* ]] && [[ "$out" == *"NEEDS A PERSON: rog may still carry a BootNext into Windows"* ]] && [ "$(grep -c -- "--delete-bootnext" "$SSH_LOG")" -ge 2 ]'
BOOT_NEXT_DROP=1 boot_run linux boot-windows rog
check 'a BootNext write whose answer was lost is taken back, and nothing reboots' '[ "$rc" = 1 ] && grep -q -- "--delete-bootnext" "$SSH_LOG" && [ ! -e "$tmp/boot.state.next" ] && ! grep -q "exec sudo -n systemctl reboot" "$SSH_LOG"'
BOOT_READBACK=0001 boot_run linux boot-windows rog
check 'a BootNext that does not read back as the entry is taken back and nothing reboots' '[ "$rc" = 1 ] && [[ "$out" == *"did not read BootNext back as 0003"* ]] && grep -q -- "--delete-bootnext" "$SSH_LOG" && ! grep -q "exec sudo -n systemctl reboot" "$SSH_LOG"'
BOOT_SUDO=deny boot_run linux boot-windows rog
check 'with no sudoers grant the reboot is refused before any selection is made' '[ "$rc" = 1 ] && [[ "$out" == *"not granted there (install /etc/sudoers.d/50-fleet-boot"* ]] && [ "$(nsel)" = 0 ] && ! grep -q "exec sudo -n systemctl reboot" "$SSH_LOG"'
BOOT_SUDO=nobootnext boot_run linux boot-windows rog
check 'a refused selection reboots nothing' '[ "$rc" = 1 ] && [[ "$out" == *"BootNext=0003 could not be set"* ]] && ! grep -q "exec sudo -n systemctl reboot" "$SSH_LOG"'
BOOT_LISTING="$BOOT_LISTING_DEFAULT
Boot0004  Windows Boot Manager${tab}HD(2,GPT,dddd)" boot_run linux boot-windows rog
check 'two Windows Boot Manager entries are an ambiguity, refused with nothing selected' '[ "$rc" = 1 ] && [[ "$out" == *"exactly one is needed"* ]] && [ "$(nsel)" = 0 ]'
BOOT_LISTING="BootNext: 0005
$BOOT_LISTING_DEFAULT" boot_run linux boot-windows rog
check 'a BootNext someone else set is refused, never replaced or deleted' '[ "$rc" = 1 ] && [[ "$out" == *"a BootNext is already set there (BootNext: 0005)"* ]] && [ "$(nsel)" = 0 ] && ! grep -q -- "--delete-bootnext" "$SSH_LOG"'
BOOT_LISTING="BootOrder: 0001
Boot0001* ubuntu${tab}HD(1,GPT,aaaa)" boot_run linux boot-windows rog
check 'a listing with no Windows Boot Manager entry is refused' '[ "$rc" = 1 ] && [[ "$out" == *"exactly one is needed"* ]] && [ "$(nsel)" = 0 ]'
BOOT_GITBASH=wsl boot_run linux boot-windows rog
check 'Windows answering without a native Git Bash is not success' '[ "$rc" = 1 ] && [[ "$out" == *"but its Git Bash did not"* ]]'
BOOT_INHIBITORS='fleet-worker 1000 lukstafi 86901 systemd-inhibit sleep:idle rog-nv-linux slot 1 of 1: bash -c x block
' boot_run linux boot-windows rog
check 'a run holding a sleep block inhibitor refuses the reboot' '[ "$rc" = 1 ] && [[ "$out" == *"a run holds a sleep block inhibitor there"* ]] && [ "$(nsel)" = 0 ]'
# The lock refusal, both locks, each held and each stale. A held lock refuses with nothing sent at
# all; a stale line on a free lock is text, not a holder, and never refuses.
for which in lane hold; do
  if [ "$which" = lane ]; then f="$bl/rog.lock"; else f="$bl/rog.hold.lock"; fi
  printf 'ocannl sweep 20260924T0517Z (pid 76065, since 20260924T051742Z)\n' >"$f"
  exec 7>>"$f"
  perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&7; took=$?
  check "control: the suite holds rog's $which lock" '[ "$took" = 0 ] && ! lock_free "$f"'
  for verb in boot-windows boot-linux; do
    boot_run linux "$verb" rog
    check "$verb is refused while the $which lock is held, naming its holder, with nothing sent" '[ "$rc" = 1 ] && [[ "$out" == *"$verb REFUSED on rog: ocannl sweep 20260924T0517Z"*"--force"* ]] && [ ! -s "$SSH_LOG" ]'
  done
  boot_run linux boot-windows --force rog
  check "--force takes the box while the $which lock is held, and says so" '[ "$rc" = 0 ] && [[ "$out" == *"WITHOUT the lab locks or the reservation check (--force)"* ]] && [ "$(nsel)" = 1 ]'
  exec 7>&-
  boot_run linux boot-windows rog
  check "a stale $which lock line whose holder is gone does not refuse" '[ "$rc" = 0 ] && lock_free "$f" && [ "$(nsel)" = 1 ]'
done
boot_run windows boot-linux rog
check 'boot-linux restarts Windows into Ubuntu over the LAN route, under both lab locks' '[ "$rc" = 0 ] && grep -q "^rog-lan .*shutdown /r /f /t 0" "$SSH_LOG" && grep -qx "locks lane=held hold=held" "$SSH_LOG" && [[ "$out" == *"rog: in Ubuntu"* ]] && [ "$(cat "$tmp/boot.state")" = linux ]'
check '...and never touches the EFI selection' '! grep -q efibootmgr "$SSH_LOG"'
BOOT_WIN_RESTART=dark boot_run windows boot-linux rog
check 'a restart after which nothing answers is NEEDS A PERSON' '[ "$rc" = 3 ] && [[ "$out" == *"NEEDS A PERSON"*"restart into Ubuntu"* ]]'
BOOT_WIN_SCHEDULED=1 boot_run windows boot-linux rog
check 'a restart already scheduled (1190) is waited out as the restart it is, not a failure that releases the locks' '[ "$rc" = 0 ] && [[ "$out" == *"already scheduled there (1190)"* ]] && [[ "$out" == *"rog: in Ubuntu"* ]] && grep -qx "locks lane=held hold=held" "$SSH_LOG"'
BOOT_WIN_SCHEDULED=1 BOOT_WIN_RESTART=noop boot_run windows boot-linux rog
check '...and one that then never happens is NEEDS A PERSON' '[ "$rc" = 3 ] && [[ "$out" == *"accepted its restart but Windows still answers"* ]]'
BOOT_WIN_RESTART=noop boot_run windows boot-linux rog
check 'an accepted restart after which Windows still answers is NEEDS A PERSON, never a release over a pending restart' '[ "$rc" = 3 ] && [[ "$out" == *"NEEDS A PERSON: rog accepted its restart but Windows still answers"* ]]'
BOOT_WIN_RESTART=windows boot_run windows boot-linux rog
check 'a restart that comes back in Windows says so' '[ "$rc" = 1 ] && [[ "$out" == *"came back in Windows"* ]]'
boot_run dark boot-linux rog
check 'boot-linux on a dark box wakes it into Ubuntu' '[ "$rc" = 0 ] && grep -q "^python3 " "$SSH_LOG" && ! grep -q shutdown "$SSH_LOG"'
boot_run linux boot-linux rog
check 'boot-linux on a box already in Ubuntu restarts nothing' '[ "$rc" = 0 ] && [[ "$out" == *"already in Ubuntu"* ]] && ! grep -q shutdown "$SSH_LOG"'
# The probe overrides the site's kind for the session (box_kind): a box set to wsl in the site
# file but found in Windows is waited on through its Linux endpoint, not its WSL guest.
sed 's/echo linux/echo wsl/' "$tmp/rog-hosts.sh" >"$tmp/rog-wsl.sh"
BOOT_HOSTS="$tmp/rog-wsl.sh" boot_run windows boot-linux rog
check 'a site kind of wsl is overridden by what the probe found' '[ "$rc" = 0 ] && [[ "$out" == *"rog: in Ubuntu"* ]] && ! grep -q "^rog-nv-wsl " "$SSH_LOG"'
BOOT_GITBASH=late BOOT_WAIT=30 boot_run windows boot-windows rog
check 'on a box already in Windows, Git Bash is polled within the boot budget too' '[ "$rc" = 0 ] && [[ "$out" == *"already in Windows"*"but its Git Bash did not"*"native Git Bash answers"* ]]'
BOOT_GITBASH=late BOOT_WAIT=30 boot_run linux boot-windows rog
check 'a Git Bash not yet up when sshd first answers is polled again, not failed' '[ "$rc" = 0 ] && [[ "$out" == *"but its Git Bash did not"*"native Git Bash answers on rog-lan"* ]] && [ "$took" -lt 25 ]'
# The execution registry covers both OSes: a native Windows run holds no logind inhibitor and need
# not take a lab lock. So a reboot runs under the caller's own exclusive (measurement) reservation,
# named with --as, and any other reservation naming any endpoint of the box refuses both verbs.
res="[$OWN,"'{"request_id":"w-9-win","request":{"execution_host":"rog-nv-win","kind":"correctness"},"state":"running"}]'
FW_LISTING="$res" boot_run windows boot-linux rog
check 'another reservation on the box'"'"'s Windows endpoint refuses boot-linux, naming it, with nothing sent' '[ "$rc" = 1 ] && [[ "$out" == *"reservation: w-9-win (running)"*"boot-linux REFUSED on rog: an active execution reservation besides w-own names it"* ]] && [[ "$out" != *"reservation: w-own"* ]] && [ ! -s "$SSH_LOG" ]'
FW_LISTING="$res" boot_run linux boot-windows rog
check '...and boot-windows too' '[ "$rc" = 1 ] && [[ "$out" == *"boot-windows REFUSED on rog: an active execution reservation besides w-own"* ]] && [ ! -s "$SSH_LOG" ]'
BOOT_AS_ID= boot_run linux boot-windows rog
check 'with no --as the reboot is refused: it runs only under the caller'"'"'s own reservation' '[ "$rc" = 1 ] && [[ "$out" == *"pass --as=<request_id> of the active measurement reservation you hold on it"* ]] && [ ! -s "$SSH_LOG" ]'
FW_LISTING="$res" BOOT_AS_ID=w-9-win boot_run windows boot-linux rog
check '--as naming a correctness (shared) reservation is refused' '[ "$rc" = 1 ] && [[ "$out" == *"--as=w-9-win is not an active measurement reservation"* ]] && [ ! -s "$SSH_LOG" ]'
FW_LISTING='[{"request_id":"w-own","request":{"execution_host":"minix-amd-linux","kind":"measurement"},"state":"running"}]' boot_run linux boot-windows rog
check '...and so is one on another box'"'"'s endpoint' '[ "$rc" = 1 ] && [[ "$out" == *"--as=w-own is not an active measurement reservation"* ]] && [ ! -s "$SSH_LOG" ]'
FW_LISTING='[]' boot_run linux boot-windows rog
check '...and one the registry does not list as active' '[ "$rc" = 1 ] && [[ "$out" == *"not an active measurement reservation"* ]] && [ ! -s "$SSH_LOG" ]'
FW_LISTING="[$OWN,"'{"request_id":"w-11","request":{"execution_host":"minix-amd-linux","kind":"correctness"},"state":"running"}]' boot_run linux boot-windows rog
check 'another box'"'"'s reservation does not refuse' '[ "$rc" = 0 ]'
FW_LISTING='not json' boot_run linux boot-windows rog
check 'an unreadable registry refuses the reboot' '[ "$rc" = 1 ] && [[ "$out" == *"execution registry could not be read"* ]] && [ ! -s "$SSH_LOG" ]'
FW_LISTING='not json' BOOT_AS_ID= boot_run linux boot-windows --force rog
check '...and --force takes the box anyway, saying so' '[ "$rc" = 0 ] && [[ "$out" == *"WITHOUT the lab locks or the reservation check (--force)"* ]]'
# An interrupt between the selection and the reboot takes the selection back: the stub's reboot
# command wedges, and the suite TERMs the command while it waits on it.
: >"$SSH_LOG"; rm -f "$tmp/boot.state".*; echo linux >"$tmp/boot.state"
( PATH="$tmp/bootbin:$PATH" BOOT_STATE="$tmp/boot.state" WAKE_LAB_LOCK_DIR="$bl" WAKE_LAB_HOSTS="$tmp/rog-hosts.sh" \
  BOOT_LISTING="$BOOT_LISTING_DEFAULT" BOOT_FIRMWARE=wedge WAKE_LAB_FLEET_WORKER="$tmp/fleet-worker.sh" FW_LISTING="[$OWN]" \
  exec "$tmp/wake-lab.sh" boot-windows --as=w-own rog >"$tmp/boot-term.out" 2>&1 7>&- ) &
bpid=$!
for _ in $(seq 1 100); do grep -q reboot-wedged "$SSH_LOG" && break; sleep 0.1; done
kill -TERM "$bpid" 2>/dev/null; wait "$bpid"; rc=$?
check 'a TERM after BootNext was set, before the reboot happened, takes the selection back' '[ "$rc" = 130 ] && grep -q -- "--delete-bootnext" "$SSH_LOG" && [ ! -e "$tmp/boot.state.next" ] && grep -q "no BootNext left set" "$tmp/boot-term.out"'
check 'control: that selection had been set before the TERM' 'grep -qx "rog-nv-linux sudo -n efibootmgr --bootnext 0003" "$SSH_LOG" && grep -q reboot-wedged "$SSH_LOG"'
BOOT_HOSTS="$tmp/hosts.sh" boot_run linux boot-windows tuf
check 'tuf, with no wired NIC, is refused with the reason and nothing sent' '[ "$rc" = 1 ] && [[ "$out" == *"boot-windows REFUSED on tuf: it has no wired NIC"* ]] && [ ! -s "$SSH_LOG" ]'
boot_run linux boot-windows
check 'boot-windows with no box reboots no default' '[ "$rc" = 2 ] && [[ "$out" == *"boot-windows needs a box"* ]] && [ ! -s "$SSH_LOG" ]'
BOOT_HOSTS="$tmp/lab-hosts.sh" boot_run linux boot-windows rog minix
check '...and two boxes are refused too' '[ "$rc" = 1 ] && [[ "$out" == *"takes exactly one box (got 2)"* ]] && [ ! -s "$SSH_LOG" ]'
[ "$fail" -eq 0 ]
exit "$?"
}
