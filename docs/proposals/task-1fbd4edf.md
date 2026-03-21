# Proposal: Configurable duo/pair workflow settings

## Summary

Add configuration for agent models, thinking effort, and per-phase timeouts in orchestrated workflows, controllable via `config.yaml` and adapter args.

## Changes

### 1. Config schema (`config.yaml`, `config.ts`)

Add `mag.orchestration` section:
```yaml
mag:
  orchestration:
    coder_model: claude-sonnet-4-6
    reviewer_model: gpt-5.4
    coder_thinking_effort: medium    # low | medium | high | token budget
    reviewer_thinking_effort: medium
    phase_timeouts:
      work: 1800
      review: 600
      pr-comments: 3600
      final-merge: 600
```

### 2. Adapter args parsing (`t3code.ts`)

Extend adapter args to accept model/effort/timeout overrides:
- `--coder-model <model>`, `--reviewer-model <model>`
- `--coder-thinking <effort>`, `--reviewer-thinking <effort>`
- `--work-timeout <seconds>`, `--review-timeout <seconds>`, etc.

Adapter args override config.yaml values.

### 3. Flow through to orchestration state (`state.ts`)

- `OrchestrationConfig` gains `coderModel`, `reviewerModel`, `coderThinkingEffort`, `reviewerThinkingEffort` fields
- `defaultOrchestrationConfig()` reads from config.yaml, applies adapter arg overrides
- Persisted in state file so restarts use same config

### 4. Apply to turns (`runner.ts`)

- `sendTurnMessage()` uses per-agent model from config (not hardcoded)
- Pass thinking effort via provider-appropriate mechanism

### 5. Status display (`orchestration/index.ts`)

- `ludics orch status <slot>` shows configured models and timeouts

### Files to modify

- `src/config.ts` — config schema for orchestration settings
- `src/adapters/t3code.ts` — adapter arg parsing, config merge
- `src/orchestration/state.ts` — OrchestrationConfig extension
- `src/orchestration/runner.ts` — sendTurnMessage model/effort usage
- `src/orchestration/index.ts` — status display
- `templates/config.reference.yaml` — document new settings
