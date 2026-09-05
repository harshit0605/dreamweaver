# Dreamweaver — Repo Context (AI.md)

> Working context for AI assistants. Generated 2026-09-05 from the state of `main` @ `27a2b39`.
> Keep this file updated when architecture, contracts, or run commands change.
>
> **Working rules and conventions live in the `CLAUDE.md` set** — read those before changing code:
> [`CLAUDE.md`](./CLAUDE.md) (root: invariants, commands, gotchas) ·
> [`dreamweaver-frontend/CLAUDE.md`](./dreamweaver-frontend/CLAUDE.md) ·
> [`dreamweaver-frontend/convex/CLAUDE.md`](./dreamweaver-frontend/convex/CLAUDE.md) ·
> [`dreamweaver-backend/CLAUDE.md`](./dreamweaver-backend/CLAUDE.md) ·
> [`storyboard-agent/CLAUDE.md`](./storyboard-agent/CLAUDE.md)
>
> This file is the **inventory** (what exists, where). Those are the **manual** (how to change it safely).

---

## 1. What this is

**Dreamweaver** is an AI film pre-production / storyboard system. You give it an *idea*, a *screenplay*, or a *novel*, and it produces a **narrative graph** (scenes → shots) with character identity continuity, generated shot images, image-to-video renders, TTS narration, and an exportable reel.

Three deployable services in one mono-repo, plus a Convex backend-as-a-database:

| Service | Dir | Stack | Local port |
|---|---|---|---|
| Frontend / BFF | `dreamweaver-frontend` | Next.js 16 (App Router, React 19), Bun, Tailwind v4, shadcn/Radix, ReactFlow | `3002` |
| Media backend | `dreamweaver-backend` | FastAPI + `uv` (Python 3.12) | `8001` (`8000` in its README) |
| Agent service | `storyboard-agent` | LangGraph 1.x + DeepAgents 0.4.1 + FastAPI | `8123` |
| Database / auth | `dreamweaver-frontend/convex` | Convex + Better Auth | (cloud/dev daemon) |

`ViMax/` and `scene-creator-copilot/` are **empty directories** (upstream ViMax was ported into `storyboard-agent/viMax_port/`). `docs/` is gitignored.

---

## 2. Repo layout

```
dreamweaver/
├── AI.md                       ← this file
├── .claude/launch.json         ← 4 launch configs: backend / langgraph / frontend / convex
├── scripts/                    ← start_storyboard_local.{sh,ps1}, stop_storyboard_local.{sh,ps1}
├── skills/
│   ├── storyboard-local-dev/   ← SKILL.md for booting the local stack (+ .runlogs/)
│   └── frontend_design_skill/
├── .agent/skills/cove/
├── dreamweaver-frontend/       ← Next.js app + Convex functions (~46k LOC src, ~11k LOC convex)
├── dreamweaver-backend/        ← FastAPI media exec (~5.4k LOC)
├── storyboard-agent/           ← LangGraph service (~7.4k LOC)
├── ViMax/                      ← EMPTY
└── scene-creator-copilot/      ← EMPTY
```

---

## 3. Architecture / data flow

```
                      ┌──────────────────────────────────────┐
   Browser ──────────►│  Next.js (3002)                      │
   (ReactFlow canvas, │  - pages: /, /auth, /image, /video,  │
    CopilotKit chat)  │    /edit, /storyboard, /storyboard/id│
                      │  - BFF: /api/* route handlers        │
                      └───┬───────────┬──────────────┬───────┘
                          │           │              │
             CopilotKit   │           │ SSE fan-out  │ direct
             runtime      │           │ + orchestr.  │ mutations
                          ▼           ▼              ▼
          ┌───────────────────┐  ┌──────────────┐  ┌──────────────────┐
          │ storyboard-agent  │  │ dreamweaver- │  │ Convex           │
          │ (LangGraph 8123)  │  │ backend 8001 │  │ (37 tables)      │
          │ graph: storyboard_│  │ FastAPI      │  │ + Better Auth    │
          │ agent + /script-  │  │ image/video/ │  │ source of truth  │
          │ ingest* routes    │  │ consistency  │  └──────────────────┘
          └─────────┬─────────┘  └──────┬───────┘
                    │                    │
             OpenAI (gpt-5.4)      Modal / OpenAI / Google
             LangSmith             (image, edit, multiview, video)
```

**Key rule:** the agent service **never writes to Convex**. It returns deterministic JSON proposals + HITL interrupts; the Next.js BFF (`agentExecutionAdapter.ts`) is the only thing that applies mutations, after human approval.

