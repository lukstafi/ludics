"""Safely remove a merged topic worktree and branch after ship-pr has confirmed the PR is merged.

The Python half of ``ship-pr/scripts/post-merge-cleanup.sh`` (ludics-lite#403), which forwards its
whole command line here. Every gate, ordering and message is the shell helper's: the long history
of review rounds behind each one lives in that file's ``git log`` and in the comments carried over
below, and test-post-merge-cleanup.sh is the conformance suite.

The order, in one breath: validate the arguments and both checkouts; remove the named
``--regenerable`` directories; refuse a session holding anything cleanup would lose; reserve the
recovery namespace and both sibling archives; fetch the base and prove the topic integrated;
fast-forward the local base under a continuous owner; retain every tip the topic and its tracking
ref reach; observe the remote topic; prune the tracking ref; hand the topic to a temporary
reservation; archive the session by an atomic rename and retain all of its Git metadata; delete
the local topic; and only then, last, delete the remote topic, leased on the tip observed.
"""

import os
import shutil
import subprocess
import tempfile
from typing import NoReturn, assert_never

from ludics import cli
from ludics.postmergecleanup import system
from ludics.postmergecleanup.options import PROG, Parsed, UsageError, parse_options, usage_text
from ludics.postmergecleanup.shellquote import bash_q as q
from ludics.postmergecleanup.system import git, substitution
from ludics.postmergecleanup.transaction import RefTransaction


CALLER_TMPDIR = "LUDICS_CALLER_TMPDIR"
# The state a Git operation under way keeps in a worktree's git directory: pending commits, and with
# `--autostash` uncommitted edits, a clean tree and a plain stash list do not show (fleetworker's
# farside-close reads this list too). ``REBASE_HEAD`` is not on it (#982): Git can leave the file
# behind a finished rebase (six of one wave's worktrees had it), and a rebase in progress is its
# ``rebase-merge`` or ``rebase-apply`` directory, which every backend holds from its start to its end.
ACTIVE_OPERATIONS = (
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_START",
    "BISECT_LOG",
    "BISECT_NAMES",
    "BISECT_TERMS",
    "BISECT_RUN",
    "BISECT_ANCESTORS_OK",
    "BISECT_EXPECTED_REV",
    "sequencer",
    "rebase-merge",
    "rebase-apply",
)


def fail(message: str) -> NoReturn:
    raise cli.Exit(1, message)


def usage() -> NoReturn:
    raise cli.Exit(2, usage_text(), raw=True)


def note(message: str) -> None:
    cli.note(PROG, message)


_SHOWN: dict[str, str] = {}


def show(path: str) -> str:
    """A path the shell helper held in its own (``pwd -P``) spelling, as it printed it. Under Git
    Bash that spelling was MSYS's (``/c/...``, ``/tmp/...``) while this interpreter is native and
    holds ``C:/...``; ``cygpath -u`` maps it back through the same mount table. Elsewhere it is the
    path itself."""
    if os.name != "nt" or not os.environ.get("MSYSTEM"):
        return path
    if path not in _SHOWN:
        converted = path
        cygpath = shutil.which("cygpath")
        if cygpath is not None:
            done = subprocess.run(
                [cygpath, "-u", "--", path], capture_output=True, check=False
            )
            if done.returncode == 0:
                converted = substitution(system.decode(done.stdout)) or path
        _SHOWN[path] = converted
    return _SHOWN[path]


def canonical_dir(path: str) -> str:
    if not system.is_dir(path):
        fail(f"directory does not exist: {path}")
    resolved = system.physical_directory(path)
    if resolved is None:
        fail(f"cannot resolve directory: {path}")
    return resolved


def git_path(checkout: str, value: str) -> str:
    if system.git_path_is_absolute(value):
        return canonical_dir(value)
    return canonical_dir(f"{checkout}/{value}")


def joined(checkout: str, path: str) -> str:
    """``git_path_is_absolute "$path" || path="$checkout/$path"``."""
    return path if system.git_path_is_absolute(path) else f"{checkout}/{path}"


def captured(*args: str, quiet: bool = False) -> tuple[int, str]:
    """``value=$(git args)``: the status and the output without its trailing newlines."""
    done = git(*args, out="capture", err="devnull" if quiet else "inherit")
    return done.rc, substitution(done.out)


def quiet(*args: str) -> int:
    """``git args >/dev/null 2>&1``."""
    return git(*args, out="devnull", err="devnull").rc


def path_has_no_link_component(root: str, rest: str) -> bool:
    """True when every component of ``rest``, the leaf included, exists under ``root`` as
    something Git could have listed there -- no component is a symbolic link, and none is ``.`` or
    ``..``. Neither session-gate exemption may follow a link: ``cmp`` through a symlinked ANCESTOR
    in the base checkout would clear a session file against a file the base checkout does not
    hold."""
    walked = root
    while rest:
        component, _, remainder = rest.partition("/")
        rest = remainder
        if not component:
            continue
        if component in (".", ".."):
            return False
        walked = f"{walked}/{component}"
        if system.is_link(walked) or not system.lexists(walked):
            return False
    return True


