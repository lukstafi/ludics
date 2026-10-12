---
name: daily-issue-planning
description: Sequence open issues for execution with focus on what and where to do today.
---

## 0. Check you are running the current prompt

Before anything else, run the drift check in the ludics-lite checkout:

    git -C ~/ludics-lite fetch --quiet origin \
      && git -C ~/ludics-lite rev-parse --abbrev-ref HEAD \
      && git -C ~/ludics-lite rev-list --left-right --count HEAD...origin/main \
      && git -C ~/ludics-lite status --porcelain -- routines scripts/sync-routines.sh
    ~/ludics-lite/scripts/sync-routines.sh

`scripts/sync-routines.sh` with no argument is status mode: one line per local scheduled task, and exit 1 on any drift. Read your own line first — `daily-issue-planning: DRIFT` means the prompt the scheduler dispatched, the one you are reading now, is not the one the checkout holds, so the instructions below may be a superseded revision and the diff it prints says in what. Which side is the newer one it does NOT say — its orientation is argument order, and step 2 says how to read that from provenance instead. Then read the other lines: this is the only run on this box that looks at them (ludics-lite#199, where the cross-machine sweep ran a week on a prompt predating `--hold`).

The `fetch`/`rev-list` line is not decoration. Status mode compares the installed copies with THIS checkout, not with `origin/main`, so a checkout behind the remote reports `in sync` while the installed prompt is older than what merged. `rev-list --left-right --count HEAD...origin/main` prints two numbers, `<ahead> <behind>`: commits the checkout has that `origin/main` does not, then commits of `origin/main` the checkout does not have. **Canonical**, once, since everything below turns on it: the checkout is canonical when the branch is `main`, the counts are `0 0`, and the `status --porcelain` line printed NOTHING. Only then does it hold exactly what merged, and only then may anyone install from it. A nonzero BEHIND means it is missing prompts that merged. A nonzero AHEAD, any other branch, or a dirty `routines/` or `scripts/sync-routines.sh` means it carries text that has not been through review — the script is in the pathspec because the next command RUNS it, and a local edit to its routine list, its destination or its publishing logic installs a state nobody reviewed — and `sync-routines.sh` compares the working tree, so uncommitted text reads as the checkout being newer and would be published as-is. Installing from a non-canonical checkout is a worse failure than the drift it would be fixing: the scheduler would then be running something nobody reviewed. It is compared against `origin/main` by name for a reason: the checkout may be on a topic branch, or on one with no upstream at all, and `git status -sb` would then report that branch's own tracking state — no `[behind N]`, and the newer prompt on `main` invisible. The `&&` is deliberate too: if the fetch fails (auth, DNS, network, the remote down), no counts are printed at all, and that absence is the answer — the remote comparison is UNKNOWN, not clean, since stale remote-tracking refs would show a checkout that matches the installed copies as up to date. Report the fetch's error in its place.

Do NOT run `sync-routines.sh push`. The installed copies are live scheduler state, and re-installing a prompt is a person's call made after reading the diff; your job is to make the drift visible.

## 1. Update the sequencing plan

Do not start editing until `git -C ~/self-improve pull --rebase` has actually succeeded — the plan is edited from other boxes too, and every recovery below ends by running it again, since nothing else fetches what they pushed. If it does not succeed, a previous run may have left a conflicted rebase behind: finish it (`git -C ~/self-improve rebase --continue`, or `--abort` for a clean tree), pull again, and if you still cannot get a clean pull, stop and report that the plan was not updated at all and why.

Update ~/self-improve/ClaudeDesktop/sequencing_plan.md with the account of all currently open issues across my active GitHub repositories: ahrefs/ocannl (PRs at lukstafi/ocannl-staging), lukstafi/flotilla, lukstafi/ocaml-cudajit, lukstafi/ocaml-metal, lukstafi/ocaml-hipjit, lukstafi/ocaml-dataprep, lukstafi/lukstafi.github.io, lukstafi/ludics-lite.

Arrange the material without unhelpful redundancy, the following are needs, not steps.

- Briefly describe the issues.
- Group them.
- Show dependencies.
- Categorize into three classes: (D1) straightforward ones; (D2) requiring logical problem solving, but limited code impact (e.g. debugging); (D3) requiring design taste and tricky conceptual thinking.
- Pick the issues that can be implemented or solved first.
  - Present them as the first-wave list, with an explicit home-box field on every item: exactly one of
    `mac-studio`, `rog-nv-linux`, `minix-amd-linux`, or `tuf-amd-linux` when those boxes are running
    native Linux. Check the current site's `kind_of` and fleet roster before writing the plan; use
    the corresponding `-wsl` alias for a box booted into WSL, and include only boxes in the roster.
    This is the issue-wave coordinator's dispatch
    lookup, so never leave it to inference from the machine-placement prose. When an issue has useful
    legs on other boxes, name the box where its primary iteration happens as home and list the other
    boxes separately as legs. If one list item groups issues with different homes, label each issue's
    home rather than giving the group an ambiguous shared field.
  - Among them, show which ones are good to run in parallel to one-another.
  - Among them, show which ones prefer to run on ROG (NVIDIA GPU), which on Minix (AMD GPU, unified memory), and which on TUF (AMD GPU, discrete memory).
- CPU ISA: `rog-nv-linux` is Arrow Lake, AVX2 only; `minix-amd-linux` (Zen 5) is the only AVX-512 box, so AVX-512 witnesses and timings go on minix.
- Place by memory model on the AMD side. `minix-amd-linux` (Radeon 8060S, `gfx1151`) shares system memory with its CPU; `tuf-amd-linux` (Radeon RX 7700S, `gfx1102`, discrete RDNA3 with its own VRAM) is the box that exposes what unified memory masks. HIP work whose behaviour depends on discrete versus unified memory — host↔device transfers, buffer placement, pinned or zero-copy host memory, anything minix's shared memory could hide — homes on TUF, or takes a TUF leg beside minix's; HIP work where the memory model does not matter stays on minix. Give the Machine-placement section a TUF paragraph for these legs, as it has one per other box. Every HIP measurement the plan cites or asks for says which memory model it ran on (unified on minix, discrete on TUF), since a number from one does not stand in for the other. TUF has no working Wake-on-LAN (cabled, but neither of its wired NICs wakes it) and a person wakes it by hand, so write "manual wake" beside each TUF placement: the coordinator then asks the user to wake it or defers the item with the gate recorded, and never reads "asleep" as a failure.
- End with a "## Design questions" section surfacing the open design decisions you noticed while reading the issues. This section feeds the issue-wave skill's decision gate, so make each entry directly consumable: one line per question with the issue number, the X-vs-Y in a clause, **your own recommendation with a one-clause reason**, and a suggested tier: "veto" (default: the wave posts the recommendation to the issue and proceeds; user silence is consent) or "ask" (reserved for genuinely user-owned calls: lasting API/workflow taste, or impacting longer term design direction). Lean heavily toward "veto" — the point is to spare the user decision fatigue, not to route every judgment through them. Drop entries from previous runs once their issue closes or a decision lands.

Updating the doc means removing issues that are closed and adding issues that are missing. For OCANNL, also assign issues that miss a milestone to the appropriate milestone. Keep the file's "Last updated" header to a few lines — the date, the run number, and one line on what changed — because the issue-wave skill reads the whole file live at every invocation; the narrative of the previous day's activity (what merged, what was filed, what closed) goes into the sync commit message, not into the header. After done, do a sync commit of all changes on ~/self-improve and push. If the push does not succeed — rejected, or failing for any other reason (auth, network, remote down) — run `git -C ~/self-improve pull --rebase` once and push again. If that still fails, do not leave it silent: end your report with an explicit final line saying the plan was updated locally but not pushed, and why (the error, and any rebase conflict you left behind) — other boxes read this file live and would otherwise keep working off a stale plan.

This routine is started inside the ocannl-staging repository, as this one has the richest related memory and context.

## 2. Report

Close the report with the routine-drift finding from step 0 — below step 1's "updated locally but not pushed" line, if that one applies, so neither hides the other. Report it even when everything is in sync, in one line: a check whose silence and whose absence look alike is not a check. When there is more to say, say it in this order.

1. **Every line `sync-routines.sh` printed**, not only the local verdicts. A `RETIRED, but still installed` warning is not a drift verdict and has no diff and no direction — it is a tombstoned routine whose registry entry keeps firing it — so carry it through with the two steps the script names (deregister the task in the desktop app FIRST, then remove the installed directory), and never answer it with `push` or `pull`: neither stops a registered task, and removing the prompt while the entry stands makes it fire and fail rather than stop.
2. **What step 0 read about the checkout**, whenever it was not canonical: the branch, the `rev-list` counts, and every path the `status --porcelain` line printed — the sync script's own path included, which no sync diff would show. Or the fetch's error, when the remote comparison could not be made at all.
3. **The diff**, for each routine that drifted.
4. **The repair a PERSON runs**, and which direction it is:
   - The direction is NOT readable off the diff. `sync-routines.sh` always diffs the checkout against the installed copy in that order, so the checkout is the `-` side whether it is the stale one, the current one, or the one holding text nobody installed. Take it from PROVENANCE: `git -C ~/ludics-lite log -1 --format='%h %ad %s' -- routines/<name>/SKILL.md` says when the checkout's prompt last landed. Text that is in the checkout's history and missing from the installed copy is a merged prompt that was never installed; text in the installed copy that appears nowhere in that history is an in-place edit.
   - `pull` when the INSTALLED copy holds the newer text — a routine editing its own prompt in place is a supported workflow (`routines/README.md`), and a `push` over it destroys the only copy of that edit. It needs no canonical checkout: a pull writes into the checkout, where `git diff` shows it and review still stands between it and the scheduler; it does need a checkout clean enough to receive it.
   - `push` when the CHECKOUT holds the newer text and step 0 found it canonical.
   - **Neither**, saying why, in every remaining case: the checkout holds the newer text but is not canonical (a nonzero BEHIND wants `git -C ~/ludics-lite checkout main && git -C ~/ludics-lite merge --ff-only origin/main` first, by name — not a bare `git pull --ff-only`, which follows whatever the CURRENT branch tracks and would fast-forward a topic; a nonzero AHEAD, another branch, or a dirty path wants that text landed through review); provenance that does not read clearly, which is not a direction; both sides having moved; or two routines pointing opposite ways — `push` and `pull` take no routine argument and apply their mode to every local routine at once, so the installed-only edit has to be copied into the checkout and committed by hand first, leaving every remaining difference pointing one way.

Re-run the script before writing any of this if something this run did could have moved either side.
