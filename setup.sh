#!/usr/bin/env bash
set -euo pipefail

# ludics setup — bootstrap from a fresh machine
# Usage: ./setup.sh

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[!]${RESET} $*"; }
fail()  { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
step()  { echo -e "\n${BOLD}--- $* ---${RESET}"; }

# ── Step 1: External dependencies ────────────────────────────────────────────

step "Checking dependencies"

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }
is_linux() { [[ "$(uname -s)" == "Linux" ]]; }

ensure_brew() {
  if ! command -v brew &>/dev/null; then
    warn "Homebrew not found — installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
}

install_pkg() {
  local name="$1"
  local brew_name="${2:-$1}"
  if is_macos; then
    ensure_brew
    brew install "$brew_name"
  elif is_linux; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y "$name"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y "$name"
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm "$name"
    else
      fail "No supported package manager found — install $name manually"
    fi
  else
    fail "Unsupported OS — install $name manually"
  fi
}

# bun
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if command -v bun &>/dev/null; then
  info "bun: $(bun --version)"
else
  warn "bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  info "bun: $(bun --version)"
fi

# tmux
if command -v tmux &>/dev/null; then
  info "tmux: $(tmux -V)"
else
  warn "tmux not found — installing..."
  install_pkg tmux
  info "tmux: $(tmux -V)"
fi

# tailscale (on macOS the CLI lives inside the app bundle)
TAILSCALE_MACOS_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
if command -v tailscale &>/dev/null; then
  info "tailscale: $(tailscale version | head -1)"
elif is_macos && [[ -x "$TAILSCALE_MACOS_CLI" ]]; then
  info "tailscale: $("$TAILSCALE_MACOS_CLI" version | head -1) (app bundle)"
else
  warn "tailscale not found — installing..."
  if is_macos; then
    ensure_brew
    brew install --cask tailscale
  elif is_linux; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    fail "Unsupported OS — install tailscale manually"
  fi
  info "tailscale installed"
fi

# gh (GitHub CLI)
if command -v gh &>/dev/null; then
  info "gh: $(gh --version | head -1)"
else
  warn "gh not found — installing..."
  install_pkg gh
  info "gh: $(gh --version | head -1)"
fi

# ttyd (web terminal)
if command -v ttyd &>/dev/null; then
  info "ttyd: $(ttyd --version 2>&1 | head -1)"
else
  warn "ttyd not found — installing..."
  install_pkg ttyd
  info "ttyd installed"
fi

# ── Step 2: Build & initialize Ludics ────────────────────────────────────────

step "Building Ludics"

LUDICS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$LUDICS_DIR"

bun install
bun run build
info "compiled bin/ludics"

step "Running ludics init"

# Ensure ~/.local/bin is on PATH for this session
export PATH="$HOME/.local/bin:$PATH"

# --no-triggers: avoid restarting launchd/systemd agents on re-run
# --no-dashboard: avoid restarting the dashboard server on re-run
# Run 'ludics init' without these flags for a full re-initialization.
bin/ludics init --no-triggers --no-dashboard
info "ludics init complete"

# ── Step 3: Clone t3code-ludics ──────────────────────────────────────────────

step "Checking t3code-ludics"

T3CODE_DIR="$HOME/t3code-ludics"
if [[ -d "$T3CODE_DIR" ]]; then
  info "t3code-ludics: already at $T3CODE_DIR"
else
  warn "t3code-ludics not found — cloning..."
  gh repo clone lukstafi/t3code-ludics "$T3CODE_DIR" || warn "failed to clone t3code-ludics"
  if [[ -d "$T3CODE_DIR" ]]; then
    info "t3code-ludics: cloned to $T3CODE_DIR"
  fi
fi

# ── Step 4: Clone missing project repos ──────────────────────────────────────

step "Checking project repositories"

CONFIG_PATH="${LUDICS_CONFIG:-}"
if [[ -z "$CONFIG_PATH" ]]; then
  CONFIG_PATH="$HOME/.config/ludics/config.yaml"
  if [[ ! -f "$CONFIG_PATH" ]]; then
    CONFIG_PATH="$HOME/.config/pai-lite/config.yaml"
  fi
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  warn "No config file found — skipping project clone"
  exit 0
fi

