"""
M9.5 L4 — integration test harness for producer/director/creator flows.

Design choice: rather than building a fake LangGraph + fake LLM (which
adds heavy machinery for negligible signal), L4 tests drive the
**deterministic post-routing** chain that each producer flow goes
through. The shape:

  1. Tests directly invoke the @tool functions a real agent would
     call (recommend_ingestion_path, request_ingestion_run, ...).
  2. The HITL `waiting_for_human` payloads emitted by those tools
     are passed to the `BridgeSimulator` — a Python translation of
     the `useHumanInTheLoop` handlers in `StoryboardCopilotBridge.tsx`.
     Each simulator method calls the corresponding mutations on the
     `ConvexShim`.
  3. Tests assert against `shim.calls` (chronological mutation log)
     to verify the chain landed in the right order with the right
     args.

What this CATCHES:
  * Tool payload shape drift (a renamed key breaks the bridge).
  * Bridge handler dropping a mutation (e.g. forgetting to call
    `setNodeNarrativeFields` before `upsertBeatPlan`).
  * Approval response failing to propagate (resolveApprovalTask
    never called → audit trail breaks).
  * Cross-tool ordering bugs (e.g. createBranch must precede
    commitPlanOps, not the other way around).

What this does NOT catch (and where it's caught):
  * "Does the LLM actually call the right subagent?" → L5 live-LLM
    smoke (`tests/smoke/test_live_smoke.py`).
  * "Does Convex actually persist this row?" → deferred to M9.6
    convex-test follow-up.
  * "Does the React UI update reactively?" → L6 Playwright.

The shim deliberately skips reactive query simulation: a real Convex
deployment fires `useQuery` re-renders on mutation, but the shim is a
flat call log, not a reactive store. Tests assert on mutation calls
directly rather than on derived UI state.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pytest


# ---------------------------------------------------------------------------
# ConvexShim — in-memory mutation surface
# ---------------------------------------------------------------------------


@dataclass
class MutationCall:
    """A single mutation invocation, captured for assertion."""

    mutation: str
    args: Dict[str, Any]
    result: Any = None


class ConvexShim:
    """
    A dict-backed in-memory shim mirroring the Convex mutation surface
    the bridge calls. Each `call(...)` records the invocation in
    `self.calls` (chronological log) AND applies a minimal state
    transition so multi-step flows can verify "row exists after
    earlier mutation" expectations.

    The shim is NOT a faithful Convex implementation:
      * No transactions; mutations apply atomically per call.
      * No reactive queries; tests use `state.<table>` directly.
      * No auth checks; every mutation is "approved by the producer".
      * Approval-token validation is shape-only (must start with
        "approved:") — same as the real Convex check but no token
        registry.
    """

    def __init__(self) -> None:
        self.calls: List[MutationCall] = []
        # Tables. Keyed by (storyboardId, primary key) tuples for
        # most; some flat-list tables use a list.
        self.storyboards: Dict[str, Dict[str, Any]] = {}
        self.nodes: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.edges: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.beat_plans: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.motifs: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.variants: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.branches: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.commits: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.approval_tasks: List[Dict[str, Any]] = []
        self.tool_audits: List[Dict[str, Any]] = []
        self.media_assets: List[Dict[str, Any]] = []
        self.dailies: List[Dict[str, Any]] = []
        self.reel_exports: List[Dict[str, Any]] = []

    # --- Generic call recorder ------------------------------------------------

    def _record(self, mutation: str, args: Dict[str, Any], result: Any = None) -> Any:
        self.calls.append(MutationCall(mutation, dict(args), result))
        return result

    def calls_for(self, mutation: str) -> List[MutationCall]:
        return [c for c in self.calls if c.mutation == mutation]

    # --- approvals ------------------------------------------------------------

    def create_approval_task(self, **args: Any) -> str:
        task_id = f"task_{len(self.approval_tasks) + 1}"
        self.approval_tasks.append({**args, "_id": task_id, "status": "pending"})
        return self._record("approvals:createTask", args, task_id)

    def resolve_approval_task(self, **args: Any) -> Dict[str, Any]:
        # Shape-only — flips the matching task's status. If the task
        # doesn't exist, fail loudly so a misordered chain surfaces.
        task_id = args.get("taskId")
        for task in self.approval_tasks:
            if task["_id"] == task_id:
                task["status"] = "approved" if args.get("approved") else "rejected"
                break
        else:
            raise AssertionError(f"resolveApprovalTask: unknown task {task_id}")
        return self._record(
            "approvals:resolveTask", args, {"taskId": task_id}
        )

    # --- storyboards ----------------------------------------------------------

    def create_storyboard(self, **args: Any) -> str:
        storyboard_id = args.get(
            "storyboardId", f"sb_{len(self.storyboards) + 1}"
        )
        self.storyboards[storyboard_id] = {
            **args,
            "_id": storyboard_id,
            "createdAt": 1,
        }
        self.nodes.setdefault(storyboard_id, {})
        self.edges.setdefault(storyboard_id, {})
        return self._record("storyboards:createStoryboard", args, storyboard_id)

    def apply_graph_patch(self, **args: Any) -> Dict[str, Any]:
        # Apply each op to the in-memory node/edge tables so multi-step
        # tests can read the resulting state.
        storyboard_id = args["storyboardId"]
        nodes = self.nodes.setdefault(storyboard_id, {})
        edges = self.edges.setdefault(storyboard_id, {})
        touched: List[str] = []
        for op in args.get("operations", []):
            op_type = op.get("op")
            if op_type == "create_node":
                node_id = op.get("nodeId") or f"n{len(nodes) + 1}"
                nodes[node_id] = {**op, "_id": node_id}
                touched.append(node_id)
            elif op_type == "update_node":
                node_id = op.get("nodeId")
                if node_id and node_id in nodes:
                    nodes[node_id].update({k: v for k, v in op.items() if k != "op"})
                    touched.append(node_id)
            elif op_type == "delete_node":
                node_id = op.get("nodeId")
                if node_id in nodes:
                    del nodes[node_id]
            elif op_type == "create_edge":
                edge_id = op.get("edgeId") or f"e{len(edges) + 1}"
                edges[edge_id] = {**op, "_id": edge_id}
            elif op_type == "update_edge":
                edge_id = op.get("edgeId")
                if edge_id in edges:
                    edges[edge_id].update({k: v for k, v in op.items() if k != "op"})
            elif op_type == "delete_edge":
                edge_id = op.get("edgeId")
                if edge_id in edges:
                    del edges[edge_id]
        result = {"touchedNodeIds": touched}
        return self._record("storyboards:applyGraphPatch", args, result)

    def record_story_event(self, **args: Any) -> str:
        return self._record("storyboards:recordStoryEvent", args, "event_1")

    def refresh_node_history_contexts(self, **args: Any) -> Dict[str, Any]:
        return self._record(
            "storyboards:refreshNodeHistoryContexts", args, {"refreshed": 1}
        )

    def set_node_narrative_fields(self, **args: Any) -> Dict[str, Any]:
        # Patch the node row with the narrative fields. Mirrors the
        # Convex mutation's null-to-clear semantics.
        storyboard_id = args["storyboardId"]
        node_id = args["nodeId"]
        nodes = self.nodes.setdefault(storyboard_id, {})
        node = nodes.setdefault(node_id, {"_id": node_id})
        for key in (
            "beatType",
            "actNumber",
            "tensionLevel",
            "motifIds",
            "hookType",
        ):
            if key in args:
                value = args[key]
                if value is None:
                    node.pop(key, None)
                else:
                    node[key] = value
        return self._record(
            "narrativeState:setNodeNarrativeFields", args, {"nodeId": node_id}
        )

    def set_edge_transition_intent(self, **args: Any) -> Dict[str, Any]:
        storyboard_id = args["storyboardId"]
        edge_id = args["edgeId"]
        edges = self.edges.setdefault(storyboard_id, {})
        edge = edges.setdefault(edge_id, {"_id": edge_id})
        intent = args.get("transitionIntent")
        if intent is None:
            edge.pop("transitionIntent", None)
        else:
            edge["transitionIntent"] = intent
        return self._record(
            "narrativeState:setEdgeTransitionIntent", args, {"edgeId": edge_id}
        )

    def upsert_beat_plan(self, **args: Any) -> str:
        storyboard_id = args["storyboardId"]
        branch_id = args["branchId"]
        plans = self.beat_plans.setdefault(storyboard_id, {})
        plan_id = f"plan_{branch_id}"
        plans[branch_id] = {**args, "_id": plan_id}
        return self._record(
            "narrativeState:upsertBeatPlan", args, plan_id
        )

    def upsert_motif(self, **args: Any) -> str:
        storyboard_id = args["storyboardId"]
        motif_key = args["motifKey"]
        motifs = self.motifs.setdefault(storyboard_id, {})
        existing = motifs.get(motif_key, {})
        motifs[motif_key] = {
            **existing,
            **args,
            "_id": f"motif_{motif_key}",
        }
        return self._record(
            "narrativeState:upsertMotif", args, motifs[motif_key]["_id"]
        )

    def upsert_variant(self, **args: Any) -> str:
        storyboard_id = args["storyboardId"]
        branch_id = args["branchId"]
        variants = self.variants.setdefault(storyboard_id, {})
        variant_id = f"variant_{branch_id}"
        # Mirror Convex's default: new variants are NOT producer-
        # picked. The pick path below flips this to true via
        # `mark_variant_picked`. Without this default, downstream
        # tests reading `producerPicked` get a KeyError instead of
        # the expected False.
        variants[branch_id] = {
            **args,
            "_id": variant_id,
            "producerPicked": args.get("producerPicked", False),
        }
        return self._record(
            "narrativeState:upsertVariant", args, variant_id
        )

    def mark_variant_picked(self, **args: Any) -> Dict[str, Any]:
        storyboard_id = args["storyboardId"]
        branch_id = args["branchId"]
        variants = self.variants.setdefault(storyboard_id, {})
        if branch_id in variants:
            variants[branch_id]["producerPicked"] = True
        return self._record(
            "narrativeState:markVariantPicked", args, {"branchId": branch_id}
        )

    # --- narrativeGit ---------------------------------------------------------

    def create_branch(self, **args: Any) -> str:
        storyboard_id = args["storyboardId"]
        branch_id = args["branchId"]
        branches = self.branches.setdefault(storyboard_id, {})
        # createBranch is idempotent in real Convex — return existing
        # id if a branch with the same branchId already exists.
        if branch_id in branches:
            return self._record(
                "narrativeGit:createBranch", args, branches[branch_id]["_id"]
            )
        new_id = f"b_{branch_id}"
        branches[branch_id] = {
            **args,
            "_id": new_id,
            "isDefault": args.get("isDefault", False),
            "status": "active",
            "headCommitId": args.get("parentCommitId"),
        }
        return self._record("narrativeGit:createBranch", args, new_id)

    def commit_plan_ops(self, **args: Any) -> Dict[str, Any]:
        # Approval token gate matches Convex behaviour: must start
        # with "approved:". Tests that forget to wire the approval
        # task surface here.
        token = args.get("approvalToken", "")
        if not token.startswith("approved:"):
            raise AssertionError(
                f"commitPlanOps: missing approval token (got {token!r})"
            )
        storyboard_id = args["storyboardId"]
        branch_id = args["branchId"]
        commits = self.commits.setdefault(storyboard_id, {})
        commit_id = f"commit_{len(commits) + 1}"
        commits[commit_id] = {
            **args,
            "_id": commit_id,
            "branchId": branch_id,
        }
        # Apply ops to the graph as the bridge would expect.
        self.apply_graph_patch(
            storyboardId=storyboard_id,
            operations=args.get("operations", []),
        )
        result = {"commitId": commit_id, "branchId": branch_id}
        return self._record("narrativeGit:commitPlanOps", args, result)

    def apply_merge_policy(self, **args: Any) -> Dict[str, Any]:
        token = args.get("approvalToken", "")
        if not token.startswith("approved:"):
            raise AssertionError(
                f"applyMergePolicy: missing approval token (got {token!r})"
            )
        storyboard_id = args["storyboardId"]
        commits = self.commits.setdefault(storyboard_id, {})
        merge_id = f"merge_{len(commits) + 1}"
        commits[merge_id] = {
            **args,
            "_id": merge_id,
            "branchId": args["targetBranchId"],
        }
        result = {
            "commitId": merge_id,
            "sourceBranchId": args["sourceBranchId"],
            "targetBranchId": args["targetBranchId"],
            "policy": args["policy"],
        }
        return self._record("narrativeGit:applyMergePolicy", args, result)

    # --- agent runs / audits / dailies ---------------------------------------

    def start_run(self, **args: Any) -> str:
        return self._record("agentRuns:startRun", args, f"run_{len(self.calls)}")

    def finish_run(self, **args: Any) -> Dict[str, Any]:
        return self._record("agentRuns:finishRun", args, {"finished": True})

    def record_tool_call_audit(self, **args: Any) -> Dict[str, Any]:
        self.tool_audits.append(dict(args))
        return self._record("toolAudits:recordToolCallAudit", args, None)

    def update_dailies_status(self, **args: Any) -> Dict[str, Any]:
        return self._record("dailies:updateDailiesStatus", args, None)

    def record_reel_export(self, **args: Any) -> str:
        export_id = f"rx_{len(self.reel_exports) + 1}"
        self.reel_exports.append({**args, "_id": export_id})
        return self._record("reelExports:recordReelExport", args, export_id)

    # --- assertion helpers ----------------------------------------------------

    def mutation_names(self) -> List[str]:
        return [c.mutation for c in self.calls]

    def assert_call_order(self, *mutation_names: str) -> None:
        """Assert these mutations occur in the given order (allowing
        intermediate mutations between them)."""
        observed = self.mutation_names()
        i = 0
        for expected in mutation_names:
            while i < len(observed) and observed[i] != expected:
                i += 1
            if i == len(observed):
                raise AssertionError(
                    f"Expected {list(mutation_names)} in order; "
                    f"missing {expected!r} after {observed}"
                )
            i += 1


# ---------------------------------------------------------------------------
# BridgeSimulator — Python translation of the bridge's HITL handlers
# ---------------------------------------------------------------------------


class BridgeSimulator:
    """
    Approves agent HITL payloads and dispatches the same mutation chain
    the React bridge would. Each `simulate_*` method takes a tool's
    `waiting_for_human` payload and applies the corresponding chain to
    the shim.

    This is a STRICT mirror of the bridge handlers in
    `StoryboardCopilotBridge.tsx`. If the Python side drifts from the
    TS side, the bridge integration tests in L3 catch the TS regression
    and these L4 tests catch the Python regression — the two sets are
    both authoritative for the contract.
    """

    def __init__(self, shim: ConvexShim) -> None:
        self.shim = shim

    # --- Phase 2: beat assignment ---------------------------------------------

    def approve_beat_assignment(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = payload["input"]
        for entry in body["assignments"]:
            kwargs: Dict[str, Any] = {
                "storyboardId": body["storyboardId"],
                "nodeId": entry["nodeId"],
                "beatType": entry["beatKey"],
            }
            if "actNumber" in entry:
                kwargs["actNumber"] = entry["actNumber"]
            self.shim.set_node_narrative_fields(**kwargs)
        beats = [
            {
                "beatKey": e["beatKey"],
                "expectedActNumber": e.get("actNumber"),
                "nodeId": e["nodeId"],
                "status": "assigned",
                "rationale": e.get("rationale"),
            }
            for e in body["assignments"]
        ]
        self.shim.upsert_beat_plan(
            storyboardId=body["storyboardId"],
            branchId=body["branchId"],
            structure=body["structure"],
            beats=beats,
        )
        return {"approved": True, "applied": len(beats)}

    # --- Phase 3: variants ----------------------------------------------------

    def approve_hook_variants(
        self, payload: Dict[str, Any], variant_type: str = "hook"
    ) -> Dict[str, Any]:
        return self._approve_variants(payload, variant_type)

    def approve_structural_remix(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._approve_variants(payload, "remix")

    def _approve_variants(
        self, payload: Dict[str, Any], variant_type: str
    ) -> Dict[str, Any]:
        body = payload["input"]
        committed = 0
        for variant in body["variants"]:
            variant_id = variant["variantId"]
            if variant_type == "hook":
                branch_id = f"variant/hook-{variant_id}"
            else:
                target = body.get("targetStructure", "save_the_cat")
                branch_id = f"variant/remix-{target}-{variant_id}"
            self.shim.create_branch(
                storyboardId=body["storyboardId"],
                branchId=branch_id,
                name=variant["branchName"],
                parentBranchId=body["parentBranchId"],
            )
            task_id = self.shim.create_approval_task(
                storyboardId=body["storyboardId"],
                taskType=(
                    "hook_variant_commit"
                    if variant_type == "hook"
                    else "structural_remix_commit"
                ),
                title=f"Commit {variant['branchName']}",
                rationale=variant.get("rationale", "Variant commit"),
                diffSummary=f"{len(variant['planOps'])} ops",
                payloadJson="{}",
            )
            self.shim.resolve_approval_task(taskId=task_id, approved=True)
            self.shim.commit_plan_ops(
                storyboardId=body["storyboardId"],
                branchId=branch_id,
                title=variant["branchName"],
                rationale=variant.get("rationale"),
                operations=variant["planOps"],
                approvalToken=f"approved:{task_id}",
            )
            self.shim.upsert_variant(
                storyboardId=body["storyboardId"],
                branchId=branch_id,
                variantType=variant_type,
                rationale=variant.get("rationale", ""),
                parentBranchId=body["parentBranchId"],
            )
            committed += 1
        return {"approved": True, "committed": committed, "variantType": variant_type}

    def promote_variant(
        self,
        storyboard_id: str,
        variant_branch_id: str,
        target_branch_id: str = "main",
    ) -> Dict[str, Any]:
        task_id = self.shim.create_approval_task(
            storyboardId=storyboard_id,
            taskType="merge_policy",
            title=f"Pick variant {variant_branch_id}",
            rationale="Producer picked",
            diffSummary=f"Merge {variant_branch_id} → {target_branch_id}",
            payloadJson="{}",
        )
        self.shim.resolve_approval_task(taskId=task_id, approved=True)
        self.shim.apply_merge_policy(
            storyboardId=storyboard_id,
            sourceBranchId=variant_branch_id,
            targetBranchId=target_branch_id,
            policy="pick_variant",
            approvalToken=f"approved:{task_id}",
        )
        self.shim.mark_variant_picked(
            storyboardId=storyboard_id, branchId=variant_branch_id
        )
        return {"promoted": True}

    # --- Phase 4: transition + motif -----------------------------------------

    def approve_transition_proposal(
        self,
        payload: Dict[str, Any],
        edge_id: str,
        chosen_intent: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = payload["input"]
        proposals = body["proposals"]
        if not proposals:
            return {"approved": False, "blockedReason": "no proposals"}
        intent = (
            chosen_intent
            if chosen_intent is not None
            else proposals[0]["intent"]
        )
        chosen = next(p for p in proposals if p["intent"] == intent)
        task_id = self.shim.create_approval_task(
            storyboardId=body["storyboardId"],
            taskType="transition_proposal",
            title=f"{chosen['intent']} between {body['sourceNodeId']} + {body['targetNodeId']}",
            rationale=chosen.get("rationale", ""),
            diffSummary=f"transitionIntent={chosen['intent']}",
            payloadJson="{}",
        )
        self.shim.resolve_approval_task(taskId=task_id, approved=True)
        if chosen.get("planOps"):
            self.shim.commit_plan_ops(
                storyboardId=body["storyboardId"],
                branchId=body["branchId"],
                title=f"Transition plant: {chosen['intent']}",
                rationale=chosen.get("rationale"),
                operations=chosen["planOps"],
                approvalToken=f"approved:{task_id}",
            )
        self.shim.set_edge_transition_intent(
            storyboardId=body["storyboardId"],
            edgeId=edge_id,
            transitionIntent=chosen["intent"],
        )
        return {
            "approved": True,
            "selectedIntent": chosen["intent"],
            "edgeId": edge_id,
        }

    def approve_motif_plant(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = payload["input"]
        sources = body.get("sourceNodeIds", [])
        payoffs = body.get("payoffNodeIds", [])
        if sources and payoffs:
            landed = "landed"
        elif sources or payoffs:
            landed = "planted"
        else:
            landed = "unplanted"
        task_id = self.shim.create_approval_task(
            storyboardId=body["storyboardId"],
            taskType="motif_plant",
            title=f"Plant motif {body['motifKey']} at {body['targetNodeId']}",
            rationale=body.get("rationale", ""),
            diffSummary=f"motif={body['motifKey']} status={landed}",
            payloadJson="{}",
        )
        self.shim.resolve_approval_task(taskId=task_id, approved=True)
        if body.get("planOps"):
            self.shim.commit_plan_ops(
                storyboardId=body["storyboardId"],
                branchId=body["branchId"],
                title=f"Plant {body['motifKey']} at {body['targetNodeId']}",
                rationale=body.get("rationale"),
                operations=body["planOps"],
                approvalToken=f"approved:{task_id}",
            )
        self.shim.upsert_motif(
            storyboardId=body["storyboardId"],
            motifKey=body["motifKey"],
            description=body.get("description", ""),
            sourceNodeIds=sources,
            payoffNodeIds=payoffs,
            visualVocabulary=body.get("visualVocabulary"),
            landedStatus=landed,
        )
        return {
            "approved": True,
            "motifKey": body["motifKey"],
            "landedStatus": landed,
        }

    # --- ingestion + batches --------------------------------------------------

    def approve_ingestion_run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = payload["input"]
        # Ingestion approval kicks off pipeline → bridge calls
        # createStoryboard with the title + mode, then logs an event.
        storyboard_id = self.shim.create_storyboard(
            title=body["title"],
            mode=body["mode"],
            rationale=body["rationale"],
        )
        self.shim.start_run(
            storyboardId=storyboard_id,
            tool="request_ingestion_run",
        )
        return {"approved": True, "storyboardId": storyboard_id}

    def approve_shot_batch(
        self, payload: Dict[str, Any], batch_kind: str
    ) -> Dict[str, Any]:
        # Each batch tool produces a `waiting_for_human` payload that
        # the bridge approves by recording a tool audit + a
        # placeholder dailies / media row. The real bridge has
        # batch-specific mutations; we record the approval here so
        # tests can assert "the producer approved the SFX batch with
        # concurrency=3".
        body = payload["input"]
        self.shim.record_tool_call_audit(
            tool=payload["action"],
            result="success",
            details={
                "storyboardId": body["storyboardId"],
                "batchKind": batch_kind,
                "nodeCount": body.get("nodeCount", 0),
                "concurrency": body.get("concurrency"),
            },
        )
        return {"approved": True, "batchKind": batch_kind}

    def approve_export_reel(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = payload["input"]
        export_id = self.shim.record_reel_export(
            storyboardId=body["storyboardId"],
            shotCount=body.get("shotCount", 0),
            totalDurationS=body.get("durationS", 0),
            byteLength=0,
            title="Producer export",
            sourceUrl="storage://test/export.mp4",
            storageId="storage_test",
        )
        return {"approved": True, "exportId": export_id}


# ---------------------------------------------------------------------------
# Pytest fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def shim() -> ConvexShim:
    """Fresh per-test Convex shim."""
    return ConvexShim()


@pytest.fixture
def bridge(shim: ConvexShim) -> BridgeSimulator:
    """Bridge simulator wired to the shim."""
    return BridgeSimulator(shim)


# ---------------------------------------------------------------------------
# Synthetic graph fixtures
# ---------------------------------------------------------------------------


def make_shot(
    node_id: str,
    label: str,
    segment: str,
    *,
    size: Optional[str] = None,
    move: Optional[str] = None,
    duration_s: float = 5.0,
) -> Dict[str, Any]:
    """Build a minimal shot node compatible with `sample_tension_curve`
    + `detect_beat_plan`."""
    shot_meta: Dict[str, Any] = {"durationS": duration_s}
    if size:
        shot_meta["size"] = size
    if move:
        shot_meta["move"] = move
    return {
        "nodeId": node_id,
        "label": label,
        "segment": segment,
        "shotMeta": shot_meta,
    }


@pytest.fixture
def synthetic_reel_shots() -> List[Dict[str, Any]]:
    """A 12-shot reel with a deliberate dip mid-act-2 for tension
    analysis tests."""
    return [
        make_shot("n1", "Opening", "Wide aerial sweep of the city at dawn.", size="WS"),
        make_shot("n2", "Catalyst", "She receives the call and panics.", size="MCU", move="handheld"),
        make_shot("n3", "Debate", "Two characters argue around a kitchen table.", size="MS"),
        make_shot("n4", "Break Two", "She steps onto the rooftop to make her decision.", size="MCU"),
        make_shot("n5", "B Story", "Old friend appears with a quiet warning.", size="MS"),
        make_shot("n6", "Fun and Games", "Heist montage rolls to an upbeat score.", size="MS", move="tilt"),
        make_shot("n7", "Midpoint", "She kills the lights and hides.", size="ECU", move="handheld"),
        make_shot("n8", "Bad Guys Close In", "Calm, peaceful aftermath as guards laugh and rest.", size="WS"),
        make_shot("n9", "All Is Lost", "She bleeds quietly in the storm; rain on glass.", size="CU"),
        make_shot("n10", "Dark Night", "Memory of her mother in soft light.", size="CU"),
        make_shot("n11", "Break Three", "She rises, fixes her grip on the blade.", size="MCU", move="handheld"),
        make_shot("n12", "Finale", "She charges the door; the explosion blooms.", size="MS", move="whip_pan"),
    ]
