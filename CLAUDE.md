# CLAUDE.md — Dreamweaver

AI film pre-production. Idea / screenplay / novel → narrative graph (scenes → shots) → character-consistent shot images → image-to-video → TTS narration → exportable reel.

**Deep reference: [`AI.md`](./AI.md)** — full inventory (44 Convex tables, every endpoint, every lib, milestone history). Read it when you need breadth. This file is the operating manual.

Per-area guides load automatically when you work in them:
`dreamweaver-frontend/CLAUDE.md` · `dreamweaver-frontend/convex/CLAUDE.md` · `dreamweaver-backend/CLAUDE.md` · `storyboard-agent/CLAUDE.md`

---

## Service map

| Service | Dir | Stack | Port | Role |
|---|---|---|---|---|
| Frontend + BFF | `dreamweaver-frontend` | Next.js 16, React 19, Bun, Tailwind v4, ReactFlow | 3002 | UI **and** all orchestration |
| Database | `dreamweaver-frontend/convex` | Convex + Better Auth | — | Source of truth |
| Agent | `storyboard-agent` | LangGraph 1.x + DeepAgents 0.4.1 | 8123 | Proposals + HITL, ingestion pipeline |
| Media | `dreamweaver-backend` | FastAPI, `uv`, Python 3.12 | 8001 | Image/video/consistency execution |

`ViMax/` and `scene-creator-copilot/` are empty. ViMax lives at `storyboard-agent/viMax_port/`.

---

## The five invariants

Violating any of these produces code that looks fine and breaks in production. They are the reason this repo is shaped the way it is.

### 1. The agent proposes, the BFF disposes

`storyboard-agent` **never writes to Convex.** It returns deterministic JSON and raises HITL interrupts. The only code path from an agent decision to a database mutation is `dreamweaver-frontend/src/app/storyboard/agentExecutionAdapter.ts`, and it runs only after a human approves.

If you find yourself adding a Convex client to the Python side, stop — you're about to break the audit trail and the approval gate.

### 2. A new approval action means editing three files, in lockstep

```
storyboard-agent/deep/tools.py       @tool def approve_x(...)             ← the tool
                                     ALL_TOOLS += approve_x
                                     TOOL_POLICY_TOKENS["approve_x"]      ← or it's dropped at init
storyboard-agent/deep/factory.py     _interrupt_config()                  ← allowed decisions
storyboard-agent/agent.py            _ACTION_POLICY_TOKENS["approve_x"]   ← or it bypasses the allowlist
  ↓
dreamweaver-frontend/src/components/storyboard/StoryboardCopilotBridge.tsx
                                     useCopilotAction({ name: "approve_x" })  ← render + accept/reject
  ↓
dreamweaver-frontend/src/app/storyboard/agentExecutionAdapter.ts
                                     executeApproved* / executeRejected*      ← the mutation
```

None of these omissions raise. Missing `TOOL_POLICY_TOKENS` → the tool never reaches the model ("the agent ignores my tool"). Missing `_ACTION_POLICY_TOKENS` → the action runs *ungoverned*, skipping the team allowlist. Missing the bridge action → the interrupt hangs with no UI.

Only three adapter executor pairs exist; most actions reuse `executeApprovedExecutionPlan` / `executeRejectedExecutionPlan` with a different `taskType` (`execution_plan` | `batch_ops` | `dailies_batch` | `simulation_critic_batch` | `repair_plan`). Prefer reusing them over adding a fourth pair.

### 3. Convex is addressed by string, not by generated type

`convex/_generated/` is **gitignored and not present in a fresh clone.** Nothing imports `api.foo.bar`. Every call site goes through `src/lib/convexRefs.ts`:

```ts
useMutation(mutationRef("storyboards:upsertNode"))
useQuery(queryRef("storyboards:getStoryboardSnapshot"), { storyboardId })
```

These are `as unknown as FunctionReference` casts. **A typo in that string is not a compile error** — it fails at runtime. When you add or rename a Convex function, grep the whole `src/` tree for the old string. The test suite is the only net.

Run `bun run convex:dev` once before building; without `_generated/` the Convex functions themselves won't typecheck (the app `tsconfig.json` excludes `convex/`, so `bun run build` passes regardless — which hides the breakage).

### 4. The Python↔TS boundary is camelCase, deliberately

`storyboard-agent/viMax_port/types.py` uses camelCase Pydantic fields so ingestion payloads forward straight into Convex `bulkCreateNodes` / `bulkCreateEdges` with zero remapping. Don't "fix" it to snake_case.

### 5. Long-running work is SSE, with a fixed frame protocol

Every ingestion and batch route streams. Frames are `event: <type>\ndata: <json>\n\n`. Every stream emits `open`, `ping` every 15 s (proxies close idle connections), domain events, then a terminal `done` **or** `error`. Route handlers set `runtime = "nodejs"`, an explicit `maxDuration`, and an internal abort timeout **below** `maxDuration` so the client sees a clean error instead of a truncated stream.

