/**
 * M9.5 L6 — mint a fresh better-auth session for the e2e suite.
 *
 * Why: Convex's `ctx.auth.getUserIdentity()` reads the
 * `better-auth.convex_jwt` cookie (a 15-minute JWT) and validates
 * its signature against the deployment's public key. To run L6
 * specs end-to-end we need:
 *   1. A real test user in the auth.users table.
 *   2. A signed convex_jwt for that user.
 *
 * This script signs up a deterministic e2e test user (idempotent —
 * 200 if it already exists) then signs in to fetch a fresh JWT.
 * Outputs both cookie values so the caller can `eval` them or pipe
 * to `gh secret set` for CI.
 *
 * Usage:
 *   bun run scripts/mint-e2e-session.ts
 *   # Outputs:
 *   #   E2E_AUTH_SESSION_TOKEN=...
 *   #   E2E_AUTH_CONVEX_JWT=...
 *
 * The convex_jwt expires in 15 minutes — CI must mint a fresh one
 * at the start of each e2e job. The session_token (the cookie
 * `better-auth.session_token`) is good for 7 days; the auth client
 * exchanges it for a fresh JWT on each Convex call when present.
 *
 * SAFETY: this script is e2e-only. It signs up the user with a
 * fixed email + password — DO NOT enable on production. The user
 * is owned by the dev / staging deployment.
 */

const SITE_URL =
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  ?? process.env.E2E_CONVEX_SITE_URL;

if (!SITE_URL) {
  console.error(
    "Error: NEXT_PUBLIC_CONVEX_SITE_URL (or E2E_CONVEX_SITE_URL) must be set.",
  );
  process.exit(1);
}

const TEST_EMAIL =
  process.env.E2E_TEST_USER_EMAIL ?? "e2e-test@dreamweaver.local";
const TEST_PASSWORD =
  process.env.E2E_TEST_USER_PASSWORD ?? "e2e-test-password-1234";
const TEST_NAME = "E2E Test User";

type AuthBody = {
  token?: string;
  user?: { id: string; email: string };
  message?: string;
};

const parseSetCookies = (raw: string | null): Map<string, string> => {
  const map = new Map<string, string>();
  if (!raw) return map;
  // Browser fetch concatenates multiple Set-Cookie headers with `, `,
  // but cookie values themselves contain `,` for `Expires=...` dates.
  // Split on the comma-followed-by-cookie-name pattern to keep cookies
  // intact.
  const splits = raw.split(/, (?=[a-zA-Z0-9._-]+=)/);
  for (const cookie of splits) {
    const idx = cookie.indexOf("=");
    if (idx <= 0) continue;
    const name = cookie.slice(0, idx).trim();
    const value = cookie.slice(idx + 1).split(";")[0]?.trim() ?? "";
    if (value) map.set(name, value);
  }
  return map;
};

const callAuth = async (
  path: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  json: AuthBody;
  cookies: Map<string, string>;
}> => {
  const url = `${SITE_URL}/api/auth/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // `getSetCookie()` is the modern API (Node 20+, undici); fall back
  // to the joined `set-cookie` header for older runtimes.
  const rawCookieHeader =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (res.headers as Headers & { getSetCookie: () => string[] })
          .getSetCookie()
          .join(", ")
      : res.headers.get("set-cookie");
  const cookies = parseSetCookies(rawCookieHeader);
  let json: AuthBody = {};
  try {
    json = (await res.json()) as AuthBody;
  } catch {
    /* tolerate empty bodies on errors */
  }
  return { status: res.status, json, cookies };
};

const main = async () => {
  // Step 1: idempotent sign-up. If the user already exists,
  // better-auth returns 200/422 with a clear message — we proceed
  // to sign-in either way.
  const signup = await callAuth("sign-up/email", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    name: TEST_NAME,
  });

  if (signup.status === 200 && signup.cookies.size > 0) {
    // Fresh user — credentials already include a session.
    emit(signup.cookies);
    return;
  }

  // Step 2: sign-in with the existing user.
  const signin = await callAuth("sign-in/email", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (signin.status !== 200 || signin.cookies.size === 0) {
    console.error(
      `Sign-in failed: status=${signin.status}, body=${JSON.stringify(signin.json)}`,
    );
    process.exit(1);
  }
  emit(signin.cookies);
};

const emit = (cookies: Map<string, string>) => {
  const sessionToken = cookies.get("better-auth.session_token");
  const convexJwt = cookies.get("better-auth.convex_jwt");
  if (!sessionToken || !convexJwt) {
    console.error(
      `Auth response missing expected cookies. Got: ${[...cookies.keys()].join(", ")}`,
    );
    process.exit(1);
  }
  // Print as shell-eval-able lines so a CI step can do:
  //   eval "$(bun run scripts/mint-e2e-session.ts)"
  console.log(`export E2E_AUTH_SESSION_TOKEN='${sessionToken}'`);
  console.log(`export E2E_AUTH_CONVEX_JWT='${convexJwt}'`);
  console.error(`✓ Minted session for ${TEST_EMAIL}`);
};

void main();
