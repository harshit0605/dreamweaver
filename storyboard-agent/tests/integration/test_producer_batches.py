"""
M9.5 L4 — Producer: shot/video/audio/SFX batch generation flow.

Producer flow:
  1. Producer says "render everything" in chat.
  2. Agent's `ingestion_coordinator` fans out 4-5 batch HITL tools in
     dependency order:
       (1) request_generate_shot_batch — image generation.
       (2) request_generate_shot_video_batch — I2V (depends on (1)).
       (3) request_generate_shot_audio_batch — narration TTS
           (independent of (1)/(2)).
       (3b) request_generate_shot_sfx_batch — ambient SFX
            (independent).
       (3c) request_generate_score — full reel score (independent).
       (4) request_export_reel — ffmpeg concat (depends on at least
           some of the above).
  3. Producer approves each card; bridge audits + dispatches the
     pipeline route.

What this pins:
  * Each batch tool emits a `waiting_for_human` payload with
    sanitized concurrency / nodeCount / clamping.
  * Approving a batch records a tool audit row tagged with the
    batch kind so producers can replay the chain via the audit
    dashboard.
"""

from __future__ import annotations

from deep.tools import (
    request_export_reel,
    request_generate_score,
    request_generate_shot_audio_batch,
    request_generate_shot_batch,
    request_generate_shot_sfx_batch,
    request_generate_shot_video_batch,
)


def test_full_render_pipeline_chains_in_dependency_order(shim, bridge) -> None:
    # Step 1: image batch (root of the dependency tree).
    image_hitl = request_generate_shot_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": 12,
            "rationale": "Producer asked to render images first.",
            "skip_existing": True,
            "concurrency": 4,
        }
    )
    assert image_hitl["status"] == "waiting_for_human"
    assert image_hitl["input"]["concurrency"] == 4
    bridge.approve_shot_batch(image_hitl, batch_kind="image")

    # Step 2: video batch (depends on images existing).
    video_hitl = request_generate_shot_video_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": 12,
            "rationale": "Animate rendered images via I2V.",
            "skip_existing": True,
            "concurrency": 3,
        }
    )
    assert video_hitl["input"]["concurrency"] == 3
    bridge.approve_shot_batch(video_hitl, batch_kind="video")

    # Step 3a: audio narration (independent — can run in parallel
    # with video, but tests serialize for assertion clarity).
    audio_hitl = request_generate_shot_audio_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": 12,
            "rationale": "OpenAI TTS narration pass.",
            "concurrency": 5,
        }
    )
    bridge.approve_shot_batch(audio_hitl, batch_kind="audio")

    # Step 3b: SFX (concurrency capped at 5 — pin it here so that
    # cap regressions surface in the audit log).
    sfx_hitl = request_generate_shot_sfx_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": 12,
            "rationale": "Ambient + foley SFX layer under narration.",
            "concurrency": 99,  # gets clamped down to 5
        }
    )
    assert sfx_hitl["input"]["concurrency"] == 5
    bridge.approve_shot_batch(sfx_hitl, batch_kind="sfx")

    # Step 3c: full reel score (one-shot generator, no concurrency).
    score_hitl = request_generate_score.invoke(
        {
            "storyboard_id": "sb_1",
            "prompt": "Cinematic noir score with a low brass swell.",
            "duration_s": 60,
            "volume_db": -18,
            "rationale": "Producer wants a unifying score under the reel.",
        }
    )
    assert score_hitl["input"]["durationS"] == 60
    bridge.approve_shot_batch(score_hitl, batch_kind="score")

    # Step 4: export reel — terminal node; must come last.
    export_hitl = request_export_reel.invoke(
        {
            "storyboard_id": "sb_1",
            "rationale": "Producer requested final mp4.",
            "shot_count": 12,
            "estimated_duration_s": 60,
        }
    )
    bridge.approve_export_reel(export_hitl)

    # Audit log records each batch in dependency order. The bridge
    # tracks `batchKind` in the audit row so producers can re-derive
    # the chain via toolAudits later.
    batch_kinds = [
        c.args["details"]["batchKind"]
        for c in shim.calls_for("toolAudits:recordToolCallAudit")
        if "batchKind" in c.args.get("details", {})
    ]
    assert batch_kinds == ["image", "video", "audio", "sfx", "score"]

    # Reel export landed.
    assert len(shim.reel_exports) == 1
    assert shim.reel_exports[0]["storyboardId"] == "sb_1"
    assert shim.reel_exports[0]["shotCount"] == 12


def test_batch_concurrency_clamped_to_safe_range(shim, bridge) -> None:
    # Image batch concurrency is capped at 6 (saturation guard); SFX
    # at 5 (audio API tolerance is lower). Producers can pass higher
    # numbers — the tool clamps them silently.
    high = request_generate_shot_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": 12,
            "rationale": "x",
            "concurrency": 999,
        }
    )
    assert high["input"]["concurrency"] == 6

    low = request_generate_shot_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": 12,
            "rationale": "x",
            "concurrency": 0,
        }
    )
    assert low["input"]["concurrency"] == 1


def test_batch_node_count_floors_at_zero(shim, bridge) -> None:
    out = request_generate_shot_video_batch.invoke(
        {
            "storyboard_id": "sb_1",
            "branch_id": "main",
            "node_count": -10,
            "rationale": "x",
            "concurrency": 2,
        }
    )
    assert out["input"]["nodeCount"] == 0
