# App workers: Claude desktop-app sessions on SSH hosts (explicit alternative)

Use this path only when the user explicitly chooses Claude app workers: Claude desktop app
sessions that the coordinator starts on the user's saved SSH connections. Each is a full Claude
Code session resident on a fleet box, in a worktree the app makes, linked to the coordinator. A
supervised wave alone is not that choice. Only a coordinator running in the Claude desktop app
has the tools: `list_start_targets` and `start_session` (`mcp__ccd_session__*`), and
`list_sessions`, `get_session` and `list_events` (`mcp__ccd_session_mgmt__*`), plus `SendMessage`.
Read their current schemas, and load deferred ones with `ToolSearch` first. Do not use `claude -p`,
tmux or `fleet-worker.sh launch` for an app worker. The transport was piloted on TUF-Linux
(2026-10-16). On any other connection, the startup report below is that connection's first check.

Before any execution leg, follow [execution reservations](executions.md), coordinator
integration included. An agent host does not reserve execution capacity.

## What runs on the box

The session is the app's own Claude Code build under `~/.claude/remote/ccd-cli/`, not the `claude`
on the box's PATH, so a CLI login there does not matter to it. Its parent is a
`~/.claude/remote/srv/.../server --serve` daemon owned by init. The app's ssh connection carries
only a `server --bridge` to that daemon's socket. In the pilot, the app's connection was killed
on the box partway through a 150 s foreground command. The turn ran to completion, the app
reconnected within about 2 s, and the end-of-turn note arrived. The Mac sleeping was not tested.

## Placement and launch

1. Call `list_start_targets`. Its `ssh[].name` entries are the connections, such as `TUF-Linux`.
   Pass one verbatim as `host`, never a raw hostname. A connection name is not a fleet box name
   (TUF-Linux is tuf-amd-linux), so record both. A box with no connection is a placement gate.
   Substituting another transport is refused by SKILL.md's *Launch*.
2. Claim the fleet coordinator lease, then run `fleet-worker.sh preflight <box> --native-claude`
   before each launch. The session loads the box's deployed skills and uses the app's login, so
   the CLI login and headless probe do not apply.
3. Write the self-contained brief and a pending entry to the board. Recheck rival PRs and
   dependencies, then run `fleet-worker.sh gate --target-repo <owner/repo> [--base-branch
   <branch>]` just before the start (SKILL.md: *Base gate*).
4. Start the worker with `start_session`, passing:
   - `initiation: "user_asked"`, `context: "fresh"`, `target: "ssh"` and the `host`;
   - `cwd`: the box's checkout, and `use_worktree: true`;
   - a recognizable `title` and `name`, the full brief as `prompt`, and `background`;
   - `model` only when the user chose one. The schema ignores a model above the coordinator's
     own, so a choice above it is a capability gate to report before launching. After the start,
     `get_session`'s `model` confirms the choice.

   The app starts a session only in a turn begun by the user's own chat message in the
   coordinator. It refused one in a turn begun by another session's message, and an
   `AskUserQuestion` answer did not count as the user's message. A `wrap_up` reply button did,
   because clicking it sends a chat message. So launch, in that turn, every app worker the user's
   wave request covers. A later launch, such as a dependent or a replacement, asks the user with a
   reply button first. `own_initiative` does not take `target: "ssh"`. The `permission_mode`
   field applies to local starts only, so the worker inherits the coordinator's mode (auto in
   the pilot). The app asked for no sign-in on a box it was already connected to.
