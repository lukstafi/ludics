# Remote slot dispatch: target-machine-aware project-path resolution

## Goal

A remote slot launch (controller **mac-studio**/macOS → worker **minipc-wsl**/Linux, the
federation's sole CUDA host) fails deterministically every keepalive tick:

```
ludics: intent start slot 4: ENOENT: no such file or directory, posix_spawn 'git'
```

The `posix_spawn 'git'` is a Bun mis-attribution: git is on PATH on the worker. The real
ENOENT is on the spawn's **working directory** — `git worktree add` runs with a `cwd` that
does not exist on the worker. The controller resolves the project checkout path against its
OWN local filesystem (`resolveProjectPath` expands `~/ocaml-cudajit` against the macOS
`$HOME` → `/Users/lukstafi/ocaml-cudajit`), stamps that absolute path into the slot's
`data.path` at auto-assign, and ships it verbatim to the worker — where the project lives at
`/home/lukstafi/ocaml-cudajit` and `/Users` does not exist.

Make project-path resolution **target-machine-aware**, with the **controller as the
resolution authority** (configs are consistent across the cluster, so the controller — which
holds the config — resolves the path *for the destination machine* and ships the correct
one; the worker trusts it). Concretely:

1. Extend the `path` project-config schema to optionally be a **map** keyed by OS
   (`macos`/`linux`) or machine name (`mac-studio`/`minipc-wsl`), so a single project can
   declare divergent checkout roots across OSes. A plain string stays valid (back-compat).
2. Resolve `~/`-relative paths against the **destination machine's** `$HOME`, never the
   controller's.
3. At auto-assign/dispatch, the controller resolves the path **for the target machine** and
   stamps THAT into `data.path`.
4. **Fail loud** when the resolved checkout is absent on the worker — an explicit
   "project checkout not found on `<machine>` at `<path>`" error rather than letting
   `git worktree add` fault on a missing cwd.

Net effect for the failing case: ocaml-cudajit dispatched to minipc-wsl resolves to
`/home/lukstafi/ocaml-cudajit`, never the controller's `/Users/...`.

Issue: https://github.com/lukstafi/ludics/issues/579

**Scope guard:** this task is **path resolution only**. The sibling gh-ludics-580
(stale-local-harness auto-resume) is being implemented separately — do not touch the
resume / `setWorkerSlotsOverride` logic.

## Acceptance Criteria

1. **`path` config accepts a map.** `ProjectConfig.path` is `string | Record<string, string>`.
   Map keys are OS identifiers (`macos` / `linux`, matching `cluster.machines[].os` — NOT
   `darwin`) or machine names (e.g. `mac-studio`, `minipc-wsl`). Config loading /
   normalization / validation accepts both shapes; a non-string, non-object `path` is
   ignored as today. **Back-compat invariant:** every existing string `path:` entry (e.g.
   `path: ~/ocaml-cudajit`, `path: ~/ludics`) resolves byte-identically to today on the host
   it is resolved for.

2. **Target-machine-aware resolution.** `resolveProjectPath` resolves a project's checkout
   path *for a specified destination machine*, selecting in precedence order:
   `map[machineName]` (most specific) → `map[machineOS]` → the plain-string form. A
   `~/`-relative selected value is expanded against the **destination machine's** `$HOME`
   (the worker's `/home/lukstafi`, not the controller's `/Users/lukstafi`). When no
   destination machine is supplied, resolution behaves **exactly as today** — local config
   + local `$HOME` + the existing `~/name` / `~/repos/name` fallbacks — so every non-remote
   caller is unaffected.

3. **No same-OS-checkout requirement on disk.** Because the controller is macOS and the
   worker may be Linux, resolution for a remote destination must NOT depend on the resolved
   path existing on the controller's own filesystem (today `resolveProjectPath` only returns
   a `path:` value when `existsSync` passes locally — that existence gate must not silently
   discard a correct *remote* path on the controller). The controller computes the
   destination path purely from config + the destination's home convention; the
   **existence check happens on the worker** (AC5).

