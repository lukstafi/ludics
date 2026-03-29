#!/usr/bin/env bun
// ludics — TypeScript entry point

import { runSessions } from "./sessions/index.ts";
import { runSlots, runSlot } from "./slots/index.ts";
import { runTasks } from "./tasks/index.ts";
import { stateFullSync, statePull, statePush } from "./state.ts";
import { journalRecent, journalList } from "./journal.ts";
import { runFlow } from "./flow.ts";
import { runNotify } from "./notify.ts";
import { runMag } from "./mag.ts";
import { runDashboard } from "./dashboard.ts";
import { runNetwork } from "./network.ts";
import { runFederation } from "./federation.ts";
import { runTriggers, triggersPause, triggersUninstall } from "./triggers.ts";
import { runInit } from "./init.ts";
import { slotsList } from "./slots/index.ts";
import { flowReady } from "./flow.ts";
import { runQuote } from "./quote.ts";
import { runEvents } from "./events.ts";
import { runT3Code } from "./t3code/index.ts";
import { runOrchestrationCli } from "./orchestration/index.ts";

const MIGRATED_COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  sessions: runSessions,
  slots: runSlots,
  slot: runSlot,
  tasks: runTasks,
  flow: runFlow,
  mag: runMag,
  notify: runNotify,
  dashboard: runDashboard,
  network: runNetwork,
  federation: runFederation,
  triggers: runTriggers,
  stop: async (args) => {
    const sub = args[0] ?? "";
    if (sub === "" || sub === "pause" || sub === "disable" || sub === "--pause") {
      triggersPause();
      return;
    }
    if (sub === "uninstall" || sub === "--uninstall") {
      triggersUninstall();
      return;
    }
    throw new Error(`unknown stop mode: ${sub} (use: pause, uninstall)`);
  },
  init: runInit,
  quote: async () => runQuote(),
  events: async (args) => runEvents(args),
  t3code: runT3Code,
  orch: runOrchestrationCli,
  orchestration: runOrchestrationCli,
  sync: async () => stateFullSync(),
  state: async (args) => {
    const sub = args[0] ?? "";
    if (sub === "pull") { statePull(); }
    else if (sub === "push") { statePush(); }
    else { throw new Error(`unknown state subcommand: ${sub} (use: pull, push)`); }
  },
  journal: async (args) => {
    const sub = args[0] ?? "";
    if (sub === "" || sub === "today") { journalRecent(); }
    else if (sub === "recent") { journalRecent(parseInt(args[1] ?? "20", 10)); }
    else if (sub === "list") { journalList(parseInt(args[1] ?? "7", 10)); }
    else { throw new Error(`unknown journal subcommand: ${sub}`); }
  },
  status: async () => {
    slotsList();
    console.log("");
    flowReady();
  },
  briefing: async () => {
    const { magBriefing } = await import("./mag.ts");
    magBriefing();
  },
  doctor: async () => {
    const { magDoctor } = await import("./mag.ts");
    magDoctor();
  },
};

