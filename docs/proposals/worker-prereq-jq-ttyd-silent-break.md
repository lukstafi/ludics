# Harden worker onboarding against silently-breaking prereq gaps (jq off-PATH, ttyd login service)

## Goal

On a Linux worker (root-caused live on `minipc-wsl`) the orchestration on-stop
hook silently breaks when `jq` isn't on the hook's PATH: **every** orchestration
agent stop fails, `.peer-sync/<agent>.stop.json` is never written, phase-completion
signals are lost, and orchestration only limps forward on the keepalive's
dead-orchestrator detection — stalling at steps that need a real turn signal
(e.g. submitting the coder's final "merge the PR" instruction). The failure
surfaces only as a confusing downstream `usage:` error, not a clear "jq not found"
diagnostic.

The root cause is a class of gotcha, not a single line: **installing (or failing
to install) a ludics prerequisite has a side effect that silently breaks ludics,
with nothing flagging it.** Two concrete instances:

1. **jq off-PATH / absent** — the on-stop hook hard-depends on `jq` but resolves
   it as a bare `jq` on a macOS-centric PATH (`/opt/homebrew/bin` only). A worker
   with `jq` in `~/.local/bin` (or with a full-path-only toolchain) silently
   breaks. `setup.sh` compounds this: it uses `jq` only behind `command -v jq`
   guards with bun fallbacks, so it works *without* jq and neither installs it
   nor signals its absence.

2. **ttyd login service squatting slot ports** — installing the Debian/Ubuntu
   `ttyd` package (a ludics prereq — ludics needs the *binary*) also ships and
   enables `/usr/lib/systemd/system/ttyd.service`, which auto-starts a login ttyd
   on port **7681** at boot. That is exactly the port ludics computes for the
   slot-1 coder web terminal. The agent/tmux run fine; only the per-slot ttyd
   can't bind, silently.

Issue: https://github.com/lukstafi/ludics/issues/590

## Acceptance Criteria

### jq resolution in the on-stop hook (`templates/hooks/ludics-on-stop.sh`)

1. The hook resolves `jq` to an absolute path the same way it already resolves
   the `ludics` binary: try `command -v jq`, then fall back over candidate paths
   including `$HOME/.local/bin/jq`. All three `jq` invocation sites (the
   `hook_event_name` read, the `cwd` read, and the marker-file `.peerSyncDir` /
   `.agentName` reads) call the resolved binary, not bare `jq`.
2. `$HOME/.local/bin` is added to the hook's `PATH` (additively — the existing
   `/opt/homebrew/bin` prepend stays so macOS workers/leader are unaffected).
3. When `jq` is genuinely unresolvable, the hook emits a clear diagnostic to
   stderr that names `jq` (so the failure is not a downstream `usage:` red
   herring) and exits **non-zero** — it does not hand an empty `cwd` to
   `ludics orch on-stop`.
4. The **Codex notify path** (`$1 == "codex"`) still works: its marker-file `jq`
   reads use the resolved binary too (the `jq_bin` resolution happens once, ahead
   of the mode branch).

### jq prerequisite gate in `ludics init` (`src/init.ts`)

5. `runInit()` performs a `jq` prerequisite check that **hard-fails**
   (`process.exit(1)`) with an install hint, mirroring the existing `which tmux`
   / `which ttyd` gates (`safeSyncOutput(["which", "jq"]).ok`). The hint names the
   install command per-OS (`brew install jq` / `apt install jq`). A worker must
   not complete `init` without `jq`.

### jq install in `setup.sh`

6. `setup.sh` installs `jq` at onboarding via the existing `install_pkg`
   pattern (the same `command -v jq` → `install_pkg jq` block shape used for
   `tmux` / `ttyd`), so a freshly-onboarded worker is never jq-less.

### ttyd login-service collision (`setup.sh` + conflict detection)

7. After installing the `ttyd` package on Linux, `setup.sh` disables the
   auto-enabled login service (`systemctl disable --now ttyd.service`) when that
   unit exists, keeping the binary while dropping the boot-time port-7681 squat.
   The step is a no-op / harmless where the unit is absent (macOS, distros that
   don't ship it).
8. ludics surfaces a slot-port conflict loudly rather than failing silently:
   when a slot's computed ttyd port (`7681 + (slot-1)*2 + roleIndex`, per
   `ttydPort` in `src/adapters/tmux-adapter.ts`) is already bound by another
   process at the point ludics would bind it, the operator gets a clear
   diagnostic naming the port and slot. The hardcoded slot ports are kept
   (deliberate, per user — muscle-memory/consistency); the fix is **detection**,
   not port randomization.

### Verification

9. The init jq gate is covered by a test (TS-testable) following the existing
   `src/init.ts` / `src/mag.ts` `safeSyncOutput(["which", ...])` patterns. The
   shell-hook changes need not have a direct unit test (no existing test asserts
   hook behavior); a focused test on the init gate is sufficient.

## Context

How things work now:

