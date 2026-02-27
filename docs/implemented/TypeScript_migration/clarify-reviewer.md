# Reviewer's Comments

## Comments on Coder's Approach

The proposed sequencing (Phase 0 scaffold first, then Phase 1 session discovery) is sound and matches the migration document. The emphasis on preserving validated behavior (longest-prefix slot matching, dedup ranking, stale filtering, classified/unclassified output) is the right risk-control strategy.

Main risks to manage early:
- Behavioral drift from `lib/sessions.sh` output formats (JSON and Markdown) that downstream workflows may depend on.
- Wrapper dispatch edge cases during transition (command routing, help text, exit codes, and behavior when TS binary is missing/outdated).
- Data-shape variance across real session stores; TypeScript types should allow unknown/optional fields and keep robust fallbacks.

Suggestion: define a small compatibility matrix before coding (commands, outputs, exit behavior, fallback behavior), then validate against fixtures/golden outputs from representative Codex + Claude + tmux + ttyd samples.

## Additional Questions

1. Should Phase 1 maintain strict output compatibility with the current `sessions` artifacts (including Markdown section names/order), or is a controlled format change acceptable if documented?
2. Should `pai-lite sessions report` be included in the Phase 1 TS surface for briefing compatibility, or is it intentionally deferred?
3. For transition safety, do we want the wrapper to prefer TS when available but automatically fall back to Bash for any TS runtime/command error, or only when the binary is absent?
4. What Bun version should be pinned in repo/CI for reproducibility (e.g., minimum supported and exact CI version)?

