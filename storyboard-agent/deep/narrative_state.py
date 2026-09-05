"""
M9 — reel-scoped narrative state helpers.

Pure Python — no Convex client dependency. The bridge hydrates the
state from Convex into `StoryboardDeepAgentState.reel_narrative_state`
before each agent turn and writes it back on exit. This module
provides:

- Serialization between JSON-string payloads (Convex `reelNarrativeState`
  columns) and the typed `ReelNarrativeState` shape consumed by agents.
- Patch helpers (assign beat, record motif, sample tension) that enforce
  the reconciliation rules without having to scatter them across subagent
  prompts.
- Invalidation helpers for the stale-flag write policy.

No I/O. All functions are deterministic so they're trivially unit-testable.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional

from .state import (
    BeatAssignment,
    CharacterArc,
    MotifEntry,
    NarrativeStructure,
    ReelNarrativeState,
    TensionSample,
)

# Canonical beat keys per structure. The narrative_architect /
# beat_analyst subagents use these to seed an empty beat plan. Free-
# form strings on the wire (schema doesn't pin them) so adding new
# structures is a one-file change here, not a schema migration.
SAVE_THE_CAT_BEATS: List[str] = [
    "opening_image",
    "theme_stated",
    "setup",
    "catalyst",
    "debate",
    "break_into_two",
    "b_story",
    "fun_and_games",
    "midpoint",
    "bad_guys_close_in",
    "all_is_lost",
    "dark_night_of_the_soul",
    "break_into_three",
    "finale",
    "final_image",
]

HARMON_CIRCLE_BEATS: List[str] = [
    "you",
    "need",
    "go",
    "search",
    "find",
    "take",
    "return",
    "change",
]

THREE_ACT_BEATS: List[str] = [
    "act1_setup",
    "act1_inciting_incident",
    "act2_rising_action",
    "act2_midpoint",
    "act2_crisis",
    "act3_climax",
    "act3_denouement",
]

KISHOTENKETSU_BEATS: List[str] = ["ki", "sho", "ten", "ketsu"]

# Hook-first short-form (TikTok/Reels/Shorts). First three seconds are
# decisive; the rest of the structure is "proof of the hook" → "call
# to action".
HOOK_FIRST_BEATS: List[str] = [
    "hook",
    "promise",
    "proof",
    "payoff",
    "cta",
]

# Recommended-default act placement. Used by `seed_beat_plan` so the
# first-run beat list has plausible `expectedActNumber` hints even
# before the beat_analyst has looked at the reel. The agent is free to
# overwrite these when it assigns nodes.
_ACT_HINTS: Dict[NarrativeStructure, Dict[str, int]] = {
    "save_the_cat": {
        "opening_image": 1,
        "theme_stated": 1,
        "setup": 1,
        "catalyst": 1,
        "debate": 1,
        "break_into_two": 2,
        "b_story": 2,
        "fun_and_games": 2,
        "midpoint": 2,
        "bad_guys_close_in": 2,
        "all_is_lost": 2,
        "dark_night_of_the_soul": 2,
        "break_into_three": 3,
        "finale": 3,
        "final_image": 3,
    },
    "harmon_circle": {
        "you": 1,
        "need": 1,
        "go": 2,
        "search": 2,
        "find": 2,
        "take": 3,
        "return": 3,
        "change": 3,
    },
    "three_act": {
        "act1_setup": 1,
        "act1_inciting_incident": 1,
        "act2_rising_action": 2,
        "act2_midpoint": 2,
        "act2_crisis": 2,
        "act3_climax": 3,
        "act3_denouement": 3,
    },
    "kishotenketsu": {
        "ki": 1,
        "sho": 2,
        "ten": 3,
        "ketsu": 4,
    },
    "hook_first": {
        "hook": 1,
        "promise": 1,
        "proof": 2,
        "payoff": 3,
        "cta": 3,
    },
}


def canonical_beats_for(structure: NarrativeStructure) -> List[str]:
    """Return the ordered beat-key list for a structure. Raises on
    unknown structures so the caller gets a clear error instead of a
    silently-empty plan."""
    if structure == "save_the_cat":
        return list(SAVE_THE_CAT_BEATS)
    if structure == "harmon_circle":
        return list(HARMON_CIRCLE_BEATS)
    if structure == "three_act":
        return list(THREE_ACT_BEATS)
    if structure == "kishotenketsu":
        return list(KISHOTENKETSU_BEATS)
    if structure == "hook_first":
        return list(HOOK_FIRST_BEATS)
    raise ValueError(f"Unknown narrative structure: {structure!r}")


def seed_beat_plan(
    structure: NarrativeStructure,
) -> List[BeatAssignment]:
    """Build a fresh beat plan with every slot in `planned` state.
    Producer triggers this when they pick a structure; the
    beat_analyst then fills in `nodeId`s."""
    hints = _ACT_HINTS.get(structure, {})
    return [
        BeatAssignment(
            beatKey=key,
            expectedActNumber=hints.get(key),
            status="planned",
        )
        for key in canonical_beats_for(structure)
    ]


def empty_reel_narrative_state(
    structure: NarrativeStructure = "save_the_cat",
) -> ReelNarrativeState:
    """First-run state for a (storyboard, branch) pair. Used when
    `load_reel_narrative_state` finds no Convex row."""
    return ReelNarrativeState(
        structure=structure,
        beats=seed_beat_plan(structure),
        motifs={},
        tension_samples=[],
        character_arcs=[],
        stale=False,
    )


# ------------------------------------------------------------
# Serialization
# ------------------------------------------------------------
# Convex stores each dict as a JSON string so the schema stays
# ontology-flexible. These helpers are the one place that format is
# stitched; keep them narrow.


def serialize_state(state: ReelNarrativeState) -> Dict[str, str]:
    """Serialize a `ReelNarrativeState` into the four JSON strings
    `upsertReelNarrativeState` expects. Returns a dict with the four
    column names as keys so the caller can spread into the mutation
    args verbatim."""
    beats = list(state.get("beats", []))
    motifs = state.get("motifs", {})
    tension_samples = list(state.get("tension_samples", []))
    character_arcs = list(state.get("character_arcs", []))
    return {
        "beatMapJson": json.dumps(beats, separators=(",", ":")),
        "motifRegistryJson": json.dumps(motifs, separators=(",", ":")),
        "tensionSamplesJson": json.dumps(
            tension_samples, separators=(",", ":")
        ),
        "characterWantNeedJson": json.dumps(
            character_arcs, separators=(",", ":")
        ),
    }


def deserialize_state(
    row: Optional[Dict[str, Any]],
    fallback_structure: NarrativeStructure = "save_the_cat",
) -> ReelNarrativeState:
    """Hydrate a `ReelNarrativeState` from a Convex
    `reelNarrativeState` row. When `row` is None (first-run), returns
    a fresh empty state for the fallback structure.

    Malformed JSON is treated as empty for that field — we'd rather
    an agent turn on a missing-payload reel than crash the whole
    pipeline on a single corrupted row. Loggers upstream should notice
    if this starts happening systematically."""
    if not row:
        return empty_reel_narrative_state(fallback_structure)
    structure = row.get("structure") or fallback_structure
    beats = _parse_json_list(row.get("beatMapJson"))
    motifs = _parse_json_dict(row.get("motifRegistryJson"))
    tension_samples = _parse_json_list(row.get("tensionSamplesJson"))
    character_arcs = _parse_json_list(row.get("characterWantNeedJson"))
    return ReelNarrativeState(
        structure=structure,  # type: ignore[arg-type]
        beats=[_coerce_beat(b) for b in beats if isinstance(b, dict)],
        motifs={
            k: _coerce_motif(v)
            for k, v in motifs.items()
            if isinstance(v, dict)
        },
        tension_samples=[
            _coerce_tension_sample(s)
            for s in tension_samples
            if isinstance(s, dict)
        ],
        character_arcs=[
            _coerce_character_arc(a)
            for a in character_arcs
            if isinstance(a, dict)
        ],
        computed_from_commit_id=str(row.get("computedFromCommitId") or ""),
        stale=bool(row.get("stale", False)),
    )


def _parse_json_list(raw: Any) -> List[Any]:
    if not isinstance(raw, str) or not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _parse_json_dict(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _coerce_beat(obj: Dict[str, Any]) -> BeatAssignment:
    out: BeatAssignment = {"beatKey": str(obj.get("beatKey", ""))}
    if "expectedActNumber" in obj and isinstance(
        obj["expectedActNumber"], (int, float)
    ):
        out["expectedActNumber"] = int(obj["expectedActNumber"])
    if isinstance(obj.get("nodeId"), str):
        out["nodeId"] = obj["nodeId"]
    status = obj.get("status")
    if status in ("planned", "assigned", "missing"):
        out["status"] = status  # type: ignore[typeddict-item]
    else:
        out["status"] = "planned"
    if isinstance(obj.get("rationale"), str):
        out["rationale"] = obj["rationale"]
    return out


def _coerce_motif(obj: Dict[str, Any]) -> MotifEntry:
    out: MotifEntry = {}
    for key in ("motifKey", "description", "visualVocabulary"):
        val = obj.get(key)
        if isinstance(val, str):
            out[key] = val  # type: ignore[literal-required]
    for key in ("sourceNodeIds", "payoffNodeIds"):
        val = obj.get(key)
        if isinstance(val, list):
            out[key] = [str(x) for x in val if isinstance(x, str)]  # type: ignore[literal-required]
    landed = obj.get("landedStatus")
    if landed in ("unplanted", "planted", "landed"):
        out["landedStatus"] = landed  # type: ignore[typeddict-item]
    return out


def _coerce_tension_sample(obj: Dict[str, Any]) -> TensionSample:
    out: TensionSample = {}
    if isinstance(obj.get("nodeId"), str):
        out["nodeId"] = obj["nodeId"]
    val = obj.get("value")
    if isinstance(val, (int, float)):
        # Clamp defensively in case an agent prompt emitted an out-of-
        # range value; the route-level validator will also clamp.
        out["value"] = max(0.0, min(10.0, float(val)))
    return out


def _coerce_character_arc(obj: Dict[str, Any]) -> CharacterArc:
    out: CharacterArc = {}
    for key in ("characterId", "want", "need", "arcStatus"):
        val = obj.get(key)
        if isinstance(val, str):
            out[key] = val  # type: ignore[literal-required]
    return out


# ------------------------------------------------------------
# Patch helpers (reconciliation rules encoded once, here)
# ------------------------------------------------------------


def apply_beat_assignments(
    state: ReelNarrativeState,
    assignments: Iterable[Dict[str, Any]],
    override: bool = False,
) -> ReelNarrativeState:
    """Map `(nodeId, beatKey)` pairs into the beat plan.

    Reconciliation rules (addresses risk #2 in the plan):
      - A slot in `planned` status → flip to `assigned` with the new
        nodeId.
      - A slot already `assigned` to a different nodeId → only
        overwrite when `override=True`. Default behavior is no-op so
        the agent cannot silently clobber a producer's manual edits.
      - A slot already `assigned` to the SAME nodeId → keep as-is
        (idempotent).
      - Unknown beatKeys are dropped (agent hallucination guard).
    """
    current = {b.get("beatKey"): b for b in state.get("beats", [])}
    for entry in assignments:
        beat_key = entry.get("beatKey")
        node_id = entry.get("nodeId")
        if not beat_key or not node_id:
            continue
        existing = current.get(beat_key)
        if existing is None:
            continue
        existing_node = existing.get("nodeId")
        if existing.get("status") == "assigned" and existing_node == node_id:
            continue
        if (
            existing.get("status") == "assigned"
            and existing_node
            and existing_node != node_id
            and not override
        ):
            continue
        existing["nodeId"] = node_id
        existing["status"] = "assigned"
        rationale = entry.get("rationale")
        if isinstance(rationale, str) and rationale.strip():
            existing["rationale"] = rationale.strip()[:400]
        act = entry.get("actNumber")
        if isinstance(act, (int, float)):
            existing["expectedActNumber"] = int(act)
    return state


def mark_missing_beats(
    state: ReelNarrativeState,
    surviving_node_ids: Iterable[str],
) -> ReelNarrativeState:
    """Flip any `assigned` slot whose nodeId is absent from the live
    graph into `missing`. Called after node deletions so the beat
    ribbon surfaces the gap."""
    alive = {
        nid for nid in surviving_node_ids if isinstance(nid, str) and nid
    }
    for beat in state.get("beats", []):
        if (
            beat.get("status") == "assigned"
            and isinstance(beat.get("nodeId"), str)
            and beat["nodeId"] not in alive
        ):
            beat["status"] = "missing"
    return state


def set_tension_sample(
    state: ReelNarrativeState,
    node_id: str,
    value: float,
) -> ReelNarrativeState:
    """Upsert a tension sample for `node_id`. Clamped to [0, 10]."""
    clamped = max(0.0, min(10.0, float(value)))
    samples = list(state.get("tension_samples", []))
    for i, s in enumerate(samples):
        if s.get("nodeId") == node_id:
            samples[i] = TensionSample(nodeId=node_id, value=clamped)
            state["tension_samples"] = samples
            return state
    samples.append(TensionSample(nodeId=node_id, value=clamped))
    state["tension_samples"] = samples
    return state


def upsert_motif(
    state: ReelNarrativeState,
    motif_key: str,
    *,
    description: Optional[str] = None,
    source_node_ids: Optional[List[str]] = None,
    payoff_node_ids: Optional[List[str]] = None,
    visual_vocabulary: Optional[str] = None,
) -> ReelNarrativeState:
    """Upsert a motif entry and recompute `landedStatus`:
       - no sources AND no payoffs → `unplanted`
       - sources present, no payoffs → `planted`
       - sources present AND payoffs present → `landed`
    """
    motifs = dict(state.get("motifs", {}))
    existing: MotifEntry = dict(motifs.get(motif_key, {}))  # type: ignore[assignment]
    existing["motifKey"] = motif_key
    if description is not None:
        existing["description"] = description
    if source_node_ids is not None:
        existing["sourceNodeIds"] = list(source_node_ids)
    if payoff_node_ids is not None:
        existing["payoffNodeIds"] = list(payoff_node_ids)
    if visual_vocabulary is not None:
        existing["visualVocabulary"] = visual_vocabulary
    sources = existing.get("sourceNodeIds") or []
    payoffs = existing.get("payoffNodeIds") or []
    if not sources and not payoffs:
        existing["landedStatus"] = "unplanted"
    elif sources and not payoffs:
        existing["landedStatus"] = "planted"
    else:
        existing["landedStatus"] = "landed"
    motifs[motif_key] = existing
    state["motifs"] = motifs
    return state


def mark_stale(state: ReelNarrativeState) -> ReelNarrativeState:
    """Flag the state as stale. Callers (commit handlers, node-mutation
    plans) use this when they can't afford a full recompute inline."""
    state["stale"] = True
    return state


def clear_stale(
    state: ReelNarrativeState,
    computed_from_commit_id: str,
) -> ReelNarrativeState:
    """Called after a full recompute. Records the commit id the state
    is current-against so incremental recomputes can detect drift."""
    state["stale"] = False
    state["computed_from_commit_id"] = computed_from_commit_id
    return state
