# Routines

The prompts behind the scheduled runs that feed the skills: the daily plan `issue-wave` reads,
the sweep that keeps OCANNL's non-CI backends honest, and the CI-red triage that owns
OCANNL master's trailing failures (ship-pr's post-merge owner there). Each directory holds one `SKILL.md` in the shape
Claude Code's scheduled tasks use: a `name` and `description` in the frontmatter, then the prompt.
CI's prompt hygiene job (`scripts/check-prompts.sh`) checks that shape, that `name` matches the
directory, and that each of these directories is named, in backticks, in the first cell of a row
of the table below.

Two kinds live here, and they are kept in sync differently.

| Routine | Kind | Fires | Runs in | Model | Feeds |
| --- | --- | --- | --- | --- | --- |
| `ocannl-cross-machine-sweep` | local scheduled task | daily 07:05 local (`5 7 * * *`), up to 699 s jitter, so 07:05–07:17 | `~/ocannl-staging` | Opus | `tools/sweep.sh` in OCANNL, `scripts/wake-lab.sh` |
| `daily-issue-planning` | local scheduled task | daily 06:45 local (`45 6 * * *`), up to 333 s jitter | `~/ocannl-staging` | Fable | the sequencing plan `issue-wave` reads |
| `ocannl-ci-red-triage` | cloud routine | on any non-PR master red except a dispatch naming its commit, fired by `ci.yml`; backstop daily 05:17 UTC (`17 5 * * *`) | Anthropic cloud, sources `lukstafi/ocannl-staging` and `ahrefs/ocannl` | Sonnet | the claiming issues OCANNL's mergers defer to |

The local scheduler adds a per-task jitter of a few minutes to the times above. The sweep's
times are the registry's (read with the scheduled-tasks list, 2026-09-23), and something outside
the Mac keys on them: tuf-amd-linux's RTC wake timer (`fleet-sweep-wake.timer`, from the
Linux bootstrap) fires at 06:55 so the gated tuf lane finds the laptop up. Move both together. Cron in the
local registry is the box's local time; the cloud routine's cron is UTC.

The cross-machine sweep starts after the planning run, which is light, so the two never contend
for `~/ocannl-staging`. (A daily formatting sweep used to run first; OCANNL formats per PR now,
through a CI gate, and the routine is retired.)

## Local scheduled tasks: copies, kept in sync by a script

A local scheduled task is two things: the prompt, at `~/.claude/scheduled-tasks/<id>/SKILL.md`,
and a registry entry in the desktop app (cron expression, working directory, model, enabled) that
names that file by path. The registry is not a file to edit by hand and is not in this repository;
the table above records its values so a task can be re-registered elsewhere.

The prompt directories must hold REAL files. Symlinking them, the way `~/.claude/skills/*` still
is, worked until desktop app 1.46388.4 (2026-09-06), which hardened the task-file reader to refuse
any path traversing a symlink. The failure is quiet: the task fires on time and is dispatched, the
prompt cannot be read, no session starts, and ten minutes later the dispatch is cleared as stale --
stamping `lastRunAt`, so the registry and the task list still look like it ran. Two symptoms give it
away: `Failed to read task file for <id>: symlink detected before open` followed by
`Cleared stale pending dispatch` in `~/Library/Logs/Claude/main.log` (a healthy run logs
`Confirmed task run for: <id>` instead), and an empty `description` for every task in the list,
because that too is read from the frontmatter of the file it will not open.

So this checkout stays canonical and `scripts/sync-routines.sh` copies between the two:

```sh
scripts/sync-routines.sh        # status: report drift, exit 1 if any
scripts/sync-routines.sh push   # this checkout -> ~/.claude/scheduled-tasks
scripts/sync-routines.sh pull   # ~/.claude/scheduled-tasks -> this checkout, then commit
```

`push` also converts a directory left over from the symlink era. Edit a prompt here and `push`; if
an edit lands in the installed copy instead -- a routine's own run editing its prompt in place --
`pull` it back and commit, rather than letting the two drift. `status` exits 1 on any drift, which
is what makes it worth running after a merge that touched a prompt.

