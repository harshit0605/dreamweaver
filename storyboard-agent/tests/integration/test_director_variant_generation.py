"""
M9.5 L4 — Director: variant generation flow (hooks + structural remix).

Producer flow A — cold-open hooks:
  1. Producer says "give me 3 cold-open variants" in chat.
  2. Agent's `hook_designer` proposes 3 variants (question / stakes /
     visual-rhyme archetypes) → `request_hook_variants` HITL.
  3. Producer approves → bridge creates 3 narrative-git branches
     (`variant/hook-<id>`), commits each variant's planOps, records
     each as a `narrativeVariants` row.
  4. Producer compares in Variant Compare tab → picks one.
  5. Bridge calls `applyMergePolicy` (policy=`pick_variant`) +
     `markVariantPicked`.

Producer flow B — structural remix:
  Same chain with branch convention `variant/remix-<structure>-<id>`
  and `variantType=remix`.

What this pins:
  * Each variant lands as its own branch with the right naming
    convention.
  * commitPlanOps requires the synthetic approval token; tests
    verify the token threading by failing loudly if missed.
  * The pick path archives the merge through applyMergePolicy +
    flips `producerPicked=true` on the chosen variant.
"""

from __future__ import annotations

from deep.tools import request_hook_variants, request_structural_remix


_HOOK_VARIANTS = [
    {
        "variantId": "question",
        "rationale": "Open on an unanswered question.",
        "expectedRetention": "high",
        "branchName": "Hook variant question",
        "planOps": [
            {
                "op": "create_node",
                "title": "Question hook shot",
                "rationale": "Provoke curiosity.",
            }
        ],
    },
    {
        "variantId": "stakes",
        "rationale": "Reveal the threat up front.",
        "expectedRetention": "high",
        "branchName": "Hook variant stakes",
        "planOps": [
            {
                "op": "create_node",
                "title": "Stakes hook shot",
                "rationale": "Worst-case reveal.",
            }
        ],
    },
    {
        "variantId": "rhyme",
        "rationale": "Match-cut into act 1.",
        "expectedRetention": "experimental",
        "branchName": "Hook variant rhyme",
        "planOps": [
            {
                "op": "create_node",
                "title": "Visual rhyme hook",
                "rationale": "Match cut.",
            }
        ],
    },
]


def test_three_hook_variants_commit_three_branches(shim, bridge) -> None:
    hitl = request_hook_variants.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "variants": _HOOK_VARIANTS,
            "rationale": "Producer asked for 3 cold-open variants.",
        }
    )
    assert hitl["status"] == "waiting_for_human"
    assert hitl["input"]["variantCount"] == 3

    response = bridge.approve_hook_variants(hitl)
    assert response["approved"] is True
    assert response["committed"] == 3
    assert response["variantType"] == "hook"

    # Three branches, each named with the variant/hook-<id> convention.
    branch_ids = sorted(shim.branches["sb_1"].keys())
    assert branch_ids == [
        "variant/hook-question",
        "variant/hook-rhyme",
        "variant/hook-stakes",
    ]
    # Three commits — one per variant; each carrying its planOps.
    commit_calls = shim.calls_for("narrativeGit:commitPlanOps")
    assert len(commit_calls) == 3
    # Three narrativeVariants rows tagged variantType=hook.
    variant_rows = list(shim.variants["sb_1"].values())
    assert all(v["variantType"] == "hook" for v in variant_rows)
    # Approval-task chain: each variant commits with a unique token.
    token_set = {c.args["approvalToken"] for c in commit_calls}
    assert len(token_set) == 3


