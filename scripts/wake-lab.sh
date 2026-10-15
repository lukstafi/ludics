#!/bin/bash
# Drive the home-lab machines' power state remotely: wake, sleep, hibernate, shut down, inspect.
#
# Waking uses two independent paths, both attempted:
#   1. FRITZ!Box TR-064 `X_AVM-DE_WakeOnLANByMACAddress` — the router emits the magic
#      packet on the wired LAN segment. No credentials needed from the LAN side.
#   2. A magic packet sent directly from this Mac (broadcast, UDP ports 7 and 9).
#
# Usage:
#   wake-lab.sh rog|minix|tuf|all ...     wake the named boxes (all: every box in the endpoint map)
#   wake-lab.sh --wait [--wsl] rog        wake, then poll until configured OS answers, and on a
#                                         linux box until its own ssh to the anchor works too
#                                         (WAKE_LAB_ANCHOR, default mac-studio; "the anchor leg")
#   wake-lab.sh --wait --restart-wsl rog  ...and start WSL from a FRESH VM (wsl --shutdown first)
#   wake-lab.sh status [box...]           per-box reachability and reached OS, whether each lab lock
#                                         is really held, and the box's execution reservations
#                                         (default: every box)
#   wake-lab.sh sleep|hibernate|down box  suspend / hibernate / full shutdown
#                                         (a destroyer's --as=ID spares only the caller's own
#                                         measurement reservation; see the next paragraph)
#   wake-lab.sh kick-wsl box              start the WSL VM (it never autostarts at boot)
#   wake-lab.sh restart-wsl box           shut the WSL VM down and start it again
#   wake-lab.sh kick-wsl --hold box       ...and leave a Windows-side holder keeping the VM alive
#   wake-lab.sh unhold box                end that holder (a lane ends by unhold, never by expiry)
#   wake-lab.sh lock-path box             where that box's LANE lock lives, for a harness taking one
#   wake-lab.sh boot-windows --as=ID box  reboot a dual-boot box into Windows for ONE boot,
#                                         unattended, and wait until its Git Bash answers; ID is the
#                                         caller's active measurement reservation on the box, and any
#                                         other reservation there refuses it (see "dual boot" below)
#   wake-lab.sh boot-linux --as=ID box    ...and back: reboot it (or wake it) into Ubuntu; both are
#                                         reboots, so a desktop session's open apps close with them
#   wake-lab.sh --list                    dump the router's host table
#   wake-lab.sh endpoint-map              print each box's row of the endpoint map as data, the box
#                                         and then its ssh aliases; needs no site table, takes no box
# Every verb but `status` and `endpoint-map` needs a box (or `all`): with none, wake-lab.sh prints
# this and exits 2, sending nothing. A bare invocation is what you type to see the usage, so it must never wake,
# sleep or restart anything.
# WSL and Windows hardware notes live with the adapter in scripts/wake-lab-wsl.sh.
#
# Every path that takes a box away from whatever is running on it -- `restart-wsl` and
# `--restart-wsl`, which shut the VM down host-globally, and `sleep`/`hibernate`/`down` and the two
# `boot-*` verbs, which take the whole host -- RESERVES the box first and refuses one another tool is using. The reservation is
# held across the destructive command rather than checked before it, because a check and an act
# with a gap between them is the race this exists to close. It spans BOTH of that box's lab locks
# -- the lane lock and the hold lock, which say two different things and are held by two different
# kinds of user -- and `--force` overrides both. The lab lock lore below says which is which, why
# there are two, when `--force` is the right call, and what each cost the day it was not there.
# Holding them, every one of these also refuses a box an outstanding `measurement` reservation in
# the fleet's execution registry names (ludics-lite#445): an exclusive timing run holds no lab
# lock. `--as=<request_id>` spares the caller's own measurement, an unreadable registry refuses,
# and `--force` skips this check with the locks (measured_box_clear, below the lock lore).
#
# Tracked in the ludics-lite repository as scripts/wake-lab.sh and meant to be reached through a
# ~/bin/wake-lab.sh symlink, so an edit made mid-run lands as a normal `git status`. One part is
# deliberately NOT tracked: the fleet's MAC and LAN IP addresses, which live in a site file this
# script sources at startup — ~/.config/wake-lab/hosts.sh, or wherever WAKE_LAB_HOSTS points. It
# defines mac_of, eth_mac_of, ip_of and kind_of, and the script refuses to run without it;
# scripts/wake-lab-hosts.example.sh in the checkout is the template. Everything else — the lab
# lore below, the router endpoints, the ssh aliases, all of the logic — is tracked and reviewable.
#
# -h/--help prints this block, which ends at the first non-comment line, so it can grow freely.
# Requires bash 3.2 (stock macOS): no associative arrays, no ${var,,}.
set -u

# Bash reads a script by OFFSET while it runs, so a writer that rewrites this file IN PLACE, through
# its own inode (`cp` over it, a shell `>` redirection, `rsync --inplace`, an editor that saves in
# place), resumes a running shell mid-command in whatever text now sits at the offset it left off
# at. `--wait` and a lock wait live for minutes, from the checkout its ~/bin symlink resolves into.
# A git fast-forward is not such a writer: checkout unlinks the old file and creates a new one, and
# a running shell keeps reading the old inode (measured for ludics-lite#437). Everything below is
# one brace group, parsed whole before its first command runs, and the closing exit means the shell
# never comes back to the file; the body keeps its own indentation, so the guard is these lines and
# two at the foot. scripts/check-parse-guards.sh holds the shape (ALSO_GUARDED), and
# scripts/test-check-parse-guards.sh rewrites the file in place under a running copy.
{

ROUTER=192.168.178.1
BCAST=192.168.178.255
HOSTS_CTL=/upnp/control/hosts
HOSTS_SVC=urn:dslforum-org:service:Hosts:1

# ---------------------------------------------------------------- machine table
# Verified lab constraints. Do not spend a session rediscovering them; the dates say when each
# was last checked.
#
# * WoL works over Ethernet only, never over Wi-Fi: a magic packet cannot reach the Wi-Fi NIC of
#   a powered-off machine. Both MACs are in the host table and packets go to both, but the
#   Ethernet one does the waking. All three boxes are CABLED, through a TP-Link switch to the
#   router since 2026-10-12 (rog Ethernet .30, minix Ethernet .31, tuf Ethernet .35; the .27
#   and .29 Wi-Fi leases are minix's and tuf's). tuf (formerly asus-amd) is cabled but still
#   needs manual wake, though native Linux SSH can be checked after it resumes: an s2idle-only
#   ASUS laptop whose onboard r8169 loses power in sleep, and whose USB AX88179B adapter cannot
#   arm WoL under cdc_ncm and gets no link under ax88179_178a (all tested 2026-10-12). Its
#   Ethernet MAC is therefore left out of eth_mac_of in the site file.
# * Both boxes wake from a full shutdown (S5), not just from sleep — verified 2026-08-15 on both,
#   after enabling the `Wake Up` item on minix's BIOS SECOND setup screen (not under Advanced).
#   "Powered off" is a normal starting state for a wake, not a reason to expect failure.
# * `status` -> router-active is the router's NewActive bit for the box's Ethernet MAC, read over
#   TR-064 -- the router's opinion of the lease, not NIC telemetry, and the column is named for
#   what it reads so that it is not mistaken for link state. It is a fast UP signal and a SLOW
#   DOWN signal: for several minutes after a shutdown or hibernate, router-active=1 is a stale
#   DHCP lease aging out, and diagnosing the wake path from it is a misdiagnosis (2026-09-01);
#   wait for it to settle first. Since the boxes reach the router through a switch (2026-10-12)
#   it says even less: their traffic with the hub no longer passes the router, so rog and minix
#   read router-active=0 while answering ssh, and the router's port holds link with the switch
#   whatever a box's NIC does. Neither value tells whether a powered-off NIC is WoL-armed any
#   more. A failed wake means the magic packet was ignored or never reached the NIC: check the
#   cable and switch port, the BIOS WoL option (and the one that keeps the NIC powered in S5), and
#   the NIC wake settings of the OS last running on the box.
# mac_of (every MAC of a box), eth_mac_of (the Ethernet one alone, whose lease is what
# router_active asks the router about) and ip_of are NOT here: they are the fleet's hardware
# addresses, the one part of this script that is site data rather than reviewable logic, and they
# come from HOSTS_FILE.
HOSTS_FILE=${WAKE_LAB_HOSTS:-$HOME/.config/wake-lab/hosts.sh}

# Refuse rather than run half-configured: without the table every box is "unknown machine", which
# reads like a typo in the command rather than a missing install step.
load_hosts() {
  local f
  if [ ! -r "$HOSTS_FILE" ]; then
    echo "wake-lab.sh: no host table at $HOSTS_FILE" >&2
    echo "  copy scripts/wake-lab-hosts.example.sh from the ludics-lite checkout there and fill" >&2
    echo "  in this fleet's MACs and IPs, or point WAKE_LAB_HOSTS at your own copy." >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$HOSTS_FILE" || { echo "wake-lab.sh: $HOSTS_FILE failed to load" >&2; exit 1; }
  for f in mac_of eth_mac_of ip_of kind_of; do
    declare -F "$f" >/dev/null && continue
    echo "wake-lab.sh: $HOSTS_FILE defines no $f() — see scripts/wake-lab-hosts.example.sh" >&2
    exit 1
  done
}

# The table's box list is mac_of's, and every target must be in it BEFORE anything is sent. A table
# that knows rog but not minix would otherwise wake rog, then report minix as a typo halfway
# through the operation -- and the dispatch loop's exit status hides that, so the run reads as a
# success. Refusing the whole run is what "refuse rather than run half-configured" means here. The
# same holds for the endpoint map below: the map is checked whole, and then every target's row,
# whatever its kind.
check_targets() {
  local t bad="" kind
  check_map || exit 1
  for t in "$@"; do
    mac_of "$t" >/dev/null 2>&1 || { bad="$bad $t"; continue; }
    kind=$(box_kind "$t") || kind=""
    case "$kind" in
      linux|wsl) ;;
      *) echo "wake-lab.sh: invalid kind for $t: ${kind:-(none)} (expected wsl or linux)" >&2; exit 1 ;;
    esac
    check_endpoints "$t" "$kind" || exit 1
  done
  [ -z "$bad" ] && return 0
  echo "wake-lab.sh: not in the host table ($HOSTS_FILE):$bad" >&2
  echo "  the known boxes are the ones mac_of answers for; nothing was sent." >&2
  exit 1
}

# The kind a box is operated as this run. That is the site's static kind_of, and every dispatch
# reads it through here rather than calling kind_of itself, so that a probe of what a dual-boot box
# really booted overrides it for the session in this one place: boot-windows and boot-linux
# (ludics-lite#353) set BOOT_BOX and BOOT_KIND from their probe -- linux, or windows, a kind only
# this override ever yields -- and every is_up after that reads the endpoints of the OS the box is
# really in. The site file is never written: kind_of stays the operator's setting.
BOOT_BOX=""
BOOT_KIND=""
box_kind() {
  if [ -n "$BOOT_KIND" ] && [ "$1" = "$BOOT_BOX" ]; then printf '%s\n' "$BOOT_KIND"; else kind_of "$1"; fi
}

# ---------------------------------------------------------------- the endpoint map
# The ONE box -> ssh endpoint mapping (ludics-lite#314). Validation, status, the waits and the WSL
# adapter all read it through endpoint_of, and nothing else in either file names an ssh alias: while
# the aliases were restated in four places, the review of the asus -> tuf rename (PR #313) twice
# found one that had been missed -- a Windows endpoint that passed WSL validation with no guest
# alias, and a status that never probed the renamed box's Windows boot. An endpoint names the OS it
# reaches:
#   linux  native Ubuntu                  win  the Windows host's sshd, over Tailscale
#   wsl    the WSL guest on that host     lan  the same Windows sshd over the direct LAN route,
#                                              which answers seconds after a cold boot
# A row lists every OS the box can boot, whatever kind_of says it is set to today: kind_of is the
# site's current setting (hosts.sh), this is which endpoints exist, and status probes the others so
# that a dual-boot box which booted the other OS says so. The short box names, first on each row,
# are the WoL and lock identities, and the rows in order are the lab: `all` and a bare `status`
# expand to them. Adding or renaming a box is one row here plus its hosts.sh entries, and
# check_endpoints refuses an incomplete row before anything is sent.
ENDPOINT_MAP=(
  "rog   linux=rog-nv-linux    win=rog-nv-win    wsl=rog-nv-wsl    lan=rog-lan"
  "minix linux=minix-amd-linux win=minix-amd-win wsl=minix-amd-wsl lan=minix-lan"
  "tuf   linux=tuf-amd-linux   win=tuf-amd-win   wsl=tuf-amd-wsl"    # cabled, no WoL: manual wake
)

endpoints_of() { # endpoints_of <box> -- that box's row, less its name; 1 when the map has none
  local r name rest
  for r in "${ENDPOINT_MAP[@]}"; do
    read -r name rest <<<"$r"
    [ "$name" = "$1" ] && { printf '%s\n' "$rest"; return 0; }
  done
  return 1
}

lab_boxes() { # the map's box names, in row order, one per line
  local r name rest
  for r in "${ENDPOINT_MAP[@]}"; do read -r name rest <<<"$r"; printf '%s\n' "$name"; done
}