The script is unforgiving about symlinks in three places, because the scheduler is. When either
end is reached through a link at an ancestor, the directories under it are each real while the
link is doing the damage. The rule is the filesystem's: publishing through a symlinked ancestor is
refused, since it writes into the link's target and leaves the link standing, while reading
through one is only warned about. So a symlinked `~/.claude/scheduled-tasks` refuses a `push` and
lets a `pull` through (the files behind it are real, and taking them is the recovery); a
symlinked `routines/` in this checkout refuses a `pull` and lets a `push` through. `status`
reports the destination one, because the scheduler will not open a task file whose path traverses
a link however the sync went. It refuses an
installed directory holding a link anywhere inside it, a linked `SKILL.md` included, which a plain
`diff -r` would follow and call in sync. And `push` replaces a link rather than writing through
it. It also refuses to `pull` from an installed directory with no
`SKILL.md` — that is a leftover, not a routine, and taking it would delete the tracked prompt
here — and from one whose `SKILL.md` is not a prompt: empty, opening with no
`---` fence, with frontmatter never closed, with no non-empty `name:` or `description:` field, or
with nothing under the frontmatter to run. Any of those installs just as happily and leaves the
scheduler a task it can read no name, no description and no instructions out of. Frontmatter
validation delegates to `scripts/check-prompts.sh --one <dir>`, using the same grammar and byte
checks as repository validation, including optional fields. CRLF frontmatter and malformed
optional fields are refused; use LF line endings and the checker's one-line scalar grammar.
Single-directory mode skips README indexing and name/directory equality, so an installed task ID
may differ from its prompt name. Sync separately requires a nonempty Markdown body and retains
its filesystem safety checks. A description that quotes `---` remains valid.

The two roots have to be disjoint, and that is checked on the resolved paths before anything is
written: a `CLAUDE_SCHEDULED_TASKS_DIR` pointing inside `routines/` would have the publisher walk
the tree it is writing and copy an installation into the canonical prompts. In the
other direction `pull` is the repair, and reads on past a checkout prompt that is broken in any of
those ways, a deleted routine directory and one linked out of the tree included: it restores them
from a usable installed copy. `push`
publishes file by file, staging each inside the destination and renaming it onto its final name,
so a dispatch that lands mid-push always finds a whole prompt: never a missing one, never a
half-written one. It replaces whatever stands in a file's way rather than following or entering it,
checks every step, and reads the result before reporting a routine published — not that a
`SKILL.md` is there, which a failed copy leaves standing, but that the destination now holds what
the source holds.

The script only touches the rows above whose Kind is `local scheduled task`, never the cloud
routine below, and its `LOCAL_ROUTINES` list is exactly those rows -- pinned by
`scripts/test-sync-routines.sh`, so adding a local scheduled task means editing both the table and
that list, and CI says so if only one of them changes.

On a fresh box, register the task first (the `schedule` tool in the desktop app, with the cron,
working directory and model from the table; it writes a placeholder `SKILL.md`), then `push` over
it. Registration and prompt are independent in both directions, and the script can see only one of
them: the registry is the desktop app's, so a missing prompt directory is no evidence the task is
unregistered (a prompt directory deleted under a live registry entry looks exactly the same), and
`push` says to check the app's task list rather than telling you what it found there.

Only the box running the desktop app's scheduler fires these. On the author's fleet that is
`mac-studio`, which is why both run in that box's `~/ocannl-staging`.

Retiring a routine is three steps, and the registry is the one the repository cannot do: delete
its directory here and its row above, then deregister the task in the desktop app, then remove
`~/.claude/scheduled-tasks/<id>`. The first step alone retires nothing on a box that already has
the task — the installed prompt stays, and so does the registry entry naming it by path, which
keeps firing. Because the script iterates the list above rather than the destination, a leftover
like that would be invisible, so a retired name goes into `RETIRED_ROUTINES` in
`scripts/sync-routines.sh` as a tombstone: the script then looks for it by name and says, in every
mode, that it is still installed and what the two remaining steps are. It removes nothing itself —
a prompt deleted while its registry entry stands makes the task fire and fail rather than stop.
The check is for a name that is present OR is a dangling link: a box installed by the old loop has
the task directory symlinked into this checkout, and deleting the target here leaves exactly that,
which a plain existence test calls absent. Drop the tombstone once the fleet is known to be clean.
`ocannl-format-sweep` is the one carried today.

