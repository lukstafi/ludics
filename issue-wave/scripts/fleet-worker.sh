#!/usr/bin/env bash
# The fleet half of the issue-wave skill: one coordinator launches workers onto any box in the
# fleet and supervises them there, with the same commands whether the box is the coordinator's
# own machine or a remote one reached over ssh (ludics-lite#4).
#
# Native workers use runtime subagents (or explicitly chosen app tasks); this script supplies their provider-specific native
# freshness preflight and point-in-time gate. Their board is coordinator-maintained through
# `board` (see references/native-workers.md); ls/status/attach/unstick below only handle CLI workers.
#
# A CLI worker is a detached tmux session on its box running a headless CLI, with its event
# stream on disk under the box's ~/.local/state/issue-wave/workers/<name>/. Everything the
# coordinator needs later is a file there: the JSONL stream, stderr, the exit code, and a meta
# file naming the kind, the cwd and the session id that addresses every intervention.
#
# The two kinds differ in their input channel (ludics-lite#259):
#   - codex: one `codex exec --json` turn per process, brief on stdin; the process ends with the
#     turn, and `unstick` resumes the thread in a new process (kill-and-resume);
#   - claude: ONE long-lived `claude -p --input-format stream-json --output-format stream-json
#     --replay-user-messages` process (meta `channel=stream-json`) whose stdin is fed from the
#     append-only file input.jsonl, one JSON user message per line, the brief first. A `tail -f`
#     feeder (its pid in feeder.pid) pipes that file into the CLI, so stdin stays open between
#     turns; `unstick` appends a line, which the CLI picks up at its next tool
#     or turn boundary (a message sent mid-turn reaches the model mid-turn: Claude Code 2.1.282,
#     probed 2026-09-26), and `close` kills the feeder, the CLI reads EOF and exits, and run.sh
#     writes `exit`. input.jsonl is the durable log of every message (and interrupt) the
#     coordinator sent.
#     `--replay-user-messages` echoes each message into the stream under the uuid it was sent
#     with, which is how `unstick` and `status` prove delivery.
#   A claude worker's states, from its stream past the current process's start (proc_offset):
#     RUNNING  process up, a turn in progress (the last turn event is not a `result`), or the
#              turn ended with background tasks still listed (their completion starts a turn);
#     IDLE     process up, the last turn event is a `result` and no background task is listed:
#              the turn ended and the worker awaits input;
#     EXITED(n), ORPHANED, VANISHED as for codex: the process is gone (after `close`, a crash or
#              a kill), or tmux is gone with a CLI still running, or gone with no exit record.
#   `exit` is still written only when the process ends, so "finished" means the hand-back turn
#   ended AND the coordinator closed the input. `attach` returns on either: an IDLE worker whose
#   latest `result` follows the CLI's echo of the latest message sent (meta `awaiting`) is an
#   IDLE verdict, and an ended process is the DONE/FAILED/VANISHED verdict as before.
#   turn_offset moves only when a process starts (launch, resume): an append names its message
#   in `awaiting` alone, so there is one key to write and nothing to reconcile if it is cut off.
#   One thing IDLE cannot see: a ScheduleWakeup the worker armed is not in the stream, so an IDLE
#   worker can start a turn on its own; the next `attach` or `status` reads it.
#   `unstick --interrupt` (ludics-lite#424) stops the turn in flight, tool call included, through
#   the same channel: it appends the CLI's own control request,
#   {"type":"control_request","request_id":<uuid>,"request":{"subtype":"interrupt"}}, and waits
#   for the `control_response` naming that request_id (the receipt: the CLI read and honoured it;
#   probed on Claude Code 2.1.284, 2026-09-29). The aborted turn ends in a `result` of its own
#   (`error_during_execution`, terminal_reason `aborted_tools`); a message given with it is appended
#   only after the receipt, so it starts the next turn instead of joining the one being aborted. A
#   plain interrupt, not `cancel_queued`: a message queued before it survives (the receipt lists it
#   under `still_queued`) and runs next. Control lines carry no uuid, so every reader of input.jsonl
#   that counts messages by uuid skips them; a resume drops those a new process would read.
#
# Why the shape is what it is, kept in code rather than skill prose:
#   - the worker's process tree hangs off tmux on ITS box, never off the coordinator's ssh or
#     the coordinator's session, so a coordinator pause, restart or dropped connection strands
#     nothing -- `attach` re-arms against the still-running session;
#   - every prompt (brief, unstick message) travels as a FILE, never as command-line text: issue
#     prose is full of backticks and $() that a shell would expand before the model saw them;
#   - supervision reads are the same commands on every box, so "the JSONL stream is quiet AND the
#     worktree is unmoved" (the stall test for workers with no yield signal) does not assume the
#     coordinator can read the worker's disk directly;
#   - the skill-freshness preflight (ludics-lite#3) runs on the box that will run the worker,
#     because that box's ~/.claude/skills symlinks serve whatever its checkout holds;
#   - `unstick` refuses to resume a session whose exec is still alive: a resume beside a live exec
#     gives the branch two writers, and the quiet stream that prompted the unstick does not prove
#     the exec cannot still act. A live claude worker with its input channel up takes the message
#     by append instead, which is the same process and so no second writer; kill-and-resume
#     (`--kill`, or a process already gone) is the fallback for a wedged or exited one, and the
#     output line says which path ran (APPENDED or RESUMED);
#   - fleet-wide state -- the coordinator LEASE and the stop-the-world HALT -- lives on one anchor
#     box (mac-studio, the always-on controller), never on whichever box the coordinator happens
#     to run on: `claim` takes the lease atomically, every `launch` proves it holds it, and `halt`
#     is a file on the anchor the launcher checks, so "one coordinator" and "launch nothing new
#     after an integration regression" are enforced rather than remembered.
#
# Usage:
#   fleet-worker.sh claim [--take]         # take the fleet's coordinator lease (--take adopts)
#   fleet-worker.sh coordinator | release  # who holds it (exit 0 me, 1 other, 3 nobody) / give it up
#   fleet-worker.sh preflight <box> [--codex|--native-codex|--native-claude] [--no-probe] [--no-cross]   # launch runs this itself, too
#   fleet-worker.sh refresh <box> [<box> ...]   # fast-forward each box's skills checkout alone, or
#                          # report why not (never resets); `execution run`/`dispatch` run it
#                          # on the execution host
#   fleet-worker.sh gate --target-repo <owner/repo> [--base-branch <branch>] [--force --allow-red-base <reason>] # lease + halt read before native dispatch (not a reservation)
#   fleet-worker.sh launch <box> <name> --target-repo <owner/repo> --kind claude|codex --brief <file>
#                          (--cwd <dir> | --repo <checkout-dir> --branch <branch> [--base <ref>])
#                          [--base-branch <branch>] [--force --allow-red-base <reason>]
#                          [--replace] [-- <extra CLI args>]
#   fleet-worker.sh attach <box> <name> [--interval <sec>]
#   fleet-worker.sh status <box> <name>
#   fleet-worker.sh log <box> <name> [-n <lines>]   # the tail of every turn's assistant text
#   fleet-worker.sh log <box> <name> --last-result  # the latest ended turn's final message, whole
#                          # and alone (no -n): claude's last `result`, codex's last agent_message
#                          # of its last ended turn; none yet is `NO RESULT <box>/<name>: <why>`, exit 1
#   fleet-worker.sh unstick <box> <name> --message <file> [--kill] [-- <extra CLI args>]
#                          # a live claude worker: append (APPENDED); else kill-and-resume (RESUMED)
#   fleet-worker.sh unstick <box> <name> --interrupt [--message <file>]
#                          # a live claude worker: stop its turn and tool call (INTERRUPTED), then
#                          # append the message, if any, as its next turn; no restart
#   fleet-worker.sh close <box> <name>     # end an IDLE claude worker (close its input), then
#                          # print its final verdict; an ended worker's verdict as it stands
#   fleet-worker.sh ls [<box> ...]
#   fleet-worker.sh load
#   fleet-worker.sh execution list [--active] [--compact] [--host <box>]   # --host: one box's
#                          # records, an alias (rog) selecting its roster entry's (rog-nv-linux)
#   fleet-worker.sh execution slot [--wait <seconds>] [--wait-window[=<seconds>]] [--cpu|--gpu] [--deadline <seconds>]
#                          -- <command...>
#                          # hold one of THIS box's run-time correctness slots around a suite or
#                          # batch (no lease needed), plus a GPU token unless it declares --cpu;
#                          # inside a slot already held (FLEET_SLOT_HELD) it runs under that one;
#                          # --wait-window waits out a measurement on this box (bare: to the
#                          # window's recorded deadline, else 3600 s) instead of refusing, then waits for a slot as --wait says. The batch
#                          # leads a process group of its own, ended (exit 124) at --deadline, and
#                          # when the wrapper is signalled or killed
#   fleet-worker.sh execution slot --bg <parent> [--wait <seconds>] [--wait-window[=<seconds>]] [--cpu|--gpu] -- <command...>
#                          # the same batch detached, for one that can outlast a 600 s tool
#                          # call: prints a bg-run.sh run directory under <parent> at once;
#                          # block on `bg-run.sh wait <dir>`
#   fleet-worker.sh execution slot --probe             # `EXECUTION SLOT PROBE <box> <slots> <gpu
#                          # tokens>` for this box, taking nothing (exit 2: not a fleet host),
#                          # then `measurement <id>` inside a live `execution hold --request <id>`
#   fleet-worker.sh execution slot --holders           # one JSON line per held slot of THIS box:
#                          # slot, kind gpu|cpu, pid, user, command, cwd (Linux, from /proc/locks;
#                          # elsewhere null, each named in `unknown`), and the holder `record`,
#                          # confirmed|unconfirmed|unknown (lock table, /proc fds or lsof), taking
#                          # nothing (lib/ludics/fleetworker/holders.py)
#   fleet-worker.sh execution hold [--why <text>] [--request <id>] [--deadline <seconds>] -- <command...>
#                          # run under THIS box's OS-level sleep guard alone (a systemd-inhibit
#                          # block lock; bare where none): the wrapper for an exclusive
#                          # measurement, and what `slot` runs inside; with --request <id> (the
#                          # measurement's), it first takes every slot of the box (waiting for
#                          # running batches), and an `execution slot` inside it runs under the
#                          # hold instead of refusing; it records the box's GPU co-tenants at
#                          # its start and end, which the measurement's conclusion cites in its
#                          # evidence; --deadline as for `slot`
#   fleet-worker.sh execution leg --request <id> [--box <box>] --rev <sha|branch> --checkout <dir>
#                          --worktree <dir> [--remote <name>] [--control <patch>] [--cpu|--gpu]
#                          [--wait <s>] [--wait-window[=<s>]] [--deadline <s>] -- <runner command...>
#                          # inside that dispatched reservation, on its box: a linked worktree of
#                          # <checkout> made or moved to the exact commit, the runner run there
#                          # under `execution slot` (a measurement: `hold --request`), its status
#                          # returned unchanged; --control: a patch that must then make it fail
#                          # (the contract: lib/ludics/fleetworker/leg.py)
#   fleet-worker.sh execution reserve|dispatch|record|reconcile|conclude <json-file>
#                          # every commit a payload names must exist on GitHub in its repository;
#                          # a "head-of:<branch>" requested_revision is resolved at run/dispatch;
#                          # a reserve/run/window payload's "checkout" (absolute, on the execution
#                          # host; required of a standing one) is the record's, fixed (ludics-lite#731)
#   fleet-worker.sh execution conclude <json-file> --observed-from <checkout>   # observed_sha is
#                          # that checkout's HEAD, read on the execution host; a checkout that is
#                          # not clean draws an OBSERVED-FROM WARNING on stderr (every form); every
#                          # --observed-from must be the record's checkout when it names one, or is refused
#   fleet-worker.sh execution run <json-file>          # reserve + dispatch in one step
#   fleet-worker.sh execution window [--no-gap] [--deadline <seconds>] <box> <json-file> # `run` for a
#                          # measurement that suspends the box's standing reservations, restored
#                          # when it concludes; it first waits out FLEET_WINDOW_GAP after the box's
#                          # last measurement while a batch is waiting for the box (none with
#                          # --no-gap); --deadline: the seconds from its opening by which it will be
#                          # concluded, which a bare --wait-window waits to (ludics-lite#737)
#   fleet-worker.sh execution conclude --from-run <run-dir> --request <id> --sha <sha>
#                          [--box <box>] [--evidence <text>]   # verdict, log and checkout read from a
#                                                     # test-run.sh record on the reserved box
#   fleet-worker.sh execution conclude --from-bg-run <run-dir> --request <id> --sha <sha>
#                          | --observed-from <checkout> [--box <box>] [--checkout <text>] [--evidence <text>]   # verdict and log
#                          # read from a bg-run.sh directory (the mapping: lib/ludics/fleetworker/execution.py)
#   fleet-worker.sh execution conclude --standing-handback --request <id> --observed-from <checkout>
#                          --evidence <text> [--from-run <run-dir>] [--verdict pass|fail|timeout|cancelled]
#                          # a "standing": true reservation only, at its worker's hand-back: observed_sha
#                          # read off the checkout; the verdict the run record's, else --verdict (no
#                          # default); the record's dirty list, launch head and gone worktree go into
#                          # the evidence, not a refusal (executions.md, Standing iteration reservation)
#   fleet-worker.sh execution tip-run <json-file> [--tip <branch>] --checkout <dir> [--id-prefix <prefix>] [--runs <dir>] [--cpu] -- <command...>
#                          # one integration-loop run (ludics-lite#615): yield to anything outstanding
#                          # on the box but standing reservations, `execution run` the request (its
#                          # requested_revision one full SHA, or with --tip the branch's head on
#                          # GitHub now; with --id-prefix its id <prefix>-<n>, the next <n> the
#                          # registry holds none past), check that SHA out detached in the
#                          # clean checkout on the box (a GPU-loop purpose's command must pin its
#                          # backend by .github/fleet-leg there), and start the command there under
#                          # `execution slot --bg <runs> --wait 0` (a GPU token unless --cpu, only
#                          # if one is free now); prints TIP-RUN STARTED <id> <box> <sha> <dir>
#                          # (exit 0) or TIP-RUN NOT STARTED <id>: <why> (exit 1, anything reserved
#                          # concluded not-launched)
#   fleet-worker.sh execution tip-run --wait <id> [--within <s>] [--tip <branch>]
#                          # block on that run (480 s by default) off its record, and conclude it
#                          # --from-bg-run: TIP-RUN CONCLUDED <id> <verdict> <box> <sha> <dir> (exit
#                          # 0; with --tip also TIP-RUN TIP <branch> <sha> moved|current), TIP-RUN
#                          # RUNNING ... (exit 3: re-issue) (lib/ludics/fleetworker/tiprun.py)
#   fleet-worker.sh prs <owner/repo> [--wave <id>] [--flag-at <n>]   # open PRs with review rounds,
#                          # CI state and head age; flags <n> (5) or more rounds, or 3 or more
#                          # after a round 1 of 5 or more inline findings (read-only); --wave
#                          # keeps the PRs that close or reference an issue the wave's records name
#   fleet-worker.sh halt <reason> | resume-launches | halted
#   fleet-worker.sh board set [--create] <wave> <task> <key>=<value>...   # the wave board, one JSON
#                          # document per wave under FLEET_ANCHOR_STATE/boards (ludics-lite#619): a
#                          # task's row, each key set; any text in a value, split at the first `=`
#   fleet-worker.sh board note [--create] <wave> <key>=<value>...   # the wave's own facts
#   fleet-worker.sh board log <wave> <text>...   # one line appended to its log, stamped
#   fleet-worker.sh board show <wave> [--json]   # the markdown view (or the document); no lease
#   fleet-worker.sh board takeover <wave> <task>   # the task's stored brief, then its state at
#                          # takeover from the row's takeover keys and the live sources; no lease;
#                          # exit 3 when the brief cannot be read (lib/ludics/fleetworker/takeover.py)
#                          # (set/note --create starts the board; without it every writer refuses
#                          # an unknown wave; the contract: lib/ludics/fleetworker/boardstore.py)
#
# `launch`, `unstick`, `close`, `halt`, `resume-launches` and the board's writers require the lease;
# `launch` also refuses while halted (`--force` admits the one triage worker) and runs the preflight
# on the box first. Lease, halt and boards live on FLEET_ANCHOR.
#
# <box> is an ssh destination (rog-nv-linux, minix-amd-linux, tuf-amd-linux, macbook-pro), or `local` / this machine's own fleet
# name (detected from the hostname through FLEET_HOSTNAME_MAP; FLEET_LOCAL_BOX overrides) for the
# coordinator's own machine.
#
# Exit: 0 ok | 1 the fact does not hold (refused, worker failed, stale) | 2 usage |
#       3 worker vanished without an exit record | 4 the box never answered.
#
# Env:
#   FLEET_COORDINATOR: lease identity; defaults to inherited CLAUDE_CODE_SESSION_ID or
#     CODEX_THREAD_ID. Required when the harness supplies neither, because nothing is guessed from
#     the process tree.
#   FLEET_LOCAL_BOX: this box's fleet name; otherwise detected from the hostname.
#   FLEET_HOSTNAME_MAP: space-separated `<glob>=<box>` hostname mappings, first match wins; the
#     default is the author's fleet.
#   FLEET_BASE_REF: ref from which `launch` starts a worktree when --base is absent; origin/master.
#   FLEET_ANCHOR: box where lease and halt live; mac-studio.
#   FLEET_ANCHOR_STATE: anchor state dir; defaults to ISSUE_WAVE_STATE.
#   FLEET_LAB_HOST: box that runs wake-lab.sh and the lab's sweep, whose lock directory holds the
#     lab's lane locks; mac-studio. A measurement on a lab box is refused, naming both, unless it is
#     FLEET_ANCHOR (`local` in either reads as FLEET_LOCAL_BOX), since the registry reads the lane
#     lock in the anchor's own lock directory (ludics-lite#454; the header of lib/ludics/fleetworker/registry.py).
#   FLEET_BOXES: whole fleet; "mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux macbook-pro". `ls` sweeps it minus local.
#     One entry per physical box: the registry refuses a reservation under a roster naming two
#     aliases of one box, read from wake-lab.sh's endpoint map (ludics-lite#395; endpoint_map in lib/ludics/fleetworker/execution.py).
#   FLEET_BOX_CORRECTNESS_SLOTS: `<box>=<n>` pairs, how many correctness executions may share a
#     box (ludics-lite#157); an unnamed box has one. "mac-studio=6" whenever the roster is the
#     default one, beside "rog-nv-linux=4 minix-amd-linux=4 tuf-amd-linux=3 macbook-pro=4" in the same
#     value, whether FLEET_BOXES is unset or exports those same boxes (compared as a word set,
#     ludics-lite#329); empty (one slot everywhere) with a custom FLEET_BOXES. Set, even to
#     empty, it overrides the default either way. `preflight` prints the count per roster box.
#     Measurement stays exclusive.
#     Six, not three (ludics-lite#160): three `-j 4` batches ran side by side on the Mac without
#     a stall on 2026-09-15 and the Developer Tools exemption removed the XProtect tax, and the
#     cap exists to bound concurrent load, never to bound how many agents may be in flight.
#     The native GPU boxes' counts were measured with 1-4 concurrent targeted batches, each box
#     under an exclusive reservation (ludics-lite#316 on 2026-09-23, #344 on 2026-09-24), and
#     every batch compiled the tree (dune's cache restored nothing). OCANNL's tools/box-jobs.sh
#     restates each count and injects the width it was measured at (ahrefs/ocannl#1033), so
#     a change here goes there too. minix-amd-linux four, at `-j 4`: 16 hip-width at once was
#     green three ways (four `-j 4` batches, two `-j 8`, a full unit at `-j 16`) and 12 twice,
#     and only dune's default 32 has drained its device-wide SDMA pool. tuf-amd-linux three, at
#     `-j 8`: three `-j 8` hip batches were green on its discrete gfx1102. rog-nv-linux four, of
#     which two may hold its GPU (FLEET_BOX_GPU_TOKENS below): rungs of three or more concurrent
#     `-j 8` cuda batches hit CUDA_ERROR_OUT_OF_MEMORY in 2 of 6 (10 of its 12 GiB in use),
#     while two cuda batches beside one or two cc batches were green, so the bound there is
#     GPU memory and not the box (ludics-lite#391). macbook-pro four, provisionally: the M4 Pro
#     MacBook (ludics#538) has fewer cores than mac-studio's M4 Max, and its count is to be
#     measured there, with a concurrent fresh-binary XProtect probe, before it is relied on.
#   FLEET_BOX_GPU_TOKENS: `<box>=<n>` pairs, how many of a box's correctness slots may run a
#     batch that holds its GPU at once (ludics-lite#391); an unnamed box has as many as it has
#     slots, so the pool binds nowhere else. "rog-nv-linux=2" whenever the roster is the default
#     one; set, even to empty, it overrides that. Fail-closed: every batch takes a token except
#     one that declares `execution slot --cpu`, so a GPU batch whose caller forgot to say so is
#     still counted. `preflight` prints the tokens beside the slots wherever they are fewer.
#   FLEET_SKILLS_REPO: skills checkout on each box; ~/ludics.
#   ISSUE_WAVE_STATE: local worker-state directory; ~/.local/state/issue-wave.
#   FLEET_SLOT_STATE: where `execution slot` keeps a box's run-time slot locks;
#     ~/.local/state/fleet-execution-slots. Deliberately NOT under ISSUE_WAVE_STATE, which is
#     per-coordinator: the cap is the box's, so every agent on the box must resolve this to the
#     same directory (as every coordinator must resolve FLEET_ANCHOR_STATE to the same one).
#   FLEET_SLOT_WINDOW_POLL: how often, in seconds, `execution slot --wait-window` re-reads the
#     registry while a measurement holds the box; 15.
#   FLEET_WINDOW_GAP: the seconds `execution window` leaves between the box's last measurement and
#     the window, so batches waiting out the last one take their slots (ludics-lite#667); 60.
#   FLEET_SLOT_HELD: set BY `execution slot` in its command's environment, never by hand:
#     `<box> <slot> <slots> <gpu|cpu>`, the slot the batch holds (THE NESTED SLOT, below).
#   FLEET_MEASUREMENT_HELD: set BY `execution hold --request <id>` in its command's environment,
#     never by hand: `<box> <id>`, the measurement the run belongs to (THE MEASUREMENT'S OWN RUN).
#   FLEET_REGISTRY_PIN: set BY a coordinator's far side, never by hand, in the environment of a
#     fleet-worker.sh it starts on a box (`execution leg`, `execution tip-run`), beside the
#     coordinator's own roster, anchor, anchor state, lab host, slot and token specs and skills
#     checkout, which that start reads instead of the box's env.sh (ludics-lite#632; the boundary:
#     FORWARDED in lib/ludics/fleetworker/transport.py). Every verb under it refuses (exit 1) when
#     this box resolves another registry than the pinned one.
#   FLEET_SYSTEMD_INHIBIT: the systemd-inhibit that `execution hold` (and so `execution slot`)
#     wraps a run in; systemd-inhibit on PATH. A name that resolves to no executable runs the
#     command bare, as on macOS; the suites pin it to a stub or to nothing, never to the runner's.
#   FLEET_CAFFEINATE: the caffeinate the guard takes instead where FLEET_SYSTEMD_INHIBIT resolves to
#     nothing (macOS, ludics#538); caffeinate on PATH, so a Linux host without systemd runs bare.
#   FLEET_TMUX_SOCKET: tmux -L name; tests isolate with it.
#   FLEET_FLOTILLA: status service; http://mac-studio:7799.
#   FLEET_PRS_LIMIT: how many open PRs `prs` fetches; 1000. A list that reaches it says so.
#   FLEET_LOCK_WAIT: seconds a lease mutation waits for a concurrent one; 10.
#   FLEET_PROBE_TIMEOUT: wall-clock bound on the live headless preflight turn; 120.
#   FLEET_CROSS_TIMEOUT: wall-clock bound on each cross-box ssh reach probe of the preflight; 20.
#   FLEET_FETCH_TIMEOUT: wall-clock bound on skills-checkout and project fetches; 300.
#   FLEET_GH_TIMEOUT: wall-clock bound on each of the GitHub probe's API calls, `gh api user` and
#     the try of the credential git returns (git's helper gets twice that plus 5 s, the try
#     inside it included), in the preflight's session and in a tmux session, and on `execution`'s
#     check that a commit a payload names exists on GitHub; 30.
#   FLEET_REFRESH_TIMEOUT: wall-clock bound on `refresh`'s skills fetch (and so on the refresh
#     after a cross-box `execution run`/`dispatch`); 30.
#   FLEET_DELIVERY_WAIT: seconds an appending `unstick` waits for the CLI to echo the message; 20.
#     Past it the message is reported queued, not lost: a worker inside a long tool call reads it
#     when the call returns. `--interrupt` waits as long for the CLI's receipt of the interrupt.
#   FLEET_CLOSE_WAIT: seconds `close` waits for the CLI to exit after its input closes; 60.
#   FLEET_FEEDER_WAIT: seconds a claude worker's run.sh waits for its input feeder to record its
#     pid before refusing to start the CLI (exit 95); 10. Fixed into run.sh when `launch` or
#     `unstick` writes it, so it is the coordinator's value on every box.

