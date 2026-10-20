#!/usr/bin/env bash
# The second planner of paired planning (issue-wave/references/paired-planning.md):
#
#   peer-plan.sh start <dir> --issue <owner/repo>#<n> --checkout <path> --base <ref> [--model <m>] [--effort <e>]
#   peer-plan.sh critique <dir> --plan <file>
#   peer-plan.sh clean <dir>
#
# Written in Python from the start (ludics-lite#403, #547): this file forwards its whole command
# line to lib/ludics/peerplan through scripts/py, and the module's docstring is the contract.

set -uo pipefail

# One brace group, parsed whole before its first command runs (scripts/check-parse-guards.sh).
{
# Physically, BEFORE going up: the skills call this file through a symlinked skill directory.
py="$(CDPATH= cd -P "$(dirname "$0")" && cd -P ../.. && pwd -P)/scripts/py"
if [ ! -x "$py" ]; then
  printf '%s\n' "peer-plan.sh: the helper is served by Python, and its runner $py is missing or not executable: this copy is not inside a ludics-lite checkout" >&2
  exit 1
fi
exec "$py" -m ludics.peerplan "$@"
exit "$?"
}
