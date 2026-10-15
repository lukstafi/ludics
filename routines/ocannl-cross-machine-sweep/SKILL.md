---
name: ocannl-cross-machine-sweep
description: Daily OCANNL test sweep, one concurrent lane per box - cc/metal locally, cuda on rog-nv, hip/multidev_cc on minix, discrete-memory hip on tuf when it is up
---

Run the OCANNL cross-machine test sweep and report failures, especially what changed since the previous sweep.

GitHub CI covers exactly one backend — `test/config/ocannl_config` pins `backend=cc` and the runners have no GPU. Metal, CUDA,
HIP — and multidev_cc, which needs no hardware but is deliberately kept off CI to keep the per-PR
matrix fast (gh-ocannl-756; the decision is recorded at the runtest step in `.github/workflows/ci.yml`) —
have no automated coverage except this sweep, so this routine is the ONLY gate for all five of
those backends. The sweep places them on three boxes: cc and metal on this Mac (`m4-max`), cuda on
rog, and hip then multidev_cc on minix. Use the destination that `kind_of` selects for each box
(`rog-nv-linux`/`minix-amd-linux` for Linux, or the corresponding `-wsl` alias for WSL). The CPU pair is split across macOS and
Linux on purpose (load balance, and cross-OS coverage of the CPU backends). So minix carries TWO
backends: a minix that stays down leaves both hip and multidev_cc uncovered. Throughout this
routine, "the box's backends" means all of them — rog: cuda; minix: hip AND multidev_cc — and every
outcome step 1 reports BEFORE the sweep (no wake, configured OS unreachable, a failed WSL restart) is reported for each
backend on that box. What happens DURING the sweep is per unit instead: minix runs hip and then
multidev_cc, so an endpoint can vanish after hip recorded a real result; judge each backend by its own row,
and only a unit that recorded `skip (unreachable)` is uncovered. The CUDA and HIP boxes
are often sleeping, and sometimes powered off; step 1 tries to wake them, but if that fails,
"skip (unreachable)" is a normal outcome, not an error.