4. **Controller resolves for the destination at dispatch.** At keepalive auto-assign
   (`maybeAutofillSlot` in `src/mag.ts`, both the single and duo branches), the path stamped
   into the slot is resolved *for the machine the slot is being dispatched to* (the
   `selectMachineForSlot` result), not the controller's local path. For the failing case —
   ocaml-cudajit auto-assigned to minipc-wsl — `data.path` becomes `/home/lukstafi/ocaml-cudajit`.
   A slot dispatched to the local/controller machine is unchanged from today.

5. **Fail loud on absent checkout.** When a slot starts and the resolved project checkout
   does not exist on the executing host, slot-start throws an explicit error of the form
   `project checkout not found on <machine> at <path>` **before** `git worktree add` runs,
   so the operator sees the real cause instead of the misleading `posix_spawn 'git'`. The
   throw leaves the start intent **un-acked**, so the worker retries on the next tick once
   the checkout appears (NO auto-clone — out of scope). The guard sits right after path
   resolution, at the worktree-creating path's entry (`makeAdapterContext` / the top of
   `slotStart`'s adapter dispatch), keyed on `existsSync(projectDir)`.

6. **No regression to the local/common case.** Non-remote slot assignment and start behave
   exactly as today: a string `path:` resolves against the local host, the empty-`data.path`
   fallback in `makeAdapterContext` still re-resolves from the task's project, and a
   genuinely-present local checkout starts normally with no new error.

7. **Test coverage** (see Tests section). At minimum: string-path back-compat (unchanged);
   map keyed by OS resolves per destination; map keyed by machine name takes precedence over
   OS; `~/` expands against the destination home, not the controller's; controller-resolves-
   for-destination ships the Linux path (`/home/...`) for the minipc-wsl case; missing-checkout
   surfaces the explicit fail-loud error.

## Context

### Root cause — the controller stamps its own local absolute path

1. **Keepalive auto-assign** (`maybeAutofillSlot`, `src/mag.ts`) is the path-stamping site.
   Both branches do:
   ```ts
   const projectPath = resolveProjectPath(task.project);   // mag.ts:3345 (duo), 3371 (single)
   const machine = selectMachineForSlot({ project, effort, requirements });
   await slotAssign(slot, task.id, autoAdapter, "", projectPath, autoArgs, machine);
   ```
   `resolveProjectPath` (`src/config.ts:500`) reads the local config's `projects[].path`,
   expands a leading `~/` against the controller's `$HOME`, and **gates on `existsSync`
   locally** (lines 511–516). On mac-studio this yields `/Users/lukstafi/ocaml-cudajit`.
   `selectMachineForSlot` returns the *destination* (`minipc-wsl`) — but the path was already
   resolved for the controller, with no knowledge of that destination.

2. **`slotAssign`** (`src/slots/index.ts:346`) writes the supplied `path` verbatim into
   `data.path` (`path: path || null`, line 415) alongside `data.machine` (line 418). This is
   the only writer of `data.path`.

