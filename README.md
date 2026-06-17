# Ludics

Autonomous task manager and personal AI infrastructure — a harness for humans working with AI agents. Ludics manages a small number of concurrent "slots," aggregates tasks from GitHub and READMEs, allows merging of overlapping tasks, provides flow-based task views, and wires triggers for briefings and syncs.

Inspired by Daniel Miessler's Personal AI Infrastructure, by Steve Yegge's Gas Town, and Emacs' org-mode. Formerly `pai-lite`.

## What you get

- **Slots**: 6 ephemeral "CPUs" for active work, not memory or identity.
- **Task index**: unified task list from GitHub issues and README TODOs.
- **Flow engine**: priority/dependency-based views (ready, blocked, critical, impact).
- **Adapters**: thin integrations with existing agent setups (tmux, claude.ai, manual; t3code is experimental).
- **Notifications**: ntfy.sh integration — outgoing (strategic), incoming (from phone), agents (operational).
- **Triggers**: launchd/systemd automation for briefings and syncs.

## Installation

```bash
# 1. Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# 2. Clone and build
gh repo clone lukstafi/ludics
cd ludics
bun install
bun run build    # compiles bin/ludics

# 3. Add to PATH (if not already)
export PATH="$PATH:$(pwd)/bin"
```

### Dependencies

