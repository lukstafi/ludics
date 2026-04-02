# Proposal: Pre-trust project directories for Codex

**Task**: task-cb53777e
**Project**: ludics

## Goal

Eliminate the interactive "Do you trust this directory?" prompt that blocks unattended Codex agent boot. Codex checks trust at startup independently of `--yolo`, so new project directories (e.g. staging forks) trigger a blocking prompt even in fully-automated flows.

## Acceptance Criteria

1. After running `setup.sh`, every project `path` directory from `config.yaml` appears in `~/.codex/.codex-global-state.json` under `"electron-saved-workspace-roots"`.
2. Existing keys in the JSON file (window bounds, atom state, etc.) are preserved -- only the roots array is merged.
3. If `~/.codex/` or the state file does not exist, the directory and a minimal JSON structure are created.
4. Duplicate paths are not inserted (idempotent).
5. Only project `path` directories are added (not `upstream_repo` directories) -- worktrees inherit trust from the parent repo.

## Context

- **Trust storage**: Codex persists trusted workspace roots in `~/.codex/.codex-global-state.json`, key `"electron-saved-workspace-roots"` (JSON array of absolute paths).
- **Trust vs --yolo**: The trust prompt is a separate startup-time mechanism, not bypassed by `--yolo`. This blocks unattended Codex agent sessions launched by ludics adapters.
- **Worktree inheritance**: Worktrees of already-trusted repos inherit trust, so only the main project directory needs to be added.
- **Config parsing**: `setup.sh` already parses project paths from config in the Step 4 clone loop (lines 240-278). The resolved `path` (with `~` expanded) is available for each project.

## Approach

Add a new Step 5 to `setup.sh` (after the project clone loop at line 282, before the "Setup complete" step) that:

1. **Collects project paths**: Reuse the same config-parsing loop or accumulate paths into an array during the existing clone loop. Each project's resolved `path` (with `~` expanded to `$HOME`) is collected. Only the `path` field is used -- `upstream_repo` directories are excluded.

2. **Reads existing state**: If `~/.codex/.codex-global-state.json` exists, read it. Otherwise, seed `{"electron-saved-workspace-roots": []}`.

3. **Merges roots**: For each project path, add it to the `"electron-saved-workspace-roots"` array if not already present. Use `jq` for JSON manipulation (already expected on dev machines; `setup.sh` can install it via `install_pkg` if missing, or use `bun -e` as fallback).

4. **Writes back**: Write the updated JSON to the state file, preserving all other keys.

**Implementation detail**: The simplest approach is to accumulate paths in a bash array during the existing parse loop (adding a line like `project_paths+=("$resolved_path")` inside `flush_project`), then after the loop, run a single `jq` invocation:

```bash
# Pre-trust project directories for Codex
step "Pre-trusting project directories for Codex"

CODEX_STATE="$HOME/.codex/.codex-global-state.json"
mkdir -p "$HOME/.codex"

if [[ ! -f "$CODEX_STATE" ]]; then
  echo '{"electron-saved-workspace-roots":[]}' > "$CODEX_STATE"
fi

# Build jq filter to add paths
jq_filter='."electron-saved-workspace-roots" |= (. + $paths | unique)'
jq --argjson paths "$(printf '%s\n' "${project_paths[@]}" | jq -R . | jq -s .)" \
   "$jq_filter" "$CODEX_STATE" > "${CODEX_STATE}.tmp" \
   && mv "${CODEX_STATE}.tmp" "$CODEX_STATE"

info "Codex trust: ${#project_paths[@]} project directories registered"
```

**Edge cases handled**:
- Fresh machine with no `~/.codex/` directory -- created via `mkdir -p`.
- Empty or missing state file -- seeded with minimal JSON.
- `jq` not installed -- add to the dependency check section (Step 1) or fall back to `bun -e` with a simple JSON merge script.
- Paths already present -- `unique` in `jq` deduplicates.

**Scope**: Only `setup.sh` is modified. No changes to adapters or runtime code.
