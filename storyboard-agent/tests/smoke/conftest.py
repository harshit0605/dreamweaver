"""
M9.5 L5 — live-LLM smoke harness.

Strategy: skip the smoke suite by default (so PR CI stays free) and
opt in via `pytest -m llm`. When the marker is active, we additionally
require:

  * `OPENAI_API_KEY` (or the relevant provider key) — without it,
    every LLM call would 401 and we'd burn time on noise.
  * `STORYBOARD_LLM_TEST_BUDGET_USD` — soft budget; the harness
    tracks token usage via the `Cost` callback and skips remaining
    tests in the suite once the budget is exhausted. Default is
    $2.00 which is conservative for nightly canary runs over
    `gpt-4.1-mini`.

The smoke tests assert on **structural keys only** — "did the agent
emit a `request_hook_variants` interrupt with at least 1 variant?"
rather than "is the rationale exactly XYZ". This avoids brittle
assertions on LLM phrasing that flip on every model nudge.

What the smoke catches that mocked tests don't:
  * Prompt drift — a subagent system prompt no longer routes to its
    tool because the LLM lost the cue word.
  * Vocabulary drift — the LLM invents a `vortex_warp` transition
    intent and our normalizer drops it; producers see fewer real
    proposals.
  * Tool-call shape drift — a typed argument the LLM is meant to
    fill (e.g. `targetStructure`) starts coming back malformed.

What it doesn't catch (still mocked):
  * Convex contracts (deferred to M9.6 convex-test).
  * Frontend reactivity (covered by L6 Playwright).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pytest


def pytest_collection_modifyitems(config, items):
    """Auto-mark every test in this directory with the `llm` marker
    so a directory-scoped invocation (`pytest tests/smoke/`) shares
    the same gating + budget guardrail as `-m llm`.

    Without this hook, a developer who runs `pytest tests/smoke/`
    directly would have the smoke suite execute even when the API
    key is missing — and we'd burn time on 401s.
    """
    for item in items:
        if "tests/smoke/" in str(item.fspath):
            item.add_marker(pytest.mark.llm)


# ---------------------------------------------------------------------------
# Skip-guards: OPENAI_API_KEY + budget guardrail
# ---------------------------------------------------------------------------


def _require_api_key() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        pytest.skip(
            "OPENAI_API_KEY is unset — live-LLM smoke needs a real key. "
            "Set it before running `pytest -m llm`.",
            allow_module_level=False,
        )


def _budget_usd() -> float:
    raw = os.getenv("STORYBOARD_LLM_TEST_BUDGET_USD", "2.00")
    try:
        return float(raw)
    except ValueError:
        return 2.00


@dataclass
class _BudgetTracker:
    """
    Cross-test token usage tracker. The smoke fixtures wrap LLM calls
    and accumulate token totals into this; if the running total
    exceeds the configured budget, subsequent tests skip with a
    clear message so the cron job doesn't burn through a credit
    cap silently.

    Pricing is approximated for `gpt-4.1-mini` (the default model);
    smoke tests that swap to another model should pass an explicit
    cost-per-token via the per-test setup.
    """

    budget_usd: float
    total_usd: float = 0.0
    calls: int = 0
    # gpt-4.1-mini per-token estimates as of 2026-04 pricing. Tweak
    # the numbers when the public pricing page changes — these are
    # ballpark guards, not invoicing.
    input_per_1m_usd: float = 0.40
    output_per_1m_usd: float = 1.60
    history: List[Dict[str, Any]] = field(default_factory=list)

    def add(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        label: str = "",
    ) -> None:
        usd = (
            prompt_tokens * self.input_per_1m_usd
            + completion_tokens * self.output_per_1m_usd
        ) / 1_000_000
        self.total_usd += usd
        self.calls += 1
        self.history.append(
            {
                "label": label,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "usd": usd,
                "elapsed": time.time(),
            }
        )

    def remaining_usd(self) -> float:
        return max(0.0, self.budget_usd - self.total_usd)

    def is_exhausted(self) -> bool:
        return self.total_usd >= self.budget_usd


@pytest.fixture(scope="session")
def llm_budget() -> _BudgetTracker:
    """Session-scoped budget so all smoke tests share one ledger."""
    return _BudgetTracker(budget_usd=_budget_usd())


@pytest.fixture(autouse=True)
def _skip_if_budget_exhausted(llm_budget: _BudgetTracker) -> None:
    if llm_budget.is_exhausted():
        pytest.skip(
            f"Live-LLM budget ${llm_budget.budget_usd:.2f} exhausted "
            f"after {llm_budget.calls} calls; remaining tests skipped. "
            f"Bump STORYBOARD_LLM_TEST_BUDGET_USD or split into smaller "
            f"nightly runs."
        )


@pytest.fixture(autouse=True)
def _require_key_on_smoke_tests(request: pytest.FixtureRequest) -> None:
    """Skip cleanly when the API key is missing rather than letting
    the LLM call itself 401 mid-test."""
    if request.node.get_closest_marker("llm") is not None:
        _require_api_key()


# ---------------------------------------------------------------------------
# LLM client + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def llm_client(llm_budget: _BudgetTracker):
    """A minimal langchain ChatModel wired to the configured smoke
    model. Wraps every invocation so prompt + completion tokens
    accumulate into the session budget tracker.

    We intentionally use `init_chat_model` with the same default the
    factory uses (`openai:gpt-4.1-mini`) so smoke results reflect
    production routing as closely as possible.
    """
    from langchain.chat_models import init_chat_model

    model_name = os.getenv(
        "STORYBOARD_AGENT_SMOKE_MODEL",
        os.getenv("STORYBOARD_AGENT_MODEL", "openai:gpt-4.1-mini"),
    )
    base = init_chat_model(model_name, temperature=0)

    class TrackedModel:
        """Wraps the raw model so callers can `.invoke(messages,
        tools=[...])` and the budget tracker observes usage_metadata
        on the returned AIMessage."""

        def __init__(self, base: Any, label_prefix: str) -> None:
            self._base = base
            self._label_prefix = label_prefix

        def with_tools(self, tools: List[Any]) -> "TrackedModel":
            bound = self._base.bind_tools(tools)
            tracked = TrackedModel(bound, self._label_prefix)
            return tracked

        def invoke(self, messages: List[Any], label: str = "") -> Any:
            response = self._base.invoke(messages)
            usage = getattr(response, "usage_metadata", None) or {}
            llm_budget.add(
                prompt_tokens=int(usage.get("input_tokens", 0)),
                completion_tokens=int(usage.get("output_tokens", 0)),
                label=f"{self._label_prefix}:{label}",
            )
            return response

    return TrackedModel(base, label_prefix=model_name)


# ---------------------------------------------------------------------------
# Retry harness — LLM tool calls are noisy. Reasonable defaults keep
# false-positives out of nightly cron alerts.
# ---------------------------------------------------------------------------


def with_retry(fn, attempts: int = 3, label: str = "") -> Any:
    """Run `fn` up to `attempts` times with exponential backoff.
    Returns the first successful result; re-raises the last
    exception if all attempts fail. Used inside smoke tests around
    `llm.invoke(...)` calls that occasionally produce malformed
    tool calls."""
    last_exc: Optional[BaseException] = None
    for attempt in range(attempts):
        try:
            return fn()
        except AssertionError:
            # Don't retry assertion errors — they're real test failures
            # that would just keep failing. Only retry LLM-shape
            # surprises (ValidationError, KeyError, etc.).
            raise
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt + 1 == attempts:
                break
            time.sleep(0.5 * (2**attempt))
    raise RuntimeError(
        f"Live-LLM smoke {label!r} failed after {attempts} attempts: {last_exc}"
    ) from last_exc