endpoint_of() { # endpoint_of <box> linux|win|wsl|lan -- that OS's ssh alias; 1 when the box has none
  local row w ws
  row=$(endpoints_of "$1") || return 1
  # An array, not an unquoted $row, so that no glob can expand in the split; the count guard is for
  # bash 3.2, which calls an empty array unbound under set -u.
  read -r -a ws <<<"$row"; [ ${#ws[@]} -gt 0 ] || return 1
  for w in "${ws[@]}"; do
    case "$w" in "$2"=?*) printf '%s\n' "${w#*=}"; return 0 ;; esac
  done
  return 1
}

# check_map -- the rules no single row can check, or say what is wrong and return 1.
#  * Each box name has one row, and is a plain name (a letter or digit, then letters, digits, `_`
#    and `-`), since it also names the box's lock files. endpoints_of reads a name's first row
#    while `all` expands to every row, so a second row would be acted on twice and validated never.
#    Nor may it be a word the argument parser takes (a verb, or `all`): `wake-lab.sh down` would
#    power off the default boxes instead of waking a box called down.
#  * Each alias belongs to one box. A row copied from another box and never edited is complete by
#    every per-row rule, and would reach that other box under this one's locks: `sleep nova` would
#    suspend tuf without seeing a lane or hold lock taken on tuf.
check_map() {
  local r name rest w ws owner boxes=" " aliases=" " bad=""
  for r in "${ENDPOINT_MAP[@]}"; do
    read -r name rest <<<"$r"
    case "$name" in
      ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) bad="$bad the box name $(printf %q "$name") is not a plain name;"; continue ;;
    esac
    case "$name" in
      status|sleep|hibernate|down|kick-wsl|restart-wsl|unhold|lock-path|boot-windows|boot-linux|endpoint-map|all)
        bad="$bad the box name $name is a command word;"; continue ;;
    esac
    case "$boxes" in *" $name "*) bad="$bad $name has two rows;"; continue ;; esac
    boxes="$boxes$name "
    read -r -a ws <<<"$rest"
    for w in ${ws[@]+"${ws[@]}"}; do
      case "$w" in *=?*) ;; *) continue ;; esac   # a malformed entry is check_endpoints' to name
      w=${w#*=}
      case "$aliases" in
        *" $w@"*) owner=${aliases#*" $w@"}; owner=${owner%% *}
                  bad="$bad the alias $(printf %q "$w") is on both $owner and $name;" ;;
        *) aliases="$aliases$w@$name " ;;
      esac
    done
  done
  [ -z "$bad" ] && return 0
  printf '%s\n' "wake-lab.sh: the endpoint map is inconsistent:${bad%;}" \
    "  fix ENDPOINT_MAP in wake-lab.sh; nothing was sent." >&2
  return 1
}

# check_endpoints <box> <kind> -- the box's row is complete, or say what is wrong and return 1.
# A fail-closed allowlist: the row is refused unless every rule holds, and each rule is an omission
# a review once had to find by hand.
#  * The box has a row. A box hosts.sh knows and this map does not reaches nothing.
#  * Every entry is `<os>=<alias>`, with one of the four keys above and an alias that starts with a
#    letter or digit and goes on in letters, digits, `.`, `_` and `-`. A misspelt key is an OS that
#    status would silently never probe, and an alias with a leading `-` is an ssh OPTION: `ssh
#    -V-linux 'exit 0'` prints the version and exits 0, so the probe reads the box as UP.
#  * win and wsl come as a pair. A Windows host with no guest alias passed WSL validation (tuf, PR
#    #313), and a guest with no host has nothing to start its VM.
#  * lan only beside win: it is a second route to that same Windows sshd.
#  * linux, win and wsl share one stem (`<stem>-linux`, `<stem>-win`, `<stem>-wsl`), and lan is
#    `<box>-lan`. A half-renamed row would go on probing the old box's name for one of its OSes.
#  * The configured kind's own endpoints are there.
check_endpoints() {
  local box=$1 kind=$2 row w ws key alias stem="" linux="" win="" wsl="" lan="" bad="" seen=""
  if ! row=$(endpoints_of "$box"); then
    printf '%s\n' "wake-lab.sh: no ssh endpoints for $box in wake-lab.sh's endpoint map" \
      "  add its row to ENDPOINT_MAP; nothing was sent." >&2
    return 1
  fi
  read -r -a ws <<<"$row"
  [ ${#ws[@]} -gt 0 ] || ws=("(empty row)")
  for w in "${ws[@]}"; do
    case "$w" in *=*) ;; *) bad="$bad $(printf %q "$w") is not <os>=<alias>;"; continue ;; esac
    key=${w%%=*}; alias=${w#*=}
    case "$alias" in
      ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) bad="$bad $(printf %q "$w") is not a plain ssh alias;"; continue ;;
    esac
    # Twice is refused rather than resolved: endpoint_of reads the first and this the last.
    case " $seen " in *" $key "*) bad="$bad $(printf %q "$key") is listed twice;"; continue ;; esac
    seen="$seen $key"
    case "$key" in
      linux) linux=$alias ;;
      win)   win=$alias ;;
      wsl)   wsl=$alias ;;
      lan)   lan=$alias ;;
      *) bad="$bad unknown endpoint $(printf %q "$key") (expected linux, win, wsl or lan);" ;;
    esac
  done
  [ -n "$win" ] && [ -z "$wsl" ] && bad="$bad a Windows endpoint ($win) with no WSL guest alias;"
  [ -n "$wsl" ] && [ -z "$win" ] && bad="$bad a WSL guest ($wsl) with no Windows host to start it;"
  [ -n "$lan" ] && [ -z "$win" ] && bad="$bad a LAN route ($lan) with no Windows endpoint;"
  [ -n "$lan" ] && [ "$lan" != "${box}-lan" ] && bad="$bad the LAN route $lan is not $box-lan;"
  for w in "${linux}:-linux" "${win}:-win" "${wsl}:-wsl"; do
    alias=${w%%:*}; key=${w#*:}
    [ -n "$alias" ] || continue
    case "$alias" in
      ?*"$key") [ -n "$stem" ] || stem=${alias%"$key"}
                [ "${alias%"$key"}" = "$stem" ] || bad="$bad $alias does not share the stem $stem;" ;;
      *) bad="$bad $alias does not end in $key;" ;;
    esac
  done
  case "$kind" in
    linux) [ -n "$linux" ] || bad="$bad no linux ssh endpoint for a linux box;" ;;
    wsl)   [ -n "$win" ] || bad="$bad no Windows ssh endpoint for a wsl box;"
           [ -n "$wsl" ] || bad="$bad no WSL guest ssh endpoint for a wsl box;" ;;
  esac
  [ -z "$bad" ] && return 0
  printf '%s\n' "wake-lab.sh: incomplete ssh endpoints for $box:${bad%;}" \
    "  fix its row in ENDPOINT_MAP; nothing was sent." >&2
  return 1
}

# ---------------------------------------------------------------- plumbing
# The header block, line 2 through the last line before the first non-comment line. The range was
# once hard-coded as 2,20p, which silently truncated the help whenever the header grew.
usage() { sed -n '2,${/^#/!q;p;}' "$0"; }

soap() { # soap <control-url> <serviceType> <action> <inner-xml>
  local body="<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:$3 xmlns:u=\"$2\">${4:-}</u:$3></s:Body></s:Envelope>"
  curl -s -m 10 -H 'Content-Type: text/xml; charset="utf-8"' -H "SoapAction: $2#$3" \
       -d "$body" "http://$ROUTER:49000$1"
}

# The router answers a refused action with an HTTP body containing <s:Fault>, and curl still exits
# 0 — so a bare `soap ... && echo sent` reports success for a MAC the router has never seen. Always
# route SOAP calls that matter through this.
soap_checked() { # soap_checked <control-url> <serviceType> <action> <inner-xml>; prints body, fails on fault
  local resp desc
  resp=$(soap "$@") || { echo "no response from router ($ROUTER)" >&2; return 1; }
  if [ -z "$resp" ]; then echo "empty response from router ($ROUTER)" >&2; return 1; fi
  if printf '%s' "$resp" | grep -q '<s:Fault>'; then
    desc=$(printf '%s' "$resp" | sed -n 's/.*<errorDescription>\([^<]*\)<.*/\1/p')
    echo "${desc:-SOAP fault}" >&2
    return 1
  fi
  printf '%s' "$resp"
}

# ssh's ConnectTimeout bounds the TCP connect ALONE and never the remote command, so every ssh
# here is unbounded the moment the far side accepts the connection and then wedges. On 2026-09-16
# that cost 2h40m: `wsl.exe -d Ubuntu -e true` on rog never returned, the caller (the scheduled
# cross-machine sweep) hung behind it, and the VM had in fact started — only the probe was stuck.
# Every remote command below therefore runs under a wall-clock cap. macOS ships no timeout(1), so
# the watchdog is a background subshell: SIGALRM at the deadline, SIGKILL a grace period later for
# anything that ignores it, and the 142/137 `wait` then reports is mapped to CAP_EXPIRED so a
# command the cap cut short is never read as one that ran and failed — the two mean opposite
# things, and the callers below act on the difference.
CAP_EXPIRED=124        # what `capped` returns for a cut-short command, as timeout(1) does
CAP_GRACE=5            # seconds between the SIGALRM and the SIGKILL behind it
capped() { # capped <seconds> <cmd...> — run cmd under a hard wall-clock cap
  local secs=$1 pid dog rc; shift
  # Redirections belong on the CALL, not in here: they then cover the watchdog too, which has
  # nothing to say, and the command keeps whatever the caller wanted to do with its output.
  "$@" & pid=$!
  # The watchdog has to be killable TOGETHER WITH its nap, and that is the whole reason for the
  # shape below. A `sleep` run in the watchdog's foreground is a separate process, so a signal to
  # the watchdog leaves it orphaned for the rest of its interval — up to WSL_START_CAP, two
  # minutes — still holding every descriptor the watchdog inherited. That is not only litter: an
  # orphan holding an inherited copy of the lab lock's descriptor keeps the lock alive after the
  # caller believes it has dropped it, which is how this was found. So the watchdog naps in a
  # background child and waits for it, which leaves it free to run a TERM trap that takes the nap
  # with it. `jobs -p` rather than a remembered `$!`, because a TERM arriving between the fork and
  # the assignment would find that variable unset, and that is the one window a remembered pid
  # cannot cover; `jobs -p` is whatever is actually running, whenever the trap happens to run.
  { trap 'kill -KILL $(jobs -p) 2>/dev/null; exit 0' TERM
    sleep "$secs" & wait $!
    kill -ALRM "$pid" 2>/dev/null
    sleep "$CAP_GRACE" & wait $!
    kill -KILL "$pid" 2>/dev/null; } >/dev/null 2>&1 &
  dog=$!
  # TERM, not KILL: the trap above is what reaps the nap, and an untrappable signal would put the
  # orphan straight back. A watchdog that somehow missed the trap still dies on TERM's default
  # action, so there is no path on which this wait outlives the watchdog.
  wait "$pid"; rc=$?
  kill -TERM "$dog" >/dev/null 2>&1; wait "$dog" >/dev/null 2>&1
  case "$rc" in 142|137) return "$CAP_EXPIRED" ;; esac
  return "$rc"
}

# The probes are capped as well, and not only for tidiness: a single wedged probe inside one of the
# polling loops below hangs it forever, because those loops check their deadline BETWEEN
# iterations. The cap is deliberately loose against the ConnectTimeout it wraps — it exists to
# bound a remote command that never returns, not to second-guess a slow connect.
PROBE_CAP=${WAKE_LAB_PROBE_CAP:-20}
ssh_probe() { # ssh_probe <alias> [timeout] — true iff sshd answers and authentication succeeds
  [ -n "$1" ] || return 1
  # `exit 0`, NOT `true`: the -win/-lan aliases land in cmd.exe, which has no `true` and would
  # report every Windows box as down. `exit 0` is valid in cmd.exe and in POSIX shells alike.
  capped "$PROBE_CAP" \
    ssh -o BatchMode=yes -o ConnectTimeout="${2:-5}" -o StrictHostKeyChecking=accept-new \
        "$1" 'exit 0' >/dev/null 2>&1
}

magic_packet() { # magic_packet <MAC>
  python3 - "$1" "$BCAST" <<'PY'
import socket, sys
mac, bcast = sys.argv[1], sys.argv[2]
pkt = b'\xff' * 6 + bytes.fromhex(mac.replace(':', '').replace('-', '')) * 16
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
for host in ('255.255.255.255', bcast):
    for port in (7, 9):
        s.sendto(pkt, (host, port))
s.close()
PY
}

# ---------------------------------------------------------------- inspection
list_hosts() {
  local n i
  n=$(soap $HOSTS_CTL $HOSTS_SVC GetHostNumberOfEntries \
      | sed -n 's/.*<NewHostNumberOfEntries>\([0-9]*\)<.*/\1/p')
  for ((i = 0; i < n; i++)); do
    soap $HOSTS_CTL $HOSTS_SVC GetGenericHostEntry "<NewIndex>$i</NewIndex>" \
      | sed -n 's/.*<NewHostName>\([^<]*\)<.*/\1/p;s/.*<NewMACAddress>\([^<]*\)<.*/\1/p;s/.*<NewIPAddress>\([^<]*\)<.*/\1/p;s/.*<NewActive>\([01]\)<.*/active=\1/p' \
      | paste -s -d' ' -
  done
  echo
  echo "NOTE: 'active' is a fast UP signal but a SLOW DOWN signal — a just-shut-down box reads"
  echo "active=1 for several minutes while its DHCP lease ages out, and a WoL-armed box holds the"
  echo "link (active=1) indefinitely while powered off. Use 'status' to ask what is really running."
}