Copy the shape from `src/app/api/storyboard/ingest-stream/route.ts`. Client side: `src/lib/sse-ingest/`.

---

## Running it

```bash
./scripts/start_storyboard_local.sh      # all services; logs + PIDs → .runlogs/
./scripts/stop_storyboard_local.sh
# flags: --backend-port N --langgraph-port N --frontend-port N
```

Individually:

```bash
cd dreamweaver-backend  && uv sync && uv run uvicorn main:app --reload --port 8001
cd storyboard-agent     && uv sync && uv run langgraph dev --no-browser --port 8123
cd dreamweaver-frontend && bun install && bun run convex:dev   # leave running
cd dreamweaver-frontend && bun run dev
```

Requires three gitignored env files: `dreamweaver-backend/.env`, `dreamweaver-frontend/.env.local`, `storyboard-agent/.env`. See `AI.md` §8 for the full variable list.

**Verify before you claim done:**

```bash
cd dreamweaver-frontend && bun test && bun run lint     # ~50 test files
cd storyboard-agent     && uv run pytest               # tests/ + viMax_port/tests/

# Playwright e2e (needs services running; `bun run test:e2e:install` once)
cd dreamweaver-frontend && bun run test:e2e
```

`dreamweaver-backend` has **no automated tests** — `scripts/test_*.py` are manual scripts that call live APIs and write to `test_outputs/`. Don't run them expecting a test suite, and don't cite them as passing tests.

---

## Where things live

| You're changing… | Go to |
|---|---|
| Storyboard canvas / editor UI | `src/app/storyboard/[storyboardId]/page.tsx` (2.4k LOC), `src/components/storyboard/` |
| Agent chat, HITL approval UI | `src/components/storyboard/StoryboardCopilotBridge.tsx` (3.2k LOC) |
| Agent decision → DB | `src/app/storyboard/agentExecutionAdapter.ts` |
| Agent reasoning, tools, subagents | `storyboard-agent/deep/tools.py`, `deep/subagents.py` |
| Mode routing, policy guard, rollout | `storyboard-agent/agent.py` |
| Ingestion (idea/screenplay/novel) | `storyboard-agent/viMax_port/`, `script_ingest_routes.py` |
| Batch generation routes | `src/app/api/storyboard/generate-*-stream/route.ts` |
| Schema / queries / mutations | `convex/` — see `convex/CLAUDE.md` |
| Image/video model plumbing | `dreamweaver-backend/providers/`, `config/models.py` |
| Continuity rules | `src/lib/continuity-validators/`, `src/lib/continuity-critic/` |
| Screenplay import/export formats | `src/lib/screenplay/` (fountain, fdx, edl, fcpxml) |

---

## Gotchas that have bitten before

- **Two different LLM defaults.** The DeepAgents supervisor defaults to `openai:gpt-4.1-mini` (`STORYBOARD_AGENT_MODEL`); the ViMax ingestion pipeline defaults to `gpt-5.4` (`VIMAX_PORT_LLM_MODEL`). They are not the same knob.
- **Port drift.** `dreamweaver-backend/README.md` says 8000; `.claude/launch.json` and both launcher scripts use 8001. 8001 is what actually runs.
- **Backend CORS is a hardcoded list** in `main.py` (localhost:3000–3005 + one Vercel host). A new frontend port needs an entry there.
- **`team.manage` is deny-by-default** in the tool allowlist. Team-management actions won't fire unless the resolved team grants the token.
- **Kill switches are live:** `AGENT_GLOBAL_KILL_SWITCH=true` forces every run to `v1_linear`; `AGENT_ROLLOUT_PERCENT` buckets by a stable hash of `storyboardId`. If v2 behavior "isn't happening," check these before debugging the graph.
- **Secrets prefer the vault.** `secretHandles` in Convex, resolved by `src/server/vault/adapter.ts`. Env vars are the fallback path, not the primary one.
- **`convex/_debugAuth.ts`** exposes dev-only auth probes including `resetPasswordDev`. Never extend it, never rely on it in product code.
- Committed scratch: `dreamweaver-frontend/tmp_spec.json` and `tmp_function_spec.json` (~278 KB each) are stale artifacts, not inputs.

---

## House style

- Match surrounding code. This repo comments *why*, not *what* — see the header block in any `generate-*-stream/route.ts` for the register. Keep that; it's load-bearing for the next reader.
- TypeScript is `strict`. React 19 with the React Compiler on (`reactCompiler: true`) — don't hand-add `useMemo`/`useCallback` for performance alone.
- Python is 3.12, `from __future__ import annotations`, typed. Agent state uses `TypedDict` (`deep/state.py`), boundary payloads use Pydantic (`viMax_port/types.py`).
- New domain logic goes in `src/lib/<domain>/` with a sibling `__tests__/`. Almost every lib there has one; follow suit.
- Never commit or push unless asked.
