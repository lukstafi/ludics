"""fleet-worker.sh's FAR SIDE: the bash scripts every worker verb runs on the box, verbatim.

ludics-lite#403 moved fleet-worker.sh's near side -- argument parsing, the order of the reads, what
a status means to the coordinator -- to Python. What runs ON a box stays the bash it was: a far-side
script is composed here, read by ``bash -s`` on the box (a local child for this box, ``ssh <box>
bash -s`` for any other: ``transport.run_on``), its arguments as positional parameters. A box needs
bash, tmux, jq and git for a CLI worker, as it always did; no far side here needs Python (the
preflight only ASKS whether the box has one, below).

Every text is the shell's heredoc byte for byte, so a box runs exactly what it ran before the port,
and the comments inside them are the design notes they always were. What each one is, and the
composition the near side does around it:

  HELPERS      the prelude every far side starts with (``transport.prelude`` prefixes the paths,
               BOX and its locality): tmux, the worker record's readers, the mkdir lock, ``bounded``,
               the run.sh writer for a claude worker, the stale-tmux-server check
  FRESHNESS    the skills checkout's freshness, shared by the preflight and ``refresh``
  ghprobe(b)   the GitHub probe (``gh_bound`` = FLEET_GH_TIMEOUT, then GHPROBE), shared by the
               preflight and the far sides that create a worker session (launch, unstick)
  FLEET_PYTHON the first Python >= 3.12 in scripts/py's order, PY_CANDIDATES then PY_LAUNCHER_ARGS
               (the registry's interpreter, and the preflight's probe of the box)
  PREFLIGHT    after FRESHNESS, ghprobe and FLEET_PYTHON
  REFRESH      after FRESHNESS
  LAUNCH_EXISTS, LAUNCH_FETCH, LAUNCH (after ghprobe)
  VERDICT      the verdict of a finished worker, for ATTACH and CLOSE
  ATTACH, STATUS, LOG, LOG_LAST_RESULT, UNSTICK (after ghprobe), CLOSE, LS
"""

import shlex


# Every far-side script starts with this, after the paths and BOX (``transport.prelude``): the same
# tmux invocation and portable helpers on macOS and Linux alike, and BOX = the name the coordinator
# addressed the box by, so every line it prints is greppable by that name.
HELPERS = r"""set -uo pipefail
expand_tilde() { case "$1" in '~/'*) printf '%s' "$HOME/${1#\~/}" ;; '~') printf '%s' "$HOME" ;; *) printf '%s' "$1" ;; esac; }
tm() { if [ -n "$TMUX_SOCKET" ]; then tmux -L "$TMUX_SOCKET" "$@"; else tmux "$@"; fi; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
now() { date +%s; }
meta_get() { sed -n "s/^$2=//p" "$1/meta" 2>/dev/null | head -n1; }
# The session id addresses every intervention: from meta when the launch recorded it, else from
# the stream itself (a Codex thread id lands there first; a launch connection can drop between).
session_of() {
  local s; s=$(meta_get "$1" session)
  [ -n "$s" ] || s=$(jq -Rr 'fromjson? | select(.type=="thread.started") | .thread_id' "$1/stream.jsonl" 2>/dev/null | head -n1)
  [ -n "$s" ] || s=$(jq -Rr 'fromjson? | select(.type=="system" and .subtype=="init") | .session_id' "$1/stream.jsonl" 2>/dev/null | head -n1)
  printf '%s' "$s"
}
# A literal string as an ERE, for pgrep/pkill -f.
re_lit() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|/]/\\&/g'; }
# `=` forces an exact session name: without it tmux falls back to prefix matching, and with
# iw-repo-1 gone, -t iw-repo-1 would resolve to iw-repo-12 - reading, or killing, a sibling.
# tmux turns a `.` in a session name into `_`, so a dotted worker's session was never found by its
# own name (and `a.b` would share `a_b`'s): names map `.` to `+`, which no worker name contains.
sess() { printf 'iw-%s' "${1//./+}"; }
alive() { tm has-session -t "=$(sess "$1")" 2>/dev/null; }
WORKERS="$STATE/workers"
# take_lock <dir> <wait-seconds> <label>: a mkdir lock that records its holder's pid, so a lock
# left by a killed shell or a rebooted box is reclaimed instead of wedging the name forever.
# Prints nothing on success; on failure prints one line and returns 1. Release with rmdir.
# The holder is identified by pid AND process start time: after a reboot (or plain pid reuse)
# the recorded pid may belong to an unrelated live process, which a bare kill -0 would treat
# as the holder forever.
proc_start() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' '; }
take_lock() {
  local lock="$1" wait="$2" label="$3" waited=0 holder hstart
  until mkdir "$lock" 2>/dev/null; do
    [ -d "$lock" ] || { echo "$label: cannot create lock $lock (unwritable?)"; return 1; }
    holder=$(cat "$lock/pid" 2>/dev/null); hstart=$(cat "$lock/start" 2>/dev/null)
    if [ -n "$holder" ] && { ! kill -0 "$holder" 2>/dev/null || [ "$(proc_start "$holder")" != "$hstart" ]; }; then
      rm -f "$lock/pid" "$lock/start"; rmdir "$lock" 2>/dev/null; continue   # dead or reused pid: reclaim
    fi
    # No owner recorded: registration takes milliseconds, so an ownerless lock older than 30 s
    # was left by a shell that died between mkdir and the pid write. Reclaim it.
    if [ -z "$holder" ] && [ $(( $(now) - $(mtime "$lock") )) -gt 30 ]; then
      rm -f "$lock/pid" "$lock/start"; rmdir "$lock" 2>/dev/null; continue
    fi
    [ "$waited" -lt "$wait" ] || { echo "$label: lock $lock held ${holder:+by pid $holder }for ${wait}s -- another operation in progress"; return 1; }
    sleep 1; waited=$((waited + 1))
  done
  # start before pid: a contender that sees a pid without its start time would otherwise read
  # the mismatch as a reused pid and reclaim a lock that is being taken right now.
  proc_start $$ > "$lock/start"; echo $$ > "$lock/pid"
}
release_lock() { rm -f "$1/pid" "$1/start"; rmdir "$1" 2>/dev/null; }
# bounded [--stdin <file>] <secs> <cmd...>: run detached from the caller's stdin, kill the whole
# group at the deadline (no `timeout` on stock macOS). Output on stdout; exit 124 on expiry.
# The child's stdin is /dev/null unless --stdin names a file. A pipe into `bounded` is NOT
# forwarded: a `&` command with job control off gets /dev/null for stdin, and macOS's bash 3.2
# (what the local run_on's `bash -s` is) applies that even inside a pipeline, while bash 5 on the
# Linux boxes kept the pipe -- so the live probe's prompt reached codex on rog and minix and
# vanished on mac-studio ("No prompt provided via stdin.", reported as an empty refusal). And the
# far-side scripts run under `bash -s`, whose stdin IS the script: a child inheriting it would
# eat the rest of the preflight. Hence a file, never the inherited descriptor.
bounded() {
  local stdin=/dev/null
  if [ "$1" = --stdin ]; then stdin="$2"; shift 2; fi
  local secs="$1"; shift
  local out rcf pid waited=0 rc c
  out=$(mktemp "${TMPDIR:-/tmp}/fw-probe.XXXXXX"); rcf=$(mktemp "${TMPDIR:-/tmp}/fw-probe-rc.XXXXXX")
  # Everything under the probe writes to files or /dev/null: nothing it spawns may inherit the
  # caller's stdout, or a lingering child would hold a command substitution open.
  ( "$@" < "$stdin" > "$out" 2>&1; echo $? > "$rcf" ) >/dev/null 2>&1 &
  pid=$!
  # Tenth-second polls: a probe that returns at once (a reachable ssh sibling, a fast CLI) must
  # not cost a whole second each, since the preflight runs them serially under the per-box lock
  # and every launch pays it; [waited] counts tenths against [secs].
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt $((secs * 10)) ]; do sleep 0.1; waited=$((waited + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    for c in $(pgrep -P "$pid" 2>/dev/null); do pkill -P "$c" 2>/dev/null; kill "$c" 2>/dev/null; done
    kill "$pid" 2>/dev/null; rc=124
  else
    rc=$(cat "$rcf" 2>/dev/null); rc=${rc:-1}
  fi
  wait "$pid" 2>/dev/null
  cat "$out"; rm -f "$out" "$rcf"; return "$rc"
}
# The pattern that finds a worker's CLI by its own command line: a claude or codex command
# word, then the session id (claude, and codex after a resume) or this worker's state dir
# (codex's -o). The command-word anchor keeps a `tail -f .../stream.jsonl` or an editor on a
# record file from reading as the worker - or from being killed as one. Same pattern everywhere.
live_pat() {
  local d="$WORKERS/$1" p sid; p=$(re_lit "$WORKERS/$1/"); sid=$(session_of "$d"); [ -n "$sid" ] && p="$(re_lit "$sid")|$p"
  printf '(^|/| )(claude|codex)( |$).*(%s)' "$p"
}
# tmux gone but the CLI reparented and still running: a live writer, not a finished worker.
orphaned() { ! alive "$1" && pgrep -f -- "$(live_pat "$1")" >/dev/null 2>&1; }
running() { alive "$1" || orphaned "$1"; }
# A claude worker on the stream-json input channel (see the header); a record from before it, and
# every codex worker, runs one process per turn.
is_stream() { [ "$(meta_get "$WORKERS/$1" channel)" = stream-json ]; }
meta_num() { local v; v=$(meta_get "$1" "$2"); case "$v" in ''|*[!0-9]*) echo "${3:-0}" ;; *) echo "$v" ;; esac; }
# meta_set <dir> <key> <value> [<key> <value> ...]: replace or add meta lines in ONE rename, so
# meta holds all of the new values or none of them; verified by reading them back.
meta_set() {
  local d="$1" keys="" k; shift
  local -a kv=("$@")
  for ((k = 0; k < ${#kv[@]}; k += 2)); do keys="$keys|${kv[k]}"; done
  { grep -Ev "^(${keys#|})=" "$d/meta"; for ((k = 0; k < ${#kv[@]}; k += 2)); do printf '%s=%s\n' "${kv[k]}" "${kv[k + 1]}"; done; } > "$d/meta.new" 2>/dev/null &&
    mv -f "$d/meta.new" "$d/meta" 2>/dev/null || return 1
  for ((k = 0; k < ${#kv[@]}; k += 2)); do [ "$(meta_get "$d" "${kv[k]}")" = "${kv[k + 1]}" ] || return 1; done
}
# turn_state <name>: "<turn> <bg> <res>", read from the stream past the current process's start
# (proc_offset). turn: `ended` when the last turn event is a `result`, `working` when it is a
# system init, a user or an assistant event, a task_notification, or a background task list
# going from nonempty to empty (a finished background task starts a turn with no user event: the
# CLI clears the list, then notifies, then inits the turn, in separate writes), `none` before the
# first. Its boundary: a task that leaves the list WITHOUT starting a turn would leave the worker
# `working` until its next event; every finished task observed (2.1.282) started one; bg: how many background
# tasks the last background_tasks_changed event listed; res: 1 when the latest message sent has
# had its reply -- a `result` after the CLI's echo of that message (meta `awaiting`, its uuid), or,
# for a record that names none, a `result` past turn_offset. An echo is the proof the CLI read
# the message: a `result` between the append and the read answers something else.
# awaiting_of <name>: meta `awaiting`, but only while input.jsonl carries that message: a writer
# killed between the meta update and its line (SIGKILL holds for no trap) leaves meta naming a
# message nobody sent, which would hold attach and close forever. Then turn_offset decides.
awaiting_of() {
  local d="$WORKERS/$1" u; u=$(meta_get "$d" awaiting)
  [ -n "$u" ] && grep -qF -- "\"uuid\":\"$u\"" "$d/input.jsonl" 2>/dev/null && printf '%s' "$u"
}
turn_state() {
  local d="$WORKERS/$1" poff toff out
  poff=$(meta_num "$d" proc_offset); toff=$(meta_num "$d" turn_offset)
  [ "$toff" -ge "$poff" ] || toff=$poff
  out=$(tail -n +"$((poff + 1))" "$d/stream.jsonl" 2>/dev/null | jq -Rrn --argjson rel "$((toff - poff))" --arg u "$(awaiting_of "$1")" '
    reduce inputs as $l ({n: 0, t: "none", bg: 0, res: 0, seen: ($u == "")};
      .n += 1 | (($l | fromjson?) // null) as $e
      | if ($e | type) != "object" then .
        elif $e.type == "result" then .t = "ended" | (if .seen and .n > $rel then .res = 1 else . end)
        elif $u != "" and $e.type == "user" and $e.uuid == $u then .t = "working" | .seen = true
        elif $e.type == "assistant" or $e.type == "user" or ($e.type == "system" and ($e.subtype == "init" or $e.subtype == "task_notification")) then .t = "working"
        elif $e.type == "system" and $e.subtype == "background_tasks_changed" then
          (($e.tasks // []) | length) as $nb | (if .bg > 0 and $nb == 0 then .t = "working" else . end) | .bg = $nb
        else . end)
    | "\(.t) \(.bg) \(.res)"' 2>/dev/null)
  printf '%s' "${out:-none 0 0}"
}
# first_unread <name> <lines>: the first line of input.jsonl, among the current process's
# (input_from on) up to <lines>, whose message that process never echoed -- so a resume feeds a
# queued message the dead process never read instead of skipping it; <lines>+1 when none is.
first_unread() {
  local d="$WORKERS/$1" seen n u
  seen=$(tail -n +"$(( $(meta_num "$d" proc_offset) + 1 ))" "$d/stream.jsonl" 2>/dev/null | jq -Rr 'fromjson? | select(.type=="user" and .isReplay==true) | .uuid // empty' 2>/dev/null)
  n=$(meta_num "$d" input_from 1)
  while [ "$n" -le "$2" ]; do
    u=$(sed -n "${n}p" "$d/input.jsonl" 2>/dev/null | jq -r '.uuid // empty' 2>/dev/null)
    [ -n "$u" ] && ! grep -qxF -- "$u" <<< "$seen" && break
    n=$((n + 1))
  done
  printf '%s' "$n"
}
# The pid of a stream worker's live feeder, or nothing (status 1): a pid file alone could name a
# reused pid, so the process must still be a tail on this record's input.jsonl.
feeder_of() {
  local d="$WORKERS/$1" p c; p=$(cat "$d/feeder.pid" 2>/dev/null)
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  c=$(ps -ww -o command= -p "$p" 2>/dev/null)   # -ww: never width-truncated (macOS)
  case "$c" in *tail*"$d/input.jsonl"*) printf '%s' "$p" ;; *) return 1 ;; esac
}
# user_line <file> <uuid>: one stream-json user message carrying the file's bytes, built by jq,
# so no message text is ever a shell word; the uuid comes back in the CLI's replay of it.
user_line() { jq -cRs --arg u "$2" '{type: "user", uuid: $u, message: {role: "user", content: .}}' "$1" 2>/dev/null; }
# stream_run <dir> <cwd> <from-line> --session-id|--resume <sid> [extra CLI args]: the run.sh of
# a claude worker. The feeder -- a `tail -f` of input.jsonl from <from-line> on (a resume starts
# past the lines an earlier process read), its pid in feeder.pid -- writes into a PIPE the CLI
# reads, so the CLI's stdin stays open until the feeder dies; its subshell waits for it, so killing
# the tail closes the pipe's last write end and the CLI reads EOF. A pipe, not a FIFO: with a FIFO
# on stdin, Claude Code 2.1.282 on macOS never saw EOF after its writer died (probed 2026-09-26),
# where a pipe ends it at once. The CLI's side ends the feeder when the CLI ends on its own (a
# crash), so the pipeline, and with it run.sh, always finishes and records the CLI's exit code.
# No `&` pipeline: bash 3.2 gives an asynchronous command /dev/null for stdin even in a pipeline.
stream_run() {
  local d="$1" cwd="$2" from="$3" flag="$4" sid="$5" a feeder; shift 5
  printf 'cd %q || { echo 97 > %q; exit 97; }\n' "$cwd" "$d/exit"
  printf 'rm -f %q\n' "$d/feeder.pid"
  # Without its pid on record the feeder could never be closed or ended, so the CLI starts only
  # once feeder.pid names this record's live tail (else exit 95, the CLI never started, after
  # FEEDER_WAIT seconds of 0.2 s polls); a failed pid write ends the feeder it would have named, so
  # the pipeline still finishes.
  printf '{ tail -n +%d -f %q & echo $! > %q || { kill $!; exit 95; }; wait; } | {\n' "$from" "$d/input.jsonl" "$d/feeder.pid"
  feeder=$(printf 'case "$(ps -ww -o command= -p "$p" 2>/dev/null)" in *tail*%q*)' "$d/input.jsonl")
  printf '  n=0; while p=$(cat %q 2>/dev/null); ! %s true ;; *) false ;; esac; do n=$((n + 1)); [ "$n" -lt %d ] || { case "$p" in *[!0-9]*|"") ;; *) kill "$p" 2>/dev/null ;; esac; exit 95; }; sleep 0.2; done\n' "$d/feeder.pid" "$feeder" "$((FEEDER_WAIT * 5))"
  printf '  claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --dangerously-skip-permissions %s %q' "$flag" "$sid"
  for a in "$@"; do printf ' %q' "$a"; done
  printf ' >> %q 2>> %q; rc=$?\n' "$d/stream.jsonl" "$d/stderr.log"
  # Killed only while it is still this record's tail: `close` may have ended it already, and its
  # pid could be anyone's by now.
  printf '  %s kill "$p" 2>/dev/null ;; esac; exit "$rc"\n}\n' "$feeder"
  printf 'rc=$?; rm -f %q; echo "$rc" > %q\n' "$d/feeder.pid" "$d/exit"
}
state_of() {
  if alive "$1"; then
    if is_stream "$1"; then case "$(turn_state "$1")" in "ended 0 "*) echo IDLE; return ;; esac; fi
    echo RUNNING
  elif orphaned "$1"; then echo ORPHANED; elif [ -f "$WORKERS/$1/exit" ]; then echo "EXITED($(cat "$WORKERS/$1/exit"))"; else echo VANISHED; fi
}
# A stale tmux server environment (ludics-lite#327). A CLI worker's `bash run.sh` reads no startup
# file, and a new tmux session takes the SERVER's environment, not the asking shell's, so an
# env.sh or gpu.sh edit reaches no CLI worker on a box whose server predates it -- silently: a
# server started before gpu.sh dropped ROCM_PATH=/usr (2026-09-22) would have gone on handing
# workers the value that broke hipcc's bitcode discovery. The reference is what a server started
# NOW would get, which is this script's own environment: on a remote box it runs under
# `ssh <box> "bash -s"`, the fresh non-login ssh shell whose ~/.bashrc sources env.sh (the
# launch that starts a server runs under the same one), and on the local box under a `bash -s`
# that reads no startup file, as that launch does. The coordinator's own environment never
# enters a remote comparison. No server running passes: the next launch starts a fresh one.
# Prints the refusal and returns 1 on a stale server. The preflight reports it early, and every
# far-side script that creates a worker session (launch, unstick) repeats it just before
# `new-session`: the launch's fetch and base gate can take minutes, and a resume creates a
# session with no preflight at all.
TMUX_ENV_VARS="PATH ROCM_PATH HIP_PATH OPAM_SWITCH_PREFIX"
tmux_env_check() {
  local sessions genv refreshed v line skip sset sval fset fval diff=""
  genv=$(tm show-environment -g 2>/dev/null) || return 0   # no server running
  # `exit-empty off` keeps a server alive with no session at all, so the server is found by its
  # environment, never by its session list; an unreadable list is an empty one.
  sessions=$(tm list-sessions -F '#{session_name}' 2>/dev/null) || sessions=""
  # A variable named in `update-environment` is copied from the launching client into every new
  # session (removed there when the client lacks it), so the worker gets the fresh shell's value
  # whatever the global one says: comparing it would refuse a safe launch.
  refreshed=$(tm show-options -gv update-environment 2>/dev/null)
  for v in $TMUX_ENV_VARS; do
    skip=0
    while IFS= read -r line; do [ "$line" = "$v" ] && skip=1; done <<< "$refreshed"
    [ "$skip" = 0 ] || continue
    # `VAR=value` is set, `-VAR` is removed from the global environment, no line is never set.
    sset=0; sval=""
    while IFS= read -r line; do
      case "$line" in "$v="*) sset=1; sval=${line#"$v="} ;; "-$v") sset=0; sval="" ;; esac
    done <<< "$genv"
    fset=0; fval=""; if [ -n "${!v+x}" ]; then fset=1; fval=${!v}; fi
    [ "$sset" = "$fset" ] && [ "$sval" = "$fval" ] && continue
    [ "$sset" = 1 ] || sval="unset"; [ "$fset" = 1 ] || fval="unset"
    diff="$diff, $v is $sval in the server but $fval in a fresh shell"
  done
  [ -n "$diff" ] || return 0
  echo "stale tmux server environment (${diff#, }): a CLI worker started now would inherit the server's values; $(tmux_restart_advice "$sessions")"
  return 1
}
# How to get a server with a fresh environment, given its session list: every live worker is an
# iw-<name> session on this socket (`ls` reads RUNNING from the same sessions), and kill-server
# ends every session the server holds.
tmux_restart_advice() {
  local line workers="" others="" tmx
  while IFS= read -r line; do
    case "$line" in iw-*) workers="$workers $line" ;; ?*) others="$others $line" ;; esac
  done <<< "$1"
  if [ -n "$TMUX_SOCKET" ]; then tmx="tmux -L $(printf '%q' "$TMUX_SOCKET")"; else tmx=tmux; fi
  # Whichever branch names kill-server also names what else it would end: on the default socket
  # those are the user's own sessions.
  others=${others:+ (kill-server also ends its non-worker session(s):$others)}
  if [ -n "$workers" ]; then
    echo "wait for its live worker session(s) (${workers# }; \`fleet-worker.sh ls $BOX\`) to finish, then \`$tmx kill-server\` if it outlives them$others"
  else
    echo "no worker session is live on it, so restart it with \`$tmx kill-server\`$others and try again"
  fi
}
"""