router_active() { # router_active <box> — echo 1/0/? for the router's NewActive bit on the Ethernet MAC
  # NewActive is the router's view of the lease, not the NIC's link state; see the lore above.
  local mac out
  mac=$(eth_mac_of "$1") || { echo '?'; return; }
  out=$(soap_checked $HOSTS_CTL $HOSTS_SVC GetSpecificHostEntry "<NewMACAddress>$mac</NewMACAddress>" 2>/dev/null) \
    || { echo '?'; return; }
  printf '%s' "$out" | sed -n 's/.*<NewActive>\([01]\)<.*/\1/p' | head -1
}

# "Up" means the configured OS answers ssh -- or, inside boot-windows / boot-linux, the OS that
# command's probe found (box_kind). A dual-boot box can answer through the other OS; status
# reports both probes so a wake never claims to know which OS the firmware started.
is_up() { # is_up <box>
  case "$(box_kind "$1")" in
    wsl) wsl_box_live "$1" ;;
    linux) ssh_probe "$(endpoint_of "$1" linux)" ;;
    windows) win_alias "$1" >/dev/null ;;
  esac
}

# The box's live logind BLOCK inhibitors on sleep, one per line, from `systemd-inhibit --list`
# (ludics-lite#317). They are what refuses `sleep` (and `hibernate`) from the OS side -- a
# `fleet-worker.sh execution slot` or `execution hold` run holds one for as long as it runs --
# so a coordinator sees who is holding a box before it tries a power verb, rather than after the
# refusal. Only `block` entries covering `sleep` are kept: GNOME's own handle-*-key and
# lid-switch blocks, on every logged-in desktop, refuse no verb here and would bury the one
# that does. The filter reads the listing's WHAT and MODE columns as tokens; a WHY that happens
# to say "sleep" between spaces is kept too, which over-reports and never hides a holder.
# Returns nonzero when the listing could not be read at all.
sleep_blocks() { # sleep_blocks <ssh-host>
  local listing
  listing=$(capped "$PROBE_CAP" ssh -o BatchMode=yes -o ConnectTimeout=5 "$1" \
    'systemd-inhibit --list --mode=block --no-legend --no-pager' 2>/dev/null) || return 1
  printf '%s\n' "$listing" | grep -E '(^|[ :])sleep([ :]|$)' | grep -E '[[:space:]]block[[:space:]]*$' | tr -s ' '
  return 0
}

status_one() { # status_one <box>
  local l host win guest blocks="" n
  l=$(router_active "$1")
  printf '%-6s router-active=%-1s' "$1" "$l"
  if [ "$(box_kind "$1")" = wsl ]; then
    wsl_status_fields "$1"
  else
    host=$(endpoint_of "$1" linux) || return 1
    if ssh_probe "$host"; then
      printf '  os=linux  linux=UP'
      if blocks=$(sleep_blocks "$host"); then
        n=0; [ -z "$blocks" ] || n=$(printf '%s\n' "$blocks" | wc -l | tr -d ' ')
        printf '  sleep-blocks=%s' "$n"
      else
        printf '  sleep-blocks=?'
      fi
    else
      # A dual-boot box may have booted Windows despite its configured Linux kind, so every
      # other OS the endpoint map lists for it is probed -- a box with none reads os=--. These
      # are liveness probes only; the Windows commands stay in the WSL adapter, never read here.
      guest=$(endpoint_of "$1" wsl) || guest=""
      win=$(endpoint_of "$1" win) || win=""
      if ssh_probe "$guest"; then printf '  os=wsl  linux=--  wsl=UP'
      elif ssh_probe "$win"; then printf '  os=windows  linux=--  win=UP'
      else printf '  os=--  linux=--'; fi
    fi
  fi
  lab_locks_fields "$1"
  reservations_fields "$1"
  printf '\n'
  [ -z "$blocks" ] || printf '%s\n' "$blocks" | sed 's/^/         block: /'
  printf '%s' "$LOCK_DETAILS" "$RES_DETAILS"
}

do_status() {
  local n wsl_boxes=()
  reservations_read
  echo "box    router-active   reached OS and ssh endpoint, lab locks, execution reservations"
  for n in "$@"; do status_one "$n"; done
  echo
  for n in "$@"; do [ "$(box_kind "$n")" = wsl ] && wsl_boxes+=("$n"); done
  [ ${#wsl_boxes[@]} -gt 0 ] && wsl_status_extra "${wsl_boxes[@]}"
  echo "sleep-blocks counts a native Linux box's logind block inhibitors on sleep (listed under it):"
  echo "while one is held, 'sleep' and 'hibernate' there are refused by the OS, whatever the lab locks say."
  echo "lane-lock and hold-lock ask each lab lock's flock on THIS machine, not its text: 'held' means a"
  echo "destroyer would be refused now; a 'free' lock's leftover line is shown as stale text. reservations"
  echo "counts the active 'fleet-worker.sh execution list' records naming the box (? = registry unread)."
  echo "router-active is the router's NewActive bit for the Ethernet MAC, not the NIC's link state:"
  echo "minutes after a shutdown or hibernate, 1 is a stale DHCP lease still aging out; behind the LAN"
  echo "switch, 0 on a box that is up is normal, and neither value says whether the NIC is WoL-armed."
}

# ---------------------------------------------------------------- power control
# Poll budgets, in seconds, and they are wall-clock budgets: the loops below run to a deadline
# rather than to an iteration count. Counting iterations quietly lied whenever the boxes stayed
# dark -- each is_up() burns two ssh ConnectTimeouts, so 48 rounds over two unreachable boxes ran
# for about twenty minutes under the name of a four-minute wait, delaying the sweep that is the
# only coverage those backends get. The env overrides exist for the test suite.
WAIT_SECONDS=${WAKE_LAB_WAIT_SECONDS:-240}
DOWN_WAIT_SECONDS=${WAKE_LAB_DOWN_WAIT_SECONDS:-120}

# ---------------------------------------------------------------- the lab locks
# `wsl.exe --shutdown` is HOST-GLOBAL: it destroys the whole WSL2 VM, so every session on that box
# dies with it -- an in-flight sweep unit, and whatever terminals the operator had open. kick_wsl's
# own note ("the shutdown lands on the Windows host, never inside the VM, so it cannot kill the
# session issuing it") is true and was exactly the blind spot: it reasons about the session ISSUING
# the shutdown and says nothing about every other session on the VM.
#
# On 2026-09-16 that cost the cross-machine sweep both GPU units. Sweep 20260916T074913Z was
# 13 minutes into rog-nv/cuda and minix/hip when a second session, verifying a fix to THIS script
# against the real lab, ran `wake-lab.sh --wait --restart-wsl rog minix` at 08:02:30Z. Both guests
# rebooted (08:02:37Z, 08:02:40Z -- three seconds apart because the restart above is concurrent)
# and both units died on a reset connection seconds later. The sweep logged it as `error`, which
# reads as a box fault, and the failure was misattributed to the GPU autotune tests for two days:
# they are the longest-running tests in the suite, so a randomly-timed external kill lands in them
# far more often than anywhere else.
#
# So the boxes are a SHARED resource and destroying one needs an interlock. But "this box is in
# use" turned out to be TWO claims, and one exclusive file could not carry both of them:
#
#   "do not destroy this VM"        -- what `--hold` says, on behalf of whatever will run there
#   "no other lane runs here"       -- what a sweep lane says, so two lanes cannot fight over a box
#
# While both lived in one flock, a lane could not sweep the box its own holder was keeping alive.
# The cross-machine sweep routine holds rog and minix in step 1 and runs the sweep in step 2 of the
# same session, and on 2026-09-18 every remote lane waited out its 300 s LAB_LOCK_WAIT against that
# routine's own holder and then skipped: three of the five backends that routine is the only gate
# for got zero coverage, and the documented recovery (`kick-wsl --hold` then rerun) reproduced the
# skip exactly, because it took the same lock again (ludics-lite#224). The two halves had been
# designed as mutual exclusion between DIFFERENT sessions; one session doing both is not a
# contradiction to resolve but the intended shape, so the file is split rather than shared.
#
# Two files per box, each an ordinary EXCLUSIVE flock, in a directory this script and the sweep
# agree on. The contract is still deliberately nothing more than a directory, a filename and a
# one-line holder description: the sweep takes its own flock and does not need this script
# installed, which keeps a harness on another machine from depending on a symlink in ~/bin.
#
#   <dir>/<box>.lock        the LANE lock -- "no other lane runs on this box"
#   <dir>/<box>.hold.lock   the HOLD lock -- "this box's VM must not be destroyed"
#   first line of each      "<what> (pid <pid>, since <utc>)" -- advisory, for the refusal message
#
# Who takes which, and it is the whole design:
#
#   a sweep lane   the LANE lock, for the length of the lane
#   `--hold`       the HOLD lock, carried by the holder for exactly as long as the holder lives
#   a DESTROYER    (`restart-wsl`, `--restart-wsl`, `sleep`, `hibernate`, `down`) takes BOTH and is
#                  refused if EITHER is held -- each one alone means somebody loses work
#   the registry   the LANE lock, SHARED and non-blocking, for the instant a `measurement`
#                  reservation is written or dispatched (fleet-worker.sh, ludics-lite#445): refused
#                  while a lane or a destroyer holds it, so a measurement is never reserved under a
#                  running lane; a lane waits that instant out, a destroyer is refused by it
#
# That keeps the 2026-09-16 property whole: another session's `restart-wsl` is refused while a lane
# is using the box, and refused just the same in the gap between a hold and the lane it was taken
# for, where there is no lane yet to refuse on its own behalf. What it drops is the one exclusion
# nobody ever wanted -- a hold and a lane no longer refuse each other.
#
# The LANE lock keeps the old name, the old format and the old semantics, so a sweep checkout that
# has not been updated still interlocks exactly as before. Worst case across a version skew is a
# spurious skip (an old sweep waiting out a new hold that no longer needs to block it), never a
# destroyed VM: neither side can be made to believe a box is free while the other is using it.
#
# flock and not a pidfile for the reasons sweep.sh gives about its own run lock: there is nothing
# to reclaim after a crash, no window between creating the lock and publishing ownership, and the
# kernel releases it when the holder dies however it dies. The holder line is advisory only -- it
# names who to go and look at, and a stale or missing one never decides anything.
LOCK_DIR=${WAKE_LAB_LOCK_DIR:-$HOME/.local/state/wake-lab}

lab_lock_path() { # lab_lock_path <box> — where that box's LANE lock lives
  printf '%s/%s.lock' "$LOCK_DIR" "$1"
}

hold_lock_path() { # hold_lock_path <box> — where that box's HOLD lock lives
  printf '%s/%s.hold.lock' "$LOCK_DIR" "$1"
}

# Take a lock and HOLD it, on a descriptor the calling shell keeps open until it exits.
#
# Asking whether a lock is free and then acting on the answer is the very race this interlock
# exists to close: a probe that takes the lock and releases it leaves a window between the check
# and the `wsl.exe --shutdown`, and a sweep that reserves the box inside that window is destroyed
# by a restart that had already decided it was allowed to proceed. So the restarter becomes a
# holder rather than an observer — there is no window because there is no interval in which
# nothing holds the lock.
#
# Every caller runs this inside a per-box SUBSHELL, so the descriptor is that subshell's own and
# concurrent boxes cannot collide on it; the lock lives exactly as long as the work it guards. A
# lock file that cannot be created or opened at all is treated as free, deliberately: that is a
# fault in this machine's state directory, and it must not lock the operator out of their own lab
# (a real holder had to create the file to hold it).
# The descriptor is a parameter so that ONE process can hold several locks at once, each on its
# own: a destroyer holds two per box, and `power_phase` reserves every box it is about to act on
# and must keep all of them for as long as it acts. bash 3.2 has no `exec {fd}>`, hence the eval
# over an explicitly chosen number.
lock_take_fd_strict() { # lock_take_fd_strict <path> <what> <fd>
                        # 0 taken and held, 1 someone else holds it, 2 could not even be attempted
  local path=$1
  mkdir -p "$LOCK_DIR" 2>/dev/null || return 2
  eval "exec $3>>\"\$path\"" 2>/dev/null || return 2
  perl -e 'use Fcntl ":flock"; exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&"$3" || return 1
  lock_label "$path" "$2" "$$"
  return 0
}

# The fail-OPEN wrapper, and the contract every caller but the release wants: a lab whose lock
# directory cannot be created or written must not stop the boxes being used, so "could not be
# attempted" reads as "proceed". That is exactly the wrong answer for a caller asking whether it
# is SERIALIZED, though -- proceeding and being serialized are different facts, and reading the
# first as the second is how an unlocked cleanup came to believe it held the box. Callers that
# need the difference use the strict form.
lock_take_fd() { # lock_take_fd <path> <what> <fd> — 0 taken or unavailable, 1 someone else holds it
  lock_take_fd_strict "$@"
  case $? in 1) return 1 ;; *) return 0 ;; esac
}

# The advisory line, written by whoever holds the lock. Separate from the take because the hold
# path REWRITES it: on the restart path the holder inherits the descriptor the restart's own take
# opened, and a line left saying `wake-lab restart (pid ...)` then outlives the restart and names a
# pid that has already exited — which is what every later refusal message, on this side and in the
# sweep's skip lines, would go on quoting. So the holder relabels the lock it has taken over.
lock_label() { # lock_label <path> <what> <pid>
  printf 'wake-lab %s (pid %s, since %s)\n' "$2" "$3" "$(date -u +%Y%m%dT%H%M%SZ)" \
    >"$1" 2>/dev/null
}

