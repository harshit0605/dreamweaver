/**
 * M8 — producer-scoped voice clone catalog.
 *
 * Voice clones live at the user level (not per-storyboard) because the
 * real-world consent + legal obligations attach to the producer, not
 * a specific project. Identity packs across any of the producer's
 * storyboards can attach to the same clone via
 * `identityPacks.voiceCloneId`.
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./storyboardAccess";

export const createVoiceClone = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    elevenlabsVoiceId: v.string(),
    previewUrl: v.optional(v.string()),
    locale: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const name = args.name.trim();
    if (!name) {
      throw new ConvexError("Voice clone name is required");
    }
    const elevenlabsVoiceId = args.elevenlabsVoiceId.trim();
    if (!elevenlabsVoiceId) {
      throw new ConvexError("elevenlabsVoiceId is required");
    }
    const now = Date.now();
    return ctx.db.insert("voiceClones", {
      userId,
      name: name.slice(0, 80),
      description: args.description?.slice(0, 400),
      elevenlabsVoiceId,
      previewUrl: args.previewUrl,
      locale: args.locale?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const deleteVoiceClone = mutation({
  args: { voiceCloneId: v.id("voiceClones") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(args.voiceCloneId);
    if (!row) return { deleted: false };
    if (row.userId !== userId) {
      throw new ConvexError("Voice clone belongs to a different producer");
    }
    await ctx.db.delete(args.voiceCloneId);
    // Defensive pass: clear any `identityPacks.voiceCloneId` that
    // pointed at this clone so deletion doesn't leave dangling refs.
    // Scoped to THIS producer's packs to bound the scan.
    const orphanedPacks = await ctx.db
      .query("identityPacks")
      .withIndex("by_user_visibility_updatedAt", (q) =>
        q.eq("userId", userId),
      )
      .collect();
    for (const pack of orphanedPacks) {
      if (pack.voiceCloneId === args.voiceCloneId) {
        await ctx.db.patch(pack._id, {
          voiceCloneId: undefined,
          updatedAt: Date.now(),
        });
      }
    }
    return { deleted: true };
  },
});

/** List this producer's voice clones, newest first. The picker in the
 *  identity pack row consumes this. */
export const listVoiceClones = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("voiceClones")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    return rows.map((row) => ({
      _id: row._id,
      name: row.name,
      description: row.description ?? null,
      elevenlabsVoiceId: row.elevenlabsVoiceId,
      previewUrl: row.previewUrl ?? null,
      locale: row.locale ?? null,
      createdAt: row.createdAt,
    }));
  },
});

/** Attach (or detach) a voice clone to an identity pack. Pass
 *  `voiceCloneId: null` to clear the mapping. */
export const setPackVoiceClone = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    packId: v.string(),
    voiceCloneId: v.union(v.id("voiceClones"), v.null()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    // Verify the clone belongs to the producer before attaching.
    if (args.voiceCloneId !== null) {
      const clone = await ctx.db.get(args.voiceCloneId);
      if (!clone) {
        throw new ConvexError("Voice clone not found");
      }
      if (clone.userId !== userId) {
        throw new ConvexError(
          "Voice clone belongs to a different producer",
        );
      }
    }
    const pack = await ctx.db
      .query("identityPacks")
      .withIndex("by_storyboard_pack", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("packId", args.packId),
      )
      .unique();
    if (!pack) {
      throw new ConvexError("Identity pack not found");
    }
    if (pack.userId !== userId) {
      throw new ConvexError(
        "Identity pack belongs to a different producer",
      );
    }
    await ctx.db.patch(pack._id, {
      voiceCloneId: args.voiceCloneId ?? undefined,
      updatedAt: Date.now(),
    });
    return { packId: args.packId, voiceCloneId: args.voiceCloneId };
  },
});
