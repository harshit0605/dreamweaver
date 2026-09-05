"""
M9.5 L2 — subagent registry / routing contract tests.

The 16 subagent definitions in `deep/subagents.py` are the contract
that drives every producer/director/creator flow. This file pins:

  * **Composition**: the canonical roster has the expected 16 names.
  * **Tool subsets**: each subagent's tool list matches its
    architectural responsibility (e.g. `motif_tracker` has
    `request_motif_plant` but NOT `request_hook_variants`).
  * **System-prompt key phrases**: each subagent's prompt mentions the
    domain idioms its routing depends on (e.g. `transition_maestro`
    must mention "Rule of Six"; `motif_tracker` must mention
    `landedStatus`). These are smoke checks for prompt regressions
    that would otherwise only surface in L5 live-LLM smoke.
  * **Filtering**: `enabled_member_names` correctly subsets;
    `tool_allowlist` correctly strips disallowed tools.
  * **HITL coverage**: every interrupt-target tool is reachable via
    at least one subagent (or the supervisor core).

This is REGISTRY contract testing — no LangGraph instantiation, no
LLM, no network. Live-LLM routing fidelity is L5 (`tests/smoke/`).
"""

from __future__ import annotations

import unittest
from typing import Any, Callable, Dict, List, Optional, Set

import pytest

from deep.factory import _interrupt_config
from deep.subagents import get_subagents
from deep.tools import (
    ALL_TOOLS,
    SUPERVISOR_CORE_TOOLS,
    TOOL_POLICY_TOKENS,
)


# ---------------------------------------------------------------------------
# Canonical roster expected as of M9.5
# ---------------------------------------------------------------------------

EXPECTED_SUBAGENTS = {
    "planner",
    "continuity_critic",
    "dailies_producer",
    "visual_director",
    "producer_guard",
    "team_architect",
    "ingestion_coordinator",
    # M9 narrative refinement (Phase 2)
    "narrative_architect",
    "beat_analyst",
    "tension_analyst",
    # M9 Phase 3 — variant generation
    "hook_designer",
    "structural_variant_generator",
    # M9 Phase 4 — transitions + motifs
    "transition_maestro",
    "motif_tracker",
    # Critic + repair
    "dailies_critic",
    "repair_agent",
}


# Per-subagent expected tool subsets. These mirror the architectural
# decisions in the M9 plan: read-only analyzers don't get HITL tools,
# HITL fires live on the supervisor + their owning subagent only,
# never spread across unrelated specialists.
EXPECTED_TOOL_SUBSETS: Dict[str, Set[str]] = {
    "planner": {
        "planner_propose_graph_patch",
        "planner_propose_media_prompt",
        "simulate_execution_plan",
        "generate_team_from_prompt",
    },
    "continuity_critic": {"continuity_critic"},
    "dailies_producer": {"build_autonomous_dailies_batch", "producer_guard"},
    "visual_director": {"planner_propose_media_prompt"},
    "producer_guard": {"producer_guard"},
    "team_architect": {
        "select_agent_team",
        "create_agent_team",
        "update_agent_team_member",
        "publish_agent_team_revision",
        "generate_team_from_prompt",
    },
    "narrative_architect": {
        "sample_tension_curve",
        "detect_beat_plan",
        "detect_beat_gaps",
        "request_beat_assignment",
    },
    "beat_analyst": {
        "detect_beat_plan",
        "detect_beat_gaps",
        "request_beat_assignment",
    },
    "tension_analyst": {"sample_tension_curve"},
    "hook_designer": {
        "sample_tension_curve",
        "detect_beat_plan",
        "request_hook_variants",
    },
    "structural_variant_generator": {
        "detect_beat_plan",
        "detect_beat_gaps",
        "sample_tension_curve",
        "request_structural_remix",
    },
    "transition_maestro": {
        "sample_tension_curve",
        "request_transition_proposal",
    },
    "motif_tracker": {
        "detect_motif_gaps",
        "request_motif_plant",
    },
    "repair_agent": {"repair_plan"},
}


# ---------------------------------------------------------------------------
# Composition tests
# ---------------------------------------------------------------------------


def _full_registry() -> List[Dict[str, Any]]:
    """The canonical 16-subagent roster.

    `get_subagents()` with the default empty allowlist applies
    `DEFAULT_RUNTIME_ALLOWLIST`, which excludes `team.manage`, which
    strips every team_architect tool and drops team_architect from
    the result. Routing-contract tests want the FULL roster, so we
    pass `["*"]`. The team-policy filtering path is exercised
    separately in FilteringTests.
    """
    return get_subagents(tool_allowlist=["*"])