**Required: [Bun](https://bun.sh) runtime (v1.1+)**

```bash
# Install Bun (macOS, Linux, WSL)
curl -fsSL https://bun.sh/install | bash
```

Then build the ludics binary:

```bash
cd ludics
bun install
bun run build
```

**Other dependencies:**

```bash
# macOS
brew install jq tmux

# Ubuntu/Debian
sudo apt install jq tmux
```

- `bun` — TypeScript runtime and build tool (required)
- `gh` — GitHub CLI (for cloning state repo and fetching issues)
- `jq` — JSON filtering (used by some adapters and triggers)
- `tmux` — terminal multiplexer (Mag runs in a tmux session)
- `ttyd` — optional, for web access to Mag's terminal

## Quickstart Tutorial

This tutorial walks through setting up ludics and using it to manage your work.

### Step 1: Configure your state repository

ludics stores state (slots, tasks) in a separate private repository. Edit the pointer config:

```bash
${EDITOR:-vi} ~/.config/ludics/config.yaml
```

Set your state repo:

```yaml
state_repo: your-username/your-private-repo
state_path: harness
```

### Step 2: Configure your projects

The full configuration lives in your state repo at `harness/config.yaml`. Create it manually (or use `ludics init` once it's migrated):

```bash
${EDITOR:-vi} ~/your-private-repo/harness/config.yaml
```

Add the projects you want to track:

```yaml
projects:
  - name: my-project
    repo: your-username/my-project
    issues: true          # Fetch GitHub issues

  - name: another-project
    repo: your-username/another-project
    issues: true

triggers:
  watch:
    - paths:
        - ~/repos/my-project/README.md   # Scan for checkboxes/TODOs
      action: tasks sync
```

### Step 3: Sync tasks from your projects

```bash
ludics tasks sync
```

This aggregates tasks from GitHub issues and README TODOs into `tasks.yaml`, automatically converts them to individual `.md` task files in `harness/tasks/`, and refreshes metadata for existing GitHub-backed tasks (including closed state). The flow engine reads these task files.

### Step 4: Verify triggers

Triggers automate Mag startup and periodic task sync via launchd (macOS) or systemd (Linux). If Mag is enabled in your config, a keepalive trigger also starts Mag at login and checks on the `mag.keepalive_interval` cadence (default: 60 seconds). Install them with:

Verify with:

```bash
ludics triggers status
```

To reinstall or update triggers separately:

```bash
ludics triggers install
```

To pause ongoing scheduled activity without deleting trigger files:

```bash
ludics stop
```

To fully remove all installed trigger units/plists:

```bash
ludics stop uninstall
```

### Step 5: Get an overview

```bash
# Quick status
ludics status

# Full briefing
ludics briefing
```

## Configuration

ludics uses a two-tier config:

1. **Pointer config** (`~/.config/ludics/config.yaml`): minimal, just points to state repo:
   ```yaml
   state_repo: your-username/your-private-repo
   state_path: harness   # optional, defaults to "harness"
   ```
2. **Full config** (`~/state-repo/harness/config.yaml`): projects, adapters, triggers, notifications — once this exists, the pointer config is only used to locate it.

For the full list of options and their defaults, see [`templates/config.reference.yaml`](templates/config.reference.yaml).

### Example full config

```yaml
state_repo: your-username/private-state
state_path: harness

projects:
  - name: my-app
    repo: your-username/my-app
    issues: true

mag:
  enabled: true

adapters:
  tmux:
    enabled: true
  manual:
    enabled: true
  t3code:
    enabled: false   # experimental; unsupported in v1.0

triggers:
  startup:
    enabled: true
    action: mag briefing --auto
  sync:
    enabled: true
    interval: 3600
    action: tasks sync
  watch:
    - paths:
        - ~/repos/my-app/README.md
      action: tasks sync

notifications:
  provider: ntfy
  topics:
    outgoing: your-username-from-Mag  # Mag → user (strategic, push to phone)
    incoming: your-username-to-Mag    # user → Mag (messages from phone)
    agents: your-username-agents      # system → user (operational)
```

### Adapter Args Layering

For orchestrated work (the `tmux` adapter plus orchestration flags such as
`--pair` / `--duo`; the experimental `t3code` adapter follows the same rules),
ludics builds final CLI args from multiple sources in this order:

1. `adapters.<adapter>.default_args`
2. `projects[].adapter_profiles.<adapter>`
3. Slot `Adapter Args` (`ludics slot <n> assign ... --adapter-args "..."`)
4. Task frontmatter `adapter_args` (highest precedence)

Later layers are appended last, so they override earlier options in typical CLI parsing.

#### 1) Global defaults for `tmux`

```yaml
adapters:
  tmux:
    enabled: true
    default_args:
      - --clarify
      - --plan
      - --work-timeout
      - "5400"
```

#### 2) Per-project profile for `tmux`

```yaml
projects:
  - name: my-app
    repo: your-username/my-app
    issues: true
    adapter_profiles:
      tmux:
        args:
          - --clarify
          - --pushback
          - --work-timeout
          - "4800"
          - --review-timeout
          - "2400"
```

#### 3) Per-task one-off override

In `tasks/task-123.md` frontmatter:

```yaml
---
id: task-123
title: "Tune auth rollout"
project: my-app
proposal: docs/task-123.md
adapter_args:
  - --work-timeout
  - "7200"
  - --pushback-timeout
  - "900"
---
```

You can also use shell-style strings:

```yaml
adapter_args: --clarify --plan --work-timeout 7200
```

#### Quoting passthrough flags

Arg parsing now supports shell-style quotes. This preserves values with spaces:

```bash
ludics slot 1 assign task-123 -a tmux --adapter-args '--claude-flags "--allowedTools Bash,Read" --codex-flags "--provider openai"'
```

Tip: for config and task files, prefer array form for maximum clarity and fewer quoting pitfalls.

## CLI Reference

### Task management

```bash
ludics tasks sync              # Aggregate tasks, convert files, refresh existing GitHub task metadata
ludics tasks list              # Show unified task list
ludics tasks show <id>         # Show task details
ludics tasks convert           # Convert tasks.yaml to task files (also run by sync)
ludics tasks update            # Refresh GitHub metadata for existing tasks (preserves local title edits)
ludics tasks create <title>    # Create a new task manually
ludics tasks files             # List individual task files
ludics tasks priority <id> <level>
                                # Set task priority (S, A, B, C, D); increases clear the auto-proposal debounce
ludics tasks status <id> <status>
                                # Set task status (one of: ready, in-progress, deferred, preempted, preempt-queued, done, abandoned, merged, needs-confirmation, blocked, stale)
```

### Flow engine

```bash
ludics flow ready              # Priority-sorted ready tasks
ludics flow blocked            # What's blocked and why
ludics flow critical           # Deadlines + high-priority
ludics flow impact <id>        # What this task unblocks
ludics flow context            # Context distribution across slots
ludics flow check-cycle        # Check for dependency cycles
```

### Slot management

```bash
ludics slots                   # Show all slots
ludics slot <n>                # Show slot n details
ludics slot <n> assign <task> [--machine <name>]  # Assign a task to slot n.
                                                  # In a federated setup (cluster.machines configured),
                                                  # --machine defaults to the current node (or the leader
                                                  # if the current host is not in cluster.machines);
                                                  # single-machine setups leave it null.
ludics slot <n> clear          # Clear slot n
ludics slot <n> start          # Start fresh agent session (use 'resume' for crash recovery)
ludics slot <n> stop           # Stop agent session
ludics slot <n> resume         # Resume crashed orchestrated session from persisted state
ludics slot <n> note "text"    # Add runtime note to slot n
ludics slot <n> reset          # Clear interrupted/escalated liveness (no process kill)
```

### Orchestration

```bash
ludics orch status <slot>         # Show orchestration state for a slot
ludics orch confirm <slot>        # Confirm current orchestration phase
ludics orch interrupt <slot>      # Interrupt active agents in the current phase
ludics orch skip <slot> <phase>   # Force orchestration to a specific phase
ludics orch log <slot>            # Show phase transition log for the slot
ludics orch diff <slot>           # Per-commit summary per worktree (stale-branch diagnosis)
```

### Notifications

```bash
ludics notify outgoing <msg>   # Send notification to user
ludics notify agents <msg>     # Send operational notification
ludics notify subscribe        # Subscribe to incoming messages (long-running)
ludics notify recent [n]       # Show recent notifications
```

### Mag (autonomous coordinator)

```bash
ludics mag briefing          # Request morning briefing
ludics mag suggest           # Get task suggestions
ludics mag analyze <issue>   # Analyze GitHub issue
ludics mag elaborate <id>    # Elaborate task into detailed spec
ludics mag health-check      # Check for deadlines, issues
ludics mag sync-learnings    # Queue a learnings-consolidation run
ludics mag queue             # Show pending requests
ludics mag queue pop one     # Atomic dequeue of one request
ludics mag queue pop all     # Atomic dequeue of all requests
ludics mag queue promote <id> # Move a pending request to the head of the queue
ludics mag queue cancel <id>  # Remove a pending request (prints the JSON line)
```

### Dashboard

```bash
ludics dashboard generate         # Generate JSON data for the dashboard
ludics dashboard serve [port]     # Serve dashboard (default port: 7678)
ludics dashboard stop             # Stop the dashboard server
ludics dashboard restart [port]   # Restart the dashboard server
ludics dashboard install          # Install dashboard assets to state repo
```

### t3code adapter (experimental)

> **Experimental — unsupported in v1.0.** The `t3code` adapter and these commands remain in the tree but are not part of the supported v1.0 surface. Use the `tmux` adapter for orchestrated work; t3code support may return in a future release as its stability improves.

```bash
ludics t3code [status]                    # Show shared t3code server status
ludics t3code start                       # Start the shared t3code server
ludics t3code stop                        # Stop the shared t3code server
ludics t3code doctor                      # Verify binary, process, HTTP, and WebSocket
ludics t3code integration-status          # Print "enabled" or "paused" (t3code feature flag)
ludics t3code thread <id> log [--last N]  # Show message history for a thread
ludics t3code thread <id> send [--wait] "<msg>"
                                          # Send a user message to a thread
ludics t3code thread <id> response        # Show last assistant response for a thread
ludics t3code slot <N> log [--agent coder|reviewer] [--last N]
                                          # Show message history for a slot's agent thread
ludics t3code slot <N> send [--agent coder|reviewer] [--wait] "<msg>"
                                          # Send a user message to a slot's agent thread
ludics t3code slot <N> response [--agent coder|reviewer]
                                          # Show last assistant response for a slot's agent
ludics t3code cleanup [--dry-run]         # Soft-delete stale threads/projects
```

### tmux adapter

```bash
ludics tmux status                  # Show tmux session state, windows, and ttyd processes
ludics tmux list-panes              # Show all panes with process state
ludics tmux attach <slot> [agent]   # Attach to a slot's agent tmux window
ludics tmux capture <slot> [agent]  # Capture pane content for debugging
```

### Sessions

```bash
ludics sessions [--json]            # Discover and classify all agent sessions
ludics sessions report [--json]     # Generate sessions report for Mag (Markdown + JSON)
ludics sessions refresh [--json]    # Re-run discovery and update report
ludics sessions show [filter]       # Show detailed session info (optional cwd/id filter)
ludics sessions sweep [--dry-run]   # Cleanup detached known sessions after 3 sweeps
```

### State sync

```bash
ludics sync           # Pull + push state repo (full sync)
ludics state pull     # Pull latest from state repo
ludics state push     # Push local changes to state repo
```

### Journal & events

```bash
ludics journal                # Show today's journal entries
ludics journal recent [n]     # Show last n journal entries
ludics journal list [days]    # List journal files from last n days
ludics events [--type X] [--task Y] [--scope S] [--source R] [--since T] [--limit N]
                              # Query the structured event log
```

### Cluster & network

```bash
ludics network status         # Show network configuration
ludics cluster status         # Show cluster status (multi-machine)
ludics cluster tick           # Publish heartbeat + run election
ludics cluster heartbeat      # Publish heartbeat only
ludics cluster ping <machine> # Ping another cluster machine
```

### Queue control

```bash
ludics queue hold     # Suppress automatic slot assignments
ludics queue resume   # Re-enable automatic slot assignments
ludics queue status   # Show whether queue is held or active
```

### Configuration

```bash
ludics config proposals-path <project>
                      # Print resolved proposals directory path for a project
```

### Misc

```bash
ludics quote          # Print a random quote
```

### Using skills directly

You don't need Mag to use ludics skills. Clone your harness repository and run Claude Code in the harness directory — skills like `ludics-briefing`, `ludics-elaborate`, and others work directly. This is useful for read-only tasks (checking status, getting briefings) or when you need something done immediately without waiting for Mag queue.

### Overview and setup

```bash
ludics status                  # Overview of slots + tasks
ludics briefing                # Morning briefing
ludics init                    # Full install/update: binary, skills, hooks, triggers
ludics stop                    # Pause scheduled trigger activity
ludics stop uninstall          # Uninstall trigger units/plists
ludics triggers install        # Reinstall launchd/systemd triggers only
ludics doctor                  # Check environment and dependencies
ludics help                    # Show help
```

## Adapters

Adapters are thin integrations that translate external state into slot format:

`tmux` and `manual` are the supported assignable adapters via `-a` (see `slot <n> assign`).
`t3code` is also assignable but experimental and unsupported in v1.0.
`claude-ai` and `chatgpt-com` stay registered for legacy bookmark-slot state reads.

| Adapter | Description |
|---------|-------------|
| `tmux` | Agent sessions (solo or orchestrated) managed in tmux — the primary, supported adapter |
| `manual` | Track human work without an agent |
| `t3code` | Multi-agent orchestration or single-thread coding via t3code — **experimental, unsupported in v1.0** |
| `claude-ai` | Treats bookmarked claude.ai URLs as sessions (state reads only) |
| `chatgpt-com` | Tracks ChatGPT browser sessions (state reads only) |

## Triggers

Triggers automate periodic actions:

- **macOS**: launchd agents for `startup`, `sync`, and Mag keepalive
- **Linux (Ubuntu)**: systemd user units and timers

If `mag.enabled` is `true` in your config, `triggers install` also creates a Mag keepalive service that starts Mag at login and checks on the `mag.keepalive_interval` cadence (default: 60 seconds).

Configure in `config.yaml` under `triggers:` and `mag:`. Then run:

```bash
ludics triggers install
```

Stop all scheduled trigger activity:

```bash
ludics stop
```

## Multi-machine setup

ludics supports running across multiple machines. All state lives in a git repository, so any machine with access can read slots, tasks, and flow views. For coordinating Mag (so only one instance runs at a time), ludics provides federation with Tailscale networking.

### How it works

- **Git-backed state**: every machine clones the same harness repo. Pull to see the latest state, push to share yours.
- **Tailscale networking**: optional MagicDNS-based hostname resolution for cross-machine URLs. Configure `cluster.transport: tailscale` in your harness config.
- **Seniority-based leader election**: nodes are listed in your config in priority order. The highest-priority node with a fresh heartbeat (< 15 min) becomes Mag leader. If the leader goes offline, the next node takes over automatically.
- **Heartbeats**: each node publishes a heartbeat every 5 minutes to `federation/heartbeats/`. The federation trigger handles this.

### Typical deployment

An always-on machine (e.g., Mac Mini) runs Mag 24/7 via launchd, while your laptop pulls state via git and runs worker slots. Any machine can also run ludics skills directly by opening Claude Code in the harness directory.

### Federation commands

```bash
ludics network status              # Show network configuration
ludics federation status           # Show leader, nodes, heartbeats
ludics federation tick             # Publish heartbeat + run election
ludics federation elect            # Run leader election only
ludics federation heartbeat        # Publish heartbeat only
```

Enable federation in your harness `config.yaml`:

```yaml
federation:
  transport: tailscale
  machines:
    - name: mac-mini
      host: mac-mini.tailnet-name.ts.net
      os: macos
      role: leader
      always_on: true
    - name: macbook
      host: macbook.tailnet-name.ts.net
      os: macos
      role: console

triggers:
  federation:
    enabled: true
    interval: 300
    action: federation tick
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, including:

- Slot model and lifecycle
- Flow engine design
- Mag (autonomous Claude Opus coordinator)
- Queue-based communication
- Notification tiers
- Multi-machine federation and deployment

## Development

```bash
bun install            # Install dependencies
bun run typecheck      # Type-check (tsc --noEmit)
bun run build          # Compile to bin/ludics
bun run dev            # Run directly from source (no compile)
```

- Core logic is TypeScript in `src/`. Adapters remain in Bash (`adapters/`).
- State changes to slots auto-commit to the state repo.

## License

MIT
