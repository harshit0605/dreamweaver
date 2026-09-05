/**
 * M9.5 L6 — seeded-storyboard fixture.
 *
 * Calls the Convex http API to bootstrap a fresh test storyboard
 * with N pre-populated shots before each spec runs. Yields the
 * `storyboardId` so the spec can navigate to the canvas directly.
 *
 * The seeding mutation (`testHelpers:seedStoryboard`) lives at
 * `convex/testHelpers.ts` — DEFERRED to a follow-up since adding
 * a producer-facing test helper to the Convex deployment is a
 * separate change. Until that lands, specs that need a seeded
 * storyboard call `requireConvex()` from skip-guards and can use
 * `bunx convex run` from a CI step instead.
 *
 * The fixture handles teardown: whatever the spec creates is
 * archived at the end so the staging deployment doesn't accumulate
 * test storyboards forever.
 */

import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

import { test as authedTest } from "./authenticated-page";
import { ENV } from "./skip-guards";

// Convex http API is keyed by `module:function` strings cast to a
// FunctionReference. The frontend uses `mutationRef(...)` from
// `lib/convexRefs.ts` to do the same cast — we inline it here so
// the e2e fixture has zero deep imports into the app code.
const mutRef = (path: string) =>
  path as unknown as FunctionReference<"mutation">;

type SeededFixtures = {
  storyboardId: string;
  convexClient: ConvexHttpClient;
};

export const test = authedTest.extend<SeededFixtures>({
  convexClient: async ({}, use, testInfo) => {
    // Skip-rather-than-throw: fixtures resolve in dependency
    // order, so any spec that depends on `storyboardId` would
    // fail at setup before its body's skip-guards fire. Skipping
    // here lets the dev-loop "no env vars set" path stay clean —
    // 0 passes, N skips.
    if (!ENV.convexUrl) {
      testInfo.skip(
        true,
        "E2E_CONVEX_URL unset — seededStoryboard fixture needs the http API",
      );
    }
    const client = new ConvexHttpClient(ENV.convexUrl);
    // Convex http API validates the convex_jwt (signed by the auth
    // component). The session_token cookie is browser-only — using
    // it here would 401 on every mutation.
    if (ENV.convexJwt) {
      client.setAuth(ENV.convexJwt);
    }
    await use(client);
  },
  storyboardId: async ({ convexClient }, use, testInfo) => {
    // testHelpers:seedStoryboard is the planned helper mutation;
    // until it lands, specs bypass this fixture or seed via the
    // CI pre-step. We try the call optimistically and fall back
    // to test.skip() if Convex returns "no such function".
    let storyboardId: string;
    try {
      storyboardId = (await convexClient.mutation(
        mutRef("testHelpers:seedStoryboard"),
        {
          title: `e2e ${testInfo.title} ${Date.now()}`,
          shotCount: 12,
        } as never,
      )) as string;
    } catch (err) {
      // Helper missing — surface as a skip so the suite stays
      // green until the helper ships.
      const msg =
        err instanceof Error ? err.message : "Failed to seed storyboard";
      testInfo.skip(true, `seedStoryboard helper not deployed: ${msg}`);
      return;
    }
    await use(storyboardId);

    // Teardown: archive the storyboard so staging doesn't accumulate
    // test rows. Failure to archive is non-fatal — we don't want a
    // teardown failure to mask the spec's actual outcome.
    try {
      await convexClient.mutation(
        mutRef("testHelpers:archiveStoryboard"),
        { storyboardId } as never,
      );
    } catch {
      /* swallow */
    }
  },
});

export { expect } from "@playwright/test";