class CanonicalRosterTests(unittest.TestCase):
    def test_full_registry_has_expected_16_subagents(self) -> None:
        registry = _full_registry()
        names = {entry["name"] for entry in registry}
        self.assertEqual(
            names,
            EXPECTED_SUBAGENTS,
            f"Roster drifted: extra={names - EXPECTED_SUBAGENTS}, "
            f"missing={EXPECTED_SUBAGENTS - names}",
        )

    def test_no_subagent_name_is_blank_or_duplicated(self) -> None:
        registry = _full_registry()
        names = [entry["name"] for entry in registry]
        for name in names:
            self.assertTrue(
                name and name.strip(), f"Empty subagent name: {names}"
            )
        self.assertEqual(
            len(names), len(set(names)), f"Duplicate subagent names: {names}"
        )

    def test_every_subagent_has_a_non_empty_system_prompt(self) -> None:
        for entry in _full_registry():
            prompt = entry.get("system_prompt", "")
            self.assertTrue(
                isinstance(prompt, str) and len(prompt) > 50,
                f"{entry['name']} system_prompt looks empty/stub: {prompt!r}",
            )

    def test_every_subagent_has_at_least_one_tool(self) -> None:
        for entry in _full_registry():
            tools = entry.get("tools", [])
            self.assertGreater(
                len(tools),
                0,
                f"{entry['name']} has no tools — would be unreachable",
            )


# ---------------------------------------------------------------------------
# Per-subagent tool subset tests (one per subagent, parametrized via
# unittest's manual loop because we want individually-named failures).
# ---------------------------------------------------------------------------


class ToolSubsetTests(unittest.TestCase):
    def _tool_names(self, name: str) -> Set[str]:
        registry = _full_registry()
        for entry in registry:
            if entry["name"] == name:
                return {getattr(t, "name", "") for t in entry.get("tools", [])}
        self.fail(f"Subagent '{name}' missing from registry")

    def test_planner_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("planner"), EXPECTED_TOOL_SUBSETS["planner"]
        )

    def test_continuity_critic_is_single_purpose(self) -> None:
        # Single-tool subagents are critical to verify: drift here
        # often means someone bolted on extra responsibility.
        self.assertEqual(
            self._tool_names("continuity_critic"),
            EXPECTED_TOOL_SUBSETS["continuity_critic"],
        )

    def test_dailies_producer_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("dailies_producer"),
            EXPECTED_TOOL_SUBSETS["dailies_producer"],
        )

    def test_visual_director_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("visual_director"),
            EXPECTED_TOOL_SUBSETS["visual_director"],
        )

    def test_producer_guard_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("producer_guard"),
            EXPECTED_TOOL_SUBSETS["producer_guard"],
        )

    def test_team_architect_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("team_architect"),
            EXPECTED_TOOL_SUBSETS["team_architect"],
        )

    def test_ingestion_coordinator_owns_every_request_batch_tool(self) -> None:
        # The ingestion_coordinator is the ONLY subagent that should
        # own the `request_generate_*_batch` family — those tools
        # must not bleed into narrative subagents (which would
        # let beat_analyst trigger a video render, which is a
        # severance-of-concerns bug).
        names = self._tool_names("ingestion_coordinator")
        for batch_tool in (
            "recommend_ingestion_path",
            "request_ingestion_run",
            "request_generate_shot_batch",
            "request_generate_shot_video_batch",
            "request_generate_shot_audio_batch",
            "request_generate_shot_sfx_batch",
            "request_generate_score",
            "request_export_reel",
            "request_assign_voice_cast",
        ):
            self.assertIn(
                batch_tool,
                names,
                f"ingestion_coordinator missing {batch_tool}",
            )

    def test_narrative_architect_is_orchestrator_not_specialist(self) -> None:
        self.assertEqual(
            self._tool_names("narrative_architect"),
            EXPECTED_TOOL_SUBSETS["narrative_architect"],
        )

    def test_beat_analyst_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("beat_analyst"),
            EXPECTED_TOOL_SUBSETS["beat_analyst"],
        )

    def test_tension_analyst_is_read_only(self) -> None:
        # tension_analyst is intentionally read-only — it surfaces
        # findings, never mutates. If a HITL tool ever lands here it's
        # a serious architectural drift.
        names = self._tool_names("tension_analyst")
        self.assertEqual(names, EXPECTED_TOOL_SUBSETS["tension_analyst"])
        for hitl_tool_name in (
            "request_beat_assignment",
            "request_hook_variants",
            "request_motif_plant",
            "request_transition_proposal",
        ):
            self.assertNotIn(
                hitl_tool_name,
                names,
                f"tension_analyst is read-only — {hitl_tool_name} leaked in",
            )

    def test_hook_designer_owns_only_hook_variants(self) -> None:
        names = self._tool_names("hook_designer")
        self.assertEqual(names, EXPECTED_TOOL_SUBSETS["hook_designer"])
        # Cross-pollination check: hook_designer must NOT own
        # structural remix or transitions.
        self.assertNotIn("request_structural_remix", names)
        self.assertNotIn("request_transition_proposal", names)

    def test_structural_variant_generator_tool_subset(self) -> None:
        self.assertEqual(
            self._tool_names("structural_variant_generator"),
            EXPECTED_TOOL_SUBSETS["structural_variant_generator"],
        )

    def test_transition_maestro_owns_only_transitions(self) -> None:
        names = self._tool_names("transition_maestro")
        self.assertEqual(names, EXPECTED_TOOL_SUBSETS["transition_maestro"])
        self.assertNotIn("request_motif_plant", names)

    def test_motif_tracker_owns_only_motifs(self) -> None:
        names = self._tool_names("motif_tracker")
        self.assertEqual(names, EXPECTED_TOOL_SUBSETS["motif_tracker"])
        self.assertNotIn("request_transition_proposal", names)

    def test_dailies_critic_includes_motif_check(self) -> None:
        # M9 Phase 4 added detect_motif_gaps to dailies_critic so it
        # surfaces UNLANDED_MOTIF + ORPHANED_PAYOFF violations alongside
        # pacing/continuity findings. Pin that here.
        registry = _full_registry()
        names = {
            getattr(t, "name", "")
            for entry in registry
            if entry["name"] == "dailies_critic"
            for t in entry.get("tools", [])
        }
        for required in (
            "simulate_story_playthrough",
            "continuity_critic",
            "repair_plan",
            "preview_simulation_critic_plan",
            "request_dailies_critic_review",
            "detect_motif_gaps",
        ):
            self.assertIn(required, names, f"dailies_critic missing {required}")

    def test_repair_agent_is_minimal(self) -> None:
        self.assertEqual(
            self._tool_names("repair_agent"),
            EXPECTED_TOOL_SUBSETS["repair_agent"],
        )


