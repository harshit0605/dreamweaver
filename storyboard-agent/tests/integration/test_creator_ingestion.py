"""
M9.5 L4 — Creator: Ingestion flow integration test.

Producer flow:
  1. Producer types a pitch / screenplay / novel excerpt in chat.
  2. Agent's `ingestion_coordinator` calls `recommend_ingestion_path`
     to classify the request → returns {mode, requiredFields, ...}.
  3. Agent emits `request_ingestion_run` HITL → producer approves.
  4. Bridge dispatches `createStoryboard` and `startRun`.

What this test pins:
  * Heuristic classification correctly routes idea / screenplay / novel.
  * The HITL payload carries the classified mode + collected hints.
  * The bridge's approval chain calls createStoryboard with the right
    title + mode and starts an audit run.
"""

from __future__ import annotations

from deep.tools import recommend_ingestion_path, request_ingestion_run


def test_idea_pitch_routes_to_idea_ingestion(shim, bridge) -> None:
    # Step 1: producer's chat input — short premise, no markers.
    pitch = "Make a film about a heist on Mars where the AI lies."
    rec = recommend_ingestion_path.invoke({"user_request": pitch})

    assert rec["mode"] == "idea"
    assert "title" in rec["requiredFields"]
    assert "idea" in rec["requiredFields"]

    # Step 2: agent emits HITL with the classified mode + hints.
    hitl = request_ingestion_run.invoke(
        {
            "mode": rec["mode"],
            "title": "Heist on Mars",
            "rationale": rec["rationale"],
            "hints": {
                "ideaSynopsis": pitch,
                "style": "cinematic noir",
            },
        }
    )
    assert hitl["status"] == "waiting_for_human"
    assert hitl["input"]["mode"] == "idea"
    assert hitl["input"]["hints"]["ideaSynopsis"] == pitch

    # Step 3: producer approves → bridge creates storyboard + run.
    response = bridge.approve_ingestion_run(hitl)

    assert response["approved"] is True
    storyboard_id = response["storyboardId"]
    # Storyboard row landed with the chosen mode + title.
    assert shim.storyboards[storyboard_id]["mode"] == "idea"
    assert shim.storyboards[storyboard_id]["title"] == "Heist on Mars"
    # Audit run started — producers can replay the chain via
    # agentRuns later.
    assert len(shim.calls_for("agentRuns:startRun")) == 1


def test_screenplay_text_routes_to_screenplay_ingestion(shim, bridge) -> None:
    # Slug lines + transitions → screenplay heuristic kicks in.
    screenplay_excerpt = (
        "INT. WAREHOUSE - NIGHT\n\n"
        "She moves through the shadows.\n\n"
        "CUT TO:\n\n"
        "EXT. ROOFTOP - DAWN\n\n"
        "Wide skyline."
    )
    rec = recommend_ingestion_path.invoke(
        {"user_request": screenplay_excerpt}
    )
    assert rec["mode"] == "screenplay"
    assert "screenplay" in rec["requiredFields"]

    hitl = request_ingestion_run.invoke(
        {
            "mode": rec["mode"],
            "title": "Untitled screenplay import",
            "rationale": rec["rationale"],
            "hints": {"screenplayExcerpt": screenplay_excerpt},
        }
    )
    response = bridge.approve_ingestion_run(hitl)
    assert response["approved"] is True
    assert shim.storyboards[response["storyboardId"]]["mode"] == "screenplay"


def test_novel_passage_routes_to_novel_ingestion(shim, bridge) -> None:
    # Long prose + paragraph breaks + dialogue markers → novel.
    novel = (
        "Chapter One\n\n"
        "She had always known the storm would come. " * 30
        + "\n\nHe said: \"You should have stayed.\"\n\n"
        + "The mountain held its breath, watching."
    )
    rec = recommend_ingestion_path.invoke({"user_request": novel})
    assert rec["mode"] == "novel"
    assert "novel" in rec["requiredFields"]
    assert "targetEpisodeCount" in rec["requiredFields"]

    hitl = request_ingestion_run.invoke(
        {
            "mode": rec["mode"],
            "title": "Untitled novel import",
            "rationale": rec["rationale"],
            "hints": {"novelExcerpt": novel[:600]},
        }
    )
    response = bridge.approve_ingestion_run(hitl)
    assert response["approved"] is True
    assert shim.storyboards[response["storyboardId"]]["mode"] == "novel"


def test_explicit_input_flag_overrides_heuristic(shim, bridge) -> None:
    # A short ambiguous request would normally be classified as "idea";
    # explicit `has_screenplay_text=True` forces screenplay routing
    # (the producer already pasted formatted text into the dialog).
    rec = recommend_ingestion_path.invoke(
        {
            "user_request": "Quick pitch.",
            "has_screenplay_text": True,
        }
    )
    assert rec["mode"] == "screenplay"


def test_ambiguous_request_defaults_to_idea(shim, bridge) -> None:
    # Empty / nonsense → falls through to idea (cheapest path).
    rec = recommend_ingestion_path.invoke({"user_request": ""})
    assert rec["mode"] == "idea"
    # Even an empty request emits a deterministic recommendation id so
    # the bridge can dedup re-issued cards.
    assert rec["recommendationId"].startswith("ingestreco_")
