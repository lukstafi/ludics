# Proposal: gh-ludics-48 — Port agent-duo orchestrated workflows to t3code

## Summary

The orchestration engine is already fully ported to t3code. This proposal covers the remaining work: enriching skill templates with agent-duo improvement ideas, adding a status-check guard in the runner, and closing out obsolete agent-duo issues.

## Work Items

### 1. Enrich skill templates (7 templates touched)

**1a. Work phase — batch-size guidance (gh-agent-duo-31)**

File: `skills/orchestration/work.md` and `skills/orchestration/pair-coder-work.md`

Add after the task spec block:

```markdown
Scope guidance:
- If the task involves many files, work in batches of 4–6 files per commit.
- Commit each batch before starting the next so the reviewer can give incremental feedback.
- Prefer smaller, well-tested commits over one large commit.
```

**1b. Work phase — quick-check commands (gh-agent-duo-38)**

Same files as 1a. Add near the "Rules" section:

```markdown
Before signaling done, run quick checks:
- Build: the project's primary build command (e.g., `make`, `dune build`, `npm run build`)
- Lint: the project's lint command if available
- Targeted tests: run only the tests related to changed files, not the full suite
```

**1c. Work phase — non-code deliverables note (gh-agent-duo-45)**

Same files. Add a conditional note:

```markdown
- If the task involves documentation or non-code deliverables, substitute "run tests" with "verify compilation/rendering of the output" and confirm the deliverable matches the spec format.
```

**1d. Update-docs — docs update and commit strategy (gh-agent-duo-32)**

File: `skills/orchestration/update-docs.md`

Expand the template to:

```markdown
# Update Docs

Capture durable learnings after round {{ROUND}}.

- Update `{{WORKFLOW_FEEDBACK_FILE}}` with process/tooling feedback.
- If you have a concise implementation summary, append it there too.
- If a PR is already open, keep `{{PR_FILE}}` accurate.
- If you restructured code, update architecture docs (ARCHITECTURE.md, README relevant sections).
- For multi-item commits, use one logical commit per distinct change — don't bundle unrelated items.

Shell note: when writing file paths in heredocs, use double-quoted heredocs (`<<EOF`) to expand variables, not single-quoted (`<<'EOF'`).

Finish with:

\`\`\`sh
printf '%s|%s|docs updated\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
\`\`\`
```

This also addresses gh-agent-duo-43 (shell variable expansion guidance).

**1e. Review phase — separate actionable items from history (gh-agent-duo-47)**

Files: `skills/orchestration/review.md` and `skills/orchestration/pair-reviewer-review.md`

Enrich the review template:

```markdown
# Review

Review the peer's implementation from your worktree context.

Peer status: `{{PEER_STATUS}}`
Peer worktree: `{{PEER_WORKTREE_PATH}}`

Structure your review as:
1. **Verdict**: `APPROVE` or `REQUEST_CHANGES` (first line)
2. **Action Items**: concrete changes needed (bullet list)
3. **Observations**: non-blocking notes, style suggestions, context for future rounds

Write to `{{REVIEW_FILE}}`. Keep action items clearly separated from observations so the coder can prioritize.

Then mark completion:

\`\`\`sh
printf '%s|%s|review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
\`\`\`
```

**1f. Review phase — document missing review in round 1 (gh-agent-duo-46)**

Files: `skills/orchestration/work.md` and `skills/orchestration/pair-coder-work.md`

Change the "Peer review from prior round" section to include a note:

```markdown
Peer review from prior round (empty in round 1 — this is expected):

{{PEER_REVIEW}}
```

**1g. Clarify and plan templates — task context enrichment note**

No template change needed for gh-agent-duo-41 at the template level; the code change in `skills.ts` handles this (see item 2 below).

### 2. Code changes (2 files)

**2a. Enrich task context with GitHub issue body — `src/orchestration/skills.ts`**

In `taskSpecText()`, when the task file exists, also attempt to extract and append the GitHub issue URL from the task frontmatter. If found, fetch the issue body using `gh issue view` and append it as supplementary context.

```typescript
function taskSpecText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) {
    return state.slotTitle?.trim() || state.feature;
  }
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  if (!content) return taskId;

  // Try to extract and append GitHub issue body
  const urlMatch = content.match(/^url:\s*"?https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)"?/m);
  if (urlMatch) {
    const issueBody = ghIssueBody(urlMatch[1], urlMatch[2]);
    if (issueBody) {
      return `${content}\n\n---\n## GitHub Issue Body\n\n${issueBody}`;
    }
  }
  return content;
}