# ---------------------------------------------------------------------------
# System-prompt key-phrase tests
# ---------------------------------------------------------------------------


class SystemPromptKeyPhraseTests(unittest.TestCase):
    """
    Smoke tests for prompts. Each subagent's system prompt must mention
    the domain idioms its routing depends on. If a producer's "give me
    a transition" message stops landing on `transition_maestro`, it's
    almost always because the prompt drifted off "Rule of Six" — the
    LLM no longer knows this is the cut-idiom specialist.
    """

    def _prompt(self, name: str) -> str:
        for entry in _full_registry():
            if entry["name"] == name:
                return entry["system_prompt"]
        self.fail(f"Subagent '{name}' missing")

    def test_transition_maestro_mentions_rule_of_six(self) -> None:
        self.assertIn("Rule of Six", self._prompt("transition_maestro"))

    def test_transition_maestro_lists_cut_vocabulary(self) -> None:
        prompt = self._prompt("transition_maestro")
        # Each cut idiom must be name-checked so the LLM picks from
        # the fixed vocabulary instead of inventing intents.
        for intent in ("match_cut", "j_cut", "l_cut", "cross_cut_accelerate"):
            self.assertIn(intent, prompt, f"missing intent '{intent}'")

    def test_motif_tracker_mentions_landed_status(self) -> None:
        prompt = self._prompt("motif_tracker")
        self.assertIn("landedStatus", prompt)
        # Must mention all four landed-status buckets so the LLM
        # routes correctly between plant + payoff + orphan + unplanted.
        for bucket in ("planted", "orphaned", "unplanted", "landed"):
            self.assertIn(bucket, prompt)

    def test_motif_tracker_mentions_visual_vocabulary_collaboration(self) -> None:
        prompt = self._prompt("motif_tracker")
        self.assertIn("visualVocabulary", prompt)
        # Cross-references the visual_director pickup path; the prompt
        # tells the LLM that visual_director will read this field.
        self.assertIn("visual_director", prompt)

    def test_hook_designer_mentions_three_archetypes(self) -> None:
        prompt = self._prompt("hook_designer")
        for archetype in ("question", "stakes", "visual-rhyme", "match-cut"):
            self.assertIn(
                archetype.lower(),
                prompt.lower(),
                f"hook_designer prompt missing archetype '{archetype}'",
            )

    def test_hook_designer_mentions_short_form_threshold(self) -> None:
        # The 90-second threshold separating short-form from long-form
        # is the routing cue for hook_designer vs. structural_variant_
        # generator.
        prompt = self._prompt("hook_designer")
        self.assertIn("90s", prompt)

    def test_structural_variant_generator_mentions_strategies(self) -> None:
        prompt = self._prompt("structural_variant_generator")
        for strategy in ("in-medias-res", "chrono-reorder", "parallel-intercut"):
            self.assertIn(strategy.lower(), prompt.lower())

    def test_structural_variant_generator_warns_about_isPrimary_invariant(
        self,
    ) -> None:
        # Risk #4 from the M9 plan: the LLM never invents edge-level
        # `order` / `isPrimary` — those are deterministic recomputations
        # server-side. The prompt must explicitly warn.
        prompt = self._prompt("structural_variant_generator")
        self.assertIn("isPrimary", prompt)

    def test_beat_analyst_mentions_override_rule(self) -> None:
        prompt = self._prompt("beat_analyst")
        # Reconciliation invariant: never silently overwrite a slot
        # the producer already assigned.
        self.assertIn("status=assigned", prompt.lower().replace(" ", ""))

    def test_tension_analyst_is_explicitly_read_only_in_prompt(self) -> None:
        prompt = self._prompt("tension_analyst")
        self.assertIn("READ-ONLY", prompt.upper())

    def test_visual_director_mentions_motif_awareness(self) -> None:
        # M9 Phase 4 wired motif visualVocabulary into visual_director's
        # prompt so payoff shots echo the planted setup's language.
        prompt = self._prompt("visual_director")
        self.assertIn("visualVocabulary", prompt)

    def test_dailies_critic_mentions_unlanded_and_orphaned_codes(self) -> None:
        # M9 Phase 4 added motif violation codes to dailies_critic.
        prompt = self._prompt("dailies_critic")
        self.assertIn("UNLANDED_MOTIF", prompt)
        self.assertIn("ORPHANED_PAYOFF", prompt)

    def test_narrative_architect_does_not_mutate_directly(self) -> None:
        prompt = self._prompt("narrative_architect")
        # Architectural invariant: the orchestrator routes, never
        # mutates. The prompt must be explicit about that.
        self.assertIn("never mutate", prompt.lower())


