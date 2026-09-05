/**
 * M9.5 L6 — environment skip-guards shared across e2e specs.
 *
 * Mirrors the Python L5 pattern: each spec checks for the
 * infrastructure it needs and `test.skip(...)` cleanly when the
 * env var is missing. Developers can clone the repo and run
 * `bun run test:e2e` without staging credentials — they'll see
 * "0 passed, 7 skipped" instead of 7 confusing failures.
 *
 * Variables (all read once at import):
 *   * E2E_STAGING_URL — Next.js app URL. Required for every spec.
 *   * E2E_OPENAI_API_KEY — Anthropic / OpenAI key for the LLM.
 *     Required by specs that drive the agent (variants, transitions,
 *     motifs, dailies critic).
 *   * E2E_AUTH_SESSION_TOKEN — better-auth bearer token for a seed
 *     user that owns the test storyboards. Set via `bunx convex
 *     run testHelpers:mintSessionToken --user-id <id>` (helper
 *     mutation lives at convex/testHelpers.ts; out of scope for
 *     this round, tracked as a follow-up).
 *   * E2E_CONVEX_URL — Convex deployment URL the staging frontend
 *     points at. Used by the seeded-storyboard fixture to set up
 *     fixtures via the http API.
 */

import { test } from "@playwright/test";

export const ENV = {
  stagingUrl: process.env.E2E_STAGING_URL ?? "",
  openaiKey: process.env.E2E_OPENAI_API_KEY ?? "",
  // session_token is what the browser shows (cookie name
  // `better-auth.session_token`); convex_jwt is what the Convex
  // http API validates (cookie name `better-auth.convex_jwt`).
  // L6 needs both: the browser fixture injects session_token; the
  // seed-storyboard fixture uses convex_jwt.
  authToken: process.env.E2E_AUTH_SESSION_TOKEN ?? "",
  convexJwt: process.env.E2E_AUTH_CONVEX_JWT ?? "",
  convexUrl: process.env.E2E_CONVEX_URL ?? "",
} as const;

/** Spec needs an authenticated browser session against staging.
 *  Skips if staging URL or auth token is missing. */
export const requireAuthedStaging = () => {
  if (!ENV.stagingUrl) {
    test.skip(true, "E2E_STAGING_URL unset — set it to enable e2e suite");
  }
  if (!ENV.authToken) {
    test.skip(
      true,
      "E2E_AUTH_SESSION_TOKEN unset — see e2e/README.md for seeding instructions",
    );
  }
};

/** Spec drives the agent → LLM round-trips happen.
 *  Adds the LLM key requirement on top of authed staging. */
export const requireLiveLlm = () => {
  requireAuthedStaging();
  if (!ENV.openaiKey) {
    test.skip(true, "E2E_OPENAI_API_KEY unset — agent specs need a live LLM");
  }
};

/** Spec writes/reads via the Convex http API (used to seed
 *  fixtures + assert post-mutation state). */
export const requireConvex = () => {
  requireAuthedStaging();
  if (!ENV.convexUrl) {
    test.skip(true, "E2E_CONVEX_URL unset — Convex http API needed for fixtures");
  }
};
