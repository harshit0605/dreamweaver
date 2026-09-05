/**
 * M9 — narrative refinement state.
 *
 * Five tables live here:
 *   - narrativeBeats: Save-the-Cat / Harmon / Three-act / Kishōtenketsu /
 *     Hook-first beat plans per (storyboard, branch).
 *   - narrativeMotifs: recurring elements with source→payoff chains.
 *   - narrativeVariants: catalog linking each narrative-git branch to
 *     its generator, rationale, and producer-picked status.
 *   - reelNarrativeState: cached LangGraph working memory, mirrored
 *     from the agent on turn exit. JSON payloads for ontology
 *     flexibility.
 *   - (Node/edge fields are extended in schema.ts directly.)
 *
 * Mutations here are narrow — they only take the diff + invalidation
 * signals they need. The agent-side narrative_state.py uses these to
 * hydrate + persist state each turn.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { ensureStoryboardEditable, requireUser } from "./storyboardAccess";

const STRUCTURE_VALIDATOR = v.union(
  v.literal("save_the_cat"),
  v.literal("harmon_circle"),
  v.literal("three_act"),
  v.literal("kishotenketsu"),
  v.literal("hook_first"),
);

const BEAT_STATUS = v.union(
  v.literal("planned"),
  v.literal("assigned"),
  v.literal("missing"),
);

const LANDED_STATUS = v.union(
  v.literal("unplanted"),
  v.literal("planted"),
  v.literal("landed"),
);

const VARIANT_TYPE = v.union(
  v.literal("hook"),
  v.literal("structural"),
  v.literal("transition"),
  v.literal("remix"),
);

// How long rejected variant branches linger before the daily cron
// archives them. 14 days mirrors the "producer can still roll back a
// week or two" intent; longer would let variant sprawl bloat the
// branch picker.
const STALE_VARIANT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// ============================================================
// narrativeBeats
// ============================================================

/** Replace the entire beat plan for a (storyboard, branch) pair. We
 *  never PATCH individual slots — beat plans are recomputed as a unit
 *  by the beat_analyst, and the agent assignment/reconciliation rules
 *  live in Python (status transitions, override handling). */
