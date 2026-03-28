# Phase 3: Orchestration Engine

Proposal for porting agent-duo's orchestration logic into Ludics as native TypeScript.

References:
- [agent-duo-migration.md](agent-duo-migration.md) — overall migration plan
- [~/agent-duo/docs/DESIGN.md](../../agent-duo/docs/DESIGN.md) — original architecture spec
- [~/agent-duo/skills/templates/](../../agent-duo/skills/templates/) — skill templates to port

---

## Prerequisite: Multi-Thread Slots in t3code Adapter

The current t3code adapter creates one thread per slot. Duo mode needs two (or more)
threads per slot — one per agent. This is the first change before any orchestration work.

### Changes to `src/adapters/t3code.ts`

- `start()` already stores `T3CodeSlotState.threads` as an array but only uses `[0]`.
  Extend to create N threads based on orchestration config.
- `readState()` iterates all threads in the slot, not just `threads[0]`.
- `stop()` already loops over all threads — no change needed.
- `lastActivity()` checks all threads, returns the most recent.

### Changes to `src/t3code/types.ts`

Add to `T3CodeSlotState`:

```typescript
export interface T3CodeSlotState {
  slot: number;
  threads: T3CodeThreadRecord[];
  orchestration?: OrchestrationRef;  // links to orchestration state if managed
}

export interface OrchestrationRef {
  stateFile: string;   // path to orchestration state JSON
  mode: "duo" | "pair";
}
```

---

## 3.1 — Phase State Machine (`src/orchestration/phases.ts`)

### Phase Definitions

Ported from agent-duo's DESIGN.md. Phases are the same for duo and pair modes,
with some phases skipped depending on mode and flags.

```typescript
export type Phase =
  | "setup"        // worktree creation, thread setup (Ludics-internal, not in agent-duo)
  | "gather"       // pair-only: reviewer collects codebase context
  | "clarify"      // agents propose approaches, ask questions
  | "pushback"     // agents suggest task spec improvements
  | "plan"         // agents write implementation plans
  | "plan-review"  // peer reviews plans (duo: both review; pair: reviewer verdicts)
  | "work"         // agents implement (parallel in duo, sequential in pair)
  | "review"       // agents review peer's code (parallel)
  | "update-docs"  // learning capture (AGENTS_STAGING.md, workflow feedback)
  | "pr-create"    // agents create PRs
  | "pr-comments"  // monitor GitHub PR comments, address feedback
  | "merge-vote"   // fresh agents analyze both PRs (duo only, when 2 PRs exist)
  | "merge-debate" // if votes disagree (max 2 rounds)
  | "merge-execute"// losing agent cherry-picks into winner's worktree
  | "merge-review" // winning agent reviews cherry-picks
  | "merge-amend"  // address merge review feedback (max 3 rounds)
  | "suggest-refactor" // post-merge: agents reflect on what they'd do differently
  | "final-merge"  // rebase, test, merge to main (auto-finish only)
  | "done";

export type PhaseCategory = "pre-work" | "main-loop" | "pr" | "merge" | "post-merge" | "terminal";
```

### Phase Graph

```
setup
  │
  ├─→ gather (if pair + --gather)
  ├─→ clarify (if --clarify)
  ├─→ pushback (if --pushback)
  ├─→ plan (if --plan)
  │     └─→ plan-review
  │
  └─→ work ←──────────────────────┐
       │                           │
       └─→ review                  │
             │                     │
             └─→ update-docs       │
                   │               │
                   └─→ [PRs exist?]│
                         NO ───────┘
                         YES
                          │
                          └─→ pr-comments
                                │
                                └─→ [2 PRs + ready?]
                                      NO → continue pr-comments
                                      YES
                                       │
                                       └─→ merge-vote
                                             │
                                             └─→ [consensus?]
                                                   YES → merge-execute
                                                   NO  → merge-debate (max 2)
                                                           │
                                                           └─→ merge-execute
                                                                 │
                                                                 └─→ merge-review
                                                                       │
                                                                       └─→ [APPROVE?]
                                                                             YES → pr-comments
                                                                             NO  → merge-amend (max 3)
                                                                                     │
                                                                                     └─→ merge-review

                          └─→ suggest-refactor (after PR merged)
                                │   Agents reflect on what they'd do differently.
                                │   Output: .peer-sync/suggest-refactor-<agent>.md
                                │
                                └─→ final-merge (if --auto-finish and remaining PR)
                                      │
                                      └─→ done
```

### Transition Rules

