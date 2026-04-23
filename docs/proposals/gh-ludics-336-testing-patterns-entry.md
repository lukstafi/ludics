# Injectable Subprocess Runners — testing-patterns.md entry

## Goal

Document the injectable-runner pattern for subprocess helpers in `docs/testing-patterns.md`, from the **how-to-test** reader surface, so a test author writing a new git-shelling helper can find and apply the pattern without archaeologising the `briefing-lag` test helpers.

Source: [gh-ludics-336](https://github.com/lukstafi/ludics/issues/336) (`workflow-feedback`).
Companion to: `task-ba243220` bundle (patterns-doc anchor `injectable-subprocess-runners` under `## Coding` — the how-to-implement surface), and `task-b0d4f45b` (extracts `RunGit` + `defaultRunGit` into `src/git-runner.ts`, which this entry cites as its worked example).

## Acceptance Criteria

- [ ] **Sequencing guard**: before landing this PR, `src/git-runner.ts` must exist in `lukstafi/ludics` main. `grep -l "export type RunGit" src/git-runner.ts` must match. If absent, wait for `task-b0d4f45b`'s PR to merge.
- [ ] `docs/testing-patterns.md` gains a new top-level section titled **"Injectable Subprocess Runners: The RunGit Pattern"**, placed as a sibling to the existing `## Safe Mocking in Bun` and `## Network-Binding Tests` sections (order: append, i.e. after `## Network-Binding Tests`).
- [ ] The new section follows the sibling style: problem statement → why → safe pattern → reference examples. No implementation-level prescriptions beyond the pattern.
- [ ] The section states the **"when to inject" threshold**: inject the runner when a helper makes **more than one git call OR branches non-trivially on git output**; otherwise inlining `Bun.spawnSync`/`safeSyncOutput` is fine.
- [ ] The section cites `src/git-runner.ts` (post-`task-b0d4f45b`) as the worked example — specifically the `RunGit` type and `defaultRunGit` production shim exported there.
- [ ] The section cites `src/briefing-lag.test.ts`'s `fakeGit(rules)` helper as the canonical fake-runner shape, and `src/staging-ff.test.ts`'s inline `RunGit` fake (the `args[0]`-dispatching variant, see the `detached HEAD` test) as an alternative shape for tests needing per-call inspection or call-ordering assertions.
- [ ] The section notes the boundary: `RunGit` is the git-specific instance of a general "injectable subprocess runner" idea — future non-git helpers that hit the threshold extract their own concrete `Run<Foo>` types rather than generalising to `RunSubprocess<cmd>`.
- [ ] No changes to any other file. No code changes. Doc-only diff.
- [ ] Commit message: `docs: testing-patterns entry for injectable subprocess runners (RunGit)`.

## Context

### Target file

`docs/testing-patterns.md` (101 lines at HEAD). Two existing sections:
- `## Safe Mocking in Bun` — discusses why `mock.module()` leaks across files and prescribes `spyOn` + restore.
- `## Network-Binding Tests` — prescribes `canBindSocket` guard from `src/test-utils.ts`.

Both sections share a compact shape: a few-line problem statement, a "why" tying it to a real incident or constraint, a "safe pattern" with code, and a short "reference examples" list pointing at two call sites.

### Worked-example module (post-`task-b0d4f45b`)

`src/git-runner.ts` will export, per `task-b0d4f45b`'s scope:
- `interface RunGitResult { stdout: string; exitCode: number }`
- `type RunGit = (args: string[], cwd: string) => RunGitResult`
- `const defaultRunGit: RunGit` — production shim that routes through `src/spawn.ts`'s `safeSyncOutput`, prefixing `git -C <cwd>`.
- `detectDefaultBranches`, `hasRemote`, `expandHome`, `withCheckout` — git-remote helpers that accept a `RunGit` parameter.

Production consumers post-extraction: `src/briefing-lag.ts`, `src/staging-ff.ts`, `src/mag.ts` (`briefingPrecomputeContext`).

### Canonical fake-runner shapes in the test tree

- `src/briefing-lag.test.ts`: `fakeGit(rules: Array<{ match: string[]; stdout: string; exitCode?: number }>): RunGit` — rule-based dispatch, arg-prefix match, default `exitCode: 128` for unmatched. Most reusable shape.
- `src/staging-ff.test.ts`: inline `const run: RunGit = (args) => { ... }` that switches on `args[0]` and records calls via a closed-over `calls: string[][]` array. Preferred when tests assert call ordering or exact argv.

### Why the pattern matters (testability payoff)

The three production consumers above collectively cover: default-branch detection, remote presence, merge-base / commit-count math, and fast-forward-with-checkout-restore. Every one of these paths has branches that only exercise under specific git states (no upstream, detached HEAD, missing remote, multi-remote disagreement). A deterministic fake runner makes those paths unit-testable without temp git repos — each of `briefing-lag.test.ts`, `staging-ff.test.ts`, and `mag.test.ts` exploits this to cover edge cases that would otherwise need either real fixtures or mutation-prone integration setups.

### Threshold rationale (from the source issue)

A helper with one git call and no branching on its output has essentially no test seam to expose — `spyOn`-ing `Bun.spawnSync` for a single call site is mechanically fine. The injection cost (an extra parameter, threaded through the caller chain) only earns its keep when multiple calls or branching decisions want coordinated fake responses. Two calls or non-trivial branching is the observed break-even.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Append the following section to `docs/testing-patterns.md` (draft; wording may be refined):

```markdown
## Injectable Subprocess Runners: The RunGit Pattern

Helpers that shell out to git (or any structured-output subprocess) should accept
the runner as a dependency instead of calling `Bun.spawnSync` directly — **when
the helper makes more than one subprocess call, or branches non-trivially on
subprocess output.** Single-call, no-branching helpers stay inline.

### Why

Branching on git state (default branch detection, remote presence, detached
HEAD, merge-base math) has edge cases that only appear under specific repo
states. Real-git fixtures are slow and flaky; `spyOn`-ing `Bun.spawnSync` for
coordinated multi-call fakes is awkward and fragile. A dedicated runner
parameter makes the seams explicit and the fakes small.

### The safe pattern

`src/git-runner.ts` defines:

\`\`\`typescript
export interface RunGitResult { stdout: string; exitCode: number }
export type RunGit = (args: string[], cwd: string) => RunGitResult;
export const defaultRunGit: RunGit = /* production shim via safeSyncOutput */;
\`\`\`

Helpers accept `runGit: RunGit` as a parameter:

\`\`\`typescript
export function detectDefaultBranches(cwd: string, runGit: RunGit): ... {
  const res = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (res.exitCode === 0) { /* parse */ }
  // ... fallback branching ...
}
\`\`\`

Callers pass `defaultRunGit` in production. Tests build a fake:

\`\`\`typescript
// Rule-based dispatch — preferred when tests care about outputs per git subcommand.
const rg = fakeGit([
  { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
  { match: ["rev-list", "--count"], stdout: "12\t3\n" },
]);

// Inline switch — preferred when tests assert call ordering or exact argv.
const calls: string[][] = [];
const run: RunGit = (args) => {
  calls.push(args.slice());
  if (args[0] === "fetch") return { stdout: "", exitCode: 0 };
  // ...
  return { stdout: "", exitCode: 128 };
};
\`\`\`

### When to inject

Inject when **either** is true:
- the helper makes two or more git calls, **or**
- the helper branches non-trivially on git output (exit code, stdout shape).

One call + no branching: inline `Bun.spawnSync` / `safeSyncOutput` is fine.

### Scope of the pattern

`RunGit` is the git-specific instance of a general "injectable subprocess
runner" idea. Future non-git helpers that cross the threshold should extract
their own concrete `Run<Foo>` type (e.g. `RunGh`, `RunTmux`) rather than
generalising to a `RunSubprocess`-of-any-command. The concrete types carry
useful constraints (fixed cwd prefix for git; `-C` semantics; exit-code
conventions) that a generic type loses.

### Reference examples

- `src/git-runner.ts` — `RunGit` type + `defaultRunGit` production shim.
- `src/briefing-lag.test.ts` — `fakeGit(rules)` rule-based dispatch helper;
  used across branch-detection, merge-base, and lag-formatting tests.
- `src/staging-ff.test.ts` — inline `RunGit` switch with call-recording;
  used to assert exact checkout/restore sequence in the detached-HEAD path.
```

Coder may trim prose, tighten wording, or adjust anchor-heading text — the acceptance criteria constrain only the section title and the structural beats (problem/why/pattern/threshold/scope/refs).

## Scope

**In scope**:
- Append one new section to `docs/testing-patterns.md`.
- Single doc-only commit.

**Out of scope** (covered elsewhere):
- Code extraction of `RunGit` + `defaultRunGit` + companions into `src/git-runner.ts` — owned by `task-b0d4f45b`.
- The `injectable-subprocess-runners` anchor under `## Coding` in `docs/orchestration-patterns.md` (how-to-implement reader surface) — owned by `task-ba243220`.
- Reviewer-template callouts (`skills/orchestration/pair-reviewer-plan-review.md`) — bundle uniformity-trim pass in `task-ba243220` handles any needed addendum.
- `docs/ARCHITECTURE.md` pointer/cross-reference — not load-bearing; skip unless a subsequent task calls for it.

**Dependencies**:
- **Blocks on**: `task-b0d4f45b`'s PR merging into `lukstafi/ludics` main. The new section cites `src/git-runner.ts` by path; that file must exist before this PR lands. Acceptance criterion gates this via a grep check.
- **Independent of**: `task-ba243220` bundle. Both can land in either order; the two surfaces serve distinct reader questions (how-to-test vs how-to-implement) and cite different worked examples in complementary ways.
