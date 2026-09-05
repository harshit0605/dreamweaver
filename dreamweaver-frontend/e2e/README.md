# E2E Test Suite (M9.5 L6)

Playwright specs covering the seven producer/director/creator flows
end-to-end against a staging Next.js + Convex deployment + a real
LLM. These tests are the safety net for the React UI; lower layers
(L1–L5) cover the agent + bridge contracts.

## When this runs

* **PR CI**: never. The default `bun run test` does not invoke
  Playwright.
* **Nightly cron**: invoked via the same workflow that runs L5
  live-LLM smoke. Burns ~$5 of LLM tokens per run.
* **Pre-release**: invoked on `release/*` branches before deploy.
* **Local debugging**: `bun run test:e2e:ui` opens the Playwright
  inspector with timeline + DOM snapshots.

## Prerequisites

Before the first run, install the Chromium binary:

```sh
bun run test:e2e:install
```

## Environment variables

All variables are read once at import time. Missing values cause
the affected specs to skip cleanly with a clear message — no spec
ever fails for "infrastructure not set up".

| Variable | Required by | Purpose |
|---|---|---|
| `E2E_STAGING_URL` | every spec | Next.js app URL (`https://app.staging.dreamweaver.example`). Defaults to `http://localhost:3002` if unset. |
| `E2E_AUTH_SESSION_TOKEN` | every spec | Better-auth bearer token for a seed test user. Mint with `bunx convex run testHelpers:mintSessionToken --user-id e2e-seed-user`. |
| `E2E_CONVEX_URL` | seeded-storyboard fixture | Convex deployment URL the staging frontend points at. Used by the http API for fixture seeding + teardown. |
| `E2E_OPENAI_API_KEY` | LLM-driving specs | OpenAI key for the agent's LLM calls. Without it, agent specs (variants, transitions, dailies critic, batches) skip. |
| `E2E_HEADED` | optional | Set to `1` to run with a visible browser (default headless). |

## Specs

| Spec | Drives LLM? | What it asserts |
|---|---|---|
| `creator-ingestion.spec.ts` | no | Library → "From Idea" dialog → submit → land on storyboard canvas |
| `producer-batches.spec.ts` | yes | Chat triggers `request_generate_shot_batch` HITL with the right node count + concurrency |
| `director-narrative-analysis.spec.ts` | no | "Analyze" button populates beat ribbon + tension sparkline + color script; beat slot popover lists candidate shots |
| `director-variants.spec.ts` | yes | Chat → 3 hook variants → approve → Variant Compare lists 3 → pick promotes one with Primary badge |
| `director-transitions-motifs.spec.ts` | yes (transition) / no (motif quick-plant) | Transition proposal lands on edge; motif quick-plant form creates a row with derived status |
| `dailies-critic.spec.ts` | yes | Chat triggers `request_dailies_critic_review` → approve → critic chain dispatches |
| `director-export.spec.ts` | no | Cut-tier promote bumps tier; Export reel records a row (or surfaces ffmpeg-missing 501 cleanly) |

## Seeding test storyboards

`convex/testHelpers.ts` provides three mutations the e2e fixture
chain depends on. **They are deployed but gated** — the env var
`STORYBOARD_E2E_HELPERS_ENABLED` must equal `"true"` on the target
deployment, otherwise every helper throws. Production deployments
must NEVER set this flag.

Mutations:

```ts
// Create a 12-shot storyboard (configurable count) wired into a
// serial timeline. Returns the new storyboardId.
seedStoryboard({ title: string; shotCount?: number })

// Soft-archive — flips status="archived". Hard-deletion runs via
// the purge cron 24h later.
archiveStoryboard({ storyboardId: Id<"storyboards"> })

// Admin sweep. Hard-deletes archived test rows older than N hours
// (default 24). Wired into a cron in production / staging.
purgeArchivedTestStoryboards({ olderThanHours?: number })
```

To enable on a deployment:

```sh
bunx convex env set STORYBOARD_E2E_HELPERS_ENABLED true
```

To verify:

