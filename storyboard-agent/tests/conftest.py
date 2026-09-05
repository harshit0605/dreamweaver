"""
M9.5 — pytest-wide fixtures shared across L2/L4 tests.

Most existing tests are pure-function unittests that don't need
fixtures, so this file is intentionally lean. The fixtures here are:

  * `subagent_registry` — caches `get_subagents()` so the 16 routing
    tests don't each rebuild the list from scratch.
  * `subagent_by_name` — convenience accessor used in routing tests.
  * `tool_names_for` — extracts `tool.name` strings from a subagent
    definition's tool list, since the registry stores LangChain Tool
    objects (not names).
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Set

import pytest

from deep.subagents import get_subagents


@pytest.fixture
def subagent_registry() -> List[Dict[str, Any]]:
    """The full canonical M9.5 roster.

    Uses `tool_allowlist=["*"]` so `team_architect` materializes —
    the default empty allowlist applies DEFAULT_RUNTIME_ALLOWLIST,
    which excludes `team.manage`, which strips every team_architect
    tool, which removes team_architect entirely. Filtering tests
    exercise that other path explicitly via FilteringTests.
    """
    return get_subagents(tool_allowlist=["*"])


@pytest.fixture
def subagent_by_name(
    subagent_registry: List[Dict[str, Any]],
) -> Callable[[str], Dict[str, Any]]:
    """Returns a lookup callable that throws a clear error if the
    subagent is missing — keeps test failures readable when a rename
    drifts."""

    def _lookup(name: str) -> Dict[str, Any]:
        for entry in subagent_registry:
            if entry.get("name") == name:
                return entry
        raise AssertionError(
            f"Subagent '{name}' not in registry. "
            f"Got: {[e['name'] for e in subagent_registry]}"
        )

    return _lookup


@pytest.fixture
def tool_names_for() -> Callable[[Dict[str, Any]], Set[str]]:
    """Extract the set of tool names from a subagent definition."""

    def _extract(definition: Dict[str, Any]) -> Set[str]:
        return {
            getattr(tool, "name", "") for tool in definition.get("tools", [])
        }

    return _extract


@pytest.fixture
def filtered_registry() -> Callable[
    [Optional[Set[str]], Optional[List[str]]], List[Dict[str, Any]]
]:
    """Convenience wrapper around `get_subagents(...)` for filter
    + allowlist tests."""

    def _filtered(
        enabled_member_names: Optional[Set[str]] = None,
        tool_allowlist: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        return get_subagents(
            enabled_member_names=enabled_member_names,
            tool_allowlist=tool_allowlist,
        )

    return _filtered
