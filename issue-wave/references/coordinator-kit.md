# Coordinator kit

`fleet-worker.sh wave` is the per-wave tooling every coordinator used to rewrite under
`$ISSUE_WAVE_STATE/<wave>/` (ludics#1047). It has four verbs:

- a brief renderer;
- a native worker's launch prep;
- a restartable integration-loop driver;
- a heartbeat.

With the kit, the wave directory holds data only: no script is copied forward from the last
wave. The contracts are the module headers in `lib/ludics/fleetworker/`: `wave.py` for the wave
file and the heartbeat, `wavebrief.py`, `waveprep.py` and `waveloop.py`. This page covers what
a coordinator puts in the wave directory and when it calls each verb.

## The wave directory

```
<wave>/wave.json              the wave's facts, the only place a project's facts enter the kit
<wave>/tasks/<task>.md        each task's section
<wave>/legs.md, leg.md        the GPU-home-box legs section; leg.md is rendered once per leg into @@LEGLINES@@
<wave>/tail.md                optional, last: e.g. "where the task section differs, it wins"
<wave>/common.md              optional: overrides the shipped common sections
<wave>/planning-<mode>.md     optional: overrides a shipped paired-planning section (paired, paired+critique)
<wave>/project.md             optional: overrides the project part the wave file's project_part names
```

## The shipped brief template

A native Claude wave copies no brief text forward. The repository ships the reference template in
`issue-wave/templates/native-claude/`:

- `common.md`, the sections every worker's brief shares;
- `planning-paired.md` and `planning-paired+critique.md`, the paired-planning additions.

`wave prep` uses a shipped part whenever the wave directory has no part of that name, and the wave
directory's part wins when it has one (waveprep.py's header, *THE PARTS*). Nothing is shipped for
`codex` yet, so a native Codex wave still writes its own `common.md` and planning parts.

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

The loop driver writes `logs/loop-<name>.{json,log,lock}`.

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