```sh
bunx convex run testHelpers:healthCheck
# {"enabled": true, "ts": ...}
```

## Authenticating: minting a session

Convex's `ctx.auth.getUserIdentity()` validates a 15-minute JWT
signed by the better-auth component. The L6 fixture chain needs both:

* `better-auth.session_token` — long-lived (7d) bearer in the
  browser cookie jar.
* `better-auth.convex_jwt` — short-lived (15min) JWT validated by
  the Convex http API.

`scripts/mint-e2e-session.ts` automates the better-auth REST flow
to mint both:

```sh
# Idempotent — signs up the seed user on first run, signs in
# on subsequent runs.
bun run scripts/mint-e2e-session.ts
# Outputs (eval-able):
#   export E2E_AUTH_SESSION_TOKEN='...'
#   export E2E_AUTH_CONVEX_JWT='...'
```

CI pattern: `eval "$(bun run scripts/mint-e2e-session.ts)"` at the
start of the e2e job, then run the suite. The JWT is only valid for
15 minutes — for long-running suites, re-mint between specs (or
within a `beforeEach`).

The seed user (`e2e-test@dreamweaver.local` / fixed password)
exists on the dev + staging deployments only. Its email/password
default can be overridden via `E2E_TEST_USER_EMAIL` +
`E2E_TEST_USER_PASSWORD`.

## Running locally

```sh
# 1. Install browser binary (one-shot)
bun run test:e2e:install

# 2. Boot a local Next dev server + Convex dev
bun run dev          # in one terminal
bunx convex dev      # in another

# 3. Set the env vars (see table above)
export E2E_STAGING_URL=http://localhost:3002
export E2E_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL  # whatever convex dev printed
export E2E_AUTH_SESSION_TOKEN=$(bunx convex run testHelpers:mintSessionToken --user-id e2e-seed-user 2>&1 | tail -1)
export E2E_OPENAI_API_KEY=$(<~/.openai-key)

# 4. Run the suite
bun run test:e2e

# Or open the inspector for one spec
bun run test:e2e:ui -- e2e/specs/director-narrative-analysis.spec.ts
```

## Running in CI

A future GitHub Actions workflow will:

1. Build the staging deployment (or skip if a prior build is fresh).
2. Run `bunx convex run testHelpers:mintSessionToken` to mint a
   short-lived (1h) bearer token.
3. Export it + the staging URLs + the OpenAI secret into the
   environment.
4. `bun run test:e2e:install && bun run test:e2e`.
5. Upload the JUnit report + traces as artifacts.

The workflow file (`.github/workflows/pre-release-e2e.yml`) is
deferred — landing it requires picking specific staging
infrastructure that's outside the scope of this round.

## Failure debugging

Every failing test captures:

* A trace (`playwright-report/` ZIP per spec) — open with
  `bunx playwright show-trace <path>`.
* A screenshot at the failure point.
* A full-run video.

These artifacts surface in the CI job on failure and are the
fastest path from "nightly went red" to "fixed in PR".

## Limits + follow-ups

* **Spec coverage is partial.** The narrative-analysis spec
  verifies hydration end-to-end (real Convex websocket → React Flow
  canvas → NarrativeBar enabled-state transitions). Other specs
  rely on agent-LLM-driven flows (variants / transitions /
  motifs / batches) that need both `E2E_OPENAI_API_KEY` AND
  the agent service running on `STORYBOARD_AGENT_URL` — those
  remain in skip-clean mode until both are set.
* **The beat-slot popover is not L6-tested.** Playwright's
  hit-testing through React Flow's pointer-event surface is
  flaky for floating-bar children. Popover behaviour is reliably
  exercised by L3 panel-level integration tests; deferred from L6.
* **Mutation-driven assertions are loose.** We assert on UI state
  (a row appears, a badge flips) rather than on the underlying
  Convex row directly. Convex contract assertions are M9.6
  scope.
* **No mobile viewport coverage.** Specs run at desktop 1440×900
  only. Mobile responsiveness is tracked as a separate effort.
* **No visual regression.** Snapshot diffing (Chromatic /
  Playwright snapshots) is M10.