### The three entry pipelines (ingestion)

1. **idea → story → screenplay → storyboard** (`/api/storyboard/ingest-stream` mode=`idea`, or `ingest-idea`)
2. **screenplay → storyboard** (`ingest-stream` mode=`screenplay`, or `ingest-screenplay`)
3. **novel → compress → episodes → screenplay → storyboard** (`ingest-novel-stream`)

All hit `storyboard-agent`'s FastAPI custom routes (`script_ingest_routes.py`: `/script-ingest`, `/idea-ingest`, `/novel-ingest` and their `-stream` SSE variants), which drive `viMax_port/*`. Results come back as camelCase Pydantic payloads (`viMax_port/types.py`) shaped to feed Convex `bulkCreateNodes` / `bulkCreateEdges` **without remapping**. The Next route then runs `src/lib/ingest-postprocess/processor.ts` — portrait generation + Convex writes — emitting fine-grained SSE.

### Generation batches (all SSE, bounded-concurrency worker pools)

- `generate-shots-stream` — per-shot image render, character-consistent reference images picked by `src/lib/shot-batch/selector.ts`. Supports `skipExisting`, `flaggedOnly` (regenerate NG dailies), explicit `nodeIds`.
- `generate-shot-videos-stream` — image→video (LTX-2.3).
- `generate-shot-audios-stream` — per-shot TTS narration, speaker-aware voice casting (M6).
- `export-reel` / `reel-manifest` — reel assembly; ffmpeg.wasm client fallback in `src/lib/reel-export/client.ts`.

**SSE protocol** (consistent across routes): frames are `event: <type>\ndata: <json>\n\n`; every stream emits `open`, `ping` (15s heartbeat), domain events, then terminal `done` or `error`. Client hooks: `src/lib/sse-ingest/use{Ingest,NovelIngest,ShotBatch}Stream.ts`, parser in `parse.ts`.

---

## 4. `storyboard-agent` (LangGraph)

Entrypoints: `langgraph.json` → graph `storyboard_agent` = `agent.py:graph`; HTTP app = `server.py:app`.

`agent.py` is a **router** (`StateGraph` with a single `dispatch` node) that selects a runtime mode:

| Mode | Trigger |
|---|---|
| `v2_deep` (default) | DeepAgents supervisor + subagents + HITL |
| `v1_linear` | `team_config.teamId ∈ {legacy_linear, legacy_v1}`, or `AGENT_GLOBAL_KILL_SWITCH=true`, or rollout bucket miss |
| `shadow_compare` | `teamId == shadow_compare` — runs v2 primary + v1 diagnostics |

Rollout control: `AGENT_ROLLOUT_PERCENT` (0-100) with a stable hash bucket on `storyboardId`.

**Policy guard** — `_ACTION_POLICY_TOKENS` maps each approval action to a scope token (e.g. `approve_graph_patch` → `graph.patch`, `select_agent_team` → `team.manage`). If the resolved team's `effective_tool_scope` allowlist denies the token, the router replaces the result with a `status: "blocked"` payload carrying `policyEvidence` and appends to `policy_trace`. `team.manage` is deny-by-default.

**`deep/` package:**
- `factory.py` — `create_storyboard_deep_agent_graph(enabled_member_names, tool_allowlist)`; builds checkpointer (Postgres via `STORYBOARD_CHECKPOINT_POSTGRES_URI`, else in-mem), `CompositeBackend`, and `interrupt_on` HITL config. Graphs are cached in `agent.py:_GRAPH_CACHE` keyed by (members, allowlist).
- `subagents.py` — 9 subagents: `planner`, `continuity_critic`, `simulation_critic`, `dailies_producer`, `visual_director`, `producer_guard`, `team_architect`, `ingestion_coordinator`, `repair_agent`.
- `state.py` — TypedDicts: `PlanOperation`, `DryRunReport`, `SemanticDiff`, `ExecutionPlan`, `AutonomousDailiesReel`, `SimulationCriticRun`, `DelegationRecord`, `TeamRuntimeConfig`, `StoryboardDeepAgentState`.
- `tools.py` (1255 LOC) — all `@tool`s. Two families:
  - *propose/compute*: `planner_propose_graph_patch`, `planner_propose_media_prompt`, `simulate_execution_plan`, `continuity_critic`, `producer_guard`, `recommend_ingestion_path`, `request_ingestion_run`, `request_generate_shot_batch`, `request_generate_shot_{audio,video}_batch`, `request_export_reel`, `repair_plan`, `build_autonomous_dailies_batch`, `simulate_story_playthrough`
  - *approval/HITL*: `approve_graph_patch`, `approve_media_prompt`, `approve_execution_plan`, `approve_batch_ops`, `preview_simulation_critic_plan`, `approve_dailies_batch`, `approve_merge_policy`, `approve_repair_plan`, `select_agent_team`, `create_agent_team`, `update_agent_team_member`, `publish_agent_team_revision`, `generate_team_from_prompt`
  - Guards: `ALLOWED_NODE_TYPES`, `ALLOWED_EDGE_TYPES`, `ALLOWED_GRAPH_OPS`, `ALLOWED_INGESTION_MODES`, `is_tool_allowed()`, `filter_tools_by_allowlist()`.

