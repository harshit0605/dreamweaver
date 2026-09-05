# CLAUDE.md — convex/

Source of truth for Dreamweaver. 44 tables, ~11k LOC of functions, Better Auth via `@convex-dev/better-auth`.

Separate from the Next.js app in ways that matter: it's a different runtime, it has its own auth model, and the app `tsconfig.json` **excludes this directory** — so `bun run build` passing tells you nothing about whether these files typecheck.

---

## Before you touch anything

```bash
bun run convex:dev     # from dreamweaver-frontend/ — leave it running
```

`convex/_generated/` is gitignored and absent in a fresh clone. Without the dev daemon, `./_generated/server` and `./_generated/dataModel` imports are unresolved and nothing here typechecks. The daemon also pushes on save — that's your feedback loop; watch its output the way you'd watch a compiler.

(`convex/auth_config/_generated/` *is* committed — that's Better Auth's generated schema, produced by `bun run auth:generate-schema`. Different thing, don't confuse them.)

---

## The renaming hazard

Callers address functions by **string**, not by generated type — `mutationRef("storyboards:upsertNode")` in `src/lib/convexRefs.ts`. Renaming or moving an export here compiles cleanly and breaks at runtime.

After any rename:

```bash
grep -rn '"oldFile:oldExport"' ../src ../convex
```

---

## Auth and authorization — every mutation, no exceptions

`storyboardAccess.ts` is the gate. The pattern, verbatim:

```ts
const userId = await requireUser(ctx);                              // throws ConvexError("Unauthorized")
await ensureStoryboardEditable(ctx, args.storyboardId, userId);     // owner + not trashed
```

- `requireUser` → `ctx.auth.getUserIdentity()`, returns `tokenIdentifier`. This is the string stored in every `userId` field.
- `ensureStoryboardOwner` → exists **and** owned by this user; a non-owner gets `"Storyboard not found"`, not `"Forbidden"` (don't leak existence).
- `ensureStoryboardEditable` → the above plus `status === "active"`.

Reads that cross a storyboard boundary need the same treatment. The CopilotKit runtime route is deliberately unauthenticated for agent discovery — **these gates are what actually protect the data**, so an ungated mutation here is a real hole, not a style nit.

---

## Table groups

| Group | Tables |
|---|---|
| Graph | `storyboards`, `storyboardNodes`, `storyboardEdges`, `scenes`, `shots`, `storyEvents`, `nodeHistoryContexts` |
| Entities / continuity | `characters`, `wardrobeVariants`, `backgrounds`, `identityPacks`, `identityReferenceAssets`, `globalConstraints`, `continuityViolations` |
| Media | `mediaAssets`, `mediaComments`, `generations`, `reelExports` |
| Narrative git | `narrativeBranches`, `narrativeCommits`, `semanticDiffs`, `dryRunReports` |
| Agent / HITL | `agentRuns`, `approvalTasks`, `agentDelegations`, `autonomousDailies`, `simulationCriticRuns` |
| Teams / governance | `agentTeams`, `agentTeamRevisions`, `agentTeamAssignments`, `agentTeamMembers`, `agentTeamRunPolicies`, `teamPromptDrafts`, `quotaProfiles`, `quotaUsageWindows`, `secretHandles`, `toolCallAudits` |

### The heavy modules

- **`storyboards.ts` (2117)** — CRUD, trash/restore/purge with `purgeAt` + `deletionVersion`, duplicate, `bulkCreateNodes`/`bulkCreateEdges` (ingestion targets), `applyGraphPatch` (agent target), `compileNodePromptPack`, `refreshNodeHistoryContexts`.
- **`agentTeams.ts` (1229)** — teams → revisions → publish/rollback, member config, prompt drafts, and `resolveEffectiveRuntimeConfig`, which produces the `effective_tool_scope` allowlist the agent router enforces.
- **`narrativeGit.ts` (1165)** — branches, commits, `simulateExecutionPlan` (dry run), `commitPlanOps`, `rollbackToCommit`, `cherryPickCommit`, `applyMergePolicy`, `computeSemanticDiff`, cut tiers, review rounds, delegation records.
- **`mediaAssets.ts` (992)** — assets + variants, generation lifecycle (`start`/`complete`/`fail`/`sweepStale`), take status (NG flagging drives `flaggedOnly` regeneration), delivery matrix, `promoteVariantToMaster`.
- **`dailies.ts` (887)**, **`continuityOS.ts` (463)**, **`identityReferences.ts`**, **`secretHandles.ts`**, **`storyboardTemplates.ts`**.

---

## Schema conventions

- **Validators are shared consts** at the top of `schema.ts` — `nodeTypeValidator`, `approvalStatusValidator`, `riskLevelValidator`, `consistencyStatusValidator`, `mediaVariantValidator`, etc. Reuse them; don't inline a duplicate union.
- **New fields on existing tables are `v.optional(...)`** unless you're writing a backfill. Existing rows won't have them. See `storyboards.editorState` for the pattern, comment included.
- **Index names describe the key path**: `by_user_updatedAt`, `by_user_status_pinned_updatedAt`. Add an index rather than filtering in JS — several tables carry 4–5 for exactly this reason.
- **Denormalized counters** (`nodeCount`, `edgeCount`, `imageCount`, `videoCount`) are maintained by `recomputeStoryboardStats`. If you change what a count means, update that too.
- Comment the *why* on non-obvious fields — the schema is the primary reference for anyone reading this system.

## Other

- `crons.ts` — one daily job, purging expired trashed storyboards (03:30 UTC, limit 200) via `internal.storyboards.purgeExpiredTrashedStoryboardsInternal`. Internal mutations are the right tool for cron targets.
- `http.ts` — Better Auth routes mounted at `/api/auth`, plus `/api/ping` and `/api/echo` debug endpoints.
- `_debugAuth.ts` — dev-only probes (`probeAuthSignUp`, `resetPasswordDev`). Don't extend it; don't reference it from product code.
