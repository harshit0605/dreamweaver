/**
 * M9.5 L6 — Producer: dailies critic flow.
 *
 * Producer flow:
 *   1. Open a seeded storyboard.
 *   2. Chat: "audit my dailies and propose repairs".
 *   3. dailies_critic fires → request_dailies_critic_review HITL.
 *   4. Approve dispatch → critic runs simulate_story_playthrough
 *      + continuity_critic + detect_motif_gaps and proposes a
 *      repair_plan.
 *   5. (If repairs proposed) approve_repair_plan HITL surfaces.
 *      We approve to land the chain.
 *
 * Drives a real LLM round-trip; gated on E2E_OPENAI_API_KEY.
 *
 * The seeded storyboard intentionally has a clean shape (no
 * deliberate violations) so this spec primarily verifies the
 * dispatch chain. A "dirty" seeded storyboard for repair-path
 * testing would be a separate fixture (tracked as a follow-up).
 */

import {
  approveCard,
  sendChatMessage,
  waitForApprovalCard,
} from "../fixtures/agent-stream";
import { test, expect } from "../fixtures/seeded-storyboard";
import { requireLiveLlm } from "../fixtures/skip-guards";

test.describe("Producer: dailies critic", () => {
  test.beforeEach(() => {
    requireLiveLlm();
  });

  test("chat-triggered dailies critic dispatch lands an approval card", async ({
    authedPage: page,
    storyboardId,
  }) => {
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);
    await expect(page.getByTestId("narrative-bar")).toBeVisible();

    await sendChatMessage(
      page,
      "Audit my dailies for continuity + motif gaps and propose repairs.",
    );

    const card = await waitForApprovalCard(
      page,
      "request_dailies_critic_review",
    );

    // Approve dispatch — the critic runs after we resume the agent
    // turn. The post-approval state may surface a follow-up
    // approve_repair_plan card if violations were found, OR a
    // confirmation message if the dailies are clean.
    await approveCard(card);

    // Either path is success: we wait for any chat bubble
    // confirming the dispatch landed without erroring.
    await expect(
      page
        .getByText(/critic dispatched|audit complete|no violations|repair plan/i)
        .first(),
    ).toBeVisible({ timeout: 60_000 });
  });
});
