"""
M9.5 L4 — Director: cut tier promotion + reel export flow.

Producer flow:
  1. Producer bumps the cut tier on the active branch (assembly →
     editor's → director's → ... → delivered). This is a Convex
     mutation handled outside the agent loop, but the agent
     observes the change in `state.branch.cutTier`.
  2. Producer says "export" → ingestion_coordinator emits
     `request_export_reel` HITL.
  3. Producer approves → bridge POSTs to /api/storyboard/export-reel
     (ffmpeg pipeline) → on success records a reelExports row.

What this pins:
  * Export HITL carries the right shotCount + estimated duration.
  * Bridge approval registers a reelExports row keyed by storyboard.
  * Re-issuing the same export request is dedup-safe (deterministic
    storyboardId + shotCount → producer can re-export without
    duplicating audit rows beyond the explicit re-issue).
  * The agent never bypasses approval — even a 1-shot reel needs
    the HITL gate.
"""

from __future__ import annotations

from deep.tools import request_export_reel


def test_export_reel_request_carries_metadata(shim, bridge) -> None:
    hitl = request_export_reel.invoke(
        {
            "storyboard_id": "sb_1",
            "rationale": "Producer signed off the picture lock; export.",
            "shot_count": 12,
            "estimated_duration_s": 60,
        }
    )
    assert hitl["status"] == "waiting_for_human"
    assert hitl["action"] == "request_export_reel"
    body = hitl["input"]
    assert body["storyboardId"] == "sb_1"
    assert body["shotCount"] == 12
    # The estimated duration field carries through so the bridge can
    # warn producers when the duration is suspicious (e.g. 0s).
    assert body["estimatedDurationS"] == 60


def test_export_approval_records_reel_export_row(shim, bridge) -> None:
    hitl = request_export_reel.invoke(
        {
            "storyboard_id": "sb_1",
            "rationale": "Final mp4 export.",
            "shot_count": 8,
            "estimated_duration_s": 40,
        }
    )
    response = bridge.approve_export_reel(hitl)
    assert response["approved"] is True

    # Bridge ran the ffmpeg pipeline (mocked) → recordReelExport
    # logs the output URL + storage id for download.
    exports = shim.reel_exports
    assert len(exports) == 1
    assert exports[0]["storyboardId"] == "sb_1"
    assert exports[0]["shotCount"] == 8


def test_zero_shot_export_is_still_a_hitl_gate(shim, bridge) -> None:
    # A degenerate reel (no shots) shouldn't crash the export tool.
    # The HITL card surfaces with shotCount=0; bridge dispatches
    # the request normally; ffmpeg pipeline will return an error
    # which the route surfaces back to the producer.
    hitl = request_export_reel.invoke(
        {
            "storyboard_id": "sb_1",
            "rationale": "Test empty export.",
            "shot_count": 0,
            "estimated_duration_s": 0,
        }
    )
    assert hitl["status"] == "waiting_for_human"
    assert hitl["input"]["shotCount"] == 0


def test_repeated_export_requests_each_record_a_row(shim, bridge) -> None:
    # Producers may export multiple takes (different cut tiers, A/B
    # comparing the dub track). Each approval records its own row
    # so the audit trail keeps every export intact.
    for _ in range(3):
        hitl = request_export_reel.invoke(
            {
                "storyboard_id": "sb_1",
                "rationale": "Take",
                "shot_count": 12,
                "estimated_duration_s": 60,
            }
        )
        bridge.approve_export_reel(hitl)
    assert len(shim.reel_exports) == 3
    # Distinct storage ids are not enforced at the shim level, but
    # each row carries its own _id so the bridge can list them.
    ids = [r["_id"] for r in shim.reel_exports]
    assert len(set(ids)) == 3
