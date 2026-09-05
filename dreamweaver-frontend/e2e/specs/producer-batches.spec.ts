/**
 * M9.5 L6 — Producer: shot/video/audio batch generation flow.
 *
 * Producer flow:
 *   1. Open a seeded 12-shot storyboard.
 *   2. Chat: "render images for all shots".
 *   3. ingestion_coordinator fires → request_generate_shot_batch HITL.
 *   4. Approve → bridge dispatches the batch route.
 *
 * Drives a real LLM round-trip; gated on E2E_OPENAI_API_KEY.
 *
 * NOTE: full image/video/audio batch execution would actually call
 * external media-gen APIs (OpenAI, Eleven Labs, LTX). This spec
 * stops at the HITL approval — the actual rendering pipeline is
 * out of scope for the e2e suite, since it can take minutes per
 * shot and is best smoke-tested separately.
 */

import {
  approveCard,
  sendChatMessage,
  waitForApprovalCard,
} from "../fixtures/agent-stream";
import { test, expect } from "../fixtures/seeded-storyboard";
import { requireLiveLlm } from "../fixtures/skip-guards";

test.describe("Producer: batch generation", () => {
  test.beforeEach(() => {
    requireLiveLlm();
  });

  test("chat 'render images' surfaces request_generate_shot_batch HITL", async ({
    authedPage: page,
    storyboardId,
  }) => {
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);
    await expect(page.getByTestId("narrative-bar")).toBeVisible();

    await sendChatMessage(
      page,
      "Render images for every shot in this storyboard.",
    );

    const card = await waitForApprovalCard(
      page,
      "request_generate_shot_batch",
    );
    // Card body should mention the node count + concurrency. The
    // 12-shot seeded storyboard yields nodeCount: 12; concurrency
    // defaults to 3-4 from the agent's prompt.
    await expect(card).toContainText(/12 shots?|nodeCount.*12/i, {
      timeout: 5_000,
    });
    await expect(card).toContainText(/concurrency/i);

    // Approve. The bridge fires the batch route; we don't wait
    // for actual media generation (that's minutes-long). The
    // post-approval state reflects the toolAudits row.
    await approveCard(card);

    // CopilotKit echoes a confirmation. We assert structural
    // success rather than text since the agent's response phrasing
    // varies.
    await expect(
      page.getByText(/approved|batch dispatched|generation started/i).first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
