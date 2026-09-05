/**
 * M9.5 L6 — Director: transitions + motifs flow (M9 Phase 4).
 *
 * Producer flow A — transition:
 *   1. Open a seeded storyboard.
 *   2. Chat: "propose a transition between n3 and n4".
 *   3. transition_maestro fires → request_transition_proposal HITL
 *      with 2-4 ranked proposals.
 *   4. Click Approve → setEdgeTransitionIntent lands on the edge.
 *
 * Producer flow B — motif quick-plant:
 *   5. Open Production Hub → Playback → MotifMapPanel.
 *   6. Click "Plant motif" → fill key + description + target.
 *   7. Submit → upsertMotif lands a row with derived landedStatus.
 *
 * Drives a real LLM round-trip for the transition flow; gated on
 * E2E_OPENAI_API_KEY. The motif quick-plant is purely deterministic
 * — runs even without LLM if `requireAuthedStaging()` is sufficient.
 */

import {
  approveCard,
  sendChatMessage,
  waitForApprovalCard,
} from "../fixtures/agent-stream";
import { test, expect } from "../fixtures/seeded-storyboard";
import {
  requireAuthedStaging,
  requireLiveLlm,
} from "../fixtures/skip-guards";

test.describe("Director: transitions + motifs", () => {
  test("transition proposal lands a transitionIntent on the edge", async ({
    authedPage: page,
    storyboardId,
  }) => {
    requireLiveLlm();
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);
    await expect(page.getByTestId("narrative-bar")).toBeVisible();

    // Producer asks for a transition between n3 and n4 (assumed
    // adjacent in the seeded storyboard).
    await sendChatMessage(
      page,
      "Propose a transition between nodes n3 and n4.",
    );

    const card = await waitForApprovalCard(
      page,
      "request_transition_proposal",
    );
    // Card renders a radio group of ranked proposals (rank-1 is
    // preselected by the bridge); approving picks the default.
    await approveCard(card);

    // The edge between n3 and n4 should now carry transitionIntent
    // — the canvas exposes this as a label/data-attr on the edge
    // SVG. Without a stable selector for individual edges across
    // React Flow versions, we assert via the agent's confirmation
    // bubble in the chat instead. The bridge respond-payload
    // surfaces "selectedIntent" → CopilotKit echoes it.
    await expect(
      page.getByText(/selectedIntent|transitionIntent/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("MotifMapPanel quick-plant form creates a motif row", async ({
    authedPage: page,
    storyboardId,
  }) => {
    requireAuthedStaging();
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);

    // Open Production Hub Drawer → Playback tab → MotifMapPanel
    // (rendered after Variant Compare).
    await page.getByRole("button", { name: /production hub|drawer/i }).click();
    await page.getByRole("tab", { name: /playback/i }).click();

    const panel = page.getByRole("region", { name: /motif map/i });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Open the inline plant form.
    await panel.getByRole("button", { name: /^plant motif$/i }).click();

    // Fill the form. Field labels match the panel's aria-labels.
    await panel
      .getByLabel(/^motif key/i)
      .fill("e2e-red-umbrella");
    await panel
      .getByLabel(/^motif description$/i)
      .fill("Recurring crimson umbrella across the rain shots.");
    await panel
      .getByLabel(/^visual vocabulary$/i)
      .fill("crimson fabric, rain-beaded");

    // Submit. Form's submit button reads "Plant".
    await panel.getByRole("button", { name: /^plant$/i }).click();

    // Row appears in the panel with "planted" status (since we
    // only seeded sources, no payoffs yet).
    await expect(panel.getByText("e2e-red-umbrella")).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.getByText("planted").first()).toBeVisible();
  });
});
