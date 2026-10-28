"""ludics v2: the core scripts, ported to type-checked, standard-library-only Python 3.12.

One package, run through ``scripts/py`` (which picks an interpreter >= 3.12 and puts ``lib/`` on
the path). Each ported script keeps its shell entry point, which forwards to a module here with
the same arguments; see ``lib/ludics/README.md`` for the layout and the porting rules
(ludics-lite#403).
"""
