"""peer-plan.sh in Python (ludics-lite#547): ``scripts/py -m ludics.peerplan``.

The second planner of issue-wave's paired planning: a read-only Codex run that plans an issue
while the Claude worker plans it independently, and, for a D3, a resumed turn of the same Codex
session that critiques the worker's plan. ``plan`` is the whole of it.
"""
