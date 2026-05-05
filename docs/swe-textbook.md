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

- `ENTRY_HEADLINE` — the proposed headline text **without** the
  leading `### ` markdown prefix; the guard prepends `### ` itself
  when it scans the textbook. (E.g., for an entry that will render
  as `### My pattern name`, the caller passes `ENTRY_HEADLINE="My
  pattern name"`.)
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

### New OrchestrationConfig fields require parse+merge in adapter init

Description: A typed configuration object that drives runtime
behaviour usually has four independent surfaces a new field has to
land on: the interface declaration, the in-code default, any
backfill the persistent-state migrator applies to old records, and
the parse+merge step the initialisation path performs against the
user-facing YAML. The first three are easy to spot — they live next
to each other in the same file or test — and a typed compiler will
flag drift between them. The fourth is the most distant from the
field declaration and the least visible to the type checker: if the
init path never reads the YAML key, the documented config is
silently inert and the field always takes its default. Adding a
shared parser called from each init consumer is the cheapest way to
keep the fourth surface visible. The pattern: a single helper named
after the value it produces, called from each adapter's existing
config-load consumer, fed into the partial-config record that the
defaults function consumes — so the adapter knows to read the YAML,
the parser knows the shape, and the merge knows the precedence.
Test the parser as a unit; integration coverage at the call sites
catches regressions there.

Precipitating retro: `task-a670cdbf` round-2 review of PR #493
(settled-no-signal / hung-detection split). The reviewer's blocking
line: the new `mag.orchestration.substantive_stall.*` YAML keys
were documented and runtime-honoured, but neither adapter init
extracted them from the YAML — so the keys were silently inert
until the round-2 fix shipped a shared
`parseSubstantiveStallOverrides` parser called from both adapter
call sites.

Filter decision: Under the competent-SWE filter this is an
"obvious-to-experienced-engineer" doctrine reminder — wiring up the
read site is part of the same change as adding the field, by
definition. Captured here rather than promoted to always-loaded
agent prompts because the failure mode survives competent engineers
under deadline pressure when the four surfaces sit in different
files. The same precipitating retro is closed mechanically by the
adapter-call-site lint shipped in gh-ludics-496, which makes the
typed-default-plus-backfill checkbox no longer sufficient.

### "Adapter init reads YAML" is a separate AC for OrchestrationConfig field additions

Description: When an acceptance criteria list enumerates the surfaces
that have to change for a new typed config field — interface,
default, migration backfill — the adapter init path's read of the
user-facing YAML is easy to bundle into the umbrella line "config
field exists". That bundling lets a typed-interface-plus-default
checkbox count as completion even when the YAML is silently
ignored. The remedy is to give the init-side read its own AC,
phrased as a behavioural property at the user-visible boundary
("setting the YAML key to a non-default value produces the
non-default behaviour"), distinct from any structural AC about the
type or the default. The behavioural framing makes the AC
falsifiable by an end-to-end test that sets the YAML and observes
the runtime, not by an inspection of the type declaration.

Precipitating retro: `task-a670cdbf` round-2 review of PR #493. The
proposal's AC list bundled the YAML-read step into "config field
exists"; round-1 implementation satisfied the structural ACs without
satisfying the behavioural one, and the gap surfaced only at
round-2 review.

Filter decision: Under the competent-SWE filter this is also
"obvious-to-experienced-engineer" doctrine — separate ACs for
separate surfaces is general AC-writing hygiene. Captured here
rather than promoted to AC templates loaded by always-on agent
prompts because the doctrine is most useful as guidance to humans
writing proposals, not as a rule enforced at every coder turn. The
mechanical lint from the sibling entry above closes the same
failure mode for the specific case of `OrchestrationConfig` fields.