# ---------------------------------------------------------------------------
# Filtering: enabled_member_names + tool_allowlist
# ---------------------------------------------------------------------------


class FilteringTests(unittest.TestCase):
    def test_enabled_member_names_subsets_registry(self) -> None:
        filtered = get_subagents(
            enabled_member_names={"planner", "continuity_critic"},
        )
        names = {entry["name"] for entry in filtered}
        self.assertEqual(names, {"planner", "continuity_critic"})

    def test_enabled_member_names_normalizes_whitespace_and_case(self) -> None:
        # `get_subagents` lowercases + strips each filter name so
        # producers with funky team configs don't silently lose
        # subagents.
        filtered = get_subagents(
            enabled_member_names={"  PLANNER  ", "Continuity_Critic"},
        )
        names = {entry["name"] for entry in filtered}
        self.assertEqual(names, {"planner", "continuity_critic"})

    def test_unknown_enabled_member_name_falls_back_to_producer_guard(self) -> None:
        # When the filter doesn't match anything real, the registry
        # returns the fallback `producer_guard` so orchestration keeps
        # working under strict policies. Verifying that fallback path.
        filtered = get_subagents(
            enabled_member_names={"made_up_subagent"},
        )
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["name"], "producer_guard")

    def test_empty_allowlist_uses_default(self) -> None:
        # Empty allowlist → applies DEFAULT_RUNTIME_ALLOWLIST → all
        # narrative + ingestion + critic subagents survive; only
        # team_architect (which needs team.manage) gets stripped down
        # to subagents with non-team tools.
        filtered = get_subagents(tool_allowlist=[])
        names = {entry["name"] for entry in filtered}
        # team_architect's tools are all team.manage; with default
        # allowlist (which excludes team.manage) it gets entirely
        # stripped → drops out of the registry.
        self.assertNotIn("team_architect", names)
        # narrative + ingestion subagents must still be present.
        self.assertIn("narrative_architect", names)
        self.assertIn("ingestion_coordinator", names)

    def test_wildcard_allowlist_keeps_team_architect(self) -> None:
        filtered = get_subagents(tool_allowlist=["*"])
        names = {entry["name"] for entry in filtered}
        self.assertIn("team_architect", names)

    def test_allowlist_strips_disallowed_tools_but_keeps_subagent(self) -> None:
        # If only `narrative.analyze` is allowed, beat_analyst keeps
        # detect_beat_plan + detect_beat_gaps but loses
        # request_beat_assignment (which needs `narrative.beats`).
        filtered = get_subagents(tool_allowlist=["narrative.analyze"])
        beat_analyst = next(
            (e for e in filtered if e["name"] == "beat_analyst"), None
        )
        self.assertIsNotNone(beat_analyst, "beat_analyst should survive")
        names = {getattr(t, "name", "") for t in beat_analyst["tools"]}
        self.assertIn("detect_beat_plan", names)
        self.assertIn("detect_beat_gaps", names)
        self.assertNotIn("request_beat_assignment", names)


