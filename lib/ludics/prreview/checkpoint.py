"""The review checkpoint's hold on ``merge`` (ludics#1242), and the posted form it reads.

A wave's review checkpoint (issue-wave's ``wave review``, fleetworker/wavereview.py) posts a second
reviewer's review on the PR when it opens (``at-open``) and, after a blocking one, again before the
merge (``confirm``). The worker is told to ask for the confirm; nothing held the merge until it did
(wave-20261118-ocannl's t2329 merged on a blocking at-open verdict). ``merge`` now reads the PR's
checkpoint posts before its first merge call and REFUSES (exit 1) when the newest at-open verdict
blocks and no confirm posted after it clears the head being merged. ``--over-checkpoint <reason>``
merges over a hold, posting the reason on the PR just before the merge call; nothing goes over it
silently, and nothing goes over a read that did not answer (exit 3, retried).

THE POSTED FORM, which wavereview.py writes and this module owns (``heading``, ``LABEL_SUFFIX``,
``parse_verdict``): a PR comment whose last non-blank line is the footer ``pr-review.sh comment
--coordinator '<label> review checkpoint'`` writes, ``(Posted by the wave coordinator, <label>
review checkpoint)``; whose first non-blank line is ``### Review checkpoint (<kind>): head
<sha8>``; and whose last non-blank line above the footer is the verdict line (THE VERDICT below).

THE BOUNDARY, a fail-closed allowlist. Read: the PR's issue comments (REST
``issues/<pr>/comments``, every page; a page that is not a list of comments, or a read that does
not answer, is UNREAD, exit 3, never "no checkpoint"), in the order GitHub lists them (creation).
A CHECKPOINT POST is a comment whose last non-blank line, stripped, starts with ``(Posted by the
wave coordinator, `` and ends with `` review checkpoint)``; every other comment is not read further,
the coordinator's other posts (footer without the suffix) included. Of a checkpoint post:
  - a heading that does not read whole (another kind, a head that is not 8 lowercase hex digits,
    text around it) makes the post an at-open BLOCKING one: what it was is unknown, and the doubt
    holds the merge (``--over-checkpoint`` or a later confirm releases it);
  - a verdict that does not read is blocking (THE VERDICT's own rule).
THE HOLD: none when the PR has no at-open post (a repository or wave without a reviewer merges as
before), or when the newest at-open post does not block. Otherwise the newest confirm post AFTER
that at-open post whose heading names the head being merged (its sha8 a prefix of the full head)
decides: not blocking clears it; blocking, or no such confirm, holds. A confirm for another head,
or one posted before the newest at-open, never counts.
Not read: who posted (a wave posts from the maintainer's account, so the author tells nothing, and
the form is trusted as the wave's: it is a guard against forgetting, not against forging), edits,
reactions, the wave's own review records (they live on the coordinator's box, which a merge from
another box cannot read), and the review's prose.

THE VERDICT, a fail-closed grammar. The review's last non-blank line, trailing blanks dropped, is
the verdict line when it is, whole, one of
    VERDICT: clean                                      (or with counts, 0 blocking)
    VERDICT: suggestions                                (or with counts, 0 blocking)
    VERDICT: blocking (<n> blocking, <m> suggestions)   (the counts required)
with decimal counts. Only the blocking count decides: more than zero blocks. Anything else is
``unreadable``, which blocks.
"""

import re
from dataclasses import dataclass
from typing import Any, cast

from ludics.prreview.comment import FOOTER_OPENING
from ludics.prreview.core import GhOk, GhSession, fail, json_stream

LABEL_SUFFIX = " review checkpoint"
KINDS = ("at-open", "confirm")
HEADING = re.compile(r"### Review checkpoint \((at-open|confirm)\): head ([0-9a-f]{8})")
VERDICT = re.compile(r"VERDICT: (clean|suggestions|blocking)(?: \((0|[1-9][0-9]*) blocking, (0|[1-9][0-9]*) suggestions\))?")


def heading(kind: str, sha: str) -> str:
    """A checkpoint post's first line, as the reviewer is told to write it and HEADING reads it."""
    return f"### Review checkpoint ({kind}): head {sha[:8]}"


@dataclass(frozen=True)
class Verdict:
    word: str  # clean, suggestions, blocking or unreadable
    blocking: int
    suggestions: int
    line: str  # the verdict line as written; "" when none was read

    @property
    def blocks(self) -> bool:
        return self.word == "unreadable" or self.blocking > 0


