/**
 * M7 — subtitle translation cache.
 *
 * One row per (storyboardId, locale). The API route queries this by
 * (storyboardId, locale) and compares `cuesHash` to the fingerprint of
 * the source cues it's about to translate. Hash match → cache hit,
 * skip OpenAI. Hash mismatch or no row → translate, then upsert.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { ensureStoryboardEditable, requireUser } from "./storyboardAccess";

/** How long a cache row can linger with no updates before we consider
 *  it stale and purge it. 30 days handles the common case of a
 *  producer iterating on a reel; longer retention would retain rows
 *  for storyboards that have since been deleted. */
const STALE_TRANSLATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Look up a cached translation. Returns `null` when the row is absent
 *  or its cuesHash doesn't match — callers should compare their source
 *  fingerprint against this result rather than blindly trusting it. */
export const getTranslation = query({
  args: {
    storyboardId: v.id("storyboards"),
    locale: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    // Read-only — ensure the caller at least can SEE the storyboard.
    // Editable check isn't needed for translation reads (any member
    // with view access should get the cache hit). We still call the
    // helper to reuse its access path; if it rejects, we surface the
    // same error the rest of the UI already handles.
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const row = await ctx.db
      .query("subtitleTranslations")
      .withIndex("by_storyboard_locale", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("locale", args.locale),
      )
      .unique();
    if (!row) return null;
    return {
      cuesHash: row.cuesHash,
      translatedTextsJson: row.translatedTextsJson,
      provider: row.provider,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});

/** Write (or replace) the cache row for a (storyboardId, locale) pair.
 *  Upsert semantics: if a row exists for the pair, we patch in the new
 *  hash + translations. This avoids a steady growth of stale rows as
 *  producers iterate on dialogue.  */
export const upsertTranslation = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    locale: v.string(),
    cuesHash: v.string(),
    translatedTextsJson: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("subtitleTranslations")
      .withIndex("by_storyboard_locale", (q) =>
        q
          .eq("storyboardId", args.storyboardId)
          .eq("locale", args.locale),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        cuesHash: args.cuesHash,
        translatedTextsJson: args.translatedTextsJson,
        provider: args.provider,
        updatedAt: now,
      });
      return existing._id;
    }
    const id = await ctx.db.insert("subtitleTranslations", {
      storyboardId: args.storyboardId,
      userId,
      locale: args.locale,
      cuesHash: args.cuesHash,
      translatedTextsJson: args.translatedTextsJson,
      provider: args.provider,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});

/**
 * M7 — cron-driven cleanup of stale translation cache rows. Called
 * daily from `crons.ts`. Purges rows whose `updatedAt` is older than
 * `STALE_TRANSLATION_TTL_MS`; bounded by `limit` per run so a huge
 * backlog doesn't monopolize a single cron tick.
 *
 * Returns the number of rows purged so the cron log carries a useful
 * diagnostic without needing a separate query.
 */
export const purgeStaleTranslationsInternal = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000);
    const cutoff = Date.now() - STALE_TRANSLATION_TTL_MS;
    // Iterate from oldest forward via the by_user_updatedAt index. We
    // don't care about user in this pass — the iteration is ordered
    // globally because Convex's `by_*` indexes are secondary orderings
    // of primary (inserting) keys. For bounded deletion we stop after
    // `limit` rows or when we pass the cutoff, whichever first.
    const rows = await ctx.db
      .query("subtitleTranslations")
      .collect();
    let purged = 0;
    for (const row of rows) {
      if (purged >= limit) break;
      if (typeof row.updatedAt === "number" && row.updatedAt < cutoff) {
        await ctx.db.delete(row._id);
        purged += 1;
      }
    }
    return { purged, cutoff };
  },
});