# The skills checkout's freshness, shared by the preflight and `refresh` (ludics-lite#362) so the
# two can never disagree about what "current" means. The caller defines note() (it appends to
# $refuse) and runs this before any note of its own, since the fast-forward is attempted only when
# this function has noted nothing. Brings a clean main to origin/main and never resets anything: a
# divergent checkout is noted, not repaired. Arg: the fetch's wall-clock bound. Sets repo, before
# (HEAD on entry), head, up (origin/main) and other (changes outside the served tree). Returns 2
# when there is no checkout at all, else 0.
# checkout_lock <wait> <label> goes first: the lock that serializes everything that fetches or
# fast-forwards the checkout. It lives in the checkout's own git directory, so every caller on the
# box meets the same lock whatever its ISSUE_WAVE_STATE (per coordinator; the daily sweep may run
# under another), which a lock under that state directory did not give (PR #379 review). Sets repo
# and plock and arms the release; prints the refusal and returns 1 on timeout, 2 with no checkout.
FRESHNESS = r"""checkout_lock() {
  local gitdir
  repo=$(expand_tilde "$SKILLS_REPO")
  gitdir=$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null) || return 2
  plock="$gitdir/fleet-checkout.lock"
  take_lock "$plock" "$1" "$2" || return 1
  trap 'release_lock "$plock"' EXIT
}
skills_freshness() {
  local prior="$refuse" frc served statusz hidden entry st path from branch pycache pydirs dir
  repo=$(expand_tilde "$SKILLS_REPO")
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 2
  before=$(git -C "$repo" rev-parse HEAD 2>/dev/null)
  bounded "$1" git -C "$repo" fetch -q origin >/dev/null; frc=$?
  if [ "$frc" -eq 124 ]; then note "git fetch in $repo timed out after ${1}s"; elif [ "$frc" -ne 0 ]; then note "fetch failed (offline?)"; fi
  # The whole checkout is the served tree: every skill directory sits at its root, so any local
  # change - tracked, untracked, even ignored - is divergence to surface, since the deployed
  # symlinks would serve it. The one exception is a stray .claude/ (settings.local.json appears
  # wherever claude was run inside the checkout): not skill text, so reported rather than refused.
  # The fast-forward below still fails, and refuses, if such a change collides with what upstream brings.
  # NUL-delimited, so a path git would otherwise quote (a space, a quote, a non-ASCII byte) is
  # still classified by its directory rather than falling through as "outside the served tree".
  # One shape of served change gets its repair named (ludics-lite#585): an ignored Python bytecode
  # cache under lib/ (`!!` on a path lib/.../__pycache__/...), which scripts/py wrote before it ran
  # the interpreter with -B. It still refuses; the note names the directories to remove only when
  # EVERY served entry has that shape and the scan noted nothing else (an index-hidden file, a
  # status that failed), so the removal it names is the whole repair of the served tree. A single
  # entry of any other shape, or another note, keeps the plain note.
  served=0; other=""; pycache=0; pydirs=""
  statusz=$(mktemp "${TMPDIR:-/tmp}/fw-status.XXXXXX")
  if ! git -C "$repo" status --porcelain -z --untracked-files=all --ignored=matching > "$statusz" 2>/dev/null; then
    rm -f "$statusz"; note "git status failed in $repo (cannot scan the served tree)"; statusz=/dev/null
  fi
  # Index-hidden entries (skip-worktree / assume-unchanged) never show in status: refuse them
  # under the served tree outright, since the symlinks serve the working-tree bytes.
  hidden=$(git -C "$repo" ls-files -v 2>/dev/null | grep -c '^[Sh]' || true)
  [ "${hidden:-0}" -eq 0 ] || note "$hidden index-hidden (skip-worktree/assume-unchanged) file(s) in the served tree"
  while IFS= read -r -d '' entry; do
    st=${entry:0:2}; path=${entry:3}; from=""
    case "$st" in R*|C*) IFS= read -r -d '' from ;; esac   # a rename's second record is the source
    # Both sides of a rename count: a file moved OUT of the served tree is a served file gone.
    case "$path" in .claude/*) case "$from" in ""|.claude/*) other="$other$path " ;; *) served=$((served + 1)) ;; esac ;; *) served=$((served + 1)) ;; esac
    case "$st:$path" in
      '!!:lib/__pycache__/'*|'!!:lib/'*'/__pycache__/'*)
        pycache=$((pycache + 1)); dir=$(printf '%q' "$repo/${path%%/__pycache__/*}/__pycache__")
        case " $pydirs " in *" $dir "*) ;; *) pydirs="${pydirs:+$pydirs }$dir" ;; esac ;;
    esac
  done < "$statusz"
  [ "$statusz" = /dev/null ] || rm -f "$statusz"
  if [ "$served" -gt 0 ] && [ "$pycache" -eq "$served" ] && [ "$refuse" = "$prior" ]; then
    note "$served local change(s) in the served tree, every one an ignored Python bytecode cache under lib/ (left by a run before scripts/py ran Python with -B, ludics-lite#585) -- repair, on $BOX: rm -rf $pydirs"
  elif [ "$served" -gt 0 ]; then
    note "$served local change(s) in the served tree"
  fi
  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [ "$branch" = main ] || note "checked out $branch, not main"
  if [ "$refuse" = "$prior" ]; then
    git -C "$repo" merge --ff-only -q origin/main >/dev/null 2>&1 || note "main does not fast-forward to origin/main"
  fi
  head=$(git -C "$repo" rev-parse HEAD 2>/dev/null); up=$(git -C "$repo" rev-parse origin/main 2>/dev/null)
  # Only after a fast-forward that went through: one that was never tried leaves a stale HEAD by
  # design, and the note that stopped it already says why.
  [ "$refuse" != "$prior" ] || [ "$head" = "$up" ] || note "HEAD $(echo "$head" | cut -c1-9) != origin/main $(echo "$up" | cut -c1-9) (ahead, or offline)"
}
"""


