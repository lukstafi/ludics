"""``scripts/py -m ludics.peerplan <verb> ...``: what ``issue-wave/scripts/peer-plan.sh`` runs."""

import sys

from ludics import cli
from ludics.peerplan.plan import PROG, run


def main() -> int:
    return cli.main(PROG, run)


if __name__ == "__main__":
    sys.exit(main())