set -uo pipefail

# Bash reads a script by OFFSET while it runs, so a writer that rewrites this file IN PLACE, through
# its own inode (`cp` over it, a shell `>` redirection, `rsync --inplace`, an editor that saves in
# place), resumes a running shell mid-command in whatever text now sits at the offset it left off
# at. `attach`, `watch`, a `launch` waiting on a lock and an `execution` run live for minutes to hours,
# from the checkout that `refresh` and a hub fast-forward update.
# A git fast-forward is not such a writer: checkout unlinks the old file and creates a new one, and
# a running shell keeps reading the old inode (measured for ludics-lite#437). Everything below is
# one brace group, parsed whole before its first command runs, and the closing exit means the shell
# never comes back to the file; the body keeps its own indentation, so the guard is these lines and
# two at the foot. scripts/check-parse-guards.sh holds the shape (ALSO_GUARDED), and
# scripts/test-check-parse-guards.sh rewrites the file in place under a running copy.
{

# EVERY VERB IS SERVED BY PYTHON (ludics-lite#403): lib/ludics/fleetworker, run through scripts/py
# (the first Python >= 3.12) with this script's path as its first argument, so it finds the
# checkout as the CHECKOUT line below does and reads its usage text from the header above. Forwarded
# before any configuration is read here: the Python reads the same environment itself. An
# `execution slot` keeps its pid through every hop (each is an exec), so the pid a caller holds is
# the slot's own wrapper, the parent of the batch, which ends the batch's process group when it is
# signalled (lib/ludics/fleetworker/group.py, ludics-lite#566).
# The caller's PYTHONPATH rides along: scripts/py replaces PYTHONPATH with the checkout's lib/ and
# notes the caller's in LUDICS_CALLER_PYTHONPATH, which the Python puts back before it runs
# anything (ludics.cli), so a batch under `execution slot`/`hold` -- and every far side a verb runs
# on this box -- sees the environment it was given; a wrapper must not change a batch's verdict,
# nor hand it the `ludics` package.
# One exception stays in this shell: `execution slot --probe` is answered below, before any
# interpreter is looked for (THE PROBE WITHOUT PYTHON).
#
# THE PROBE'S WORDS: fw_is_probe is the shell's whole reading of an `execution slot` command line,
# and it only recognizes, never refuses. A clean probe -- `--probe`, and before any `--` nothing but
# the options a probe takes and ignores, each well formed as lib/ludics/fleetworker/slot.py's
# parse_slot takes it -- is answered here. Anything else (an option a probe refuses, --bg or
# --deadline; a malformed value; --cpu with --gpu; a word this list does not know) goes to Python
# whole and unparsed, which refuses it in SLOT_USAGE's own words or runs it, so no usage or refusal
# text of the slot lives in this file to drift from Python's. On a box with no Python >= 3.12 such a
# line gets scripts/py's refusal (exit 2), still no PROBE line. test-fleet-worker.sh (THE PROBE'S
# WORDS there) holds this list to parse_slot: a probe line answers here exactly when Python answers
# it, and with Python's line.
fw_is_probe() {
  local probe="" kind=""
  [ "${1:-}" = execution ] && [ "${2:-}" = slot ] || return 1
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --probe) probe=1 ;;
      --wait)
        case "${2-}" in ''|*[!0-9]*) return 1 ;; esac
        shift ;;
      --wait-window) ;;
      --wait-window=*)
        case "${1#--wait-window=}" in ''|*[!0-9]*) return 1 ;; esac ;;
      --cpu|--gpu)
        [ -z "$kind" ] || [ "$kind" = "$1" ] || return 1
        kind="$1" ;;
      --) break ;;
      *) return 1 ;;
    esac
    shift
  done
  [ -n "$probe" ]
}
die() { echo "fleet-worker.sh: $*" >&2; exit 2; }
CHECKOUT=$(CDPATH='' cd -P "$(dirname "$0")/../.." 2>/dev/null && pwd -P)
if ! fw_is_probe "$@"; then
  # A copy of this file away from its checkout has no package to forward to: said, not left to
  # exec's own error.
  [ -x "$CHECKOUT/scripts/py" ] || die "no $CHECKOUT/scripts/py: run this script from its skills checkout (issue-wave/scripts/ in it)"
  exec "$CHECKOUT/scripts/py" -m ludics.fleetworker "$0" "$@"