# A lock's own description of itself, for the refusal message. Never trusted for the decision
# -- taking the lock makes that -- so an empty or truncated line degrades to a bare "held".
lock_holder() { # lock_holder <path>
  local line
  line=$(head -1 "$1" 2>/dev/null | tr -d '\000-\037')
  printf '%s' "${line:-held by an unnamed holder}"
}

# What `status` says about a box's lab locks (ludics-lite#359). A lock file's line outlives its
# holder -- the kernel drops the flock when the holder dies, however it dies, and nothing rewrites
# the line -- so the text alone cannot say whether anything is using the box; on 2026-09-24 all six
# lock files named holders and none of the four pids was alive. The flock can say it, so this asks
# the flock: a non-blocking SHARED take on a read-only descriptor of the probe's own, dropped as the
# probe exits. Every taker here and in the sweep takes these locks EXCLUSIVE, so a refused shared
# take is exactly "a destroyer would be refused right now". (The registry's shared take for a
# measurement's write, ludics-lite#445, lasts an instant and reads as free here.) The probe
# creates no file, writes no line and holds nothing past its own instant; the one effect it can
# have is that a destroyer's non-blocking take landing in that instant is refused, which fails
# closed.
# What it reads, and nothing else: whether the file exists, its flock, its mtime (when a holder last
# wrote the line, which is when it took the lock), and its first line. The line is SHOWN, stripped of
# control characters, and never parsed: no pid in it is looked up and no state is taken from it.
lock_probe() { # lock_probe <path> — "held|free|unknown <age-seconds|?> <first line>", or "absent"
  perl -e '
    use Fcntl ":flock";
    my $p = shift;
    -e $p or do { print "absent\n"; exit 0 };
    open(my $fh, "<", $p) or do { print "unknown ?\n"; exit 0 };
    my $age = time - (stat $fh)[9]; $age = 0 if $age < 0;
    my $line = <$fh>; $line = "" unless defined $line; $line =~ s/[\x00-\x1f\x7f]//g;
    my $st = flock($fh, LOCK_SH | LOCK_NB) ? "free" : ($!{EWOULDBLOCK} ? "held" : "unknown");
    print "$st $age $line\n";' "$1" 2>/dev/null || printf 'unknown ?\n'
}

fmt_age() { # fmt_age <seconds> — 45s, 12m, 2h13m, 3d04h
  local s=$1
  case "$s" in ''|*[!0-9]*) printf '?'; return ;; esac
  if [ "$s" -lt 60 ]; then printf '%ds' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%dm' $((s / 60))
  elif [ "$s" -lt 86400 ]; then printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  else printf '%dd%02dh' $((s / 86400)) $((s % 86400 / 3600)); fi
}

# The lane-lock= and hold-lock= columns of a box's status line, printed; the lines that name each
# lock's text go to LOCK_DETAILS for the caller to print under the status line. `free` with no
# detail line is a lock with no file or an empty one: nothing has ever claimed it, or nothing said who.
LOCK_DETAILS=""
lab_locks_fields() { # lab_locks_fields <box>
  local which path st age text
  LOCK_DETAILS=""
  for which in lane hold; do
    if [ "$which" = lane ]; then path=$(lab_lock_path "$1"); else path=$(hold_lock_path "$1"); fi
    read -r st age text <<<"$(lock_probe "$path")"
    case "$st" in
      absent) printf '  %s-lock=free' "$which"; continue ;;
      held|free) printf '  %s-lock=%s' "$which" "$st" ;;
      *) printf '  %s-lock=?' "$which"
         LOCK_DETAILS+=$(printf '         %s lock: could not be probed: %s' "$which" "$path")$'\n'
         continue ;;
    esac
    if [ "$st" = held ]; then
      LOCK_DETAILS+=$(printf '         %s lock: held by %s (line written %s ago)' "$which" \
        "${text:-an unnamed holder}" "$(fmt_age "$age")")$'\n'
    elif [ -n "$text" ]; then
      LOCK_DETAILS+=$(printf '         %s lock: free, stale text (written %s ago): %s' "$which" \
        "$(fmt_age "$age")" "$text")$'\n'
    fi
  done
}

# The reservations= column: how many of the fleet's active execution reservations name this box as
# their execution host, with each one's id and state listed under the line. Read once per `status`
# from `fleet-worker.sh execution list --active`, the issue-wave skill's own registry reader in this
# checkout (WAKE_LAB_FLEET_WORKER overrides the path), under the probe cap, because that reader
# asks the anchor box over ssh from anywhere else. A registry that cannot be read or does not parse
# is `?`, never 0: "nothing reserved" and "could not look" call for opposite conclusions.
# A record names its box by an ssh identity, and a box has one per endpoint in its row of the
# endpoint map -- native Linux, the WSL guest, the Windows host and its LAN route. Any one counts,
# whatever the box's configured kind: a reservation on a box's guest holds that box.
RESERVATIONS=""   # the listing as JSON; empty means it could not be read
RES_DETAILS=""
reservations_read() {
  local dir fw
  RESERVATIONS=""
  if [ -n "${WAKE_LAB_FLEET_WORKER:-}" ]; then fw=$WAKE_LAB_FLEET_WORKER
  else dir=$(script_dir) || return 0; fw=$dir/../issue-wave/scripts/fleet-worker.sh; fi
  [ -x "$fw" ] || return 0
  # A destroyer reads this while it holds its boxes' lab locks, on descriptors LOCK_FD_BASE (4)
  # through 9, so the reader is given none of them: a straggler of its tree must not carry a lock.
  RESERVATIONS=$(capped_tree "$PROBE_CAP" "$fw" execution list --active --compact 2>/dev/null </dev/null \
    4>&- 5>&- 6>&- 7>&- 8>&- 9>&-) || RESERVATIONS=""
}

# `capped` for a command that is a process TREE writing into a command substitution. `capped`
# signals the one pid it started, and that is enough for a bare ssh; but the registry reader is a
# script that runs its ssh inside a pipeline, so a wedged remote command would leave that ssh
# alive, holding the substitution's pipe open, and `status` would hang behind it with the reader
# itself already dead. So the reader runs as the leader of a process group of its own, and the
# whole group is killed at the deadline -- and again once the leader exits, for a straggler that
# outlived it. Returns CAP_EXPIRED when the deadline cut the command short.
capped_tree() { # capped_tree <seconds> <cmd...>
  perl -e '
    use POSIX ();
    my $secs = shift; my $expired = shift;
    my $pid = fork; defined $pid or exit 1;
    if ($pid == 0) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127 }
    POSIX::setpgid($pid, $pid);
    $SIG{ALRM} = sub { kill "KILL", -$pid; waitpid($pid, 0); exit $expired };
    alarm $secs;
    waitpid($pid, 0); my $st = $?;
    alarm 0; kill "KILL", -$pid;
    exit(($st & 127) ? 128 + ($st & 127) : $st >> 8);' "$1" "$CAP_EXPIRED" "${@:2}"
}
# box_reservations <box> [except-id] [only-id] [kind] -- "<id> (<state>)" per active reservation
# naming the box on any endpoint of its row, less the one whose request_id is <except-id>; with
# <only-id>, just that one, and only if it is a `measurement` (exclusive) reservation; with <kind>,
# only reservations of that kind. 1 when the registry was unread.
box_reservations() {
  local os e names=""
  for os in linux wsl win lan; do
    e=$(endpoint_of "$1" "$os") && names="$names$e"$'\n'
  done
  [ -n "$RESERVATIONS" ] && [ -n "$names" ] || return 1
  jq -r --arg names "$names" --arg except "${2:-}" --arg only "${3:-}" --arg kind "${4:-}" \
     '($names | split("\n") | map(select(. != ""))) as $ns
      | if type == "array" then .[] | .request.execution_host as $h
        | select($ns | index([$h])) | select(($except == "") or (.request_id != $except))
        | select(($only == "") or (.request_id == $only and .request.kind == "measurement"))
        | select(($kind == "") or (.request.kind == $kind))
        | "\(.request_id) (\(.state))" else error("not a list") end' <<<"$RESERVATIONS" 2>/dev/null
}
reservations_fields() { # reservations_fields <box>
  local ids n
  RES_DETAILS=""
  if ! ids=$(box_reservations "$1"); then
    printf '  reservations=?'; return 0
  fi
  n=0; [ -z "$ids" ] || n=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
  printf '  reservations=%s' "$n"
  [ -z "$ids" ] || RES_DETAILS=$(printf '%s\n' "$ids" | sed 's/^/         reservation: /')$'\n'
}

# Every lock descriptor in this script stays BELOW 10, and that is not a style choice. bash 3.2
# parks the descriptor a redirection displaces on the first free fd at or above 10, for the length
# of the command carrying the redirection — so `eval "exec 10>>\"$path\"" 2>/dev/null` opens the
# lock onto the very slot holding this shell's stderr, and bash closes it again when the eval
# returns. `exec` reports success, `flock` then fails on a descriptor that is no longer there, and
# the box reads as reserved by somebody else. It cost a run of the suite to find; the cases pin it.
# The cost is a ceiling on how many locks one process can hold at once, and `power_phase` is the
# only caller that holds more than one box's worth — hence the refusal there rather than a silent
# reservation this shell cannot actually make.
LOCK_FD_BASE=4         # the lowest descriptor a multi-box reservation may use
LOCK_FD_LIMIT=9        # ...and the highest, one below bash 3.2's save slot

# RESERVE a box: both of its locks, taken in one fixed order and released together if either is
# refused. Half a reservation is worse than none — a destroyer that kept the lane lock it had just
# taken while refusing on the hold lock would block the very sweep the holder was taken for — so
# the lane fd is closed again on the way out. Every take here is non-blocking, and this script
# never waits on a lock, so two destroyers racing for the same pair cannot deadlock: one of them
# is refused at once.
RESERVE_REFUSED_BY=""  # the holder line of whichever lock refused us, for the caller's message
lab_reserve() { # lab_reserve <box> <what> <fd> — the lane lock on <fd>, the hold lock on <fd>+1
  local box=$1 what=$2 fd=$3 hfd=$(($3 + 1))
  RESERVE_REFUSED_BY=""
  if ! lock_take_fd "$(lab_lock_path "$box")" "$what" "$fd"; then
    RESERVE_REFUSED_BY=$(lock_holder "$(lab_lock_path "$box")")
    return 1
  fi
  if ! lock_take_fd "$(hold_lock_path "$box")" "$what" "$hfd"; then
    RESERVE_REFUSED_BY=$(lock_holder "$(hold_lock_path "$box")")
    eval "exec $fd>&-"
    return 1
  fi
  return 0
}

# A destroyer's second check, made while it HOLDS the box's lab locks (ludics-lite#445). An
# exclusive `measurement` reservation in the fleet's execution registry is someone's timing run on
# the box, and it holds no lab lock, so the locks alone let `restart-wsl` or `sleep` take the box
# from under it. So every destroyer, once reserved, reads the registry and refuses a box that an
# outstanding measurement names on any endpoint of its row -- except the caller's own, named with
# `--as=<request_id>` (a measurement's owner restarting its guest, or sleeping the box it is done
# timing on). Correctness reservations are not read: a slot batch holds a logind sleep inhibitor,
# which refuses a native sleep from the OS side, and the registry keeps a standing record on nearly
# every box. A registry that cannot be read refuses, as boot_reservations_clear does: "nothing
# measured" and "could not look" call for opposite conclusions, and the cost of the refusal is a
# box left awake or a guest not restarted, where the cost of guessing wrong is the measurement.
# Holding the locks first is what closes the race: a measurement reserve takes the box's LANE lock
# shared while it writes its record (fleet-execution.py), so it is refused for as long as this
# destroyer holds that lock, and one written before it is in the registry this reads.
# Its caller has run reservations_read after taking the locks; prints the refusal and returns 1.
measured_box_clear() { # measured_box_clear <verb> <box>
  local held
  if ! held=$(box_reservations "$2" "$BOOT_AS" "" measurement); then
    printf '%s\n' "  $1 REFUSED on $2: the fleet's execution registry could not be read, so an exclusive measurement there cannot be ruled out"
    return 1
  fi
  [ -z "$held" ] && return 0
  printf '%s\n' "$held" | sed 's/^/  measurement: /'
  printf '%s\n' "  $1 REFUSED on $2: an exclusive measurement reservation names it"
  return 1
}
MEASURED_HINT="an exclusive measurement holds the box, or the registry could not be read; wait for it to conclude, pass --as=<request_id> if it is your own, or --force to take the box anyway"

