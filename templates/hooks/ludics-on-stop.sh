#!/bin/bash
# ludics Mag Stop Hook
# Installed by: ludics init --hooks
#
# This hook fires when Claude Code finishes a turn. It reads the Stop event
# JSON from stdin, pops the next queued request, and outputs a JSON decision
# to continue Claude with the skill command.
#
# Loop prevention: when the queue is empty, mag_queue_pop outputs nothing
# (exit 0), so Claude stops naturally. No stop_hook_active guard needed.

# Ensure Bash 4+ and tools like jq/yq are available (macOS system bash is v3)
export PATH="/opt/homebrew/bin:$PATH"

# Read Stop event input from stdin
input=$(cat)

# Ignore subagent stops; queue-pop should only run for top-level Stop events.
hook_event_name=$(echo "$input" | jq -r '.hook_event_name // ""' 2>/dev/null)
if [[ "$hook_event_name" == "SubagentStop" ]]; then
  exit 0
fi

# Extract cwd so mag queue-pop can verify this is Mag session
cwd=$(echo "$input" | jq -r '.cwd // ""' 2>/dev/null)

# Find ludics binary and run queue-pop
if command -v ludics >/dev/null 2>&1; then
  exec ludics mag queue-pop "$cwd" "$hook_event_name"
fi

# Fallback: check common install locations
for bin in "$HOME/.local/bin/ludics" "$HOME/.local/ludics/bin/ludics"; do
  if [[ -x "$bin" ]]; then
    exec "$bin" mag queue-pop "$cwd" "$hook_event_name"
  fi
done

# ludics not found - exit silently
exit 0
