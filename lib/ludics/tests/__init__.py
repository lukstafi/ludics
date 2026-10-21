"""The package's unit tests: ``scripts/py -m unittest discover -s lib -t lib -p 'test_*.py'``.

Importing this package arms a watchdog: once ``LUDICS_TEST_WATCHDOG`` seconds (default 600) have
passed, faulthandler prints every thread's stack to stderr and exits the process with status 1.
It is one timer for the whole process, not one per test, so it bounds the run: the full suite
takes about 105 s on mac-studio and 100 s on the CI runner. ``0`` disables it. CI sets a lower
bound, because its job cap is shorter than the default and a job killed at the cap prints nothing.

Why: while writing the tests for ludics-lite#736, two in-process flock deadlocks (a
``take_slot`` slot lock leaked onto a descriptor nothing could reach any more; the registry's
``waiters/.lock``, held until the process exits) each hung the suite silently until an outer cap,
with no trace of where. macOS has no timeout(1) to wrap the run in, and a hang in CI ran to the
job's cap. A hang now fails with the blocked stack instead.
"""

import faulthandler
import os

_WATCHDOG_SECONDS = float(os.environ.get("LUDICS_TEST_WATCHDOG", "600"))
if _WATCHDOG_SECONDS > 0:
    faulthandler.dump_traceback_later(_WATCHDOG_SECONDS, exit=True)