# The whole power phase, with every box it acts on RESERVED from before its command is sent until
# that box is confirmed down.
#
# `hibernate` terminates the WSL VM outright (kick_wsl's note says so), `down` is a full host
# shutdown, and `sleep` suspends the host under whatever is running on it — all three destroy a
# reserved workload exactly as `wsl.exe --shutdown` does, so the interlock that covers the restart
# has to cover them too.
#
# And it has to cover the EFFECT, not the command. A dropped ssh means the suspend was INITIATED,
# not that the host is gone: for the seconds or minutes until it actually goes down the box still
# answers, so a reservation released when `power_action` returns lets another harness take the lock
# and start work that the pending transition then destroys. That is the restart's mistake one layer
# out — there the reservation did not cover the shutdown, here it did not cover what the shutdown
# does — so the rule this file holds is that a reservation spans the effect, never the command.
#
# THIS process holds every reservation, two descriptors each — the lane lock and the hold lock, as
# every destructive path takes both — and it is also the process that acts.
# An earlier version reserved box N at recursion level N, each level a subshell, so the descriptors
# lived in a chain of waiting ancestors — and killing the top-level command then released the first
# box's lock while the surviving descendant went on issuing and confirming its suspend, freeing a
# box whose power transition was still pending. Descriptors held by the actor cannot outlive it or
# be released ahead of it: kill the command and every reservation goes at once, which is the only
# arrangement where "reserved" and "still acting" cannot come apart. It is also the simpler one —
# a flat loop rather than a recursion — and it keeps the confirmation concurrent, against one
# deadline, where confirming box by box would multiply the worst-case wait by the number of boxes.
power_phase() { # power_phase <verb> <box...> — nonzero if any box was refused or never went down
  local verb=$1; shift
  local box fd=$LOCK_FD_BASE rc=0 i acted=() fds=() kept=() confirming=() refused=() measured=()
  for box in "$@"; do
    if [ "$FORCE" = 1 ]; then acted+=("$box"); continue; fi
    # Out of descriptors below bash 3.2's save slot: refuse rather than act on a box this shell
    # cannot hold. A reservation it cannot make is exactly the state the interlock exists to rule
    # out, and the ceiling is well clear of the three boxes the host table names.
    if [ $((fd + 1)) -gt "$LOCK_FD_LIMIT" ]; then
      echo "  $verb REFUSED on $box: no descriptor left to reserve it with (at most $(( (LOCK_FD_LIMIT - LOCK_FD_BASE + 1) / 2 )) boxes per command)"
      refused+=("$box"); continue
    fi
    if lab_reserve "$box" "$verb" "$fd"; then
      acted+=("$box"); fds+=("$fd"); fd=$((fd + 2))
    else
      echo "  $verb REFUSED on $box: $RESERVE_REFUSED_BY"
      refused+=("$box")
    fi
  done
  # With every lock held, the registry (measured_box_clear): a measured box's two locks are let go
  # again at once, since this command will not act on it.
  if [ "$FORCE" != 1 ] && [ ${#acted[@]} -gt 0 ]; then
    reservations_read
    i=0
    for box in "${acted[@]}"; do
      if measured_box_clear "$verb" "$box"; then kept+=("$box")
      else
        measured+=("$box"); eval "exec ${fds[$i]}>&- $((fds[i] + 1))>&-"
      fi
      i=$((i + 1))
    done
    acted=(${kept[@]+"${kept[@]}"})
  fi
  # Only the boxes actually acted on are confirmed: polling a refused box for the DOWN signal
  # would report the holder's live machine as a failure to go down.
  if [ ${#acted[@]} -gt 0 ]; then
    for box in "${acted[@]}"; do
      if power_action "$verb" "$box"; then confirming+=("$box"); else rc=1; fi
    done
    # Its status is the phase's: a box that never went down is a failure of this command, and
    # letting a trailing conditional swallow it would report success over the very line that says
    # the suspend may not have taken.
    if [ ${#confirming[@]} -gt 0 ]; then
      echo "confirming..."
      confirm_down "${confirming[@]}" || rc=1
    fi
  fi
  if [ ${#refused[@]} -gt 0 ]; then
    echo "$verb REFUSED on: ${refused[*]} (a lab lock is held; wait for the holder, or --force to take the box anyway)"
    rc=1
  fi
  if [ ${#measured[@]} -gt 0 ]; then
    echo "$verb REFUSED on: ${measured[*]} ($MEASURED_HINT)"
    rc=1
  fi
  return $rc
}

wake() { # wake <box>
  local name=$1 macs mac err ok=1
  macs=$(mac_of "$name") || { echo "unknown machine: $name" >&2; return 1; }
  if ! eth_mac_of "$name" >/dev/null 2>&1; then
    echo "  $name has no wired NIC in the site file; wake it manually (none of its NICs wakes on LAN)"
    return 1
  fi
  for mac in $macs; do
    if err=$(soap_checked $HOSTS_CTL $HOSTS_SVC X_AVM-DE_WakeOnLANByMACAddress \
                          "<NewMACAddress>$mac</NewMACAddress>" 2>&1 >/dev/null); then
      echo "  fritzbox WoL sent      -> $name ($mac)"
    else
      # NoSuchEntryInArray just means this MAC never held a DHCP lease; the direct packet below
      # is the path that matters for a freshly cabled NIC.
      echo "  fritzbox WoL REFUSED   -> $name ($mac): $err"
      ok=0
    fi
    if magic_packet "$mac"; then
      echo "  direct magic packet    -> $name ($mac)"
    else
      echo "  direct magic packet FAILED -> $name ($mac)"
      ok=0
    fi
  done
  [ "$ok" = 1 ]
}

# The remote prefix of every command that acts on a native Linux box: a stale alias that now lands
# somewhere else -- the other OS, or a WSL guest -- exits 2 before anything is done there.
NATIVE_LINUX_GUARD='[ "$(uname -s)" = Linux ] || { echo "OS changed; refresh before requesting power action" >&2; exit 2; }; if grep -qi microsoft /proc/sys/kernel/osrelease; then echo "Refusing to power off WSL; use its Windows host" >&2; exit 2; fi'
power_action() {
  if [ "$(box_kind "$2")" = wsl ]; then
    wsl_power_action "$@"
    return
  fi
  local cmd host output action_rc
  host=$(endpoint_of "$2" linux) || return 1
  case "$1" in
    sleep) cmd="systemctl --no-ask-password --check-inhibitors=yes suspend" ;;
    hibernate) cmd="systemctl --no-ask-password hibernate" ;;
    down) cmd="systemctl --no-ask-password poweroff" ;;
    *) return 1 ;;
  esac
  # Flotilla PR #3 verified this native-OS guard and the inhibitor-aware suspend path on
  # ROG and MINIX. A stale ssh alias must never suspend a WSL guest as if it were the host.
  cmd="$NATIVE_LINUX_GUARD"'; echo WAKE_LAB_POWER_STARTED; exec '"$cmd"
  echo "$2: $1"
  output=$(capped 30 ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$host" "$cmd" 2>&1); action_rc=$?
  [ -z "$output" ] || printf '  %s\n' "$(printf '%s\n' "$output" | tail -1)"
  case "$action_rc" in
    0) return 0 ;;
    255|124)
      if grep -Fxq 'WAKE_LAB_POWER_STARTED' <<<"$output"; then
        echo "  $1 on $2 unconfirmed (connection dropped or timed out); checking reachability"
        return 0
      fi
      echo "  $1 FAILED on $2 (connection failed before the remote power command started)"
      return 1 ;;
    *)
      # systemctl's inhibitor refusal is several lines, and the one naming the holder is not the
      # last, so the tail printed above would say "ignore inhibitors with -i" and not who. Name
      # the holders, and call it a refusal: the OS-side guard did its job (ludics-lite#317).
      if grep -q 'Operation inhibited by' <<<"$output"; then
        grep 'Operation inhibited by' <<<"$output" | sed 's/^/  /'
        echo "  $1 REFUSED on $2 by a block inhibitor (a run there holds it; see 'status')"
        return 1
      fi
      echo "  $1 FAILED on $2 (command exited $action_rc)"; return 1 ;;
  esac
}

confirm_down() { # confirm_down <box...> — poll until ssh stops answering, to a deadline
  local names=("$@") n any deadline=$((SECONDS + DOWN_WAIT_SECONDS))
  while :; do
    any=0
    for n in "${names[@]}"; do
      if is_up "$n"; then printf '%s=up ' "$n"; any=1; else printf '%s=DOWN ' "$n"; fi
    done
    printf '(%s)\n' "$(date +%H:%M:%S)"
    [ "$any" = 0 ] && return 0
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 5
  done
  echo "still reachable after $((DOWN_WAIT_SECONDS / 60)) min — the suspend may not have taken"
  return 1
}

wait_for() { # wait_for <box...> — poll until every box answers, for up to WAIT_SECONDS
  local names=("$@") n up all deadline=$((SECONDS + WAIT_SECONDS))
  while :; do
    all=1
    for n in "${names[@]}"; do
      if is_up "$n"; then up=UP; else up=down; all=0; fi
      printf '%s=%s ' "$n" "$up"
    done
    printf '(%s)\n' "$(date +%H:%M:%S)"
    [ "$all" = 1 ] && return 0
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 5
  done
}

# ---------------------------------------------------------------- the anchor leg
# A box that answers ssh is not yet a box that can work (ludics-lite#617). Every fleet-worker.sh
# run on a box reads the execution registry on the anchor over the box's OWN ssh to it, and in the
# first minute after a wake that leg can still fail while the box's sshd already answers: on
# 2026-10-14 an integration run started on minix right after `--wait minix` said up, and its
# `execution slot` refused it `EXECUTION SLOT UNREACHABLE mac-studio`. So `--wait` asks the second
# leg too, once the first answers: on the box, a non-interactive `ssh -o BatchMode=yes <anchor>
# true`, polled for up to ANCHOR_WAIT_SECONDS. A box whose leg never comes up is NOT all up, and
# its line says which leg failed -- the box itself, or its ssh to the anchor.
# Boundary, a fail-closed allowlist: only a box whose kind is `linux` is asked, through its linux
# endpoint, which is where its fleet shell runs. A wsl box's fleet shell is its WSL guest, and a
# windows box runs no fleet work; neither is asked, and each says so on a line of its own rather
# than passing as checked by omission. ANCHOR is the anchor's name as the BOX's ssh spells it,
# fleet-worker.sh's FLEET_ANCHOR default; WAKE_LAB_ANCHOR overrides it, and set empty turns the leg
# off for a lab with no fleet. It must be a plain ssh destination, since it is spliced into the
# remote command line (checked before anything is sent).
# What `all up` claims is POINT-IN-TIME: at the last poll every asked leg answered, and every box
# the leg did not ask still answered after the anchor wait (the final pass in the wake dispatch).
# A route that flaps after that is outside it; `execution slot`'s UNREACHABLE refusal says to
# retry a box woken minutes ago.
ANCHOR=${WAKE_LAB_ANCHOR-mac-studio}
ANCHOR_WAIT_SECONDS=${WAKE_LAB_ANCHOR_WAIT_SECONDS:-120}
ANCHOR_POLL_SECONDS=${WAKE_LAB_ANCHOR_POLL_SECONDS:-5}
ANCHOR_LEG_FAILED=3   # the probe's status when the box answered and its own ssh to the anchor did not
ANCHOR_FAILED=""      # set by wait_anchor: the boxes whose anchor leg never came up
ANCHOR_UNASKED=""     # set by wait_anchor: the boxes it did not ask, for the final pass
ANCHOR_ASKED=0        # set by wait_anchor: 1 when it asked any leg, which is time spent

anchor_alias() { # anchor_alias <box> -- the endpoint whose ssh to the anchor is asked; 1 when none is
  [ "$(box_kind "$1")" = linux ] || return 1
  endpoint_of "$1" linux
}

# 0 the leg works; ANCHOR_LEG_FAILED the box answered and its ssh to the anchor did not;
# CAP_EXPIRED nothing came back within PROBE_CAP; anything else, the box itself did not answer
# (ssh's own 255). The remote `|| exit` is what tells the two legs apart: ssh hands back the
# remote command's status, so a bare inner ssh failing reads as 255, the same as the outer one.
anchor_probe() { # anchor_probe <alias> <cap seconds>
  capped "$2" \
    ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$1" \
        "ssh -o BatchMode=yes -o ConnectTimeout=10 $ANCHOR true || exit $ANCHOR_LEG_FAILED" >/dev/null 2>&1
}

# The bound is wall-clock, the way the other waits here are, and an ask is held to it too: every
# box's leg is asked once whatever the bound (under PROBE_CAP, as one is_up probe is), and after
# that no ask starts past the deadline, each ask is capped at the time left before it, and the
# pause between polls never sleeps past it. So the wait ends by the later of the deadline and the
# first pass's end, never a PROBE_CAP per box beyond the deadline.
wait_anchor() { # wait_anchor <box...> -- poll each box's anchor leg until it works, for up to ANCHOR_WAIT_SECONDS
  local n a i all line left cap names=() aliases=() rcs=() caps=() first=1 deadline=$((SECONDS + ANCHOR_WAIT_SECONDS))
  ANCHOR_FAILED=""; ANCHOR_UNASKED=""; ANCHOR_ASKED=0
  if [ -z "$ANCHOR" ]; then echo "anchor leg not checked: WAKE_LAB_ANCHOR is empty"; return 0; fi
  for n in "$@"; do
    # fleet-worker reads the registry WITHOUT ssh exactly where its anchor is `local` or the box's
    # own fleet name (transport.is_local), and a linux box's fleet name is its linux alias. Those
    # two spellings, and no other alias of the row, have no leg to ask; every other one is asked.
    if a=$(anchor_alias "$n") && { [ "$ANCHOR" = local ] || [ "$ANCHOR" = "$a" ]; }; then
      echo "anchor leg not asked on $n: the anchor $ANCHOR is that box itself, read without ssh"
      ANCHOR_UNASKED="$ANCHOR_UNASKED $n"
    elif a=$(anchor_alias "$n"); then names+=("$n"); aliases+=("$a"); rcs+=(1); caps+=("$PROBE_CAP")
    else echo "anchor leg not checked on $n: its kind is $(box_kind "$n"), and only a linux box is asked"
         ANCHOR_UNASKED="$ANCHOR_UNASKED $n"; fi
  done
  [ ${#names[@]} -gt 0 ] || return 0
  echo "waiting for each box's own ssh to $ANCHOR..."
  ANCHOR_ASKED=1
  while :; do
    all=1; line="anchor leg to $ANCHOR: "
    for ((i = 0; i < ${#names[@]}; i++)); do
      # Every leg is asked on every poll, an answered one included, as wait_for asks every box:
      # `all up` is then one poll at which every leg answered, never a leg that answered once and
      # has since gone while another box was still coming up.
      cap=$PROBE_CAP; left=$((deadline - SECONDS))
      if [ "$first" = 1 ] || [ "$left" -gt 0 ]; then
        [ "$first" = 1 ] || [ "$left" -ge "$cap" ] || cap=$left
        caps[i]=$cap
        anchor_probe "${aliases[i]}" "$cap"; rcs[i]=$?
      elif [ "${rcs[i]}" = 0 ]; then
        # The deadline passed before this poll reached the leg: an answer from an earlier poll is
        # not this poll's, so it cannot make the poll all-answered.
        rcs[i]=unasked
      fi
      if [ "${rcs[i]}" = 0 ]; then line="$line${names[i]}=OK "
      else line="$line${names[i]}=-- "; all=0; fi
    done
    first=0
    printf '%s(%s)\n' "$line" "$(date +%H:%M:%S)"
    [ "$all" = 1 ] && return 0
    left=$((deadline - SECONDS))
    [ "$left" -gt 0 ] || break
    if [ "$left" -ge "$ANCHOR_POLL_SECONDS" ]; then sleep "$ANCHOR_POLL_SECONDS"; else sleep "$left"; fi
    [ "$SECONDS" -lt "$deadline" ] || break
  done
  for ((i = 0; i < ${#names[@]}; i++)); do
    n=${names[i]}; a=${aliases[i]}
    case "${rcs[i]}" in
      0) continue ;;
      "$ANCHOR_LEG_FAILED")
        printf '%s\n' "anchor leg NOT up on $n: $a answers, but its own 'ssh -o BatchMode=yes $ANCHOR true' still failed after ${ANCHOR_WAIT_SECONDS}s; a fleet-worker.sh run there would refuse UNREACHABLE $ANCHOR" ;;
      unasked)
        printf '%s\n' "anchor leg NOT up on $n: the wait ran out before the last poll could ask it again" ;;
      "$CAP_EXPIRED")
        printf '%s\n' "anchor leg NOT up on $n: its last check through $a did not return within its ${caps[i]}s cap" ;;
      *)
        printf '%s\n' "anchor leg NOT up on $n: $a itself stopped answering ssh (status ${rcs[i]}) while its ssh to $ANCHOR was asked" ;;
    esac
    ANCHOR_FAILED="${ANCHOR_FAILED:+$ANCHOR_FAILED }$n"
  done
  return 1
}

# ---------------------------------------------------------------- dual boot
# `boot-windows <box>` and `boot-linux <box>` reboot a dual-boot box into its other OS exactly once,
# with nobody at the keyboard, and wait until that OS answers (ludics-lite#353). A booted Windows
# box answers a native check in minutes, where a windows_only CI dispatch takes one to three hours.
#
# Selection is UEFI BootNext, never GRUB. `efibootmgr --bootnext <Windows Boot Manager>` makes the
# firmware start Windows for the ONE next boot and delete the variable as it does, so BootOrder
# (Ubuntu first on every box) and /etc/default/grub are never written; `grub-reboot` would have
# needed GRUB_DEFAULT=saved, and every box has GRUB_DEFAULT=0 (checked 2026-09-24). Coming back
# needs no selection at all: Windows' `shutdown /r /t 0` restarts into BootOrder's first entry,
# Ubuntu, and a dark box wakes into it the same way.
#
# Root on the Linux side is two commands, from a narrow sudoers file, /etc/sudoers.d/50-fleet-boot
# (its text is in README's lab-script section): `efibootmgr --bootnext <entry>` (with
# `--delete-bootnext`, to take the selection back when the reboot then fails, and a bare listing for
# a box whose EFI variables are not world-readable) and `systemctl reboot`. Every sudo is `sudo -n`,
# so a box without the file refuses at once instead of waiting on a password nobody will type.
#
# A reboot kills everything on the box, so both verbs RESERVE its lane and hold locks as
# power_phase does, from before the first command until the other OS answers or the deadline
# passes, and refuse while either is held; `--force` skips them with the same caveats. Both also
# run only under the caller's own exclusive execution reservation, named with --as, and refuse
# while any other names the box (boot_reservations_clear). boot-windows also refuses a box whose logind lists a sleep BLOCK inhibitor (sleep_blocks): that is a
# `fleet-worker.sh execution slot` or `hold` run in progress, which the lab locks do not see and a
# root `systemctl reboot` does not honour, since it inhibits sleep and not shutdown.
#
# The wait prints a line per poll with both OSes' state, and ends in a verdict:
#   exit 0  the requested OS answers (for Windows, its Git Bash as well)
#   exit 1  refused, or failed with the box reachable in a known OS: the box came back in the OS it
#           left, or a command failed before any reboot was accepted
#   exit 3  NEEDS A PERSON: nothing answers after the reboot, or the reboot was accepted and the old
#           OS still answers at the deadline (it may yet go down). Only someone at the box can tell
#           Windows updates from a BitLocker recovery prompt or a hang, so this never retries.
# A box with no wired NIC in the site file (tuf) is refused: what cannot be woken remotely cannot
# be recovered remotely either.
BOOT_WAIT_SECONDS=${WAKE_LAB_BOOT_WAIT_SECONDS:-900}
BOOT_POLL_SECONDS=${WAKE_LAB_BOOT_POLL_SECONDS:-5}   # between probes of the boot waits
BOOT_CAP=30            # the cap on one remote command of the boot path
BOOT_DOWN_POLLS=2      # consecutive dark polls that count as "went down"
GIT_BASH='C:\Program Files\Git\bin\bash.exe'   # the launcher that sets MSYSTEM, so uname says MINGW*
BOOT_DEADLINE=0        # the switch's one deadline: every wait after the reboot is accepted shares it

win_alias() { # win_alias <box> -- the first of the box's Windows routes that answers; 1 when none
  local os a
  for os in lan win; do   # lan first: it answers seconds after a cold boot, before Tailscale does
    a=$(endpoint_of "$1" "$os") || continue
    ssh_probe "$a" && { printf '%s\n' "$a"; return 0; }
  done
  return 1
}

# Windows' cmd.exe ends its lines with `\r` and its echo keeps a blank before `&`, so the start
# marker is matched as a whole line only after both are stripped. Here, not in the WSL adapter:
# boot_linux needs it on a dual-boot box whose kind is linux, and the adapter is not loaded then.
saw_power_start_marker() { # saw_power_start_marker <output> -- 0 when a line of it is the marker
  tr -d '\r' <<<"$1" | sed 's/[[:space:]]*$//' | grep -Fxq WAKE_LAB_POWER_STARTED
}

boot_ssh() { # boot_ssh <alias> <remote command> -- one capped, non-interactive remote command
  capped "$BOOT_CAP" ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=2 "$1" "$2"
}

boot_probe() { # boot_probe <box> -- set BOOT_KIND to the OS that answers now: linux, windows or ""
  BOOT_BOX=$1; BOOT_KIND=""
  if ssh_probe "$(endpoint_of "$1" linux)"; then BOOT_KIND=linux
  elif win_alias "$1" >/dev/null; then BOOT_KIND=windows; fi
}

boot_left() { # seconds left before BOOT_DEADLINE, never negative
  local l=$((BOOT_DEADLINE - SECONDS))
  [ "$l" -gt 0 ] || l=0
  printf '%s\n' "$l"
}

# The old OS going down, as a SUSTAINED outage: BOOT_DOWN_POLLS dark polls in a row. One failed
# probe is a flaky ssh as often as a reboot, and reading it as the reboot would end the wait for
# the old OS -- so a box that then answers again would read as having come BACK, and the locks
# would be released over a reboot still pending. Waits until BOOT_DEADLINE.
boot_down() { # boot_down <box>
  local n=0
  while :; do
    if is_up "$1"; then n=0; printf '%s=up ' "$1"; else n=$((n + 1)); printf '%s=DOWN ' "$1"; fi
    printf '(%s)\n' "$(date +%H:%M:%S)"
    [ "$n" -ge "$BOOT_DOWN_POLLS" ] && return 0
    [ "$(boot_left)" = 0 ] && return 1
    sleep "$BOOT_POLL_SECONDS"
  done
}

# Poll both OSes until <want> answers (0), the OTHER one does (2) -- which after a sustained outage
# means the box came back in the OS it left, and waiting longer cannot change that -- or
# BOOT_DEADLINE passes (1). Every poll prints a line: a long wait is never a silent one.
boot_wait() { # boot_wait <box> linux|windows
  local box=$1 want=$2 start=$SECONDS l w
  while :; do
    if ssh_probe "$(endpoint_of "$box" linux)"; then l=UP; else l=down; fi
    if win_alias "$box" >/dev/null; then w=UP; else w=down; fi
    printf '  %s: linux=%s windows=%s (%s, %ss)\n' "$box" "$l" "$w" "$(date +%H:%M:%S)" $((SECONDS - start))
    case "$want:$l:$w" in
      linux:UP:*|windows:*:UP) BOOT_KIND=$want; return 0 ;;
      linux:*:UP) BOOT_KIND=windows; return 2 ;;
      windows:UP:*) BOOT_KIND=linux; return 2 ;;
    esac
    [ "$(boot_left)" = 0 ] && return 1
    sleep "$BOOT_POLL_SECONDS"
  done
}

needs_a_person() { # needs_a_person <box> <what was waited for>
  printf '%s\n' "NEEDS A PERSON: $1 answers in NEITHER OS $(( BOOT_WAIT_SECONDS / 60 )) min after $2." \
    "  Only someone at the box can tell Windows updates from a BitLocker recovery prompt, a firmware" \
    "  menu or a hang, so nothing here retries. Look at its screen; '$0 status $1' shows when it answers."
}

needs_a_person_pending() { # needs_a_person_pending <box> <OS still answering> <what was accepted>
  printf '%s\n' "NEEDS A PERSON: $1 accepted $3 but $2 still answers $(( BOOT_WAIT_SECONDS / 60 )) min later." \
    "  It may still go down at any moment, so nothing should be started there until someone has looked;" \
    "  '$0 status $1' shows what answers."
}

# The one read of efibootmgr's listing, and its boundary: a line `Boot<4 hex>` (with or without the
# active `*`), spaces, then exactly the label `Windows Boot Manager`, ended by the tab efibootmgr
# puts before an entry's device path or by the end of the line -- so `Windows Boot Manager (old
# disk)` is another label, not a match. Everything else in the listing -- BootCurrent, BootOrder,
# every other entry, the device paths -- is deliberately not read. Exactly one such line is
# required: none is a box with no Windows to select, and two are an ambiguity a guess would turn
# into a boot of the wrong disk.
windows_boot_entry() { # windows_boot_entry <listing> -- the entry's 4 hex digits; 1 unless exactly one
  local hits
  hits=$(printf '%s\n' "$1" | tr -d '\r' | grep -E '^Boot[0-9A-Fa-f]{4}\*? +Windows Boot Manager('$'\t''|$)' | cut -c5-8)
  [ -n "$hits" ] && [ "$(printf '%s\n' "$hits" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$hits"
}

boot_git_bash() { # boot_git_bash <box> -- the reached Windows' native Git Bash, printed; 1 unless native
  local a out
  a=$(win_alias "$1") || { echo "  $1: no Windows route answers for the Git Bash check"; return 1; }
  # The adapter's shape for a Windows command (wsl_power_action): sshd hands the string to cmd.exe,
  # and an inner `cmd.exe /s /c "..."` strips exactly the outer pair of quotes, whatever the count.
  out=$(boot_ssh "$a" "cmd.exe /d /s /c \"\"$GIT_BASH\" -lc \"uname -s; git --version\"\"" 2>&1 | tr -d '\r')
  printf '%s\n' "$out" | sed "s/^/  $a: /"
  if printf '%s\n' "$out" | grep -Eq '^(MINGW|MSYS)' &&
     printf '%s\n' "$out" | grep -q '^git version .*\.windows\.'; then
    echo "$1: in Windows, native Git Bash answers on $a"; return 0
  fi
  echo "$1: Windows answers on $a, but its Git Bash did not ($GIT_BASH: uname -s MINGW*, git --version .windows.)"
  return 1
}

# The Git Bash check, repeated until it passes or BOOT_DEADLINE: sshd can answer before a freshly
# booted Windows can start Git Bash, and one early miss is not a verdict.
boot_git_bash_wait() { # boot_git_bash_wait <box>
  until boot_git_bash "$1"; do
    [ "$(boot_left)" = 0 ] && return 1
    sleep "$BOOT_POLL_SECONDS"
  done
}

# The BootNext this run set, until the destination OS is SEEN: while BOOT_NEXT_HOST names the Linux
# alias it was set on, any way out of this process takes it back -- an explicit failure through
# boot_undo_next, anything else (an interrupt, a closed terminal, a TERM) through the traps armed
# before the write. SIGKILL cannot be caught; nothing here can cover it.
BOOT_NEXT_HOST=""
boot_next_trap() {
  [ -n "$BOOT_NEXT_HOST" ] || return 0
  boot_undo_next "$BOOT_BOX" "$BOOT_NEXT_HOST" || true
}
# Success is VERIFIED absence, not the delete's status: the listing is read back and must carry no
# BootNext line, so the same call is right whether this run's write landed, never landed, or was
# lost in transit. The marker is cleared only then, so an unverified undo leaves the EXIT trap one
# more try, and the caller turns it into NEEDS A PERSON.
boot_undo_next() { # boot_undo_next <box> <linux alias> -- 1 when absence could not be verified
  if boot_ssh "$2" 'sudo -n efibootmgr --delete-bootnext >/dev/null 2>&1; l=$(efibootmgr 2>/dev/null || sudo -n efibootmgr) || exit 1; ! printf "%s\n" "$l" | grep -q "^BootNext:"' >/dev/null 2>&1; then
    BOOT_NEXT_HOST=""
    echo "  $1: no BootNext left set; its next boot is Ubuntu"; return 0
  fi
  echo "  $1: BootNext could NOT be verified gone, so its next reboot may start Windows ('sudo efibootmgr --delete-bootnext' there)"
  return 1
}
# boot_fail <box> <host> <rc> <message> -- take the selection back, then fail with <rc>; an undo that
# could not be verified makes it NEEDS A PERSON (3) whatever <rc> was.
boot_fail() {
  local ok=0
  boot_undo_next "$1" "$2" || ok=1
  printf '%s\n' "$4"
  [ "$ok" = 0 ] && return "$3"
  echo "NEEDS A PERSON: $1 may still carry a BootNext into Windows; check 'efibootmgr' there before anything reboots it."
  return 3
}

boot_windows() { # boot_windows <box>
  local box=$1 host list entry out rc blocks start
  host=$(endpoint_of "$box" linux)
  boot_probe "$box"
  case "$BOOT_KIND" in
    windows) echo "$box: already in Windows; no reboot"
             BOOT_DEADLINE=$((SECONDS + BOOT_WAIT_SECONDS)); boot_git_bash_wait "$box"; return ;;
    "") echo "$box: answers in neither OS; waking it into Ubuntu (first in its BootOrder) first"
        wake "$box"
        BOOT_DEADLINE=$((SECONDS + BOOT_WAIT_SECONDS))   # a cold boot gets the boot budget, as boot-linux's
        boot_wait "$box" linux; rc=$?
        case "$rc" in
          0) ;;
          2) echo "$box: woke into Windows, not Ubuntu; no reboot"
             BOOT_DEADLINE=$((SECONDS + BOOT_WAIT_SECONDS)); boot_git_bash_wait "$box"; return ;;
          *) echo "boot-windows FAILED on $box: it did not wake within $((BOOT_WAIT_SECONDS / 60)) min"; return 1 ;;
        esac ;;
  esac
  if [ "$FORCE" != 1 ]; then
    if ! blocks=$(sleep_blocks "$host"); then
      echo "boot-windows REFUSED on $box: its logind inhibitors could not be read, so a run there cannot be ruled out (--force reboots anyway)"
      return 1
    fi
    if [ -n "$blocks" ]; then
      printf '%s\n' "$blocks" | sed 's/^/  block: /'
      echo "boot-windows REFUSED on $box: a run holds a sleep block inhibitor there (see 'status'; --force reboots anyway)"
      return 1
    fi
  fi
  list=$(boot_ssh "$host" "$NATIVE_LINUX_GUARD; efibootmgr 2>/dev/null || sudo -n efibootmgr" 2>&1) || {
    printf '  %s\n' "$(printf '%s\n' "$list" | tail -1)"
    echo "boot-windows REFUSED on $box: its EFI boot entries could not be read"; return 1; }
  # A BootNext already set is someone else's selection -- a firmware or diagnostic boot -- and this
  # run's cleanup can only delete, never restore, so it is refused rather than replaced.
  if printf '%s\n' "$list" | tr -d '\r' | grep -q '^BootNext:'; then
    echo "boot-windows REFUSED on $box: a BootNext is already set there ($(printf '%s\n' "$list" | tr -d '\r' | grep '^BootNext:' | head -1)); not replacing someone else's selection ('sudo efibootmgr --delete-bootnext' there if it is stale)"
    return 1
  fi
  entry=$(windows_boot_entry "$list") || {
    echo "boot-windows REFUSED on $box: its EFI listing has $(printf '%s\n' "$list" | grep -c 'Windows Boot Manager') 'Windows Boot Manager' entries, and exactly one is needed"
    return 1; }
  # Asked before the selection, so that a box whose reboot is not granted never carries a BootNext
  # into whatever reboots it next.
  if ! boot_ssh "$host" 'sudo -n -l systemctl reboot' >/dev/null 2>&1; then
    echo "boot-windows REFUSED on $box: 'sudo -n systemctl reboot' is not granted there (install /etc/sudoers.d/50-fleet-boot; see README)"
    return 1
  fi
  # Armed BEFORE the write, since a write whose answer was lost may still have landed.
  BOOT_NEXT_HOST=$host
  trap 'boot_next_trap' EXIT
  trap 'boot_next_trap; exit 130' INT TERM HUP
  out=$(boot_ssh "$host" "sudo -n efibootmgr --bootnext $entry" 2>&1); rc=$?
  if [ "$rc" != 0 ]; then
    printf '  %s\n' "$(printf '%s\n' "$out" | tail -1)"
    boot_fail "$box" "$host" 1 "boot-windows REFUSED on $box: BootNext=$entry could not be set (install /etc/sudoers.d/50-fleet-boot; see README)"
    return
  fi
  if ! printf '%s\n' "$out" | tr -d '\r' | grep -qx "BootNext: $entry"; then
    boot_fail "$box" "$host" 1 "boot-windows FAILED on $box: efibootmgr did not read BootNext back as $entry"; return
  fi
  echo "  $box: BootNext=$entry (Windows Boot Manager) for one boot; BootOrder untouched"
  echo "$box: reboot"
  out=$(boot_ssh "$host" "$NATIVE_LINUX_GUARD; echo WAKE_LAB_POWER_STARTED; exec sudo -n systemctl reboot" 2>&1); rc=$?
  case "$rc" in
    0) ;;
    255|124) grep -Fxq WAKE_LAB_POWER_STARTED <<<"$out" || rc=1 ;;
    *) rc=1 ;;
  esac
  if [ "$rc" = 1 ]; then
    printf '  %s\n' "$(printf '%s\n' "$out" | tail -1)"
    boot_fail "$box" "$host" 1 "boot-windows FAILED on $box: the reboot command failed"; return
  fi
  # One deadline for the rest of the switch: the down, the wait for Windows and its Git Bash share
  # it, so the documented budget bounds how long the locks are held. The down is awaited for all of
  # it, not DOWN_WAIT_SECONDS: an accepted reboot can be held up (a unit slow to stop), and giving
  # up early would release the locks over a reboot still pending.
  start=$SECONDS; BOOT_DEADLINE=$((SECONDS + BOOT_WAIT_SECONDS))
  if ! boot_down "$box"; then
    boot_fail "$box" "$host" 3 "$(needs_a_person_pending "$box" Ubuntu "its reboot")"; return
  fi
  echo "waiting for Windows (up to $((BOOT_WAIT_SECONDS / 60)) min in all)..."
  boot_wait "$box" windows; rc=$?
  case "$rc" in
    0) BOOT_NEXT_HOST=""   # Windows is up: the firmware took the selection
       echo "$box: Windows answers $((SECONDS - start))s after the reboot"
       boot_git_bash_wait "$box"; return ;;
    2) boot_fail "$box" "$host" 1 "boot-windows FAILED on $box: it came back in Ubuntu, so the firmware ignored BootNext"; return ;;
  esac
  # Dark at the deadline: the box went down with the selection set and has not answered since, so
  # there is nothing to reach to take it back; the message says where to look.
  BOOT_NEXT_HOST=""
  needs_a_person "$box" "its reboot into Windows"
  echo "  If it comes back in Ubuntu, check 'efibootmgr' there for a leftover BootNext."
  return 3
}

