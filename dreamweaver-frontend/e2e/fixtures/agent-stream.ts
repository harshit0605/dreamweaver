/**
 * M9.5 L6 — CopilotKit chat sidebar interaction helpers.
 *
 * Each producer/director spec drives the agent by typing a message
 * into the CopilotKit sidebar, then waiting for a HITL approval
 * card to render. These helpers wrap the DOM contract so individual
 * specs don't reproduce the locators.
 *
 * Locator strategy — uses semantic roles + the agent action name:
 *   * The CopilotKit sidebar uses role="textbox" for its input.
 *     We pick the FIRST textbox in the sidebar to avoid collisions
 *     with editor inputs elsewhere on the page.
 *   * HITL approval cards expose a `data-tool-name` attribute set
 *     by the bridge's render contract. Specs assert against that
 *     name before clicking Approve/Edit/Reject.
 *
 * If the bridge contract changes (e.g. data-tool-name renamed),
 * update HITL_CARD_TESTID + AGENT_INPUT_TESTID below — those are
 * the single source of truth for the e2e suite.
 */

import { type Locator, type Page, expect } from "@playwright/test";

// Locator constants — bumped here when the bridge contract changes.
// We intentionally use semantic locators where possible; data-testid
// fallbacks land in components that can't surface a role usefully
// (e.g. the floating chat sidebar that's a div tree).
export const HITL_CARD_TESTID = "hitl-approval-card";
export const AGENT_INPUT_TESTID = "copilot-input";

/**
 * Open the CopilotKit chat sidebar and type a producer message.
 * Returns once the message bubble has appeared in the chat
 * transcript so the caller knows the agent received it.
 */
export async function sendChatMessage(
  page: Page,
  message: string,
): Promise<void> {
  // The sidebar may be collapsed by default. The toggle button
  // bears `aria-label="Open Storyboard Copilot"`; if the sidebar
  // is already open the button isn't visible — handle both.
  const sidebarToggle = page.getByRole("button", {
    name: /open storyboard copilot/i,
  });
  if (await sidebarToggle.isVisible().catch(() => false)) {
    await sidebarToggle.click();
  }

  // CopilotKit's sidebar input — fall back across role + testid.
  const input = page
    .getByRole("textbox", { name: /message|chat/i })
    .or(page.getByTestId(AGENT_INPUT_TESTID))
    .first();
  await input.fill(message);
  await input.press("Enter");

  // Wait for the message to land in the chat transcript so the
  // agent's response is queued before the spec proceeds. We don't
  // assert on the agent's reply text — that's brittle under prompt
  // changes — only on the producer's bubble being visible.
  await expect(page.getByText(message, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Wait for an approval card with the given action name to render.
 * Returns the card locator so the spec can interact with it
 * (Approve/Edit/Reject + read content).
 */
export async function waitForApprovalCard(
  page: Page,
  toolName: string,
): Promise<Locator> {
  const card = page
    .getByTestId(HITL_CARD_TESTID)
    .filter({ has: page.locator(`[data-tool-name="${toolName}"]`) })
    .first()
    .or(
      // Fallback: if the bridge hasn't set data-tool-name yet,
      // match by visible heading text. Approval cards render
      // their action name in the title so this is reasonably
      // robust even before the testid migration.
      page
        .getByRole("region", { name: new RegExp(toolName.replace(/_/g, " "), "i") })
        .first(),
    );
  await expect(card).toBeVisible({ timeout: 60_000 });
  return card;
}

/** Click the approval card's Approve button. */
export async function approveCard(card: Locator): Promise<void> {
  await card.getByRole("button", { name: /^approve$/i }).first().click();
}

/** Click the approval card's "Approve As Edited" button. */
export async function approveAsEdited(card: Locator): Promise<void> {
  await card.getByRole("button", { name: /approve as edited/i }).click();
}

/** Click the approval card's Reject button. */
export async function rejectCard(card: Locator): Promise<void> {
  await card.getByRole("button", { name: /^reject$/i }).first().click();
}