Each transition is a pure function: `(state, agentStatuses) → Phase | null`.

```typescript
export interface TransitionRule {
  from: Phase;
  to: Phase;
  /** Return true if transition should fire. */
  condition: (state: OrchestrationState) => boolean;
}
```

Key conditions (ported from agent-duo):
- **Pre-work → next**: both agents signaled `{phase}-done` OR timeout expired
- **work → review**: both agents `done` or `interrupted`
- **review → update-docs**: both agents `review-done` (skip if no peer changes)
- **update-docs → work**: no PRs exist yet → increment round, loop back
- **update-docs → pr-comments**: at least one PR exists
- **pr-comments → merge-vote**: 2 PRs exist, both reviewed, minimum rounds met
- **merge-vote → merge-execute**: consensus (both voted same)
- **merge-vote → merge-debate**: no consensus
- **merge-debate → merge-execute**: consensus after debate OR max debate rounds
- **merge-execute → merge-review**: cherry-picks complete
- **merge-review → pr-comments**: APPROVE
- **merge-review → merge-amend**: REQUEST_CHANGES (max 3 rounds)
- **pr-comments → suggest-refactor**: PR merged (detected via `gh pr view` or `.peer-sync/<agent>.pr`)
- **suggest-refactor → final-merge**: both agents `suggest-refactor-done` (if --auto-finish and remaining PR)
- **suggest-refactor → done**: both agents `suggest-refactor-done` (no remaining PR)
- **final-merge → done**: merged or timeout

---

## 3.2 — Orchestration State (`src/orchestration/state.ts`)

```typescript
export interface OrchestrationState {
  /** Ludics slot owning this orchestration. */
  slot: number;

  /** Feature name (from task spec or user). */
  feature: string;

  /** Orchestration mode. */
  mode: "duo" | "pair";

  /** Current phase. */
  phase: Phase;

  /** Current work/review round (1-indexed). */
  round: number;

  /** Merge-specific sub-round (0-indexed). */
  mergeRound: number;

  /** Agents participating. */
  agents: AgentConfig[];

  /** Per-agent runtime state. */
  agentStates: Record<string, AgentRuntimeState>;

  /** Timeouts and flags. */
  config: OrchestrationConfig;

  /** Phase entry timestamp (epoch seconds). */
  phaseStartedAt: number;

  /** Session start timestamp. */
  startedAt: string;

  /** Project directory (main repo, not worktree). */
  projectDir: string;

  /** Root worktree path (orchestrator's worktree). */
  rootWorktree: string;

  /** Path to .peer-sync/ directory. */
  peerSyncDir: string;

  /** t3code thread IDs per agent. */
  threadIds: Record<string, string>;

  /** Merge winner (set during merge phase). */
  mergeWinner?: string;
}

export interface AgentConfig {
  /** Agent name: "claude", "codex", etc. */
  name: string;

  /** t3code provider: "codex" | "claude-code" (obligatory, no default). */
  provider: T3ProviderKind;

  /** Role in pair mode: "coder" or "reviewer". */
  role?: "coder" | "reviewer";

  /** t3code model to use. */
  model: string;

  /** Git branch name. */
  branch: string;

  /** Worktree path. */
  worktreePath: string;
}

export interface AgentRuntimeState {
  /** Latest status from .peer-sync/<agent>.status */
  status: string;

  /** Epoch of last status update. */
  statusEpoch: number;

  /** Status message. */
  statusMessage: string;

  /** PR URL if created. */
  prUrl: string | null;

  /** Whether agent is interrupted. */
  interrupted: boolean;
}

export interface OrchestrationConfig {
  /** Phase timeouts in seconds. */
  timeouts: Record<string, number>;

  /** Polling interval in seconds. */
  pollInterval: number;

  /** Enable pre-work phases. */
  enableClarify: boolean;
  enablePushback: boolean;
  enablePlan: boolean;
  enableGather: boolean;   // pair-only

  /** Auto-finish: merge to main unattended. */
  autoFinish: boolean;
  autoFinishTimeout: number;

  /** Learning capture throttle. */
  learningInterval: number;
  learningProductiveRoundsGap: number;

  /** Use Mag for skill tailoring. */
  useMagTailoring: boolean;
}
```

### Default Timeouts

Ported from agent-duo's `agent-lib.sh`:

```typescript
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  work: 3600,         // 1 hour
  review: 1800,       // 30 minutes
  gather: 600,        // 10 minutes
  clarify: 600,
  pushback: 600,
  plan: 600,
  "plan-review": 600,
  "update-docs": 600,
  "pr-create": 600,
  "merge-vote": 600,
  "merge-debate": 600,
  "merge-execute": 1800,
  "merge-review": 600,
  "merge-amend": 600,
  "suggest-refactor": 600,
  "final-merge": 1800,
};

export const DEFAULT_POLL_INTERVAL = 10;        // seconds
export const DEFAULT_LEARNING_INTERVAL = 3600;  // seconds
export const DEFAULT_LEARNING_PRODUCTIVE_ROUNDS_GAP = 3;
export const DEFAULT_AUTO_FINISH_TIMEOUT = 1800;
```

### State Persistence

State is persisted to `harness/orchestration/slot-<N>.json` and updated on every
phase transition. Events are emitted to `journal/events.jsonl` via `emitEvent()`.

```typescript
export function stateFilePath(slot: number): string {
  return join(harnessDir(), "orchestration", `slot-${slot}.json`);
}
```

---

## 3.3 — Orchestration Runner (`src/orchestration/runner.ts`)

The main loop. Replaces agent-duo's `cmd_run` function (~300 lines of Bash).

```typescript
export async function runOrchestration(state: OrchestrationState): Promise<void> {
  persistState(state);

  while (state.phase !== "done") {
    // 1. Enter phase: write .peer-sync/, send skill messages
    await enterPhase(state);

    // 2. Poll until agents complete or timeout
    await pollUntilDone(state);

    // 3. Evaluate transition
    const next = evaluateTransition(state);
    if (!next) {
      // No valid transition — escalate or wait
      break;
    }

    emitEvent({
      event_type: "phase_transition",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.feature,
      action: `${state.phase} → ${next}`,
      status: next,
      message: `round ${state.round}`,
    });

    state.phase = next;
    state.phaseStartedAt = nowEpoch();
    persistState(state);
  }
}
```

### Phase Entry (`enterPhase`)

For each phase:
1. Write phase/round/phase-token to `.peer-sync/`
2. Compose skill message for each agent (template + context)
3. Send as turn message via t3code `thread.turn.start` command
4. Update agent status to the phase's "active" status

```typescript
async function enterPhase(state: OrchestrationState): Promise<void> {
  writePeerSync(state);

  for (const agent of state.agents) {
    // Skip agents not involved in this phase (e.g., coder-only phases in pair mode)
    if (!agentParticipatesInPhase(state, agent)) continue;

    const skillMessage = await composeSkillMessage(state, agent);
    await sendTurnMessage(state, agent, skillMessage);
  }
}
```

### Polling Loop (`pollUntilDone`)

Replaces agent-duo's `while ! ($agent1_done && $agent2_done)` loop.

```typescript
async function pollUntilDone(state: OrchestrationState): Promise<void> {
  const timeout = state.config.timeouts[state.phase] ?? 600;
  const deadline = state.phaseStartedAt + timeout;
  const interval = state.config.pollInterval * 1000;

  while (true) {
    // Read agent statuses from .peer-sync/
    refreshAgentStatuses(state);

    // Check if all participating agents are done
    if (allAgentsDone(state)) return;

    // Check timeout
    if (nowEpoch() >= deadline) {
      await handleTimeout(state);
      return;
    }

    await sleep(interval);
  }
}
```

### Status Reading

Read `.peer-sync/<agent>.status` files (pipe-delimited: `status|epoch|message`):

```typescript
function refreshAgentStatuses(state: OrchestrationState): void {
  for (const agent of state.agents) {
    const statusFile = join(state.peerSyncDir, `${agent.name}.status`);
    const content = readFileSync(statusFile, "utf-8").trim();
    const [status, epochStr, ...messageParts] = content.split("|");
    state.agentStates[agent.name] = {
      status: status ?? "unknown",
      statusEpoch: parseInt(epochStr ?? "0", 10),
      statusMessage: messageParts.join("|"),
      prUrl: state.agentStates[agent.name]?.prUrl ?? null,
      interrupted: state.agentStates[agent.name]?.interrupted ?? false,
    };
  }
}
```

### Timeout Handling

Different phases handle timeouts differently (same as agent-duo):

```typescript
async function handleTimeout(state: OrchestrationState): Promise<void> {
  const phase = state.phase;

  if (phase === "clarify" || phase === "pushback" || phase === "plan") {
    // Pre-work phases: just proceed, agents had their chance
    return;
  }

  if (phase === "work" || phase === "review") {
    // Main loop: interrupt agents that haven't finished
    for (const agent of state.agents) {
      if (!isAgentDone(state, agent)) {
        await interruptAgent(state, agent);
      }
    }
    return;
  }

  // Other phases: proceed without interrupting
}
```