# The GitHub probe (ludics-lite#360, #374), shared by the preflight, which runs it in its own
# session and in a running tmux server, and by the far sides that create a worker session (launch,
# unstick), which run it in the server just before new-session, as they repeat tmux_env_check.
# ``ghprobe(bound)`` is it with gh_bound, each call's wall-clock bound (FLEET_GH_TIMEOUT), set.
GHPROBE = r"""# gh_probe_write <file>: the probe, one file run wherever it is made, `bash <file> <dir> <bound>
# [tmux]`. It writes gh.rc and gh.out (`gh api user`; rc 127 is no gh on PATH), then git.rc and
# git.out, then done. The git half asks for github.com's HTTPS credential as a push does, with
# prompts and askpass off, and once the API call passed, tries the credential git returned against
# GitHub: a helper can hold a stale password beside a live GH_TOKEN, and retrieving one proves
# nothing about it. The credential lives in a variable and in that one call's GH_TOKEN, never in
# a file: git.out holds git's stderr and gh's error alone. The account must be the one gh's own
# token answered as, since that is who opens the PR (the fleet pushes as one user). Its exits: 0
# accepted (or retrieved, when there was nothing to try it against), 1 no credential, 2 GitHub
# refused it, 3 no password, 4 another account's, 5 GitHub did not answer the try; 124 is then the
# helper's own silence, since the try is bounded inside.
# With `tmux` it ends by killing its own session, so `remain-on-exit` or an interrupted preflight
# leaves none behind; the caller never passes it outside a probe session (a shell in the user's own
# pane has TMUX_PANE too).
gh_probe_write() {
  { printf '%s\n' 'set -u'; declare -f bounded; cat <<'PROBE'
d="$1" t="$2"
cd / || exit 1
# Which token variables this session carries, by name alone (ludics-lite#567).
{ [ -z "${GH_TOKEN:-}" ] || echo GH_TOKEN; [ -z "${GITHUB_TOKEN:-}" ] || echo GITHUB_TOKEN; } > "$d/env.out"
if command -v gh >/dev/null 2>&1; then
  GH_PROMPT_DISABLED=1 bounded "$t" gh api --hostname github.com user -q .login > "$d/gh.out"; echo "$?" > "$d/gh.rc"
else echo 127 > "$d/gh.rc"; fi
# bounded runs it in a subshell that records its status after it: return, never exit.
# The API call has its own bound inside the helper's: its silence is GitHub's (5), not the helper's.
git_cred() {
  local cred pw out orc
  cred=$(git credential fill) || return 1
  [ "$1" = 0 ] || return 0
  pw=$(printf '%s\n' "$cred" | sed -n 's/^password=//p' | head -n 1)
  [ -n "$pw" ] || { echo "git's answer carries no password"; return 3; }
  out=$(GH_TOKEN=$pw GH_PROMPT_DISABLED=1 bounded "$3" gh api --hostname github.com user -q .login); orc=$?
  [ "$orc" -ne 124 ] || { echo "no answer from gh api user in ${3}s"; return 5; }
  out=$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -n 1)
  [ "$orc" -eq 0 ] && [ -n "$out" ] || { printf '%s\n' "${out:-exit $orc, no output}"; return 2; }
  [ "$out" = "$2" ] || { printf '%s\n' "git's credential is $out's, gh's token is $2's"; return 4; }
}
printf 'protocol=https\nhost=github.com\n\n' > "$d/cred.in"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false GCM_INTERACTIVE=never \
  bounded --stdin "$d/cred.in" "$((2 * t + 5))" git_cred "$(cat "$d/gh.rc")" "$(tail -n 1 "$d/gh.out" 2>/dev/null)" "$t" > "$d/git.out"; echo "$?" > "$d/git.rc"
: > "$d/done"
[ "${3:-}" != tmux ] || [ -z "${TMUX_PANE:-}" ] || tmux kill-session -t "$TMUX_PANE" 2>/dev/null
PROBE
  } > "$1"
}
# gh_read <dir>: ghst is ok, nogh, down, refused or none (no result at all), ghlast what gh said;
# ghenv the token variables the probe's session carried (names, " and "-joined);
# gitst ok, down, rejected, other (another account's), or none/nocred (no credential), gitwhy what
# git or GitHub said. A
# GitHub that did not answer is gh's "error connecting to" or an HTTP 5xx; any other failure refuses.
gh_read() {
  local ghrc gitrc ghout gitout v
  ghrc=$(cat "$1/gh.rc" 2>/dev/null); gitrc=$(cat "$1/git.rc" 2>/dev/null)
  ghout=$(cat "$1/gh.out" 2>/dev/null); gitout=$(cat "$1/git.out" 2>/dev/null)
  ghenv=""; [ ! -r "$1/env.out" ] || while IFS= read -r v; do
    case "$v" in GH_TOKEN|GITHUB_TOKEN) ghenv="${ghenv:+$ghenv and }$v" ;; esac
  done < "$1/env.out"
  ghlast=$(printf '%s\n' "$ghout" | sed '/^[[:space:]]*$/d' | tail -n1 | sed 's/^.*}gh: /gh: /' | cut -c1-120)
  case "$ghrc" in
    '') ghst=none; ghlast="no result" ;;
    0) if [ -n "$ghlast" ]; then ghst=ok; else ghst=refused; ghlast="exit 0, no output"; fi ;;
    127) ghst=nogh ;;
    124) ghst=down; ghlast="no answer from gh api user in ${gh_bound}s" ;;
    *) case "$ghout" in *"error connecting to "*|*"(HTTP 5"[0-9][0-9]")"*) ghst=down; ghlast="gh api user: $ghlast" ;; *) ghst=refused; ghlast=${ghlast:-exit $ghrc, no output} ;; esac ;;
  esac
  gitwhy=$(printf '%s\n' "$gitout" | sed '/^[[:space:]]*$/d' | tail -n1 | sed 's/^.*}gh: /gh: /' | cut -c1-120)
  case "$gitrc" in
    '') gitst=none; gitwhy="no result" ;;
    0) gitst=ok; gitwhy="" ;;
    124) gitst=nocred; gitwhy="no answer from git's credential helper in $((2 * gh_bound + 5))s" ;;
    5) gitst=down ;;
    2) case "$gitout" in *"error connecting to "*|*"(HTTP 5"[0-9][0-9]")"*) gitst=down ;; *) gitst=rejected ;; esac; gitwhy=${gitwhy:-no output} ;;
    4) gitst=other ;;
    *) gitst=nocred; gitwhy=${gitwhy:-exit $gitrc, no output} ;;
  esac
}
# gh_verdict: gh_read's result as one reason (srv) and a GitHub-did-not-answer note; 1 on a reason.
gh_verdict() {
  srv=""
  case "$ghst" in ok) ;; down) tmux_gh_down=$ghlast ;; nogh) srv="no gh on PATH" ;; *) srv="gh api user: $ghlast" ;; esac
  case "$ghst:$gitst" in
    *:ok|nogh:*|refused:*|none:*) ;;
    *:down) tmux_gh_down="${tmux_gh_down:+$tmux_gh_down; }checking git's credential: $gitwhy" ;;
    *:rejected|*:other) srv="${srv:+$srv; }git's credential: $gitwhy" ;;
    *) srv="${srv:+$srv; }git credential fill: $gitwhy" ;;
  esac
  [ -z "$srv" ]
}
# tmux_gh_check [login]: the probe as the command of a throwaway session of the tmux server a CLI
# worker would start in, in the shape `launch` starts one (`bash <file>` via new-session, so
# update-environment and the default shell, and its startup files, apply as they do for the worker;
# `run-shell` is not that shape: it runs /bin/sh in the most recent session's environment). A new
# session takes a RUNNING server's environment, not this shell's, and a server started before
# gh-token.sh existed or rotated hands out a stale token or none; with no server running, the
# session starts one from this shell, as the worker's would. No comparison of variables stands in
# for this (#367 built one over three review rounds and removed it). The session must also answer
# as the account this shell's probe proved: <login>, or with none given this shell is probed first
# (a resume has no preflight in front of it, and a launch's preflight ran minutes earlier in another
# shell). Returns 1 with tmux_gh_msg set on a failure; tmux_gh_down says GitHub did not answer.
# tmux_gh_envmsg, set whatever it returns, says the new session carries a GitHub token variable
# (ludics-lite#567: a CLI worker started there hands the PAT to every process it starts); the
# preflight notes it when this session itself exports none.
# The session is not iw-*, so no `ls` reads it as a worker.
tmux_gh_check() {
  local want="${1:-}" pf pd ps perr waited srv="" had=1
  tmux_gh_msg=""; tmux_gh_down=""; tmux_gh_envmsg=""
  pf=$(mktemp "${TMPDIR:-/tmp}/fw-ghprobe.XXXXXX"); pd=$(mktemp -d "${TMPDIR:-/tmp}/fw-ghprobe.XXXXXX"); ps="fw-ghprobe-$$"
  gh_probe_write "$pf"
  if [ -z "$want" ]; then
    bash "$pf" "$pd" "$gh_bound" < /dev/null > /dev/null 2>&1; gh_read "$pd"; rm -rf "$pd"; mkdir -p "$pd"
    if ! gh_verdict; then
      rm -rf "$pd" "$pf"
      tmux_gh_msg="GitHub credential refused in a non-interactive session on $BOX ($srv) -- \`fleet-worker.sh preflight $BOX\` names the repair"
      return 1
    fi
    [ "$ghst" != ok ] || want=$ghlast   # GitHub silent: no login to hold the server to
  fi
  tm show-environment -g >/dev/null 2>&1 || had=0
  if perr=$(tm new-session -d -s "$ps" "bash $(printf '%q' "$pf") $(printf '%q' "$pd") $(printf '%q' "$gh_bound") tmux" 2>&1); then
    # Both calls' bounds and a margin, in tenths; a session gone without `done` has no more to say.
    waited=0
    while [ ! -e "$pd/done" ] && [ "$waited" -lt $((gh_bound * 30 + 150)) ] && tm has-session -t "=$ps" 2>/dev/null; do
      sleep 0.1; waited=$((waited + 1))
    done
    tm kill-session -t "=$ps" 2>/dev/null   # a probe past its bound; a finished one has gone itself
    gh_read "$pd"
    if [ -n "$ghenv" ] && [ "$had" = 1 ]; then
      tmux_gh_envmsg="a new session of the running tmux server on $BOX gets $ghenv, so a CLI worker started now hands the fleet PAT to every process it starts: $(tmux_restart_advice "$(tm list-sessions -F '#{session_name}' 2>/dev/null)")"
    elif [ -n "$ghenv" ]; then
      tmux_gh_envmsg="a tmux server started from this session on $BOX gives a new session $ghenv: its default shell's startup files export it (grep -Hnos -e GH_TOKEN -e GITHUB_TOKEN ~/.zshenv ~/.bashrc ~/.config/fleet/env.sh lists the lines without their values)"
    fi
    gh_verdict && [ "$ghst" = ok ] && [ -n "$want" ] && [ "$ghlast" != "$want" ] && srv="gh api user answers as $ghlast, not as $want"
  else
    rm -rf "$pd" "$pf"
    tmux_gh_msg="tmux on $BOX refused a probe session ($(printf '%s' "$perr" | tail -n1 | cut -c1-120)), so it would refuse a CLI worker's too"
    return 1
  fi
  rm -rf "$pd" "$pf"
  [ -n "$srv" ] || return 0
  if [ "$had" = 1 ]; then
    tmux_gh_msg="the running tmux server on $BOX gives a new session a GitHub credential that does not work ($srv): a CLI worker started now would inherit it; $(tmux_restart_advice "$(tm list-sessions -F '#{session_name}' 2>/dev/null)")"
  else
    tmux_gh_msg="a tmux server started from this session on $BOX gives a new session a GitHub credential that does not work ($srv), though this session's own passes: its default shell's startup files change it (grep -Hnos GH_TOKEN ~/.zshenv ~/.bashrc ~/.config/fleet/env.sh lists the lines without their values)"
  fi
  return 1
}
"""


def ghprobe(bound: str) -> str:
    """The GitHub probe's far side, its bound first (the shell's ``printf 'gh_bound=%q\\n'``)."""
    return f"gh_bound={shlex.quote(bound)}\n" + GHPROBE


# scripts/py's interpreter order, held here as data so a unit test can pin it against scripts/py's
# own text (test_fleetworker_workers): the built-in candidates, then under Git Bash / MSYS / Cygwin
# the launcher `py` with each of these arguments.
PY_CANDIDATES = (
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "python3.13",
    "python3.12",
    "python3",
    "python",
    "${HOME:-/nonexistent}/.local/bin/python3.12",
)
PY_LAUNCHER_ARGS = ("-3.12", "-3")

# The first Python >= 3.12 in scripts/py's order, or in LUDICS_PY_CANDIDATES (one per line, which
# replaces the order, the launcher included) as the box's environment sets it. A non-interactive
# ssh session on a Mac often has no /opt/homebrew on PATH, and its bare python3 is Xcode's 3.9.
# Prints the interpreter and returns 0 -- for the launcher, the interpreter it chose (its
# sys.executable, as a POSIX path where cygpath can say one), since a caller runs "$py" as one
# word; or prints what each candidate was, in scripts/py's words, and returns 1. The probe is
# scripts/py's own, which parses on any Python down to 2.x and prints the version it ran under.
FLEET_PYTHON = (
    r"""# fleet_py_try <command> [<arg>]: scripts/py's try, noting a miss in fleet_py_tried.
fleet_py_try() {
  local cmd="$1" arg="${2:-}" label where v rc exe
  label="$cmd${arg:+ $arg}"
  case "$cmd" in
    */*) if [ ! -f "$cmd" ] || [ ! -x "$cmd" ]; then fleet_py_tried="$fleet_py_tried, $label: absent"; return 1; fi
         where="$cmd" ;;
    *) where=$(command -v "$cmd" 2>/dev/null) || { fleet_py_tried="$fleet_py_tried, $label: not on PATH"; return 1; } ;;
  esac
  local probe='import sys; sys.stdout.write("%d.%d.%d\n" % tuple(sys.version_info[:3])); sys.exit(0 if sys.version_info >= (3, 12) else 1)'
  if [ -n "$arg" ]; then v=$("$cmd" "$arg" -c "$probe" </dev/null 2>/dev/null); else v=$("$cmd" -c "$probe" </dev/null 2>/dev/null); fi
  rc=$?
  v=$(printf '%s' "$v" | tr -d '\r' | head -n 1)
  if [ "$rc" -eq 0 ] && [ -n "$v" ]; then
    if [ -z "$arg" ]; then printf '%s' "$cmd"; return 0; fi
    exe=$("$cmd" "$arg" -c 'import sys; sys.stdout.write(sys.executable)' </dev/null 2>/dev/null | tr -d '\r')
    if [ -n "$exe" ]; then
      if command -v cygpath >/dev/null 2>&1; then exe=$(cygpath -u "$exe"); fi
      printf '%s' "$exe"; return 0
    fi
    fleet_py_tried="$fleet_py_tried, $label ($where): Python $v, with no sys.executable"; return 1
  fi
  if [ -n "$v" ]; then fleet_py_tried="$fleet_py_tried, $label ($where): Python $v, older than 3.12"
  else fleet_py_tried="$fleet_py_tried, $label ($where): did not run as Python (exit $rc)"; fi
  return 1
}
fleet_python() {
  local c candidates
  fleet_py_tried=""
  if [ -n "${LUDICS_PY_CANDIDATES+set}" ]; then candidates=$LUDICS_PY_CANDIDATES
  else candidates="""
    + '"'
    + "\n".join(PY_CANDIDATES)
    + '"'
    + r"""; fi
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    fleet_py_try "$c" && return 0
  done <<FLEET_PYTHON_CANDIDATES
$candidates
FLEET_PYTHON_CANDIDATES
  if [ -z "${LUDICS_PY_CANDIDATES+set}" ]; then
    case "$(uname -s 2>/dev/null)" in
      MINGW* | MSYS* | CYGWIN*) { """
    + " || ".join(f"fleet_py_try py {a}" for a in PY_LAUNCHER_ARGS)
    + r"""; } && return 0 ;;
    esac
  fi
  printf 'tried %s' "${fleet_py_tried#, }"
  return 1
}
"""
)


