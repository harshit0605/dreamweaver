# CLAUDE.md — storyboard-agent

LangGraph 1.x + DeepAgents 0.4.1 service on **:8123**. Two jobs:

1. **The agent graph** — a supervisor + 9 subagents that reason about the storyboard and propose changes.
2. **The ingestion pipeline** (`viMax_port/`) — idea / screenplay / novel → a Convex-shaped narrative graph.

```bash
uv sync
uv run langgraph dev --no-browser --port 8123    # the graph (langgraph.json)
uv run uvicorn server:app --reload --port 8123   # custom FastAPI routes only
uv run pytest                                    # tests/ + viMax_port/tests/
```

Needs `.env` with at least `OPENAI_API_KEY`.

---

## The rule that shapes this whole service

**This service never writes to Convex.** Tools return deterministic JSON; mutations happen in the Next.js BFF (`agentExecutionAdapter.ts`) after a human approves. If you're reaching for an HTTP client to POST into Convex from here, you're about to break the approval gate and the audit trail — route it through a proposal + HITL interrupt instead.

The one HTTP direction that *is* allowed: `viMax_port/media_proxy.py` calling the FastAPI media backend during ingestion.

---

## Entry points

`langgraph.json` wires both:

```json
"graphs": { "storyboard_agent": "./agent.py:graph" },
"http":   { "app": "./server.py:app" }
```

`server.py` mounts `/generated` static files, `script_ingest_routes.py`, and `/health` (which reports the active `STORYBOARD_AGENT_MODE`).

---

## `agent.py` — the router

A single-node `StateGraph` that picks a runtime mode, then guards the result.

| Mode | Selected when |
|---|---|
| `v2_deep` *(default)* | otherwise |
| `v1_linear` | `team_config.teamId ∈ {legacy_linear, legacy_v1}`, or `AGENT_GLOBAL_KILL_SWITCH=true`, or the storyboard falls outside `AGENT_ROLLOUT_PERCENT` |
| `shadow_compare` | `teamId == "shadow_compare"` — runs v2, then v1, and attaches a diff |

Rollout uses `_stable_bucket(storyboardId)` — a deterministic hash, so a given storyboard always lands the same way. **If v2 behavior "isn't happening," check these two env vars before you debug the graph.**

### The policy guard

`_ACTION_POLICY_TOKENS` maps each approval action to a scope token:

```
approve_graph_patch   → graph.patch        approve_dailies_batch  → dailies.batch
approve_media_prompt  → media.prompt       approve_merge_policy   → branch.merge
approve_execution_plan→ execution.plan     approve_repair_plan    → repair.plan
approve_batch_ops     → execution.plan     select/create/update/publish/generate team → team.manage
preview_simulation_critic_plan → simulation.critic
```

If the team's `effective_tool_scope` (from Convex `agentTeams:resolveEffectiveRuntimeConfig`) denies the token, the router replaces the assistant message with `status: "blocked"` + `policyEvidence` and appends to `policy_trace`. `team.manage` is **deny-by-default** — see `DEFAULT_RUNTIME_ALLOWLIST` in `deep/tools.py`.

**Adding an approval action without an `_ACTION_POLICY_TOKENS` entry silently bypasses the allowlist.** That's the highest-consequence mistake available in this file.

Graphs are cached in `_GRAPH_CACHE`, keyed by (enabled members, allowlist). Changing how a graph is constructed without changing that key gives you a stale graph.

---

## `deep/` — the DeepAgents runtime

| File | Contents |
|---|---|
| `factory.py` | `create_storyboard_deep_agent_graph(enabled_member_names, tool_allowlist)`. Supervisor model from `STORYBOARD_AGENT_MODEL` (**default `openai:gpt-4.1-mini`**). Checkpointer: Postgres if `STORYBOARD_CHECKPOINT_POSTGRES_URI` is set, else in-memory. `_interrupt_config()` declares allowed HITL decisions per tool. |
| `subagents.py` | 9 subagents: `planner`, `continuity_critic`, `simulation_critic`, `dailies_producer`, `visual_director`, `producer_guard`, `team_architect`, `ingestion_coordinator`, `repair_agent`. Filtered by the team's enabled members. |
| `state.py` | `TypedDict`s for the wire contract: `PlanOperation`, `DryRunReport`, `SemanticDiff`, `ExecutionPlan`, `AutonomousDailiesReel`, `SimulationCriticRun`, `DelegationRecord`, `TeamRuntimeConfig`, `StoryboardDeepAgentState`. These mirror `frontend/src/app/storyboard/types.ts` — change one, change both. |
| `tools.py` (1255) | Every `@tool`, plus the allowlist machinery. |

`deep/__init__.py` degrades gracefully: if DeepAgents deps are missing, `create_storyboard_deep_agent_graph` raises a clear `RuntimeError` instead of an import error at module load. Preserve that.

### Tools, in two families

**Propose / compute** (no side effects, return JSON):
`planner_propose_graph_patch`, `planner_propose_media_prompt`, `simulate_execution_plan`, `continuity_critic`, `producer_guard`, `recommend_ingestion_path`, `request_ingestion_run`, `request_generate_shot_batch`, `request_generate_shot_video_batch`, `request_generate_shot_audio_batch`, `request_export_reel`, `repair_plan`, `build_autonomous_dailies_batch`, `simulate_story_playthrough`

**Approval / HITL** (raise interrupts, consumed by the frontend bridge):
`approve_graph_patch`, `approve_media_prompt`, `approve_execution_plan`, `approve_batch_ops`, `preview_simulation_critic_plan`, `approve_dailies_batch`, `approve_merge_policy`, `approve_repair_plan`, `select_agent_team`, `create_agent_team`, `update_agent_team_member`, `publish_agent_team_revision`, `generate_team_from_prompt`

