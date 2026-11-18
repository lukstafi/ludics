# Design decisions taken without the maintainer in the loop

A ledger, not a design record: one row per design decision that a wave coordinator or a worker
took so that work could go on, for the maintainer to review afterwards. Waves run without design
holds, so a decision that would once have waited for an answer is taken, written up as a comment on
its issue, and listed here. The comment is the record; the row is a pointer to it.

- **A row is added** when its decision comment is posted and the issue gets the `design-joint`
  label. A wave's rows land together, in the one close-out commit its coordinator makes
  (`fleet-worker.sh wave decisions <wave.json>` prints them), so workers do not all edit this
  file; a session outside a wave adds its row in the PR that acts on the decision.
- **Newest first**: a new block of rows goes directly under the header row.
- **Who decided** is `maintainer`, `coordinator of <wave>`, or `worker` with the wave or session it
  worked in.
- **Status** is the maintainer's to change: `unreviewed` until read, then `ok`, or `revisit` when
  the call should be reopened, with the reason on the issue.

| Date | Issue | The call | Who decided | Decision | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | [lukstafi/ludics#1214](https://github.com/lukstafi/ludics/issues/1214) | routine vs intervention read from the message marker; native coordinator tallies every `SendMessage` | coordinator of wave-20261118-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1214#issuecomment-6979333526) | unreviewed |
| 2026-11-18 | [lukstafi/ludics#1206](https://github.com/lukstafi/ludics/issues/1206) | one live Windows witness on rog, coordinator-run after fakes pass | maintainer | [comment](https://github.com/lukstafi/ludics/issues/1206#issuecomment-6979058765) | ok |
| 2026-11-18 | [lukstafi/ludics#1214](https://github.com/lukstafi/ludics/issues/1214) | one intervention counter on the board row, written by the verbs | coordinator of wave-20261118-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1214#issuecomment-6979038594) | unreviewed |
| 2026-11-18 | [lukstafi/ludics#1204](https://github.com/lukstafi/ludics/issues/1204) | drop `lease_token` from every `execution list` form | coordinator of wave-20261118-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1204#issuecomment-6979037643) | unreviewed |
| 2026-11-17 | [lukstafi/ludics#1187](https://github.com/lukstafi/ludics/issues/1187) | The cc loop's reserved slot is a standing `slot_reservation` record, one per box; ordinary records count against `cap-1` and only the reserving tip-run is exempt; a window blocked by correctness records answers *pending* with a 1800 s mark; a per-wave `standby` with `failover_after` 1800 s. | coordinator of wave-20261117-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1187#issuecomment-6945035481) | unreviewed |
| 2026-11-17 | [lukstafi/ludics#1165](https://github.com/lukstafi/ludics/issues/1165) | `phase` is derived at read time from the closed state-word vocabulary, by the function `board check` reads; nothing stores it; `done` joins the vocabulary. | coordinator of wave-20261117-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1165#issuecomment-6944881159) | unreviewed |
| 2026-11-17 | [lukstafi/ludics#1165](https://github.com/lukstafi/ludics/issues/1165) | The board writes a normalized `phase` at `board set`; read-time derivation only for legacy rows, `unknown` otherwise (overturned by the row above). | coordinator of wave-20261117-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1165#issuecomment-6944637858) | unreviewed |
| 2026-11-15 | [lukstafi/ludics#1157](https://github.com/lukstafi/ludics/issues/1157) | A queue entry is native by its worker's transport (a non-`cli` profile, or no profile in a native-default wave), takes only `task`/`profile`/`after`, and its cue is a durable ledger line. | coordinator of wave-20261115-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1157#issuecomment-6897427588) | unreviewed |
| 2026-11-15 | [lukstafi/ludics#1157](https://github.com/lukstafi/ludics/issues/1157) | The queue may name a native task: the driver announces it once as a non-final attention line when due; the heartbeat prints one line when nothing changed. | coordinator of wave-20261115-ludics (Claude Opus 5.5) | [comment](https://github.com/lukstafi/ludics/issues/1157#issuecomment-6894943498) | unreviewed |
| 2026-11-14 | [lukstafi/ludics#1130](https://github.com/lukstafi/ludics/issues/1130) | `wave unprep` serves CLI tasks and refuses a native one; the driver un-prepares a stale prepared task itself and refreshes the served checkout before each prep. | coordinator of wave-20261113b-ludics (Claude Fable 5.2) | [comment](https://github.com/lukstafi/ludics/issues/1130#issuecomment-6868689105) | unreviewed |
| 2026-11-13 | [lukstafi/ludics#1111](https://github.com/lukstafi/ludics/issues/1111) | No guard and no count for a raw `gh run` call in a worker turn: `pr-review.sh` gets the job-level reads and the wait-then-rerun under the budget, and the brief text stays the guard. | coordinator of wave-20261113b-ludics (Claude Fable 5.2) | [comment](https://github.com/lukstafi/ludics/issues/1111#issuecomment-6865228995) | unreviewed |
| 2026-11-13 | [lukstafi/ludics#1123](https://github.com/lukstafi/ludics/issues/1123) | A no-PR board close takes its verdict from a run record: each `--run` concludes the one standing record with its box and checkout, an unused record is not-launched, `standing=none` needs no run. | coordinator of wave-20261113b-ludics (Claude Fable 5.2) | [comment](https://github.com/lukstafi/ludics/issues/1123#issuecomment-6865228369) | unreviewed |
