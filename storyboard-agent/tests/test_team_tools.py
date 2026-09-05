"""
M9.5 L1 — agent-team management tool unit tests.

The five team-management tools (`select_agent_team`, `create_agent_team`,
`update_agent_team_member`, `publish_agent_team_revision`,
`generate_team_from_prompt`) are the only path through which the
supervisor mutates the team registry. Their pre-M9.5 coverage was
zero except for indirect registry-presence checks in
`test_ingestion_tools.py`.

Their policy posture matters: every team tool is gated by the
`team.manage` token, which is EXPLICITLY excluded from the default
runtime allowlist (see `tools.py::DEFAULT_RUNTIME_ALLOWLIST`). A
caller has to opt in by passing `["team.manage"]` (or `["*"]`). These
tests pin that posture so a stray edit to the default allowlist
doesn't silently open a team.manage attack surface.
"""

from __future__ import annotations

import unittest

from deep.tools import (
    ALL_TOOLS,
    DEFAULT_RUNTIME_ALLOWLIST,
    SUPERVISOR_CORE_TOOLS,
    TOOL_POLICY_TOKENS,
    create_agent_team,
    generate_team_from_prompt,
    is_tool_allowed,
    publish_agent_team_revision,
    select_agent_team,
    update_agent_team_member,
)


# ---------------------------------------------------------------------------
# select_agent_team
# ---------------------------------------------------------------------------


class SelectAgentTeamTests(unittest.TestCase):
    def test_team_only_payload(self) -> None:
        out = select_agent_team.invoke({"team_id": "team_alpha"})
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "select_agent_team")
        self.assertEqual(out["input"], {"teamId": "team_alpha"})

    def test_with_revision_includes_revision_id(self) -> None:
        out = select_agent_team.invoke(
            {"team_id": "team_alpha", "revision_id": "rev_42"}
        )
        self.assertEqual(
            out["input"], {"teamId": "team_alpha", "revisionId": "rev_42"}
        )

    def test_blank_revision_id_omits_field(self) -> None:
        # Blank revisionId would prompt the bridge to look up the
        # active revision; including an empty string would defeat that.
        out = select_agent_team.invoke(
            {"team_id": "team_alpha", "revision_id": ""}
        )
        self.assertNotIn("revisionId", out["input"])


# ---------------------------------------------------------------------------
# create_agent_team
# ---------------------------------------------------------------------------


