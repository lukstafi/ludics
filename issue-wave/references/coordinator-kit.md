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
<wave>/common.md              the brief's common sections (copied from the newest wave of the same transport)
<wave>/tasks/<task>.md        each task's section
<wave>/legs.md, leg.md        the GPU-home-box legs section; leg.md is rendered once per leg into @@LEGLINES@@
<wave>/planning-<mode>.md     the paired-planning section, one file per mode (paired, paired+critique)
<wave>/tail.md                optional, last: e.g. "where the task section differs, it wins"
```

Prep writes these:

```
briefs/brief-<task>.md   the rendered brief
reserve/<task>*.json     the standing reservation payloads
reserve/<task>-base.json `execution assign`'s base
scratch/<task>/runs/     the worker's run parent
prep/<task>.json         prep's manifest
```

The loop driver writes `logs/loop-<name>.{json,log,lock}`.

`wave.json` is a fail-closed allowlist (wave.py's header lists every key). A minimal native
Claude wave, with one GPU home box and one loop, looks like this:

```json
{"wave": "wave-20261110-ocannl", "repository": "lukstafi/ocannl-staging", "issue_repository": "ahrefs/ocannl",
 "checkout": "/Users/lukstafi/ocannl-staging", "worker_prefix": "w1110", "agent_host": "mac-studio",
 "transport": "subagent", "kind": "claude",
 "standing_purpose": "standing iteration: targeted aliases for @@T@@, slot-wrapped",
 "vars": {"COORDINATOR": "local_..."},
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
