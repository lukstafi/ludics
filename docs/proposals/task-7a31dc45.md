# Extract reusable merge_json helper in setup.sh

## Goal

After task-121e5814 removes the jq codepaths, Step 5 of `setup.sh` will have two bun trust blocks (Codex and Claude Code) that follow the same pattern: ensure a JSON file exists with default content, pipe project paths via stdin, run a bun one-liner that reads the file, merges paths, and writes back. Extract a `merge_json` shell function to encapsulate the shared scaffolding, with each caller supplying only the file path, default JSON content, and the bun JS transform logic.

## Acceptance Criteria

1. A shell function `merge_json` (or similar name) is defined in `setup.sh` before Step 5, accepting at minimum: (a) target file path, (b) default JSON content for initialization, and (c) a bun JS transform expression or inline script.
2. The function handles: creating the target file with default content if it does not exist, piping `$PATHS_LINES` via stdin, invoking `bun -e` with the provided transform, and passing the target file path via environment variable.
3. The Codex trust block is replaced by a single call to `merge_json` with the appropriate arguments (file: `$CODEX_STATE`, default: `{"electron-saved-workspace-roots":[]}`, transform: the existing Set-based array merge logic).
4. The Claude Code trust block is replaced by a single call to `merge_json` with the appropriate arguments (file: `$CLAUDE_STATE`, default: `{}`, transform: the existing Object.assign-based object merge logic).
5. `PATHS_LINES` is still computed once before the function calls (unchanged from current code).
6. `setup.sh` runs successfully: `bash setup.sh` completes Step 5 without errors and produces the same JSON output in `~/.codex/.codex-global-state.json` and `~/.claude.json` as before.
7. Net line reduction: the two trust blocks combined should be shorter than the pre-refactor version (target: ~15-20 lines for the function + ~5 lines per call site, vs ~30+ lines for the two inline blocks).

## Context

**File**: `setup.sh`, Step 5 ("Pre-trusting project directories for Codex and Claude Code").

**Dependency**: This task must run AFTER task-121e5814, which removes jq codepaths and leaves bun-only trust blocks. The code to refactor is the post-121e5814 state of Step 5.

**Post-121e5814 Codex block** (bun-only, approximate):
```bash
CODEX_STATE="$HOME/.codex/.codex-global-state.json"
mkdir -p "$HOME/.codex"
[[ ! -f "$CODEX_STATE" ]] && echo '{"electron-saved-workspace-roots":[]}' > "$CODEX_STATE"
echo "$PATHS_LINES" | CODEX_STATE="$CODEX_STATE" bun -e '
  const fs = require("fs");
  const stateFile = process.env.CODEX_STATE;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const roots = new Set(state["electron-saved-workspace-roots"] || []);
  const lines = fs.readFileSync("/dev/stdin", "utf8").trim().split("\n");
  for (const p of lines) roots.add(p);
  state["electron-saved-workspace-roots"] = [...roots].sort();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
'
```

**Post-121e5814 Claude Code block** (bun-only, approximate):
```bash
CLAUDE_STATE="$HOME/.claude.json"
[[ ! -f "$CLAUDE_STATE" ]] && echo '{}' > "$CLAUDE_STATE"
echo "$PATHS_LINES" | CLAUDE_STATE="$CLAUDE_STATE" bun -e '
  const fs = require("fs");
  const stateFile = process.env.CLAUDE_STATE;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!state.projects) state.projects = {};
  const lines = fs.readFileSync("/dev/stdin", "utf8").trim().split("\n");
  for (const p of lines) {
    state.projects[p] = Object.assign({}, state.projects[p] || {}, {hasTrustDialogAccepted: true});
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
'
```

**Common pattern** to extract into `merge_json`:
1. Ensure target file exists (create with default content)
2. Pipe `$PATHS_LINES` to stdin
3. Pass target file path via `STATE_FILE` env var
4. Run bun with caller-supplied JS transform that reads `STATE_FILE`, reads stdin lines, applies transform, writes back

The JS transform receives `process.env.STATE_FILE` as the file path and stdin as newline-separated paths. The function signature would be roughly:
```bash
merge_json <file> <default_json> <bun_js_transform>
```
