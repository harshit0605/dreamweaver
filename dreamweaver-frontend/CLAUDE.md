# CLAUDE.md — dreamweaver-frontend

Next.js 16 (App Router, React 19 + React Compiler), Bun, Tailwind v4, shadcn/Radix, ReactFlow.

This is **not just the UI.** It is the orchestration tier: every agent decision, every batch render, every Convex write passes through here. The Python services are dumb executors by design.

Convex specifics live in `convex/CLAUDE.md`.

---

## Commands

```bash
bun install
bun run convex:dev        # leave running — generates convex/_generated/, which is gitignored
bun run dev               # :3002
bun test                  # ~50 files, bun's built-in runner (no jest/vitest config)
bun run lint
bun run build
bun run auth:generate-schema   # regenerate convex/auth_config/schema.ts after Better Auth config changes
```

Needs `.env.local`. `NEXT_PUBLIC_API_URL` → FastAPI (8001); `LANGGRAPH_STORYBOARD_DEPLOYMENT_URL` and `STORYBOARD_AGENT_BASE_URL` → LangGraph (8123). Full list in `../AI.md` §8.

---

## Layout

```
src/
├── app/
│   ├── page.tsx  auth/  image/  video/  edit/          ← standalone tools
│   ├── storyboard/
│   │   ├── page.tsx                    library
│   │   ├── [storyboardId]/page.tsx     THE editor (2376 LOC)
│   │   ├── agentExecutionAdapter.ts    agent → Convex (1748 LOC)
│   │   └── types.ts                    domain types + option tables (776 LOC)
│   └── api/                            the BFF — 20 route handlers
├── components/storyboard/              32 panels; StoryboardCopilotBridge.tsx is 3245 LOC
├── lib/<domain>/                       pure logic + __tests__/
└── server/vault/adapter.ts             secret resolution (Convex secretHandles → env fallback)
```

---

## Calling Convex — read this before you write a query

`convex/_generated/` is gitignored. Nothing imports `api.*`. Everything goes through `src/lib/convexRefs.ts`:

```ts
import { mutationRef, queryRef } from "@/lib/convexRefs";

const snapshot   = useQuery(queryRef("storyboards:getStoryboardSnapshot"), { storyboardId });
const upsertNode = useMutation(mutationRef("storyboards:upsertNode"));
```

The string is `"<file>:<exportName>"` and it is an unchecked cast. **Typos fail at runtime, not compile time.** After renaming a Convex export:

```bash
grep -rn '"oldFile:oldExport"' src convex
```

Server-side routes use `ConvexHttpClient` with a Better Auth token from `getToken()` (`src/lib/auth-server.ts`) — see any route in `src/app/api/storyboard/`.

---

## The BFF routes

**Ingestion** — proxy to `storyboard-agent` (8123), then write results to Convex.

| Route | Flow |
|---|---|
| `ingest-stream` (`mode: screenplay \| idea`) | SSE, `maxDuration` 900 s, internal abort 12 min |
| `ingest-novel-stream` | novel → compress → episodes → screenplay → graph |
| `ingest-screenplay`, `ingest-idea` | blocking variants of the same pipelines |

All ingestion tails share `src/lib/ingest-postprocess/processor.ts` (portrait generation + Convex writes). Add stages there, not in the routes — the SSE and blocking routes both call it, and duplicating logic is how they drift.

**Batch generation** — bounded-concurrency worker pools over the shot list, per-shot SSE events.

| Route | Notes |
|---|---|
| `generate-shots-stream` | images; refs chosen by `src/lib/shot-batch/selector.ts`; supports `skipExisting`, `flaggedOnly` (NG dailies), explicit `nodeIds` |
| `generate-shot-videos-stream` | image→video, LTX-2.3 |
| `generate-shot-audios-stream` | per-shot TTS, speaker-aware voice casting |
| `export-reel`, `reel-manifest` | reel assembly; ffmpeg.wasm client fallback in `src/lib/reel-export/client.ts` |

**Other:** `copilotkit/storyboard` (CopilotKit runtime → LangGraph; intentionally unauthenticated for agent discovery — all side effects are gated downstream by `requireUser`), `auth/[...all]`, `media/generate`, `media/generate-audio`, `story/generate`, `story/edit`, `storyboard/continuity-critic`, `storyboard/export`, `storyboard/media-proxy`, `vault/secret-handles`.

### Writing a new streaming route

Copy `src/app/api/storyboard/ingest-stream/route.ts`. Non-negotiables:

```ts
export const runtime = "nodejs";
export const maxDuration = 900;          // platform ceiling
const TIMEOUT_MS = 12 * 60 * 1000;       // strictly BELOW maxDuration
const HEARTBEAT_INTERVAL_MS = 15_000;    // or proxies drop the connection
```

Emit `open` → `ping`/domain events → terminal `done` or `error`. Use `sseFrame` from `@/lib/ingest-postprocess`. Document the event protocol in the file header — every existing route does, and the client hooks in `src/lib/sse-ingest/` are written against those headers.

---

## The two big files

**`StoryboardCopilotBridge.tsx` (3245)** — registers the `storyboard_agent` CopilotKit agent and one `useCopilotAction` per HITL approval: `approve_graph_patch`, `approve_media_prompt`, `approve_execution_plan`, `preview_simulation_critic_plan`, `approve_batch_ops`, `approve_dailies_batch`, `approve_merge_policy`, `approve_repair_plan`, plus team management. Each renders approval UI and dispatches accept/reject into the adapter.

**`agentExecutionAdapter.ts` (1748)** — the sole agent→Convex path. Six exports:

```
executeApprovedGraphPatch    / executeRejectedGraphPatch
executeApprovedMediaPrompt   / executeRejectedMediaPrompt
executeApprovedExecutionPlan / executeRejectedExecutionPlan
```

The execution-plan pair backs most actions, discriminated by `taskType`: `execution_plan` | `batch_ops` | `dailies_batch` | `simulation_critic_batch` | `repair_plan`. Reuse it rather than adding a fourth pair.

Both have integration tests (`__tests__/`) — run them after any change here.

---

## Domain libs (`src/lib/`)

Pure, tested, framework-free. Put new logic here rather than in components.

`shot-batch` reference-image selection · `identity-portraits` canonical views · `continuity-critic` prompt+parse · `continuity-validators` axis/eyeline/thirty-degree/walk · `screenplay` fountain/fdx/edl/fcpxml/timecode/traverse · `dialogue-extract` · `delivery-matrix` · `cut-tier` · `cherry-pick` · `cameo` · `reel-export` · `review` · `ingest-postprocess` · `sse-ingest` · `observability` · `llm` · `auth-client`/`auth-server`/`convexRefs`

`src/lib/llm/LLMFactory.ts` fans out: Gemini (text + structured), Modal (image, video), ElevenLabs/Suno (audio). Model id constants sit in `src/lib/storyboardConstants.ts`.

---

## Conventions

- Path alias `@/*` → `./src/*`.
- `strict: true`. React Compiler is on — skip manual `useMemo`/`useCallback` added purely for perf.
- New lib ⇒ new `__tests__/`. Follow the existing pattern; `bun test` picks it up with no config.
- Structured logging via `src/lib/observability` — `createLogger` + `resolveRequestId`, and thread the request id into downstream Python calls. All SSE routes already do.
- Secrets: resolve through `src/server/vault/adapter.ts`, not `process.env`, unless you're writing the fallback itself.
- `tmp_spec.json` / `tmp_function_spec.json` at the package root are stale scratch. Ignore them.