# Far-side skill-freshness preflight (ludics-lite#3), after FRESHNESS, ghprobe and FLEET_PYTHON.
# Args: codex probe probe_timeout fetch_timeout cross cross_timeout gh_timeout. Exit 0 with a
# PREFLIGHT OK line, 1 with the refusal. `launch` runs it on the box before every worker, so the
# per-launch refusal the skill promises is enforced here rather than remembered.
PREFLIGHT = r"""codex="$1" probe="$2" probe_timeout="$3" fetch_timeout="$4" cross="$5" cross_timeout="$6" gh_timeout="$7"
refuse=""
note() { refuse="$refuse; $*"; }
# One preflight per box at a time: a parallel group launched together would otherwise race
# `git fetch`/`merge` in the same checkout and refuse on git's own lock files. Idempotent, so
# waiting for the other preflight is the right thing; the bound covers a hung live probe.
# The wait covers everything a holder may legitimately spend: the fetch, the live probe, and one
# cross-box timeout per sibling, since the reach probes run serially under this lock, and every
# bounded gh call: gh's stored token, the probe (3) and the tmux server's probe (3).
nsib=0; for _s in $cross; do nsib=$((nsib + 1)); done
checkout_lock $((fetch_timeout + probe_timeout + 7 * gh_timeout + 90 + cross_timeout * nsib)) "PREFLIGHT REFUSED $BOX"; lrc=$?
if [ "$lrc" -eq 2 ]; then echo "PREFLIGHT REFUSED $BOX: no skills checkout at $repo"; exit 1; fi
[ "$lrc" -eq 0 ] || exit 1
skills_freshness "$fetch_timeout"
if [ $? -eq 2 ]; then echo "PREFLIGHT REFUSED $BOX: no skills checkout at $repo"; exit 1; fi
# Every skill the checkout declares must be one of the symlinks the README installs, into ITS OWN
# directory of THIS checkout - compared as resolved paths, so neither a link through `..` nor two
# links swapped within the checkout can pass. Deriving this set from SKILL.md keeps a new skill
# from falling outside preflight while the README's top-level install glob starts serving it.
canon=$(cd "$repo" && pwd -P)
resolved() { [ -L "$1" ] && (cd -P "$1" 2>/dev/null && pwd -P); }
for skill_dir in "$repo"/*; do
  [ -f "$skill_dir/SKILL.md" ] || continue
  s=${skill_dir##*/}
  t=$(resolved "$HOME/.claude/skills/$s")
  [ "$t" = "$canon/$s" ] || note "~/.claude/skills/$s -> ${t:-missing/not a link} (not $repo/$s)"
done
if [ "$codex" = 1 ] || [ "$codex" = native ]; then
  for s in ship-pr wait-and-proceed after-merge; do
    t=$(resolved "$HOME/.codex/skills/$s")
    [ "$t" = "$canon/$s" ] || note "~/.codex/skills/$s -> ${t:-missing/not a link} (README's Codex loop not run)"
  done
  if [ "$codex" = 1 ]; then
    command -v codex >/dev/null 2>&1 || note "no codex on PATH"
    codex login status >/dev/null 2>&1 || note "codex not logged in"
    # A status read is not a proof either way; only a live headless turn is.
    if [ "$probe" = 1 ] && command -v codex >/dev/null 2>&1; then
      prompt=$(mktemp "${TMPDIR:-/tmp}/fw-prompt.XXXXXX"); printf 'Reply with the single word ok.' > "$prompt"
      out=$(cd / && bounded --stdin "$prompt" "$probe_timeout" codex exec --json --ephemeral --skip-git-repo-check -C / -); prc=$?
      rm -f "$prompt"
      if [ "$prc" -eq 124 ]; then note "codex headless probe timed out after ${probe_timeout}s"
      elif ! printf '%s' "$out" | grep -q '"type":"turn.completed"'; then
        note "codex cannot run headless: $(printf '%s' "$out" | grep -o '"message":"[^"]*"' | head -n1 | cut -c1-120)"
      fi
    fi
  fi
elif [ "$codex" = 0 ]; then
  command -v claude >/dev/null 2>&1 || note "no claude on PATH"
  # `claude auth status` reports loggedIn:true over an expired, unrefreshable OAuth session
  # (observed 2026-09-02 on minix); only a live turn proves the CLI can run headless here. The
  # turn runs in the worker's own mode, the stream-json channel (ludics-lite#259): a CLI that
  # predates those flags is refused here, not discovered as a worker that died at launch. One
  # input line and then EOF: the CLI answers it and exits.
  if [ "$probe" = 1 ] && command -v claude >/dev/null 2>&1; then
    prompt=$(mktemp "${TMPDIR:-/tmp}/fw-prompt.XXXXXX")
    printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word ok."}}' > "$prompt"
    out=$(cd / && bounded --stdin "$prompt" "$probe_timeout" claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --replay-user-messages --no-session-persistence); prc=$?
    rm -f "$prompt"
    if [ "$prc" -eq 124 ]; then note "claude headless probe timed out after ${probe_timeout}s"
    elif ! printf '%s' "$out" | grep -q '"is_error":false'; then
      why=$(printf '%s' "$out" | grep -o '"result":"[^"]*"' | head -n1 | cut -c1-120)
      note "claude cannot run headless: ${why:-$(printf '%s\n' "$out" | head -n1 | cut -c1-120)}"
    fi
  fi
fi
# tmux_ok: a CLI worker launched now would start under tmux in a server whose build variables are
# right (the GitHub probe below then runs as a session of that server too).
tmux_ok=""
case "$codex" in
  native|native-claude) ;;
  *) if ! command -v tmux >/dev/null 2>&1; then note "no tmux"
     elif ! msg=$(tmux_env_check); then note "$msg"
     else tmux_ok=1; fi ;;
esac
command -v jq >/dev/null 2>&1 || note "no jq"
# Every correctness batch on this box runs under `execution slot`, whose N-holder lock is a real
# flock (ludics-lite#160), and since ludics-lite#403 fleet-worker.sh runs it -- and every verb but
# the slot probe -- under scripts/py: the first Python >= 3.12 in its order. So the probe is that
# order (fleet_python, LUDICS_PY_CANDIDATES honoured as there), never a bare python3: a
# non-interactive ssh session on a Mac often has no /opt/homebrew on PATH, and its python3 is
# Xcode's 3.9, which imports fcntl and runs none of it.
if py=$(fleet_python); then
  "$py" -c 'import fcntl' </dev/null >/dev/null 2>&1 || note "$py, the Python >= 3.12 scripts/py would run here, cannot import fcntl (execution slot's run-time lock)"
else
  note "no Python >= 3.12 in scripts/py's order on $BOX ($py): fleet-worker.sh runs under it here, execution slot's run-time lock included -- install one (Homebrew python, the distro python3.12, or uv python install 3.12), or name it in LUDICS_PY_CANDIDATES"
fi
sleep_guard=""
if command -v "${FLEET_SYSTEMD_INHIBIT:-systemd-inhibit}" >/dev/null 2>&1 \
  && ! pkcheck --action-id org.freedesktop.login1.inhibit-block-sleep --process $$ >/dev/null 2>&1; then
  sleep_guard="no polkit grant for the sleep guard (runs unguarded; see issue-wave/references/executions.md#the-os-level-sleep-guard)"
fi
# Cross-box reach (ludics-lite#57): a worker's brief may drive a fleet sibling over ssh for a
# one-off leg, and on 2026-09-04 the first such leg found no credential mid-task. A refused
# credential (permission denied, an unverifiable host key) refuses here; a sibling that does not
# answer at all is asleep or off the network, which the wake path owns, so it is noted on the OK
# line rather than refused - a worker whose task has no leg there must still launch.
cross_down=""
if [ -n "$cross" ] && ! command -v ssh >/dev/null 2>&1; then
  note "no ssh client on $BOX for the cross-box legs (ludics-lite#57)"; cross=""
fi
for sibling in $cross; do
  # Under `bounded`, which gives the probe /dev/null as stdin (the far-side program arrives on
  # stdin through `bash -s`, and an ssh that inherited it would read the rest of this script as
  # its own input, ending it early with status 0 - Codex P1 on #67; `-n` says the same thing to
  # ssh itself) and a whole-process deadline: ConnectTimeout bounds the handshake only, not a
  # login shell that never returns, and this loop holds the preflight lock.
  err=$(bounded "$cross_timeout" ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$sibling" exit 0); crc=$?
  [ "$crc" -eq 0 ] && continue
  if [ "$crc" -eq 124 ]; then cross_down="$cross_down $sibling(no answer in ${cross_timeout}s)"; continue; fi
  case "$err" in
    *"Permission denied"*|*"Host key verification failed"*)
      note "no non-interactive ssh to $sibling from $BOX: $(printf '%s' "$err" | tail -n1 | cut -c1-100) (provision the key, ludics-lite#57)" ;;
    *) cross_down="$cross_down $sibling" ;;
  esac
done
# GitHub credential (ludics-lite#360): a worker on this box pushes and opens its PR with this
# box's `gh` (git's credential helper here too), and on 2026-09-23 a dead keyring token surfaced
# an hour into a worker's task, and another worker routed around it with a copied token. Since
# 2026-09-24 every box uses one PAT, distributed as ~/.config/fleet/gh-token.sh (per-box keyring
# logins revoked each other: GitHub keeps 10 OAuth tokens per user and app). Until ludics-lite#567
# env.sh sourced that file, so every process a session started saw the PAT as GH_TOKEN (dune
# recorded it in its build trace, ahrefs/ocannl#1280); now gh stores it (`gh auth login
# --with-token --insecure-storage`, a 0600 hosts.yml) and the session exports none. So the
# preflight makes the call a worker makes, `gh api user`, from the same kind of session: this
# script runs as a non-interactive `ssh <box> bash -s` (or a local child on the anchor), which is
# NOT the box's desktop console. On 2026-09-24 minix's `gh auth status` was reported green at the
# desktop while its token answered HTTP 401 over non-interactive ssh, and rog's gh 2.46 exited 0
# from `auth status` over "The token in keyring is invalid", so neither a console nor a status
# read is the proof. Classification is a fail-closed allowlist: a login on stdout with exit 0 passes; a
# call with no answer in time, gh's "error connecting to" (DNS, TCP, TLS) or an HTTP 5xx means
# GitHub did not answer, which is noted on the OK line like a sleeping sibling (git fetch above
# already refuses a box that cannot reach GitHub at all); everything else - a 401, gh's "gh auth
# login" hint, any output this list does not name - refuses with the user-side repair.
# The push path and the tmux server too (ludics-lite#374; ghprobe_fn above): git's credential for
# github.com is asked for as a push asks and tried against GitHub, and for a CLI worker the probe
# runs again as a session of the tmux server the worker would start in (the running one, or one
# started from this shell) - only once it passed here, so a failure there is tmux's to repair.
# Boundary: it proves what `gh api --hostname github.com user` answers, and that git gets a
# credential for https://github.com (outside any repository) that GitHub accepts, in this session,
# the session a native worker, a leg and a NEW tmux server get, and in a new session of the running
# tmux server a CLI worker would start in. It does not read what a worker's own tool shell re-sources on top of that, a
# repository's own credential config, a remote over ssh (a box pushing only over ssh is refused
# for a missing helper it does not need), or a token /user does not accept (an app installation
# token; the fleet pushes as the user).
gh_down=""
# The fleet's PAT file (2026-09-24), checked whatever `gh api user` answers, since a live token
# that is not the file's is a per-box credential again: it must be a regular file this user owns,
# mode 0600/0400 (`ls -lnd` reads that alike on GNU and BSD), and the token gh uses must be the
# one it exports (sourced in a subshell only once it passed; no value is printed). Two states
# pass (ludics-lite#567): the session exports no token and gh's stored one is the file's (the
# target), or the session exports the file's token (the earlier state, noted on the OK line,
# since every process the session starts sees it). Each repair replaces the file with a fresh
# regular one, stores its token in gh (on stdin, with both variables unset: gh refuses to log in
# while one is set), or names the startup line to fix.
# Boundary: gh's stored token is read with `gh auth token -h github.com`, gh's own answer to
# which token it would use with no variable set (hosts.yml or keyring alike), and compared with
# the file's; `gh api user` below then proves it live. A token other than the file's, an absent
# one, or a `gh auth token` that fails or does not answer in the bound refuses alike.
tokf="$HOME/.config/fleet/gh-token.sh"; tokbad=""; tokenv=""; tmux_tok=""; qbox=$(printf '%q' "$BOX")
storecmd="(. ~/.config/fleet/gh-token.sh; printenv GH_TOKEN) | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login -h github.com --with-token --insecure-storage"
case "$BOX_IS_LOCAL" in 1) tokcopy="replace it here with a regular 0600 file holding the fleet PAT (export GH_TOKEN=ghp_...)"; storecmd="in a terminal on this box: $storecmd" ;;
  *) tokcopy="replace it from the anchor: ssh $qbox 'f=~/.config/fleet/gh-token.sh; umask 077; cat > \"\$f.new\" && chmod 600 \"\$f.new\" && mv \"\$f.new\" \"\$f\"' < ~/.config/fleet/gh-token.sh"
     storecmd="ssh $qbox '$storecmd'" ;; esac
if [ -e "$tokf" ] || [ -L "$tokf" ]; then
  tokbad=1; tls=$(ls -lnd "$tokf" 2>/dev/null)
  case "$tls" in "-rw------- "*|"-r-------- "*) [ "$(printf '%s' "$tls" | awk '{print $3}')" != "$(id -u)" ] || tokbad="" ;; esac
  if [ -n "$tokbad" ]; then
    # mv replaces only a regular file: onto a directory, or a symlink to one, it moves the new
    # file INTO it. So any path that is not a plain regular file is moved aside first (never
    # deleted: nothing here says its contents are disposable).
    # The operator reads this on the anchor, so a remote box's move runs over ssh as its copy does.
    tokmv="mv ~/.config/fleet/gh-token.sh ~/.config/fleet/gh-token.sh.aside"; [ "$BOX_IS_LOCAL" = 1 ] || tokmv="ssh $qbox '$tokmv'"
    tokfix=$tokcopy; [ -f "$tokf" ] && [ ! -L "$tokf" ] || tokfix="move the path aside first ($tokmv; a symlink moves as the link), then $tokcopy"
    note "~/.config/fleet/gh-token.sh on $BOX is not a regular mode-0600 file this user owns ($(printf '%s' "$tls" | awk '{print $1, "uid", $3}')): the PAT in it may be readable by others -- repair: $tokfix"
  else
    # An empty variable is no token to gh: it falls back to the next, GH_TOKEN then GITHUB_TOKEN
    # then its stored login. And an assignment without `export` never reaches gh, so the file's
    # token is read through the environment (printenv), not as a shell variable.
    ftok=$(unset GH_TOKEN; . "$tokf" >/dev/null 2>&1; printenv GH_TOKEN)
    envv=""; if [ -n "${GH_TOKEN-}" ]; then envv=GH_TOKEN; elif [ -n "${GITHUB_TOKEN-}" ]; then envv=GITHUB_TOKEN; fi
    if [ -z "$ftok" ]; then
      tokbad=1; note "~/.config/fleet/gh-token.sh on $BOX exports no GH_TOKEN -- repair: $tokcopy"
    elif [ -n "$envv" ] && [ "${!envv}" = "$ftok" ]; then
      tokenv=$envv
    elif [ -n "$envv" ]; then
      tokbad=1
      # The anchor's preflight is a child of the invoking shell, which rereads no startup file:
      # there a mismatch is as likely a shell that predates the file's rotation.
      case "$BOX_IS_LOCAL" in
        1) note "this shell's $envv is not the token ~/.config/fleet/gh-token.sh exports -- repair: unset $envv (or open a new shell) and rerun; if a new shell still exports one, a startup line sets it (grep -Hnos -e GH_TOKEN -e GITHUB_TOKEN ~/.zshrc ~/.zprofile ~/.bashrc ~/.profile ~/.bash_profile ~/.config/fleet/env.sh lists the lines without their values)" ;;
        *) note "this session's $envv is not the token ~/.config/fleet/gh-token.sh exports on $BOX: a line of its shell startup sets it -- repair: remove that line (ssh $qbox 'grep -Hnos -e GH_TOKEN -e GITHUB_TOKEN ~/.bashrc ~/.profile ~/.bash_profile ~/.config/fleet/env.sh' lists the lines without their values), then restart any tmux server that inherited it" ;;
      esac
    elif command -v gh >/dev/null 2>&1; then
      # Compared inside the bounded call, whose output reaches a file: only the verdict leaves it,
      # as git_cred keeps git's credential in a variable. gh prints the token to stdout alone.
      gh_stored() { local t; t=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_PROMPT_DISABLED=1 gh auth token -h github.com 2>/dev/null) || t=""
        if [ -z "$t" ]; then echo none; elif [ "$t" = "$ftok" ]; then echo same; else echo other; fi; }
      stok=$(bounded "$gh_timeout" gh_stored) || stok=none
      if [ "$stok" != same ] && [ "$stok" != other ]; then
        tokbad=1; note "this session exports no GitHub token and gh on $BOX answers none stored (gh auth token -h github.com, bounded ${gh_timeout}s) -- repair: store the fleet PAT in gh: $storecmd"
      elif [ "$stok" = other ]; then
        tokbad=1; note "gh's stored token on $BOX is not the PAT in ~/.config/fleet/gh-token.sh (a per-box login) -- repair: store the fleet PAT in gh: $storecmd"
      fi
    fi
  fi
fi
gh_bound=$gh_timeout
case "$BOX_IS_LOCAL" in 1) setupgit="in a terminal on this box: gh auth setup-git" ;; *) setupgit="ssh $qbox 'gh auth setup-git'" ;; esac
gpf=$(mktemp "${TMPDIR:-/tmp}/fw-ghprobe.XXXXXX"); gpd=$(mktemp -d "${TMPDIR:-/tmp}/fw-ghprobe.XXXXXX")
gh_probe_write "$gpf"
bash "$gpf" "$gpd" "$gh_bound" < /dev/null > /dev/null 2>&1
gh_read "$gpd"; rm -rf "$gpd" "$gpf"
case "$ghst" in
  nogh) note "no gh on PATH in a non-interactive session on $BOX (a worker here cannot open its PR)" ;;
  down) gh_down=$ghlast ;;
  refused|none)
    # An exported token outranks the stored login, and `gh auth login` refuses while one is
    # set, so the stored-login repair applies only to a box without the fleet's token file.
    envtok=""; for v in GH_TOKEN GITHUB_TOKEN; do [ -z "${!v+x}" ] || envtok="${envtok:+$envtok and }$v"; done
    if [ -n "$tokbad" ]; then repair="fix the token file first (above), then rerun the preflight"
    elif [ -e "$tokf" ]; then repair="the PAT in ~/.config/fleet/gh-token.sh is dead: $tokcopy; then store it in gh ($storecmd) and restart any tmux server that inherited the old value"
    else
      case "$BOX_IS_LOCAL" in 1) repair="in a terminal on this box: gh auth login -h github.com -p https -w && gh auth setup-git" ;;
        *) repair="ssh -t $qbox 'gh auth login -h github.com -p https -w && gh auth setup-git'" ;; esac
      [ -z "$envtok" ] || repair="remove the $envtok this session exports (it outranks gh's stored login and blocks gh auth login) from $BOX's shell startup, then restart any tmux server that inherited it; for the stored login: $repair"
    fi
    note "GitHub credential refused in a non-interactive session on $BOX (gh api user: $ghlast); a green \`gh auth status\` at the box's desktop console does not prove the token a worker's ssh session reads -- repair: $repair" ;;
esac
case "$ghst:$gitst" in
  ok:ok|down:ok|nogh:*|refused:*|none:*) ;;
  *:down) gh_down="${gh_down:+$gh_down; }checking git's credential: $gitwhy" ;;
  *:rejected) note "GitHub rejects the credential git returns for https://github.com in a non-interactive session on $BOX ($gitwhy) though gh's own token passes, so a worker's push would fail -- repair: $setupgit (it makes gh git's helper for github.com)" ;;
  *:other) note "git's credential for https://github.com is another account's than gh's in a non-interactive session on $BOX ($gitwhy), so a worker would push as one account and open its PR as the other -- repair: $setupgit (it makes gh git's helper for github.com)" ;;
  *) note "git gets no GitHub credential in a non-interactive session on $BOX (git credential fill for https://github.com: $gitwhy), so a worker's push would fail -- repair: $setupgit" ;;
esac
# The tmux server, only once this session's probe proved both halves: a failure there is then the
# server's environment, or its default shell's startup.
if [ -n "$tmux_ok" ] && [ "$ghst" = ok ] && [ "$gitst" = ok ]; then
  tmux_gh_check "$ghlast" || note "$tmux_gh_msg"
  [ -z "$tmux_gh_down" ] || gh_down="${gh_down:+$gh_down; }in a tmux session: $tmux_gh_down"
  # Noted, as this session's own export is: during the rollout a running server still holds the
  # token every session used to export. When this session exports one too, its own note says so.
  [ -z "$tmux_gh_envmsg" ] || [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || tmux_tok="$tmux_gh_envmsg; ludics-lite#567"
fi
if [ -n "$refuse" ]; then
  echo "PREFLIGHT REFUSED $BOX: ${refuse#; }${other:+ (changes outside the served tree, ignored: $other)}"
  exit 1
fi
echo "PREFLIGHT OK $BOX skills=$(echo "$head" | cut -c1-9)${other:+ (changes outside the served tree, ignored: $other)}${cross_down:+ (cross-box unreachable, asleep or off the network:$cross_down)}${gh_down:+ (GitHub unreachable from $BOX: $gh_down)}${tokenv:+ (this session exports the fleet PAT as $tokenv, so every process it starts sees it: store it in gh and drop the export, ludics-lite#567)}${tmux_tok:+ ($tmux_tok)}${sleep_guard:+ ($sleep_guard)}"
"""