export const upsertBeatPlan = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
    structure: STRUCTURE_VALIDATOR,
    beats: v.array(
      v.object({
        beatKey: v.string(),
        expectedActNumber: v.optional(v.number()),
        nodeId: v.optional(v.string()),
        status: BEAT_STATUS,
        rationale: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("narrativeBeats")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        structure: args.structure,
        beats: args.beats,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("narrativeBeats", {
      storyboardId: args.storyboardId,
      userId,
      branchId: args.branchId,
      structure: args.structure,
      beats: args.beats,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getBeatPlan = query({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    return ctx.db
      .query("narrativeBeats")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
  },
});

// ============================================================
// narrativeMotifs
// ============================================================

export const upsertMotif = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    motifKey: v.string(),
    description: v.string(),
    sourceNodeIds: v.array(v.string()),
    payoffNodeIds: v.array(v.string()),
    visualVocabulary: v.optional(v.string()),
    landedStatus: LANDED_STATUS,
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("narrativeMotifs")
      .withIndex("by_storyboard_motifKey", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("motifKey", args.motifKey),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        description: args.description,
        sourceNodeIds: args.sourceNodeIds,
        payoffNodeIds: args.payoffNodeIds,
        visualVocabulary: args.visualVocabulary,
        landedStatus: args.landedStatus,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("narrativeMotifs", {
      storyboardId: args.storyboardId,
      userId,
      motifKey: args.motifKey,
      description: args.description,
      sourceNodeIds: args.sourceNodeIds,
      payoffNodeIds: args.payoffNodeIds,
      visualVocabulary: args.visualVocabulary,
      landedStatus: args.landedStatus,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listMotifs = query({
  args: { storyboardId: v.id("storyboards") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    return ctx.db
      .query("narrativeMotifs")
      .withIndex("by_storyboard_updatedAt", (q) =>
        q.eq("storyboardId", args.storyboardId),
      )
      .order("desc")
      .take(200);
  },
});

export const deleteMotif = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    motifKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const row = await ctx.db
      .query("narrativeMotifs")
      .withIndex("by_storyboard_motifKey", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("motifKey", args.motifKey),
      )
      .unique();
    if (!row) return { deleted: false };
    await ctx.db.delete(row._id);
    return { deleted: true };
  },
});

// ============================================================
// narrativeVariants
// ============================================================

export const upsertVariant = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
    variantType: VARIANT_TYPE,
    rationale: v.string(),
    generatedByRunId: v.optional(v.string()),
    producerPicked: v.optional(v.boolean()),
    parentBranchId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("narrativeVariants")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        variantType: args.variantType,
        rationale: args.rationale,
        generatedByRunId: args.generatedByRunId,
        producerPicked: args.producerPicked ?? existing.producerPicked,
        parentBranchId: args.parentBranchId ?? existing.parentBranchId,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("narrativeVariants", {
      storyboardId: args.storyboardId,
      userId,
      branchId: args.branchId,
      variantType: args.variantType,
      rationale: args.rationale,
      generatedByRunId: args.generatedByRunId,
      producerPicked: args.producerPicked ?? false,
      parentBranchId: args.parentBranchId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Marks one variant as producer-picked; rejected siblings remain on
 *  the storyboard but can be archived by the cron. The caller is
 *  responsible for also calling `applyMergePolicy` on narrativeGit
 *  to promote the chosen branch to primary — this mutation is
 *  pure bookkeeping. */
export const markVariantPicked = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const row = await ctx.db
      .query("narrativeVariants")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
    if (!row) throw new ConvexError("Variant not found");
    await ctx.db.patch(row._id, {
      producerPicked: true,
      updatedAt: Date.now(),
    });
    return { branchId: args.branchId };
  },
});

export const listVariants = query({
  args: {
    storyboardId: v.id("storyboards"),
    variantType: v.optional(VARIANT_TYPE),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    if (args.variantType) {
      return ctx.db
        .query("narrativeVariants")
        .withIndex("by_storyboard_type", (q) =>
          q
            .eq("storyboardId", args.storyboardId)
            .eq("variantType", args.variantType as
              | "hook"
              | "structural"
              | "transition"
              | "remix"),
        )
        .order("desc")
        .take(100);
    }
    return ctx.db
      .query("narrativeVariants")
      .withIndex("by_storyboard_branch", (q) =>
        q.eq("storyboardId", args.storyboardId),
      )
      .order("desc")
      .take(200);
  },
});

/** Cron-driven: archive variant branches that were never picked and
 *  haven't been touched in 14 days. The branches themselves live in
 *  narrativeBranches and are archived via a separate mutation on
 *  narrativeGit; this pass only prunes the `narrativeVariants`
 *  catalog rows so the variant picker doesn't drown. */
export const purgeStaleVariantsInternal = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 2000);
    const cutoff = Date.now() - STALE_VARIANT_TTL_MS;
    const rows = await ctx.db.query("narrativeVariants").collect();
    let purged = 0;
    for (const row of rows) {
      if (purged >= limit) break;
      if (row.producerPicked) continue;
      if (
        typeof row.updatedAt === "number"
        && row.updatedAt < cutoff
      ) {
        await ctx.db.delete(row._id);
        purged += 1;
      }
    }
    return { purged, cutoff };
  },
});

// ============================================================
// reelNarrativeState (Convex mirror of LangGraph working memory)
// ============================================================

export const upsertReelNarrativeState = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
    structure: v.string(),
    beatMapJson: v.string(),
    motifRegistryJson: v.string(),
    tensionSamplesJson: v.string(),
    characterWantNeedJson: v.string(),
    computedFromCommitId: v.optional(v.string()),
    stale: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("reelNarrativeState")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
    const payload = {
      structure: args.structure,
      beatMapJson: args.beatMapJson,
      motifRegistryJson: args.motifRegistryJson,
      tensionSamplesJson: args.tensionSamplesJson,
      characterWantNeedJson: args.characterWantNeedJson,
      computedAt: now,
      computedFromCommitId: args.computedFromCommitId,
      stale: args.stale ?? false,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return ctx.db.insert("reelNarrativeState", {
      storyboardId: args.storyboardId,
      userId,
      branchId: args.branchId,
      ...payload,
    });
  },
});