5. The app makes the worktree at `<cwd>/.claude/worktrees/<random>`, on a branch named after the
   app's branch prefix (`claude/<random>`). It cuts the branch from the checkout's current local
   commit. On TUF that was a local master 1622 commits behind origin. The brief therefore requires
   these steps in the app's worktree before any edit: `git fetch <remote>`, a check of the
   verified base SHA, and `git switch -c <topic> <verified-sha>`. The brief names the
   development remote and base that the coordinator resolved, as
   [native-workers.md](native-workers.md#placement-and-launch) step 1 says. A SHA as the start point sets no upstream.
   The pilot's `git checkout -B <branch> origin/master` made origin/master the upstream.

   A replacement worker takes over the old worker's worktree, where the topic branch is
   already checked out. Start it only after the old writer is proven stopped as SKILL.md's
   *Intervene* bullet requires. That means its session process, which archiving stops, every
   child of it such as a `bg-run.sh` run, and its reservations. Pass `cwd`: the old `worktreePath` and `use_worktree: false`, which the
   schema defines as that folder as it is. Its brief names the topic branch, commits and PR
   where they exist. If the inherited worktree is still on the app's branch, the replacement
   runs the fresh-start steps above. That worktree is then cleaned up once, at close-out.
6. The result gives the `local_` session id and the `name`. `get_session` on that id reports
   `worktreePath`, `branch`, `model`, `permissionMode`, `isRemote` and `isRunning`. Record
   all of them.
   The brief names the coordinator's own `local_` id (`get_session "self"`). The worker's
   linked-sessions note names only the top session of the family, not the session that
   started it. The brief also names the expected `hostname`, which is the box name on this
   fleet: the pilot reported `tuf-amd-linux`. The worker's first command compares it. On a
   mismatch, the worker ends its turn with a report and touches nothing. Its startup report goes
   to the coordinator's id by `SendMessage`. It carries the hostname, the absolute worktree, the
   topic branch, the base SHA, and a harmless Git mutation with its exit status. Then the worker
   carries on with the task. Its final hand-back is the final message of its last turn.

## Board and recovery

App workers go on the same board as native workers. Its location and fields are in
[native-workers.md](native-workers.md#supervision-recovery-and-evidence). For a Claude app
worker the board also records:

- the SSH connection name and the box;
- the `local_` id and name;
- the app's worktree path and branch, and the topic branch;
- the permission mode.

A reservation for an app worker carries `"transport": "app"` and the box as `agent_host`.

`list_sessions {"linked": true}` lists the coordinator's family with each worker's state, and
`get_session` reads one worker. A worker's process lives under the daemon on its box, not under
the coordinator. A coordinator interruption therefore says nothing about whether the worker
stopped. After an interruption, reconcile each board entry with `get_session` and the box's
`ps` (the session's `ccd-cli` process), then resume through the same ids.

## Worker channel and supervision

An app worker is a Claude Code session, so [native-claude.md](native-claude.md) governs its
turns. Its *Blocking on a run* rules are the worker's, and its turn-shaped *Worker channel*
applies with these differences:

- **The note instead of the task notification.** When a worker ends a turn, the app gives the
  coordinator a note. If the coordinator is idle, the note continues it, and in the pilot every
  note did. A returned turn means only that the turn ended (SKILL.md, *Supervise*).
- **The note shows only the first 400 characters.** Read the worker's whole final message with
  `list_events`. Tool calls count as messages, so a small limit can return only the result
  line; the pilot needed about 12. Always read the whole message for an `EXECUTION_REQUEST`,
  which comes last.
- **Resume the worker by its id.** `SendMessage` with `to` set to the worker's `local_` id. In
  the pilot this started the idle worker's turn. The worker's `SendMessage` to the coordinator's
  id arrived as a cross-session message.

The worker wraps batches as the brief says, with `fleet-worker.sh execution slot -- <batch>`. In
the pilot that took slot 1 of 3 on tuf-amd-linux, with the sleep inhibitor held.

## Startup permissions

The worker runs in the coordinator's permission mode. A permission prompt appears only in the
worker's own session view, and while nobody looks, it stalls the worker. In auto mode the pilot
met no prompt for any of these:

- `git worktree add` and `git worktree remove`, `git fetch` and `git checkout`;
- `gh auth status` and `gh api`;
- `fleet-worker.sh execution slot`;
- `SendMessage`.

The startup report's Git mutation is the check. A worker that `get_session` shows running, with
no new transcript activity, may be on a prompt. Tell the user which session to open.

## Intervention and close-out

Correct, nudge or request the hand-back with `SendMessage` to the worker's id, and observe the
response. Escalation is SKILL.md's *Intervene* bullet. `archive_session` stopped the pilot's
process, and no `ccd-cli` process for it remained on the box. That tool needs the user's
explicit agreement for each session, so ask in a batch at close-out, or before a takeover that
needs the old writer stopped.

First collect the whole hand-back with `list_events` and verify it. Consolidate it as
SKILL.md's *Close out* requires.

Archiving left the worktree and the app's branch on the box. The app's `clean_up_worktrees`
does not work over SSH. Clean up only after the verified hand-back, the merge, the archive, and
a check that no process or reservation still uses the checkout. Run the cleanup in
[native-workers.md](native-workers.md#close-out-and-bounded-smoke) on the box:

1. Archive unique experiment inputs and instrumentation.
2. Run ship-pr's `post-merge-cleanup.sh <checkout> <worktreePath> <topic> --base <base>`, with
   the project's `--regenerable` directories. It refuses other ignored local data rather than
   deleting it. The helper works against `origin`. Where the development remote has another
   name, retain the worktree and report it.
3. Delete the app's own `claude/<random>` branch with `git -C <checkout> branch -D`. Once the worker has
   switched to its topic branch, no worktree has the app's branch checked out.

The pilot made no PR, so nobody has seen which session a worker's PR binds to.
[native-claude.md](native-claude.md#auto-fix-events-on-worker-prs) covers Auto-fix events
wherever the PR is bound.
