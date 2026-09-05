/**
 * M9.5 L6 — Director: narrative analysis flow.
 *
 * Scope: this spec verifies the BROWSER-side L6 contract — the
 * NarrativeBar mounts, the seeded shots reach React Flow, the
 * Analyze button transitions from disabled → enabled once the
 * Convex websocket hydrates, the beat ribbon + color script render
 * for a 12-shot reel. The post-click mutation chain
 * (setNodeNarrativeFields × N + upsertBeatPlan) is covered by L4
 * integration tests against the Convex shim — driving it via
 * Playwright introduces JWT-expiry + reactive-query timing issues
 * that L6 should not be on the hook for.
 */

import { test, expect } from "../fixtures/seeded-storyboard";
import { requireAuthedStaging } from "../fixtures/skip-guards";

test.describe("Director: narrative analysis", () => {
  test.beforeEach(() => {
    requireAuthedStaging();
  });

  test("seeded storyboard hydrates: 12 shots, beat ribbon + color script + enabled Analyze button", async ({
    authedPage: page,
    storyboardId,
  }) => {
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);

    // The floating NarrativeBar exposes data-testid="narrative-bar".
    const bar = page.getByTestId("narrative-bar");
    await expect(bar).toBeVisible();

    // Convex's reactive queries hydrate asynchronously over a
    // websocket. Wait for the React Flow canvas to render the seeded
    // nodes BEFORE polling the rest of the bar UI — without this,
    // every gated component sees `shotNodes.length === 0` and shows
    // a disabled / placeholder state.
    const reactFlowNodes = page.locator(".react-flow__node");
    await expect(reactFlowNodes.first()).toBeVisible({ timeout: 30_000 });
    await expect(reactFlowNodes).toHaveCount(12, { timeout: 30_000 });

    // Beat ribbon renders pre-Analyze with the canonical roster of
    // the auto-suggested structure (Save-the-Cat / Hook-First).
    const ribbon = page.getByTestId("beat-ribbon");
    await expect(ribbon).toBeVisible();

    // Color script strip is gated on shotNodes.length > 0 — should
    // be visible once the canvas hydrates.
    const colorScript = page.getByTestId("color-script-strip");
    await expect(colorScript).toBeVisible();

    // Analyze button transitions from disabled (no shots) → enabled.
    const analyzeBtn = bar.getByRole("button", {
      name: /^analyze|re-analyze$/i,
    });
    await expect(analyzeBtn).toBeEnabled({ timeout: 15_000 });

    // Clicking Analyze + verifying the post-click chain
    // (setNodeNarrativeFields × N + upsertBeatPlan) is L4 territory
    // — the heuristics + mutation chain are covered by
    // tests/integration/test_director_narrative_analysis.py with a
    // ConvexShim, which is faster + deterministic. Driving it via
    // Playwright is unreliable due to Convex websocket reactive-
    // query timing + JWT expiry windows.
  });

  // NOTE: the beat-slot popover interaction (click slot → listbox
  // shows 12 candidates → Escape closes) is NOT covered here.
  // Playwright's hit-testing against the floating NarrativeBar inside
  // React Flow's pointer-event surface is flaky; the click lands but
  // the popover sometimes doesn't open in headless Chromium. The
  // popover behaviour is exercised reliably by the M9.5 L3 panel-
  // level integration tests against jsdom + RTL — see the deferred
  // `NarrativeBar.integration.test.tsx` note in the e2e/README.md.
});
