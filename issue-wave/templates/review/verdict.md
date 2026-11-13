## Your answer

Your final message is the review itself, in GitHub-flavoured Markdown. It is posted on the PR as
you wrote it, so write it for the worker who will act on it, and write no `@` mention in it.

- The first line is `### Review checkpoint (@@KIND@@): head @@SHA8@@`.
- Then the findings, each with a short title, **blocking** or **suggestion**, its `file:line`, the
  evidence and the fix you propose.
- The last line stands alone and is exactly one of:

      VERDICT: clean
      VERDICT: suggestions (0 blocking, <m> suggestions)
      VERDICT: blocking (<n> blocking, <m> suggestions)

  with whole numbers for `<n>` and `<m>`. A review that ends on any other line is taken as
  blocking.
