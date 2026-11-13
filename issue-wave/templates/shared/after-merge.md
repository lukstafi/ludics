## After the merge

1. Close out each issue: `gh issue comment <N> --repo @@ISSUE_REPO@@ --body-file <scratch file>`
   with a summary (what landed, the merge SHA, the decisions, and what was deferred and where).
   The body's first line is the heading `## Landed (@@WAVE@@, @@T@@)`: the decision gate tells a
   wave's own comment from a maintainer decision by a wave or task in its heading, and this
   comment is posted from the maintainer's account. Then run `gh issue close <N> --repo @@ISSUE_REPO@@` only if the merge left it open.
   (`gh issue close --comment` on an issue that is already closed posts nothing.)
2. Run the after-merge skill (`~/.claude/skills/after-merge/SKILL.md`) in HAND-BACK MODE: propose
   follow-up issues (a title and a 2-4 line body each, ready to file, with evidence), task chips,
   and one-line checklist items for polish that changes no behaviour, in your report. File
   nothing and spawn nothing; the coordinator combines proposals across workers and files them.
3. Do NOT remove your worktree or its branch; the coordinator does that at close-out. Leave the
   worktree clean (no untracked data of yours).
4. Your final message is the hand-back. Its first line is `HANDBACK @@T@@`, alone. Then: the PR by
   its URL (`https://github.com/@@REPO@@/pull/<n>`) and the merge SHA; issues closed; the decisions you
   made (and where documented); the startup facts; each test batch with its exit status and run
   directory; the last batch's run directory and the SHA and dirty state it ran at; the review
   rounds and what was deferred; your after-merge proposals; and anything the coordinator must file
   or clean up.
