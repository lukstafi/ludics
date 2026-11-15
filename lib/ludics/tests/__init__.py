"""The package's unit tests: ``scripts/py -m unittest discover -s lib -t lib -p 'test_*.py'``.

The suite owns its state: on import, discard only the inherited ``LUDICS_PR_BUDGET_DIR`` shell
forward. It would outrank each fixture's ``SHIP_PR_STATE_DIR`` under an actual merge build and
mix their histories. Cases probing the forward set it themselves; other environment is untouched.

Importing this package arms a watchdog: once ``LUDICS_TEST_WATCHDOG`` seconds (default 600) have
passed, faulthandler prints every thread's stack to stderr and exits the process with status 1.
It is one timer for the whole process, not one per test. The unsharded suite took 373 s
in CI run 43549924107 (2026-11-14). CI now runs module shards, with their own measured
watchdog set in skill-scripts.yml. ``0`` disables it. The default still covers local full
suite discovery; CI overrides it to leave setup and stack-dump room inside each job cap.

Why: while writing the tests for ludics-lite#736, two in-process flock deadlocks (a
``take_slot`` slot lock leaked onto a descriptor nothing could reach any more; the registry's
``waiters/.lock``, held until the process exits) each hung the suite silently until an outer cap,
with no trace of where. macOS has no timeout(1) to wrap the run in, and a hang in CI ran to the
job's cap. A hang now fails with the blocked stack instead.
"""

import faulthandler
import os

# Keep this common initializer independent of the application runtime: the prompt fixtures
# also import it on native Windows.
os.environ.pop("LUDICS_PR_BUDGET_DIR", None)

_WATCHDOG_SECONDS = float(os.environ.get("LUDICS_TEST_WATCHDOG", "600"))
if _WATCHDOG_SECONDS > 0:
    faulthandler.dump_traceback_later(_WATCHDOG_SECONDS, exit=True)
