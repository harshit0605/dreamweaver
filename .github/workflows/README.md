# GitHub Actions workflows

Three workflows form the M9.5 CI pyramid:

| Workflow | Trigger | Layers | Cost | Time |
|---|---|---|---|---|
| `ci-pr.yml` | every PR + push to main | L1 + L2 + L3 + L4 | $0 | <4m |
| `nightly-llm-smoke.yml` | cron 02:00 UTC daily | L5 | ~$0.006 | <5m |
| `pre-release-e2e.yml` | push to `release/*` + manual | L6 | ~$5 | <15m |

## Required secrets

| Name | Used by | What it is |
|---|---|---|
| `OPENAI_API_KEY_NIGHTLY` | nightly-llm-smoke | OpenAI key with a low daily budget cap. Smoke runs cost ~$0.006 each, so a $5/day cap is generous. |
| `OPENAI_API_KEY_E2E` | pre-release-e2e | OpenAI key for staging e2e runs. ~$5/run. |
| `E2E_TEST_USER_PASSWORD` | pre-release-e2e | Password for the `e2e-test@dreamweaver.local` seed user on staging. |

## Required variables

| Name | Used by | What it is |
|---|---|---|
| `E2E_STAGING_URL` | pre-release-e2e | Next.js staging URL (e.g. `https://app.staging.dreamweaver.example`). |
| `E2E_CONVEX_URL` | pre-release-e2e | Convex deployment URL the staging frontend points at. |
| `E2E_CONVEX_SITE_URL` | pre-release-e2e | Convex site URL (better-auth REST endpoint). |
| `E2E_TEST_USER_EMAIL` | pre-release-e2e | Seed user email. Defaults to `e2e-test@dreamweaver.local` if unset. |

Set them via the GitHub UI or CLI:

```sh
gh secret set OPENAI_API_KEY_NIGHTLY --body "$OPENAI_API_KEY_NIGHTLY"
gh secret set OPENAI_API_KEY_E2E --body "$OPENAI_API_KEY_E2E"
gh secret set E2E_TEST_USER_PASSWORD --body "$E2E_TEST_USER_PASSWORD"

gh variable set E2E_STAGING_URL --body "https://staging..."
gh variable set E2E_CONVEX_URL --body "https://....convex.cloud"
gh variable set E2E_CONVEX_SITE_URL --body "https://....convex.site"
gh variable set E2E_TEST_USER_EMAIL --body "e2e-test@dreamweaver.local"
```

## Activation checklist

The workflows are committed but inactive until the secrets land:

- [ ] `ci-pr.yml` — runs immediately on first PR (no secrets needed).
- [ ] `nightly-llm-smoke.yml` — needs `OPENAI_API_KEY_NIGHTLY`. Until then, every nightly run will fail at the install step → opens an issue. Set the secret first to avoid issue spam.
- [ ] `pre-release-e2e.yml` — needs all secrets + variables above. Without `E2E_STAGING_URL` set, the suite skips cleanly with no failures.

## Failure handling

* **`ci-pr.yml`**: failure blocks the PR (default behaviour).
* **`nightly-llm-smoke.yml`**: opens a GitHub issue tagged `test-failure agent nightly` so the team can triage in the morning. The `smoke-output.txt` artifact is attached to the issue body.
* **`pre-release-e2e.yml`**: uploads the Playwright HTML report + traces as artifacts. Failure on a release branch blocks the deploy by convention; teams running their own deploy gate should add a `needs: e2e` requirement to that workflow.

## Manual runs

```sh
# Trigger nightly-llm-smoke on demand (e.g. after a prompt change)
gh workflow run nightly-llm-smoke.yml

# Trigger e2e on demand against the current branch
gh workflow run pre-release-e2e.yml

# Trigger e2e for a specific spec
gh workflow run pre-release-e2e.yml -f spec_filter=director-narrative-analysis
```
