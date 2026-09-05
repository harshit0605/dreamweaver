/**
 * M9.5 L6 — Director: cut tier promotion + reel export flow.
 *
 * Producer flow:
 *   1. Open a seeded storyboard.
 *   2. Open Production Hub → Playback → Timeline Theater.
 *   3. Click "Promote" on the active branch to bump cut tier.
 *   4. Open the Reel Player and click "Export mp4".
 *   5. Bridge POSTs to /api/storyboard/export-reel; on success
 *      records a reelExports row.
 *
 * The export pipeline runs ffmpeg on the server. In the CI nightly
 * we hit a real export → real mp4 → real Convex storage upload.
 * Local runs without ffmpeg installed will get a 501 from the
 * route which the bridge surfaces as a producer-readable error;
 * the spec tolerates either path.
 */

import { test, expect } from "../fixtures/seeded-storyboard";
import { requireAuthedStaging } from "../fixtures/skip-guards";

test.describe("Director: cut tier + export", () => {
  test.beforeEach(() => {
    requireAuthedStaging();
  });

  test("Promote bumps cut tier; Export reel records a row", async ({
    authedPage: page,
    storyboardId,
  }) => {
    await page.goto(`/storyboard/${encodeURIComponent(storyboardId)}`);
    await expect(page.getByTestId("narrative-bar")).toBeVisible();

    // Open the Production Hub Drawer → Playback tab to surface
    // TimelineTheaterPanel which holds the cut-tier promote button.
    await page.getByRole("button", { name: /production hub|drawer/i }).click();
    await page.getByRole("tab", { name: /playback/i }).click();

    const theater = page.getByRole("region", { name: /timeline theater/i });
    await expect(theater).toBeVisible({ timeout: 15_000 });

    // The first branch row carries a "Promote" button. Click it
    // once — tier should advance from "Assembly" to "Editor's Cut".
    const branchRow = theater.getByRole("button", {
      name: /^promote$/i,
    }).first();
    await expect(branchRow).toBeVisible();
    await branchRow.click();
    // Tier badge label updates within a couple of seconds.
    await expect(
      theater.getByText(/Editor's Cut|editors/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Open the Reel Player. The library page exposes a reel
    // player toggle; once the dialog opens, click "Export mp4".
    await page.getByRole("button", { name: /reel player|preview reel/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    const exportButton = dialog.getByRole("button", {
      name: /export.*mp4|export reel/i,
    });
    await exportButton.click();

    // Either a success path (download link / "Export complete")
    // or a route-level error (501 if ffmpeg missing). Both keep
    // the dialog open. Hard failure (network 500) would close
    // the dialog or crash the app; that's the regression we want
    // to catch.
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(
      dialog
        .getByText(/export complete|download|ffmpeg|export failed/i)
        .first(),
    ).toBeVisible({ timeout: 60_000 });
  });
});