boot_linux() { # boot_linux <box>
  local box=$1 a out rc start
  boot_probe "$box"
  case "$BOOT_KIND" in
    linux) echo "$box: already in Ubuntu; no reboot"; return 0 ;;
    windows)
      a=$(win_alias "$box") || { echo "boot-linux FAILED on $box: its Windows route stopped answering"; return 1; }
      echo "$box: restart from Windows ($a)"
      # /f as the adapter's `down` has it: nobody is at the keyboard to answer an app that asks. No
      # space before `&`: cmd.exe's echo keeps it, and on rog (2026-09-24) `echo X & ...` came back
      # as `X ` and failed an exact match over a restart that had in fact started.
      out=$(boot_ssh "$a" 'cmd.exe /d /s /c "echo WAKE_LAB_POWER_STARTED& shutdown /r /f /t 0"' 2>&1); rc=$?
      # Error 1190, ERROR_SHUTDOWN_IS_SCHEDULED: a restart was already pending, and it will still
      # happen. That is an accepted restart as far as the locks are concerned, so it is waited out
      # like one rather than reported as a failure that releases them.
      if grep -q '(1190)' <<<"$out"; then
        echo "  $box: a shutdown was already scheduled there (1190); waiting on that one"
        rc=0
      fi
      if ! saw_power_start_marker "$out" ||
         { [ "$rc" != 0 ] && [ "$rc" != 255 ] && [ "$rc" != 124 ]; }; then
        printf '  %s\n' "$(printf '%s\n' "$out" | tr -d '\r' | tail -1)"
        echo "boot-linux FAILED on $box: the Windows restart command did not start (exit $rc)"; return 1
      fi
      start=$SECONDS; BOOT_DEADLINE=$((SECONDS + BOOT_WAIT_SECONDS))   # one deadline, as boot-windows'
      if ! boot_down "$box"; then
        needs_a_person_pending "$box" Windows "its restart"; return 3
      fi ;;
    "") echo "$box: answers in neither OS; waking it (it boots Ubuntu, first in its BootOrder)"
        start=$SECONDS; BOOT_DEADLINE=$((SECONDS + BOOT_WAIT_SECONDS))
        wake "$box" ;;
  esac
  echo "waiting for Ubuntu (up to $((BOOT_WAIT_SECONDS / 60)) min in all)..."
  boot_wait "$box" linux; rc=$?
  case "$rc" in
    0) echo "$box: in Ubuntu, $((SECONDS - start))s after the restart"; return 0 ;;
    2) echo "boot-linux FAILED on $box: it came back in Windows (a Windows update restart, or a BootOrder that does not start Ubuntu first)"; return 1 ;;
  esac
  needs_a_person "$box" "its restart into Ubuntu"; return 3
}