function ghIssueBody(repo: string, issue: string): string | null {
  try {
    const result = Bun.spawnSync(
      ["gh", "issue", "view", issue, "--repo", repo, "--json", "body", "-q", ".body"],
      { stdout: "pipe", stderr: "ignore", env: process.env as Record<string, string> },
    );
    if (result.exitCode !== 0) return null;
    const body = result.stdout.toString().trim();
    return body || null;
  } catch {
    return null;
  }
}
```

This addresses gh-agent-duo-41 (enrich task context with issue body).

**2b. Status-check guard in `markActiveAgents()` — `src/orchestration/runner.ts`**

In `markActiveAgents()`, skip overwriting the agent status if the agent has already signaled a meaningful completion status for the current phase. This prevents re-signaling issues (gh-agent-duo-44).

```typescript
function markActiveAgents(state: OrchestrationState): void {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    // Don't overwrite if agent already has a meaningful status for this phase
    if (runtime.status.endsWith("-done") || runtime.status === "done" || runtime.status === "merged") {
      continue;
    }
    runtime.status = phaseActiveStatus(state.phase);
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = `entered ${state.phase}`;
    runtime.interrupted = false;
    clearInterrupt(state.peerSyncDir, agent.name);
  }
}
```

### 3. Agent-duo issue triage actions

**Close with reference to t3code orchestration** (covered or superseded):

| Issue | Title | Reason |
|-------|-------|--------|
| gh-agent-duo-31 | Batch sizes for large-scope rounds | Incorporated into work template (1a) |
| gh-agent-duo-32 | Docs updates and commit strategy | Incorporated into update-docs template (1d) |
| gh-agent-duo-38 | Quick-check command set | Incorporated into work template (1b) |
| gh-agent-duo-41 | Enrich task context with issue body | Implemented in skills.ts (2a) |
| gh-agent-duo-43 | Shell variable expansion guidance | Incorporated into update-docs template (1d) |
| gh-agent-duo-44 | Check already-signaled status | Implemented in runner.ts (2b) |
| gh-agent-duo-45 | Non-code deliverables support | Incorporated into work template (1c) |
| gh-agent-duo-46 | Document missing review in round 1 | Incorporated into work template (1f) |
| gh-agent-duo-47 | Separate actionable items from history | Incorporated into review template (1e) |
| gh-agent-duo-35 | PR phase docs-update re-entry | Superseded — t3code threads handle token limits differently |
| gh-agent-duo-36 | Verification pre-flight | Superseded — t3code manages tool deps via runtime mode |
| gh-agent-duo-39 | ttyd links in notifications | Superseded — t3code web UI provides links directly |
| gh-agent-duo-42 | Shared CLI passthrough helper | Superseded — t3code adapter handles arg parsing natively |

**Leave open** (distinct future work, not covered by this port):

| Issue | Title | Reason |
|-------|-------|--------|
| gh-agent-duo-29 | Brainstorm/party-mode phase | Genuinely new feature, not a port item |
| gh-agent-duo-40 | Gemini CLI provider | Provider expansion, orthogonal to orchestration |
| gh-agent-duo-48 | Cursor CLI provider | Provider expansion, orthogonal to orchestration |

### 4. Legacy adapter removal confirmation — DONE

Both `src/adapters/orchestrated-adapter.ts` and `src/adapters/agent-duo.ts` were removed in commit `1317e03`. No agent-duo entries remain in the adapter registry or `normalizeLaunchAdapter()`.

**Regression fixed**: The removal deleted `matchesOrchestratedMode()` but left a call site in `src/notify.ts:762`, breaking the build. A stub returning `true` was added (per gh-ludics-41 proposal guidance). The caller is currently unreachable (`orchestratedModeFilter` returns `null`), but the session conclusion code in `notify.ts` (functions using `peerSyncPath`: `collectPrLinks`, `collectRefactorSummary`, `hasConcludedSessionStatuses`, `readPhaseToken`, etc.) will need adaptation as part of the t3code port — these still assume agent-duo's `.peer-sync/` filesystem layout for reading session state.

### 5. End-to-end verification

After applying the template and code changes:

1. Run existing tests: `bun test src/orchestration/`
2. Manual smoke test: `ludics launch --adapter t3code --args '--pair --coder codex --reviewer claude-code --plan --feature test-pair'` on a test task to verify phase transitions work with enriched templates
3. Verify `ludics orch status <slot>` shows correct phase/status
4. Verify skill messages sent to threads contain the new guidance sections

## Estimated Effort

- Template edits: ~1 hour (7 files, straightforward text additions)
- Code changes: ~1 hour (2 functions, each ~15 lines)
- Issue triage: ~30 minutes (13 issues to close with comments)
- Testing: ~1 hour (unit tests + manual smoke test)
- **Total: ~3.5 hours**

## Risk Assessment

- **Low risk**: Template changes are additive text — they cannot break existing functionality.
- **Low risk**: The `markActiveAgents()` guard is conservative — it only skips overwriting when the agent is already in a terminal status.
- **Medium risk**: The `ghIssueBody()` function adds a subprocess call during skill composition. If `gh` is not available or the network is down, it returns null gracefully. The synchronous `Bun.spawnSync` call could add latency (~1-2s per agent per phase entry). This is acceptable since phase transitions are infrequent.
- **No risk**: Issue closures are documentation-only actions.