# ---------------------------------------------------------------------------
# Cross-cutting: HITL coverage
# ---------------------------------------------------------------------------


class HITLCoverageTests(unittest.TestCase):
    """
    Every HITL tool registered in `_interrupt_config()` must be
    reachable from at least one place — either the supervisor core or
    a subagent. If a HITL tool falls off both surfaces, the agent
    can never trigger producer approval through it.
    """

    def test_every_interrupt_tool_is_reachable(self) -> None:
        interrupt_names = set(_interrupt_config().keys())
        supervisor_names = {
            getattr(t, "name", "") for t in SUPERVISOR_CORE_TOOLS
        }
        subagent_names: Set[str] = set()
        for entry in _full_registry():
            for tool in entry.get("tools", []):
                subagent_names.add(getattr(tool, "name", ""))
        reachable = supervisor_names | subagent_names
        unreachable = interrupt_names - reachable
        self.assertFalse(
            unreachable,
            f"HITL tools registered for interrupt but unreachable: "
            f"{unreachable}",
        )

    def test_every_interrupt_tool_has_a_policy_token(self) -> None:
        # Without a policy token, the tool is silently dropped by
        # filter_tools_by_allowlist — it would never reach a runtime
        # under any allowlist.
        for name in _interrupt_config().keys():
            self.assertIn(
                name,
                TOOL_POLICY_TOKENS,
                f"Interrupt tool '{name}' has no policy token; "
                f"filter_tools_by_allowlist will drop it.",
            )

    def test_every_request_tool_lives_on_supervisor_core(self) -> None:
        # All `request_*` HITL tools should be reachable from the
        # supervisor directly so the orchestrator can fire approvals
        # without an unnecessary subagent delegation hop.
        supervisor_names = {
            getattr(t, "name", "") for t in SUPERVISOR_CORE_TOOLS
        }
        request_tools = [
            name
            for name in _interrupt_config().keys()
            if name.startswith("request_")
        ]
        for name in request_tools:
            self.assertIn(
                name,
                supervisor_names,
                f"{name} should be on SUPERVISOR_CORE_TOOLS so the "
                f"orchestrator can fire approvals without delegating.",
            )


# ---------------------------------------------------------------------------
# Sanity: tool registry coherence
# ---------------------------------------------------------------------------


class ToolRegistryCoherenceTests(unittest.TestCase):
    def test_every_subagent_tool_is_in_all_tools(self) -> None:
        all_tool_names = {getattr(t, "name", "") for t in ALL_TOOLS}
        for entry in _full_registry():
            for tool in entry.get("tools", []):
                tool_name = getattr(tool, "name", "")
                self.assertIn(
                    tool_name,
                    all_tool_names,
                    f"Subagent {entry['name']} references {tool_name} "
                    f"but it's missing from ALL_TOOLS",
                )

    def test_every_tool_has_a_policy_token(self) -> None:
        # Tools without a policy token get silently dropped under
        # any non-wildcard allowlist. New @tool definitions should
        # always land in TOOL_POLICY_TOKENS at the same time.
        for tool in ALL_TOOLS:
            name = getattr(tool, "name", "")
            self.assertIn(
                name,
                TOOL_POLICY_TOKENS,
                f"@tool '{name}' has no policy token; will be filtered out.",
            )


if __name__ == "__main__":
    unittest.main()