### Agent Interruption

Write interrupt file + send t3code interrupt command:

```typescript
async function interruptAgent(state: OrchestrationState, agent: AgentConfig): Promise<void> {
  // Write interrupt file (agent observes via .peer-sync/)
  writeFileSync(join(state.peerSyncDir, `${agent.name}.interrupt`), "");

  // Also interrupt via t3code
  const threadId = state.threadIds[agent.name];
  if (threadId) {
    const record = readServerRecord();
    if (record) {
      await withClient(record, async (client) => {
        await client.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: makeId("cmd"),
          threadId,
          createdAt: isoNow(),
        });
      });
    }
  }

  state.agentStates[agent.name]!.interrupted = true;
}
```

---

## 3.4 — Skill Message Composition (`src/orchestration/skills.ts`)

### Skill Templates

Port agent-duo's 33 skill templates from `skills/templates/` to `skills/orchestration/`.
Templates are Markdown files with structured sections.

File naming: `skills/orchestration/{phase}.md` (e.g., `work.md`, `review.md`).

For pair mode variants: `skills/orchestration/pair-{role}-{phase}.md`.

### Context Object

```typescript
export interface SkillContext {
  phase: Phase;
  round: number;
  mode: "duo" | "pair";
  agent: AgentConfig;
  peer: AgentConfig | null;
  taskSpec: string;              // contents of feature spec file
  peerReview: string | null;     // previous round's review from .peer-sync/reviews/
  peerStatus: string | null;     // peer's current status string
  peerPlan: string | null;       // peer's plan (during plan-review)
  gitDiffStat: string | null;    // git diff --stat main...HEAD in agent's worktree
  previousRoundSummary: string | null;
  mergeVotes: string | null;     // during merge phases
}
```

### Composition Pipeline

```typescript
export async function composeSkillMessage(
  state: OrchestrationState,
  agent: AgentConfig,
): Promise<string> {
  const context = buildSkillContext(state, agent);
  const templatePath = resolveTemplatePath(state.phase, state.mode, agent.role);
  const template = readFileSync(templatePath, "utf-8");

  // Static substitution (always works, no Mag needed)
  let message = substituteTemplate(template, context);

  // Optional Mag tailoring
  if (state.config.useMagTailoring) {
    message = await magTailorSkill(message, context);
  }

  return message;
}
```

### Static Substitution

Replace placeholders with context values. Simpler than agent-duo's `{{PEER_SYNC}}`
shell vars — we inject actual content rather than file paths:

```typescript
function substituteTemplate(template: string, ctx: SkillContext): string {
  return template
    .replace(/\{\{PHASE\}\}/g, ctx.phase)
    .replace(/\{\{ROUND\}\}/g, String(ctx.round))
    .replace(/\{\{AGENT_NAME\}\}/g, ctx.agent.name)
    .replace(/\{\{PEER_NAME\}\}/g, ctx.peer?.name ?? "none")
    .replace(/\{\{TASK_SPEC\}\}/g, ctx.taskSpec)
    .replace(/\{\{PEER_REVIEW\}\}/g, ctx.peerReview ?? "(no review yet)")
    .replace(/\{\{PEER_STATUS\}\}/g, ctx.peerStatus ?? "unknown")
    .replace(/\{\{GIT_DIFF_STAT\}\}/g, ctx.gitDiffStat ?? "(no changes)")
    .replace(/\{\{PEER_PLAN\}\}/g, ctx.peerPlan ?? "(no plan)")
    .replace(/\{\{MERGE_VOTES\}\}/g, ctx.mergeVotes ?? "");
}
```

### Sending via t3code

```typescript
async function sendTurnMessage(
  state: OrchestrationState,
  agent: AgentConfig,
  message: string,
): Promise<void> {
  const threadId = state.threadIds[agent.name];
  const record = readServerRecord();
  if (!record || !threadId) throw new Error(`no t3code thread for agent ${agent.name}`);

  await withClient(record, async (client) => {
    await client.dispatchCommand({
      type: "thread.turn.start",
      commandId: makeId("cmd"),
      threadId,
      message: {
        messageId: makeId("msg"),
        role: "user",
        text: message,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: isoNow(),
    });
  });
}
```

---