# Far-side refresh of a box's skills checkout alone (ludics-lite#362), after FRESHNESS: the
# freshness half of the preflight, for a box the fleet reaches for work without launching a worker
# there. Only `launch` and `preflight` ever fast-forwarded a checkout, so a box that only EXECUTES
# kept a stale one indefinitely (tuf-amd-linux sat at 0f7de3d, without `execution hold`, until a
# hand-run preflight). Arg: the fetch bound, which also bounds the wait for the checkout's lock: a
# holder (a preflight, another refresh) may still fail, so a busy lock is waited out and the
# checkout then checked here, never read as refreshed by someone else (PR #379 review).
# Exit 0 current or fast-forwarded, 1 not refreshed (divergent, fetch failed, lock never free): the
# checkout is reported and left exactly as it is, never reset.
REFRESH = r"""fetch_timeout="$1"
refuse=""
note() { refuse="$refuse; $*"; }
checkout_lock "$fetch_timeout" "REFRESH FAILED $BOX"; lrc=$?
if [ "$lrc" -eq 2 ]; then echo "REFRESH FAILED $BOX: no skills checkout at $repo"; exit 1; fi
[ "$lrc" -eq 0 ] || exit 1
skills_freshness "$fetch_timeout"
if [ $? -eq 2 ]; then echo "REFRESH FAILED $BOX: no skills checkout at $repo"; exit 1; fi
if [ -n "$refuse" ]; then
  echo "REFRESH FAILED $BOX: ${refuse#; } -- left as it is, never reset; repair it by hand, then run fleet-worker.sh preflight $BOX"
  exit 1
fi
if [ "$before" = "$head" ]; then echo "REFRESH OK $BOX skills=$(echo "$head" | cut -c1-9) (already current)"
else echo "REFRESH OK $BOX skills=$(echo "$head" | cut -c1-9) (fast-forwarded from $(echo "$before" | cut -c1-9))"; fi
"""


# `launch --repo`: does the path exist on the box? Arg: the --repo value.
LAUNCH_EXISTS = '[ -e "$(expand_tilde "$1")" ]\n'


# `launch --repo`: fetch before the base is read, and print the immutable commit the worktree will
# start from. Args: repo base fetch_timeout.
LAUNCH_FETCH = r"""repo=$(expand_tilde "$1"); base="$2"; fetch_timeout="$3"
bounded "$fetch_timeout" git -C "$repo" fetch -q origin >/dev/null; frc=$?
[ "$frc" -ne 124 ] || { echo "LAUNCH REFUSED: git fetch in $repo timed out after ${fetch_timeout}s" >&2; exit 1; }
[ "$frc" -eq 0 ] || { echo "LAUNCH REFUSED: fetch failed in $repo" >&2; exit 1; }
git -C "$repo" rev-parse --verify "$base^{commit}"
"""


