## This is a confirm review, not a first review

An earlier review of this PR, at head `@@REVIEWED_SHA@@`, found blocking defects. It is in
`@@REVIEW_FILE@@`: read it first. Your job now is to decide whether the current head resolves each
blocking finding, by a fix or by a rebuttal that holds against the code. Read top-level PR comments
and review summaries for the worker's replies:

    gh pr view @@PR@@ --repo @@REPO@@ --json comments,reviews --jq '[.comments[], .reviews[]] | sort_by(.submittedAt // .createdAt)[] | ([.submittedAt // .createdAt, .state // "COMMENT", .author.login, .commit.oid] | map(select(. != null)) | join(" ")) + "\n\(.body)\n"'

Read the change since the reviewed head, `git -C @@CHECKOUT@@ diff @@REVIEWED_SHA@@ @@SHA@@`, not
the whole PR again. Report a new blocking finding only where that change introduced one. For each
earlier blocking finding say RESOLVED, REBUTTED (the rebuttal holds) or UNRESOLVED, with the
evidence. The verdict is `clean` when every one is resolved or soundly rebutted and nothing new
blocks.
