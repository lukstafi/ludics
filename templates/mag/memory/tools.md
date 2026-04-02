# CLI Tools Knowledge

This file contains learned knowledge about CLI tools used in ludics workflows.

## yq (YAML processor)

### Usage Patterns
- Single file: `yq eval '.key' file.yaml` or `yq e '.key' file.yaml`
- Multiple files slurp: `yq eval-all '.' *.yaml` or `yq ea '.' *.yaml`
- Output as JSON: `yq -o json file.yaml`
- Output as YAML (explicit): `yq -o yaml file.yaml`

### Gotchas
- *Add gotchas learned from corrections here*

### Examples
```bash
# Extract frontmatter from task files
yq eval-all '.' tasks/*.md 2>/dev/null

# Get specific field
yq e '.status' task-042.md
```

---

## jq (JSON processor)

### Usage Patterns
- Basic filter: `jq '.key' file.json`
- Multiple values: `jq '.key1, .key2' file.json`
- Raw output: `jq -r '.key' file.json`
- Slurp array: `jq -s '.' *.json`

### Gotchas
- *Add gotchas learned from corrections here*

### Examples
```bash
# Filter ready tasks
jq '[.[] | select(.status == "ready")]' tasks.json

# Sort by priority
jq 'sort_by(.priority)' tasks.json
```

---

## tsort (Topological sort)

### Usage
- Input: pairs of dependencies, one per line (format: `A B` means A must come before B)
- Output: sorted list
- Detects cycles (exits with error)

### Example
```bash
# Check for dependency cycles
echo "task-1 task-2
task-2 task-3" | tsort

# Will fail if cycle exists
```

---

## gh (GitHub CLI)

### Common Commands
```bash
# Issues
gh issue list --repo owner/repo
gh issue view 123 --json title,body,labels

# PRs
gh pr list --repo owner/repo
gh pr view 123 --json state,reviews

# API
gh api --paginate repos/owner/repo/issues/123/comments
```

### Gotchas
- *Add gotchas learned from corrections here*

---

## git

### Useful Commands
```bash
# Recent commits
git log --since="1 day ago" --oneline

# Check if in worktree
test -f .git  # True if worktree (file), false if main repo (directory)

# Get main repo from worktree
cat .git | grep gitdir | cut -d' ' -f2-
```

---

## tmux

### Common Commands
```bash
# Sessions
tmux new-session -d -s name -c /path
tmux has-session -t name
tmux kill-session -t name
tmux ls

# Send commands
tmux send-keys -t session "command"
tmux send-keys -t session C-m

# Capture output
tmux capture-pane -t session -p -S -100
```

---

## Add New Tools

*When learning about a new tool, add a section following the pattern above.*