# `launch`'s far side, after ghprobe. Args: name kind cwd repo branch base sid coord replace stamp
# fetch_timeout bid, then the extra CLI args. The brief was staged beside the record
# ($STATE/incoming/<name>-<stamp>.md) and is moved into place only after the guards pass, so a
# refused launch leaves a finished worker's brief untouched.
LAUNCH = r"""name="$1" kind="$2" cwd="$3" repo="$4" branch="$5" base="$6" sid="$7" coord="$8" replace="$9" stamp="${10}" fetch_timeout="${11}" bid="${12}"; shift 12
d="$WORKERS/$name"; incoming="$STATE/incoming/$name-$stamp.md"
# Until the lock is held nothing here is ours but the staged brief; `fresh` (this launch
# creates the record, so a refusal removes it whole) is decided under the lock.
fresh=0
refuse() { rm -f "$incoming"; if [ "$fresh" = 1 ]; then rm -rf "$d"; fi; echo "LAUNCH REFUSED $BOX/$name: $*"; exit 1; }
# One launch of a name at a time: the guards below and the record writes after them are one
# critical section, held until the tmux session exists (or this launch has refused).
mkdir -p "$STATE/locks"; wlock="$STATE/locks/$name"
msg=$(take_lock "$wlock" 0 "lock") || refuse "another launch or unstick of this name is in progress ($msg)"
archive=""; started=0
on_exit() {
  # Killed anywhere after archiving the old record and before tmux started: put it back; a
  # fresh record that never reached a session is removed, so the name stays launchable. The
  # session itself is the truth: if it exists, nothing is rolled back whatever the flag says.
  if [ "$started" != 1 ] && ! alive "$name"; then
    if [ -n "$archive" ] && [ -d "$archive" ]; then rm -rf "$d"; mv "$archive" "$d" 2>/dev/null
    elif [ "$fresh" = 1 ]; then rm -rf "$d"; fi
  fi
  release_lock "$wlock"; [ -n "${blaunch:-}" ] && release_lock "$blaunch"
}
trap on_exit EXIT; trap 'exit 143' TERM HUP INT
blaunch=""
[ -f "$d/meta" ] || fresh=1
if alive "$name"; then refuse "already running"; fi
if [ -f "$d/meta" ]; then
  # tmux gone is not the CLI gone: a reparented orphan can still write and commit, and
  # --replace must not put a second CLI beside it.
  opat=$(live_pat "$name")
  if pgrep -f -- "$opat" >/dev/null 2>&1; then
    refuse "a CLI from the previous launch is still running ($(pgrep -fl -- "$opat" | head -n 2 | tr '\n' ';')); unstick --kill it, or wait"
  fi
fi
if [ -f "$d/meta" ] && [ "$replace" != 1 ]; then
  if [ -f "$d/exit" ]; then
    refuse "a finished worker's record is here (its stream is close-out evidence); pick a new name, or --replace to archive it"
  fi
  refuse "a previous launch left no exit record (killed?); unstick it, or --replace"
fi
if [ -z "$cwd" ]; then
  repo=$(expand_tilde "$repo")
  cwd="$repo-worktrees/$name"
  if [ ! -d "$cwd" ]; then
    # base is the immutable SHA fetched and confirmed before admission.
    git -C "$repo" worktree add -q "$cwd" -b "$branch" "$base" 2>&1 || refuse "worktree add failed"
  else
    # An existing directory is reused only when it is the worktree the caller described.
    have=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
    [ "$have" = "$branch" ] || refuse "$cwd exists but is on '${have:-no branch}', not $branch; remove it, or pass it explicitly with --cwd"
    common=$(cd "$cwd" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
    want=$(cd "$repo" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
    [ -n "$common" ] && [ "$common" = "$want" ] || refuse "$cwd exists but is not a worktree of $repo (common dir ${common:-unknown}); remove it, or pass it explicitly with --cwd"
    echo "notice: reusing existing worktree $cwd (on $branch)"
  fi
else
  cwd=$(expand_tilde "$cwd")
fi
[ -d "$cwd" ] || refuse "no such directory $cwd"
# One live worker per worktree on this box: two CLIs in one checkout are the two-writer
# condition unstick refuses, under different names. Compared by resolved path, and under a
# box-wide launch lock held from this scan until this record's meta (its ownership claim)
# is written, so two launches under different names cannot both pass the scan.
msg=$(take_lock "$STATE/launch.lock" 120 "launch lock") || refuse "another launch on this box is publishing its record ($msg)"
blaunch="$STATE/launch.lock"   # set only once acquired: on_exit must never release another holder's lock
canon_cwd=$(cd "$cwd" 2>/dev/null && pwd -P); cwd="$canon_cwd"   # the record holds the resolved absolute path
for om in "$WORKERS"/*/meta; do
  [ -f "$om" ] || continue
  oname=$(basename "$(dirname "$om")"); [ "$oname" = "$name" ] && continue
  ocwd=$(sed -n 's/^cwd=//p' "$om" | head -n1); [ -n "$ocwd" ] || continue
  [ "$(cd "$ocwd" 2>/dev/null && pwd -P)" = "$canon_cwd" ] || continue
  running "$oname" && refuse "worktree $cwd is already owned by live worker $oname on this box; wait for it, unstick --kill it, or use another worktree"
done
mkdir -p "$d" 2>/dev/null || refuse "cannot create the worker record at $d (a file in the way, or unwritable)"
if [ -f "$d/meta" ]; then
  # A feeder that outlived its CLI (no tmux, no CLI: both refused above) would follow the archived
  # file forever, out of feeder_of's reach once the record moves: end it first.
  if fpid=$(feeder_of "$name"); then kill "$fpid" 2>/dev/null; fi
  # --replace keeps the previous record whole under $STATE/replaced/ (evidence), and a refusal
  # below puts it back; nothing of it is truncated in place.
  mkdir -p "$STATE/replaced" 2>/dev/null; archive="$STATE/replaced/$name-$stamp"
  if ! mv "$d" "$archive" 2>/dev/null || [ ! -d "$archive" ]; then
    archive=""; refuse "cannot archive the previous record to $STATE/replaced/ (unwritable, or a file in the way); nothing was changed"
  fi
  # From here the old record lives in $archive; any refusal puts it back whole.
  refuse() { rm -f "$incoming"; rm -rf "$d"; mv "$archive" "$d" 2>/dev/null; echo "LAUNCH REFUSED $BOX/$name: $* (previous record restored)"; exit 1; }
  mkdir -p "$d" || refuse "cannot start a fresh record at $d"
fi
# Every record mutation is checked, and the brief is in place before any evidence is truncated.
[ ! -d "$d/brief.md" ] || refuse "cannot install the brief: $d/brief.md is a directory"
mv -f "$incoming" "$d/brief.md" 2>/dev/null && [ -f "$d/brief.md" ] || refuse "cannot install the brief at $d/brief.md"
{ : > "$d/stream.jsonl" && : > "$d/stderr.log" && rm -f "$d/exit" && [ ! -e "$d/exit" ]; } 2>/dev/null ||
  refuse "cannot initialize the worker record under $d"
# The CLI line itself, written to a file tmux runs: nothing from the brief is ever a shell word.
# A claude worker's brief is the first line of its input channel (see the header).
if [ "$kind" = claude ]; then
  line=$(user_line "$d/brief.md" "$bid") && [ -n "$line" ] && printf '%s\n' "$line" > "$d/input.jsonl" 2>/dev/null ||
    refuse "cannot write the brief to the input channel $d/input.jsonl"
  stream_run "$d" "$cwd" 1 --session-id "$sid" "$@" > "$d/run.sh" || refuse "cannot write $d/run.sh"
else
  {
    printf 'cd %q || { echo 97 > %q; exit 97; }\n' "$cwd" "$d/exit"
    printf 'codex exec --json --yolo -C %q -o %q' "$cwd" "$d/last-message.md"
    for a in "$@"; do printf ' %q' "$a"; done
    printf ' - < %q >> %q 2>> %q\n' "$d/brief.md" "$d/stream.jsonl" "$d/stderr.log"
    printf 'echo $? > %q\n' "$d/exit"
  } > "$d/run.sh" || refuse "cannot write $d/run.sh"
fi
{
  echo "kind=$kind"; echo "cwd=$cwd"; echo "box=$(hostname -s)"; echo "coordinator=$coord"
  echo "launched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "resumes=0"; echo "turn_offset=0"
  if [ -n "$sid" ]; then echo "session=$sid"; fi
  # proc_offset: where the current process's events start; input_from: its first input line.
  # awaiting: the uuid of the latest message sent, whose reply attach waits for.
  if [ "$kind" = claude ]; then echo "channel=stream-json"; echo "proc_offset=0"; echo "input_from=1"; echo "awaiting=$bid"; fi
} > "$d/meta" || refuse "cannot write $d/meta"
msg=$(tmux_env_check) || refuse "$msg"   # the preflight's read may be minutes old
tmux_gh_check || refuse "$tmux_gh_msg"   # and so may its GitHub probe of the server
tm new-session -d -s "$(sess "$name")" "bash $(printf '%q' "$d/run.sh")" || refuse "tmux failed"
started=1
# Ownership is now visible as a live session; the box-wide lock can go.
release_lock "$blaunch"; blaunch=""
if [ "$kind" = codex ]; then
  # The thread id is the resume address; it is the first event, but the exec takes a moment. If
  # this connection drops before it is recorded, session_of recovers it from the stream later.
  for i in $(seq 1 60); do
    sid=$(jq -Rr 'fromjson? | select(.type=="thread.started") | .thread_id' "$d/stream.jsonl" 2>/dev/null | head -n1)
    [ -n "$sid" ] && break
    [ -f "$d/exit" ] && break
    sleep 1
  done
  [ -n "$sid" ] && echo "session=$sid" >> "$d/meta"
fi
echo "LAUNCHED $BOX/$name kind=$kind session=${sid:-unknown} cwd=$cwd stream=$d/stream.jsonl${archive:+ replaced=$archive}"
"""


# The verdict of a finished worker, from its files. Prints one line; exit 0 clean, 1 failed,
# 3 no exit record (the session is gone but nothing wrote the code: killed, or never started).
# A claude worker whose process is up and idle (attach's stop condition, see fleet-worker.sh's
# header) gets an IDLE line instead of DONE, or a FAILED line saying `idle` when its turn ended in
# an error; when it is up but no longer idle (a turn started meanwhile) it prints nothing and
# returns 5.
#
# A DONE or IDLE line gains `| PROBABLE STRAND: ...` when the turn's final message announces a
# wait still pending. A one-shot turn's end kills the background tasks it started, so a worker
# that ended on "the watch will wake me" will never be woken (ludics-lite#361); an IDLE worker's
# tasks outlive its turn, but attach reports IDLE only with none listed, so the wait it announces
# is not a background task (a ScheduleWakeup, or nothing). This is a free-text reader,
# and its boundary is a fail-closed allowlist: it reads ONLY the turn's final message (a Claude
# turn's `result`, a Codex turn's last agent message), whole, case-insensitively, for the fixed
# substrings strand_mark lists, and flags on the first one present. It does not read
# earlier messages, the tool calls, or the processes the turn left, so a paraphrase outside the
# list is not flagged, and a phrase quoted or negated ("no watch will wake me") is flagged anyway.
# The mark is a prompt to read the final message, never a verdict: it changes neither the DONE
# nor the exit code.
VERDICT = r"""strand_mark() {
  local text p
  text=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  for p in 'will wake me' 'wakes me' 'wake me up' 'wake me when' 'watch is armed' 'watch armed' \
           'armed the watch' 'armed a watch' 'while the watch runs' 'waiting in the background' \
           'running in the background'; do
    case "$text" in *"$p"*)
      if [ "${2:-}" = idle ]; then
        printf ' | PROBABLE STRAND: the final message says "%s"; no background task of the worker is pending' "$p"
      else
        printf ' | PROBABLE STRAND: the final message says "%s"; a CLI turn'"'"'s background tasks end with it' "$p"
      fi
      return 0 ;;
    esac
  done
}
verdict() {
  local name="$1" d="$WORKERS/$1" kind rc="" summary final idle=0
  kind=$(meta_get "$d" kind)
  if [ ! -f "$d/exit" ]; then
    if alive "$name" && is_stream "$name"; then idle=1
    else
      echo "VANISHED $BOX/$name: no exit record (killed, or the CLI never started; an orphaned CLI ran on past tmux if the stream moved -- see $d/stderr.log)"; return 3
    fi
  fi
  [ "$idle" = 1 ] || rc=$(cat "$d/exit")
  # Only THIS turn's events count: the stream is append-only across resumes, so the verdict
  # reads past the turn_offset the launch/unstick recorded; a turn with no terminal event of
  # its own is not a success whatever the exit code said.
  local off; off=$(meta_get "$d" turn_offset); off=${off:-0}
  # A claude record that names the latest message (meta `awaiting`) counts only what follows the
  # CLI's echo of it, as attach does: a result between the append and the read answers something
  # else, and a message never echoed has had no turn at all.
  if [ "$kind" = claude ] && [ -n "$(awaiting_of "$name")" ]; then
    local at; at=$(tail -n +"$((off + 1))" "$d/stream.jsonl" 2>/dev/null | jq -Rrn --arg u "$(awaiting_of "$name")" \
      'first(foreach inputs as $l (0; . + 1; . as $n | ($l | fromjson? // null) | select(type == "object" and .type == "user" and .uuid == $u) | $n)) // empty' 2>/dev/null)
    if [ -n "$at" ]; then off=$((off + at)); else off=$(grep -c '' "$d/stream.jsonl" 2>/dev/null); off=${off:-0}; fi
  fi
  turn() { tail -n +"$((off + 1))" "$d/stream.jsonl" 2>/dev/null; }
  case "$kind" in
    # A terminal_reason other than `completed` goes among the fields, ahead of the free text: it
    # tells an interrupted turn (`aborted_tools`, unstick --interrupt) from a crash.
    claude) summary=$(turn | jq -Rr 'fromjson? | select(.type=="result") | "\(.subtype) is_error=\(.is_error) turns=\(.num_turns) "
              + (if (.terminal_reason // "completed") != "completed" then "terminal_reason=\(.terminal_reason) " else "" end)
              + ((.result // "")|tostring|.[0:200]|gsub("\n";" "))' 2>/dev/null | tail -n1)
            # From the last result's own field: the summary carries the result text, which can
            # say anything, `is_error=false` included.
            ok_event=$(turn | jq -Rrn '[inputs | fromjson? | select(.type=="result")] | last | if . != null and .is_error == false then 1 else 0 end' 2>/dev/null) ;;
    codex)  summary=$(turn | jq -Rr 'fromjson? | select(.type=="turn.completed" or .type=="turn.failed") | .type + " " + ((.error.message // "")|tostring|.[0:200])' 2>/dev/null | tail -n1)
            ok_event=$(printf '%s' "$summary" | grep -c '^turn.completed')
            last=$(turn | jq -Rr 'fromjson? | select(.type=="item.completed" and .item.type=="agent_message") | .item.text' 2>/dev/null | tail -n1 | cut -c1-200)
            [ -n "$last" ] && summary="$summary | $last" ;;
  esac
  [ -n "$summary" ] || summary="no terminal event in the stream"
  # An ended stream process whose last turn never ended (a turn a ScheduleWakeup or a task began,
  # or tasks still listed) finished nothing, whatever an earlier result said.
  if [ "$idle" = 0 ] && is_stream "$name"; then
    local t bg
    read -r t bg _ <<< "$(turn_state "$name")"
    [ "$t $bg" = "ended 0" ] || { ok_event=0; summary="$summary | the process ended mid-turn (turn=$t, background_tasks=$bg)"; }
  fi
  if [ "$idle" = 1 ]; then
    # Re-read at the moment of the verdict: a turn a ScheduleWakeup (or a task) started since
    # attach saw the worker idle is no IDLE; 5 tells attach to go on waiting.
    case "$(turn_state "$name")" in "ended 0 1") ;; *) return 5 ;; esac
    local next='awaiting input: `unstick --message` continues it, `close` ends it'
    if [ "${ok_event:-0}" -gt 0 ]; then
      final=$(turn | jq -Rrn '[inputs | fromjson? | select(.type=="result") | (.result // "" | tostring)] | last // ""' 2>/dev/null)
      echo "IDLE $BOX/$name $summary | $next$(strand_mark "${final:-}" idle)"; return 0
    fi
    echo "FAILED $BOX/$name idle $summary | $next"; return 1
  fi
  if [ "$rc" = 0 ] && [ "${ok_event:-0}" -gt 0 ]; then
    case "$kind" in
      claude) final=$(turn | jq -Rrn '[inputs | fromjson? | select(.type=="result") | (.result // "" | tostring)] | last // ""' 2>/dev/null) ;;
      codex)  final=$(turn | jq -Rrn '[inputs | fromjson? | select(.type=="item.completed" and .item.type=="agent_message") | (.item.text // "" | tostring)] | last // ""' 2>/dev/null) ;;
    esac
    echo "DONE $BOX/$name exit=0 $summary$(strand_mark "${final:-}")"; return 0
  fi
  echo "FAILED $BOX/$name exit=$rc $summary $(tail -n 2 "$d/stderr.log" 2>/dev/null | tr '\n' ' ' | cut -c1-200)"; return 1
}
"""


# `attach`, after VERDICT: the far side waits; a dropped connection is the near side's to retry.
# Args: name interval.
ATTACH = r"""name="$1" interval="$2"; d="$WORKERS/$name"
[ -f "$d/meta" ] || { echo "UNKNOWN $BOX/$name: never launched here"; exit 3; }
started=$(now); last=$started
while running "$name"; do
  # A claude worker's process outlives its turns: its turn's end is IDLE with the reply to the
  # latest message in the stream (turn_state's `ended 0 1`), checked before each sleep so a
  # worker already idle answers at once.
  if is_stream "$name"; then
    case "$(turn_state "$name")" in "ended 0 1")
      if alive "$name"; then
        v=$(verdict "$name"); vrc=$?
        [ "$vrc" = 5 ] || { printf '%s\n' "$v"; exit "$vrc"; }
      else
        # Its turn is done, but its session is gone: no append reaches it (the append path needs
        # the session), and it would idle on its input forever.
        echo "ORPHANED $BOX/$name: its turn ended but the CLI outlived its tmux session and idles on its input -- read the turn with \`log\`, then \`unstick --kill\` resumes it in a new session"; exit 1
      fi ;;
    esac
  fi
  sleep "$interval"
  t=$(now)
  if [ $((t - last)) -ge 900 ]; then
    echo "still running: $BOX/$name, $(( (t - started) / 60 )) min attached, stream $(( t - $(mtime "$d/stream.jsonl") ))s quiet"
    last=$t
  fi
done
verdict "$name"
"""