### The push is manual, and two prompts watch for the day it is forgotten

Nothing installs a prompt on its own. Merging a change to `routines/<id>/SKILL.md` moves this
checkout and nothing else; the scheduler keeps dispatching the copy it already has until a person
runs, on the box that fires them (`mac-studio`):

```sh
git -C ~/ludics fetch origin \
  && git -C ~/ludics checkout main \
  && git -C ~/ludics merge --ff-only origin/main \
  && git -C ~/ludics rev-list --left-right --count HEAD...origin/main \
  && git -C ~/ludics status --porcelain -- routines scripts/sync-routines.sh \
  && ~/ludics/scripts/sync-routines.sh
```

Chained, not five separate lines: a fetch that fails on auth, DNS or the network leaves a stale
`origin/main` standing, and every command after it then agrees that a stale checkout is level with
the remote. Read the last three outputs before doing anything. The counts must be `0 0` — the
merge does NOT establish that, since `--ff-only` only refuses a merge it cannot fast-forward and
says "Already up to date" for a `main` that is AHEAD, carrying a prompt edit that never left this
box. The `status` line must print nothing — it covers `scripts/sync-routines.sh` as well as `routines/`,
since the next command runs that script and a local edit to its routine list or its publishing logic
would install a state nobody reviewed. Only then is the checkout canonical.

Then READ the sync status and choose the direction; there is deliberately no unconditional command
after it. The diff's orientation is not the direction — `sync-routines.sh` always diffs the checkout
first, so the checkout is the `-` side whether it is stale or holds the only copy of an edit; what
says which text is newer is provenance, `git log -- routines/<name>/SKILL.md` against what the diff
shows, and where that is unclear the answer is neither. `push` when the checkout holds the newer text — the usual case, a prompt that merged and
was never installed. `pull` when the INSTALLED copy does: a routine that edited its own prompt in
place is a supported workflow, and a push over it destroys the only copy of that edit before anyone
has committed it. When both sides have moved, neither: reconcile by hand.

The direction is a decision about the WHOLE run, not about one routine: `push` and `pull` take no
routine argument and apply their mode to every name in `LOCAL_ROUTINES`. So when the routines
disagree — one drifted with the checkout newer, another with the installed copy newer — there is
no direction to pick, and running either destroys one side of one of them. Reconcile by hand
first: copy the installed-only edit into the checkout and commit it (that is what a `pull` would
have done, done to one routine), leaving every remaining difference pointing the same way, and
only then run the sync.

Canonical is what makes a `push` safe, and nothing weaker will do: `push` installs whatever the
checkout holds, so out of a topic branch, a checkout ahead of `origin/main` — committed or not —
or one with an uncommitted edit under `routines/` or in the sync script itself, it publishes prompt text nobody reviewed into
the live scheduler, a worse failure than the drift it was fixing. `pull` needs none of that
gating: it writes into the checkout, where `git diff` shows it and review still stands between it
and the scheduler.

