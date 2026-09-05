/**
 * M9.5 L6 — authenticated browser context fixture.
 *
 * The app uses better-auth with a Convex session backend. For e2e
 * we don't go through the full sign-in flow; instead we mint a
 * session token via a Convex test helper (see e2e/README.md →
 * "Seeding test users") and inject it directly as a cookie before
 * the page navigates.
 *
 * The fixture is a thin wrapper over Playwright's built-in
 * `browser.newContext()` that:
 *   1. Creates a fresh browser context per spec (no auth bleed
 *      between specs).
 *   2. Sets the `__session` cookie to the test bearer token.
 *   3. Returns a `page` already pointed at the staging URL.
 */

import {
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { ENV } from "./skip-guards";

type AuthedFixtures = {
  authedContext: BrowserContext;
  authedPage: Page;
};

export const test = base.extend<AuthedFixtures>({
  authedContext: async ({ browser }, use) => {
    const context = await browser.newContext({
      baseURL: ENV.stagingUrl || undefined,
      // Keep the storage state explicit + reset between specs so we
      // never accidentally inherit a previous test's storyboard.
      storageState: undefined,
    });
    if (ENV.authToken) {
      const url = new URL(ENV.stagingUrl || "http://localhost:3002");
      // Inject BOTH cookies the browser uses:
      //   * better-auth.session_token — the long-lived (7d) session
      //     bearer; the better-auth client exchanges it for a fresh
      //     convex_jwt on each Convex call.
      //   * better-auth.convex_jwt — the short-lived (15min) JWT
      //     Convex validates. Including this means the first
      //     Convex query / mutation works without an exchange round-
      //     trip, which speeds up the e2e setup.
      // mint-e2e-session.ts emits both; CI exports them into
      // E2E_AUTH_SESSION_TOKEN + E2E_AUTH_CONVEX_JWT.
      const baseCookie = {
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        secure: url.protocol === "https:",
        sameSite: "Lax" as const,
      };
      const cookies = [
        {
          ...baseCookie,
          name: "better-auth.session_token",
          value: ENV.authToken,
        },
      ];
      if (ENV.convexJwt) {
        cookies.push({
          ...baseCookie,
          name: "better-auth.convex_jwt",
          value: ENV.convexJwt,
        });
      }
      await context.addCookies(cookies);
    }
    await use(context);
    await context.close();
  },
  authedPage: async ({ authedContext }, use) => {
    const page = await authedContext.newPage();
    await use(page);
  },
});

export { expect } from "@playwright/test";
