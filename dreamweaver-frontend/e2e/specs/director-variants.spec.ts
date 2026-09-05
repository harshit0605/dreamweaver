/**
 * M9.5 L6 — Director: variant generation flow.
 *
 * Producer flow:
 *   1. Open a seeded 12-shot storyboard.
 *   2. Chat: "give me 3 cold-open variants".
 *   3. hook_designer subagent fires → request_hook_variants HITL
 *      card renders.
 *   4. Click Approve → 3 narrative-git branches commit.
 *   5. Variant Compare panel lists the 3 candidates.
 *   6. Click "Pick" on one → applyMergePolicy promotes it; siblings
 *      stay un-picked but remain in the panel until the cron eviction.
 *
 * Drives a real LLM round-trip; gated on E2E_OPENAI_API_KEY via
 * requireLiveLlm().
 */

import {
  approveCard,
  sendChatMessage,
  waitForApprovalCard,
} from "../fixtures/agent-stream";
import { test, expect } from "../fixtures/seeded-storyboard";
import { requireLiveLlm } from "../fixtures/skip-guards";

test.describe("Director: variant generation", () => {
  test.beforeEach(() => {
    requireLiveLlm();
  });

  test("3 cold-open variants → approve → Variant Compare lists 3 → pick promotes one", async ({
    authedPage: page,
    storyboardId,
  }) => {
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);
    await expect(page.getByTestId("narrative-bar")).toBeVisible();

    // Step 1: tell the agent what we want.
    await sendChatMessage(page, "Give me 3 cold-open variants for this reel.");

    // Step 2: wait for the hook_designer subagent to land its
    // approval card. The bridge renders one card with all 3
    // variants surfaced as checkboxes.
    const card = await waitForApprovalCard(page, "request_hook_variants");
    // The card body should mention 3 variants somewhere visible.
    await expect(card).toContainText(/3 variants?|variantCount.*3/i, {
      timeout: 5_000,
    });

    // Step 3: approve all 3.
    await approveCard(card);

    // Step 4: open the Production Hub Drawer → Playback tab to
    // surface the Variant Compare panel.
    await page.getByRole("button", { name: /production hub|drawer/i }).click();
    await page.getByRole("tab", { name: /playback/i }).click();

    const panel = page.getByRole("region", { name: /variant compare/i });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The 3 hook variants render under "Cold-open hooks" group.
    await expect(panel.getByText("Cold-open hooks")).toBeVisible();
    // 3 candidate rows total.
    await expect(panel).toContainText(/3 candidates?/i);

    // Step 5: pick the first variant → applyMergePolicy fires.
    await panel.getByRole("button", { name: /^pick$/i }).first().click();

    // Picked row gets the Trophy badge + suppresses the action
    // buttons for that row.
    await expect(panel.getByText(/primary/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
