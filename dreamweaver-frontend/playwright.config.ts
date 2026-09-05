/**
 * M9.5 L6 — Playwright E2E configuration.
 *
 * Targets the real Next.js app + a Convex deployment + a real LLM
 * for the seven producer/director/creator flows. Runs in three
 * modes:
 *
 *   * `bun run test:e2e` — uses `E2E_STAGING_URL` + `E2E_OPENAI_API_KEY`
 *     from the environment. CI nightly + pre-release.
 *   * `bun run test:e2e:ui` — same, with Playwright's inspector for
 *     local debugging.
 *   * `bun run test:e2e:local` — boots a local Next dev server on
 *     :3002 + a local Convex dev deployment. Slow first-run; cached
 *     after.
 *
 * Tests skip cleanly (rather than fail) when:
 *   * `E2E_STAGING_URL` is unset (no target).
 *   * `E2E_OPENAI_API_KEY` is unset (LLM tests would 401).
 *   * `E2E_AUTH_SESSION_TOKEN` is unset (every spec needs an
 *     authenticated session).
 *
 * This mirrors the L5 smoke pattern: developers can install
 * Playwright + browse the test files without staging credentials,
 * and the suite only runs end-to-end when explicitly opted in.
 */

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_STAGING_URL || "http://localhost:3002";
const isLocalRun = baseURL.includes("localhost");

export default defineConfig({
  testDir: "./e2e/specs",
  // Each spec runs in isolation — no shared state across files. We
  // do NOT enable test parallelism by default because the agent
  // service is a stateful process and the LLM has rate limits;
  // serial execution with one shared browser context is safer for
  // a nightly cron.
  fullyParallel: false,
  workers: 1,
  // CI cron: retry once on flake (network jitter, LLM occasionally
  // returns malformed tool calls). Local dev: 0 retries so failures
  // surface immediately.
  retries: process.env.CI ? 1 : 0,
  // Hard cap so a stuck spec doesn't hang the cron job.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "playwright-report/junit.xml" }]]
    : [["list"]],
  use: {
    baseURL,
    // Non-headless in `:ui` mode so the inspector shows the UI.
    headless: !process.env.E2E_HEADED,
    // Capture trace on first failure to make remote-debugging easy.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Bridge expects a real Next.js viewport; the Storyboard canvas
    // uses ResizeObserver under the hood, which jsdom can't drive.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Local-run convenience: when no staging URL is provided, boot
  // the Next dev server. CI must always pass `E2E_STAGING_URL` so
  // the cron doesn't accidentally start a long-lived local
  // process.
  webServer: isLocalRun
    ? {
        command: "bun run dev",
        port: 3002,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