class CreateAgentTeamTests(unittest.TestCase):
    def test_shape_is_waiting_for_human(self) -> None:
        out = create_agent_team.invoke(
            {
                "name": "Continuity Squad",
                "description": "Focused on identity locks.",
                "team_goal": "Catch wardrobe drift inline.",
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "create_agent_team")
        self.assertEqual(out["input"]["name"], "Continuity Squad")
        self.assertEqual(out["input"]["teamGoal"], "Catch wardrobe drift inline.")


# ---------------------------------------------------------------------------
# update_agent_team_member
# ---------------------------------------------------------------------------


class UpdateAgentTeamMemberTests(unittest.TestCase):
    def test_member_payload_round_trips(self) -> None:
        member = {
            "name": "continuity_critic",
            "persona": "Strict, fast, production-aware.",
            "tools": ["continuity_critic"],
        }
        out = update_agent_team_member.invoke(
            {
                "team_id": "team_alpha",
                "revision_id": "rev_2",
                "member": member,
            }
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "update_agent_team_member")
        # Member dict must round-trip unchanged so the bridge can
        # forward it to `agentTeams:updateRevisionMember` verbatim.
        self.assertEqual(out["input"]["member"], member)


# ---------------------------------------------------------------------------
# publish_agent_team_revision
# ---------------------------------------------------------------------------


class PublishAgentTeamRevisionTests(unittest.TestCase):
    def test_minimal_payload(self) -> None:
        out = publish_agent_team_revision.invoke(
            {"team_id": "team_alpha", "revision_id": "rev_2"}
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "publish_agent_team_revision")
        self.assertEqual(
            out["input"], {"teamId": "team_alpha", "revisionId": "rev_2"}
        )


# ---------------------------------------------------------------------------
# generate_team_from_prompt
# ---------------------------------------------------------------------------


class GenerateTeamFromPromptTests(unittest.TestCase):
    def test_minimal_payload_default_publish_false(self) -> None:
        out = generate_team_from_prompt.invoke(
            {"input_prompt": "Build me a docu-style narrator team."}
        )
        self.assertEqual(out["status"], "waiting_for_human")
        self.assertEqual(out["action"], "generate_team_from_prompt")
        self.assertFalse(out["input"]["publish"])
        # Optional fields are omitted when not supplied so the bridge
        # treats the run as "draft against a fresh team".
        self.assertNotIn("teamId", out["input"])

    def test_with_team_id_includes_field(self) -> None:
        out = generate_team_from_prompt.invoke(
            {
                "input_prompt": "Refine the existing team.",
                "team_id": "team_alpha",
            }
        )
        self.assertEqual(out["input"]["teamId"], "team_alpha")

    def test_publish_flag_propagates(self) -> None:
        out = generate_team_from_prompt.invoke(
            {"input_prompt": "Ship it.", "publish": True}
        )
        self.assertTrue(out["input"]["publish"])


# ---------------------------------------------------------------------------
# Policy / registry wiring (the safety-critical piece)
# ---------------------------------------------------------------------------


class TeamToolsPolicyTests(unittest.TestCase):
    """
    The team management surface is governed by the `team.manage` policy
    token, which is intentionally NOT in DEFAULT_RUNTIME_ALLOWLIST. This
    means any caller that doesn't pass an explicit allowlist (or "*")
    cannot route to these tools. These tests pin that posture so a
    drive-by edit doesn't open the surface.
    """

    def test_team_tools_in_all_tools(self) -> None:
        names = {getattr(t, "name", "") for t in ALL_TOOLS}
        self.assertIn(select_agent_team.name, names)
        self.assertIn(create_agent_team.name, names)
        self.assertIn(update_agent_team_member.name, names)
        self.assertIn(publish_agent_team_revision.name, names)
        self.assertIn(generate_team_from_prompt.name, names)

    def test_only_select_agent_team_on_supervisor_core(self) -> None:
        # `select_agent_team` is the supervisor-level orchestration
        # primitive (switching teams). All other team mutations
        # (create/update/publish/generate) live exclusively on the
        # `team_architect` subagent — verifying that here.
        names = {getattr(t, "name", "") for t in SUPERVISOR_CORE_TOOLS}
        self.assertIn(select_agent_team.name, names)
        self.assertNotIn(create_agent_team.name, names)
        self.assertNotIn(update_agent_team_member.name, names)
        self.assertNotIn(publish_agent_team_revision.name, names)
        self.assertNotIn(generate_team_from_prompt.name, names)

    def test_all_team_tools_share_team_manage_token(self) -> None:
        for tool in (
            select_agent_team,
            create_agent_team,
            update_agent_team_member,
            publish_agent_team_revision,
            generate_team_from_prompt,
        ):
            self.assertEqual(
                TOOL_POLICY_TOKENS[tool.name],
                "team.manage",
                f"{tool.name} should be gated by team.manage",
            )

    def test_team_manage_excluded_from_default_allowlist(self) -> None:
        # SAFETY: team.manage must NEVER drift into the default
        # allowlist. If this assertion fails, an edit just exposed
        # team mutations to every storyboard run by default.
        self.assertNotIn("team.manage", DEFAULT_RUNTIME_ALLOWLIST)

    def test_team_tools_blocked_under_default_policy(self) -> None:
        # Empty allowlist → applies DEFAULT_RUNTIME_ALLOWLIST → blocks.
        self.assertFalse(is_tool_allowed([], "team.manage"))

    def test_team_tools_allowed_under_explicit_opt_in(self) -> None:
        self.assertTrue(is_tool_allowed(["team.manage"], "team.manage"))

    def test_team_tools_allowed_under_wildcard(self) -> None:
        self.assertTrue(is_tool_allowed(["*"], "team.manage"))


if __name__ == "__main__":
    unittest.main()
