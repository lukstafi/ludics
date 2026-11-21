## This review runs without tools

In this run you have no tools: no shell, no file reader, no GitHub. Every tool call is refused,
and a refused call ends the review with no verdict, so make none. Where this prompt names a read,
that read has been made for you: its output is under *Materials* below, headed by what it is and
the command that made it. Reads of your own choosing are not available. The materials hold the
PR, its diff, the issue or the worker brief, the project's root rules at the base and each
changed file's text at the head. A finding that needs a read they lack says what it could not
check, rather than guessing.
