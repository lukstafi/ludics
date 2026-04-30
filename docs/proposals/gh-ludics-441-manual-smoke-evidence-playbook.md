# Proposal: Manual-smoke evidence playbook in worker-conventions

**Task**: gh-ludics-441
**Project**: ludics
**Source issue**: https://github.com/lukstafi/ludics/issues/441

## Goal

Workers and reviewers repeatedly rediscover that ACs phrased as "manual smoke
verification" are not satisfied by *argument* ("the unit tests exercise the
same library combination, therefore manual smoke is covered") nor cleanly
deferrable. Round 1 of task-61aee08e (markdown renderer migration) hit this
exact failure mode and triggered a `REQUEST_CHANGES`; round 2 succeeded by
producing two evidence layers — a wrapper-pipeline probe and a live HTTP probe
— that together substitute for "open the dashboard in a browser." The harness
*can* deliver real evidence for any deterministically-rendered, statically-
served surface; the missing piece is documented technique.

This task adds a single playbook section to `skills/worker-conventions.md`
codifying both probes with concrete entrypoint names, terse cross-links from
the three orchestrator-side skills that most often emit or judge manual-smoke
ACs, and an optional helper script that automates the temp-dir-mirror dance
for the dashboard.

## Acceptance Criteria

1. `skills/worker-conventions.md` gains a new `## Manual-Smoke Evidence` section
   (sibling to `## Scope`, placed immediately after it). The section names
   the principle ("substitution-by-argument is not evidence") and describes
   two reusable patterns:
   - **(a) Wrapper-pipeline probe**: run the wrapper's exact pipeline at the
     vendored library versions against real harness content, capture the
     output for inspection.
   - **(b) Live HTTP probe**: instantiate the real server entrypoint
     (`startDashboardServer(port, dashboardDir, ttlSeconds)` from
     `src/dashboard-server.ts`, with `port = 0` and a temp-dir mirror of
     `templates/dashboard/`) and `fetch` (or `curl`) the routes the AC names.
     The transcript becomes the evidence.
   The section explicitly calls out that "I can't open a browser" is *not* a
   valid harness limit when rendering is deterministic from MD source +
   library versions and the server is a static file server.

2. The section names the entrypoint signature explicitly:
   `startDashboardServer(port: number, dashboardDir: string, ttlSeconds: number): ReturnType<typeof Bun.serve>`
   and references the existing usage at `src/dashboard.test.ts` around line
   545 as a worked example readers can lift.

3. The section includes the three documented caveats:
   - **Subjective visual review is excluded.** ACs that genuinely demand
     human visual judgement (mobile layout, typography "feel") still need a
     human; the playbook covers deterministic rendering only.
   - **Vendored-version drift.** Pattern (a) installs from npm at the
     vendored versions; if `package.json` and `templates/dashboard/vendor/`
     drift, the probe silently tests the wrong artifact. The playbook says
     "verify the npm version matches the vendored bundle's claimed version
     before trusting the evidence" and links to the `lint:vendor-sync` work
     (task-d024e32c).
   - **Artifact hygiene.** Probe scripts and transcripts go under `/tmp/`,
     not the repo.