That is the whole discipline, and it is a step in `ship-pr`'s sense of "landed" for any PR that
touches a prompt here. A git hook could close the window, but installing one is a per-checkout
side effect this repository has no idiom for — `ship-pr/hooks` is an agent-harness `Stop` hook
merged into the harness's own settings, not a `.git/hooks` installer — so the push stays a
documented manual step (ludics-lite#199).

Forgetting it used to be invisible. The scheduler fires on time, the run looks normal, and the
routine's own record shows nothing amiss, because the only thing that is wrong is that the prompt
is old: on 2026-09-17 the cross-machine sweep was found to have run about a week on a revision
predating the `--hold` fix, which is exactly the coverage the sweep exists to provide. So the two
live prompts now read their own drift, which is the one report that reaches a human every day:

- each one's **step 0** runs `scripts/sync-routines.sh` and reads its OWN verdict line, since a
  DRIFT there means the instructions it is about to follow are not the ones that were merged;
- `daily-issue-planning` **also reports the whole verdict**, every routine's line, because it is
  the only run on this box that looks at the others (the sweep would not see a stale planning
  prompt, and a retired-but-installed routine belongs to neither);
- the sweep **notifies** on its own drift, every day it lasts — the same rule as a skip-coverage
  `FAIL`, and for the same reason: only a person can end it.

Neither routine pushes. The installed copies are live scheduler state, the direction of the drift
is a judgment (`push` if the checkout is canonical, `pull` if the edit was made in place), and a
routine that quietly re-installed its own prompt would be the silent step this all exists to
remove. `scripts/check-prompts.sh` pins the guard from the other side: every routine in
`LOCAL_ROUTINES` must name `sync-routines.sh` in its prompt, so the step 0 above cannot be edited
away without CI saying so.

Status mode compares the installed copies with the checkout, not with `origin/main`: a checkout
behind the remote reports `in sync` while the installed prompt is older than what merged. That is
why both prompts count `HEAD...origin/main` beside the verdict — against that ref by name, since
the checkout may sit on a topic branch whose own tracking state says nothing about `main` — and why
they call a checkout canonical only on `main`, with both counts at `0` and `routines/` clean:
installing from a checkout that is ahead, on another branch, or dirty publishes prompt text that
has not been through review into the live scheduler, which is worse than the drift it would be
fixing. Every push prescription in either prompt is gated on that one definition. It is also why the push recipe takes `origin/main` by
name first — a bare `git pull --ff-only` follows whatever the
current branch tracks, which on a checkout parked on a topic branch advances the wrong thing.

## The cloud routine: synced by hand

`ocannl-ci-red-triage/SKILL.md` is a copy of the prompt of the "ocannl-staging CI-red triage"
routine at claude.ai/code/routines; the cloud holds the live copy and nothing links them. Its
body is the prompt verbatim, so it can be diffed against the cloud copy. To change it, edit here,
land the change, then push the new body to the routine through the `schedule` skill's update
action, diffing the live prompt against the previous version of this file first in case someone
edited it in the web UI.

Deployed baseline: the cloud copy holds this file's body as of `ff8f22b3`, pushed 2026-10-03
(the live copy had lagged the repo until then); the next sync diffs the live prompt against
`SKILL.md` at that commit.

Its non-prompt configuration, for re-creating it:

| Setting | Value |
| --- | --- |
| Model | `claude-sonnet-5-5` |
| Environment | "Full access" (`anthropic_cloud`) |
| Sources | `https://github.com/lukstafi/ocannl-staging`, `https://github.com/ahrefs/ocannl` |
| Allowed tools | `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` (the GitHub MCP tools, `actions_run_trigger` among them, load through `ToolSearch` regardless) |
| MCP | `Claude_Code_Remote` (`https://api.anthropic.com/v1/code/mcp/meta`) |
| Fire API | `ci.yml`'s `notify-triage-routine` job, with the `ROUTINE_FIRE_URL` and `ROUTINE_FIRE_TOKEN` repository secrets |
| Notifications | none; findings reach people as issues on `ahrefs/ocannl` |

## Site configuration

Like the skills, these prompts name the author's setup in prose and are edited in place:
`~/self-improve/ClaudeDesktop/sequencing_plan.md` and the repository list in
`daily-issue-planning`; `~/ludics`, the checkout both prompts run their step-0 drift check in
(the clone path the top-level README installs); `~/ocannl-staging`, `~/.ocannl-sweep`, `~/bin/wake-lab.sh` and the box
names `rog`/`minix` (native Linux or WSL aliases, selected by `kind_of`) in the cross-machine sweep; the two OCANNL
repositories in the triage routine. `~/bin/wake-lab.sh` is a symlink to `scripts/wake-lab.sh` in
this checkout, so the cross-machine sweep's lab lore is reviewable here rather than living only on
`mac-studio` (ludics-lite#31); the fleet's MAC and IP addresses are the one part that stays out of
the repository, in the untracked `~/.config/wake-lab/hosts.sh` the script refuses to run without.
Both are installed by the "The lab script" section of the top-level README.

The OCANNL scripts they drive (`tools/sweep.sh`, `tools/aggregate-skips.sh`) live in that repository, and the outcome strings
the prompts teach the agent to read are those scripts' messages, so a change to a script's
wording is a change to its routine.