UNREADABLE = Verdict("unreadable", 0, 0, "")


def parse_verdict(review: str) -> Verdict:
    """THE VERDICT (the header)."""
    lines = [line.rstrip() for line in review.split("\n") if line.strip()]
    found = VERDICT.fullmatch(lines[-1]) if lines else None
    if found is None:
        return UNREADABLE
    word, counted = found.group(1), found.group(2) is not None
    blocking, suggestions = (int(found.group(2)), int(found.group(3))) if counted else (0, 0)
    if (word == "blocking" and not counted) or (word != "blocking" and blocking > 0):
        return UNREADABLE
    return Verdict(word, blocking, suggestions, lines[-1])


@dataclass(frozen=True)
class Post:
    """One checkpoint post: its URL, its kind and head as its heading reads ("" for both when it
    does not), and its verdict."""

    url: str
    kind: str
    head: str
    verdict: Verdict

    @property
    def at_open(self) -> bool:
        return self.kind != "confirm"  # an unread heading is taken as at-open (the boundary)

    @property
    def blocks(self) -> bool:
        return not self.kind or self.verdict.blocks  # an unread heading is taken as blocking too

    def said(self) -> str:
        what = f"{self.kind} at {self.head}" if self.kind else "with an unreadable heading, taken as a blocking at-open review"
        line = self.verdict.line or "no readable verdict line, taken as blocking"
        return f"{what} ({self.url}: {line})"


def is_footer(line: str) -> bool:
    line = line.strip()
    return line.startswith(f"{FOOTER_OPENING}, ") and line.endswith(f"{LABEL_SUFFIX})")


def post_of(url: str, body: str) -> Post | None:
    """The comment as a checkpoint post (the boundary), or None when it is none."""
    lines = [line for line in body.split("\n") if line.strip()]
    if not lines or not is_footer(lines[-1]):
        return None
    found = HEADING.fullmatch(lines[0].rstrip())
    kind, head = (found.group(1), found.group(2)) if found else ("", "")
    return Post(url, kind, head, parse_verdict("\n".join(lines[:-1])))


def read_posts(session: GhSession, repo: str, pr: str) -> list[Post]:
    """Every checkpoint post on the PR, oldest first; exit 3 when the comments do not read whole."""
    result = session.retry("read", ["api", "--paginate", f"repos/{repo}/issues/{pr}/comments?per_page=100"])
    unread = f"NOT merging {repo}#{pr}: its comments could not be read"
    if not isinstance(result, GhOk):
        fail(3, f"{unread} ({session.err_line()}), so whether its review checkpoint holds the merge is unknown"
             " — not 'no checkpoint'. Retry.")
    pages = json_stream(result.stdout)
    posts: list[Post] = []
    for page in pages or [None]:
        if not isinstance(page, list):
            fail(3, f"{unread}: a page of issues/{pr}/comments is not a list of comments. Retry.")
        for item in cast(list[Any], page):
            body: Any = cast(dict[str, Any], item).get("body") if isinstance(item, dict) else None
            url: Any = cast(dict[str, Any], item).get("html_url") if isinstance(item, dict) else None
            if not isinstance(body, str) or not isinstance(url, str):
                fail(3, f"{unread}: a comment on it carries no body or URL. Retry.")
            post = post_of(url, body)
            if post is not None:
                posts.append(post)
    return posts


def hold_of(posts: list[Post], head: str) -> str | None:
    """THE HOLD (the header): why the checkpoint holds a merge of ``head``, or None."""
    opened = [i for i, post in enumerate(posts) if post.at_open]
    if not opened or not posts[opened[-1]].blocks:
        return None
    at_open = posts[opened[-1]]
    confirms = [post for post in posts[opened[-1] + 1:] if post.kind == "confirm" and head.startswith(post.head)]
    if confirms and not confirms[-1].blocks:
        return None
    if confirms:
        after = f"the confirm for this head is not cleared: {confirms[-1].said()}"
    else:
        others = [post for post in posts[opened[-1] + 1:] if post.kind == "confirm"]
        after = (f"no confirm after it names this head (the newest names another head, {others[-1].head})"
                 if others else "no confirm has been posted after it")
    return f"the newest at-open review is blocking, {at_open.said()}, and {after}"