## 3.5 — Git Worktree Management (`src/orchestration/worktrees.ts`)

Ported from agent-duo's worktree creation logic.

### Worktree Layout

```
~/myproject/                        (main repo — not a worktree)
├── .agent-sessions/                (session registry)
│
~/myproject-feat/                   (root worktree — orchestrator state)
├── .peer-sync/                     (shared coordination directory)
│   ├── feature                     ("feat")
│   ├── mode                        ("duo" or "pair")
│   ├── phase                       (current phase)
│   ├── phase-token                 (UUID for dedup)
│   ├── round                       (current round)
│   ├── <agent>.status              (status|epoch|message)
│   ├── <agent>.interrupt           (empty file, signals interrupt)
│   ├── <agent>.pr                  (PR URL)
│   ├── reviews/                    (per-round reviews)
│   ├── merge-votes/                (voting files)
│   └── workflow-feedback-<agent>.md
│
~/myproject-feat-codex/             (agent worktree, codex)
├── .peer-sync -> ../myproject-feat/.peer-sync  (symlink)
│
~/myproject-feat-claude/            (agent worktree, claude)
├── .peer-sync -> ../myproject-feat/.peer-sync  (symlink)
```

### Functions

```typescript
export interface WorktreeSetup {
  rootWorktree: string;
  peerSyncDir: string;
  agentWorktrees: Record<string, string>;
  branches: Record<string, string>;
}

/** Create root + agent worktrees. Returns paths. */
export function createWorktrees(
  projectDir: string,
  feature: string,
  agents: AgentConfig[],
  mainBranch: string,
): WorktreeSetup { ... }

/** Set up .peer-sync/ directory with initial state. */
export function initPeerSync(
  peerSyncDir: string,
  feature: string,
  mode: "duo" | "pair",
  agents: AgentConfig[],
): void { ... }

/** Symlink .peer-sync into agent worktrees. */
export function symlinkPeerSync(
  peerSyncDir: string,
  agentWorktrees: Record<string, string>,
): void { ... }

/** Clean up worktrees on completion. */
export function cleanupWorktrees(
  projectDir: string,
  feature: string,
  agents: AgentConfig[],
): void { ... }
```

---

## 3.6 — Merge Logic (`src/orchestration/merge.ts`)

The merge phase is the most complex. Ported from agent-duo's merge-vote/debate/execute
workflow. Only applies in duo mode when both agents have created PRs.

### Merge Sub-Phases

1. **merge-vote**: Both agents analyze both PRs, vote for winner
2. **merge-debate** (if no consensus): Agents reconsider (max 2 rounds)
3. **merge-execute**: Losing agent works in winner's worktree, cherry-picks best parts
4. **merge-review**: Winning agent reviews cherry-picks
5. **merge-amend**: If REQUEST_CHANGES, losing agent addresses feedback (max 3 rounds)

### Functions

```typescript
/** Read vote files from .peer-sync/merge-votes/ */
export function readMergeVotes(
  peerSyncDir: string,
  round: number,
): Record<string, string> { ... }

/** Check if votes agree. */
export function hasConsensus(votes: Record<string, string>): boolean { ... }

/** Determine winner from votes (majority or first voter if tied after debate). */
export function determineWinner(
  votes: Record<string, string>,
  debateRounds: number,
): string { ... }
```

---

## 3.7 — `.peer-sync/` Writer (`src/orchestration/peer-sync.ts`)

Ludics is the **single writer** of coordination state. Agents only read.

```typescript
/** Write phase transition to .peer-sync/. */
export function writePeerSync(state: OrchestrationState): void {
  const dir = state.peerSyncDir;
  writeFileSync(join(dir, "phase"), state.phase);
  writeFileSync(join(dir, "phase-token"), crypto.randomUUID());
  writeFileSync(join(dir, "round"), String(state.round));
  writeFileSync(join(dir, "feature"), state.feature);
  writeFileSync(join(dir, "mode"), state.mode);
}

/** Read agent status from .peer-sync/<agent>.status. */
export function readAgentStatus(dir: string, agent: string): {
  status: string; epoch: number; message: string;
} { ... }

/** Write interrupt file. */
export function writeInterrupt(dir: string, agent: string): void { ... }

/** Clear interrupt file. */
export function clearInterrupt(dir: string, agent: string): void { ... }
```

---

## 3.8 — Learning Capture (`src/orchestration/learning.ts`)

Ported from agent-duo's update-docs phase. Throttled to avoid redundant updates.

