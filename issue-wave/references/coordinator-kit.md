# Coordinator kit

`fleet-worker.sh wave` is the per-wave tooling every coordinator used to rewrite under
`$ISSUE_WAVE_STATE/<wave>/` (ludics#1047). It has these verbs:

- a brief renderer;
- a worker's launch prep;
- a CLI worker's launch;
- a restartable integration-loop driver;
- a heartbeat;
- the review checkpoint;
- the handoff driver;
- the decision record.

With the kit, the wave directory holds data only: no script is copied forward from the last
wave. The contracts are the module headers in `lib/ludics/fleetworker/`: `wave.py` for the wave
file and the heartbeat, `wavebrief.py`, `waveprep.py`, `wavelaunch.py`, `waveloop.py`,
`wavereview.py`, `wavedrive.py` and `wavedecide.py`. This page covers what a coordinator puts in the wave directory and when it calls each verb.

## The wave directory

```
<wave>/wave.json              the wave's facts, the only place a project's facts enter the kit
<wave>/tasks/<task>.md        each task's section
<wave>/legs.md, leg.md        the GPU-home-box legs section; leg.md is rendered once per leg into @@LEGLINES@@
<wave>/tail.md                optional, last: e.g. "where the task section differs, it wins"
<wave>/common/<part>          optional: overrides one shipped common section (who.md, landing.md, ...)
<wave>/common.md              optional: the common sections whole, in place of every shipped one
<wave>/planning-<mode>.md     optional: overrides a shipped paired-planning section (paired, paired+critique)
<wave>/project.md             optional: overrides the project part the wave file's project_part names
<wave>/queue.json             optional: the launches left to the handoff driver (step 9)
<wave>/review/<part>          optional: overrides a shipped review part; review/project.md overrides the
                              project's own review part (the wave file's review.project_part)
```

## The shipped brief template

A wave copies no brief text forward. The repository ships the reference template in
`issue-wave/templates/`, one section to a part, and a rule every transport follows is in one file:

- `shared/`: where the worker works, its startup check, the task, requests, landing through
  ship-pr, the review checkpoint (only for a wave file that names a `review`) and the steps after
  the merge;
- `native-claude/` and `cli-codex/`: what differs by the worker's kind. That is who it is, how it
  runs tests, how it holds a long run, and how it keeps its context lean;
- `native-claude/planning-paired.md` and `planning-paired+critique.md`, the paired-planning
  additions.

`wave prep` puts the common sections in a fixed order and takes each from the wave directory's
`common/<part>` when it has one, else from the worker's own kind, else from `shared/`
(waveprep.py's header, *THE COMMON PARTS*). A wave directory's `common.md` replaces all of them.
Nothing is shipped for a native Codex or a Claude CLI worker's own four parts, so such a wave
writes them under `common/`, and its planning parts.

The template holds no project fact. It takes them from three places:

- **Built-in values.** `REPO`, `ISSUE_REPO`, `CHECKOUT`, `HOST` and the task's own values come from
  the wave file and the task.
- **Two `vars`.** `COORDINATOR` is the coordinator's session id. `MAIN` is the main branch.
- **The project part.** `@@PROJECT@@` is the project's own section: its conventions, its test
  commands and traps, its formatter gate, its pre-merge coverage. The wave file's `project_part`
  names it, a path in the project's checkout read at the task's base. That way the project keeps
  its section in its own repository and reviews it there. A wave directory's `project.md`
  overrides it for one wave.

This repository's own project part is `.github/wave-brief.md`.

The template is kept in step with issue-wave SKILL.md's *The brief*. A PR that
changes a brief rule changes the template in the same diff. `scripts/check-prompts.sh` reads the
template (checkprompts/brieftemplate.py). It checks that every placeholder in it is one prep gives,
that every path and heading it names exists, and that no step a PR retired is still in it.

Prep writes these:

```
briefs/brief-<task>.md   the rendered brief
reserve/<task>*.json     the standing reservation payloads
reserve/<task>-base.json `execution assign`'s base
scratch/<task>/runs/     the worker's run parent
prep/<task>.json         prep's manifest
```

The loop driver writes `logs/loop-<name>.{json,log,lock}`. A review writes
`reviews/<pr>-<kind>-<sha12>.*`: the prompt, the reviewer's raw answer, the review as posted, the
message for the worker, and the record a re-run reads.

`wave.json` is a fail-closed allowlist (wave.py's header lists every key). A minimal ludics wave
on the shipped template:

```json
{"wave": "wave-20261111-ludics", "repository": "lukstafi/ludics", "checkout": "/Users/lukstafi/ludics",
 "worker_prefix": "w1111", "agent_host": "mac-studio", "transport": "subagent", "kind": "claude",
 "standing_purpose": "standing iteration: targeted ludics suites and lint for @@T@@, slot-wrapped (--cpu)",
 "project_part": ".github/wave-brief.md", "vars": {"COORDINATOR": "local_...", "MAIN": "main"}}
```

A native Claude wave with one GPU home box and one loop looks like this:

```json
{"wave": "wave-20261110-ocannl", "repository": "lukstafi/ocannl-staging", "issue_repository": "ahrefs/ocannl",
 "checkout": "/Users/lukstafi/ocannl-staging", "worker_prefix": "w1110", "agent_host": "mac-studio",
 "transport": "subagent", "kind": "claude",
 "standing_purpose": "standing iteration: targeted aliases for @@T@@, slot-wrapped",
 "vars": {"COORDINATOR": "local_...", "MAIN": "master"},
 "legs": {"rog-nv-linux": {"checkout": "/home/lukstafi/ocannl-staging", "suffix": "rog",
                           "purpose": "standing GPU home box for @@T@@ via execution leg", "vars": {"BACKEND": "cuda"}}},
 "loops": {"cuda-rog": {"box": "rog-nv-linux", "purpose": "GPU integration loop, cuda: @runtest @train at master tip",
                        "checkout": "/home/lukstafi/ocannl-staging-worktrees/integ", "tip": "master",
                        "command": ["env", "OCANNL_BACKEND=cuda", "tools/test-run.sh", "run", "--test-cap", "0", "build", "@runtest", "@train"]}}}
```

## A mixed wave

A wave file's `transport`, `kind` and `agent_host` describe its default worker. A wave that also
runs another kind of worker names each kind as a profile, and each other box a CLI worker lives on
as a host:

```json
"profiles": {"sol": {"transport": "cli", "kind": "codex", "model": "gpt-6.1-sol", "effort": "medium"}},
"hosts": {"rog-nv-linux": {"checkout": "/home/lukstafi/ocannl-staging", "scratch": "/home/lukstafi/wave-scratch"}}
```

`wave prep <wave.json> <task> --base <sha> --profile sol [--host rog-nv-linux]` prepares such a
task. For a CLI task it makes nothing on the box and reserves nothing: `fleet-worker.sh launch`
makes a CLI worker's worktree and takes its standing reservation in one fenced step. `wave launch
<wave.json> <task>` runs that launch from what prep recorded, then reserves the task's legs and
sets its row. A Codex CLI worker's brief is the shipped one (`cli-codex/` with `shared/`).

## Templates

A placeholder is `@@NAME@@`, where NAME is `[A-Z][A-Z0-9_]*`. Any other `@@` is text.

Prep gives every part a fixed set of built-in values (the list is in waveprep.py's header), plus
the wave file's `vars`. `leg.md` also gets the leg's own values.

A post-wave task (`--source <N>`) gets `SOURCE` and no `ISSUE`. A common template that still
says `Closes @@ISSUE@@` therefore refuses to render for that task, rather than give it a closing
keyword.

The template is also where a task can be given a sanctioned in-tree probe spot, with the
project's marker line (native-workers.md, *Scratch files*). The project supplies that line; the
kit invents none.

## When to call each verb

1. **Once per box per wave,** before the first prep, run the provider preflight
   (`fleet-worker.sh preflight <box> --native-claude|--native-codex`).
2. **Per task:**

   ```
   fleet-worker.sh wave prep <wave.json> <task> --base <sha> [--mode ...] [--legs ...]
   ```

   It runs every check before it writes anything: the lease and the halt, rival PRs, an existing
   worktree or branch, registry ids, the board row, and the brief render. Then it makes the
   worktree, the standing reservations, the brief, `base.json` and the pending row.

   When a write fails, the `WAVE PREP MADE` lines say what was made. What to keep is your call.
   A second prep of the same task refuses on the manifest.

   A CLI task (*A mixed wave*) is then started with `fleet-worker.sh wave launch <wave.json>
   <task>`, which runs the launch gate itself, in place of step 3's spawn.
3. **Right before each spawn,** run `fleet-worker.sh gate --wait <seconds>`. Re-check for a
   rival PR by topic first: prep's check covers only the number and the branch. Then spawn the
   worker and set `agent=` and `state=launched` on its row.
4. **Each worker's EXECUTION_REQUEST** is answered with one call:

   ```
   fleet-worker.sh execution assign <wave>/reserve/<task>-base.json <saved final message>
   ```
5. **Each loop:**

   ```
   fleet-worker.sh wave loop <wave.json> <name>
   ```

   A Claude coordinator runs it with Bash `run_in_background`, so its exit wakes you. A native
   Codex coordinator runs it in a managed foreground session (native-codex.md).

   The driver ends in one of three ways:
   - `LOOP RED`: take SKILL.md's *On a red at the tip*, then restart the driver with
     `--resume-after <id>`.
   - `LOOP UNKNOWN`: reconcile the record it names.
   - A stop file (`loops.stop`, or `loop-<name>.stop`) ends it with its run left running. The
     next driver resumes that run rather than starting another.
6. **The heartbeat:**

   ```
   fleet-worker.sh wave heartbeat <wave.json>
   ```

   Run it with `run_in_background` and re-arm it each tick. A tick prints `prs` whole, `halted`,
   each loop's last line, and its time last.

7. **For a paired worker's plan,** use `peer-plan.sh save-plan <plan dir> --from-transcript
   <file>` ([paired-planning.md](paired-planning.md)).
8. **The review checkpoint.** A wave whose file names a reviewer has a second model read each
   worker's PR:

   ```json
   "review": {"kind": "claude", "model": "opus", "label": "Claude Opus 5.5",
              "project_part": ".github/review-checkpoint.md"}
   ```

   A worker's request for its review, or for the confirm before it merges, is answered with one
   call, run in the background since a review takes minutes:

   ```
   fleet-worker.sh wave review <wave.json> <task> <pr> <head sha> --kind at-open|confirm
   ```

   It runs the reviewer headless and read-only, posts the review on the PR, and prints one line
   with the verdict, the decision and the path of the message that resumes the worker. Send the
   worker that file as it is. `decision=unreadable` means the review ended on no verdict line: it
   is treated as blocking, and the review is yours to read. The verdict's grammar, the decisions
   and what a re-run recovers are `wavereview.py`'s header. Under the driver (step 9) this call
   is the driver's for a CLI worker, and yours for a native one. The same call run twice replays its
   record and buys no second review, so when a worker asks for a confirm again at the same head
   (it rebutted and pushed nothing), add `--again`. `--dry-run` posts nothing, for trying a
   reviewer or a project part on a PR that already merged.
9. **The handoff driver.** A CLI worker ends its turn for every handoff, and most of those turns
   need no judgment. Start one driver per wave, in the background, once the first Codex CLI
   worker is launched (it serves Codex CLI workers; a Claude CLI worker's turns, like a native
   worker's, are yours to answer with the same verbs):

   ```
   fleet-worker.sh wave drive <wave.json>
   ```

   It reads each such worker's returned turn by the marker in its final message and answers it:
   an `EXECUTION_REQUEST` is assigned and the worker resumed, an `EXECUTION_RESULT` concluded, a
   `REVIEW_REQUEST` or `CONFIRM_REQUEST` reviewed (step 8) while it serves the other workers, and
   a `HANDBACK` saved under `handbacks/` and its task closed with `board close`. Each turn is
   answered once: the ledger is `logs/drive.jsonl`. Anything a marker does not answer becomes an
   attention line and is yours: a design question, a plan, a worker that vanished, an assignment
   refused six times or in part, a review with no verdict, a merge that no posted clearance
   of its head covers.
   The heartbeat prints each new attention line and returns early when one arrives. Answer the
   turn by hand; the worker's next turn is the driver's again. `wave turn <wave.json> <task>`
   answers one worker's turn, once, when no driver runs. A stop file `drive.stop` ends the driver.
   The markers, the answers and what is deliberately left to you are `wavedrive.py`'s header.

   The driver also launches what you queue. Write each CLI task's part (`tasks/<task>.md`) and
   list the tasks in `queue.json`, in the order you want them started:

   ```json
   {"capacity": {"mac-studio": 4, "rog-nv-linux": 2},
    "tasks": [{"task": "t2130", "profile": "sol", "host": "mac-studio"},
              {"task": "t2136", "profile": "sol", "host": "mac-studio", "after": ["t2130"]},
              {"task": "t2151", "profile": "sol", "host": "rog-nv-linux", "legs": ["minix-amd-linux"]}]}
   ```

   Each tick it starts the first task that is due: its `after` tasks merged, its host under its
   capacity, launches not halted, and the launch gate open. It reads the gate before it prepares
   anything, so under a red base the queued tasks wait unprepared (you are told once) and none is
   left with a stale base. It then prepares the task at the main branch's tip as fetched then, so
   a dependent starts from the base its prerequisite merged into, and launches it. A prep that
   refuses (a rival PR, say) is an attention line and that task is yours; a launch its own gates
   refuse (a preflight) is told once and tried again every five minutes. A task you prepared
   yourself is launched where and at what its prep recorded: on another host than its queue
   entry's, or with the main branch moved since, it is an attention line and yours. You may add
   tasks to the file while the driver runs. A task's queued `after` tasks are above it in the file; an `after`
   task that is not queued is one you launch yourself (a native worker's). A task whose `after`
   task ended without a merge is an attention line too, since it will never come due. The
   rival-PR check by topic stays yours, before you queue a task.
10. **A design decision the wave takes** is surfaced with one call, whether it is a
    recommendation before launch, a call you make mid-wave, or the maintainer's answer you post
    for them:

    ```
    fleet-worker.sh wave decide <wave.json> <issue> --tier 2|mid-wave|3 --call '<the decision, one line>' \
      --body-file <the comment> --by '<your model>' [--task <task>]
    ```

    It posts the comment (with the wave's footer, or for tier 3 under the maintainer's heading),
    adds the `design-joint` label, and records the decision under the wave directory. At
    close-out, `fleet-worker.sh wave decisions <wave.json>` prints the records as rows for the
    project's decisions ledger: add them to that file in one commit. A wave's own decision starts
    `unreviewed` there, and the maintainer's `ok`. When the maintainer answers a call the wave
    recorded, record the answer with `--tier 3` and the same `--call`: its row replaces the wave's.