class Cleanup:
    """The helper's state. The first block is what the shell's EXIT trap released
    (``release``); the rest is what the run computes as it goes."""

    def __init__(self) -> None:
        self.master_reservation = ""
        self.master_head_lock = ""
        self.master_head_lock_owned = False
        self.master_owner_index_path = ""
        self.master_owner_index_lock = ""
        self.master_owner_index_lock_owned = False
        self.master_refresh_git_dir = ""
        self.session_head_lock = ""
        self.session_head_lock_owned = False
        self.capability_ref = ""
        self.capability_ref_owned = False
        self.session_namespace_reservation = ""
        self.session_namespace_reservation_owned = False
        self.session_pseudoref_locks: list[str] = []
        self.session_worktree_lock_owned = False
        self.topic_reservation = ""
        self.transaction: RefTransaction | None = None
        self.private_namespace_blockers: list[str] = []
        self.config_lock = ""
        self.config_lock_owned = False
        self.master_index_probe = ""
        self.session_archive = ""
        self.late_session_archive = ""

        self.main = ""
        self.session = ""
        self.session_original = ""
        self.temp_root = ""
        self.branch = ""
        self.base = "master"
        self.force_reason = ""
        self.regenerable: tuple[str, ...] = ()
        self.base_local_ref = ""
        self.base_remote_ref = ""
        self.main_common = ""
        self.local_branch_oid = ""
        self.session_ref = ""
        self.session_head = ""
        self.session_head_path = ""
        self.session_archived_worktree = ""
        self.local_master = ""
        self.remote_master = ""
        self.origin_push_url = ""
        self.master_owner = ""
        self.original_master_owner = ""
        self.current_topic_oid = ""
        self.recovery_ref = ""
        self.session_recovery_ref = ""
        self.tracking_branch_present = False
        self.tracking_branch_oid = ""
        # scan_branch_owner's answers
        self.branch_owner = ""
        self.branch_owner_count = 0
        self.session_locked = False

    # --- the EXIT trap ------------------------------------------------------------------------

    def release(self) -> None:
        """Release every reservation still held, in the shell trap's order, quietly."""
        # An open transaction is aborted by closing its input, never by killing: Git releases its
        # locks on EOF.
        if self.transaction is not None:
            self.transaction.discard()
            self.transaction = None
        for lock in self.private_namespace_blockers:
            if system.is_file(lock):
                system.unlink(lock)
        if self.config_lock_owned and self.config_lock and system.is_file(self.config_lock):
            system.unlink(self.config_lock)
        if self.master_index_probe:
            system.unlink(f"{self.master_index_probe}.lock")
            system.unlink(self.master_index_probe)
        for lock in self.session_pseudoref_locks:
            if system.is_file(lock):
                system.unlink(lock)
        if (
            self.session_head_lock_owned
            and self.session_head_lock
            and system.is_file(self.session_head_lock)
        ):
            system.unlink(self.session_head_lock)
        if self.capability_ref_owned and self.capability_ref:
            quiet("-C", self.main, "symbolic-ref", "--delete", self.capability_ref)
        if self.session_namespace_reservation_owned and self.session_namespace_reservation:
            quiet(
                "-C",
                self.main,
                "update-ref",
                "--no-deref",
                "-d",
                self.session_namespace_reservation,
                self.local_branch_oid,
            )
        if self.topic_reservation and system.is_dir(self.topic_reservation):
            quiet("-C", self.main, "worktree", "remove", "--force", self.topic_reservation)
        if self.session_worktree_lock_owned and self.session:
            quiet("-C", self.main, "worktree", "unlock", self.session)
        if (
            self.master_owner_index_lock_owned
            and self.master_owner_index_lock
            and system.is_file(self.master_owner_index_lock)
        ):
            system.unlink(self.master_owner_index_lock)
        if (
            self.master_head_lock_owned
            and self.master_head_lock
            and system.is_file(self.master_head_lock)
        ):
            system.unlink(self.master_head_lock)
        if self.master_refresh_git_dir:
            refresh = self.master_refresh_git_dir
            system.unlink(f"{refresh}/HEAD.lock")
            system.unlink(f"{refresh}/logs/HEAD")
            system.rmdir(f"{refresh}/logs")
            system.unlink(f"{refresh}/config.worktree")
            system.unlink(f"{refresh}/info/sparse-checkout")
            system.rmdir(f"{refresh}/info")
            system.unlink(f"{refresh}/HEAD")
            system.rmdir(refresh)
        if self.master_reservation and system.is_dir(self.master_reservation):
            quiet("-C", self.main, "worktree", "remove", "--force", self.master_reservation)
        if self.session_archive:
            system.rmdir(self.session_archive)
        if self.late_session_archive:
            system.rmdir(self.late_session_archive)

    # --- small shared shapes -------------------------------------------------------------------

    def locate(self, checkout: str, name: str, failure: str) -> tuple[str, str]:
        """``path=$(git -C checkout rev-parse --git-path name) || fail``, joined to the checkout,
        its directory made physical: (directory, path)."""
        rc, path = captured("-C", checkout, "rev-parse", "--git-path", name)
        if rc != 0:
            fail(failure)
        path = joined(checkout, path)
        directory = canonical_dir(system.posix_dirname(path))
        return directory, f"{directory}/{system.posix_basename(path)}"

    def locate_raw(self, checkout: str, name: str, failure: str) -> str:
        """The same path, joined but not resolved: for a directory that may legitimately be
        absent."""
        rc, path = captured("-C", checkout, "rev-parse", "--git-path", name)
        if rc != 0:
            fail(failure)
        return joined(checkout, path)

    def lock_file(self, path: str) -> bool:
        """``(set -o noclobber; printf '%s\\n' "$$" >path)``."""
        return system.noclobber_create(path, f"{os.getpid()}\n")

    # --- the session gates ---------------------------------------------------------------------
    # The session gate reads ignored data as well as tracked and untracked changes, because
    # cleanup archives the session by renaming it into a sibling: ignored data is not destroyed,
    # it is moved somewhere the operator may never look. Two narrow classes carry no such loss
    # (ludics-lite#194, #205 §1): harness-owned state under a top-level `.claude/` DIRECTORY, and
    # an ignored regular file byte-identical to the base checkout's copy (or an ignored directory
    # every file beneath which is one). No symlink is ever followed or compared.

    def ignored_file_is_a_base_copy(self, path: str) -> bool:
        if not path_has_no_link_component(self.session, path):
            return False
        if not path_has_no_link_component(self.main, path):
            return False
        ours, theirs = f"{self.session}/{path}", f"{self.main}/{path}"
        if not (system.is_file(ours) and system.is_file(theirs)):
            return False
        return system.same_contents(ours, theirs)

    def ignored_directory_holds_only_base_copies(self, directory: str) -> bool:
        """Git prints one entry per matching IGNORE PATTERN (an excluded ``cache/`` is ``!!
        cache/`` with nothing inside shown), so a directory entry is cleared exactly when every
        file beneath it is a base copy. A walk that did not see everything clears nothing, and
        the first path that is not a base copy refuses the whole entry."""
        if not path_has_no_link_component(self.session, directory):
            return False
        root = f"{self.session}/{directory}"
        if not system.is_dir(root):
            return False
        entries = system.walk_non_directories(root)
        if entries is None:
            return False
        for absolute in entries:
            relative = f"{directory}/{absolute[len(root) + 1 :]}"
            if not self.ignored_file_is_a_base_copy(relative):
                return False
        return True

    def ignored_path_is_archivable_without_loss(self, entry: str) -> bool:
        path = entry.removesuffix("/")
        if path == ".claude" or path.startswith(".claude/"):
            harness = f"{self.session}/.claude"
            return not system.is_link(harness) and system.is_dir(harness)
        target = f"{self.session}/{path}"
        if not system.is_link(target) and system.is_dir(target):
            return self.ignored_directory_holds_only_base_copies(path)
        return self.ignored_file_is_a_base_copy(path)

    def refuse_session_local_data(self) -> None:
        """Refuse the session over any change, and over ignored data the two rules above do not
        clear, naming the ignored paths -- shell-quoted, since a pathname is attacker-shaped data.
        No stash is suggested: worktrees share one stash stack with the primary checkout. The
        status is read NUL-delimited, so a name Git would C-quote is judged as itself."""
        done = git(
            "-C",
            self.session,
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=normal",
            "--ignored=matching",
            out="capture",
        )
        if done.rc != 0:
            fail("could not inspect session worktree cleanliness")
        changed = False
        ignored: list[str] = []
        for entry in system.nul_records(done.out):
            if not entry:
                continue
            if entry.startswith("!! "):
                path = entry[3:]
                if self.ignored_path_is_archivable_without_loss(path):
                    continue
                ignored.append(q(path))
            else:
                # A tracked change, an untracked file, or a rename's second NUL field.
                changed = True
        if changed:
            fail("session worktree is dirty; commit or remove its changes before cleanup")
        if ignored:
            fail(
                "session worktree holds ignored data that cleanup would archive out of sight; "
                f"move or remove it before cleanup: {', '.join(ignored)}"
            )

    # The BASE-OWNER gate is the mirror image: nothing there is archived, and the fast-forward
    # writes only the paths it changes. So neither ignored NOR untracked data is part of this
    # read (ludics#859, narrowing ludics-lite#215's by-name `.claude/` allow-list to nothing):
    # both are at risk only on a changed path or an ancestor of one, which the collision scan in
    # fast_forward_base refuses before any ref moves, and the locked refresh's plain
    # `checkout --detach --no-overwrite-ignore` refuses to overwrite either class besides. #215
    # kept untracked data in the gate "because the fast-forward writes into this tree", a
    # whole-tree reading the changed-path scan makes exact. The one Git step that DOES overwrite
    # untracked files, `read-tree --reset -u`, runs only in the helper's own fresh reservation.

    def scan_base_owner_local_data(self, worktree: str, index_file: str = "") -> str | None:
        """The owner's tracked changes, shell-quoted and comma-joined (empty when there are none);
        None when the status could not be read. Untracked files are not read (the rule above). A
        rename's second ``-z`` field carries no status prefix and is skipped."""
        done = git(
            "-C",
            worktree,
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=no",
            out="capture",
            env={"GIT_INDEX_FILE": index_file} if index_file else None,
        )
        if done.rc != 0:
            return None
        data: list[str] = []
        original = False
        for entry in system.nul_records(done.out):
            if original:
                original = False
                continue
            if not entry:
                continue
            code, path = entry[0:2], entry[3:]
            if len(code) == 2 and (code[0] in "RC" or code[1] in "RC"):
                original = True
            data.append(q(path))
        return ", ".join(data)

    # --- --regenerable (ludics-lite#205 §2) ----------------------------------------------------
    # A build tree slips between both session-gate exemptions by construction, and archiving it
    # would be worse than refusing. So the operator may name ONE top-level directory of the
    # session worktree that cleanup REMOVES. A value with a separator (`/`, or `\` under Git Bash)
    # is refused rather than resolved; `.` and `..` by name; a value the filesystem FOLDS onto a
    # different entry is refused, since Git's pathspecs are byte-exact; a symbolic link is never
    # followed; a tracked path is repository content. An absent name is a no-op. This runs before
    # either gate reads the worktree, so a later refusal still leaves the directories removed.

    def regenerable_entry_is_spelled_exactly(self, name: str) -> bool:
        entries = system.list_entries(self.session)
        if entries is None:
            fail("could not list the session worktree root while resolving --regenerable")
        return name in entries

    def regenerable_path_is_untracked(self, name: str) -> bool:
        # Any byte at all means the pathspec matched: a tracked name beginning with a newline
        # renders as an empty first LINE, which once read as "untracked".
        done = git("-C", self.session, "ls-files", "-z", "--", f":(literal){name}", out="capture")
        if done.rc != 0:
            fail(f"could not inspect whether the --regenerable path is tracked: {q(name)}")
        return done.out == ""

    def remove_regenerable_directories(self) -> None:
        for name in self.regenerable:
            if "/" in name or "\\" in name:
                fail(f"--regenerable names one top-level directory, not a path: {q(name)}")
            if name in (".", ".."):
                fail(f"--regenerable cannot name a directory entry of the worktree root: {q(name)}")
            target = f"{self.session}/{name}"
            if not system.lexists(target):
                continue
            if not self.regenerable_entry_is_spelled_exactly(name):
                fail(
                    "--regenerable names no entry spelled exactly that way in the session "
                    "worktree root, so the filesystem resolved it to a different one: "
                    f"{q(name)}"
                )
            if system.is_link(target):
                fail(
                    "--regenerable path is a symbolic link, which is never followed; remove it "
                    f"yourself before cleanup: {q(name)}"
                )
            if not system.is_dir(target):
                fail(f"--regenerable path is not a directory: {q(name)}")
            if not self.regenerable_path_is_untracked(name):
                fail(
                    "--regenerable path is tracked by the repository and is not regenerable: "
                    f"{q(name)}"
                )
            if not system.remove_tree(target):
                fail(f"could not remove the --regenerable directory: {q(name)}")
            if system.lexists(target):
                fail(f"the --regenerable directory remained after its removal: {q(name)}")

    # --- refusals shared by the session and the base owner -------------------------------------

    def refuse_initialized_submodules(self, worktree: str, description: str, shown: str) -> None:
        done = git("-C", worktree, "submodule", "status", "--recursive", out="capture")
        if done.rc != 0:
            fail(f"could not inspect {description} submodules: {shown}")
        # `git submodule status` has no NUL-delimited mode, so a name holding a newline arrives
        # split across lines; the refusal still fires, because only an entry's first line begins
        # with the status character. The name is `.gitmodules` content, so it is shell-quoted.
        for line in substitution(done.out).split("\n"):
            if line == "" or line.startswith("-"):
                continue
            fail(
                f"{description} has an initialized submodule; deinitialize it before cleanup: "
                f"{q(line[1:])}"
            )

    def refuse_session_module_gitdirs(self, worktree: str, shown: str) -> None:
        rc, git_dir = captured("-C", worktree, "rev-parse", "--absolute-git-dir")
        if rc != 0:
            fail(f"could not locate session worktree metadata: {shown}")
        modules = f"{git_dir}/modules"
        if not system.lexists(modules):
            return
        if system.is_link(modules):
            fail(f"session submodule repository root is symbolic: {modules}")
        if not system.is_dir(modules):
            fail(f"session submodule repository root is not a directory: {modules}")
        entries = system.list_entries(modules)
        if entries is None:
            fail(f"could not inspect residual session submodule repositories: {modules}")
        if entries:
            # The directory name derives from the submodule name in `.gitmodules`: shell-quoted.
            first = substitution(f"{modules}/{system.msys_name(entries[0])}")
            fail(
                "session has a residual submodule repository; retain or remove it before "
                f"cleanup: {q(first)}"
            )

    def refuse_private_worktree_refs(self, worktree: str, shown: str) -> None:
        done = git(
            "-C",
            worktree,
            "for-each-ref",
            "--format=%(refname)",
            "refs/worktree",
            "refs/bisect",
            "refs/rewritten",
            out="capture",
        )
        if done.rc != 0:
            fail(f"could not inspect session-local refs: {shown}")
        private_ref = done.out.split("\n", 1)[0]
        if private_ref:
            fail(f"session worktree has a private ref; remove or retain it before cleanup: {private_ref}")

    def refuse_active_session_operations(self, worktree: str = "", description: str = "session") -> None:
        """Refuse what names a Git operation in progress (``ACTIVE_OPERATIONS``). A ``REBASE_HEAD``
        alone is a finished rebase: the metadata gates still judge it (a symbolic one, a held lock)
        and the archive retains the commit it names, as for ``ORIG_HEAD``."""
        checkout = worktree or self.session
        for name in ACTIVE_OPERATIONS:
            _, path = self.locate(checkout, name, f"could not locate session operation state: {name}")
            if system.lexists(path):
                fail(
                    f"{description} has an active or retained Git operation; finish or abort it "
                    f"before cleanup: {name}"
                )

    def refuse_index_resolve_undo(self, worktree: str, description: str, shown: str) -> None:
        done = git("-C", worktree, "ls-files", "--resolve-undo", out="capture")
        if done.rc != 0:
            fail(f"could not inspect {description} resolve-undo state: {shown}")
        if done.out.split("\n", 1)[0]:
            fail(f"{description} index has resolve-undo data; resolve or remove it before cleanup: {shown}")

    def refuse_hidden_index_changes(self, worktree: str, description: str, shown: str) -> None:
        """A tracked change hidden behind index flags (assume-unchanged, skip-worktree) is still a
        change. The probe is a COPY of the index with every hiding flag that can be cleared
        cleared, refreshed and compared; the real index is never written."""
        rc, index_path = captured("-C", worktree, "rev-parse", "--git-path", "index")
        if rc != 0:
            fail(f"could not locate {description} index: {shown}")
        index_path = joined(worktree, index_path)
        index_dir = canonical_dir(system.posix_dirname(index_path))
        index_path = f"{index_dir}/{system.posix_basename(index_path)}"
        if system.is_link(index_path):
            fail(f"{description} index is symbolic: {shown}")
        if not system.is_file(index_path):
            fail(f"{description} index is missing: {shown}")
        if system.lexists(f"{index_path}.lock"):
            fail(f"{description} index is locked; retry after its Git operation finishes: {shown}")
        probe = system.mktemp_file(f"{index_dir}/.ship-pr-index-probe.XXXXXX")
        if probe is None:
            fail(f"could not allocate the {description} index probe")
        self.master_index_probe = probe
        if not system.copy_preserving(index_path, probe):
            fail(f"could not snapshot the {description} index")
        probe_env = {"GIT_INDEX_FILE": probe}
        flags = git("-C", worktree, "ls-files", "-t", "-z", out="capture", env=probe_env)
        if flags.rc != 0:
            fail(f"could not enumerate {description} index flags")
        # Clear the copied flag for every MATERIALIZED skip-worktree path, so an edit hidden behind
        # it is detected. An ABSENT one is a sparse checkout's intentional absence or a deletion
        # hidden behind `update-index --skip-worktree`; the active sparse rules tell them apart,
        # and when they cannot be read every absent flag is cleared -- the conservative refusal.
        absent: list[str] = []
        for entry in system.nul_records(flags.out):
            if not entry.startswith("S "):
                continue
            path = entry[2:]
            if system.lexists(f"{worktree}/{path}"):
                cleared = git(
                    "-C", worktree, "update-index", "--no-skip-worktree", "--", path, env=probe_env
                )
                if cleared.rc != 0:
                    fail("could not clear a copied skip-worktree flag")
            else:
                absent.append(path)
        if absent:
            rc, sparse_enabled = captured(
                "-C", worktree, "config", "--get", "--type=bool", "core.sparseCheckout", quiet=True
            )
            if rc != 0:
                sparse_enabled = "false"
            suspects = absent
            if sparse_enabled == "true":
                rules = git(
                    "-C",
                    worktree,
                    "sparse-checkout",
                    "check-rules",
                    "-z",
                    out="capture",
                    err="devnull",
                    stdin=system.encode("".join(f"{p}\0" for p in absent)),
                )
                if rules.rc == 0:
                    suspects = system.nul_records(rules.out)
            for path in suspects:
                cleared = git(
                    "-C", worktree, "update-index", "--no-skip-worktree", "--", path, env=probe_env
                )
                if cleared.rc != 0:
                    fail("could not clear a copied skip-worktree flag")
        if git("-C", worktree, "update-index", "-q", "--really-refresh", env=probe_env).rc != 0:
            fail(f"could not refresh the {description} index snapshot")
        if (
            git(
                "-C", worktree, "diff-files", "--quiet", "--ignore-submodules=none", "--", env=probe_env
            ).rc
            != 0
        ):
            fail(f"{description} has a tracked change hidden by index flags; clean it before cleanup: {shown}")
        if not system.unlink(probe):
            fail(f"could not remove the {description} index probe")
        self.master_index_probe = ""

    # --- session metadata preflight ------------------------------------------------------------

    def preflight_session_metadata_locks(self) -> None:
        for name in (
            "ORIG_HEAD",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "REBASE_HEAD",
            "BISECT_HEAD",
            "AUTO_MERGE",
            "FETCH_HEAD",
            "COMMIT_EDITMSG",
            "SQUASH_MSG",
            "TAG_EDITMSG",
            "NOTES_EDITMSG",
            "index",
            "config.worktree",
        ):
            path_dir, path = self.locate(self.session, name, f"could not locate session metadata: {name}")
            if system.is_link(path):
                fail(f"session metadata is symbolic; replace it before cleanup: {name}")
            if name not in (
                "COMMIT_EDITMSG",
                "SQUASH_MSG",
                "TAG_EDITMSG",
                "NOTES_EDITMSG",
                "index",
                "config.worktree",
            ):
                symbolic = quiet("-C", self.session, "symbolic-ref", "-q", name)
                if symbolic == 0:
                    fail(f"session pseudoref is symbolic; replace it before cleanup: {name}")
                if symbolic != 1:
                    fail(f"could not inspect whether the session pseudoref is symbolic: {name}")
            if system.lexists(f"{path_dir}/{system.posix_basename(path)}.lock"):
                fail(f"session metadata is locked; retry after its Git operation finishes: {name}")

    def preflight_sparse_checkout_metadata(self) -> None:
        path = self.locate_raw(
            self.session, "info/sparse-checkout", "could not locate session sparse-checkout metadata"
        )
        path_dir = system.posix_dirname(path)
        if not system.is_dir(path_dir):
            if system.lexists(path):
                fail("session sparse-checkout metadata has an invalid parent")
            return
        path_dir = canonical_dir(path_dir)
        path = f"{path_dir}/{system.posix_basename(path)}"
        if system.is_link(path):
            fail("session sparse-checkout metadata is symbolic")
        if system.lexists(f"{path}.lock"):
            fail("session sparse-checkout metadata is locked; retry after its Git operation finishes")

    # --- the base owner's locked handoff -------------------------------------------------------

    def reserve_master_owner_handoff(self) -> bool:
        owner = self.original_master_owner
        rc, head_path = captured("-C", owner, "rev-parse", "--git-path", "HEAD")
        if rc != 0:
            fail(f"could not locate the {self.base} owner's HEAD")
        head_path = joined(owner, head_path)
        head_dir = canonical_dir(system.posix_dirname(head_path))
        head_path = f"{head_dir}/{system.posix_basename(head_path)}"
        if system.is_link(head_path):
            fail(f"{self.base} owner's HEAD is symbolic on disk")
        self.master_head_lock = f"{head_path}.lock"
        if not self.lock_file(self.master_head_lock):
            return False
        self.master_head_lock_owned = True
        raw = system.first_line(head_path)
        if raw is None or raw != f"ref: {self.base_local_ref}":
            return False
        rc, index_path = captured("-C", owner, "rev-parse", "--git-path", "index")
        if rc != 0:
            return False
        index_path = joined(owner, index_path)
        index_dir = canonical_dir(system.posix_dirname(index_path))
        self.master_owner_index_path = f"{index_dir}/{system.posix_basename(index_path)}"
        if system.is_link(self.master_owner_index_path):
            return False
        if not system.is_file(self.master_owner_index_path):
            return False
        self.master_owner_index_lock = f"{self.master_owner_index_path}.lock"
        if not system.noclobber_create(self.master_owner_index_lock, ""):
            return False
        self.master_owner_index_lock_owned = True
        if not system.copy_preserving(self.master_owner_index_path, self.master_owner_index_lock):
            return False
        if not system.unlink(self.master_head_lock):
            return False
        self.master_head_lock_owned = False
        return True

    def prepare_master_owner_refresh(self) -> bool:
        """A synthetic GIT_DIR for the locked refresh, carrying the owner's per-worktree
        configuration and sparse-checkout patterns: without them a sparse owner's checkout would
        materialize (and un-flag) a sparse-absent path the fast-forward changes. A symbolic source
        refuses the whole preparation rather than following the link."""
        refresh = system.mktemp_dir(f"{self.temp_root}/ship-pr-master-refresh.XXXXXX")
        self.master_refresh_git_dir = refresh or ""
        if refresh is None:
            return False
        if not system.write_file(f"{refresh}/HEAD", f"{self.local_master}\n"):
            return False
        rc, owner_git_dir = captured("-C", self.original_master_owner, "rev-parse", "--absolute-git-dir")
        if rc != 0:
            return False
        source = f"{owner_git_dir}/config.worktree"
        if system.is_link(source):
            return False
        if system.is_file(source) and not system.copy_new(source, f"{refresh}/config.worktree"):
            return False
        source = f"{owner_git_dir}/info/sparse-checkout"
        if system.is_link(source):
            return False
        if system.is_file(source):
            if not system.mkdir(f"{refresh}/info"):
                return False
            if not system.copy_new(source, f"{refresh}/info/sparse-checkout"):
                return False
        return True

    def refresh_master_owner_to(self, target: str) -> bool:
        owner = self.original_master_owner
        return (
            git(
                "-C",
                owner,
                "checkout",
                "--detach",
                "--no-overwrite-ignore",
                target,
                out="devnull",
                env={
                    "GIT_DIR": self.master_refresh_git_dir,
                    "GIT_COMMON_DIR": self.main_common,
                    "GIT_WORK_TREE": owner,
                    "GIT_INDEX_FILE": self.master_owner_index_lock,
                },
            ).rc
            == 0
        )

    def discard_master_refresh_admin(self) -> None:
        refresh = self.master_refresh_git_dir
        if system.is_file(f"{refresh}/logs/HEAD"):
            system.unlink(f"{refresh}/logs/HEAD")
        if system.is_dir(f"{refresh}/logs"):
            system.rmdir(f"{refresh}/logs")
        for leaf in ("config.worktree", "info/sparse-checkout"):
            if system.is_file(f"{refresh}/{leaf}"):
                system.unlink(f"{refresh}/{leaf}")
        if system.is_dir(f"{refresh}/info"):
            system.rmdir(f"{refresh}/info")
        if system.is_file(f"{refresh}/HEAD"):
            system.unlink(f"{refresh}/HEAD")
        if system.rmdir(refresh):
            self.master_refresh_git_dir = ""
        else:
            note(f"retained temporary {self.base} refresh metadata at {show(refresh)}")

    def install_master_owner_refresh(self) -> None:
        if system.atomic_rename(self.master_owner_index_lock, self.master_owner_index_path) is not None:
            fail(f"could not install the refreshed {self.base}-owner index")
        self.master_owner_index_lock_owned = False
        if not system.unlink(self.master_head_lock):
            fail(f"could not release the {self.base}-owner HEAD lock")
        self.master_head_lock_owned = False
        self.discard_master_refresh_admin()

    def relock_master_owner_head(self) -> bool:
        if not self.lock_file(self.master_head_lock):
            return False
        self.master_head_lock_owned = True
        raw = system.first_line(self.master_head_lock.removesuffix(".lock"))
        return raw is not None and raw == f"ref: {self.base_local_ref}"

    def lock_session_head_for_archive(self) -> bool:
        """Compare-and-swap the session's HEAD file under a lock held through the archive and the
        unregistering: an attached session is detached at the validated tip in place, so neither
        an attached nor a detached session can move after validation."""
        if not self.lock_file(self.session_head_lock):
            return False
        self.session_head_lock_owned = True
        raw = system.first_line(self.session_head_path)
        if raw is None:
            return False
        if self.session_ref:
            if raw != f"ref: refs/heads/{self.branch}":
                return False
            if not system.write_file(self.session_head_lock, f"{self.session_head}\n"):
                return False
            if system.atomic_rename(self.session_head_lock, self.session_head_path) is not None:
                return False
            self.session_head_lock_owned = False
            if not self.lock_file(self.session_head_lock):
                return False
            self.session_head_lock_owned = True
            raw = system.first_line(self.session_head_path)
            if raw is None:
                return False
        return raw == self.session_head

    # --- recovery refs -------------------------------------------------------------------------

    def retain_object(self, namespace: str, label: str, kind: str, oid: str) -> None:
        """Keep ``oid`` reachable under ``refs/ship-pr/<namespace>/<branch>/<kind>-<oid>``.
        ``label`` is the refusal's word for it: ``archived session`` or ``topic``."""
        if quiet_err_ok("-C", self.main, "cat-file", "-e", f"{oid}^{{object}}") != 0:
            if namespace == "session-recovery":
                fail(f"archived session metadata contains an unreadable object: {kind}")
            fail(f"topic recovery metadata contains an unreadable object: {kind}")
        recovery_ref = f"refs/ship-pr/{namespace}/{self.branch}/{kind}-{oid}"
        if quiet("-C", self.main, "symbolic-ref", "-q", recovery_ref) == 0:
            fail(f"{label} metadata recovery ref is symbolic rather than direct: {recovery_ref}")
        if git("-C", self.main, "show-ref", "--verify", "--quiet", recovery_ref).rc == 0:
            rc, recovery_oid = captured("-C", self.main, "rev-parse", recovery_ref)
            if rc != 0:
                fail(f"cannot read {recovery_ref}")
            if recovery_oid != oid:
                fail(f"{label} metadata recovery points at an unexpected object: {recovery_ref}")
        elif git("-C", self.main, "update-ref", "--no-deref", recovery_ref, oid, "").rc != 0:
            if namespace == "session-recovery":
                fail(f"could not retain archived session metadata object: {recovery_ref}")
            fail(f"could not retain topic metadata object: {recovery_ref}")

    def retain_session_object(self, kind: str, oid: str) -> None:
        self.retain_object("session-recovery", "session", kind, oid)

    def retain_topic_recovery_object(self, kind: str, oid: str) -> None:
        self.retain_object("recovery", "topic", kind, oid)

    def reflog_oids(self, path: str) -> list[str]:
        """Both sides of every reflog entry that names an object (not the null id)."""
        lines = system.read_lines(path)
        oids: list[str] = []
        for line in lines or []:
            old_oid, new_oid, _ = system.read_fields(line, 3)
            for oid in (old_oid, new_oid):
                if system.has_nonzero(oid):
                    oids.append(oid)
        return oids

    def retain_topic_reflog_sides(self, ref: str, kind: str) -> None:
        rc, path = captured("-C", self.main, "rev-parse", "--git-path", f"logs/{ref}")
        if rc != 0:
            fail(f"could not locate {ref} reflog")
        path = joined(self.main, path)
        path_dir = system.posix_dirname(path)
        if not system.is_dir(path_dir):
            if system.lexists(path):
                fail(f"{ref} reflog has an invalid parent")
            return
        path_dir = canonical_dir(path_dir)
        path = f"{path_dir}/{system.posix_basename(path)}"
        if system.is_link(path):
            fail(f"{ref} reflog is symbolic")
        if not system.is_file(path):
            return
        for oid in self.reflog_oids(path):
            self.retain_topic_recovery_object(kind, oid)

    def retain_session_reflog_sides(self, ref: str, kind: str = "private-reflog", path: str = "") -> None:
        if not path:
            rc, path = captured(
                "-C", self.session_archived_worktree, "rev-parse", "--git-path", f"logs/{ref}"
            )
            if rc != 0:
                fail(f"could not locate session-private reflog: {ref}")
            path = joined(self.session_archived_worktree, path)
        path_dir = system.posix_dirname(path)
        if not system.is_dir(path_dir):
            if system.lexists(path):
                fail(f"session-private reflog has an invalid parent: {ref}")
            return
        path_dir = canonical_dir(path_dir)
        path = f"{path_dir}/{system.posix_basename(path)}"
        if system.is_link(path):
            fail(f"session-private reflog is symbolic: {ref}")
        if not system.is_file(path):
            return
        for oid in self.reflog_oids(path):
            self.retain_session_object(kind, oid)

    # --- ref transactions ----------------------------------------------------------------------

    def open_ref_transaction(self, checkout: str, what: str) -> RefTransaction:
        transaction = RefTransaction(checkout, what)
        self.transaction = transaction
        refusal = transaction.open(self.temp_root)
        if refusal is not None:
            fail(refusal)
        return transaction

    def discard_ref_transaction(self) -> None:
        if self.transaction is not None:
            self.transaction.discard()
            self.transaction = None

    def finish_ref_transaction(self, transaction: RefTransaction) -> None:
        refusal = transaction.finish()
        if refusal is not None:
            fail(refusal)
        self.transaction = None

    def retain_private_session_refs(self) -> None:
        archived = self.session_archived_worktree
        done = git(
            "-C",
            archived,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/worktree",
            "refs/bisect",
            "refs/rewritten",
            out="capture",
        )
        if done.rc != 0:
            fail("could not recheck session-private refs before unregistering")
        private_refs: list[tuple[str, str]] = []
        for line in substitution(done.out).split("\n"):
            ref, _, rest = line.partition(" ")
            oid = rest if " " in line else line
            if not ref:
                continue
            # The namespace roots themselves are shared; only their children are private.
            if ref in ("refs/worktree", "refs/bisect", "refs/rewritten"):
                continue
            private_refs.append((ref, oid))
        transaction = self.open_ref_transaction(archived, "session-private namespace")
        if not transaction.send("start\noption no-deref\n"):
            fail("could not start the private namespace transaction")
        for ref, oid in private_refs:
            if not oid:
                fail(f"session-private ref has no object: {ref}")
            if not transaction.send(f"delete {ref} {oid}\n"):
                fail(f"could not queue session-private ref retention: {ref}")
        if not transaction.send("prepare\n"):
            fail("could not prepare session-private namespace retention")
        ok, response = transaction.response()
        if not ok:
            fail("session-private namespace transaction stopped before start")
        if response != "start: ok":
            fail("session-private namespace transaction did not start")
        ok, response = transaction.response()
        if not ok:
            fail("session-private namespace transaction stopped before preparation")
        if response != "prepare: ok":
            fail("session-private refs changed before retention")
        for ref, oid in private_refs:
            self.retain_session_object("private-ref", oid)
            self.retain_session_reflog_sides(ref)
        if not transaction.send("commit\n"):
            fail("could not commit session-private namespace retention")
        ok, response = transaction.response()
        if not ok:
            fail("session-private namespace transaction stopped before commit")
        if response != "commit: ok":
            fail("session-private namespace transaction did not commit")
        self.finish_ref_transaction(transaction)

        # Reserve each per-worktree namespace directory with a regular-file blocker after
        # atomically emptying it. A writer that recreates a child in the handoff makes rmdir refuse
        # and preserves the new state; once installed, the blocker makes every child creation fail.
        for namespace in ("refs/worktree", "refs/bisect", "refs/rewritten"):
            rc, probe = captured("-C", archived, "rev-parse", "--git-path", f"{namespace}/ship-pr-probe")
            if rc != 0:
                fail(f"could not locate private namespace: {namespace}")
            probe = joined(archived, probe)
            blocker = system.posix_dirname(probe)
            blocker_parent = system.posix_dirname(blocker)
            if not system.is_dir(blocker_parent):
                if system.lexists(blocker_parent):
                    fail(f"private namespace parent is invalid: {namespace}")
                if not system.mkdir(blocker_parent):
                    fail(f"could not create private namespace parent: {namespace}")
            blocker_parent = canonical_dir(blocker_parent)
            blocker = f"{blocker_parent}/{system.posix_basename(blocker)}"
            blocker_temp = system.mktemp_file(f"{blocker_parent}/.ship-pr-namespace-blocker.XXXXXX")
            if blocker_temp is None:
                fail(f"could not allocate private namespace blocker: {namespace}")
            if not system.write_file(blocker_temp, f"{self.local_branch_oid}\n"):
                fail(f"could not write private namespace blocker: {namespace}")
            if system.is_dir(blocker):
                if not system.rmdir(blocker):
                    fail(f"private namespace gained a ref during retention: {namespace}")
            elif system.lexists(blocker):
                fail(f"private namespace gained an unexpected entry during retention: {namespace}")
            if system.atomic_rename(blocker_temp, blocker) is not None:
                fail(f"could not install private namespace blocker: {namespace}")
            self.private_namespace_blockers.append(blocker)

    def delete_ref_with_locked_reflog(self, ref: str, expected_oid: str, kind: str) -> bool:
        """Delete ``ref`` at ``expected_oid`` with its reflog retained while ``prepare`` holds
        both locks; False (after aborting) when the deletion could not be prepared."""
        transaction = self.open_ref_transaction(self.main, f"ref deletion ({ref})")
        if not transaction.send(f"start\noption no-deref\ndelete {ref} {expected_oid}\nprepare\n"):
            fail(f"could not prepare the ref deletion: {ref}")
        ok, response = transaction.response()
        if not ok or response != "start: ok":
            note(f"ref deletion transaction did not start: {ref}: {response}")
            self.discard_ref_transaction()
            return False
        ok, response = transaction.response()
        if not ok or response != "prepare: ok":
            note(f"ref deletion transaction was not prepared: {ref}: {response}")
            self.discard_ref_transaction()
            return False
        self.retain_topic_reflog_sides(ref, kind)
        if not transaction.send("commit\n"):
            fail(f"could not commit the ref deletion: {ref}")
        ok, response = transaction.response()
        if not ok:
            fail(f"ref deletion transaction stopped before commit: {ref}")
        if response != "commit: ok":
            fail(f"ref deletion transaction did not commit: {ref}: {response}")
        self.finish_ref_transaction(transaction)
        # Read the deletion back rather than trusting the channel: a transaction that reads
        # nothing also exits 0, and the caller deletes the remote topic only on this success.
        status = quiet("-C", self.main, "show-ref", "--exists", ref)
        if status != 2:
            fail(f"ref deletion committed but {ref} is not absent on read-back (show-ref exit {status})")
        return True

    # --- the archived session's metadata -------------------------------------------------------

    def link_snapshot(self, path: str, template: str, allocate: str, prepare: str, link: str) -> None:
        """A hard link to ``path`` at a fresh name in the session archive, so a direct Git
        overwrite of the original updates the recovery copy too."""
        snapshot = system.mktemp_file(f"{self.session_archive}/{template}")
        if snapshot is None:
            fail(allocate)
        if not system.unlink(snapshot):
            fail(prepare)
        if not system.hard_link(path, snapshot):
            fail(link)

    def lock_and_retain_session_metadata(self) -> None:
        archived = self.session_archived_worktree
        archive = self.session_archive
        for name in (
            "ORIG_HEAD",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "REBASE_HEAD",
            "BISECT_HEAD",
            "AUTO_MERGE",
            "FETCH_HEAD",
        ):
            _, path = self.locate(archived, name, f"could not locate archived session pseudoref: {name}")
            lock = f"{path}.lock"
            if not self.lock_file(lock):
                fail(f"archived session pseudoref is busy: {name}")
            self.session_pseudoref_locks.append(lock)
            if system.is_link(path):
                fail(f"archived session pseudoref is symbolic: {name}")
            if system.is_file(path):
                for line in system.read_lines(path) or []:
                    oid = system.first_token(line)
                    if oid:
                        self.retain_session_object(f"pseudoref-{name}", oid)
            rc, worktree_git_dir = captured("-C", archived, "rev-parse", "--absolute-git-dir")
            if rc != 0:
                fail("could not locate archived session Git metadata")
            worktree_git_dir = canonical_dir(worktree_git_dir)
            self.retain_session_reflog_sides(
                name, f"pseudoref-reflog-{name}", f"{worktree_git_dir}/logs/{name}"
            )

        _, path = self.locate(archived, "COMMIT_EDITMSG", "could not locate archived commit message")
        lock = f"{path}.lock"
        if not self.lock_file(lock):
            fail("archived commit message is busy")
        self.session_pseudoref_locks.append(lock)
        if system.is_link(path):
            fail("archived commit message is symbolic")
        if not system.is_file(path) and not system.write_file(path, ""):
            fail("could not reserve the archived commit-message path")
        self.link_snapshot(
            path,
            "COMMIT_EDITMSG.XXXXXX",
            "could not allocate a commit-message snapshot",
            "could not prepare the commit-message snapshot",
            "could not link the archived commit message",
        )

        _, path = self.locate(archived, "SQUASH_MSG", "could not locate archived squash message")
        lock = f"{path}.lock"
        if not self.lock_file(lock):
            fail("archived squash message is busy")
        self.session_pseudoref_locks.append(lock)
        if system.is_link(path):
            fail("archived squash message is symbolic")
        if system.is_file(path):
            self.link_snapshot(
                path,
                "SQUASH_MSG.XXXXXX",
                "could not allocate a squash-message snapshot",
                "could not prepare the squash-message snapshot",
                "could not link the archived squash message",
            )

        for name in ("TAG_EDITMSG", "NOTES_EDITMSG"):
            _, path = self.locate(archived, name, f"could not locate archived edit message: {name}")
            lock = f"{path}.lock"
            if not self.lock_file(lock):
                fail(f"archived edit message is busy: {name}")
            self.session_pseudoref_locks.append(lock)
            if system.is_link(path):
                fail(f"archived edit message is symbolic: {name}")
            if system.is_file(path):
                self.link_snapshot(
                    path,
                    f"{name}.XXXXXX",
                    f"could not allocate an edit-message snapshot: {name}",
                    f"could not prepare the edit-message snapshot: {name}",
                    f"could not link the archived edit message: {name}",
                )

        for name, label, noun, template in (
            (
                "config.worktree",
                "per-worktree configuration",
                "a per-worktree configuration snapshot",
                "config.worktree.XXXXXX",
            ),
            (
                "info/sparse-checkout",
                "sparse-checkout metadata",
                "a sparse-checkout snapshot",
                "sparse-checkout.XXXXXX",
            ),
        ):
            path = self.locate_raw(archived, name, f"could not locate archived {label}")
            path_dir = system.posix_dirname(path)
            if system.is_dir(path_dir):
                path_dir = canonical_dir(path_dir)
                path = f"{path_dir}/{system.posix_basename(path)}"
                lock = f"{path}.lock"
                if not self.lock_file(lock):
                    fail(f"archived {label} is busy")
                self.session_pseudoref_locks.append(lock)
                if system.is_link(path):
                    fail(f"archived {label} is symbolic")
                if system.is_file(path):
                    snapshot = system.mktemp_file(f"{archive}/{template}")
                    if snapshot is None:
                        fail(f"could not allocate {noun}")
                    if not system.copy_contents(path, snapshot):
                        fail(f"could not archive {label}")
            elif system.lexists(path):
                fail(f"archived {label} has an invalid parent")

        rc, path = captured("-C", archived, "rev-parse", "--git-path", "index")
        if rc != 0:
            fail("could not locate archived session index")
        path = joined(archived, path)
        path_dir = canonical_dir(system.posix_dirname(path))
        lock = f"{path_dir}/{system.posix_basename(path)}.lock"
        if not self.lock_file(lock):
            fail("archived session index is busy")
        self.session_pseudoref_locks.append(lock)
        index_snapshot = system.mktemp_file(f"{archive}/index.snapshot.XXXXXX")
        if index_snapshot is None:
            fail("could not allocate an archived session index snapshot")
        if not system.copy_contents(path, index_snapshot):
            fail("could not copy the locked archived session index")
        rc, shared_index = captured("-C", archived, "rev-parse", "--shared-index-path")
        if rc != 0:
            fail("could not locate the archived session shared index")
        if shared_index:
            shared_index = joined(archived, shared_index)
            shared_dir = canonical_dir(system.posix_dirname(shared_index))
            shared_index = f"{shared_dir}/{system.posix_basename(shared_index)}"
            if system.is_link(shared_index):
                fail("archived session shared index is symbolic")
            if not system.is_file(shared_index):
                fail("archived session shared index is missing")
            shared_temp = system.mktemp_file(f"{archive}/sharedindex.snapshot.XXXXXX")
            if shared_temp is None:
                fail("could not allocate an archived shared-index snapshot")
            if not system.copy_contents(shared_index, shared_temp):
                fail("could not copy the archived session shared index")
            shared_snapshot = f"{archive}/{system.posix_basename(shared_index)}"
            if not system.hard_link(shared_temp, shared_snapshot):
                fail("could not reserve the archived session shared-index name")
            if not system.unlink(shared_temp):
                fail("could not finalize the archived session shared-index snapshot")
        snapshot_env = {"GIT_INDEX_FILE": index_snapshot}
        done = git("-C", archived, "write-tree", out="capture", env=snapshot_env)
        if done.rc != 0:
            fail("could not retain the archived session index")
        self.retain_session_object("index-tree", substitution(done.out))
        reuc_snapshot = system.mktemp_file(f"{archive}/index.resolve-undo.XXXXXX")
        if reuc_snapshot is None:
            fail("could not allocate a resolve-undo snapshot")
        done = git("-C", archived, "ls-files", "--resolve-undo", "-z", out="capture", env=snapshot_env)
        if done.rc != 0 or not system.write_file(reuc_snapshot, done.out):
            fail("could not inspect archived session resolve-undo data")
        for line in system.nul_records(done.out):
            metadata = line.split("\t", 1)[0]
            _, oid, _ = system.read_fields(metadata, 3)
            if oid:
                self.retain_session_object("index-reuc", oid)

        path = self.locate_raw(archived, "logs/HEAD", "could not locate the archived session HEAD reflog")
        path_dir = system.posix_dirname(path)
        if system.is_dir(path_dir):
            path_dir = canonical_dir(path_dir)
            path = f"{path_dir}/{system.posix_basename(path)}"
            if system.is_link(path):
                fail("archived session HEAD reflog is symbolic")
            if system.is_file(path):
                for oid in self.reflog_oids(path):
                    self.retain_session_object("reflog-HEAD", oid)
        elif system.lexists(path):
            fail("archived session HEAD reflog has an invalid parent")

    # --- worktree ownership --------------------------------------------------------------------

    def scan_branch_owner(self, target_ref: str) -> None:
        """Which worktree has ``target_ref`` checked out, how many do, and whether the session's
        registration is locked. NUL-delimited: a worktree path can hold a newline."""
        self.branch_owner = ""
        self.branch_owner_count = 0
        self.session_locked = False
        # The listing is read from a capture, but the shell's snapshot file is still allocated and
        # removed: it is the helper's first write into TEMP_ROOT, so an unusable TMPDIR refuses
        # here, before the base fetch and before any reservation, as it did in the shell.
        snapshot = system.mktemp_file(f"{self.temp_root}/ship-pr-worktree-list.XXXXXX")
        if snapshot is None:
            fail("could not allocate the worktree list snapshot")
        try:
            done = git("-C", self.main, "worktree", "list", "--porcelain", "-z", out="capture")
        finally:
            removed = system.unlink(snapshot)
        if done.rc != 0:
            fail("could not inspect registered worktrees")
        if not removed:
            fail("could not remove the worktree list snapshot")
        current = ""
        for entry in system.nul_records(done.out):
            if entry.startswith("worktree "):
                current = entry[len("worktree ") :]
            elif entry.startswith("locked") and current == self.session:
                self.session_locked = True
            if entry == f"branch {target_ref}":
                self.branch_owner = current
                self.branch_owner_count += 1

    # --- the remote steps ----------------------------------------------------------------------

    def local_topic_reappeared(self) -> bool:
        """Nothing holds the local topic name once its deletion has committed, so the remote steps
        are bracketed by two reads of it. True when the name is present or cannot be proved
        absent, with ``current_topic_oid`` the tip to publish: its own when it resolves, else the
        retained original tip. It never refuses, so its caller can still restore."""
        self.current_topic_oid = ""
        status = quiet("-C", self.main, "show-ref", "--exists", f"refs/heads/{self.branch}")
        if status == 2:
            return False
        rc, oid = captured(
            "-C", self.main, "rev-parse", "--verify", "--quiet", f"refs/heads/{self.branch}^{{commit}}", quiet=True
        )
        self.current_topic_oid = oid if rc == 0 and oid else self.local_branch_oid
        return True

    def remote_base_still_integrates(self) -> str:
        """Is the remote base still the validated ``remote_master`` or a verified fast-forward of
        it? The problem when it is not, else the empty string."""
        done = git(
            "-C",
            self.main,
            "ls-remote",
            "--exit-code",
            "--heads",
            self.origin_push_url,
            self.base_local_ref,
            out="capture",
        )
        if done.rc != 0:
            return f"remote {self.base} became unreadable"
        oid = system.first_token(substitution(done.out))
        if oid == self.remote_master:
            return ""
        # A sibling merge preserves the containment already proved: fetch the exact advertised
        # object, never the branch name, and without moving any ref.
        if (
            git("-C", self.main, "fetch", "--no-tags", "--no-write-fetch-head", self.origin_push_url, oid).rc
            != 0
            or git("-C", self.main, "merge-base", "--is-ancestor", self.remote_master, oid).rc != 0
        ):
            return (
                f"remote {self.base} changed from {self.remote_master} to {oid} without a "
                "verified fast-forward"
            )
        return ""

    def restore_remote_topic(self, recovery_oid: str) -> bool:
        branch_ref = f"refs/heads/{self.branch}"
        pushed = git(
            "-C",
            self.main,
            "push",
            f"--force-with-lease={branch_ref}:",
            self.origin_push_url,
            f"{recovery_oid}:{branch_ref}",
        )
        if pushed.rc == 0:
            return True
        # A competing writer may have restored another recovery tip first, which is still safer
        # than an absent ref.
        return (
            quiet("-C", self.main, "ls-remote", "--exit-code", "--heads", self.origin_push_url, branch_ref)
            == 0
        )

    def finish_remote_deletion(self, oid: str) -> str:
        """The command that finishes the job, leased at ``oid``, for a refusal that leaves
        origin/<branch> in place once the session is archived and the helper cannot be re-run. The
        push URL is the validated one with any http(s) userinfo removed, so no credential reaches
        the diagnostic and the endpoint stays the same."""
        url = self.origin_push_url
        if url.startswith(("http://", "https://")):
            scheme, _, rest = url.partition("://")
            authority = rest.split("/", 1)[0]
            if "@" in authority:
                url = f"{scheme}://{authority.rsplit('@', 1)[1]}{rest[len(authority):]}"
        branch_ref = f"refs/heads/{self.branch}"
        return (
            f"finish with: git -C {q(show(self.main))} push "
            f"{q(f'--force-with-lease={branch_ref}:{oid}')} {q(url)} {q(f':{branch_ref}')}"
        )

    # --- the run -------------------------------------------------------------------------------

    def run(self, argv: list[str]) -> int:
        if len(argv) < 3:
            usage()
        self.main = canonical_dir(argv[0])
        self.session = canonical_dir(argv[1])
        self.session_original = self.session
        self.temp_root = canonical_dir(temp_directory())
        self.branch = argv[2]
        parsed = parse_options(argv[3:])
        match parsed:
            case Parsed(options):
                self.base = options.base
                self.force_reason = options.force_reason
                self.regenerable = options.regenerable
            case UsageError():
                usage()
            case _:
                assert_never(parsed)
        self.validate()
        self.gate_session()
        self.reserve()
        self.prove_integration()
        self.fast_forward_base()
        self.retain_topic()
        remote_branch_oid = self.observe_remote_topic()
        self.prune_tracking_ref()
        self.clean_branch_configuration()
        self.reserve_topic()
        self.archive_session()
        return self.finish(remote_branch_oid)

    def validate(self) -> None:
        main, session, branch, base = self.main, self.session, self.branch, self.base
        if quiet("check-ref-format", f"refs/heads/{branch}") != 0:
            fail(f"invalid branch name: {branch}")
        if quiet("-C", main, "rev-parse", "--is-inside-work-tree") != 0:
            fail(f"main checkout is not a git worktree: {show(main)}")
        if quiet("-C", session, "rev-parse", "--is-inside-work-tree") != 0:
            fail(f"session path is not a git worktree: {show(session)}")
        rc, validated_base = captured("-C", main, "check-ref-format", "--branch", base, quiet=True)
        if rc != 0:
            fail(f"invalid base branch name: {base}")
        if validated_base != base:
            fail(f"expanded base branch shorthand is not allowed: {base} (use {validated_base})")
        if branch == base:
            fail(f"refusing to clean up the base branch {base}")
        self.base_local_ref = f"refs/heads/{base}"
        self.base_remote_ref = f"refs/remotes/origin/{base}"
        _, toplevel = captured("-C", session, "rev-parse", "--show-toplevel")
        session_toplevel = canonical_dir(toplevel)
        if session != session_toplevel:
            fail(
                f"session-worktree must be the worktree root ({show(session_toplevel)}), not a "
                "directory inside it"
            )
        if self.temp_root == session or self.temp_root.startswith(f"{session}/"):
            fail(f"temporary root must be outside the session worktree: {show(self.temp_root)}")

        _, value = captured("-C", main, "rev-parse", "--git-common-dir")
        self.main_common = git_path(main, value)
        _, value = captured("-C", main, "rev-parse", "--git-dir")
        main_git = git_path(main, value)
        _, value = captured("-C", session, "rev-parse", "--git-common-dir")
        session_common = git_path(session, value)
        if main_git != self.main_common:
            fail(f"main-checkout is a linked worktree, not the primary checkout: {show(main)}")
        if main == session:
            fail("main checkout and session worktree must be different paths")
        if session_common != self.main_common:
            fail("main checkout and session worktree belong to different repositories")
        rc, ref_format = captured("-C", main, "rev-parse", "--show-ref-format")
        if rc != 0:
            fail("could not determine repository ref storage")
        if ref_format != "files":
            fail(f"cleanup currently requires files ref storage, found: {ref_format}")
        config = f"{self.main_common}/config"
        if system.is_link(config):
            fail("repository config is symbolic; replace it before cleanup")
        if not system.is_file(config):
            fail("repository config is missing or not a regular file")
        if system.lexists(f"{config}.lock"):
            fail("repository config is locked; retry after the lock clears")

        branch_ref = f"refs/heads/{branch}"
        if git("-C", main, "show-ref", "--verify", "--quiet", branch_ref).rc != 0:
            fail(f"local branch does not exist: {branch}")
        if quiet("-C", main, "symbolic-ref", "-q", branch_ref) == 0:
            fail(f"local branch ref is symbolic rather than direct: {branch_ref}")
        rc, self.local_branch_oid = captured("-C", main, "rev-parse", branch_ref)
        if rc != 0:
            fail(f"cannot read local {branch}")

        _, self.session_ref = captured("-C", session, "symbolic-ref", "-q", "HEAD", quiet=True)
        if self.session_ref:
            if self.session_ref != branch_ref:
                fail(f"session worktree owns {self.session_ref.removeprefix('refs/heads/')}, not {branch}")
            self.session_head = self.local_branch_oid
        else:
            rc, self.session_head = captured("-C", session, "rev-parse", "HEAD")
            if rc != 0:
                fail("cannot read detached session HEAD")
            rc, branch_head = captured("-C", main, "rev-parse", branch_ref)
            if rc != 0:
                fail(f"cannot read {branch}")
            if self.session_head != branch_head:
                fail(f"detached session HEAD is not the tip of {branch}")

        self.scan_branch_owner(branch_ref)
        if self.session_locked:
            fail("session worktree is locked; unlock it before cleanup")
        if self.session_ref:
            if self.branch_owner_count != 1:
                fail(f"{branch} must be owned only by the attached session worktree")
            owner = canonical_dir(self.branch_owner)
            if owner != session:
                fail(f"{branch} is owned by another worktree: {show(owner)}")
        elif self.branch_owner_count != 0:
            fail(
                f"detached session cannot clean {branch} while another worktree owns it: "
                f"{self.branch_owner}"
            )

    def gate_session(self) -> None:
        session = self.session
        self.remove_regenerable_directories()
        self.refuse_session_local_data()
        self.refuse_initialized_submodules(session, "session worktree", show(session))
        self.refuse_session_module_gitdirs(session, show(session))
        self.refuse_private_worktree_refs(session, show(session))
        self.refuse_active_session_operations()
        self.preflight_session_metadata_locks()
        self.preflight_sparse_checkout_metadata()

        rc, head_path = captured("-C", session, "rev-parse", "--git-path", "HEAD")
        if rc != 0:
            fail("cannot locate session HEAD")
        self.session_head_path = joined(session, head_path)
        head_dir = canonical_dir(system.posix_dirname(self.session_head_path))
        self.session_head_lock = f"{head_dir}/{system.posix_basename(self.session_head_path)}.lock"
        if system.lexists(self.session_head_lock):
            fail("session HEAD is locked; retry after its Git operation finishes")

    def reserve(self) -> None:
        main, session = self.main, self.session
        # A child ref kept present until the final session recovery ref exists: with the files
        # backend it reserves every prefix directory against a conflicting direct ref, and an
        # existing conflict makes this expected-absent update fail before any mutation.
        self.session_namespace_reservation = (
            f"refs/ship-pr/session-recovery/{self.branch}/reservation-{os.getpid()}"
        )
        if (
            git(
                "-C", main, "update-ref", "--no-deref", self.session_namespace_reservation, self.local_branch_oid, ""
            ).rc
            != 0
        ):
            fail("session recovery ref namespace is unavailable")
        self.session_namespace_reservation_owned = True

        # Both sibling archives, before any ref mutation: the empty directories prove the parent
        # writable and reserve the names; teardown moves data beneath them.
        parent = system.posix_dirname(session)
        name = system.posix_basename(session)
        archive = system.mktemp_dir(f"{parent}/.{name}.ship-pr-recovery.XXXXXX")
        if archive is None:
            fail(f"could not allocate a session recovery archive beside {show(session)}")
        self.session_archive = archive
        late = system.mktemp_dir(f"{parent}/.{name}.ship-pr-late-data.XXXXXX")
        if late is None:
            fail(f"could not allocate a late-data recovery archive beside {show(session)}")
        self.late_session_archive = late
        link_probe = f"{archive}/.commit-message-link-probe"
        if not system.hard_link(f"{self.main_common}/config", link_probe):
            fail("session recovery archive cannot hard-link repository metadata")
        if not system.unlink(link_probe):
            fail("could not remove the commit-message link probe")
        if git("-C", main, "worktree", "lock", "--reason", "ship-pr cleanup in progress", session).rc != 0:
            fail("could not lock the session worktree registration against pruning")
        self.session_worktree_lock_owned = True

        # symref-update provides the compare-and-swap of the base ownership handoff: probe it
        # before any mutation, so an older Git refuses cleanly rather than mid-cleanup.
        self.capability_ref = f"refs/ship-pr/capability-probe-{os.getpid()}"
        status = quiet("-C", main, "show-ref", "--exists", self.capability_ref)
        if status == 0:
            fail(f"temporary capability ref already exists: {self.capability_ref}")
        if status != 2:
            fail(f"could not inspect the temporary capability ref: {self.capability_ref}")
        if git("-C", main, "symbolic-ref", self.capability_ref, self.base_local_ref).rc != 0:
            fail("could not create the symref capability probe")
        self.capability_ref_owned = True
        probe = git(
            "-C",
            main,
            "update-ref",
            "--stdin",
            out="devnull",
            err="devnull",
            stdin=system.encode(
                "option no-deref\n"
                f"symref-update {self.capability_ref} {self.base_local_ref} ref {self.base_local_ref}\n"
            ),
        )
        if probe.rc != 0:
            if quiet("-C", main, "symbolic-ref", "--delete", self.capability_ref) == 0:
                self.capability_ref_owned = False
            fail("Git lacks update-ref symref transactions required for safe cleanup")
        if git("-C", main, "symbolic-ref", "--delete", self.capability_ref).rc != 0:
            fail("could not remove the symref capability probe")
        self.capability_ref_owned = False

    def prove_integration(self) -> None:
        main, base, branch = self.main, self.base, self.branch
        # Fetch before the safety decision: the local base may be stale, while origin/<base> is
        # the state whose PR merge was independently confirmed.
        if quiet("-C", main, "symbolic-ref", "-q", self.base_remote_ref) == 0:
            fail(f"origin/{base} is symbolic rather than a direct remote-tracking ref")
        if git("-C", main, "fetch", "--no-tags", "origin", f"+{self.base_local_ref}:{self.base_remote_ref}").rc != 0:
            fail(f"could not fetch origin/{base} explicitly")
        if git("-C", main, "show-ref", "--verify", "--quiet", self.base_remote_ref).rc != 0:
            fail(f"origin/{base} does not exist")
        if not self.force_reason:
            if git("-C", main, "merge-base", "--is-ancestor", f"refs/heads/{branch}", self.base_remote_ref).rc != 0:
                fail(
                    f"{branch} is not an ancestor of origin/{base}; independently confirm a "
                    "squash/rebase merge and use --force-integrated with a reason"
                )
        else:
            note(f"FORCE-INTEGRATED override: {self.force_reason}")

        # Read and delete the branch through the same push endpoint.
        rc, push_urls = captured("-C", main, "remote", "get-url", "--push", "--all", "origin")
        if rc != 0:
            fail("could not resolve origin's push endpoint")
        if not push_urls:
            fail("origin has no push endpoint")
        if "\n" in push_urls:
            fail("origin has multiple push endpoints; refusing ambiguous branch deletion")
        self.origin_push_url = push_urls
        rc, fetch_url = captured("-C", main, "remote", "get-url", "origin")
        if rc != 0:
            fail("could not resolve origin's fetch endpoint")
        if fetch_url != self.origin_push_url:
            fail(
                "origin has distinct fetch and push endpoints; cleanup requires one repository for "
                f"{base} and topic"
            )
        if quiet("-C", main, "symbolic-ref", "-q", f"refs/remotes/origin/{branch}") == 0:
            fail(f"remote-tracking branch is symbolic rather than direct: refs/remotes/origin/{branch}")

    def fast_forward_base(self) -> None:
        """Prove and perform the local base fast-forward before deleting anything, keeping the
        checked-out base continuously owned so Git refuses another worktree's checkout."""
        main, base = self.main, self.base
        if quiet("-C", main, "symbolic-ref", "-q", self.base_local_ref) == 0:
            fail(f"local {base} ref is symbolic rather than direct")
        rc, self.local_master = captured("-C", main, "rev-parse", self.base_local_ref)
        if rc != 0:
            fail(f"cannot read local {base}")
        rc, self.remote_master = captured("-C", main, "rev-parse", self.base_remote_ref)
        if rc != 0:
            fail(f"cannot read origin/{base}")
        if git("-C", main, "merge-base", "--is-ancestor", self.local_master, self.remote_master).rc != 0:
            fail(f"local {base} cannot fast-forward to origin/{base}")

        self.scan_branch_owner(self.base_local_ref)
        if self.branch_owner_count > 1:
            fail(f"more than one worktree reports owning {base}")
        if self.branch_owner_count == 0:
            reservation = system.mktemp_dir(f"{self.temp_root}/ship-pr-master-reserve.XXXXXX")
            self.master_reservation = reservation or ""
            if reservation is None:
                fail(f"could not allocate a temporary {base} reservation")
            if not system.rmdir(reservation):
                fail(f"could not prepare the temporary {base} reservation path")
            if git("-C", main, "worktree", "add", "--", reservation, base, out="devnull").rc != 0:
                fail(f"could not reserve unchecked-out {base} in a temporary worktree")
            self.master_owner = reservation
            master_owner_shown = show(reservation)
            self.original_master_owner = ""
        else:
            self.master_owner = self.branch_owner
            master_owner_shown = self.branch_owner
            self.original_master_owner = self.branch_owner
        owner = self.master_owner

        _, owner_ref = captured("-C", owner, "symbolic-ref", "-q", "HEAD", quiet=True)
        if owner_ref != self.base_local_ref:
            fail(f"{base} owner changed branches before its fast-forward: {master_owner_shown}")
        rc, owner_head = captured("-C", owner, "rev-parse", "HEAD")
        if rc != 0:
            fail(f"cannot read {base} owner HEAD")
        if owner_head != self.local_master:
            fail(f"{base} owner's HEAD disagrees with local {base}")
        # Neither ignored nor untracked files are part of this gate (the rule above
        # scan_base_owner_local_data): on the standard layout the primary checkout owns the base
        # and carries build caches, notes and drafts. The rechecks after the refresh read the
        # owner through the same scanner, so data that passed here cannot come back as "gained".
        local_data = self.scan_base_owner_local_data(owner)
        if local_data is None:
            fail(f"could not inspect {base} owner cleanliness")
        if local_data:
            fail(f"{base} owner is dirty; clean it before cleanup: {master_owner_shown}: {local_data}")
        description = f"{base} owner"
        self.refuse_hidden_index_changes(owner, description, master_owner_shown)
        self.refuse_initialized_submodules(owner, description, master_owner_shown)
        self.refuse_index_resolve_undo(owner, description, master_owner_shown)
        self.refuse_active_session_operations(owner, description)

        changed = git("-C", main, "diff", "--name-only", "-z", self.local_master, self.remote_master, out="capture")
        if changed.rc != 0:
            fail(f"could not enumerate paths changed by the {base} fast-forward")
        # The collision scan, an allowlist of what may stand where the fast-forward writes. For
        # each changed path it reads only the owner's working tree along that path: every proper
        # ancestor must be a real directory or absent, and the path itself must be absent, a
        # file Git tracks, or a directory that stays one (or holds nothing Git calls "other").
        # Anything else on that path, an untracked or ignored file, link or directory, refuses
        # here, before any ref moves. Off the changed paths it reads nothing.
        collision = ""
        for changed_path in system.nul_records(changed.out):
            collision = self.fast_forward_collision(owner, changed_path)
            if collision:
                break
        if collision:
            fail(
                f"{base} fast-forward would overwrite untracked or ignored local data: "
                f"{q(f'{master_owner_shown}/{collision}')}"
            )

        # Keep an existing owner's symbolic HEAD and real index locked across the complete
        # named-ref and worktree refresh; an unowned base stays reserved by its helper worktree.
        original = self.original_master_owner
        if original:
            if not self.reserve_master_owner_handoff():
                fail(f"{base} owner HEAD or index changed before its locked refresh: {original}")
            if not self.prepare_master_owner_refresh():
                fail(f"could not prepare the locked {base}-owner refresh")
        if git("-C", main, "update-ref", "--no-deref", self.base_local_ref, self.remote_master, self.local_master).rc != 0:
            if original:
                if not self.relock_master_owner_head():
                    fail(f"local {base} and its owner's HEAD both moved after preflight")
                rc, during = captured("-C", main, "rev-parse", self.base_local_ref)
                if rc != 0:
                    fail(f"could not read {base} after its conditional update failed")
                if not self.refresh_master_owner_to(during):
                    fail(f"local {base} moved and its locked owner could not follow the concurrent tip")
                local_data = self.scan_base_owner_local_data(original, self.master_owner_index_lock)
                if local_data is None:
                    fail(f"could not recheck the {base} owner after its ref moved")
                self.install_master_owner_refresh()
                if local_data:
                    fail(f"local {base} moved and its owner gained data; the data was preserved: {local_data}")
            fail(f"local {base} moved after its owner preflight")
        if original:
            if not self.relock_master_owner_head():
                git("-C", main, "update-ref", "--no-deref", self.base_local_ref, self.local_master, self.remote_master)
                fail(f"{base} owner changed HEAD during its locked ownership handoff")
            if not self.refresh_master_owner_to(self.remote_master):
                git("-C", main, "update-ref", "--no-deref", self.base_local_ref, self.local_master, self.remote_master)
                fail(f"{base} owner could not be refreshed while its HEAD and index were locked")
            rc, during = captured("-C", main, "rev-parse", self.base_local_ref)
            if rc != 0:
                fail(f"could not recheck {base} during its locked refresh")
            if during != self.remote_master and not self.refresh_master_owner_to(during):
                fail(f"{base} moved during refresh and its owner could not follow the concurrent tip")
            # Ignored and untracked files pass here for the preflight gate's reason.
            local_data = self.scan_base_owner_local_data(original, self.master_owner_index_lock)
            if local_data is None:
                fail(f"could not recheck the locked {base} owner")
            self.install_master_owner_refresh()
            if local_data:
                fail(f"{base} owner gained local data during its locked update; the data was preserved: {local_data}")
            if during != self.remote_master:
                fail(f"{base} moved during its locked refresh; its owner followed the concurrent tip")
        else:
            reservation = self.master_reservation
            if git("-C", reservation, "read-tree", "--reset", "-u", self.remote_master, out="devnull").rc != 0:
                fail(f"{base} advanced but its helper-only reservation could not be refreshed")
            if git("-C", main, "worktree", "remove", "--force", reservation).rc != 0:
                fail(f"{base} advanced but its temporary reservation could not be removed")
            self.master_reservation = ""

        rc, self.local_master = captured("-C", main, "rev-parse", self.base_local_ref)
        if rc != 0:
            fail(f"cannot reread local {base}")
        if self.local_master != self.remote_master:
            fail(f"local {base} did not reach origin/{base}")
        rc, current = captured("-C", main, "rev-parse", f"refs/heads/{self.branch}")
        if rc != 0:
            fail(f"cannot reread local {self.branch}")
        if current != self.local_branch_oid:
            fail(f"local {self.branch} moved before remote deletion; all topic artifacts were preserved")

    def untracked_or_ignored_entry(self, owner: str, path: str) -> str:
        """The first file Git calls "other" (untracked or ignored, no exclude rules applied) at
        or under ``path`` in the owner, NUL-delimited so the name is the path to go clear, and
        empty when there is none. An unreadable listing refuses rather than reading as clear."""
        listed = git("-C", owner, "ls-files", "--others", "-z", "--", f":(literal){path}", out="capture")
        if listed.rc != 0:
            fail(f"could not list local data the {self.base} fast-forward would touch: {q(path)}")
        return system.first_nul_record(listed.out) or ""

    def fast_forward_collision(self, owner: str, changed_path: str) -> str:
        """The untracked or ignored entry the fast-forward of ``changed_path`` would overwrite in
        the owner, or empty. An ancestor that is a file or a symbolic link stands where the
        fast-forward needs a directory (a tracked one is itself a changed path, and Git replaces
        it); a link is never followed into."""
        parts = changed_path.split("/")
        for depth in range(1, len(parts)):
            ancestor = "/".join(parts[:depth])
            on_disk = f"{owner}/{ancestor}"
            if not system.lexists(on_disk):
                return ""
            if system.is_link(on_disk) or not system.is_dir(on_disk):
                return self.untracked_or_ignored_entry(owner, ancestor)
        on_disk = f"{owner}/{changed_path}"
        if not system.lexists(on_disk):
            return ""
        if not system.is_link(on_disk) and system.is_dir(on_disk):
            _, remote_type = captured(
                "-C", self.main, "cat-file", "-t", f"{self.remote_master}:{changed_path}", quiet=True
            )
            if remote_type == "tree":
                return ""
        return self.untracked_or_ignored_entry(owner, changed_path)

    def retain_direct_ref(self, ref: str, oid: str, label: str, retain_failure: str) -> None:
        """``ref`` at ``oid``: created when absent, accepted when already there, refused when it
        is symbolic or points anywhere else."""
        main = self.main
        if quiet("-C", main, "symbolic-ref", "-q", ref) == 0:
            fail(f"{label} is symbolic rather than {'a direct ref' if label == 'recovery ref' else 'direct'}: {ref}")
        if git("-C", main, "show-ref", "--verify", "--quiet", ref).rc == 0:
            rc, existing = captured("-C", main, "rev-parse", ref)
            if rc != 0:
                fail(f"cannot read {ref}")
            if existing != oid:
                fail(f"{label} points at an unexpected object: {ref}")
        elif git("-C", main, "update-ref", "--no-deref", ref, oid, "").rc != 0:
            fail(retain_failure)

    def retain_topic(self) -> None:
        """A remote base can change immediately after any finite observation, so the validated
        topic stays reachable locally after its public branch is gone; and a stale tracking ref
        that differs is preserved before its pruning."""
        main, branch = self.main, self.branch
        self.recovery_ref = f"refs/ship-pr/recovery/{branch}/{self.local_branch_oid}"
        self.retain_direct_ref(
            self.recovery_ref,
            self.local_branch_oid,
            "recovery ref",
            f"could not retain the topic recovery ref: {self.recovery_ref}",
        )
        self.retain_topic_reflog_sides(f"refs/heads/{branch}", "topic-reflog")

        tracking = f"refs/remotes/origin/{branch}"
        self.tracking_branch_present = False
        self.tracking_branch_oid = ""
        if git("-C", main, "show-ref", "--verify", "--quiet", tracking).rc == 0:
            self.tracking_branch_present = True
            rc, self.tracking_branch_oid = captured("-C", main, "rev-parse", tracking)
            if rc != 0:
                fail(f"cannot read origin/{branch} tracking ref")
            if self.tracking_branch_oid != self.local_branch_oid:
                tracking_recovery = f"refs/ship-pr/tracking-recovery/{branch}/{self.tracking_branch_oid}"
                self.retain_direct_ref(
                    tracking_recovery,
                    self.tracking_branch_oid,
                    "tracking recovery ref",
                    f"could not retain {tracking_recovery}",
                )
            self.retain_topic_reflog_sides(tracking, "tracking-reflog")

    def observe_remote_topic(self) -> str:
        """Observe the remote topic before any local topic mutation; it is deleted only as the
        very last step (ludics-lite#287), leased against what is observed here. Absent is a safe
        retry state, and then nothing is sent at the end."""
        main, branch = self.main, self.branch
        done = git(
            "-C", main, "ls-remote", "--exit-code", "--heads", self.origin_push_url, f"refs/heads/{branch}", out="capture"
        )
        remote_branch_oid = ""
        if done.rc == 0:
            remote_branch_oid = system.first_token(substitution(done.out))
            if remote_branch_oid != self.local_branch_oid:
                fail(
                    f"origin/{branch} moved from local {self.local_branch_oid} to {remote_branch_oid}; "
                    "refusing to delete its newer tip"
                )
        elif done.rc != 2:
            fail(f"could not determine whether origin/{branch} exists (ls-remote exit {done.rc})")
        problem = self.remote_base_still_integrates()
        if problem:
            fail(f"{problem} before any topic deletion; local and remote {branch} were preserved")
        return remote_branch_oid

    def prune_tracking_ref(self) -> None:
        """The remote-tracking ref is a local cache of the branch: pruned ahead of the topic, so
        its movement refusal precedes every other mutation."""
        main, branch = self.main, self.branch
        tracking = f"refs/remotes/origin/{branch}"
        if git("-C", main, "show-ref", "--verify", "--quiet", tracking).rc != 0:
            return
        rc, current = captured("-C", main, "rev-parse", tracking)
        if rc != 0:
            fail(f"cannot read origin/{branch} tracking ref")
        if not self.tracking_branch_present:
            fail(f"origin/{branch} tracking ref appeared during cleanup; its new tip was preserved")
        if current != self.tracking_branch_oid:
            fail(f"origin/{branch} tracking ref moved during cleanup; its new tip was preserved")
        if not self.delete_ref_with_locked_reflog(tracking, self.tracking_branch_oid, "tracking-reflog"):
            fail(f"origin/{branch} tracking ref changed before its leased deletion")

    def clean_branch_configuration(self) -> None:
        """Only the repository-local file removal edits, and only the standard branch keys, tested
        exactly: Git flattens dotted subsections, so branch.topic.* is not unambiguous when
        topic.child is also a branch. Inherited, global, per-worktree and custom keys are policy
        and are left alone. The edit is staged in config.lock, held through the topic deletion."""
        branch = self.branch
        self.config_lock = f"{self.main_common}/config.lock"
        if not system.noclobber_create(self.config_lock, ""):
            fail(f"repository config became locked during cleanup; local {branch} was preserved")
        self.config_lock_owned = True
        if not system.copy_preserving(f"{self.main_common}/config", self.config_lock):
            fail("could not snapshot repository configuration")
        for key in ("remote", "merge", "mergeOptions", "pushRemote", "rebase", "description"):
            name = f"branch.{branch}.{key}"
            status = quiet("config", "--file", self.config_lock, "--no-includes", "--get", name)
            if status == 0:
                unset = git(
                    "config", "--file", self.config_lock, "--no-includes", "--unset-all", name, err="devnull"
                )
                if unset.rc != 0:
                    fail(
                        f"branch configuration could not be removed; local {branch} and its session "
                        "were preserved"
                    )
            elif status != 1:
                fail(
                    f"branch configuration could not be inspected; local {branch} and its session "
                    "were preserved"
                )

    def reserve_topic(self) -> None:
        """Transfer topic ownership from the session to a temporary worktree, revalidating across
        the handoff: the reservation stays attached through the deletion, so no other worktree
        can acquire the branch between the last owner scan and the deletion."""
        main, branch = self.main, self.branch
        reservation = system.mktemp_dir(f"{self.temp_root}/ship-pr-topic-reserve.XXXXXX")
        self.topic_reservation = reservation or ""
        if reservation is None:
            fail("could not allocate a temporary topic reservation")
        if not system.rmdir(reservation):
            fail("could not prepare the temporary topic reservation path")
        if git("-C", main, "worktree", "add", "--detach", reservation, self.local_branch_oid, out="devnull").rc != 0:
            fail("could not prepare a temporary topic reservation")
        self.topic_reservation = canonical_dir(reservation)
        if not self.lock_session_head_for_archive():
            fail(f"session HEAD changed after preflight; local and remote {branch} were preserved")
        if quiet("-C", self.topic_reservation, "switch", "--", branch) != 0:
            quiet("-C", main, "worktree", "remove", "--force", self.topic_reservation)
            self.topic_reservation = ""
            fail(f"could not reserve local {branch} for deletion; local and remote {branch} were preserved")
        rc, current = captured("-C", main, "rev-parse", f"refs/heads/{branch}")
        if rc != 0:
            fail(f"cannot reread local {branch}")
        if current != self.local_branch_oid:
            quiet("-C", self.topic_reservation, "checkout", "--detach", self.local_branch_oid)
            quiet("-C", main, "worktree", "remove", "--force", self.topic_reservation)
            self.topic_reservation = ""
            fail(f"local {branch} moved during ownership handoff; its session and remote tip were preserved")

        self.scan_branch_owner(f"refs/heads/{branch}")
        if self.branch_owner_count != 1:
            fail(f"{branch} reservation was lost before deletion")
        owner = canonical_dir(self.branch_owner)
        if owner != self.topic_reservation:
            fail(f"{branch} was acquired by another worktree: {show(owner)}")
        if not self.force_reason:
            if git("-C", main, "merge-base", "--is-ancestor", f"refs/heads/{branch}", self.base_local_ref).rc != 0:
                fail(f"{branch} is not an ancestor of the updated local {self.base}")

    def archive_session(self) -> None:
        """Atomically move the session aside before unregistering it: `git worktree remove`
        deletes ignored files recursively, so ordinary removal cannot close the final write race.
        Removing the now-missing registered path drops only Git metadata."""
        main, session = self.main, self.session
        if not system.chdir(self.temp_root):
            fail("cannot move out of the session worktree before archiving it")
        self.session_archived_worktree = f"{self.session_archive}/worktree"
        archived = self.session_archived_worktree
        error = system.atomic_rename(session, archived)
        if error is not None:
            fail(f"could not archive session worktree atomically: {show(session)}")
        # The session HEAD lock taken during the ownership handoff stays held across this rename
        # and the unregistering.
        self.lock_and_retain_session_metadata()
        rc, final_head = captured("-C", archived, "rev-parse", "HEAD")
        if rc != 0:
            fail("could not read the archived session's final HEAD")
        self.session_recovery_ref = f"refs/ship-pr/session-recovery/{self.branch}/{final_head}"
        self.retain_direct_ref(
            self.session_recovery_ref,
            final_head,
            "session recovery ref",
            f"could not retain the archived session HEAD: {self.session_recovery_ref}",
        )
        self.retain_private_session_refs()
        self.refuse_session_module_gitdirs(archived, show(archived))
        self.refuse_active_session_operations(archived)
        if (
            git(
                "-C", main, "update-ref", "--no-deref", "-d", self.session_namespace_reservation, self.local_branch_oid
            ).rc
            != 0
        ):
            fail("could not release the session recovery namespace reservation")
        self.session_namespace_reservation_owned = False
        late_data = f"{self.late_session_archive}/data"
        if system.lexists(session) and system.atomic_rename(session, late_data) is not None:
            fail(f"late data appeared at {show(session)} and could not be moved aside safely")
        if git("-C", main, "worktree", "remove", "--force", "--force", session).rc != 0:
            if not system.lexists(session):
                fail("session data was archived, but its locked worktree registration could not be removed")
            if system.atomic_rename(session, late_data) is not None:
                fail("late data appeared during unregistering and could not be moved aside safely")
            if git("-C", main, "worktree", "remove", "--force", "--force", session).rc != 0:
                fail("session and late data were archived, but the locked registration could not be removed")
        self.session_worktree_lock_owned = False
        if not system.lexists(late_data):
            if not system.rmdir(self.late_session_archive):
                fail("unused late-data archive could not be removed")
            self.late_session_archive = ""
        self.private_namespace_blockers = []
        self.session_head_lock_owned = False
        self.session_head_lock = ""
        self.session_pseudoref_locks = []
        if not system.is_dir(archived):
            fail(f"session recovery archive disappeared: {show(archived)}")

    def finish(self, remote_branch_oid: str) -> int:
        main, branch, archived = self.main, self.branch, self.session_archived_worktree
        branch_ref = f"refs/heads/{branch}"
        if not self.delete_ref_with_locked_reflog(branch_ref, self.local_branch_oid, "topic-reflog"):
            fail(
                f"local {branch} changed before final deletion; it and origin/{branch} were "
                f"preserved; session archived at {show(archived)}"
            )
        if system.atomic_rename(self.config_lock, f"{self.main_common}/config") is not None:
            fail(
                f"local {branch} was deleted but its cleaned repository configuration could not be "
                f"installed; origin/{branch} was left in place"
            )
        self.config_lock_owned = False
        self.config_lock = ""
        if git("-C", main, "worktree", "remove", "--force", self.topic_reservation).rc != 0:
            fail(
                f"local {branch} was deleted but its temporary reservation could not be removed; "
                f"origin/{branch} was left in place"
            )
        self.topic_reservation = ""
        if self.late_session_archive:
            note(f"data appearing at the former session path was archived at {show(self.late_session_archive)}")

        # The local side is complete and read back; from here a refusal leaves only the public
        # branch, whose tip the recovery ref still holds locally.
        local_done = (
            f"local {branch} was deleted and its session archived at {show(archived)}; recovery "
            f"retained at {self.recovery_ref}"
        )
        if remote_branch_oid:
            if self.local_topic_reappeared():
                fail(
                    f"{local_done}; but local {branch} reappeared (at or over {self.current_topic_oid}) "
                    f"before the remote deletion, so origin/{branch} was left in place; once that local "
                    f"{branch} is resolved and gone, {self.finish_remote_deletion(remote_branch_oid)}"
                )
            pushed = git(
                "-C",
                main,
                "push",
                f"--force-with-lease={branch_ref}:{remote_branch_oid}",
                self.origin_push_url,
                f":{branch_ref}",
            )
            if pushed.rc != 0:
                done = git(
                    "-C", main, "ls-remote", "--exit-code", "--heads", self.origin_push_url, branch_ref, out="capture"
                )
                tip = system.first_token(substitution(done.out))
                # A push refused with the branch unmoved (a pre-push hook, a permission or
                # protected-branch rejection, a dropped connection) is not a race.
                if done.rc == 2:
                    note(f"origin/{branch} disappeared before its leased deletion (nothing left to delete)")
                elif done.rc == 0:
                    if tip == remote_branch_oid:
                        fail(
                            f"{local_done}; but the leased deletion of origin/{branch} was refused while "
                            f"it was still at the validated tip {remote_branch_oid} (git's own output "
                            "above names why), and it was left in place; once that cause is resolved, "
                            f"{self.finish_remote_deletion(remote_branch_oid)}"
                        )
                    fail(
                        f"{local_done}; but origin/{branch} moved to {tip} before its leased deletion, "
                        "and its newer tip was left in place; that tip was never validated, so only "
                        f"once it is confirmed integrated into origin/{self.base}, "
                        f"{self.finish_remote_deletion(tip)}"
                    )
                else:
                    fail(
                        f"{local_done}; but origin/{branch} could not be lease-deleted at "
                        f"{remote_branch_oid} and was left in place; "
                        f"{self.finish_remote_deletion(remote_branch_oid)}"
                    )
        else:
            note(f"origin/{branch} was already absent (no deletion sent)")

        # The same read after the deletion, for a base that moved while it ran.
        problem = self.remote_base_still_integrates()
        if problem:
            if not self.restore_remote_topic(self.local_branch_oid):
                fail(f"{local_done}; but {problem} after topic deletion, and the topic could not be restored")
            fail(f"{local_done}; but {problem} after topic deletion; origin/{branch} was restored")

        # The last read, after every network call: a local topic recreated while the remote steps
        # ran would otherwise outlive its public branch. Publish it again, as it now is.
        if remote_branch_oid and self.local_topic_reappeared():
            if not self.restore_remote_topic(self.current_topic_oid):
                fail(
                    f"{local_done}; but local {branch} reappeared (publishing {self.current_topic_oid}) "
                    f"during the remote deletion, and origin/{branch} could not be restored"
                )
            fail(
                f"{local_done}; but local {branch} reappeared (publishing {self.current_topic_oid}) "
                f"during the remote deletion; origin/{branch} was restored at that tip"
            )

        cli.say(
            f"{PROG}: cleaned {branch} and unregistered {show(self.session_original)}; session "
            f"archived at {show(archived)}; recovery retained at {self.recovery_ref} and "
            f"{self.session_recovery_ref}"
        )
        return 0


def quiet_err_ok(*args: str) -> int:
    """``git args 2>/dev/null``, stdout left alone."""
    return git(*args, err="devnull").rc


def temp_directory() -> str:
    """``${TMPDIR:-/tmp}``; a native Windows interpreter has no ``/tmp``, and takes the one the
    platform names."""
    # Under Git Bash the forwarder hands TMPDIR over in its own variable: MSYS rewrites TMPDIR
    # itself for a native program, and a relative one arrived rooted.
    value = os.environ.pop(CALLER_TMPDIR, "") or os.environ.get("TMPDIR", "")
    if value:
        return value
    if os.name == "nt":
        return tempfile.gettempdir()
    return "/tmp"