export const getReelNarrativeState = query({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    return ctx.db
      .query("reelNarrativeState")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
  },
});

/** Fast invalidation — flip `stale=true` without touching the JSON
 *  payload. Called by commit handlers when a tracked node field
 *  (beatType, tensionLevel, segment) changes. */
export const markReelNarrativeStateStale = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    branchId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const row = await ctx.db
      .query("reelNarrativeState")
      .withIndex("by_storyboard_branch", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("branchId", args.branchId),
      )
      .unique();
    if (!row) return { stale: false };
    if (row.stale) return { stale: true };
    await ctx.db.patch(row._id, {
      stale: true,
      updatedAt: Date.now(),
    });
    return { stale: true };
  },
});

// ============================================================
// Node + edge narrative-field patches
// ============================================================
// These are narrow mutations scoped just to M9's narrative metadata.
// We intentionally don't fold them into `upsertNode` / `upsertEdge`
// because those mutations get called on every producer keystroke +
// every commit replay; threading narrative patches through them
// would both bloat the hot path and muddy the audit trail. Separate
// mutations → separate rows in toolAudits when the agent fires them.

/** Apply agent/producer-authored beat + tension + hook + motif
 *  patches to a single shot node. Pass `null` to clear a field.
 *  `undefined` (via omitting the key) leaves the existing value. */
export const setNodeNarrativeFields = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    beatType: v.optional(v.union(v.string(), v.null())),
    actNumber: v.optional(v.union(v.number(), v.null())),
    tensionLevel: v.optional(v.union(v.number(), v.null())),
    motifIds: v.optional(v.union(v.array(v.string()), v.null())),
    hookType: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("nodeId", args.nodeId),
      )
      .unique();
    if (!node) throw new ConvexError("Node not found");
    // tensionLevel clamped to [0, 10]. actNumber clamped to [1, 5]
    // (no canonical structure exceeds 5 acts).
    const clampedTension =
      args.tensionLevel === null
        ? undefined
        : typeof args.tensionLevel === "number"
          ? Math.max(0, Math.min(10, args.tensionLevel))
          : node.tensionLevel;
    const clampedAct =
      args.actNumber === null
        ? undefined
        : typeof args.actNumber === "number"
          ? Math.max(1, Math.min(5, Math.round(args.actNumber)))
          : node.actNumber;
    const nextBeatType =
      args.beatType === null
        ? undefined
        : typeof args.beatType === "string"
          ? args.beatType.trim() || undefined
          : node.beatType;
    const nextHookType =
      args.hookType === null
        ? undefined
        : typeof args.hookType === "string"
          ? args.hookType.trim() || undefined
          : node.hookType;
    const nextMotifIds =
      args.motifIds === null
        ? undefined
        : Array.isArray(args.motifIds)
          ? args.motifIds.filter((m) => typeof m === "string" && m.length > 0)
          : node.motifIds;
    await ctx.db.patch(node._id, {
      beatType: nextBeatType,
      actNumber: clampedAct,
      tensionLevel: clampedTension,
      hookType: nextHookType,
      motifIds: nextMotifIds,
      updatedAt: Date.now(),
    });
    return { nodeId: args.nodeId };
  },
});

/** Apply a transition-intent patch to a storyboard edge. Used by the
 *  transition_maestro's `request_transition_proposal` approval
 *  handler. Free-form string (validated against known vocabulary at
 *  the route boundary). */
export const setEdgeTransitionIntent = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    edgeId: v.string(),
    transitionIntent: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const edge = await ctx.db
      .query("storyboardEdges")
      .withIndex("by_storyboard_edge", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("edgeId", args.edgeId),
      )
      .unique();
    if (!edge) throw new ConvexError("Edge not found");
    const next =
      args.transitionIntent === null
        ? undefined
        : args.transitionIntent.trim() || undefined;
    await ctx.db.patch(edge._id, {
      transitionIntent: next,
      updatedAt: Date.now(),
    });
    return { edgeId: args.edgeId };
  },
});