# Read the resolved config (which may be in the state repo)
# Use ludics itself to avoid reimplementing config resolution
# Fall back to reading the pointer config directly
STATE_REPO=$(grep -E '^\s*state_repo:' "$CONFIG_PATH" | head -1 | sed 's/.*state_repo:\s*//' | tr -d '"' | tr -d "'" | xargs)
STATE_PATH=$(grep -E '^\s*state_path:' "$CONFIG_PATH" | head -1 | sed 's/.*state_path:\s*//' | tr -d '"' | tr -d "'" | xargs)
STATE_PATH="${STATE_PATH:-harness}"

RESOLVED_CONFIG="$CONFIG_PATH"
if [[ -n "$STATE_REPO" && "$STATE_REPO" != *"your-username"* ]]; then
  REPO_NAME="${STATE_REPO##*/}"
  CANDIDATE="$HOME/$REPO_NAME/$STATE_PATH/config.yaml"
  if [[ -f "$CANDIDATE" ]]; then
    RESOLVED_CONFIG="$CANDIDATE"
  fi
fi

# Harness directory: the state repo's harness subdirectory (mirrors harnessDir() in config.ts)
HARNESS_DIR="${REPO_NAME:+$HOME/$REPO_NAME/$STATE_PATH}"

# Parse projects from config — extract repo and path fields
# Uses a simple state machine to handle YAML list items
in_projects=false
current_repo=""
current_staging_repo=""
current_path=""

clone_repo() {
  local repo="$1"
  local local_dir="$2"

  if [[ -d "$local_dir" ]]; then
    info "project $repo: already at $local_dir"
  else
    warn "project $repo: cloning to $local_dir..."
    gh repo clone "$repo" "$local_dir" || warn "failed to clone $repo"
    if [[ -d "$local_dir" ]]; then
      info "project $repo: cloned to $local_dir"
    fi
  fi
}

clone_if_missing() {
  local repo="$1"
  local staging_repo="$2"
  local path="$3"

  if [[ -z "$repo" || "$repo" == *"your-username"* ]]; then
    return
  fi

  # Working repo = staging_repo if set, otherwise repo
  local working_repo="${staging_repo:-$repo}"

  # path points to the working repo checkout
  local local_dir=""
  if [[ -n "$path" ]]; then
    local_dir="${path/#\~/$HOME}"
  else
    local_dir="$HOME/${working_repo##*/}"
  fi

  clone_repo "$working_repo" "$local_dir"

  # Also clone upstream alongside when staging is configured
  if [[ -n "$staging_repo" && "$staging_repo" != "$repo" ]]; then
    local upstream_dir="$HOME/${repo##*/}"
    clone_repo "$repo" "$upstream_dir"
  fi
}

project_paths=()

flush_project() {
  if [[ -n "$current_repo" ]]; then
    clone_if_missing "$current_repo" "$current_staging_repo" "$current_path"

    # Accumulate resolved project path for Codex trust
    local resolved_path=""
    if [[ -n "$current_path" ]]; then
      resolved_path="${current_path/#\~/$HOME}"
    else
      local working_repo="${current_staging_repo:-$current_repo}"
      resolved_path="$HOME/${working_repo##*/}"
    fi
    project_paths+=("$resolved_path")
  fi
  current_repo=""
  current_staging_repo=""
  current_path=""
}

while IFS= read -r line; do
  # Detect start of projects section
  if [[ "$line" =~ ^projects: ]]; then
    in_projects=true
    continue
  fi

  # Detect end of projects section (new top-level key)
  if $in_projects && [[ "$line" =~ ^[a-z_]+: ]] && [[ ! "$line" =~ ^[[:space:]] ]]; then
    flush_project
    in_projects=false
    continue
  fi

  if ! $in_projects; then
    continue
  fi

  # New list item
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]] ]]; then
    flush_project
  fi

  # Extract staging_repo (must come before repo — "staging_repo:" contains "repo:")
  if [[ "$line" =~ staging_repo:[[:space:]]*(.+) ]]; then
    current_staging_repo="${BASH_REMATCH[1]}"
    current_staging_repo=$(echo "$current_staging_repo" | tr -d '"' | tr -d "'" | xargs)
  # Extract repo
  elif [[ "$line" =~ repo:[[:space:]]*(.+) ]]; then
    current_repo="${BASH_REMATCH[1]}"
    current_repo=$(echo "$current_repo" | tr -d '"' | tr -d "'" | xargs)
  fi

  # Extract path
  if [[ "$line" =~ path:[[:space:]]*(.+) ]]; then
    current_path="${BASH_REMATCH[1]}"
    current_path=$(echo "$current_path" | tr -d '"' | tr -d "'" | xargs)
  fi
done < "$RESOLVED_CONFIG"

# Flush last project
flush_project