# The fleet's execution registry is the one record of work on a box that covers BOTH of its OSes:
# a native Windows run holds no logind inhibitor and need not take a lab lock. A reboot therefore
# runs under the caller's own EXCLUSIVE reservation, named with --as=<request_id>: it must be an
# active `measurement` reservation on one of the box's endpoints, which the registry itself keeps
# every later reservation on that host from joining -- so there is no window between this check and
# the reboot for new work on that host to start in. Any OTHER active reservation naming one of the
# box's endpoints refuses too (the registry knows hosts, not boxes, so the box's other endpoints
# are checked here), and so does a registry that cannot be read.
boot_reservations_clear() { # boot_reservations_clear <verb> <box>
  local own others
  if [ -z "$BOOT_AS" ]; then
    echo "$1 REFUSED on $2: a reboot runs under your own exclusive reservation; pass --as=<request_id> of the active measurement reservation you hold on it (or --force)"
    return 1
  fi
  reservations_read
  if ! own=$(box_reservations "$2" "" "$BOOT_AS") || ! others=$(box_reservations "$2" "$BOOT_AS"); then
    echo "$1 REFUSED on $2: the fleet's execution registry could not be read, so a run there cannot be ruled out (--force reboots anyway)"
    return 1
  fi
  if [ -z "$own" ]; then
    echo "$1 REFUSED on $2: --as=$BOOT_AS is not an active measurement reservation on any of its endpoints"
    return 1
  fi
  [ -z "$others" ] && return 0
  printf '%s\n' "$others" | sed 's/^/  reservation: /'
  echo "$1 REFUSED on $2: an active execution reservation besides $BOOT_AS names it (wait for it to conclude, or --force)"
  return 1
}

boot_phase() { # boot_phase boot-windows|boot-linux <box> -- the box reserved across the whole switch
  local verb=$1 box=$2
  if ! eth_mac_of "$box" >/dev/null 2>&1; then
    echo "$verb REFUSED on $box: it has no wired NIC in the site file, so no Wake-on-LAN, and a box that cannot be woken remotely cannot be recovered remotely (wake it by hand)"
    return 1
  fi
  if ! endpoint_of "$box" linux >/dev/null || ! endpoint_of "$box" win >/dev/null; then
    echo "$verb REFUSED on $box: its endpoint map row does not list both a linux and a win endpoint, so it is not a dual-boot box"
    return 1
  fi
  if [ "$FORCE" = 1 ]; then
    echo "$verb on $box WITHOUT the lab locks or the reservation check (--force): whatever runs there dies with the reboot"
  elif ! lab_reserve "$box" "$verb" "$LOCK_FD_BASE"; then
    echo "$verb REFUSED on $box: $RESERVE_REFUSED_BY (a lab lock is held; wait for the holder, or --force to take the box anyway)"
    return 1
  else
    boot_reservations_clear "$verb" "$box" || return 1
  fi
  if [ "$verb" = boot-windows ]; then boot_windows "$box"; else boot_linux "$box"; fi
}

