## The review checkpoint

A second reviewer, another model than yours, reads your PR for the coordinator. It is one
checkpoint, and a second only when the first is blocking.

1. **Right after you open the PR** (rebased, pushed, the PR body written), and before you start
   the review watch, end your turn. The LAST line of your final message is
   `REVIEW_REQUEST <PR number> <head sha>`, with the full 40-character SHA and nothing after it.
   You are resumed with a message whose first line is `REVIEW_POSTED <PR number> <head sha>`. It
   gives the review's verdict line and its URL, and says whether the verdict is blocking.
2. Answer the review's findings with the automated reviewer's round in your ship-pr loop: fix or
   rebut each one, and reply on the PR. A finding about elegance whose fix would grow the PR's
   scope goes to a follow-up proposal in your hand-back instead.
3. **Only when that message said the verdict is blocking:** before merging (the build green on
   the head, the ship-pr loop ended, every thread answered), end your turn with
   `CONFIRM_REQUEST <PR number> <head sha>` as the last line of your final message. You are
   resumed with one of:
   - `MERGE CLEARED <PR number> <head sha>`: merge that head. A push after it is a new head, so
     ask again before merging it.
   - `MERGE NOT CLEARED <PR number> <head sha>`: blocking findings remain. Fix or rebut each and
     reply on the PR, then ask again. When you rebutted and pushed nothing, ask at the same SHA.

After a verdict that is not blocking you merge when the ship-pr loop ends, without asking.