const USAGE = `Usage: ludics <command>

Commands:
  slots                        Show all slots
  slots refresh                Refresh slot state from adapters
  slot <n>                     Show slot n
  slot <n> assign <task|desc> [-a adapter] [-s session] [-p path] [-A "adapter args"]
                               Assign a task to slot n
  slot <n> clear [in-progress|done|abandoned]
                               Clear slot n (optionally mark task in-progress/done/abandoned)
  slot <n> start               Start fresh agent session (use 'resume' for crash recovery)
  slot <n> stop                Stop agent session
  slot <n> resume              Resume orchestrated t3code session from persisted state (crash recovery)
  slot <n> note "text"         Add runtime note to slot n
  slot <n> preempt <task-id> [-a adapter] [-s session] [-p path] [-A "adapter args"]
                               Preempt slot for priority task (stashes current work)
  slot <n> restore             Restore previously preempted work to slot

  tasks sync                   Aggregate tasks, convert to task files, and refresh existing GitHub task metadata
  tasks list                   Show unified task list
  tasks show <id>              Show task details
  tasks convert                Convert tasks.yaml to individual task files (also run by sync)
  tasks update                 Refresh GitHub metadata for existing tasks (preserves local title edits)
  tasks create <title> [project] [priority] [--uses-browser]
                               Create a new task manually
  tasks files                  List individual task files
  tasks samples                Create sample tasks for testing
  tasks needs-elaboration      List tasks needing elaboration
  tasks queue-elaborations     Queue elaboration for unprocessed ready tasks
  tasks check <id>             Check if task needs elaboration
  tasks merge <target> <src..> Merge source task(s) into target
  tasks unmerge <source>       Unmerge a previously merged task
  tasks duplicates             Find potential duplicate tasks
  tasks migrate-refs [--dry-run]
                               Migrate legacy task-<number> IDs to deterministic IDs and rewrite references

  flow ready                   Priority-sorted ready tasks
  flow blocked                 What's blocked and why
  flow critical                Deadlines + high-priority
  flow impact <id>             What this task unblocks
  flow context                 Context distribution across slots
  flow check-cycle             Check for dependency cycles

  mag start [--no-ttyd]        Start Mag tmux session (with ttyd by default)
  mag stop                     Stop Mag tmux session
  mag status                   Show Mag status
  mag attach                   Attach to Mag tmux session
  mag logs [n]                 Show recent Mag activity
  mag doctor                   Health check for Mag setup
  mag briefing                 Request morning briefing
  mag suggest                  Get task suggestions
  mag elaborate <id>           Elaborate task into detailed spec
  mag draft-proposal <id>     Generate proposal document for task
  mag split-task <id>          Split multi-concern task into subtasks
  mag verify-completion <id>   Deep-inspect task completion, create follow-ups
  mag health-check             Check for deadlines, issues
  mag adopt-sessions [--force] Discover sessions and queue adoption for Mag
  mag process-suggestions <id> Queue suggestion processing for completed task
  mag message "text"           Send async message to Mag
  mag queue                    Show pending queue requests
  mag context                  Pre-compute briefing context file

  notify outgoing <msg>        Send notification to user
  notify agents <msg>          Send operational notification
  notify subscribe             Subscribe to incoming messages (long-running)
  notify recent [n]            Show recent notifications

  dashboard generate           Generate JSON data for dashboard
  dashboard serve [port]       Serve dashboard (default: 7678)
  dashboard stop               Stop the dashboard server
  dashboard restart [port]     Restart the dashboard server
  dashboard install            Install dashboard to state repo

  t3code [status]             Show shared t3code server status
  t3code start                Start the shared t3code server
  t3code stop                 Stop the shared t3code server
  t3code doctor               Verify t3code binary, process, HTTP reachability, and WebSocket
  t3code thread <id> log [--last N]
                              Show message history for a thread
  t3code thread <id> send [--wait] "<msg>"
                              Send a user message to a thread (--wait for response)
  t3code thread <id> response Show last assistant response for a thread
  t3code slot <N> log [--agent coder|reviewer] [--last N]
                              Show message history for a slot's agent thread
  t3code slot <N> send [--agent coder|reviewer] [--wait] "<msg>"
                              Send a user message to a slot's agent thread
  t3code slot <N> response [--agent coder|reviewer]
                              Show last assistant response for a slot's agent

  orch status <slot>          Show orchestration state for a slot
  orch confirm <slot>         Confirm the current orchestration phase
  orch interrupt <slot>       Interrupt active agents in the current phase
  orch skip <slot> <phase>    Force the orchestration to a different phase
  orch log <slot>             Show phase transition log for the slot

  sessions [--json]            Discover and classify all agent sessions
  sessions report [--json]     Generate sessions report for Mag (Markdown + JSON)
  sessions refresh [--json]    Re-run discovery and update report
  sessions show [filter]       Show detailed session info (optional cwd/id filter)
  sessions sweep [--dry-run]   Cleanup detached known sessions after 3 sweeps

  sync                         Pull + push state repo (full sync)
  state pull                   Pull latest from state repo
  state push                   Push local changes to state repo

  journal                      Show today's journal entries
  journal recent [n]           Show last n journal entries
  journal list [days]          List journal files from last n days

  events [--type X] [--task Y] [--scope S] [--source R] [--since T] [--limit N]
                               Query structured event log

  network status               Show network configuration
  federation status            Show federation status (multi-machine Mag)
  federation tick              Publish heartbeat and run leader election
  federation elect             Run leader election only
  federation heartbeat         Publish heartbeat only

  quote                        Print a random quote

  status                       Overview of slots + tasks
  briefing                     Morning briefing
  init [--no-hooks] [--no-dashboard] [--no-triggers] [--restart-t3code]
                               Initialize config, harness, hooks, dashboard, and triggers
  stop [pause|uninstall]       Stop scheduled activity (default: pause)
  triggers install             Install launchd/systemd triggers
  triggers pause               Pause/disable triggers without deleting unit files
  triggers status              Show trigger status
  triggers uninstall           Remove all triggers
  doctor                       Check system health and dependencies

  help                         Show this message`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "";

  if (cmd === "" || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    process.exit(0);
  }

  const handler = MIGRATED_COMMANDS[cmd];
  if (handler) {
    await handler(args.slice(1));
  } else {
    console.error(`ludics ${cmd}: not yet migrated`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`ludics: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