# `status`. Arg: name.
STATUS = r"""name="$1"; d="$WORKERS/$name"
[ -f "$d/meta" ] || { echo "UNKNOWN $BOX/$name: never launched here"; exit 3; }
kind=$(meta_get "$d" kind); cwd=$(meta_get "$d" cwd)
state=$(state_of "$name")
quiet=$(( $(now) - $(mtime "$d/stream.jsonl") ))
case "$kind" in
  claude) last=$(tail -n 1 "$d/stream.jsonl" 2>/dev/null | jq -Rr 'fromjson? | .type + (if .type=="assistant" then ":" + ([.message.content[]? | .type] | join(",")) else "" end)' 2>/dev/null) ;;
  codex)  last=$(tail -n 1 "$d/stream.jsonl" 2>/dev/null | jq -Rr 'fromjson? | .type + (if .item then ":" + .item.type else "" end)' 2>/dev/null) ;;
esac
events=$(grep -c . "$d/stream.jsonl" 2>/dev/null); events=${events:-0}
if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  wt="head=$(git -C "$cwd" log -1 --format='%h %cr' 2>/dev/null) dirty=$(git -C "$cwd" status --porcelain 2>/dev/null | grep -c .) branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)"
else
  wt="cwd not a git repo (or gone)"
fi
# A stream worker's turn and input: the turn state and listed background tasks (see turn_state),
# and how many messages the current process has been sent but has not echoed yet.
chan=""
if is_stream "$name"; then
  read -r t bg _ <<< "$(turn_state "$name")"
  seen=$(tail -n +"$(( $(meta_num "$d" proc_offset) + 1 ))" "$d/stream.jsonl" 2>/dev/null | jq -Rr 'fromjson? | select(.type=="user" and .isReplay==true) | .uuid // empty' 2>/dev/null)
  unread=0
  while IFS= read -r u; do
    [ -n "$u" ] || continue
    grep -qxF -- "$u" <<< "$seen" || unread=$((unread + 1))
  done <<< "$(tail -n +"$(meta_num "$d" input_from 1)" "$d/input.jsonl" 2>/dev/null | jq -r '.uuid // empty' 2>/dev/null)"
  chan=" | turn=$t background_tasks=$bg unread=$unread"
fi
echo "$state $BOX/$name kind=$kind session=$(session_of "$d") stream: ${events} events, ${quiet}s quiet, last=${last:-none}$chan | $wt | resumes=$(meta_get "$d" resumes) stderr=$(wc -c < "$d/stderr.log" 2>/dev/null | tr -d ' ')B"
"""


# `log`. Args: name lines.
LOG = r"""name="$1" n="$2"; d="$WORKERS/$name"
[ -f "$d/meta" ] || { echo "UNKNOWN $BOX/$name: never launched here"; exit 3; }
case "$(meta_get "$d" kind)" in
  claude) jq -Rr 'fromjson? | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$d/stream.jsonl" 2>/dev/null | tail -n "$n" ;;
  codex)  jq -Rr 'fromjson? | select(.type=="item.completed" and .item.type=="agent_message") | .item.text' "$d/stream.jsonl" 2>/dev/null | tail -n "$n" ;;
esac
if [ -s "$d/stderr.log" ]; then echo "--- stderr (tail):"; tail -n 5 "$d/stderr.log"; fi
"""


# `log --last-result`. Args: name. The final message of the worker's latest ENDED turn, whole and
# alone on stdout -- what a coordinator parses for EXECUTION_REQUEST / EXECUTION_RESULT and the
# hand-back -- so no stderr tail follows it (`log` without the flag has that). A turn still in
# progress has no final message yet: the one printed is its predecessor's, and `status` says
# whether a turn is running. The rule per kind, over the whole append-only stream:
#   claude: the `.result` of the last `result` event, the event that ends every turn (an error
#           result included: its text is the turn's last word, as attach reports it);
#   codex:  a turn runs from `turn.started` to its `turn.completed` or `turn.failed` (each resume
#           is a new process appending a new turn); the message is the last `agent_message` item
#           inside the last turn that ended. A turn that failed has no final message, nor does a
#           completed one with no agent_message; an unterminated turn (a killed exec) is skipped.
# Anything else is one line, `NO RESULT <box>/<name>: <why>`, exit 1 (UNKNOWN stays exit 3).
LOG_LAST_RESULT = r"""name="$1"; d="$WORKERS/$name"
[ -f "$d/meta" ] || { echo "UNKNOWN $BOX/$name: never launched here"; exit 3; }
kind=$(meta_get "$d" kind)
# Each program ends in {text} or {why}. The stream is read ONCE into that object, and the verdict
# and the text both come from it: a second read could meet a turn that ended in between.
case "$kind" in
  claude) prog='[inputs | fromjson? | select(type == "object" and .type == "result")] | last
    | if . == null then {why: "no result event in the stream: no turn has ended yet"}
      elif (.result | type) == "string" then {text: .result}
      else {why: "the latest turn ended (\(.subtype // "no subtype")) with no result text"} end' ;;
  codex) prog='reduce (inputs | fromjson? | select(type == "object")) as $e ({cur: null, last: null};
      if $e.type == "turn.started" then .cur = null
      elif $e.type == "item.completed" and ($e.item | type) == "object" and $e.item.type == "agent_message" then .cur = ($e.item.text // "" | tostring)
      elif $e.type == "turn.completed" or $e.type == "turn.failed" then .last = {type: $e.type, text: .cur, err: ($e.error.message? // "" | tostring)} | .cur = null
      else . end)
    | .last
    | if . == null then {why: "no turn.completed or turn.failed in the stream: no turn has ended yet"}
      elif .type == "turn.failed" then {why: "the latest turn ended turn.failed: \(.err[0:200] | gsub("\n"; " "))"}
      elif .text == null then {why: "the latest turn completed with no agent_message"}
      else {text: .text} end' ;;
  *) echo "NO RESULT $BOX/$name: unknown worker kind '$kind'"; exit 1 ;;
esac
[ -r "$d/stream.jsonl" ] || { echo "NO RESULT $BOX/$name: no stream yet"; exit 1; }
got=$(jq -Rcn "$prog" "$d/stream.jsonl" 2>&1) || { echo "NO RESULT $BOX/$name: cannot read the stream: $(printf '%s' "$got" | head -n 1)"; exit 1; }
why=$(printf '%s' "$got" | jq -r '.why // empty')
[ -z "$why" ] || { echo "NO RESULT $BOX/$name: $why"; exit 1; }
printf '%s' "$got" | jq -r '.text'
"""