3. **Remote dispatch ships the slot map.** The controller records a `start` intent; the
   worker's `processSlotIntents` (`src/mag.ts`) pulls the fresh slot map, installs it via
   `setWorkerSlotsOverride`, and calls `slotStart(slotNum)` locally (this is gh-ludics-580
   territory — do not modify it; it is named here only to trace the bad path's journey).

4. **`makeAdapterContext`** (`src/slots/index.ts:905`) sets
   `let resolvedPath = data.path ?? "";` and only re-resolves locally when `data.path` is
   **empty** (lines 909–919, reading the task's `project` from frontmatter). Because the
   controller-shipped `data.path` is a non-empty (foreign) absolute path, the
   local-re-resolution branch never fires. `ctx.path` then flows into the tmux adapter's
   `normalizeWorkspacePath` (`src/adapters/tmux-adapter.ts:204`) → `createWorktrees` →
   `git worktree add` with `cwd: projectDir` (`src/orchestration/worktrees.ts:407`, via
   `runGit` → `safeSyncOutput`). The non-existent `cwd` is the ENOENT.

5. **The misleading error** comes from `safeSyncOutput` (`src/spawn.ts:13`), which returns
   `{ ok: false, exitCode: -1 }` on ENOENT-or-missing-cwd but does not distinguish a missing
   cwd from a missing binary — so the operator sees `posix_spawn 'git'`. AC5's explicit
   pre-check makes this case self-describing.

### Resolution authority — controller, not worker

The user **rejected** "worker discards `data.path` and re-resolves locally." Configs are
consistent across the cluster, so the controller (which holds the config) stays the
resolution authority — but a single `~/`-relative string cannot bridge genuinely different
roots across OSes (`/Users` vs `/home`), even though it works across same-OS machines. Hence
the optional map (AC1) + destination-aware resolution (AC2) + controller-resolves-at-dispatch
(AC4). The empty-`data.path` re-resolution branch in `makeAdapterContext` stays as the
local-only fallback (AC6).

### Existing resolution machinery (`src/config.ts:500`)

`resolveProjectPath(projectName)` today:
- matches a project by `name` or `repo` tail;
- if `p.path` is set, expands a leading `~/` against `process.env.HOME` and returns it
  **iff `existsSync`** (lines 511–516);
- else falls back through `~/<tail>`, `~/repos/<tail>`, upstream-repo tail, and finally
  `~/<projectName>` candidates, each gated on `existsSync`.

The map-aware variant must thread a *destination machine* through to the leading-`~/`
expansion (using the destination's home) and must NOT apply the local `existsSync` gate when
resolving for a remote destination (AC3) — the controller cannot see the worker's disk.

### Destination machine → OS / home

`clusterMachine(name)` (`src/cluster.ts:74`) returns the `ClusterMachine` with `os`
(`macos`/`linux`, defaulted `linux`) for OS-keyed map lookup. The destination's `$HOME` for
`~/` expansion is conventionally `/Users/<user>` on `macos` and `/home/<user>` on `linux`;
derive the leaf user from the controller's own `$HOME` basename (the federation runs the same
user `lukstafi` on every node) and join under the OS-appropriate home root. For a
**local/no-destination** resolution, keep using `process.env.HOME` directly so the local case
is byte-identical (AC2/AC6).

### Live config data (`config.yaml`)

- ocaml-cudajit: `repo: lukstafi/ocaml-cudajit`, `requirements.gpu: nvidia`,
  `path: ~/ocaml-cudajit` (string, `~/`-relative).
- `cluster.machines[].os` values are `macos` / `linux`. Relevant machines: `mac-studio`
  (`os: macos`, leader), `minipc-wsl` (`os: linux`, `gpu: nvidia`, the only nvidia host).

The string `~/ocaml-cudajit` already produces the correct path for *each* destination once
resolution expands against the destination's home (`/Users/lukstafi/ocaml-cudajit` on
mac-studio, `/home/lukstafi/ocaml-cudajit` on minipc-wsl) — so the failing case is fixed by
AC2+AC4 with the existing string config; **no `config.yaml` edit is required** for the fix.
The map (AC1) is the general mechanism for projects whose roots genuinely diverge beyond the
home-relative convention (e.g. a checkout under `/opt/...` on one OS).

## Approach

Included because the design is fully resolved (no open creative choice) and the call-site
audit pins the mechanics.

1. **Schema (AC1).** Widen `ProjectConfig.path` to `string | Record<string, string>` in
   `src/config.ts`. Audit config loading/normalization (`parseConfig` / the projects mapper)
   and any code that does `String(p.path)` — it must branch on the shape rather than coercing
   a map to `"[object Object]"`. Keep a non-string/non-object `path` ignored.

2. **Resolver (AC2, AC3).** Give `resolveProjectPath` an optional destination-machine
   parameter (default `undefined` = local, unchanged behavior). When a destination is given:
   resolve the project's `path` entry via `map[machineName] → map[machineOS] → string-form`,
   expand a leading `~/` against the destination's home root (OS-derived), and **skip the
   local `existsSync` gate** for the remote case (the path is for another host). Keep the
   `~/<tail>` / `~/repos/<tail>` fallbacks for the no-`path` case. **Audit all call sites**
   of `resolveProjectPath` (`src/mag.ts:3345`, `:3371`; `src/health.ts:116`;
   `src/config-cli.ts:11`; `src/slots/index.ts:916`) — the health, config-cli, and
   `makeAdapterContext`-fallback callers have no destination in scope and must keep the
   default (local) behavior.

3. **Dispatch-site resolution (AC4).** In `maybeAutofillSlot` (`src/mag.ts`), compute
   `machine` *before* the path, then resolve the path *for that machine*:
   `resolveProjectPath(task.project, machine)`. Apply to both the single and duo branches.
   `slotAssign` already persists the supplied path verbatim — no change there.

4. **Fail-loud guard (AC5).** In the worktree-creating path (after `makeAdapterContext`
   resolves `ctx.path`, or at the top of `slotStart`'s adapter dispatch), if the resolved
   `projectDir` is non-empty and `!existsSync(projectDir)`, throw
   `project checkout not found on <machine> at <path>` (machine = `data.machine` or the
   current host). Place it so the throw propagates *before* `createWorktrees` /
   `git worktree add`, leaving the intent un-acked for retry.

## Tests

Extend `src/slots/index.test.ts` (which already unit-tests `makeAdapterContext`, imports at
~line 5, cases ~680–900, plus remote-dispatch / off-cluster scaffolding ~2204 / ~2415) and
`src/config.test.ts` / `cluster.test.ts` patterns (config + machine resolution via
`LUDICS_CLUSTER_MACHINE_NAME` + a scratch `LUDICS_CONFIG`). Cover:

- **String back-compat:** an existing string `path:` resolves byte-identically to today for
  the local case (no destination passed).
- **Map keyed by OS:** `path: { macos: …, linux: … }` resolves to the OS-appropriate entry
  per destination.
- **Machine-name precedence:** a map with both a machine-name key and the destination's OS
  key resolves to the machine-name value.
- **`~/` against destination home:** a `~/`-relative result for a `linux` destination expands
  under `/home/...`, for `macos` under `/Users/...` — driven by the destination, not the
  controller's `$HOME`.
- **Controller-resolves-for-destination:** the minipc-wsl dispatch case yields
  `/home/lukstafi/ocaml-cudajit` (Linux), not `/Users/...` — exercise the
  `resolveProjectPath(project, machine)` call (or `maybeAutofillSlot`'s wiring).
- **Fail-loud:** a slot whose resolved `projectDir` does not exist surfaces the explicit
  `project checkout not found on <machine> at <path>` error (and does not reach
  `git worktree add`).
- **Local no-regression:** a non-remote slot with a present local checkout starts with no new
  error; the empty-`data.path` fallback still re-resolves from the task project.

Build/verify after changes: `bun run build` then `bun test` in `~/ludics`.

## Notes

- 2026-06-22: Proposal drafted from the user-resolved design (task `## Tentative Design` §
  "RESOLVED DESIGN (user, 2026-06-22)"). Authority = controller; mechanism = optional
  OS/machine-keyed `path` map + destination-aware `resolveProjectPath` + dispatch-site
  resolution in `maybeAutofillSlot` + fail-loud `existsSync` guard. The earlier
  "worker re-resolves and discards `data.path`" sketch is **superseded**. Scoped to path
  resolution only — gh-ludics-580 (stale-state resume) is separate.
- The failing case needs **no `config.yaml` edit**: `~/ocaml-cudajit` resolves correctly per
  destination once AC2+AC4 expand against the destination home. The map is the forward-looking
  mechanism for genuinely divergent roots.
- Verified against `config.yaml` HEAD: ocaml-cudajit `path: ~/ocaml-cudajit` (string),
  `requirements.gpu: nvidia`; cluster `os` values `macos`/`linux`; minipc-wsl is the sole
  `gpu: nvidia` host.