def test_pick_variant_promotes_to_main_and_marks_picked(shim, bridge) -> None:
    # First commit the variants.
    hitl = request_hook_variants.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "variants": _HOOK_VARIANTS,
            "rationale": "x",
        }
    )
    bridge.approve_hook_variants(hitl)

    # Producer picks the "stakes" variant.
    bridge.promote_variant(
        storyboard_id="sb_1",
        variant_branch_id="variant/hook-stakes",
        target_branch_id="main",
    )

    # applyMergePolicy fired with the right source/target/policy.
    merge_calls = shim.calls_for("narrativeGit:applyMergePolicy")
    assert len(merge_calls) == 1
    args = merge_calls[0].args
    assert args["sourceBranchId"] == "variant/hook-stakes"
    assert args["targetBranchId"] == "main"
    assert args["policy"] == "pick_variant"

    # markVariantPicked flipped the chosen variant.
    assert shim.variants["sb_1"]["variant/hook-stakes"]["producerPicked"] is True
    # Non-chosen variants stay un-picked (they linger until the cron
    # eviction at 14 days).
    assert (
        shim.variants["sb_1"]["variant/hook-question"]["producerPicked"]
        is False
    )


def test_structural_remix_uses_remix_branch_naming(shim, bridge) -> None:
    remix_variants = [
        {
            "variantId": "in-medias-res",
            "strategy": "in_medias_res",
            "rationale": "Open mid-act-2.",
            "branchName": "Remix harmon_circle in-medias-res",
            "planOps": [
                {
                    "op": "update_node",
                    "title": "Reorder n1 → midpoint",
                    "nodeId": "n1",
                }
            ],
        },
        {
            "variantId": "harmon-reframe",
            "strategy": "harmon_reframe",
            "rationale": "Strict 8-beat circle.",
            "branchName": "Remix harmon_circle harmon-reframe",
            "planOps": [
                {
                    "op": "update_node",
                    "title": "Move catalyst → 'go' beat",
                    "nodeId": "n2",
                }
            ],
        },
    ]

    hitl = request_structural_remix.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "target_structure": "harmon_circle",
            "variants": remix_variants,
            "rationale": "Reframe to Harmon Circle.",
        }
    )
    assert hitl["input"]["targetStructure"] == "harmon_circle"

    response = bridge.approve_structural_remix(hitl)
    assert response["approved"] is True
    assert response["variantType"] == "remix"

    branch_ids = sorted(shim.branches["sb_1"].keys())
    assert branch_ids == [
        "variant/remix-harmon_circle-harmon-reframe",
        "variant/remix-harmon_circle-in-medias-res",
    ]
    variant_rows = list(shim.variants["sb_1"].values())
    assert all(v["variantType"] == "remix" for v in variant_rows)


def test_unknown_target_structure_falls_back_to_save_the_cat(
    shim, bridge
) -> None:
    hitl = request_structural_remix.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "target_structure": "vortex_warp",
            "variants": [
                {
                    "variantId": "v1",
                    "rationale": "x",
                    "branchName": "x",
                    "planOps": [
                        {"op": "update_node", "title": "x", "nodeId": "n1"}
                    ],
                }
            ],
            "rationale": "x",
        }
    )
    # Sanitization fallback at the tool boundary.
    assert hitl["input"]["targetStructure"] == "save_the_cat"

    bridge.approve_structural_remix(hitl)
    branch_ids = list(shim.branches["sb_1"].keys())
    assert branch_ids == ["variant/remix-save_the_cat-v1"]


def test_variants_with_empty_plan_ops_dropped_at_tool_boundary(
    shim, bridge
) -> None:
    # The Python tool drops variants whose planOps are empty so the
    # producer never sees a no-op variant in the approval card.
    hitl = request_hook_variants.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "variants": [
                {"variantId": "empty", "planOps": []},
                {
                    "variantId": "ok",
                    "planOps": [
                        {"op": "create_node", "title": "Real shot"}
                    ],
                },
            ],
            "rationale": "x",
        }
    )
    assert hitl["input"]["variantCount"] == 1
    bridge.approve_hook_variants(hitl)
    assert list(shim.branches.get("sb_1", {}).keys()) == ["variant/hook-ok"]
