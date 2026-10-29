"""check-prompts: prompt hygiene, the small deterministic checks on the prompts themselves.

The Python form of ``scripts/check-prompts.sh`` (ludics-lite#403), which is now the one-line
forward to ``scripts/py -m ludics.checkprompts``. It is the one CI job that runs on every head
regardless of what changed (ludics-lite#55): a prompt-only PR would otherwise reach the merge gate
with no verdict at all, which ``pr-review.sh merge`` refuses as ABSENT.

    check-prompts.sh [root]        every check over the checkout (root defaults to this one)
    check-prompts.sh --one <dir>   one prompt directory, frontmatter only: no index and no
                                   directory-name equality, since installed scheduler IDs may
                                   differ from prompt names

Exit 0 when everything passes, 1 otherwise, 2 on a usage error. Each verdict is a line on stdout,
``ok: …`` or ``FAIL: <file>: …``, and under GitHub Actions each failure is also an ``::error``
annotation on the file it names.

The checks, each in its own module:
  frontmatter  every ``*/SKILL.md`` and ``routines/*/SKILL.md``: a flat YAML map, values in a
               string-only subset, ``name`` equal to the directory;
  registers    the README index of those directories, and the test-fixture register (README and
               CI workflows);
  slots        the mac-studio correctness-slot count, fleet-worker.sh against every statement;
  drift        each routine sync-routines.sh installs runs it (ludics-lite#199);
  cleanup      ship-pr/SKILL.md against post-merge-cleanup.sh's usage text (ludics-lite#276);
  links        relative Markdown links and their anchors (ludics-lite#260).
  verdicts     no shell or skill-text reader compares bg-run.sh wait's whole verdict line
               (ludics-lite#826).

Every reader works on the C-locale (byte) view of the files, as the shell's did under
``LC_ALL=C``; ``bytes_view`` says why that is part of the contract. Every scanner here reads LINE
SHAPES, and text crafted to carry a shape without the substance, or the substance in another shape,
is outside it (README, Tests; ludics-lite#75): each module states its grammar as that boundary.
"""
