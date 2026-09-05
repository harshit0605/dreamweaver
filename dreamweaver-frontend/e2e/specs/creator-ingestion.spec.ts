/**
 * M9.5 L6 — Creator: ingestion flow.
 *
 * Producer flow:
 *   1. Land on the library page (root).
 *   2. Click "From Idea" / "From Screenplay" / "From Novel".
 *   3. Submit the dialog with a synthetic premise.
 *   4. Land on the new storyboard's canvas.
 *
 * This spec doesn't use the seededStoryboard fixture — it tests
 * the storyboard CREATION path. It DOES drive a Convex mutation
 * (the dialog's submit) but does NOT need the LLM (the agent
 * route is invoked AFTER landing in the new storyboard).
 */

import { test, expect } from "../fixtures/authenticated-page";
import { requireAuthedStaging } from "../fixtures/skip-guards";

test.describe("Creator: ingestion", () => {
  test.beforeEach(() => {
    requireAuthedStaging();
  });

  test("From Idea dialog creates a storyboard and navigates to it", async ({
    authedPage: page,
  }) => {
    await page.goto("/");

    // Library page exposes 3 ingestion buttons. Names rendered
    // verbatim from the buttons in src/app/page.tsx.
    const fromIdea = page.getByRole("button", { name: /from idea/i });
    await expect(fromIdea).toBeVisible({ timeout: 15_000 });
    await fromIdea.click();

    // Dialog opens with a textarea for the synopsis + a title
    // input + a primary submit button. We fill minimally to exercise
    // the validation path.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog
      .getByRole("textbox", { name: /title/i })
      .fill(`e2e creator ${Date.now()}`);
    await dialog
      .getByRole("textbox", { name: /idea|synopsis|premise/i })
      .fill(
        "A cat burglar with a perfect memory must rob a museum where the "
        + "exhibits are her own forgotten paintings.",
      );

    // Submit. The button label varies (Create / Generate / Submit) —
    // accept any of them so the test survives a copy refactor.
    await dialog
      .getByRole("button", {
        name: /^create|^generate|^submit|^start/i,
      })
      .first()
      .click();

    // Once the storyboard creates, the URL transitions to
    // /storyboard/<id>. We don't assert on the agent's first
    // response — that's a separate flow.
    await expect(page).toHaveURL(/\/storyboard\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });

    // Canvas renders with React Flow viewport. Sanity that we
    // landed somewhere meaningful.
    await expect(page.getByTestId("narrative-bar")).toBeVisible({
      timeout: 15_000,
    });
  });
});
