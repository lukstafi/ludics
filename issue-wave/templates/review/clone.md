## This review runs in a clone

Your working directory is a disposable clone of the repository at the head, `@@CHECKOUT@@`, with
no remote: `origin/@@MAIN@@` and `@@SHA@@` are there for the `git -C @@CHECKOUT@@` reads above, and
the `gh` reads work as written. Nothing in this run refuses a command, so the limits above are
yours to keep: edit nothing, push nothing, post nothing on GitHub (your final message is posted
for you), and run no build or test suite (a run here takes none of the box's run-time slots, and
it proves nothing the review needs). Keep scratch files, if any, inside the clone; it is removed
when you finish.