**`viMax_port/`** — the ported ViMax pipeline: `idea_ingester`, `screenplay_preprocessor`/`screenplay_ingester`, `novel_compressor`/`novel_ingester`, `episode_splitter`, `screenwriter`, `character_extractor`, `character_portraits_generator`, `storyboard_artist`, `mapper` (→ Convex-shaped nodes/edges), `types.py` (camelCase Pydantic contract), `llm_factory.py` (OpenAI **gpt-5.4** default, override `VIMAX_PORT_LLM_MODEL`), `media_proxy.py`.

---

## 5. `dreamweaver-backend` (FastAPI)

`main.py` → routers under `/api` + a top-level video router. Startup calls `providers.registry.initialize_providers()`.

Endpoints:
- `GET  /api/models?type=image|video|edit`
- `POST /api/image/generate`, `/api/image/edit`, `/api/image/compose` (multi-reference), `POST /api/image/build-prompt`, `GET /api/image/models`
- `POST /api/video/generate`, `/api/video/retake`
- `POST /api/consistency/evaluate` — identity/wardrobe continuity scoring
- `GET /`, `GET /health`

**Provider registry** (`providers/registry.py`): class-level maps model-id → provider. Registered at boot: `OpenAIImageProvider`, `ModalImageProvider`. Video providers exist under `providers/modal/video.py` and `providers/google/video.py`.

**Model catalog** (`config/models.py`): `gpt-image-1`, `dall-e-3`, `dall-e-2`, `zennah-image-gen`, `zennah-qwen-edit`, `zennah-qwen-multiview`, `ltx-2.3`, `ltx-2`, `veo-3.1`, `sora-2`.

`utils/` — `file_upload.py`, `s3_upload.py`, `video_utils.py`. `services/prompt_builder.py`. `scripts/` are ad-hoc manual test/debug scripts (**not** a pytest suite) writing into `test_outputs/`.

CORS is a hardcoded localhost:3000-3005 list + `https://dreamweaver-s6j9.vercel.app`.

---

## 6. `dreamweaver-frontend`

### Pages
`/` · `/auth` · `/image` · `/video` · `/edit` · `/storyboard` (library) · `/storyboard/[storyboardId]` (editor, 2376 LOC)

### The two hot files
- **`src/components/storyboard/StoryboardCopilotBridge.tsx` (3245 LOC)** — registers the `storyboard_agent` CopilotKit agent plus a `useCopilotAction` per HITL approval (`approve_graph_patch`, `approve_media_prompt`, `approve_execution_plan`, `preview_simulation_critic_plan`, `approve_batch_ops`, `approve_dailies_batch`, `approve_merge_policy`, `approve_repair_plan`, team-management actions). Renders approval UI, forwards accept/reject.
- **`src/app/storyboard/agentExecutionAdapter.ts` (1748 LOC)** — the *only* place agent proposals become Convex writes: `executeApprovedGraphPatch`, `executeRejectedGraphPatch`, `executeApprovedMediaPrompt`, `executeRejectedMediaPrompt`, `executeApprovedExecutionPlan`, `executeRejectedExecutionPlan`.

### Panels (`src/components/storyboard/`)
`StoryGraph` (ReactFlow) · `CustomNode` · `CanvasToolbar` · `PropertiesPanel` (1262) · `ChatPanel` · `ContinuityOSPanel` (785) · `ReviewPanel` (754) · `DeliveryMatrixSection` (747) · `ReelPlayer` (576) · `TeamBuilderPanel` · `MissionConsolePanel` · `ProductionHubDrawer` · `OutlinePanel` · `DailiesBoardPanel` · `SimulationCriticPanel` · `TimelineTheaterPanel` · `ReviewInboxPanel` · ingest forms (`Idea`/`Screenplay`/`Novel`) · `IngestProgressPanel` · `CameoUploadDialog` · `CherryPickDialog` · `ExportMenu` · `GenerateAll{Shots,Videos,Audios}Button` · `RegenerateFlaggedButton`