A fourth box, **tuf** (`tuf-amd-linux`, native Ubuntu only), runs hip AGAIN, and that is the point of
it: its RX 7700S (gfx1102) is the fleet's one DISCRETE-memory AMD GPU, where a missing or misplaced
host↔device transfer reads stale memory, while minix's gfx1151 is an iGPU whose device memory is
host memory and can read the right bytes anyway (ludics-lite#320, gh-ocannl-1035). tuf is a
laptop whose NICs cannot wake it (cabled since 2026-10-12, but neither wired NIC wakes it), so
Wake-on-LAN cannot reach it and this routine never wakes it: its own RTC timer does, a
few minutes before this routine fires (a `WakeSystem=true` systemd timer, the optional laptop step
of the Linux bootstrap, `scripts/install-linux.sh`), or a person does. Its lane is therefore **gated**: the sweep asks
`wake-lab.sh status tuf` itself, runs the unit only when that reaches tuf's Linux, and otherwise
records the unit as `gate` — nothing tested, nothing failed, and nothing for this routine to repair.
When the lane did reach tuf it ends by putting the box back to sleep (`wake-lab.sh sleep tuf`, which
is inhibitor-aware), so a timer-woken laptop does not stay up all day. tuf is NOT one of the five
backends' gates: hip's gate stays minix, and tuf/hip is an additional unit reported on its own line.

**TEMPORARILY, that sleep is disabled** (2026-09-26): once asleep, tuf stays down until a person
wakes it, since no magic packet wakes it. Step 2 hands the sweep a `wake-lab.sh` wrapper
that refuses `sleep tuf`, so the lane's line reads `tuf: left awake, not a failure -- REFUSED:
tuf kept awake …`. That is expected, not a finding. Remove the wrapper once tuf has a
Wake-on-LAN path that a wake test has confirmed.

CI's Windows OS target is likewise off the per-PR path: it runs only on the
twice-weekly scheduled CI sweep, and on demand via `workflow_dispatch`, because at 62-74min it
set the latency of the whole per-PR matrix.

## 0. Check you are running the current prompt

Before waking anything, run the drift check in the ludics-lite checkout, which is where this prompt is canonical:

    git -C ~/ludics-lite fetch --quiet origin \
      && git -C ~/ludics-lite rev-parse --abbrev-ref HEAD \
      && git -C ~/ludics-lite rev-list --left-right --count HEAD...origin/main \
      && git -C ~/ludics-lite status --porcelain -- routines scripts/sync-routines.sh
    ~/ludics-lite/scripts/sync-routines.sh

`scripts/sync-routines.sh` with no argument is status mode: one line per local scheduled task, and exit 1 on any drift. Read your own line. `ocannl-cross-machine-sweep: DRIFT` means the prompt the scheduler dispatched — the one you are reading now — is not the one the checkout holds, so the steps below may be a superseded revision; the diff it prints says in what, though not which side is the newer one — its orientation is argument order, and step 6 says how to read that from provenance instead. It is not hypothetical: on 2026-09-17 the installed copy was found nineteen lines of superseded prose behind, still telling the run to wake the lab without `--hold`, and it had been that way for about a week (ludics-lite#199).

Status mode compares the installed copies with THIS checkout, not with `origin/main`, so a checkout behind the remote reports `in sync` while the installed prompt is older than what merged. `rev-list --left-right --count HEAD...origin/main` prints `<ahead> <behind>`. **Canonical**, once, since everything below turns on it: the checkout is canonical when the branch is `main`, the counts are `0 0`, and the `status --porcelain` line printed NOTHING. Only then does it hold exactly what merged, and only then may anyone install from it. A nonzero BEHIND means it is missing prompts that merged. A nonzero AHEAD, any other branch, or a dirty `routines/` or `scripts/sync-routines.sh` means it carries text that has not been through review — the script is in the pathspec because the next command RUNS it, and a local edit to its routine list, its destination or its publishing logic installs a state nobody reviewed — and `sync-routines.sh` compares the working tree, so uncommitted text reads as the checkout being newer and would be published as-is. Installing from a non-canonical checkout is a worse failure than the drift it would be fixing: the scheduler would then be running something nobody reviewed. Against `origin/main` by name, not `git status -sb`: the checkout may be on a topic branch or one with no upstream, whose tracking state says nothing about `main`. The `&&` is deliberate too — a failed fetch (auth, DNS, network) prints no counts at all, and that absence is the answer: the remote comparison is UNKNOWN, not clean, because stale remote-tracking refs would show a checkout matching the installed copies as up to date. Report the fetch failure in its place.

Carry on with the sweep either way — a drifted prompt still runs a useful sweep, and the coverage window is the thing that must not be missed — but report the finding in step 5 and notify on it in step 6. Do NOT run `sync-routines.sh push` and do not edit the installed copy: those are live scheduler state, and re-installing a prompt is a person's call made after reading the diff. Where the two disagree about a step below, this prompt is what the scheduler gave you; say so and follow it.

## 1. Wake the GPU boxes

Read the execution registry first: `~/ludics-lite/issue-wave/scripts/fleet-worker.sh execution list
--active --compact`. A box that an outstanding `measurement` reservation names, on any of its
endpoints (its row of `~/bin/wake-lab.sh endpoint-map`), is someone's exclusive timing run: leave
it out of this step entirely — drop it from the `for box in rog minix` loop, and from the checkout
refresh below, so it is neither woken, restarted, held nor fetched on —
and report it as measured. The sweep's own per-unit check then skips its units. `--restart-wsl` in
particular destroys a guest host-globally, and a measurement holds no lab lock; wake-lab.sh now
refuses a measured box itself (ludics-lite#445), but that refusal would read as a failed wake, so
leave the box out rather than lean on it. If the registry or the map cannot be read, say so in the report and
treat a WSL box as measured unless you can tell otherwise (a skipped box costs a day's coverage; a
restarted one costs the measurement). A WSL box left out here is not held, so if its measurement
concludes before the sweep reaches its units they run in an unheld guest and may end `skip
(unreachable)`: report those as the measured box, not as a failed wake, and do not rerun for them.

Read the site file's `kind_of` for each GPU box, then wake each kind through its own path:

    . ~/.config/wake-lab/hosts.sh
    linux_boxes=(); wsl_boxes=()
    for box in rog minix; do
      case "$(kind_of "$box")" in
        linux) linux_boxes+=("$box") ;;
        wsl) wsl_boxes+=("$box") ;;
        *) echo "unknown kind for $box" >&2; exit 1 ;;
      esac
    done
    [ ${#linux_boxes[@]} -eq 0 ] || ~/bin/wake-lab.sh --wait "${linux_boxes[@]}"
    held_file=$(mktemp "${TMPDIR:-/tmp}/ocannl-held-wsl.XXXXXX")
    if [ ${#wsl_boxes[@]} -gt 0 ]; then
      wsl_out=$(~/bin/wake-lab.sh --wait --restart-wsl --hold "${wsl_boxes[@]}" 2>&1)
      printf '%s\n' "$wsl_out"
      for box in "${wsl_boxes[@]}"; do
        grep -Fq "wsl holder observed on $box (" <<<"$wsl_out" && printf '%s\n' "$box" >>"$held_file"
      done
    fi
    printf 'holder list: %s\n' "$held_file"
    ~/bin/wake-lab.sh status rog minix tuf

tuf appears in `status` only, never in the wake commands: it has no Wake-on-LAN (a wake sent to it is
refused as `no wired NIC`), and it is woken by its own RTC timer or by hand. Read its `os=`/`linux=`
fields for the report — `linux=UP` means today's run will cover discrete-memory hip; anything else
means its unit will record `gate`, which is not a failure and needs nothing from you — and do not
`--hold` it (it is native Linux). `sleep-blocks=N` on tuf, as on any native box, counts other
sessions' sleep inhibitors: the sweep's own units hold one each while they run.

Then refresh the skills checkout on each GPU box (ludics-lite#362), at the endpoint `kind_of`
selects, since that is the system the lanes run on (`ENDPOINT_MAP` in `wake-lab.sh` names them). A
box the fleet only executes on never hosts a worker launch, the one other place its
`~/ludics-lite` is fast-forwarded, so this daily wake is where it is kept current (tuf was found
without `execution hold`):

    refresh_targets=()
    for box in rog minix tuf; do
      case "$box" in rog) stem=rog-nv ;; minix) stem=minix-amd ;; tuf) stem=tuf-amd ;; esac
      refresh_targets+=("$stem-$(kind_of "$box")")
    done
    ~/ludics-lite/issue-wave/scripts/fleet-worker.sh refresh "${refresh_targets[@]}"

One line per box, and its exit status does not change anything below. `REFRESH OK` (already current,
or fast-forwarded) needs nothing.
`REFRESH UNREACHABLE` is a box `status` already shows down or booted into Windows. `REFRESH FAILED`
is a finding for step 5, quoted: the checkout is divergent (a local change, another branch, an
unpushed commit) or could not fetch, and it is left exactly as it is. Never reset it from here: a
divergent local edit may be a fix worth keeping.

The native Linux path waits for sshd after boot and needs no holder. For WSL, the wake path
restarts the guest on each host that answered and establishes a Windows-side holder before
declaring it ready. A partial wake is handled per box. Read `status`'s `os=` field: a dual-boot
box can boot a different OS from the one the site file expected. Do not sweep a box whose
configured OS did not answer. The WSL-specific holder and restart diagnostics below apply only
to the boxes in `wsl_boxes`.

`--hold` also takes that box's **hold lock** (one of the two interlocks `--restart-wsl` consults)
and leaves it with the holder, so while a box is held another session's `restart-wsl` is REFUSED —
naming this holder — instead of destroying the VM under it with a host-global `wsl.exe --shutdown`.
`unhold` releases the lock along with the holder. That is the other half of the 2026-09-16 story:
one loss was the update restart, the other was a second session restarting WSL under a running
unit.

There are two locks per box and this run takes one of each, at different times, which is what lets
step 1 and step 2 belong to the same session:

- `<box>.hold.lock`, the **hold lock** — "this box's VM must not be destroyed". Step 1's `--hold`
  takes it, the Windows-side holder carries it, and `unhold` in step 2 releases it.
- `<box>.lock`, the **lane lock** — "no other lane runs on this box". The sweep takes it in step 2,
  per box, for the length of that box's lane, and the hold deliberately does not touch it.

`restart-wsl` and the power verbs take both and refuse the box if either is held. Do not expect
step 1's hold to keep the sweep out of its own boxes: before 2026-09-18 it did exactly that — one
file said both things, so every remote lane waited out its five-minute lock budget against this
routine's own holder and skipped, and three of the five backends this routine gates got no
coverage at all that day (ludics-lite#224). If you ever see `skip (box <box> reserved by wake-lab
--hold ...)`, that regression is back: report it as the finding, because it means the run held the
boxes against itself.

`--hold` is what keeps each GPU lane's VM alive for the whole lane. A WSL VM is held up by a
`wsl.exe` process on the WINDOWS side and by nothing else; the sweep's ssh sessions inside the
guest do not hold it, and the owner's console shell — the process that usually does — is removed by
a Windows Update restart. `--hold` spawns `wsl.exe -d Ubuntu -e sh -s <token>` on each box's
Windows side — a shell reading its commands off the ssh channel — reports it, and declares the VM
up only once that holder has said its token back from inside the guest. It is never sized with a
fixed `sleep N`: a lane is hip then multidev_cc, each with its own cap, plus preparation outside
them, so a sized holder expires under the last unit, and a shell waiting for input cannot expire
at all. **You must end it
explicitly** once the sweep has finished (step 2), for every box in this run's holder list.

Keep the `holder list:` path printed in step 1 for both cleanup sites in step 2. It contains only
boxes whose holder acknowledged its token in this run, including partial WSL wakes. The record
is per box and global to the machine, so `unhold` on a box you did not hold
would release whatever holder is there, and if another run put it there you would unhold its lane.
Run cleanup even when the sweep failed; an empty holder list needs no `unhold` call. But
`ANOMALY: wsl holder on <box> had already exited`, with **exit 2**, is the
opposite of a clean cleanup: nothing but `unhold` ENDS a holder deliberately, so one already gone is
one the lane LOST — the box slept or rebooted under it, the network dropped, something killed it. What that costs is the **lab lock**, which lives on the holder's
descriptor and was released the moment it died — from then on the box was not reserved, and another
session's `restart-wsl` was free to shut its VM down mid-unit, the 2026-09-16 failure the interlock
exists to prevent. The VM itself usually survives, because a dying holder orphans its `wsl.exe` on
the Windows side instead of taking it down. That orphan is no longer unowned: the holder carries a
token, so this same `unhold` asks the VM whether that guest shell is still there and ends it by pid
if it is, and its output says which happened. Read those lines before reaching for anything else —
`restart-wsl` is host-global and destroys every other session on the box, so it is for an orphan
the release reported it could NOT end (exit 3), never for one it has already cleaned up. Treat it as a failed lane for that box: report it, quote the line
(it carries the pid and how long the holder lived), and do not call the run clean on the strength of
green units. Note the interlock only covers wake-lab's own `sleep`/`down` verbs, which are refused
while a box is held — a box slept by hand or from Windows takes its holder with it and nothing
refuses anything. That is what happened on 2026-09-18: both boxes were slept at 11:33 with a hold
still outstanding, and the only thing that ever reported it was this line, calling it a release.

**An `unhold` that does not come back is the run's most urgent item.** It is a cleanup step, so it
reads as something to fire and forget, and it is not: the boxes stay held and their lab locks stay
taken until it returns. On 2026-09-18 this `unhold` was issued at 07:39 and did not return until
**11:39** — two earlier attempts were refused by the permission classifier and the third sat four
hours waiting for an approval. Nothing else in the run was blocked, so nothing looked wrong, and
both boxes stayed held and locked through the whole morning. It also corrupts the record afterwards:
the holders were lost at 11:33 when the boxes were slept, but the report of that loss carries the
timestamp of the stalled command, so a later reading puts the death minutes after the spawn instead
of four hours after it. If an `unhold` is denied or does not return, say so in the run's report and
chase it — do not treat a missing result as a completed cleanup.

`wsl HOLD FAILED on: <box>` in the last lines means the VM started but nothing on
the Windows side holds it, and the line says which of two situations that is:

- `...so it was shut down again: those units record no coverage` — the VM this command created is
  gone, you need do nothing by hand, and that box's units will record `skip (unreachable)`. Report
  its backends as untestable today, the same as `wsl still down` below.
- `...the VM is up and UNHELD and was not shut down: do not sweep that box` — the guest is still
  reachable, so the lanes WILL run its units and those units can die mid-run. This is the shape the
  recovery rerun below can produce. Do not launch the sweep for that box: report its backends as
  untestable, and say in the report that an unheld guest was left running.

It always terminates. Every remote command it issues runs under a wall-clock cap, and the boxes
are restarted concurrently, so it cannot sit on a wedged `wsl.exe` the way it did on 2026-09-16 —
2h40m in one start probe, which hung this sweep behind it and cost the second box its restart
entirely. If it has not returned in about a quarter of an hour, that is a bug in the script and
not a slow box.

Read its last lines. Interpret WSL lines only for boxes in `wsl_boxes`; for Linux boxes use
`os=` and `linux=` from `status` to tell whether the native system answered:

- `did NOT wake: <box>` is **not** an error: that box's backends (rog: cuda; minix: hip and
  multidev_cc) simply go uncovered today, surfacing through the staleness thresholds in step 4. Do not send the wake command again.
- `wsl still down after 3 min` on a WSL box that woke means the machine is up but that box's backends (minix: both) are
  untestable — say so explicitly in the report, since it is a different finding from a box that
  never woke.
- `no host table at ~/.config/wake-lab/hosts.sh`: nothing was woken and nothing will be. That
  file is this box's untracked site configuration for the script (the top-level README of
  ludics-lite says how to install it); report the missing setup as the finding rather than the
  boxes as unreachable.
- `all up`, `wsl up` and `wsl holder observed on <box>` for a WSL box: start the sweep promptly. A VM kicked on a
  cold-booted box does not stay up on its own, and a session inside it does not hold it — the
  holder `--hold` spawned does, until you `unhold`.
- `ACTIVE HOURS WARNING on <box>`: the box's Windows Update active hours do not cover the sweep
  window, so an update restart can take the VM, its holder and the unit with it mid-run (that is
  how the 2026-09-15 sweep lost hip twice). Both boxes pin `ActiveHoursStart=6`, `ActiveHoursEnd=0`
  with `SmartActiveHoursState=0` under `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings`; a
  feature update can reset that, and the warning is the only notice. Sweep anyway — it is a
  warning, not a refusal — and report it in step 5 as a risk to tomorrow's run, with a task chip to
  re-pin the values on that box.
- `--restart-wsl` rather than `--wsl`: it is harmless (on a cold-booted box the shutdown is a
  no-op) and it keeps the daily GPU units on a VM of known age. Do NOT read it as protection
  against the dxg `vmbus_sendpacket failed: fffffff5` refusals: ludics-lite#60 read those as a VM
  kept alive across host resumes, and on 2026-09-15 three FRESH VMs overflowed the same way at
  dune's default width while the same VMs were clean at `-j 2`. Concurrency decides that class,
  and OCANNL's `unit_jobs` cap (`minix:hip -> 2`) is the fix that holds.
  `wsl restart FAILED on: <box>` in the last lines means no fresh VM there — the line says
  whether the shutdown was refused (a `-wsl` that still answers is the old VM) or the start
  failed after it (no VM at all) — so that box's backends (minix: hip and multidev_cc both) are untestable today: report it as such rather
  than sweeping it. Each such line names only the boxes it applies to.
- `wsl restart REFUSED on: <box>` is a different line and a different situation: **another tool is
  using that box right now**, and the refusal names it. `wsl.exe --shutdown` is host-global, so
  restarting a box mid-sweep destroys the VM under whatever is running there — on 2026-09-16 that
  cost this sweep both GPU units, and the failure was read as a GPU fault for two days. Almost
  always the holder is another sweep that has not finished, or a `--hold` holder another session
  left behind. Wait for it and run the wake command again; do **not** reach for `--force`, which
  takes the box anyway and is there for a holder that has demonstrably gone (a crashed run whose
  ssh is still orphaned), not for one you are impatient with. If you wait, say in the report that
  the run started late and why. One holder it can never name is this run's own: the command that
  prints this line is the one that would have taken the locks, and it took none.

`~/bin/wake-lab.sh status` prints the per-box picture (router-active, reached OS, native Linux,
`-lan`, `-win`, `-wsl`) if you need to
say precisely what happened.

The sweep takes each GPU box's lane lock for the length of that box's lane, and `wake-lab.sh`
refuses to destroy a box either of whose locks is held, so the 2026-09-16 collision cannot repeat
silently. Two consequences to know. A unit recorded as `skip (box <box> reserved by ...)` is a box
ANOTHER run's lane held for longer than the sweep was willing to wait: nothing was tested and
nothing failed, so report it the way `skip (unreachable)` is reported, naming the holder. (A
holder line reading `wake-lab --hold` there is the regression above, not another run.) A unit
recorded as `skip (box <box> under an exclusive measurement: <request_id> (<state> on <host>))` is
a box the fleet's execution registry has under an outstanding `measurement` reservation: before
each unit the lane asks `fleet-worker.sh execution list --active --compact`, and it defers rather
than contaminate someone's timings (ahrefs/ocannl#1097). Report it like the lock skip, naming the
request id, and do not wake, kick or rerun for it: the box is busy on purpose. Correctness
reservations never cause it. The header's `reservations:` line says whether the registry was
consulted; `NOT CONSULTED` on this Mac means no fleet-worker.sh answered its probe, which is a
setup finding for step 5, and a unit line `WARNING -- the fleet's execution registry could not be
read` means that unit ran without the check. The header's `lab locks:` line, present whenever a
remote unit is selected, is the startup check that the sweep and `wake-lab.sh` still agree on the
lane-lock contract (ahrefs/ocannl#1025): `agree with ...` is its only verdict and needs nothing.
There is no unchecked state (staging#888): a contract or endpoint map the sweep cannot read refuses
the run at startup with exit 2 and a `sweep:` line, which step 2 says how to read. And a dxg
window whose verdict is
`vm-replaced` means the guest was destroyed and recreated while that unit ran — the unit's result
says nothing about the code, it gets the serial rerun automatically, and the thing to investigate
is who restarted the box, not the backend.

For WSL boxes, the retry budget is exactly one re-kick and one rerun. If the sweep records cuda,
hip or multidev_cc as `skip (unreachable)` while `status` shows that box `win=UP`, the VM was up and vanished: run
`~/bin/wake-lab.sh kick-wsl --hold <box>` once — **with `--hold`**, or the rerun runs an unheld VM
the way the 2026-09-15 recovery rerun did, and it died 76 s in — then rerun the sweep once (reruns
are incremental and cheap) and `~/bin/wake-lab.sh unhold <box>` when it finishes. The re-kick takes
only that box's hold lock, so the rerun's own lane still reserves the box normally; before
ludics-lite#224 this recovery reproduced the skip exactly, taking the same lock the lane then
waited on, which is why a rerun that skips for `reserved by wake-lab --hold` means the fix has
regressed rather than that the box is busy. If the unit still skips, report it as "woken but
`-wsl` gone" (step 4 names this outcome) and do not kick or rerun again. For native Linux,
inspect `os=` and `linux=` instead; a Windows boot or lost sshd cannot be repaired by `kick-wsl`.

Everything else about these boxes — WoL over Ethernet only, waking from a full shutdown, and
what `router-active=1` means — is recorded in the header comment of `scripts/wake-lab.sh` in
ludics-lite. WSL holder and Windows details are in `scripts/wake-lab-wsl.sh`. The installed
`~/bin/wake-lab.sh` links to that core script; do not spend the run rediscovering this setup.

Do not power the boxes back down afterwards — the user may want them for the day's work, and the
next sweep can always wake them again. The one exception is tuf, and it is the sweep's, not
yours: its lane ends with `wake-lab.sh sleep tuf` and says how that went on a summary line of its
own — `tuf: put back to sleep`, or `tuf: left awake, not a failure -- … REFUSED …` (another run holds
the box: a block inhibitor or a lab lock, named on the line), or `tuf: WARNING -- wake-lab.sh sleep
tuf exited N: …`. Quote that line in the report; only the WARNING is worth a task chip. Do not sleep
tuf yourself.

## 2. Run the sweep

Always use origin/master's copy of the script, the checkout is sometimes on a WIP branch. The
script is NOT standalone: it resolves siblings relative to its own directory
(`tools/aggregate-skips.sh`, and `benchmarks/fixture_digest.py` for the measurement-box matrix),
so a lone copy of `tools/sweep.sh` dies with exit 2 before testing anything. Extract the two
directories together from master instead of copying one file:

    mkdir -p ~/.ocannl-sweep
    git -C ~/ocannl-staging fetch -q origin master
    rm -rf ~/.ocannl-sweep/tools ~/.ocannl-sweep/benchmarks
    git -C ~/ocannl-staging archive origin/master tools benchmarks | tar -x -C ~/.ocannl-sweep
    # TEMPORARY (see the top of this routine): every wake-lab.sh verb but `sleep tuf`.
    printf '%s\n' '#!/bin/bash' \
      'if [ "$1" = sleep ] && [ "$2" = tuf ]; then echo "REFUSED: tuf kept awake by the sweep routine until it has wired Wake-on-LAN"; exit 3; fi' \
      'exec "$HOME/bin/wake-lab.sh" "$@"' > ~/.ocannl-sweep/wake-lab-tuf-awake.sh
    chmod +x ~/.ocannl-sweep/wake-lab-tuf-awake.sh

The `mkdir` is not redundant on a box where the sweep has run before: `tar -C` requires the
directory to exist, and `~/.ocannl-sweep` is also the script's state directory
(`OCANNL_TOOL_SWEEP_STATE`), so a fresh host, or one where it was cleared, has none.

If a future master grows a dependency outside those two directories, the failure is an exit 2
during startup: today the missing sibling is reported by the interpreter's own error above the
`sweep:` line (`cannot parse measurement boxes at <sha>` is what the script itself says when
`benchmarks/fixture_digest.py` is not there), so read both lines, not just the `sweep:` one.
Widen the pathspec in the `git archive` line above (that is the whole fix), then relaunch once.

The script refuses to run without `OCANNL_TOOL_SWEEP_LOCAL_BOX`, the portable measurement-box ID
of THIS host — one of the names on the `# measurement-boxes:` line of
`benchmarks/fixtures/DIGESTS.txt` (currently `m4-max minix rog-nv`). It deliberately will not
infer that identity from the hostname or CPU model (either can name a different machine the same
way), so the binding is per-host site configuration, one line in
`~/.config/ocannl-sweep/local-box` (on this Mac, the Apple M4 Max, it says `m4-max`). Do not
hardcode a box name in this routine: read the file, and treat its absence exactly like the missing
`~/.config/wake-lab/hosts.sh` in step 1 — the setup is the finding, nothing was swept, and it is
notify-worthy (step 6):

    box=$(cat ~/.config/ocannl-sweep/local-box 2>/dev/null)
    [ -n "$box" ] || { echo "no box ID at ~/.config/ocannl-sweep/local-box; nothing swept" >&2; exit 1; }

If that fires, DO NOT launch the sweep. An empty `OCANNL_TOOL_SWEEP_LOCAL_BOX` is not "let the
script decide": it dies with the same exit 2 as any other unusable environment, which reads like
something the corrected relaunch below could fix and is not. Release only step 1's recorded
holders first — they are already running by then, nothing else ends them, and this path never
reaches the cleanup below:

    # Restore held_file from the "holder list:" path printed in step 1 if using a new shell.
    held_boxes=()
    while IFS= read -r held_box; do [ -z "$held_box" ] || held_boxes+=("$held_box"); done < "$held_file"
    [ ${#held_boxes[@]} -eq 0 ] || ~/bin/wake-lab.sh unhold "${held_boxes[@]}"

Then go straight to step 5 and report the missing
site configuration as the finding, and notify in step 6. The same goes for any other exit from
this step that never launches the sweep: unhold before you leave it.

A typo in the file is caught by the script itself: it checks that every declared box has a sweep
unit, so a misspelled local ID dies with `declared measurement box 'm4-max' has no sweep unit`.

Then, if today is Sunday, run the weekly full check
`OCANNL_TOOL_SWEEP_LOCAL_BOX=$box OCANNL_TOOL_SWEEP_WAKE_LAB=$HOME/.ocannl-sweep/wake-lab-tuf-awake.sh OCANNL_TOOL_SWEEP_CAP=10800 ~/.ocannl-sweep/tools/sweep.sh --slow --force`;
otherwise `OCANNL_TOOL_SWEEP_LOCAL_BOX=$box OCANNL_TOOL_SWEEP_WAKE_LAB=$HOME/.ocannl-sweep/wake-lab-tuf-awake.sh ~/.ocannl-sweep/tools/sweep.sh`. `--force` is what makes a unit record `pass` with `execution=forced`
(a `dune clean` plus alias `--force`, so every test action genuinely re-executes); a weekday run
is incremental and records `incremental-pass`, which is evidence about the changed cone but does
not refresh execution coverage. The raised cap is for the forced runs only: a cold rebuild plus
`@slow` legitimately exceeds the default 90-minute unit cap, and cutting it short would file lost
coverage as `timeout`.
Run it in the background and wait for it to finish — a cold unit can take tens of minutes.
Each box's units run as one lane, and the four lanes (three when a run selects no tuf unit) run concurrently (gh-ocannl-976): the remote
units start within seconds of launch, and the run lasts as long as its longest lane — normally this Mac's, which carries metal's suite. The stdout header's `lanes:` line names each
box's units. Units on different boxes finish in any order, so their summary blocks and their
history rows appear in completion order, not in the order this routine lists them.
The script deliberately exits 0 even when tests
fail; its exit code tells you nothing about test results, so do not read anything into it. Read
the results from the history file instead.

The ONE exit code that does carry meaning is 2, and it comes in two kinds; tell them apart by the
`sweep:` line before doing anything else. The startup kind: the script found its launch environment
unusable (a `sweep: ...` line on stderr says why) and stopped BEFORE testing anything, on any
machine. A startup exit 2 is therefore a whole day of non-coverage for all five backends, not a test result:
read the `sweep:` line first, and relaunch only if it names something this routine can correct
from the instructions above (a missing box ID, a stale or incomplete extraction, "another sweep is
running"). `sweep: the lab lock contract with <wake-lab.sh> is broken: ...` is NOT one of those:
`wake-lab.sh lock-path <box>` names a different file from the one a lane locks, so lanes would
reserve locks no destroyer checks. It is a code fix on whichever side moved (the line names what),
and it is notify-worthy. Nor are the endpoint-map refusals, since the sweep takes every remote
unit's ssh alias from `wake-lab.sh endpoint-map` (staging#888): `endpoint-map gave no map`, `has no
row for <box>`, `lists no -<kind> alias for <box>` are a finding about the installed wake-lab.sh or
its site map, notify-worthy. Only `sweep: no wake-lab.sh at <path>` is an incomplete extraction
(the wrapper above is missing). Do not retry the same command hoping for a different answer — the 2026-09-05 run burned
a second attempt on that before recognizing the failure. Whatever the outcome of the single
corrected relaunch, a startup exit 2 is reported in step 5 as non-coverage and notified in step 6.

The lane-stopped kind comes AFTER testing: `sweep: lane(s) stopped before finishing: <box> (exit
N)` means a lane could not write a history row or unit state (the lane's own `sweep:` line above
says which) and stopped, while the other lanes ran to completion. This is a PARTIAL sweep, not an
absent one: the rows the run did write, today's `when` stamp in the history file, are real
results, and steps 3–5 process them exactly as for a completed run — a failure in a lane that
finished is news like any other. Units without a row, which only the stopped lane can have, are non-coverage; any row
the stopped lane did write is a result like the rest, and no
skip-coverage report was written. Do not relaunch for it: an unwritable state directory is the
finding, and it is notify-worthy.

When you leave this step — however that happens: the run finished, it died at startup, or one of
the refusals above sent you to step 5 without launching anything — release only the holders
recorded in step 1 (unless the earlier missing-box path already released them):

    # Restore held_file from the "holder list:" path printed in step 1 if using a new shell.
    held_boxes=()
    while IFS= read -r held_box; do [ -z "$held_box" ] || held_boxes+=("$held_box"); done < "$held_file"
    [ ${#held_boxes[@]} -eq 0 ] || ~/bin/wake-lab.sh unhold "${held_boxes[@]}"

Nothing else ends them deliberately: the holder cannot expire under the last unit, so a lane that
is never unheld leaves a `wsl.exe` pinning the VM (and an ssh connection from this Mac) until the
box reboots or that connection dies. `unhold` exits 2 if a holder had already died under the lane
(treat that box's results as suspect) and 3 if the release could not leave the box demonstrably
free — a holder survived both its channel and a kill by pid, or the box never answered. That box
needs a human, though the lane's results are fine; on the "never answered" case, run `unhold` again
once it is reachable and the release finishes the job off the record it kept. Do it before the retry budget's rerun too, or take the rerun's
own `kick-wsl --hold` over the still-held box — `kick-wsl --hold` reuses a live holder rather than
stacking a second one.

## 3. Diff against the previous sweep

Read `~/.ocannl-sweep/history.tsv` (columns: when, machine, backend, ref, outcome, seconds,
target, slow, log, execution). Passing outcomes are `pass` (forced execution), `incremental-pass`
(a weekday run; cache hits possible) and `legacy-pass` (rows migrated from before the execution
column existed).
For every unit in today's run whose outcome is not one of those, compare
`~/.ocannl-sweep/logs/<stamp>-<machine>-<backend>.fingerprint` against the fingerprint of that
same unit's most recent PREVIOUS non-pass run. Only a DIFFERENCE is news.

The `machine` column holds the measurement-box ID, so rows and filenames from before 2026-09-05
spell the same units `local` (now `m4-max`) and `rog` (now `rog-nv`); `minix` is unchanged. When
looking for a unit's previous non-pass run, match on machine AND backend, accepting only those old
machine spellings of its fingerprint filename. Never match on backend alone: hip runs on two boxes
of different memory models (minix unified, tuf discrete), so the other box's hip fingerprint is a
different experiment, and matching it would invent news or hide a repeat. The one cross-machine
match is multidev_cc's move below.

multidev_cc also MOVED, from this Mac to minix (gh-ocannl-976): its older rows and fingerprints say
`m4-max`/`local`, its newer ones `minix`. Match it on `backend` across both, but read the first
minix failures with that in mind: a multidev_cc unit that is red on minix while its last `m4-max`
rows were green may be a Linux-only finding the move newly exposed rather than a regression of
master — still news, and worth a task chip, but say which it looks like (does cc on this Mac pass
the same tests? is the failing golden platform-sensitive?). The sweep's own per-unit cursor is
keyed by machine, so its `REGRESSION OR FIX DID NOT TAKE` and `fingerprint moved` lines start
fresh for minix/multidev_cc and cannot flag that first transition; this diff is what catches it.

A unit going from `pass` to `fail`, or a new entry appearing in a fingerprint, IS news.

A forced full-suite run (Sunday) also writes `~/.ocannl-sweep/logs/<stamp>-skip-coverage.txt` —
the intersection of backend-scoped `Verdict.skipped` claims across every unit that recorded
`pass` (gh-ocannl-792). Read it: its `result:` line is the verdict (`PASS`/`CLEAR` are green;
`POTENTIAL` means some claim was skipped on every backend that completed, with backends absent;
`FAIL` means a claim was skipped on all five backends — that claim has ZERO execution coverage
anywhere; `NOT AGGREGATED` means fewer than two backends completed, so the question could not be
asked — report that as non-coverage of the coverage question itself, not as green). The sweep's
stdout also quotes the `result:` line and each `FAIL:`/`POTENTIAL:` finding, indented under its
`skip coverage:` line. Compare the FAIL/POTENTIAL claim set against the most recent previous
`*-skip-coverage.txt`, the same way fingerprints are diffed: a claim appearing or escalating
(POTENTIAL → FAIL) is news. A weekday incremental run writes no report and says
`skip coverage: not aggregated` — that is normal, not a finding.

The per-run record `~/.ocannl-sweep/logs/<stamp>-run.tsv` (its path is the sweep's `run:` line) is
the machine-readable form of the same run; read it rather than re-deriving facts from the summary
prose. Its first line is `schema 6`. Each `unit` row is: machine, backend, outcome (or `no-row`), a
lane-stopped flag, the log path, the kernel window's start and end, its COUNT, the window's KIND, the
unit's MEMORY model, and its GPU-TOKEN readings. The count means what the kind says (gh-ocannl-1034):

- `dxg` — a WSL boot (`-wsl`): the count is `vmbus_sendpacket failed` bursts on the dxg bridge.
- `native` — a native-Ubuntu boot (`-linux`): the count is refused GPU queues and driver faults —
  amdgpu's `DQM create queue type <n> failed` (one per refused queue; `No more SDMA queue to allocate`
  is its reason, counted only where no DQM line was logged) and NVIDIA's `NVRM: Xid` events. On minix
  that is the SDMA queue pool running dry, the signature `unit_jobs` caps against; ROCr's
  `GpuAgent::ReleaseQueueMainScratch` assertion in the log is its userspace half.
- `-` — no window: a local unit, a CPU unit, one that never ran (`skip`, `gate`).

A count is `-` (no window), a number (a window that was read; only this is a finding about the
device), `unavailable` (the collection failed — not "the device was fine"), `vm-replaced` (the
WSL guest was destroyed and recreated mid-window), or `suspended` (a native box slept inside the
window: the kernel's `PM: suspend` entry/exit lines, since its boot id survives; gh-ocannl-1039).
A positive count, `vm-replaced` or `suspended` makes the unit environment-red: on a `fail` it buys
the serial rerun, whose `still red:` / `all clean` lines are the verdict. On an `error` or `timeout`
there is no rerun, and for the last two the sweep says the guest was REPLACED or the box SUSPENDED
mid-unit: that unit tested nothing about the code (a sleep mostly ends it as a `timeout`), so ask
who restarted or slept the box, not what the backend did. Quote the kind with the count so a reader
knows which device it is about. The memory field is `discrete/<arch>`, `unified/<arch>`
or `-` (CPU): it is how you tell tuf/hip's discrete coverage from minix/hip's unified one without
knowing the fleet's hardware.

The twelfth field is the box's GPU-TOKEN readings (gh-ocannl-1177): `<event>=<GPU holders>/<tokens>`
per reading, comma-separated — `opened` at the unit's start, `closed` after its suite, `refused` when
its take of a token gave up — `?` for a reading that could not be read, and `-` for a unit with none
(local, CPU, or never dialled). `opened=1/2,closed=0/2` says another batch held one of the box's two
GPU tokens as the unit started; a launch out-of-memory beside a nonzero reading is contention until
the serial rerun says otherwise. Where the tokens bind (rog-nv's cuda today) the unit runs inside
one, and a token that did not come free in time records `skip (no GPU token on <box>: <holders>;
<n>s)` — the one `skip` row that carries a log, with a `refused` reading in its token field
(`opened=2/2,refused=2/2`) and each holder in the `<log stem>.gpu-tokens` file beside the log.
Nothing was tested and nothing failed: report it like the lock skip, attributing it to the holders
it names (a worker's batch, the GPU integration loop), never as a test failure, and do not rerun
into it.

## 4. Staleness

Age only FULL-SCOPE passes: a row counts toward coverage only if its `target` column is `<all>`.
A row with a narrower target came from a manual smoke run that executed a fraction of the suite,
and treating it as coverage would certify tests that never ran. Likewise, when judging whether
slow coverage is current, count only rows with `slow` = 1.

And age a backend only by rows from the box that runs it NOW — the one today's `lanes:` header line
puts it on — normalizing only the historical renames of the same box (`local` → `m4-max`, `rog` →
`rog-nv`). A backend that moved boxes has not been covered on its new box until a row there says
so: multidev_cc's `m4-max`/`local` passes do not count toward its liveness or its 14-day forced
check once the sweep runs it on minix, so the move shows as stale until minix records its own pass
and forced pass — which is the point, since the move exists to add coverage that had never run.
Failure comparison in step 3 still matches across the move; only aging is per box.

Two distinct ages per backend, because a green incremental run and a genuinely re-executed suite
are different claims:
- **Liveness**: the most recent full-scope passing row of ANY passing outcome (`pass`,
  `incremental-pass`, or `legacy-pass` while those age out). This is the "is the sweep working
  and is the backend green" age, thresholded below.
- **Execution coverage**: the most recent full-scope `pass` row with `execution=forced`. Flag any
  backend whose last forced pass is more than 14 days old (the Sunday `--force` cadence plus one
  missed week) — incremental greens in between may be cache hits and cannot stand in for it.

For each of the FIVE backends (cc, multidev_cc, metal, cuda, hip) find the most recent qualifying
liveness row. hip's is minix's: `lanes:` lists hip under both `minix(...)` and `tuf(hip)`, and the
backend rows of the run record carry hip twice, once per box — age each unit by its own box's rows,
and gate hip on minix's as before. Age tuf/hip separately, as its own line ("hip on tuf, discrete
memory: last full-scope pass <age>, last forced pass <age>"): flag its liveness only when that pass
is more than 7 days old, since a week of gates means the RTC wake is not waking it and
discrete-memory hip has quietly lost its only coverage; and flag its EXECUTION coverage by its own
forced pass on the same 14-day rule as the five backends — hip's forced pass on minix does not
stand in for it, and weekday `incremental-pass` rows on tuf cannot either. Flag backends with no pass in more than 2 days. For cuda, hip or multidev_cc,
report the step-1 outcome for its box: woken and swept; machine reachable but the configured
guest or native Linux endpoint unreachable when the unit probed it; or wake failed. Only units
whose own row says `skip (unreachable)` are uncovered; a unit that ran before an endpoint vanished
keeps its result. For WSL boxes, a vanished guest also means the holder failed or was never asked
for; a re-kick with `--hold` plus an incremental rerun usually recovers it. For native Linux,
check the booted OS and sshd instead. A failed wake with settled `router-active=1` means the NIC
was powered and listening but ignored the magic packet; check the OS-specific WoL settings.
With settled `router-active=0`, check the cable, box power, and BIOS setting that keeps the NIC
powered while off.

## 5. Report

Print a short summary: one line per unit (machine/backend, outcome, duration), preceded by a line
on what step 1 did if any box needed waking, and by each `REFRESH FAILED` line step 1 printed. Open with step 0's drift verdict, in one line when
everything is in sync and with the diff when it is not (plus the branch, the `rev-list` counts and every path the
`status --porcelain` line printed when the checkout is not canonical — the sync script's own path
included, which no sync diff would show — or the fetch's error if that comparison could not be made,
and any `RETIRED, but still installed` warning with the two steps the script names for it) — a check whose silence and whose absence look alike is not a check. Then either "no change since the last sweep" or the
specific new failures with the relevant log excerpt (the full log path is in the history row —
quote a few lines, do not paste the whole thing). On a forced run, also include the skip-coverage
`result:` line and every `FAIL:`/`POTENTIAL:` claim from today's report, plus the report path —
these are the zero-coverage findings this routine is the only channel for.

Outcomes are `pass`, `incremental-pass`, `legacy-pass`, `fail`, `skip`, `gate`, `timeout` and
`error`. `gate` is tuf's alone: the box was not up (`gate (tuf not up: <its status fields>)`), or
answered its status and then not the unit (`gate (unreachable)`). It is non-coverage of that one
unit and never notify-worthy by itself; report it on tuf/hip's line with the status fields.
`error` means the harness could not
put that machine's worktree on the commit under test, so NOTHING was tested there — report it as
non-coverage rather than as a test failure, and treat it as notify-worthy. For an `error` (or a
`skip (unreachable)`) on a GPU box, check whether the box restarted under it before diagnosing the
harness. For a native Linux box, inspect its boot history and journal when reachable (for example,
`journalctl --list-boots` and `journalctl -b -1`) and report whether a reboot or suspend interrupted
the lane. For a WSL box, System event 1074 on the `-win` side inside the unit's window, from
`MoUsoCoreWorker.exe` or `TrustedInstaller.exe`, is a Windows Update restart, which takes the VM
and its holder with it:

    ssh rog-nv-win "powershell -NoProfile -Command \"Get-WinEvent -FilterHashtable @{LogName='System';Id=1074;StartTime=(Get-Date).AddHours(-12)} | Format-List TimeCreated,Message\""

(`minix-amd-win` for minix — those two, and the `-lan` aliases, are the Windows destinations;
`wake-lab.sh` names the one that answered when it kicked the box.)

Report a WSL update restart as such, name the active-hours values step 1 read, and file the fix as
re-pinning active hours on that box. For native Linux, report the corresponding journal evidence
and the cause it supports. If the script itself
exits 2 at startup, no sweep happened at all: report that as the finding and do not read the history
file as though the run had completed. A lane-stopped exit 2 (step 2) is the exception: report every row the run
recorded — the stopped lane's own included, since it may have finished a unit (minix's hip) before
stopping — including any new failures among them, as this step describes, and report only the
units with no row as non-coverage. The same applies when this routine never got as far as launching
it because `~/.config/ocannl-sweep/local-box` is missing: report the missing site configuration,
not the backends.

## 6. Notify

Send a PushNotification ONLY if there is (a) a new failure or timeout, (b) a staleness flag,
(c) a skip-coverage `FAIL`, or a FAIL/POTENTIAL claim set that differs from the previous report's,
(d) step 0 reporting DRIFT on this routine's own prompt, a checkout that is not canonical as
step 0 defines it, or a remote comparison it could not make at all — each says this run may have executed
instructions that have been superseded, and nothing else on this box notices; an installed prompt that
matches an equally stale checkout reads `in sync` and is exactly as wrong,
or (e) an `error` outcome, a script exit of 2, or a launch refused for a missing
`~/.config/ocannl-sweep/local-box`: nothing was tested there, which step 5 already
calls notify-worthy, and it must not go silent for being neither a failure nor yet stale.
A `FAIL` notifies even when unchanged — it fires at most weekly (forced runs only) and means some
claim has zero execution coverage on every backend, which must keep reaching a human until fixed;
an unchanged POTENTIAL set stays silent like an unchanged fingerprint.
Drift — and a checkout that is not canonical, and a fetch that failed — notifies every day it lasts, for
the same reason: each says this run may have followed superseded instructions, only a person can end it,
and it is silent everywhere else — the 2026-09-17 instance went a
week unseen. Name the direction from PROVENANCE, never from the diff's orientation (`sync-routines.sh` always diffs
the checkout first, so the `-` side is the checkout whether it is the stale one or not; the checkout's
`git log` for that prompt is what says which text landed and when). Put THAT in the notification, never a
fixed command, and never a `push` out of a
checkout step 0 did not find canonical — that installs unreviewed text, and the notification is read by
someone who will run what it says. So: `pull` whenever the INSTALLED copy holds the newer text (a run
that edited its own prompt in place — a push would destroy the only copy of that edit), canonical or
not, since a pull writes into the checkout where `git diff` shows it and review still stands between it
and the scheduler; `push` when the checkout holds the newer text AND step 0 found it canonical; and no
command at all — just what is wrong — when the checkout holds the newer text but is not canonical, or
when both sides have moved — or when another local routine's drift points the OTHER way, since
`push` and `pull` take no routine argument and apply to every local routine at once, so one of the two
would be destroyed.
A green sweep, or a red-but-unchanged sweep, must stay silent — a notification that fires every
day is one that gets ignored, which would defeat the point. A box that failed to wake is not by
itself notify-worthy; it becomes so only through the staleness thresholds above.

Do NOT fix anything, do NOT commit, do NOT run `dune promote`. However, create a task chip for each failure/finding that has a diagnostic. The task is to fix the regression if the fix is localized, file an ahrefs/ocannl issue if the fix would involve design work.
If the sweep script itself errors out (missing repo, cannot resolve the ref), report that as the
finding and stop.