# ── Step 5: Pre-trust project directories for Codex & Claude Code ───────────

step "Pre-trusting project directories for Codex and Claude Code"

if [[ ${#project_paths[@]} -gt 0 ]]; then
  # ── Codex trust ──
  CODEX_STATE="$HOME/.codex/.codex-global-state.json"
  mkdir -p "$HOME/.codex"

  if [[ ! -f "$CODEX_STATE" ]]; then
    echo '{"electron-saved-workspace-roots":[]}' > "$CODEX_STATE"
  fi

  # Build path data for both jq and bun fallbacks
  PATHS_LINES="$(printf '%s\n' "${project_paths[@]}")"
  if command -v jq &>/dev/null; then
    PATHS_JSON="$(echo "$PATHS_LINES" | jq -R . | jq -s .)"
  fi

  if command -v jq &>/dev/null; then
    jq --argjson paths "$PATHS_JSON" \
       '."electron-saved-workspace-roots" |= (. + $paths | unique)' \
       "$CODEX_STATE" > "${CODEX_STATE}.tmp" \
       && mv "${CODEX_STATE}.tmp" "$CODEX_STATE"
  else
    # Pass paths via stdin and file path via env to avoid interpolating into JS source
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
  fi

  info "Codex trust: ${#project_paths[@]} project directories registered"

  # ── Claude Code trust ──
  CLAUDE_STATE="$HOME/.claude.json"

  if [[ ! -f "$CLAUDE_STATE" ]]; then
    echo '{}' > "$CLAUDE_STATE"
  fi

  if command -v jq &>/dev/null; then
    jq --argjson paths "$PATHS_JSON" '
      .projects //= {} |
      reduce $paths[] as $p (.; .projects[$p] = ((.projects[$p] // {}) + {"hasTrustDialogAccepted": true}))
    ' "$CLAUDE_STATE" > "${CLAUDE_STATE}.tmp" \
       && mv "${CLAUDE_STATE}.tmp" "$CLAUDE_STATE"
  else
    # Pass paths via stdin to avoid interpolating into JS source
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
  fi

  info "Claude Code trust: ${#project_paths[@]} project directories registered"
else
  info "No project directories to register for trust"
fi

step "Claude Code memory symlink"

if [[ -z "$HARNESS_DIR" ]]; then
  info "No state repo configured — skipping memory symlink"
elif [[ ! -d "$HARNESS_DIR" ]]; then
  warn "Harness directory $HARNESS_DIR does not exist — skipping memory symlink"
else

# Symlink Claude Code auto-memory into the harness repo so it's git-synced
# across machines. The project key is derived from the harness parent directory.
HARNESS_PARENT="$(dirname "$HARNESS_DIR")"
# Claude Code encodes paths by replacing / with - and stripping the leading -
PROJECT_KEY="-$(echo "$HARNESS_PARENT" | tr '/' '-' | sed 's/^-//')"
CLAUDE_MEMORY_SRC="$HARNESS_DIR/claude-memory"
CLAUDE_MEMORY_DST="$HOME/.claude/projects/$PROJECT_KEY/memory"

if [[ -d "$CLAUDE_MEMORY_SRC" ]]; then
  mkdir -p "$(dirname "$CLAUDE_MEMORY_DST")"
  if [[ -L "$CLAUDE_MEMORY_DST" ]]; then
    info "Claude memory symlink already exists"
  elif [[ -d "$CLAUDE_MEMORY_DST" ]]; then
    # Merge existing local memories into repo, then replace with symlink
    cp -n "$CLAUDE_MEMORY_DST"/* "$CLAUDE_MEMORY_SRC/" 2>/dev/null || true
    rm -rf "$CLAUDE_MEMORY_DST"
    ln -s "$CLAUDE_MEMORY_SRC" "$CLAUDE_MEMORY_DST"
    info "Merged local memories and created symlink"
  else
    ln -s "$CLAUDE_MEMORY_SRC" "$CLAUDE_MEMORY_DST"
    info "Created Claude memory symlink: $CLAUDE_MEMORY_DST -> $CLAUDE_MEMORY_SRC"
  fi
else
  info "No claude-memory directory in harness — skipping symlink"
fi

fi  # end HARNESS_DIR guard

step "Setup complete"

# Check if ~/.local/bin is in the user's default PATH (not just this session)
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin" || \
   ! grep -qsE '\.local/bin' "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile" 2>/dev/null; then
  warn "~/.local/bin may not be in your shell's PATH"
  echo "  Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo "Run 'ludics status' to verify everything is working."