### Domain libs (`src/lib/`) — most have `__tests__`
`shot-batch` (reference-image selector) · `identity-portraits` (canonical views) · `continuity-critic` (prompt + parse) · `continuity-validators` (axis / eyeline / thirty-degree / walk) · `screenplay` (fountain, fdx, edl, fcpxml, timecode, traverse) · `dialogue-extract` · `delivery-matrix` · `cut-tier` · `cherry-pick` · `cameo` · `reel-export` · `review` · `ingest-postprocess` · `sse-ingest` · `observability` (structured JSON logs + request-id correlation) · `llm` (`LLMFactory` → Gemini text/structure, Modal image/video, ElevenLabs/Suno audio) · `auth-client` / `auth-server` / `convexRefs`

`src/server/vault/adapter.ts` — resolves provider secrets via Convex `secretHandles` (`resolveSecretByHandleId`, `resolveSecretByProviderScope`), with env fallback.

### Convex (`dreamweaver-frontend/convex/`, 37 tables)
Domain groups:
- **Graph**: `storyboards`, `storyboardNodes`, `storyboardEdges`, `scenes`, `shots`, `storyEvents`, `nodeHistoryContexts`
- **Entities/continuity**: `characters`, `wardrobeVariants`, `backgrounds`, `identityPacks`, `identityReferenceAssets`, `globalConstraints`, `continuityViolations`
- **Media**: `mediaAssets`, `mediaComments`, `generations`, `reelExports`
- **Narrative git**: `narrativeBranches`, `narrativeCommits`, `semanticDiffs`, `dryRunReports`
- **Agent/HITL**: `agentRuns`, `approvalTasks`, `agentDelegations`, `autonomousDailies`, `simulationCriticRuns`
- **Teams/governance**: `agentTeams`, `agentTeamRevisions`, `agentTeamAssignments`, `agentTeamMembers`, `agentTeamRunPolicies`, `teamPromptDrafts`, `quotaProfiles`, `quotaUsageWindows`, `secretHandles`, `toolCallAudits`

Notable modules: `storyboards.ts` (2117 — CRUD, trash/restore/purge, duplicate, `applyGraphPatch`, `bulkCreateNodes/Edges`, `compileNodePromptPack`, `refreshNodeHistoryContexts`), `agentTeams.ts` (1229 — revisions, publish/rollback, `resolveEffectiveRuntimeConfig`), `narrativeGit.ts` (1165 — branch/commit/cherry-pick/merge-policy/semantic-diff/rollback), `mediaAssets.ts` (992 — variants, takes, delivery matrix, promote-to-master), `dailies.ts` (887), `continuityOS.ts` (463).

Auth: Better Auth via `@convex-dev/better-auth`; config in `better-auth-config.ts`, `convex/auth.ts`, `convex/auth.config.ts`, generated schema at `convex/auth_config/schema.ts`; route `src/app/api/auth/[...all]/route.ts`.

---

## 7. Running locally

```bash
# one-shot launcher (writes logs + PIDs to .runlogs/)
./scripts/start_storyboard_local.sh            # macOS/Linux
./scripts/stop_storyboard_local.sh
#   flags: --backend-port N --langgraph-port N --frontend-port N (+ PS1 has -SkipBackend/-IncludeConvex)
```

Or per-service:

```bash
# backend  :8001
cd dreamweaver-backend && uv sync && uv run uvicorn main:app --reload --port 8001

# agent    :8123
cd storyboard-agent && uv sync && uv run langgraph dev --no-browser --port 8123

# frontend :3002
cd dreamweaver-frontend && bun install && bun run dev
cd dreamweaver-frontend && bun run convex:dev        # Convex dev daemon
cd dreamweaver-frontend && bun run auth:generate-schema
```

Tests: `cd dreamweaver-frontend && bun test` (~50 test files) · `cd storyboard-agent && uv run pytest` (`tests/`, `viMax_port/tests/`).
Lint: `bun run lint`. Build: `bun run build`.

Env files expected: `dreamweaver-backend/.env`, `dreamweaver-frontend/.env.local`, `storyboard-agent/.env` (all gitignored).

---

## 8. Environment variables

