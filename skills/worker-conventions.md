# Worker Conventions

Shared conventions for worker subagents. Each worker skill references this file.

## Argument Parsing

Workers receive arguments via `$ARGUMENTS`. Parse positionally:

```
$ARGUMENTS format: <arg1> <arg2> [<arg3>...]
```

Split on whitespace. The first word is typically a task ID or repo identifier;
subsequent words are paths or additional parameters.

## Scope

Acceptance criteria are a contract floor — every listed criterion must be
satisfied. They are not an exhaustive ceiling: small adjacent fixes that the
work makes obvious (a typo, a one-line type tightening, a stale comment, an
obvious dead-code drop in a file already being edited) may be absorbed
without spawning a follow-up task. The boundary and the reviewer's three
tiers (absorb / accept-with-note / reject-and-salvage) are documented in
[scope: floor, not ceiling](../docs/orchestration-patterns.md#scope-floor-not-ceiling).
Reach for declare/salvage/follow-up only when a fix exceeds the absorb
boundary — a few lines, same file or sibling test, no new abstractions or
imports, no new public surface.

## Skill body CLI references

Skill markdown bodies are executable specs — Mag and human readers literally
run the `ludics ...` commands cited in code formatting. Every literal
`ludics <verb> <sub>` written inside backticks or a fenced code block must
resolve to a real dispatcher case and a USAGE entry in `src/index.ts`. The
`lint:skill-cli-refs` script catches drift in CI; sanity-check locally
before opening a PR with `bun run lint:skill-cli-refs`.

**Prefer direct tools where an equivalent exists** — `Read`, `Glob`, and
`Bash` are validated by the agent harness and compose better than shelling
to `ludics tasks list --json` or similar. This is guidance only; firing
`ludics notify`, `ludics slot N assign`, etc. remains entirely fine where
there is no equivalent direct path.

## Running the test suite

When capturing `bun test` output to a file the harness or a watcher can read in real time, use file redirection (or `tee`) — not a pipe-to-`tail`/`head`/`grep`. This section lives here, in worker-conventions, because it's about *how a worker invokes the suite for capture*, not about the cross-worker baseline pattern that `docs/orchestration-patterns.md` already covers.

- **Recommended:** `bun test > /tmp/<name>.out 2>&1` (or `bun test 2>&1 | tee /tmp/<name>.out` if you also want it on the terminal). Order matters in POSIX shells: `> file 2>&1` sends stdout to the file *then* duplicates stderr from the now-redirected stdout, so both streams land in the file; `2>&1 > file` does the opposite (duplicates stderr to the original terminal stdout, then redirects stdout to the file) and silently drops stderr. Writing to a regular file flushes line-by-line, so a watcher (`tail -f`, harness file read) sees progress as the suite runs.
- **Avoid:** `bun test 2>&1 | tail -40` (or any pipe-to-`tail`/`head`/`grep` without `--line-buffered`). Stdout into a pipe is block-buffered (4–8 KiB) and `bun test` does not flush per-line, so during a 50+ second run the captured file stays empty until the suite ends — making a healthy run look hung.
- **Per-round filename suffix:** prefer round-distinct names like `/tmp/bun-test-baseline.out`, `/tmp/bun-test-round-N.out` so a stale file from an earlier round can't be mistaken for current output.
- **Worktree fallback:** if `/tmp` is unavailable or undesirable, a worktree-relative path such as `.peer-sync/bun-test-baseline.out` works equally well — file redirection is what makes the bytes visible, not the directory.

## AC verification rigor

When ACs are unusually contract-heavy, see [`docs/ac-rigor-reference.md`](../docs/ac-rigor-reference.md). Sections (grep-able in-place):
- Vacuous-harness family: Vacuous test harness — assert on the artifact the AC names; Stash-prod mutation test — confirm your new test actually falsifies; Sibling-mutation for cardinality probes; Vacuous doc/config harness — same rule, doc artifacts; Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'; Mutation evidence — for test-shaped AC verification, cite a one-line edit (sed/Edit/stash) that flips the assertion PASS→FAIL (see [mutation evidence](../docs/orchestration-patterns.md#mutation-evidence)).
- Falsifier-shape family: Literal-grep AC — relocate the literal, don't keep it under a new rule; Per-element assertions for enumerated-element ACs; Window-scoped pairing assertion for "Surfaces X as Y" ACs; Closed-set / cardinality ACs — set-equality is the strongest probe shape; Byte-pinned assertions on rendered or normalised output; Prose-only template instructions are unverifiable; Literal paths in ACs are literal — don't substitute the platform abstraction; Capture-and-feed ACs need a direct mock-driven invariant test, not indirect coverage.
- Process-around-the-AC: Proposal beats task file when AC counts diverge; Self-contradicting AC literal probe — revise the AC, not the verification narrative; AC verification evidence must survive the commit boundary; AC-cited test paths are load-bearing — ls-probe each before done-status; Diff-enumerated verification lines go stale — anchor to invariants, not snapshots; Proposal-path enumeration goes stale when proposal commits to main first — anchor to scope invariant; No-regression framing when the gate baseline is red.

## Manual-Smoke Evidence

When an AC requires "manual smoke verification," reviewers will not accept
*substitution-by-argument* ("the unit tests exercise the same library
combination, therefore manual smoke is covered") and will not accept
deferral. The harness *can* produce real evidence for any deterministically-
rendered, statically-served surface; "I can't open a browser" is not a valid
limit when rendering is deterministic from MD source + library versions and
the server is a static file server. Two patterns work, often used together:

### (a) Wrapper-pipeline probe

Run the wrapper's exact pipeline at the *vendored* library versions against
real harness content. Capture the output (HTML, transformed text, whatever
the wrapper produces) so the reviewer can read what a user would see.

Recipe:

1. Install the libraries from npm at the *exact* versions claimed by the
   vendored bundles (e.g. `templates/dashboard/vendor/README.md` cites
   versions for `marked` and `isomorphic-dompurify`).
2. Write a small `.ts` file under `/tmp/` that imports those libraries and
   replays the wrapper's pipeline (including any pre/post-processing such
   as `task.html`'s frontmatter strip).
3. Feed it 2–3 real harness files spanning the variation the AC cares
   about (e.g. a task file with frontmatter, a proposal with code blocks,
   a briefing with tables).
4. Capture stdout/stderr into `/tmp/<probe-name>.transcript` and quote
   key sections in the workflow-feedback or PR comment.

> **Verify version alignment first.** If `package.json` and
> `templates/dashboard/vendor/` drift, the probe silently tests the wrong
> artifact. Cross-check the version string in the vendored bundle against
> the npm-installed version before trusting the evidence. (See
> task-d024e32c — `lint:vendor-sync`.)

### (b) Live HTTP probe

Instantiate the *real* server entrypoint against a temp-dir mirror of the
asset tree, then `fetch` (or `curl`) the routes the AC names. The transcript
becomes the evidence.

Entrypoint signature:
`startDashboardServer(port: number, dashboardDir: string, ttlSeconds: number): ReturnType<typeof Bun.serve>`
exported from `src/dashboard-server.ts`. Pass `port = 0` to let Bun pick a
free port; read the resolved port back from the returned server's `.port`.

Worked example: `src/dashboard.test.ts` around line 545 shows the canonical
shape (mirror under `harnessDir()/dashboard`, boot with port 0, `fetch`,
`stop`). Lift it instead of writing your own.

For the dashboard specifically,
`bun run scripts/dev-dashboard-mirror.ts` performs the temp-dir mirror +
boot dance and prints the URL; pipe its output into your evidence
transcript. Example:

```bash
bun run scripts/dev-dashboard-mirror.ts
# dashboard listening on http://localhost:54321 (mirror=/tmp/ludics-dash-mirror-XXXX)
curl http://localhost:54321/index.html | head
curl http://localhost:54321/task.html?task=<id> | head
curl http://localhost:54321/vendor/marked.esm.js | head -1
```

### Patterns combined

For ACs that exercise both rendering *and* serving (the markdown-renderer
case from task-61aee08e), run (a) first to prove the pipeline is correct
given the inputs, then (b) to prove the server actually delivers those
inputs to the browser.

### What this does *not* cover

- Subjective visual judgement ("the layout looks right on mobile",
  "typography feels balanced"). These ACs still need a human; the playbook
  is for deterministic rendering only.
- Stateful interaction flows (clicking through a multi-step UI). Out of
  scope for static-content surfaces.

### Hygiene

- Probe scripts and transcripts live under `/tmp/`, never in the repo.
- Name them with the task ID: `/tmp/<task-id>-<probe>.ts`,
  `/tmp/<task-id>-<probe>.transcript`.
- Cite paths in the PR comment so reviewers can rerun if needed.
- When a probe script edited a tracked file (e.g. injected a temporary
  dune stanza, appended a debug println), clean up with
  `git checkout -- <path>` rather than tail-trimming. macOS `head` does
  not accept negative line counts (`head -n -<N>` is a GNU extension), so
  the trick that works on Linux silently truncates the wrong region on
  macOS — the checkout form works on both.

## Broader Context

Some workers receive a `<context_brief>` as a trailing argument — free-form
text (3-10 lines) the orchestrator composes from Mag's conversation history.
When present:

- Use it for judgment calls (scope, staleness, priority).
- Treat it as a hint, not ground truth — verify claims against the codebase.
- Don't echo it verbatim in outputs.
- If absent or empty, proceed using only the codebase and task file.

## Structured Response Format

Your final response includes a fenced ` ```json ``` ` block as the **last code
block** in the response. All structured fields go inside it.

```json
{
  "status": "<status_value>",
  "field_name": "<value>"
}
```

- `status` is always present and is the primary routing field.
- Common status values: `"completed"`, `"error"`, `"stale"`, `"split-needed"`,
  `"already-exists"`, `"merged"`, `"already-elaborated"`, `"empty"`.
- Field names use snake_case.
- Multi-value fields use JSON arrays (e.g., `"questions": ["q1", "q2"]`); use
  the string `"none"` when a list is empty.
- Free-form explanation text may precede the JSON block; the JSON block is
  still the last fenced code block.
- Keep responses concise — the orchestrator handles notifications, result JSON,
  and downstream actions.

## Field Annotations

Each worker documents response fields in a "Response Contract" with:

- **required**: always present in non-error responses. List-like required
  fields use `"none"` when empty.
- **conditional**: present only when the stated condition holds. Omitted
  entirely otherwise — never `null`.

When `status` is `"error"`, only `status` plus a narrative field are
guaranteed; other fields may be absent. Orchestrators handle missing
conditional fields gracefully.

## Field Contract Reference

Canonical cross-skill reference for field types and required/conditional/optional
annotations across all worker/orchestrator pairs. Each worker skill keeps its
own `### Response Contract` section with full prose and examples — this table
summarises, it does not replace. Vocabulary matches "Field Annotations" above.

| Skill pair | Field | Type | Annotation | Condition / Notes |
|---|---|---|---|---|
| elaborate | `status` | string | required | `completed` / `merged` / `already-elaborated` / `error` |
| elaborate | `task_id` | string | required | echoes input |
| elaborate | `title` | string | required | |
| elaborate | `merge_target` | string | conditional | when `status = "merged"` |
| elaborate | `elaborated_date` | string | conditional | when `status = "already-elaborated"` |
| elaborate | `questions` | string[] | required | `"none"` when empty |
| elaborate | `summary` | string | required | |
| draft-proposal | `status` | string | required | `completed` / `stale` / `split-needed` / `already-exists` / `error` |
| draft-proposal | `task_id` | string | required | |
| draft-proposal | `proposal_path` | string | conditional | when `status ∈ {completed, already-exists}` |
| draft-proposal | `ambiguities` | string[] | required | `"none"` when empty |
| draft-proposal | `start_confidence` | string | conditional | when `status = "completed"`; `high` / `low` |
| draft-proposal | `start_rationale` | string | conditional | when `status = "completed"` |
| draft-proposal | `title` | string | required | |
| draft-proposal | `summary` | string | required | |
| draft-proposal | `skip_plan` | boolean | optional | when `status = "completed"`; written to frontmatter when `true` |
| revise-proposal | `status` | string | required | `revised` / `no-changes` / `error` |
| revise-proposal | `task_id` | string | required | |
| revise-proposal | `proposal_path` | string | conditional | when `proposal_mode = "file"`; omitted for inline |
| revise-proposal | `proposal_mode` | string | conditional | required when `status = "revised"`; orchestrator must not default to `"file"` |
| revise-proposal | `changes_summary` | string | required | |
| revise-proposal | `title` | string | required | |
| revise-proposal | `summary` | string | required | |
| verify-completion | `status` | string | required | always `"completed"` in non-error cases |
| verify-completion | `task_id` | string | required | |
| verify-completion | `title` | string | required | |
| verify-completion | `slot` | number | required | error if verdict requires slot clearing |
| verify-completion | `verdict` | string | required | `complete` / `complete-with-followups` / `uncertain` / `incomplete` |
| verify-completion | `followups` | object[] | required | `{title, priority}`; `"none"` when empty |
| verify-completion | `questions` | string[] | required | `"none"` when empty |
| verify-completion | `evidence` | string | required | |
| feedback-digest | `status` | string | required | `completed` / `empty` / `error` |
| feedback-digest | `issues_created` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `issues_updated` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `issues_skipped` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `files_processed` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `summary` | string | required | |
| feedback-digest | `textbookCaptures` | object[] | optional | items `{feedbackItem, entryHeadline, precipitatingRetro}`; default `[]` |

## Error Handling

- **Missing input** (task not found, path not found): set `"status": "error"`
  and put the explanation in the primary narrative field (`summary`,
  `evidence`, etc.); if none applies, add an `"error"` string field.
- **Partial failure**: continue with what works, report partial results in
  the structured response.
- **External service failure** (`gh` not authenticated, git push fails):
  log a warning, carry on, note the limitation.
- **Already processed**: report the appropriate status (`already-exists`,
  `already-elaborated`) with the existing artifact details.

## Environment

- `$LUDICS_STATE_PATH`: path to the ludics harness directory (always set).
- `$LUDICS_RESULTS_DIR`: directory for result JSON (when workers write
  results directly).
- Workers run in a forked context (`context: fork`) — file reads, git
  operations, and tool outputs stay out of Mag's conversation history.
