"""Fail-closed absence for safety state (#1092).

Only ENOENT in searchable directories means absent. A dangling ancestor link is unread,
just like a dangling marker itself; missing real ancestors are a genuinely unused state tree.
Callers translate OSError to their own immediate refusal, never a retry loop.
"""

import errno
import os
import stat


def absent(path: str | os.PathLike[str]) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        parent = os.path.dirname(os.path.abspath(path))
        if absent(parent):
            return True
        if not stat.S_ISDIR(os.stat(parent).st_mode):
            raise NotADirectoryError(errno.ENOTDIR, "not a directory", parent)
        if not os.access(parent, os.X_OK):
            raise PermissionError(errno.EACCES, "directory is not searchable", parent)
        return True
    return False