**Guards** — validate before you emit: `ALLOWED_NODE_TYPES`, `ALLOWED_EDGE_TYPES`, `ALLOWED_GRAPH_OPS`, `ALLOWED_INGESTION_MODES`, `_sanitize_graph_operations()`.

### Allowlist semantics — three non-obvious rules

`TOOL_POLICY_TOKENS` maps **tool name → scope token**. `filter_tools_by_allowlist()` runs at graph init and:

> **drops any tool with no `TOOL_POLICY_TOKENS` entry — silently.** "Tools without a policy token can't be governed."

So a new tool that you forget to register doesn't error; it just never reaches the model, and you get a confusing "the agent won't use my tool" bug. Register it.

`is_tool_allowed(allowlist, token)`:

- **empty allowlist** → falls back to `DEFAULT_RUNTIME_ALLOWLIST` (14 tokens; `team.manage` is *not* among them — that's the deny-by-default)
- **`["*"]`** → allows everything. Fine for local dev, a hole in anything shared.
- **`media.prompt` grants every `media.*` token** — a legacy prefix expansion. Don't rely on `media.<something>` being independently gated.

Note there are **two** token maps and they must agree: `TOOL_POLICY_TOKENS` (tool name → token, in `deep/tools.py`, enforced at graph init) and `_ACTION_POLICY_TOKENS` (approval action → token, in `agent.py`, enforced on the result).

### Adding a tool — the checklist

1. `@tool` in `deep/tools.py`, output validated against the `ALLOWED_*` sets.
2. Append to `ALL_TOOLS` (and `SUPERVISOR_CORE_TOOLS` if the supervisor calls it directly).
3. **Add to `TOOL_POLICY_TOKENS`** — omit this and the tool is silently dropped at graph init.
4. If it interrupts: add to `_interrupt_config()` in `deep/factory.py` with its `allowed_decisions`.
5. If it's an approval action: add to `_ACTION_POLICY_TOKENS` in `agent.py` — omit this and it bypasses the allowlist.
6. Cross the boundary: `useCopilotAction` in `StoryboardCopilotBridge.tsx`, executor in `agentExecutionAdapter.ts`.
7. Test in `tests/`.

Steps 3 and 5 fail in opposite directions: forgetting 3 makes the tool invisible, forgetting 5 makes it ungoverned. Neither raises.

---

## `viMax_port/` — ingestion

Ported from upstream ViMax (the root `ViMax/` dir is empty). Pipeline stages:

```
idea      → idea_ingester → screenwriter ─┐
screenplay → screenplay_preprocessor → screenplay_ingester ─┤
novel     → novel_compressor → episode_splitter → novel_ingester ─┘
                                                          ↓
              character_extractor → character_portraits_generator
                                                          ↓
                              storyboard_artist → mapper → Convex-shaped nodes/edges
```

- **`types.py` is the cross-language contract.** Fields are **camelCase on purpose** so payloads forward into Convex `bulkCreateNodes` / `bulkCreateEdges` with no remapping. Don't snake_case them. It mirrors `frontend/src/app/storyboard/types.ts`.
- **`llm_factory.py`** — OpenAI, default **`gpt-5.4`**, override `VIMAX_PORT_LLM_MODEL`. Chosen for structured-output reliability; the pipeline leans on deeply nested Pydantic schemas. Note this is a *different* model from the supervisor's `STORYBOARD_AGENT_MODEL`.
- **`mapper.py`** — descriptions → `ShotMeta` (size/angle/lens/move/aspect) and node/edge ids. Well covered by `tests/test_mapper.py` (467 lines); extend those when you change heuristics.

### `script_ingest_routes.py`

Blocking: `/script-ingest`, `/idea-ingest`, `/novel-ingest`.
Streaming: `/script-ingest-stream`, `/idea-ingest-stream`, `/novel-ingest-stream` — SSE via `_sse_format` + `_run_with_event_stream`.

Both variants must stay behaviorally identical; the Next.js side calls whichever fits its timeout budget.

---

## Environment

```
OPENAI_API_KEY                              required
STORYBOARD_AGENT_MODE                       v2_deep | v1_linear | shadow_compare
STORYBOARD_AGENT_MODEL                      supervisor model (default openai:gpt-4.1-mini)
VIMAX_PORT_LLM_MODEL                        ingestion model (default gpt-5.4)
AGENT_GLOBAL_KILL_SWITCH                    "true" forces v1_linear
AGENT_ROLLOUT_PERCENT                       0-100, stable hash bucket on storyboardId
STORYBOARD_CHECKPOINT_POSTGRES_URI          Postgres checkpointer; in-memory if unset
STORYBOARD_CHECKPOINT_POSTGRES_MAX_CONN
```

Postgres for local HITL persistence: `docker compose -f docker-compose.postgres.yml up -d`. Without it, thread state dies with the process and interrupts can't resume.

---

## Style

- `from __future__ import annotations`, typed throughout, Python 3.12.
- Tool outputs are **machine objects, not prose** — deterministic JSON the frontend can execute against.
- Failure mode is a structured `{"status": "blocked" | "failed", "blockedReason": ..., "nextAction": "manual_mode"}` payload, not an exception. See `_apply_policy_guard` in `agent.py`.
- Optional imports degrade to a clear runtime error rather than crashing at import (`deep/__init__.py`, `linear_agent` import in `agent.py`).