- **`templates/hooks/ludics-on-stop.sh`** — fires on Claude Code Stop / Codex
  notify. PATH line: `export PATH="/opt/homebrew/bin:$PATH"` (comment claims it
  ensures `jq`/`yq` are available, but only adds the Homebrew dir). The `ludics`
  binary is resolved robustly via `command -v ludics` then a fallback loop over
  `"$HOME/.local/bin/ludics"` / `"$HOME/.local/ludics/bin/ludics"` — this is the
  house pattern to mirror for `jq`. `jq` is invoked at three sites: the
  `hook_event_name` read, the `cwd` read (both Claude-stdin-only), and the
  marker-file walk-up reads of `.peerSyncDir` / `.agentName` from
  `.ludics-orchestration.json` (both modes). All three use bare `jq` with
  `2>/dev/null`, which swallows the exit-127 and yields empty strings; an empty
  `cwd` is then passed to `ludics orch on-stop`, producing the `usage:` error.

- **`src/init.ts`** — `runInit()`; `installStopHook(root)` copies the template to
  `$HOME/.local/bin/ludics-on-stop`. The "Backend-specific setup" block (the
  `adapter === "tmux"` branch) already hard-gates `which tmux` and `which ttyd`
  via `safeSyncOutput([...]).ok` + `console.error` + `process.exit(1)` with
  install hints — the jq gate mirrors these. `safeSyncOutput` is imported from
  `./spawn.ts`. Prior art for the message style: `magDoctor()` in `src/mag.ts`
  does `safeSyncOutput(["which", "jq"]).ok` with a "jq: found" / "jq: NOT FOUND
  (required for queue processing)" report (that one is a soft warn; per the
  resolved question the init gate is a hard fail).

- **`setup.sh`** — worker onboarding installer. `install_pkg name [brew_name]`
  dispatches `brew install` (macOS) / `apt-get|dnf|pacman install` (Linux). The
  dependency checks for `bun`, `tmux`, `tailscale`, `gh`, `ttyd` all follow
  `if command -v X; then info; else warn + install_pkg X; fi`. There is **no**
  jq block. `jq` appears later (around the Codex/Claude path-data emit) only
  behind `command -v jq &>/dev/null` guards with `bun -e` fallbacks — so it
  silently works without jq. The `ttyd` install block (the `# ttyd (web
  terminal)` section) runs `install_pkg ttyd` with no follow-up service disable.

- **Slot ttyd ports** — `ttydPort(slot, role)` in
  `src/adapters/tmux-adapter.ts` returns `PORT_BASE + (slot-1)*2 + roleIndex`
  with `PORT_BASE = 7681`; the same arithmetic is duplicated in
  `src/dashboard.ts`. Slot-1 coder = 7681, exactly the Debian ttyd-package
  default. ttyd processes are spawned in `tmux-adapter.ts` (the `ttyd --writable
  -6 --port <port> ...` invocations) — the natural place to detect a bind
  collision.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The jq surfaces (ACs 1–6) are straightforward and were iterated with the user;
follow the existing house patterns verbatim:

- **Hook**: add a `jq_bin` resolution block mirroring the `ludics_bin` block
  (`command -v jq`, then fallback over `"$HOME/.local/bin/jq"`), placed once near
  the top (before the mode branch), and add `$HOME/.local/bin` to the PATH line.
  Replace the three bare `jq` calls with `"$jq_bin"`. If `jq_bin` is empty, echo
  a `jq not found` diagnostic to stderr and `exit 1`.
- **init**: add a jq gate in `runInit()` alongside the tmux/ttyd gates (or near
  `installStopHook`), `safeSyncOutput(["which", "jq"]).ok` → on failure
  `console.error` with `brew install jq` / `apt install jq` hint +
  `process.exit(1)`.
- **setup.sh**: add a jq block in the dependency section mirroring the `tmux`
  block (`command -v jq` → `install_pkg jq`).

For the ttyd-service collision (ACs 7–8):

- **setup.sh**: after the `install_pkg ttyd` call, on Linux, guard a
  `systemctl disable --now ttyd.service` behind a check that the unit exists
  (e.g. `systemctl list-unit-files | grep -q ttyd.service`, or
  `[[ -f /usr/lib/systemd/system/ttyd.service ]]`) so it's a no-op elsewhere.
- **Conflict detection**: when ludics is about to spawn a per-slot ttyd, check
  whether the computed port is already bound and, if so, emit a clear diagnostic
  naming the port and slot. The exact mechanism (pre-bind probe vs. detecting
  the spawn failure and translating it) is the implementer's call — the AC is
  about the *loud, specific diagnostic*, not the probe technique.

## Scope

**In scope:**
- jq robustness across all three surfaces (hook, init, setup.sh) — the durable
  fix for the silent on-stop break (issue #590 core).
- The ttyd login-service disable in setup.sh + slot-port conflict detection
  (addendum 2 to the task — same "silent prereq side-effect" theme, shares
  `setup.sh` as a fix surface).

**Out of scope:**
- Vendoring a static `jq` binary (resolved NO — robust resolution + init gate +
  OS-package install supersede the temporary minipc-wsl static-jq workaround).
- Randomizing or reassigning slot ports — the hardcoded 7681-base scheme stays
  (user: deliberate for muscle-memory); only conflict *detection* is added.
- Broader auditing of other prereqs for similar Debian-packaging side effects
  (the pattern is noted but only the two known instances are fixed here).

**Dependencies:** `blocked_by: gh-ludics-589` (duo slotB launch) — per the issue
the on-stop error *compounded* #589 but is a separate, broader defect; this
proposal stands on its own and need not wait on #589's resolution for the fix to
be correct, but the dependency is recorded in the task frontmatter.