fi

# THE PROBE WITHOUT PYTHON: `execution slot --probe`, the forwarder's one exception. A project
# runner asks it before every batch (ahrefs/ocannl#1004), and any answer but the PROBE line tells
# the runner to run WITHOUT a slot (issue-wave/references/executions.md), so a probe that needed
# Python >= 3.12 would turn a box without one into a box whose batches silently skip the run-time
# cap. Answered here in bash, as before the port: no interpreter, no lock, no registry. Only inside
# a live `execution hold --request` (FLEET_MEASUREMENT_HELD set) is Python asked, for the
# measurement it runs -- the marker is judged against the hold's lock, which takes a flock -- and a
# Python that cannot answer reads as no measurement, as a failed python3 always did here. The
# slot count and token count are the spec's own text, as they always were. Anything that is not a
# clean probe (THE PROBE'S WORDS above; `--bg --probe` names a directory) went to Python already.
#
# What the probe reads is the configuration lib/ludics/fleetworker/config.py reads, in the same
# grammar: which box this is (FLEET_LOCAL_BOX, else the hostname through FLEET_HOSTNAME_MAP, first
# matching glob wins), the roster (FLEET_BOXES) and the two `<box>=<n>` specs, whose site defaults
# apply whenever the roster IS the default one, compared as a word set (ludics-lite#329). Every
# word list is read with `read -d ""`, i.e. across ALL its lines.
fw_words() {
  local -a words=()
  read -r -d "" -a words <<< "$1" || :
  [ "${#words[@]}" -gt 0 ] || return 0
  printf '%s\n' "${words[@]}" | LC_ALL=C sort -u | tr '\n' ' '
}
fw_local_box() {
  local host pair
  local -a hostname_pairs=()
  host=$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z')
  read -r -d "" -a hostname_pairs <<< "${FLEET_HOSTNAME_MAP:-*mac-studio*=mac-studio lukaszsacstudio*=mac-studio rog-nv*=rog-nv-linux rog=rog-nv-linux minix*=minix-amd-linux tuf*=tuf-amd-linux *macbook-pro*=macbook-pro}" || :
  for pair in "${hostname_pairs[@]}"; do
    case "$pair" in *=*) ;; *) continue ;; esac
    # shellcheck disable=SC2254  # the glob is the point
    case "$host" in ${pair%%=*}) echo "${pair#*=}"; return ;; esac
  done
  echo ""
}
# fw_spec_count <variable> <spec> <box> <default>: that box's count as the spec spells it (a box the
# spec does not name has <default>), or a refusal line and return 1 for a malformed spec -- the
# registry's grammar, a repeated box keeping its LAST value as the registry's dict does.
fw_spec_count() {
  local name="$1" spec="$2" box="$3" found="$4" pair count entry ok
  local -a pairs=() roster=()
  read -r -d "" -a pairs <<< "$spec" || :
  read -r -d "" -a roster <<< "$BOXES" || :
  for pair in ${pairs[@]+"${pairs[@]}"}; do
    count="${pair#*=}"
    case "$pair" in *=*) ;; *) count="" ;; esac
    case "$count" in ''|*[!0-9]*) echo "$name entry must be <box>=<positive n>: $pair"; return 1 ;; esac
    [ "$count" -ge 1 ] || { echo "$name entry must be <box>=<positive n>: $pair"; return 1; }
    ok=""; for entry in ${roster[@]+"${roster[@]}"}; do [ "$entry" = "${pair%%=*}" ] && ok=1; done
    [ -n "$ok" ] || { echo "$name names ${pair%%=*}, which is not in FLEET_BOXES"; return 1; }
    [ "${pair%%=*}" = "$box" ] && found="$count"
  done
  echo "$found"
}
cmd_execution_slot_probe() {
  local box cap tokens inside="" answer entry ok
  local -a roster=()
  box="${FLEET_LOCAL_BOX-$(fw_local_box)}"
  [ -n "$box" ] || die "execution slot: this host has no fleet name; set FLEET_LOCAL_BOX (the slot is this box's own)"
  ok=""; read -r -d "" -a roster <<< "$BOXES" || :
  for entry in ${roster[@]+"${roster[@]}"}; do [ "$entry" = "$box" ] && ok=1; done
  [ -n "$ok" ] || { echo "EXECUTION SLOT REFUSED $box: not a canonical FLEET_BOXES entry ($BOXES)"; exit 1; }
  cap=$(fw_spec_count FLEET_BOX_CORRECTNESS_SLOTS "$SLOTS" "$box" 1) || { echo "EXECUTION SLOT REFUSED $box: $cap"; exit 1; }
  tokens=$(fw_spec_count FLEET_BOX_GPU_TOKENS "$GPU_TOKENS" "$box" "$cap") || { echo "EXECUTION SLOT REFUSED $box: $tokens"; exit 1; }
  # Where there are as many tokens as slots the tokens cannot bind, and every batch takes any slot.
  [ "$tokens" -lt "$cap" ] || tokens=0
  if [ -n "${FLEET_MEASUREMENT_HELD:-}" ]; then
    answer=$("$CHECKOUT/scripts/py" -m ludics.fleetworker "$0" execution slot --probe 2>/dev/null) || answer=""
    case "$answer" in "EXECUTION SLOT PROBE $box "*" measurement "*) inside="${answer##* measurement }" ;; esac
  fi
  echo "EXECUTION SLOT PROBE $box $cap $([ "$tokens" -eq 0 ] && echo "$cap" || echo "$tokens")${inside:+ measurement $inside}"
  exit 0
}

# The roster and the two specs, as config.py reads them: the site's slot and token defaults apply
# whenever the roster IS the default one, compared as a word set (ludics-lite#329); set, even to
# empty, a spec overrides that. The slot default is read from this line by check-prompts, which
# holds every prompt that states mac-studio's count to it (ludics-lite#160).
DEFAULT_BOXES="mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux macbook-pro"
BOXES="${FLEET_BOXES:-$DEFAULT_BOXES}"
if [ "$(fw_words "$BOXES")" = "$(fw_words "$DEFAULT_BOXES")" ]; then DEFAULT_ROSTER=1; else DEFAULT_ROSTER=0; fi
SLOTS="${FLEET_BOX_CORRECTNESS_SLOTS-$([ "$DEFAULT_ROSTER" = 0 ] || echo mac-studio=6 rog-nv-linux=4 minix-amd-linux=4 tuf-amd-linux=3 macbook-pro=4)}"
GPU_TOKENS="${FLEET_BOX_GPU_TOKENS-$([ "$DEFAULT_ROSTER" = 0 ] || echo rog-nv-linux=2)}"

cmd_execution_slot_probe
exit "$?"
}