**Frontend / Convex**
```
NEXT_PUBLIC_API_URL            # → FastAPI backend (8001)
API_URL
NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL, CONVEX_SITE_URL, CONVEX_DEPLOYMENT
SITE_URL, BETTER_AUTH_SECRET
BETTER_AUTH_INSECURE_COOKIES, BETTER_AUTH_ALLOW_DEV_PASSWORD_RESET   # dev only
LANGGRAPH_STORYBOARD_DEPLOYMENT_URL   # → 8123 (CopilotKit runtime)
STORYBOARD_AGENT_BASE_URL             # → 8123 (SSE ingest routes)
LANGSMITH_API_KEY, LANGSMITH_SECRET_HANDLE_ID
OPENAI_API_KEY, GEMINI_API_KEY, NEXT_PUBLIC_GEMINI_API_KEY
ELEVENLABS_API_KEY, SUNO_API_KEY
NEXT_PUBLIC_MEDIA_SECRET_HANDLE_ID, VAULT_ACCESS_TOKEN
```

**storyboard-agent**
```
OPENAI_API_KEY
STORYBOARD_AGENT_MODE            # v2_deep | v1_linear | shadow_compare
STORYBOARD_AGENT_MODEL
VIMAX_PORT_LLM_MODEL             # default gpt-5.4
AGENT_GLOBAL_KILL_SWITCH         # "true" forces v1_linear
AGENT_ROLLOUT_PERCENT            # 0-100
STORYBOARD_CHECKPOINT_POSTGRES_URI, STORYBOARD_CHECKPOINT_POSTGRES_MAX_CONN
```

**dreamweaver-backend** (`config/settings.py`, pydantic-settings)
```
OPENAI_API_KEY, FAL_API_KEY, REPLICATE_API_KEY, MODAL_API_KEY
GOOGLE_API_KEY, GOOGLE_PROJECT_ID
UPLOAD_API_ENDPOINT, UPLOAD_API_KEY, UPLOAD_API_KEY_ID
S3_BUCKET, S3_REGION
DEBUG
```

---

## 9. Conventions & invariants

1. **Agent proposes, BFF disposes.** LangGraph tools return deterministic machine JSON; nothing mutates Convex except the Next.js layer after explicit approval. Preserve this when adding tools.
2. **camelCase across the Python↔TS boundary.** `viMax_port/types.py` is deliberately camelCase so payloads forward straight into Convex mutations.
3. **Every long-running route is SSE** with `open` / `ping`(15s) / domain events / `done` | `error`, `runtime = "nodejs"`, explicit `maxDuration`, and an internal abort timeout set *below* `maxDuration`.
4. **Policy tokens gate approval actions.** Adding an approval action means adding it to `_ACTION_POLICY_TOKENS` in `agent.py` *and* wiring a `useCopilotAction` in `StoryboardCopilotBridge.tsx` *and* an executor in `agentExecutionAdapter.ts`.
5. **Secrets go through `secretHandles`**, resolved server-side by `src/server/vault/adapter.ts`; env vars are the fallback, not the primary path.
6. **Backend model additions** need an entry in `config/models.py` and registration in `providers/registry.py:initialize_providers()`.
7. Observability: structured JSON logs + request-id correlation (`src/lib/observability`), threaded through SSE routes into Python sub-calls.

---

## 10. Milestone history (from git)

`M1` Script2Video ingestion → `M2` 3-view portraits + ref-image plumbing + batch shot gen → `M3` idea2video, SSE streaming, novel2video, LangGraph HITL, shot-context-aware portrait ranking, user-photo cameo w/ consent+watermark → `M4` per-shot image→video (LTX-2.3) → `M5` per-shot TTS narration, "Watch reel" sequential preview, mp4 export, reel persistence, chat export, ffmpeg.wasm fallback, dailies, composition → `M6` voice cast (per-character TTS + speaker-aware narration).

Also landed: Postgres checkpointer lifecycle + docker-compose (`storyboard-agent/docker-compose.postgres.yml`), structured observability, cameo upload to Convex storage, two QA dogfooding punch-list rounds.

---

## 11. Known rough edges

- `ViMax/` and `scene-creator-copilot/` are empty — dead directories.
- `dreamweaver-frontend/tmp_spec.json` and `tmp_function_spec.json` (~278 KB each) are committed scratch files.
- Backend README says port 8000; `.claude/launch.json` and the launcher scripts use 8001.
- Backend `scripts/` are manual test scripts, not an automated suite — there is no pytest config for `dreamweaver-backend`.
- Backend CORS origins are hardcoded in `main.py` (localhost 3000-3005 + one Vercel domain).
- No root-level README, CLAUDE.md, or CI config.
- `convex/_debugAuth.ts` exposes dev-only auth probes (`probeAuthSignUp`, `resetPasswordDev`) — should not be reachable in prod.
