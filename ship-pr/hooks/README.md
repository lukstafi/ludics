# Optional stop nudge

`ship-pr-nudge.sh` reminds a session to consider `ship-pr` when a topic branch has
unlanded work and no PR. It works with Claude Code and Codex synchronous `Stop`
hooks: JSON arrives on stdin; exit 2 with a reason on stderr asks the agent to
continue once. It does not decide that a goal is finished or perform any landing.

## Install

Point the hook directly at your persistent ludics checkout. Merge this entry into
`hooks.Stop` in `~/.claude/settings.json` for Claude Code or `~/.codex/hooks.json`
for Codex, preserving any existing hooks:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/ludics/ship-pr/hooks/ship-pr-nudge.sh\"",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

The example assumes the checkout is at `~/ludics`; substitute its actual path
on each machine, keeping the shell quotes for paths containing spaces. Both clients
can use the same script directly. Use a persistent checkout, not a temporary task
worktree. The hook reads the repository to inspect from the event's `cwd`, so its
own location does not need to match the session's repository.

Skill discovery is separate: follow the repository README to make `ship-pr`
available to your agent. Hook registration does not require a skill-directory
symlink. Replace any older registration through `~/.claude/hooks/` or
`~/.claude/skills/` instead of keeping duplicate hooks.
Codex requires review/trust of newly configured hooks before running them. Keep
this hook synchronous: an asynchronous hook cannot request turn continuation.
See the [Codex hook reference](https://learn.chatgpt.com/docs/hooks) and
[Claude Code hook reference](https://code.claude.com/docs/en/hooks).

Requirements: Bash, Git, `gh` authenticated for the repository, and either `jq` or
Python 3 for JSON parsing. No settings are changed by installing the skill itself.

## Deliberate quiet cases

This is a reminder for incremental and exploratory conversations, not a completion
gate. It stays quiet on the default branch, detached HEAD, clean integrated topic
branches, and branches with **any** PR, including closed or merged PRs. A closed
PR can represent a deliberately abandoned experiment; opening a PR transfers
responsibility to the skill/coordinator rather than starting another monitor.
A PR counts when its head branch has the local branch's name or, for work pushed
under another name (`git push origin HEAD:<name>`), when it contains the local
HEAD commit. Local commits beyond such a PR's head are in no PR and still nudge.
The lookup asks origin's repository by its URL, and also gh's default repository
when the checkout has other remotes and origin is not `gh repo set-default`'s
choice: gh prefers a remote named `upstream`, so a staging checkout would
otherwise ask the parent and miss the PR that merged on origin.

A nudge is claimed at most once per session, worktree, branch, HEAD and porcelain
status. File contents are deliberately not hashed: editing the same dirty files
again does not nag the user at every turn. A new commit or changed set/status of
paths can permit another nudge. A Claude Code session with a human attending
(`CLAUDE_CODE_SESSION_ATTENDED=1`, as in the desktop app; `claude -p` sets `0`) is
nudged at most once per session, worktree and branch: the human decides when to land. The `stop_hook_active` guard prevents an immediate
continuation loop. Claims live in `${TMPDIR:-/tmp}/ship-pr-nudge` and are temporary.

GitHub failures, timeouts, missing dependencies, and unreadable Git state are
unknown and stay quiet without claiming the state. A successful empty
`gh pr list --state all` answer to every lookup is required before saying there is
no PR. The local `origin/HEAD` determines the base, falling back to `master` when
absent. Only then, with commits ahead, the hook fetches that base branch from
origin (`gh pr merge` does not update the local ref) and counts again: a branch
whose commits already landed stays quiet. A failed fetch still nudges, noting that
the count is against a possibly stale local ref. Each network call is bounded to
5 seconds and all of them together to 15, inside the 20-second hook timeout above.

Claude's recent unfinished task files defer the reminder without stamping. Codex
payloads have `turn_id` and skip that Claude-only probe; this hook does **not**
detect active Codex background commands or scheduled follow-ups. Both harnesses
also get a cheap recent-transcript question-tool check (`AskUserQuestion` or
`request_user_input`, including its async variant). This is a best-effort
heuristic, not a reliable account of pending questions or background work. The
reminder explicitly allows the agent to explain that work is still in progress
and stop. Do not register this as `SubagentStop`: a helper agent need not own
landing the whole task.

## Verify

```sh
python3 ship-pr/hooks/test-ship-pr-nudge.py
```

The suite uses scratch Git repositories and a mocked `gh`; it does not call
GitHub or modify installed hooks. It covers both payloads and parsers, deliberate
quiet cases, failed lookups, escaped paths, and deduplication. These are protocol
and script tests, not an end-to-end test inside either agent application.
