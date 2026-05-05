# SWE Textbook — Mag-side Write Memory for Filter-Rejected Learnings

## Audience and Directionality

This document is a **write-only journal** with these constraints:

1. The file is **not** consulted by coder agents.
2. The file is **not** consulted by reviewer agents.
3. The only active consumers are Mag and the
   `/ludics-feedback-digest` worker.
4. Entries are write-side memory for **competent-SWE filter
   decisions** — items the filter would otherwise discard from
   always-loaded prompts (see
   `harness/claude-memory/feedback_competent_swe_filter.md`).
5. The corpus is also a **future publication seed**; entries should
   read in plain English, free of Ludics-internal jargon.

## Entry Shape

Each entry is a `### <headline>` section with the following labelled
fields:

- `Description:` one paragraph, plain English, publication-friendly.
- `Precipitating retro:` one of `task-…`, `gh-…`, or a PR URL.
- `Filter decision:` why a `/ludics-process-suggestions` or
  `/ludics-feedback-digest` run would skip this item under the
  competent-SWE filter.
- `Second occurrence:` *(optional)* — appended only when the same
  pattern repeats; carries the new precipitating retro and a
  one-line note.

## Capture Idempotency

This is the **only** location where the duplicate-guard logic lives.
Both `/ludics-process-suggestions` and `/ludics-feedback-digest`
MUST run this check before appending a new entry; both skills
reference this section by anchor
(`docs/swe-textbook.md#capture-idempotency`) and describe its
inputs/outputs in prose. **Skills MUST NOT copy the snippet below
into their own bodies** — duplicating the implementation across
skill files would defeat the single-source-of-truth invariant this
section enforces.

Inputs from the calling skill:

- `ENTRY_HEADLINE` — the proposed `### <headline>` text.
- `PRECIPITATING_RETRO` — the proposed `Precipitating retro:` value.

Outputs:

- `append` — no near-duplicate found; the caller writes a fresh
  `### <headline>` block with the four required labelled fields.
- `skip-duplicate` — a near-duplicate exists by either headline OR
  precipitating-retro; the caller MUST NOT append a new entry. The
  caller MAY amend the matched entry's `Second occurrence:` line
  with the new precipitating retro and a one-line note.

```bash
textbook="docs/swe-textbook.md"
if grep -Fq "### ${ENTRY_HEADLINE}" "$textbook" \
   || grep -Fq "${PRECIPITATING_RETRO}" "$textbook"; then
  echo "skip-duplicate"
  exit 0
fi
echo "append"
```

---

### "Issue is updated" means an actual GH-side comment, not a one-way docs cite

Description: When a contract clause says an external issue tracker
entry is "updated" as part of acceptance, the update must be visible
on the tracker itself — a comment, an edited body, or a
closed/labelled state — not merely a one-way pointer from the
repository's own documentation. A docs file that links the issue is
not the same as the issue gaining a link to the docs file. A reader
checking the issue tracker for the update will see no change. Sister
contract clauses ("issue is closed," "issue is labelled") have the
same direction: the side named by the verb is the side that must
visibly change.

Precipitating retro: `gh-ocannl-270` (round-1 reviewer; retrospective
at `~/self-improve/harness/retrospectives/gh-ocannl-270.json`). The
reviewer's blocking line: *"AC6 is not satisfied because GitHub issue
#270 has not been updated to link to the committed memo. The proposal
requires 'GH issue #270 is updated to link to it'; the current issue
body still only links the Imbue article […]."*

Filter decision: Under the competent-SWE filter this would land in
the "obvious-to-experienced-engineer" bucket and be discarded from a
`/ludics-process-suggestions` run — yet the failure mode survives
competent engineers under deadline pressure (the contracted artifact
lives on the *other* side of the fence). Captured here rather than
skipped silently.
