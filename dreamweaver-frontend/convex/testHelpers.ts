/**
 * M9.5 L6 — test-only helpers for the Playwright e2e suite.
 *
 * Three mutations that bootstrap + tear down test data:
 *   * `seedStoryboard` — creates a fresh storyboard with N shot nodes
 *     wired into a serial timeline. Returns the new storyboardId.
 *   * `archiveStoryboard` — flips status="archived" so the e2e
 *     teardown doesn't accumulate test rows on staging.
 *   * `purgeArchivedTestStoryboards` — admin sweep to hard-delete
 *     test rows older than 24h. Cron-friendly.
 *
 * SAFETY: every mutation is gated by `STORYBOARD_E2E_HELPERS_ENABLED`
 * — when the env var is NOT set to "true", the mutation throws
 * "E2E helpers disabled" before doing any work. Production
 * deployments leave the flag unset; staging + dev set it true.
 *
 * AUTH: helpers go through the normal `requireUser` path — every
 * seeded storyboard is owned by the calling user. The Playwright
 * fixture's `convexClient.setAuth(token)` sends the session bearer,
 * which `ctx.auth.getUserIdentity()` honours. Producer accounts
 * are NOT exempt; the env flag is the sole production guard.
 */

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import {
  ensureStoryboardOwner,
  requireUser,
} from "./storyboardAccess";

// ---------------------------------------------------------------------------
// Env-flag gate — flips every helper into a "Disabled" no-op in prod.
// ---------------------------------------------------------------------------

const ensureE2EEnabled = () => {
  // Convex env vars: set via `bunx convex env set
  // STORYBOARD_E2E_HELPERS_ENABLED true` on dev / staging.
  if (process.env.STORYBOARD_E2E_HELPERS_ENABLED !== "true") {
    throw new ConvexError(
      "E2E helpers disabled. Set STORYBOARD_E2E_HELPERS_ENABLED=true in "
      + "the Convex deployment to enable. NEVER enable this in production.",
    );
  }
};

// ---------------------------------------------------------------------------
// seedStoryboard — bootstraps a fresh test storyboard with N shots.
// ---------------------------------------------------------------------------

export const seedStoryboard = mutation({
  args: {
    title: v.string(),
    shotCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ensureE2EEnabled();
    const userId = await requireUser(ctx);
    const now = Date.now();
    const shotCount = Math.max(1, Math.min(40, args.shotCount ?? 12));

    // Storyboard row.
    const storyboardId = await ctx.db.insert("storyboards", {
      userId,
      title: args.title,
      description: `Auto-seeded by testHelpers:seedStoryboard at ${now}`,
      status: "active",
      isPinned: false,
      lastOpenedAt: now,
      deletionVersion: 0,
      nodeCount: shotCount,
      edgeCount: Math.max(0, shotCount - 1),
      imageCount: 0,
      videoCount: 0,
      mode: "graph_studio",
      visualTheme: "cinematic_studio",
      createdAt: now,
      updatedAt: now,
    });

    // N shot nodes laid out in a horizontal serial line. Segments use
    // the synthetic-reel-shots pattern from the L4 conftest so the
    // tension/beat heuristics produce sensible outputs against this
    // storyboard.
    const segments = [
      "Wide aerial sweep of the city at dawn.",
      "She receives the call and panics.",
      "Two characters argue around a kitchen table.",
      "She steps onto the rooftop to make her decision.",
      "Old friend appears with a quiet warning.",
      "Heist montage rolls to an upbeat score.",
      "She kills the lights and hides.",
      "Calm, peaceful aftermath as guards laugh and rest.",
      "She bleeds quietly in the storm; rain on glass.",
      "Memory of her mother in soft light.",
      "She rises, fixes her grip on the blade.",
      "She charges the door; the explosion blooms.",
    ];
    const labels = [
      "Opening", "Catalyst", "Debate", "Break Two",
      "B Story", "Fun and Games", "Midpoint", "Bad Guys Close In",
      "All Is Lost", "Dark Night", "Break Three", "Finale",
    ];

    const insertedNodeIds: string[] = [];
    for (let i = 0; i < shotCount; i++) {
      const nodeId = `n${i + 1}`;
      const segIdx = i % segments.length;
      // Mirror `defaultNodePayload` from storyboards.ts so the row
      // satisfies every required schema field (entityRefs,
      // continuity sub-object, historyContext, promptPack, media).
      // Without these the node can be inserted but the storyboard
      // page rejects it on snapshot reads.
      await ctx.db.insert("storyboardNodes", {
        storyboardId,
        userId,
        nodeId,
        nodeType: "shot",
        label: labels[segIdx] ?? `Shot ${i + 1}`,
        segment: segments[segIdx] ?? `Shot ${i + 1} segment.`,
        position: { x: 100 + i * 240, y: 200 },
        entityRefs: { characterIds: [] },
        continuity: {
          identityLockVersion: 1,
          wardrobeVariantIds: [],
          consistencyStatus: "ok" as const,
        },
        historyContext: {
          eventIds: [],
          rollingSummary: "",
          tokenBudgetUsed: 0,
          lineageHash: "",
        },
        promptPack: { continuityDirectives: [] },
        media: { images: [], videos: [] },
        status: "draft" as const,
        shotMeta: { durationS: 5 },
        createdAt: now,
        updatedAt: now,
      });
      insertedNodeIds.push(nodeId);
    }

    // Serial edges between consecutive shots so traverse.ts builds
    // a coherent primary line. Each edge gets a stable id +
    // isPrimary=true so the reel manifest reconstructs cleanly.
    for (let i = 0; i + 1 < shotCount; i++) {
      const edgeId = `e${i + 1}`;
      await ctx.db.insert("storyboardEdges", {
        storyboardId,
        userId,
        edgeId,
        sourceNodeId: insertedNodeIds[i],
        targetNodeId: insertedNodeIds[i + 1],
        edgeType: "serial",
        isPrimary: true,
        order: i,
        createdAt: now,
        updatedAt: now,
      });
    }

    return storyboardId;
  },
});