4. `skills/ludics-elaborate.md` gains a single-paragraph cross-link near the
   end of the "Common Steps" or "Status routing" section (whichever sits
   closest to where ACs are emitted) pointing at the new section. The
   cross-link is one bullet or one sentence, not a duplicate of the playbook.
   Suggested wording shape:
   > "When you draft an AC that requires manual visual or runtime
   > verification, see [Manual-Smoke Evidence](worker-conventions.md#manual-smoke-evidence)
   > in worker-conventions for the two patterns the harness can deliver."

5. `skills/ludics-draft-proposal.md` gains the same one-line cross-link, in
   the section closest to AC drafting (likely under "Common Steps" or near
   the precondition / proposal-write step). Same rationale: the
   draft-proposal flow is where the manual-smoke phrasing is born.

6. `skills/ludics-verify-completion.md` gains the same one-line cross-link,
   placed in the section closest to verdict routing. The wording emphasises
   the reviewer-side framing:
   > "Do not accept 'unit tests exercise the same combination' as evidence
   > for a manual-smoke AC. See [Manual-Smoke Evidence](worker-conventions.md#manual-smoke-evidence)
   > for the two probe shapes that count."

7. `scripts/dev-dashboard-mirror.ts` is created. It:
   - Takes no required arguments (optional `--port <n>` defaulting to 0,
     `--ttl <seconds>` defaulting to 3600, `--keep` to preserve the temp
     directory on exit).
   - Mirrors `templates/dashboard/` into a fresh temp directory under
     `/tmp/ludics-dash-mirror-<random>/dashboard/` (preserving the layout
     `startDashboardServer` expects, including the sibling `tasks/` parent
     resolution — see step 8).
   - Calls `startDashboardServer(port, mirrorDir, ttl)` and prints
     `dashboard listening on http://localhost:<port>` with the resolved port.
   - Cleans up the temp directory on `SIGINT` / `SIGTERM` unless `--keep`.
   - Can be invoked as `bun run scripts/dev-dashboard-mirror.ts`.

8. The helper script handles `startDashboardServer`'s expectation that the
   dashboard directory has a sibling `tasks/` directory (see line 41 of
   `src/dashboard-server.ts`: `tasksRoot = resolve(dashboardDir, "..", "tasks") + "/"`).
   The mirror layout is `/tmp/ludics-dash-mirror-<random>/dashboard/`
   (assets) and `/tmp/ludics-dash-mirror-<random>/tasks/` (empty directory
   created at mirror time). The script's behaviour on missing `tasks/`
   should match production (server still starts; task endpoints just return
   404), so an empty sibling directory is sufficient.

9. The playbook section in `worker-conventions.md` cites the helper script
   as the citable shorthand for pattern (b):
   > "For the dashboard specifically, `bun run scripts/dev-dashboard-mirror.ts`
   > performs the temp-dir mirror + boot dance and prints the URL; pipe its
   > output into your evidence transcript."

10. No behavioural code changes outside `scripts/dev-dashboard-mirror.ts`.
    `src/`, `templates/`, and existing tests are not touched.

11. `CHANGELOG.md` gets a single-line entry under the next unreleased section
    naming the new playbook + helper script. No version bump.

## Context

### Where this came from

Task-61aee08e (markdown renderer migration) carried AC9 — "manual smoke
verification of `/index.html`, `/task.html`, `/markdown.js`, vendored bundles".
Round 1: coder argued unit tests covered the same combination, reviewer
rejected, cited "substitution by argument is not evidence." Round 2: coder
delivered:
- `/tmp/markdown-smoke-task-61aee08e.ts` — imported `marked` +
  `isomorphic-dompurify` from npm at vendored versions, rendered three real
  harness MD files (`tasks/gh-agent-duo-11.md`,
  `docs/proposals/agent-duo-migration.md`, `briefing.md`) through the
  wrapper's exact pipeline (including the `task.html` frontmatter strip).
- `startDashboardServer(7679, tempDir, 3600)` against a temp-dir mirror of
  `templates/dashboard/`, then `curl` of every route the AC named.
Round 2 was accepted. The technique generalises; the documentation does not
exist yet.

### Confirmed entrypoints (re-verified 2026-04-30)

- `src/dashboard-server.ts` line 34: `export function startDashboardServer(port: number, dashboardDir: string, ttlSeconds: number): ReturnType<typeof Bun.serve>` — stable, exported, used in tests.
- `src/dashboard.test.ts` line 545: existing `startServer()` helper that
  passes `port = 0` and a `harnessDir()`-rooted temp dashboard dir. This is
  the canonical worked example — the playbook references it instead of
  duplicating the snippet.
- `src/dashboard.ts` line 1109: production caller — confirms the live HTTP
  probe is the *same* code the user actually hits.
- `templates/dashboard/` is the source-of-truth asset directory (contains
  `vendor/marked.esm.js`, `vendor/purify.es.js`, `vendor/README.md`, plus
  `markdown.js`, `task.html`, `index.html`, etc.).

### Confirmed gaps (re-verified 2026-04-30)

`grep -in "manual.smoke\|manual smoke" skills/worker-conventions.md
skills/ludics-elaborate.md skills/ludics-draft-proposal.md
skills/ludics-verify-completion.md skills/ludics-draft-proposal-worker.md
skills/ludics-verify-completion-worker.md` returns zero matches. There is no
existing playbook to extend or replace; this task lands the first version.

### Reference layer, not inline

Per `feedback_reference_layer_not_inline` (Mag memory): trust agents to
follow a reference, do not bloat skill templates. The three sibling skills
(`ludics-elaborate`, `ludics-draft-proposal`, `ludics-verify-completion`)
get one-line cross-links each. The playbook itself lives once in
`worker-conventions.md` — the highest-traffic worker reference.

### Why ship the helper script in the same task

Two reasons:
- The script is ~30 lines; deferring it would create a follow-up task
  larger than the script.
- The playbook becomes more citable when there is a one-line invocation
  (`bun run scripts/dev-dashboard-mirror.ts`) rather than "set up your own
  temp-dir mirror." The script and the doc reinforce each other.

The script stays narrow (dashboard-specific). If a second `Bun.serve`
entrypoint appears later, that task can either parameterise this script or
add a sibling — both are fine.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Write the playbook section

In `skills/worker-conventions.md`, between `## Scope` and `## Broader Context`
(at line 28), insert:

```markdown
## Manual-Smoke Evidence

When an AC requires "manual smoke verification," reviewers will not accept
*substitution-by-argument* ("the unit tests exercise the same library
combination, therefore manual smoke is covered") and will not accept
deferral. The harness *can* produce real evidence for any deterministically-
rendered, statically-served surface; "I can't open a browser" is not a valid
limit. Two patterns work, often used together:

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
asset tree, then `fetch` the routes the AC names. The transcript becomes
the evidence.

Entrypoint:
`startDashboardServer(port: number, dashboardDir: string, ttlSeconds: number)`
exported from `src/dashboard-server.ts`. Pass `port = 0` to let Bun pick a
free port; read the resolved port back from the returned server object.

Worked example: `src/dashboard.test.ts` around line 545 shows the canonical
shape (mirror to `harnessDir()/dashboard`, boot, `fetch`, stop).

For the dashboard specifically:

```bash
bun run scripts/dev-dashboard-mirror.ts
# dashboard listening on http://localhost:54321
curl http://localhost:54321/index.html | head
curl http://localhost:54321/task.html?task=<id> | head
curl http://localhost:54321/vendor/marked.esm.js | head -1
```

Pipe the curl transcripts into the workflow-feedback or PR comment.

### Patterns combined

For ACs that exercise both rendering *and* serving (the markdown-renderer
case), run (a) first to prove the pipeline is correct given the inputs,
then (b) to prove the server actually delivers those inputs to the browser.

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
```

### 2. Cross-links in the three sibling skills

In `skills/ludics-elaborate.md`, find the end of `## Common Steps` and add
a single bullet:

```markdown
- **Manual-smoke ACs.** When an AC implies visual or runtime verification,
  link the worker to [Manual-Smoke Evidence](worker-conventions.md#manual-smoke-evidence)
  rather than trying to inline guidance. Two probe shapes (wrapper-pipeline
  + live HTTP) cover the harness-deliverable cases.
```

In `skills/ludics-draft-proposal.md`, in the section closest to AC drafting
(around `## Common Steps` or right before `## Status routing`), add the same
bullet — the draft-proposal flow is where manual-smoke phrasing is born,
so the cross-link belongs near AC writing.

In `skills/ludics-verify-completion.md`, in the section closest to verdict
routing (just above `## Verdict routing` or in `### incomplete`'s prose),
add the reviewer-side wording:

```markdown
- **Manual-smoke ACs require evidence, not argument.** Do not accept
  "unit tests exercise the same library combination" as evidence for an
  AC that names a route, an asset, or a rendered surface. See
  [Manual-Smoke Evidence](../skills/worker-conventions.md#manual-smoke-evidence)
  for the two probe shapes the harness can deliver.
```

(The `..` prefix in the verify-completion link is because that skill lives
beside `worker-conventions.md` in `skills/` — keep it consistent with the
existing relative-link style in each file.)

### 3. The helper script

Create `scripts/dev-dashboard-mirror.ts` (~40 lines):

```typescript
#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDashboardServer } from "../src/dashboard-server.ts";

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const port = Number(parseArg("--port", "0"));
const ttl = Number(parseArg("--ttl", "3600"));
const keep = process.argv.includes("--keep");

const root = mkdtempSync(join(tmpdir(), "ludics-dash-mirror-"));
const dashboardDir = join(root, "dashboard");
const tasksDir = join(root, "tasks");
mkdirSync(tasksDir, { recursive: true });
cpSync(resolve(import.meta.dir, "..", "templates", "dashboard"), dashboardDir, { recursive: true });

const server = startDashboardServer(port, dashboardDir, ttl);
console.log(`dashboard listening on http://localhost:${server.port} (mirror=${root}${keep ? ", kept" : ""})`);

function shutdown() {
  void server.stop(true);
  if (!keep) rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Verify by running it locally and `curl http://localhost:<port>/index.html`.

### 4. CHANGELOG entry

```markdown
### Documentation

- **Manual-smoke evidence playbook.** New section in `worker-conventions.md`
  documenting two probe patterns (wrapper-pipeline + live HTTP via
  `startDashboardServer`) for ACs that require runtime verification of
  deterministically-rendered, statically-served surfaces. Cross-linked from
  `ludics-elaborate`, `ludics-draft-proposal`, `ludics-verify-completion`.
  New helper: `bun run scripts/dev-dashboard-mirror.ts` boots the dashboard
  against a temp-dir mirror.
```

## Scope

### In scope

- `skills/worker-conventions.md` — new `## Manual-Smoke Evidence` section
  (insertion site between `## Scope` and `## Broader Context`).
- `skills/ludics-elaborate.md` — one-line cross-link.
- `skills/ludics-draft-proposal.md` — one-line cross-link.
- `skills/ludics-verify-completion.md` — one-line cross-link with
  reviewer-side framing.
- `scripts/dev-dashboard-mirror.ts` — new file, dashboard-only.
- `CHANGELOG.md` — single-line entry under next unreleased section.

### Out of scope

- AC linter or draft-proposal-worker hook that auto-emits the playbook
  reference whenever an AC string contains "manual smoke." Belongs in a
  follow-up if at all (would touch `src/` and need its own design).
- Generalising `dev-dashboard-mirror.ts` into a multi-server helper.
  Premature; the dashboard is the only `Bun.serve` entrypoint that needs
  it today. A future task can parameterise if a second server appears.
- Modifying `src/dashboard-server.ts` or any other production code path.
- Rewriting the existing `### Scope: floor, not ceiling` anchor in
  `docs/orchestration-patterns.md`. Conventions stays the canonical home.
- Verifying the `lint:vendor-sync` work itself (task-d024e32c) — the
  playbook merely references it.

### Dependencies

- None. Sibling task task-66feb317 (AC verification rigor — literal-grep
  AC clause + vacuous-harness clause) is in the same family but addresses
  a different surface; the two compose without ordering.
