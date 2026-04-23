# Task frontmatter reference

Reference documentation for the YAML frontmatter on `task-*.md` files. Each section describes a single field: how to choose a value, what the orchestrator does with it, and worked examples drawn from real triage decisions.

This doc grows over time. Today it covers `effort`; future additions are expected for the priority ladder (`S` / `A` / `B` / `C` / `D`), the status lifecycle (`ready` → `in-progress` → `done` / `merged` / etc.), and interaction flags like `skip_plan`, `uses_browser`, and `requirements`.

For the authoritative list of fields and their TypeScript types, see [`TaskFrontmatter` in `src/tasks/types.ts`](../src/tasks/types.ts). For the orchestration mapping, see `selectOrchestrationFlags` in [`src/adapters/t3code.ts`](../src/adapters/t3code.ts).

## Effort levels

The `effort` field is a four-level scale used to pick the orchestration shape for a task. The default at task creation is `medium`. The four levels — `tiny`, `small`, `medium`, `large` — are accepted by the dashboard task-create form and consumed by the t3code adapter to choose mode, model, and pre-work phases.

Pick the lowest level that honestly fits. The criterion is the *shape* of the work, not its perceived importance — a high-priority bug whose fix is a one-line change is still `tiny`. Calibration tends to drift across sessions; when in doubt, prefer the lower level for clearly mechanical work and the higher level when you can already see a design decision lurking.

### `tiny`

A mechanical edit whose diff can be sketched without reading the codebase. Typically up to ~4 files of predictable changes, no new abstractions, no new decision points. The implementation is essentially 1:1 with the proposal — there is nothing left to decide once the change is described.

Worked examples:

- Delete-only or rename-only cleanups at known call sites.
- Single-file helper extraction from a small, enumerated set of call sites.
- Targeted lint fix or doc-only change with a clean audit.
- Proposals that explicitly set `skip_plan: true` because the implementation reads as a translation of the proposal.

Orchestration behavior: solo mode (single coder, no reviewer), no pre-work phases, Sonnet model for `claude-code` coders. `tiny` bypasses the configured `default_mode` unconditionally — it is the one effort level that overrides orchestration defaults rather than reading them. `skip_plan` has no effect at this level (the plan phase is already skipped).

### `small`

Focused scope but requires some thinking. The shape of the change is clear, but a few non-obvious choices come up during implementation — which call sites are in scope, whether to extend an existing helper or add a new one, how to phrase a new pattern entry. Typically across a handful of files in one subsystem.

Worked examples:

- Cross-cutting refactor across a handful of files in one area.
- Single-feature extension to an existing component.
- Fix-or-retire decisions on a short, enumerated list of failures.
- Writing a few pattern entries with rationale.

Orchestration behavior: pair mode (coder + reviewer) using the configured `default_mode`, no pre-work phases, Sonnet model for `claude-code` coders. `skip_plan` is ignored — the plan phase is already skipped at this level.

### `medium`

Multi-component change, or a change that needs an explicit design pass before implementation. This is the default at task creation and the level at which the planning phase kicks in. Most non-trivial feature work, new modules, and coordinated multi-template edits land here.

Worked examples:

- New module with tests.
- Multi-template coordinated edit (e.g. updating both coder and reviewer phase templates together).
- Adapter extension that touches the adapter, its registry entry, and a couple of call sites.
- Workflow change that ripples through more than one phase template.

Orchestration behavior: pair mode using the configured `default_mode`, `--plan` enabled, Opus model for `claude-code` coders. `medium` is the only level where `skip_plan: true` in the task's frontmatter takes effect — it is the manual override for exhaustive proposals where the design work is already in the proposal and the plan phase would just rehash it.

### `large`

Multi-week or architectural. Needs phased planning, often deserves a dedicated proposal with milestones, and typically benefits from gathering exploratory context before the plan phase begins.

Worked examples:

- Phased architectural work that lands in several PRs over a sprint or longer.
- Module split or rename that ripples through most of the codebase.
- New subsystem (federation layer, orchestration phase set, adapter for a new agent kind).

Orchestration behavior: pair mode using the configured `default_mode`, `--plan --gather` enabled, Opus model for `claude-code` coders. `skip_plan` is ignored at this level — `large` always runs both pre-work phases.

### `skip_plan` interaction summary

The `skip_plan: true` frontmatter flag is only consulted at `medium` effort:

- At `tiny` and `small`, the plan phase is already skipped, so the flag is a no-op.
- At `medium`, `skip_plan: true` suppresses `--plan`. This is the intended manual override for proposals whose implementation is exhaustive enough that planning would duplicate work.
- At `large`, the flag is ignored — the plan and gather phases always run.

### Notes on extension

The four levels above describe today's scale. Nothing in the model precludes a future `huge` or `epic` level if a class of work emerges that genuinely needs a different orchestration shape; the framing here is descriptive rather than normative. New levels would need corresponding entries in the dashboard validation allowlist, the `selectOrchestrationFlags` mapping, and this section.
