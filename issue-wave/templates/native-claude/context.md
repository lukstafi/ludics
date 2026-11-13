## Keeping your context lean (this is a regular-mode wave)

Every request you make re-reads your whole context, so its size is the wave's main cost.
- Send wide reads, log digests and review-thread sweeps to your own subagents (the `Agent` tool,
  e.g. `Explore`), which return conclusions, not dumps.
- Read logs with `tail` or `grep`, never whole. Put independent tool calls in one message.
- Go straight from the merge to the after-merge brainstorm and the hand-back.
