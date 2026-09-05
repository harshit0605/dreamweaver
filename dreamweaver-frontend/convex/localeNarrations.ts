/**
 * M8 — per-locale narration audio attachments.
 *
 * Upsert semantics: one row per (storyboardId, nodeId, locale). Later
 * regenerations overwrite the row's `mediaAssetId` rather than piling
 * up historical dubs — the asset itself still lives in `mediaAssets`
 * so producers can roll back by swapping the `mediaAssetId` through
 * this mutation.
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureStoryboardEditable, requireUser } from "./storyboardAccess";

export const upsertLocaleNarration = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    locale: v.string(),
    mediaAssetId: v.id("mediaAssets"),
    translatedText: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Locale narration media asset not found");
    }
    if (asset.kind !== "audio") {
      throw new ConvexError(
        `upsertLocaleNarration: asset kind is "${asset.kind}" (expected "audio")`,
      );
    }
    if (asset.storyboardId !== args.storyboardId) {
      throw new ConvexError(
        "Locale narration asset belongs to a different storyboard",
      );
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("localeNarrations")
      .withIndex("by_storyboard_locale_node", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("locale", args.locale)
          .eq("nodeId", args.nodeId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        mediaAssetId: args.mediaAssetId,
        translatedText: args.translatedText,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("localeNarrations", {
      storyboardId: args.storyboardId,
      userId,
      nodeId: args.nodeId,
      locale: args.locale,
      mediaAssetId: args.mediaAssetId,
      translatedText: args.translatedText,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** List every locale-narration row for (storyboardId, locale). Used
 *  by the reel manifest to override per-shot `audioUrl` with the
 *  dubbed asset's URL when the producer requests a non-source reel. */
export const listForReel = query({
  args: {
    storyboardId: v.id("storyboards"),
    locale: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const rows = await ctx.db
      .query("localeNarrations")
      .withIndex("by_storyboard_locale_node", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("locale", args.locale),
      )
      .collect();
    // Resolve the asset URL for each row so the reel manifest can
    // drop a single per-shot lookup into a map without a second
    // round of mediaAsset fetches.
    const results = await Promise.all(
      rows.map(async (row) => {
        const asset = await ctx.db.get(row.mediaAssetId);
        if (!asset || asset.kind !== "audio") return null;
        return {
          nodeId: row.nodeId,
          locale: row.locale,
          mediaAssetId: row.mediaAssetId,
          sourceUrl: asset.sourceUrl,
          translatedText: row.translatedText,
        };
      }),
    );
    return results.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
  },
});

/** List every available locale for a storyboard. Returns the distinct
 *  locale codes so the ReelPlayer's dubbing picker only shows
 *  languages that actually have dubs. */
export const listAvailableLocales = query({
  args: { storyboardId: v.id("storyboards") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const rows = await ctx.db
      .query("localeNarrations")
      .withIndex("by_storyboard_locale_node", (q) =>
        q.eq("storyboardId", args.storyboardId),
      )
      .collect();
    const locales = new Set<string>();
    for (const row of rows) {
      locales.add(row.locale);
    }
    return Array.from(locales).sort();
  },
});