# ---------------------------------------------------------------- dispatch
script_dir() { # the directory this script really lives in, through the ~/bin symlink
  local path=$0 link
  while [ -L "$path" ]; do
    link=$(readlink "$path") || return 1
    case "$link" in /*) path=$link ;; *) path=$(dirname "$path")/$link ;; esac
  done
  dirname "$path"
}

load_wsl_adapter() {
  [ "${WSL_ADAPTER_LOADED:-0}" = 1 ] && return 0
  local dir
  dir=$(script_dir) || return 1
  # shellcheck source=scripts/wake-lab-wsl.sh
  . "$dir/wake-lab-wsl.sh" || return 1
  WSL_ADAPTER_LOADED=1
}

prepare_boxes() { # WSL gets its existing concurrent kick; Linux needs nothing after sshd boots.
  local n wsl_boxes=()
  for n in "$@"; do
    if [ "$(box_kind "$n")" = wsl ]; then wsl_boxes+=("$n");
    else echo "linux ready on $n (sshd starts at boot; no holder needed)"; fi
  done
  if [ ${#wsl_boxes[@]} -gt 0 ]; then start_wsl "${wsl_boxes[@]}"; fi
}

WAIT=0
WANT_WSL=0
HOLD=0
FRESH_WSL=""   # "fresh" makes kick_wsl shut the VM down first; --wsl alone never kills a live VM
BOOT_AS=""     # --as=<request_id>: the caller's own measurement reservation, which a boot verb requires
               # and no destroyer refuses (boot_reservations_clear, measured_box_clear)
FORCE=0        # --force: destroy the VM even while a lab lock is held (see the lab lock lore)
HOLD_LOCKED=0  # set in a box's subshell once its reservation holds that box's HOLD lock on HOLD_FD
VERB=wake
VERB_WORD=${1:-}   # as typed: restart-wsl runs as kick-wsl
TARGETS=()

# Every word taken here, and `all` below, is a name check_map refuses for a box.
case "${1:-}" in
  status|sleep|hibernate|down|kick-wsl|unhold) VERB=$1; shift ;;
  restart-wsl) VERB=kick-wsl; FRESH_WSL=fresh; shift ;;
  lock-path|boot-windows|boot-linux) VERB=$1; shift ;;
  endpoint-map) VERB=$1; shift ;;
esac

# `endpoint-map` (ludics-lite#395): the map as data, one line per row -- the box name, then every
# ssh alias of that row -- for fleet-worker.sh, whose registry refuses a FLEET_BOXES roster that
# lists two aliases of one box (a measurement on one would not exclude a run on the other). The map
# stays the one source: the registry asks here rather than restating the rows. Before the argument
# loop and load_hosts, like lock-path: it takes no box and no option, and it answers from a checkout
# that holds no site table. It answers only for a map every rule passes -- check_map whole, then
# check_endpoints on each row with no kind to require -- so a reader never gets a row this script
# itself would refuse to act on.
if [ "$VERB" = endpoint-map ]; then
  if [ "$#" -ne 0 ]; then
    printf '%s\n' "wake-lab.sh: endpoint-map takes no arguments; nothing was sent." >&2
    exit 2
  fi
  check_map || exit 1
  while IFS= read -r t; do check_endpoints "$t" "" || exit 1; done < <(lab_boxes)
  for r in "${ENDPOINT_MAP[@]}"; do
    read -r t rest <<<"$r"
    read -r -a ws <<<"$rest"
    line=$t
    for w in "${ws[@]}"; do line="$line ${w#*=}"; done
    printf '%s\n' "$line"
  done
  exit 0
fi

for arg in "$@"; do
  case "$arg" in
    --list) list_hosts; exit 0 ;;
    --wait) WAIT=1 ;;
    --wsl)  WANT_WSL=1 ;;
    --hold) HOLD=1 ;;
    --restart-wsl) WANT_WSL=1; FRESH_WSL=fresh ;;
    --force) FORCE=1 ;;
    --as=?*) BOOT_AS=${arg#--as=} ;;
    -h|--help) usage; exit 0 ;;
    all) while IFS= read -r t; do TARGETS+=("$t"); done < <(lab_boxes) ;;
    *) TARGETS+=("$arg") ;;
  esac
done
# Only `status` has a no-box default. It is a read -- a router query and ssh probes, nothing that
# changes a box's state -- so it covers the whole lab, tuf included (ludics-lite#320): tuf has no
# Wake-on-LAN and is woken by hand, so it is often the one box awake, and a first look that leaves it out
# reads that box as absent. Like `status all`, the default is checked against the site table whole,
# so a table that does not know tuf refuses a bare `status` rather than silently shrinking it.
# Every other verb, the bare wake first, takes no default at all: it prints the usage, exits 2 and
# sends nothing. A bare `wake-lab.sh` is what anyone types to see the usage, and on 2026-09-24 one
# expecting that woke rog and minix instead; a bare `sleep` or `restart-wsl` would have taken them
# away from whatever was running there. A reboot takes exactly one box: two are refused too.
if [ ${#TARGETS[@]} -eq 0 ]; then
  if [ "$VERB" = status ]; then
    while IFS= read -r t; do TARGETS+=("$t"); done < <(lab_boxes)
  else
    if [ "$VERB" = wake ]; then echo "wake-lab.sh: no box named; nothing was sent." >&2
    else echo "wake-lab.sh: $VERB_WORD needs a box (or all); nothing was sent." >&2; fi
    usage >&2
    exit 2
  fi
fi
case "$VERB" in
  boot-windows|boot-linux)
    if [ ${#TARGETS[@]} -ne 1 ]; then
      echo "wake-lab.sh: $VERB takes exactly one box (got ${#TARGETS[@]}); nothing was sent." >&2
      exit 1
    fi ;;
esac

# A --hold that holds nothing is a lane that believes it is held and is not, which is the exact
# failure this flag exists to prevent — so refuse it rather than ignore it. On the wake path that
# means --wait as well as --wsl: without --wait the wake never reaches start_wsl at all, so
# `--wsl --hold` alone would send the packets, hold nothing, and exit 0. Before load_hosts: a
# a WSL box that has no start to hold is refused after kind validation.
# unhold before load_hosts, and before check_targets: releasing a local pid needs neither the MAC
# table nor the network, and a site file that went missing or unparseable after a lane started
# would otherwise strand the holder it is the only way to end. The cost is that a misspelled box
# reports no holder instead of a typo, which is the right trade for a cleanup command.
if [ "$VERB" = unhold ]; then
  # A missing site file must not strand an existing holder. When it is available, Linux is a
  # no-op and need not even read the WSL adapter.
  [ ! -r "$HOSTS_FILE" ] || . "$HOSTS_FILE"
  for t in "${TARGETS[@]}"; do
    state_dir=${WAKE_LAB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/wake-lab}
    if declare -F kind_of >/dev/null && [ "$(box_kind "$t")" = linux ] &&
       [ ! -e "$state_dir/hold-$t.pid" ] && [ ! -e "$state_dir/hold-$t.releasing" ]; then
      echo "no holder needed for linux box $t"
    else
      load_wsl_adapter || exit 1
      release_hold "$t"
    fi
  done
  # rc 2, not 1: a lane's cleanup must be able to tell "the holder died under me" (the lane's
  # results are suspect) from an ordinary failure of the unhold command itself. The record is gone
  # either way, so a caller that only cares about cleanup can ignore it, while the sweep can fail
  # the lane on it.
  #
  # rc 3 is the opposite fault and is deliberately not folded into it: the holder did its job and
  # the lane's results are fine, but this release could not leave the box demonstrably free -- a
  # process of ours survived both its channel dying and being ended by pid, or the box never
  # answered and nothing here knows either way. That needs a human on that box, and it needs them
  # for a reason that has nothing to do with the lane's results -- reporting both as rc 2
  # would make the sweep discard good work over a box it should instead be complaining about.
  # An unverified release KEEPS its record, so running `unhold` again once the box answers picks
  # the job up where this one left it rather than starting from no identity at all.
  # The anomaly is checked first: of the two, it is the one that says the results cannot be
  # trusted, and a caller reacting to only one status should react to that one.
  [ "${HOLD_ANOMALY:-0}" = 1 ] && exit 2
  [ "${HOLD_LEAK:-0}" = 1 ] && exit 3
  exit 0
fi

# Before load_hosts, like --help and --list: a lock path is a function of the lock directory and a
# box NAME alone, and the harness that asks where to put its flock -- the sweep, from a checkout
# that has no business holding this lab's MAC addresses -- must not need the site table to find
# out. It answers the LANE lock, because that is the one a harness takes; the hold lock beside it
# is wake-lab's own, taken by `--hold` alone and never by a lane.
if [ "$VERB" = lock-path ]; then
  for t in "${TARGETS[@]}"; do lab_lock_path "$t"; echo; done
  exit 0
fi

# After the argument loop on purpose: --help and --list need no site data, and both are what you
# reach for on a box where the host table has yet to be installed.
load_hosts
check_targets "${TARGETS[@]}"
any_wsl=0
for t in "${TARGETS[@]}"; do
  if [ "$(box_kind "$t")" = wsl ]; then any_wsl=1; load_wsl_adapter || exit 1; break; fi
done
if [ "$HOLD" = 1 ] && [ "$any_wsl" = 1 ] && [ "$VERB" != kick-wsl ] &&
   { [ "$VERB" != wake ] || [ "$WANT_WSL" != 1 ] || [ "$WAIT" != 1 ]; }; then
  echo "wake-lab.sh: --hold needs a WSL start to hold" >&2
  echo "  use 'kick-wsl --hold' / 'restart-wsl --hold', or '--wait --wsl --hold' (the wake path" >&2
  echo "  starts WSL only under --wait); end it with 'unhold'." >&2
  exit 1
fi
# The anchor goes into a remote command line (anchor_probe), so a name that is not a plain ssh
# destination is refused here, before a packet is sent, rather than run on the box.
if [ "$VERB" = wake ] && [ "$WAIT" = 1 ]; then
  case "$ANCHOR" in
    -*|*[!A-Za-z0-9._@-]*)
      printf '%s\n' "wake-lab.sh: WAKE_LAB_ANCHOR $(printf '%q' "$ANCHOR") is not a plain ssh destination; nothing was sent." >&2
      exit 1 ;;
  esac
fi

case "$VERB" in
  status)
    do_status "${TARGETS[@]}"
    ;;
  kick-wsl)
    prepare_boxes "${TARGETS[@]}"; exit $?
    ;;
  boot-windows|boot-linux)
    boot_phase "$VERB" "${TARGETS[0]}"; exit $?
    ;;
  sleep|hibernate|down)
    # Only the boxes actually acted on are confirmed: polling a refused box for the DOWN signal
    # would report the holder's live machine as a failure to go down.
    power_phase "$VERB" "${TARGETS[@]}" || exit 1
    ;;
  wake)
    wake_rc=0
    for t in "${TARGETS[@]}"; do echo "$t:"; wake "$t" || wake_rc=1; done
    if [ "$WAIT" = 1 ]; then
      echo "waiting for boot..."
      wait_for "${TARGETS[@]}"; rc=$?
      # Partial success still deserves the WSL kick: one box failing to wake must not suppress
      # starting WSL on the box that did come up, or an unrelated dead machine silently costs a
      # backend's coverage.
      wsl_rc=0
      if [ "$WANT_WSL" = 1 ]; then
        UP=()
        for t in "${TARGETS[@]}"; do is_up "$t" && UP+=("$t"); done
        [ ${#UP[@]} -gt 0 ] && { prepare_boxes "${UP[@]}" || wsl_rc=1; }
      fi
      # The anchor leg, for the boxes that answer: one that never woke has no leg to wait for, and
      # is already reported below as not woken. A box the leg does not ask is passed through
      # unprobed, for wait_anchor to say so.
      anchor_rc=0
      UP=()
      for t in "${TARGETS[@]}"; do
        if [ "$rc" = 0 ] || [ -z "$ANCHOR" ] || ! anchor_alias "$t" >/dev/null || is_up "$t"; then UP+=("$t"); fi
      done
      if [ ${#UP[@]} -gt 0 ]; then wait_anchor "${UP[@]}" || anchor_rc=1; fi
      # The final pass: a box the anchor wait did not ask holds its verdict from before that wait,
      # so where that wait asked any leg (which takes time, a first slow ask included) and every
      # box had answered, each such box is asked once more. (With a box already down the run is
      # NOT all up whatever this would find.)
      gone=""
      if [ "$ANCHOR_ASKED" = 1 ] && [ "$rc" = 0 ]; then
        for t in $ANCHOR_UNASKED; do is_up "$t" || gone="${gone:+$gone }$t"; done
      fi
      # The final verdict is the wake's AND the WSL step's: `all up` over a failed restart would
      # hand the sweep the degraded VM the restart exists to replace, so the WSL failure is
      # restated as the LAST line, where the sweep routine reads its verdict, and the exit
      # status says so too.
      if [ "$rc" = 0 ] && [ "$wsl_rc" = 0 ] && [ "$anchor_rc" = 0 ] && [ -z "$gone" ]; then
        echo "all up"
      else
        if [ "$rc" != 0 ]; then
          for t in "${TARGETS[@]}"; do is_up "$t" || echo "did NOT wake: $t"; done
          echo "Check BIOS Wake-on-LAN / 'Power Up' (minix needed the SECOND setup screen, not"
          echo "Advanced), then run scripts/enable-wol-windows.ps1 from an elevated Windows"
          echo "PowerShell to disable Fast Startup and re-arm the NIC. Check '$0 status' after the"
          echo "router lease settles; tuf (no Wake-on-LAN) needs manual wake."
        fi
        [ -n "$gone" ] && echo "NOT all up: stopped answering during the anchor wait: $gone"
        [ "$anchor_rc" != 0 ] && echo "NOT all up: no ssh to $ANCHOR yet from: $ANCHOR_FAILED (see above)"
        [ "$wsl_rc" != 0 ] && echo "NOT all up: $WSL_FAILED (see above)"
        exit 1
      fi
    else
      exit "$wake_rc"
    fi
    ;;
esac
exit "$?"
}