```typescript
export function shouldRunUpdateDocs(state: OrchestrationState): boolean {
  // Check minimum interval since last update-docs
  // Check minimum productive rounds since last update-docs
  return true; // or false if throttled
}
```

Workflow feedback files (`.peer-sync/workflow-feedback-<agent>.md`) are read by the
existing feedback digest pipeline (`ludics mag feedback-digest`). No changes needed.

---

## Integration Touchpoints

### Adapter Changes

The t3code adapter gains a `"duo"` / `"pair"` mode:

```
ludics slot assign 1 my-task t3code --duo
ludics slot assign 1 my-task t3code --pair --coder codex --reviewer codex
```

When `--duo` or `--pair` is passed:
1. Adapter creates worktrees via `createWorktrees()`
2. Creates one t3code thread per agent (workspace = agent worktree)
3. Stores all thread IDs in `T3CodeSlotState.threads[]`
4. Stores orchestration ref in `T3CodeSlotState.orchestration`
5. Launches `runOrchestration()` as a background task

### CLI Commands

```
ludics orch status <slot>       # Show phase, round, agent statuses
ludics orch confirm <slot>      # Approve clarify/pushback (user reviewed proposals)
ludics orch interrupt <slot>    # Force-interrupt current phase
ludics orch skip <slot> <phase> # Jump to specific phase
ludics orch log <slot>          # Phase transition history from events.jsonl
```

### Event Emission

Every phase transition emits to `events.jsonl`:

```json
{
  "ts": "2026-03-07T15:30:00Z",
  "epoch": 1741361400,
  "event_type": "phase_transition",
  "source": "orchestration",
  "scope": "slot",
  "slot": 1,
  "task": "my-feature",
  "action": "work → review",
  "status": "review",
  "message": "round 2"
}
```

---

## Implementation Order

1. **Multi-thread slots** — extend t3code adapter to create/manage N threads per slot
2. **State + phases** — `state.ts`, `phases.ts` with types and transition rules
3. **Peer-sync writer** — `peer-sync.ts` for writing coordination files
4. **Worktrees** — `worktrees.ts` for git worktree lifecycle
5. **Skills** — `skills.ts` + port templates to `skills/orchestration/`
6. **Runner** — `runner.ts` with poll loop, phase entry, timeout handling
7. **Merge** — `merge.ts` for voting/debate/execute/review cycle
8. **Learning** — `learning.ts` for update-docs throttling
9. **CLI** — `ludics orch` subcommands
10. **Tests** — unit tests for transitions, worktree setup, skill composition

Steps 1-5 can be developed incrementally. Step 6 (runner) ties everything together.
Steps 7-8 can follow after the main work→review loop is proven.

---

## Design Decisions (Resolved)

1. **Agent signaling mechanism**: Keep `.peer-sync/<agent>.status` writes — the proven
   pattern from agent-duo. Codex has full shell access inside t3code, so skill templates
   include `echo "done|$(date +%s)|msg" > .peer-sync/<agent>.status` as before.
   Supplement with t3code turn completion events (`latestTurn.state === "completed"`)
   as a secondary signal — if the turn completes but no status file appears within a
   grace period, treat as done-with-no-message.

2. **Background orchestration**: `runOrchestration()` launches as a detached `Bun.spawn()`
   subprocess from `slot assign --duo` / `--pair`. The subprocess PID is stored in slot
   state for lifecycle management (`slot clear` sends SIGTERM). For crash recovery, the
   existing `triggers` system can periodically check for orphaned orchestration states
   and restart them — but this is a future enhancement, not required for initial launch.

3. **Pair mode threads**: Two threads, one per agent. Each agent has its own t3code
   thread, worktree, and context window, even when both are backed by the same model
   (e.g., two Codex threads). Role switching (coder ↔ reviewer) is handled by sending
   different skill messages to each thread per phase, not by reusing a single thread.

4. **PR detection**: Primary: agent writes `.peer-sync/<agent>.pr` (skill template
   instructs the agent to do this after `gh pr create`). Secondary fallback: Ludics
   polls `gh pr list --head <branch>` if no `.pr` file appears within a timeout.
   t3code events are not used for PR detection — too noisy and unreliable.

5. **Provider field is obligatory**: `AgentConfig.provider` must be explicitly set
   (`"codex"` or `"claude-code"`). No silent default — the caller chooses the provider.
   Passed through to `T3ThreadTurnStartCommand.provider` on every turn. This keeps
   Ludics provider-agnostic while making the config explicit.