# `unstick`'s far side, after ghprobe. Args: name kill stamp mid dwait rid, then the extra CLI
# args. An empty stamp is a bare --interrupt, with no message staged.
UNSTICK = r"""name="$1" kill="$2" stamp="$3" mid="$4" dwait="$5" rid="$6"; shift 6
# An empty stamp: a bare --interrupt, with no message staged or to place.
d="$WORKERS/$name"; staged=""; [ -z "$stamp" ] || staged="$STATE/incoming/$name-$stamp.md"
unstage() { [ -z "$staged" ] || rm -f "$staged"; }
[ -f "$d/meta" ] || { unstage; echo "UNSTICK REFUSED $BOX/$name: never launched here"; exit 1; }
# Same critical section as launch: liveness checks through tmux creation, one at a time.
mkdir -p "$STATE/locks"; wlock="$STATE/locks/$name"
msg=$(take_lock "$wlock" 0 "lock") || { unstage; echo "UNSTICK REFUSED $BOX/$name: another launch or unstick of this name is in progress ($msg)"; exit 1; }
started=0; blaunch=""; backed=0; ilines=""
# A resume that never started takes its line back off the input channel: the file had $ilines.
input_restore() {
  [ -n "$ilines" ] || return 0
  if [ "$ilines" = 0 ]; then rm -f "$d/input.jsonl"
  else head -n "$ilines" "$d/input.jsonl" > "$d/input.jsonl.new" 2>/dev/null && mv -f "$d/input.jsonl.new" "$d/input.jsonl"; fi
}
on_exit() {
  # Only backups THIS invocation made are ever restored, and only when the session does not
  # exist (the session is the truth); when it does, the backups are stale and are removed
  # so no later refusal can restore them over a completed turn.
  if [ "$backed" = 1 ]; then
    if [ "$started" != 1 ] && ! alive "$name"; then
      [ -e "$d/exit.prev" ] && mv -f "$d/exit.prev" "$d/exit" 2>/dev/null
      [ -e "$d/meta.prev" ] && mv -f "$d/meta.prev" "$d/meta" 2>/dev/null
      input_restore
      unstage
    else
      rm -f "$d/exit.prev" "$d/meta.prev"
    fi
  fi
  release_lock "$wlock"; [ -n "$blaunch" ] && release_lock "$blaunch"
}
trap on_exit EXIT; trap 'exit 143' TERM HUP INT
# The message moves into the record only now, under the lock: a --replace that archived the
# record before we held it cannot have taken it along.
[ -z "$stamp" ] || { mkdir -p "$d/messages" && mv -f "$staged" "$d/messages/$stamp.md" 2>/dev/null && [ -f "$d/messages/$stamp.md" ]; } ||
  { echo "UNSTICK REFUSED $BOX/$name: cannot place the message under $d/messages"; exit 1; }
kind=$(meta_get "$d" kind); cwd=$(meta_get "$d" cwd); sid=$(session_of "$d")
[ -n "$sid" ] || { echo "UNSTICK REFUSED $BOX/$name: no session id in meta or stream"; exit 1; }
[ -d "$cwd" ] || { echo "UNSTICK REFUSED $BOX/$name: recorded working directory $cwd is gone (worktree removed or renamed); nothing was changed"; exit 1; }
# The append path (see the header): a live claude worker whose input channel is up takes the
# message as one more input line -- the same process, so no second writer, no resume and no
# transcript replay, whether it is IDLE or mid-turn. --kill skips it for kill-and-resume.
if [ "$kind" = claude ] && [ "$kill" != 1 ] && alive "$name" && is_stream "$name"; then
  # A running process takes no new flags: extra CLI args are a restart, which is --kill.
  [ "$#" -eq 0 ] || { echo "UNSTICK REFUSED $BOX/$name: extra CLI arguments ($*) cannot reach a live process -- pass --kill to resume the session with them, or drop them to append"; exit 1; }
  feeder_of "$name" >/dev/null || { echo "UNSTICK REFUSED $BOX/$name: the CLI's session is up but its input channel is not (no live feeder on $d/input.jsonl) -- pass --kill to resume the session instead"; exit 1; }
  if [ -n "$stamp" ]; then
    line=$(user_line "$d/messages/$stamp.md" "$mid") && [ -n "$line" ] || { echo "UNSTICK REFUSED $BOX/$name: cannot encode the message as an input line"; exit 1; }
  fi
  # A line appended onto a partial one (a failed earlier append) would reach the CLI as garbage.
  [ ! -s "$d/input.jsonl" ] || [ -z "$(tail -c 1 "$d/input.jsonl")" ] ||
    { echo "UNSTICK REFUSED $BOX/$name: $d/input.jsonl ends in a partial line (an append that failed) -- \`unstick --kill\` resumes the session and drops it"; exit 1; }
  was=$(state_of "$name")
  # --interrupt (see the header): the control request first, and the message only once the CLI's
  # receipt says the interrupt was honoured -- a message ahead of it could join the aborted turn.
  # No receipt, no message: the request stays on the input and acts whenever the CLI reads it.
  if [ -n "$rid" ]; then
    cline=$(jq -cn --arg r "$rid" '{type: "control_request", request_id: $r, request: {subtype: "interrupt"}}' 2>/dev/null) && [ -n "$cline" ] ||
      { echo "UNSTICK REFUSED $BOX/$name: cannot encode the interrupt as an input line"; exit 1; }
    off=$(grep -c '' "$d/stream.jsonl" 2>/dev/null); off=${off:-0}
    trap '' TERM HUP INT
    if ! printf '%s\n' "$cline" >> "$d/input.jsonl" 2>/dev/null; then
      echo "UNSTICK REFUSED $BOX/$name: cannot append the interrupt to $d/input.jsonl (disk full?); it may now end in a partial line -- free space, then \`unstick --kill\` it (the resume drops a partial line)"; exit 1
    fi
    trap 'exit 143' TERM HUP INT
    nomsg=""; [ -z "$stamp" ] || nomsg="; the message was NOT sent (it stays at $d/messages/$stamp.md)"
    waited=0
    while :; do
      receipt=$(tail -n +"$((off + 1))" "$d/stream.jsonl" 2>/dev/null | jq -Rrn --arg r "$rid" '
        first(inputs | fromjson? | select(type == "object" and .type == "control_response" and .response.request_id == $r) | .response
          | if .subtype == "success" then "ok \(.response.still_queued // null | if type == "array" then length else "?" end)"
            else "error \(.error // "no reason given" | tostring | .[0:200] | gsub("\n"; " "))" end) // empty' 2>/dev/null)
      [ -z "$receipt" ] && [ "$waited" -lt "$dwait" ] && alive "$name" || break
      sleep 1; waited=$((waited + 1))
    done
    case "$receipt" in
      "ok "*) ;;
      "error "*) echo "INTERRUPT FAILED $BOX/$name request=$rid: the CLI answered it with an error: ${receipt#error }$nomsg"; exit 1 ;;
      *) if alive "$name"; then
           echo "INTERRUPT UNCONFIRMED $BOX/$name request=$rid: on the input channel, but the CLI sent no receipt within ${dwait}s (a wedged CLI acts on it only if it reads it)$nomsg -- \`unstick --kill\` stops it"
         else
           echo "INTERRUPT UNCONFIRMED $BOX/$name request=$rid: the process ended before answering it$nomsg -- \`attach\` for its verdict, then unstick again to resume"
         fi; exit 1 ;;
    esac
    # still_queued: messages the CLI had read but not yet started (e.g. one appended mid-tool):
    # they survive a plain interrupt and run next, ahead of any message sent now.
    echo "INTERRUPTED $BOX/$name kind=claude session=$sid from=$was request=$rid receipt: still_queued=${receipt#ok }"
    [ -n "$stamp" ] || exit 0
    was=$(state_of "$name")
  fi
  # attach waits for the reply to THIS message: meta names it before the line lands, so a reply
  # that beats the next command is still read as its reply.
  off=$(grep -c '' "$d/stream.jsonl" 2>/dev/null); off=${off:-0}
  # Meta and the input line change together: signals wait until both have (milliseconds), so an
  # interruption never leaves meta naming a message the input never got, nor half a line. Only
  # `awaiting` changes; a writer cut off anyway (SIGKILL) leaves an awaiting awaiting_of ignores.
  trap '' TERM HUP INT
  prev_awaiting=$(meta_get "$d" awaiting)
  meta_set "$d" awaiting "$mid" ||
    { echo "UNSTICK REFUSED $BOX/$name: cannot update $d/meta (disk full?); nothing was changed"; exit 1; }
  if ! printf '%s\n' "$line" >> "$d/input.jsonl" 2>/dev/null; then
    meta_set "$d" awaiting "$prev_awaiting" ||
      echo "UNSTICK: could not put back $d/meta's awaiting=$prev_awaiting (awaiting_of ignores the one it names, which the input lacks)" >&2
    # No truncation: the live feeder may already have forwarded a partial write, and a file
    # truncated under `tail -f` is re-read or skipped by platform. Said, not repaired.
    echo "UNSTICK REFUSED $BOX/$name: cannot append to $d/input.jsonl (disk full?); it may now end in a partial line the CLI has already read -- free space, then \`unstick --kill\` it (the resume drops a partial line) rather than appending again"; exit 1
  fi
  trap 'exit 143' TERM HUP INT
  waited=0
  while :; do
    echoed=$(tail -n +"$((off + 1))" "$d/stream.jsonl" 2>/dev/null | jq -Rrn --arg u "$mid" 'first(inputs | fromjson? | select(.type=="user" and .uuid==$u) | .uuid) // empty' 2>/dev/null)
    [ -z "$echoed" ] && [ "$waited" -lt "$dwait" ] && alive "$name" || break
    sleep 1; waited=$((waited + 1))
  done
  if [ -n "$echoed" ]; then how="delivered (echoed by the CLI)"
  elif alive "$name"; then how="queued: not echoed within ${dwait}s -- the CLI reads it at its next tool or turn boundary, and \`status\` counts it unread until then"
  else
    echo "APPENDED $BOX/$name kind=claude session=$sid to=$was message=$d/messages/$stamp.md uuid=$mid NOT delivered: the process ended before echoing it -- \`attach\` for its verdict, then unstick again to resume"; exit 1
  fi
  echo "APPENDED $BOX/$name kind=claude session=$sid to=$was message=$d/messages/$stamp.md uuid=$mid $how"; exit 0
fi
# An interrupt has no other path: it never falls back to a kill or a resume.
[ -z "$rid" ] || { echo "UNSTICK REFUSED $BOX/$name: --interrupt reaches only a live claude worker on the stream-json channel, and this is kind=$kind, $(state_of "$name")$(is_stream "$name" || echo ', one process per turn') -- nothing was sent; \`unstick --message\` resumes an ended worker, \`--kill\` stops a live one"; exit 1; }
# The same one-live-worker-per-worktree rule as launch, under the same box-wide lock: a
# resume must not start beside another worker that took this worktree meanwhile.
msg=$(take_lock "$STATE/launch.lock" 120 "launch lock") || { echo "UNSTICK REFUSED $BOX/$name: another launch on this box is publishing its record ($msg)"; exit 1; }
blaunch="$STATE/launch.lock"
canon_cwd=$(cd "$cwd" 2>/dev/null && pwd -P)
for om in "$WORKERS"/*/meta; do
  [ -f "$om" ] || continue
  oname=$(basename "$(dirname "$om")"); [ "$oname" = "$name" ] && continue
  ocwd=$(sed -n 's/^cwd=//p' "$om" | head -n1); [ -n "$ocwd" ] || continue
  [ "$(cd "$ocwd" 2>/dev/null && pwd -P)" = "$canon_cwd" ] || continue
  running "$oname" && { echo "UNSTICK REFUSED $BOX/$name: worktree $cwd is now owned by live worker $oname on this box"; exit 1; }
done
grep -q '^session=' "$d/meta" || echo "session=$sid" >> "$d/meta"
# Why this unstick resumes rather than appends, for the RESUMED line.
if [ "$kind" = codex ]; then why="codex: one process per turn"
elif running "$name"; then why="kill-and-resume: --kill stopped the live CLI"
else why="resume: the CLI had ended"; fi
if alive "$name"; then
  if [ "$kill" != 1 ]; then
    echo "UNSTICK REFUSED $BOX/$name: still running -- a resume beside a live exec gives the branch two writers; pass --kill to stop it first"; exit 1
  fi
  tm kill-session -t "=$(sess "$name")"
  for i in $(seq 1 30); do alive "$name" || break; sleep 1; done
fi
# The tmux session is gone; make sure the CLI it ran is too (it could have been reparented).
# A claude worker carries its session id on its command line; a codex worker's first exec
# carries only this worker's state dir (-o), so match either. An orphan is still a live
# writer: it is refused without --kill exactly like a live tmux session.
pat=$(live_pat "$name")
if [ "$kill" != 1 ] && pgrep -f -- "$pat" >/dev/null 2>&1; then
  echo "UNSTICK REFUSED $BOX/$name: tmux is gone but a CLI still runs ($(pgrep -fl -- "$pat" | head -n 2 | tr '\n' ';')); pass --kill to stop it first"; exit 1
fi
# A stream worker's feeder is no CLI and no writer (live_pat never matches it), and its session is
# gone: a feeder that outlived it is ended by its pid file rather than left behind.
if fpid=$(feeder_of "$name"); then kill "$fpid" 2>/dev/null; fi
for i in $(seq 1 30); do
  pgrep -f -- "$pat" >/dev/null 2>&1 || break
  [ "$i" -eq 1 ] && pkill -TERM -f -- "$pat" 2>/dev/null
  sleep 1
done
if pgrep -f -- "$pat" >/dev/null 2>&1; then
  echo "UNSTICK REFUSED $BOX/$name: a process still carries session $sid after TERM: $(pgrep -fl -- "$pat" | head -n 3 | tr '\n' ';')"; exit 1
fi
# A resume creates a session too, with no preflight in front of it.
msg=$(tmux_env_check) || { echo "UNSTICK REFUSED $BOX/$name: $msg"; exit 1; }
tmux_gh_check || { echo "UNSTICK REFUSED $BOX/$name: $tmux_gh_msg"; exit 1; }
# A claude session resumes onto the stream-json channel whatever it ran before (a record from
# before it has no input.jsonl): the new process reads input.jsonl from the first line the old one
# never echoed -- a message still queued when it died -- or else from the message's own line.
if [ "$kind" = claude ]; then
  line=$(user_line "$d/messages/$stamp.md" "$mid") && [ -n "$line" ] || { echo "UNSTICK REFUSED $BOX/$name: cannot encode the message as an input line"; exit 1; }
  # A partial last line (an append that failed) is dropped: no process reads the file now, the
  # message stays under messages/, and the next line must start on a record boundary.
  if [ -s "$d/input.jsonl" ] && [ -n "$(tail -c 1 "$d/input.jsonl")" ]; then
    sed '$d' "$d/input.jsonl" > "$d/input.jsonl.new" 2>/dev/null && mv -f "$d/input.jsonl.new" "$d/input.jsonl" ||
      { rm -f "$d/input.jsonl.new"; echo "UNSTICK REFUSED $BOX/$name: cannot drop the partial last line of $d/input.jsonl (disk full?)"; exit 1; }
  fi
  il=$(grep -c '' "$d/input.jsonl" 2>/dev/null); il=${il:-0}
  if is_stream "$name"; then from=$(first_unread "$name" "$il"); else from=$((il + 1)); fi
  # An interrupt at or past $from was meant for the process that is gone (one the CLI never
  # answered, behind a queued message): the new one would abort the turn it resumes into. Dropped
  # like the partial line; the lines before $from, which no process reads again, stay as the log.
  # Matched by the line's opening, which is the exact shape the interrupt path writes (jq -c keeps
  # key order) and no user line (`{"type":"user"`) can start with.
  if awk -v f="$from" 'NR >= f && /^\{"type":"control_request"/ { x = 1 } END { exit !x }' "$d/input.jsonl" 2>/dev/null; then
    awk -v f="$from" 'NR < f || !/^\{"type":"control_request"/' "$d/input.jsonl" > "$d/input.jsonl.new" 2>/dev/null && mv -f "$d/input.jsonl.new" "$d/input.jsonl" ||
      { rm -f "$d/input.jsonl.new"; echo "UNSTICK REFUSED $BOX/$name: cannot drop the unanswered interrupt from $d/input.jsonl (disk full?)"; exit 1; }
    il=$(grep -c '' "$d/input.jsonl" 2>/dev/null); il=${il:-0}
  fi
  stream_run "$d" "$cwd" "$from" --resume "$sid" "$@" > "$d/run.sh" 2>/dev/null
else
  {
    printf 'cd %q || { echo 97 > %q; exit 97; }\n' "$cwd" "$d/exit"
    printf 'codex exec resume %q --yolo --json' "$sid"
    for a in "$@"; do printf ' %q' "$a"; done
    printf ' - < %q >> %q 2>> %q\n' "$d/messages/$stamp.md" "$d/stream.jsonl" "$d/stderr.log"
    printf 'echo $? > %q\n' "$d/exit"
  } > "$d/run.sh" 2>/dev/null
fi && [ -f "$d/run.sh" ] && [ -s "$d/run.sh" ] || { echo "UNSTICK REFUSED $BOX/$name: cannot write $d/run.sh (a directory in its place, or unwritable)"; exit 1; }
n=$(meta_get "$d" resumes); n=$(( ${n:-0} + 1 ))
# meta is set aside with exit below and restored together with it if tmux refuses.
rm -f "$d/exit.prev" "$d/meta.prev"   # leftovers from an interrupted earlier run are not ours to restore
cp -p "$d/meta" "$d/meta.prev" 2>/dev/null || { echo "UNSTICK REFUSED $BOX/$name: cannot back up $d/meta"; exit 1; }
backed=1
# The verdict of THIS turn must come from events appended after this point, never from the
# previous turn's terminal event: record where the new turn's output starts.
off=$(grep -c '' "$d/stream.jsonl" 2>/dev/null); off=${off:-0}
grep -q '^turn_offset=' "$d/meta" || echo "turn_offset=0" >> "$d/meta"
sed -i.bak "s/^resumes=.*/resumes=$n/; s/^turn_offset=.*/turn_offset=$off/" "$d/meta" 2>/dev/null && rm -f "$d/meta.bak" && grep -q "^resumes=$n\$" "$d/meta" && grep -q "^turn_offset=$off\$" "$d/meta" &&
  { [ "$kind" != claude ] || { meta_set "$d" channel stream-json proc_offset "$off" input_from "$from" awaiting "$mid"; }; } ||
  { mv -f "$d/meta.prev" "$d/meta"; echo "UNSTICK REFUSED $BOX/$name: cannot update $d/meta"; exit 1; }
# The previous terminal state is evidence until the resume has really started: set it aside,
# and put it back (with the previous meta) if tmux refuses.
if [ -e "$d/exit" ]; then mv -f "$d/exit" "$d/exit.prev" 2>/dev/null && [ ! -e "$d/exit" ] || { mv -f "$d/meta.prev" "$d/meta"; echo "UNSTICK REFUSED $BOX/$name: cannot set aside $d/exit"; exit 1; }; fi
# The message is the resumed process's first input line; on_exit takes it back if tmux refuses.
if [ "$kind" = claude ]; then
  ilines=$il
  printf '%s\n' "$line" >> "$d/input.jsonl" 2>/dev/null || { echo "UNSTICK REFUSED $BOX/$name: cannot append to $d/input.jsonl"; exit 1; }
fi
if ! tm new-session -d -s "$(sess "$name")" "bash $(printf '%q' "$d/run.sh")"; then
  [ -e "$d/exit.prev" ] && mv -f "$d/exit.prev" "$d/exit"
  mv -f "$d/meta.prev" "$d/meta"
  echo "UNSTICK REFUSED $BOX/$name: tmux failed (previous exit record and meta kept)"; exit 1
fi
started=1
release_lock "$blaunch"; blaunch=""
rm -f "$d/exit.prev" "$d/meta.prev"
echo "RESUMED $BOX/$name kind=$kind session=$sid resume=$n message=$d/messages/$stamp.md ($why)"
"""


# close: the end of a claude worker's life, after VERDICT. Its process outlives every turn, so
# "finished" is the hand-back turn ended (IDLE) AND the input closed: killing the feeder closes the
# CLI's stdin, the CLI exits, run.sh records `exit`, and the verdict of the last turn is printed as
# attach would (DONE/FAILED, exit 0/1). A worker mid-turn, with background tasks listed, or whose
# latest message has no reply yet (attach's own condition) is refused: close is never an interrupt
# (that is `unstick --kill`). A worker already ended prints its verdict as it stands, so a
# close-out can run close over every worker it finished. Args: name cwait.
CLOSE = r"""name="$1" cwait="$2"; d="$WORKERS/$name"
[ -f "$d/meta" ] || { echo "CLOSE REFUSED $BOX/$name: never launched here"; exit 1; }
mkdir -p "$STATE/locks"; wlock="$STATE/locks/$name"
msg=$(take_lock "$wlock" 0 "lock") || { echo "CLOSE REFUSED $BOX/$name: another launch, unstick or close of this name is in progress ($msg)"; exit 1; }
trap 'release_lock "$wlock"' EXIT; trap 'exit 143' TERM HUP INT
# An ended worker's verdict as it stands -- after ending a feeder that outlived its CLI.
running "$name" || { if fpid=$(feeder_of "$name"); then kill "$fpid" 2>/dev/null; fi; verdict "$name"; exit $?; }
state=$(state_of "$name")
if ! alive "$name" || ! is_stream "$name"; then
  echo "CLOSE REFUSED $BOX/$name: $state, not a stream-json worker with its session up (a one-shot or orphaned CLI ends with its turn) -- wait for it, or \`unstick --kill\`"; exit 1
fi
# The tuple read here decides, never the earlier state: a turn can start in between.
read -r t bg res <<< "$(turn_state "$name")"
[ "$t $bg" = "ended 0" ] || { echo "CLOSE REFUSED $BOX/$name: not idle (turn=$t, background_tasks=$bg) -- wait for attach's IDLE, or \`unstick --kill\` to interrupt"; exit 1; }
# attach's own condition: the latest message sent has had its reply. An appended line not yet
# read would be dropped by closing the input under it.
[ "$res" = 1 ] || { echo "CLOSE REFUSED $BOX/$name: idle, but the latest message sent has no reply yet (unread, or not yet answered) -- wait for attach's IDLE"; exit 1; }
fpid=$(feeder_of "$name") || { echo "CLOSE REFUSED $BOX/$name: no live feeder on $d/input.jsonl, so its input is closed already or was never fed -- \`attach\` waits for the CLI, \`unstick --kill\` ends it"; exit 1; }
kill "$fpid" 2>/dev/null
# The session ends only after run.sh has written `exit`, so the verdict never reads it half-written.
# `running`, not `alive`: a CLI that outlived its tmux session can still write and commit.
waited=0
while running "$name" && [ "$waited" -lt "$cwait" ]; do sleep 1; waited=$((waited + 1)); done
if running "$name"; then echo "CLOSE PENDING $BOX/$name: its input closed ${cwait}s ago and the CLI still runs ($(state_of "$name")) -- \`attach\` waits for its exit"; exit 1; fi
verdict "$name"
"""


# `ls`: the box's worker inventory. No args.
LS = r"""[ -d "$WORKERS" ] || { echo "$BOX: no workers"; exit 0; }
found=0
for d in "$WORKERS"/*/; do
  [ -f "$d/meta" ] || continue
  found=1
  name=$(basename "$d")
  state=$(state_of "$name")
  echo "$BOX/$name $state kind=$(meta_get "$d" kind) launched=$(meta_get "$d" launched_at) by=$(meta_get "$d" coordinator) quiet=$(( $(now) - $(mtime "$d/stream.jsonl") ))s cwd=$(meta_get "$d" cwd)"
done
[ "$found" = 1 ] || echo "$BOX: no workers"
"""