// ---------------------------------------------------------------------------
// archiveStoryboard — teardown sweep. Soft-archives so a failed e2e
// run can still be inspected; the purge mutation hard-deletes later.
// ---------------------------------------------------------------------------

export const archiveStoryboard = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    ensureE2EEnabled();
    const userId = await requireUser(ctx);
    await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    await ctx.db.patch(args.storyboardId, {
      status: "archived",
      updatedAt: Date.now(),
    });
    return { storyboardId: args.storyboardId, archived: true };
  },
});

// ---------------------------------------------------------------------------
// purgeArchivedTestStoryboards — admin sweep. Hard-deletes archived
// e2e storyboards older than 24h. Wired into a cron so staging
// doesn't accumulate test rows over time.
// ---------------------------------------------------------------------------

export const purgeArchivedTestStoryboards = mutation({
  args: {
    olderThanHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ensureE2EEnabled();
    const cutoff =
      Date.now() - (args.olderThanHours ?? 24) * 60 * 60 * 1000;
    const candidates = await ctx.db
      .query("storyboards")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "archived"),
          q.lt(q.field("updatedAt"), cutoff),
        ),
      )
      .take(100);

    let deleted = 0;
    for (const sb of candidates) {
      const description = String(sb.description ?? "");
      if (!description.startsWith("Auto-seeded by testHelpers")) {
        // Defensive: only purge rows the seedStoryboard helper
        // created. A producer-archived row with no auto-seed marker
        // should NEVER be purged here.
        continue;
      }
      // Hard-delete child nodes + edges first so foreign-key style
      // references don't dangle.
      const nodes = await ctx.db
        .query("storyboardNodes")
        .withIndex("by_storyboard_node", (q) =>
          q.eq("storyboardId", sb._id),
        )
        .collect();
      for (const n of nodes) await ctx.db.delete(n._id);

      const edges = await ctx.db
        .query("storyboardEdges")
        .withIndex("by_storyboard_edge", (q) =>
          q.eq("storyboardId", sb._id),
        )
        .collect();
      for (const e of edges) await ctx.db.delete(e._id);

      await ctx.db.delete(sb._id);
      deleted += 1;
    }

    return { deleted, cutoff };
  },
});

// ---------------------------------------------------------------------------
// healthCheck — sanity that the helpers + flag are wired up.
// ---------------------------------------------------------------------------

export const healthCheck = query({
  args: {},
  handler: async () => {
    return {
      enabled: process.env.STORYBOARD_E2E_HELPERS_ENABLED === "true",
      ts: Date.now(),
    };
  },
});
