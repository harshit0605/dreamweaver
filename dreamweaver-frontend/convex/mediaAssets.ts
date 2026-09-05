import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ensureStoryboardEditable, requireUser } from "./storyboardAccess";
import { recomputeStoryboardStatsInternal } from "./storyboardStats";

// Shared validators for delivery-variant surface. Keep the literals in sync
// with the matching blocks in `convex/schema.ts` for the `mediaAssets` table.
const deliveryVariantSpecValidator = v.object({
  aspect: v.optional(v.union(
    v.literal("2.39:1"), v.literal("1.85:1"), v.literal("16:9"),
    v.literal("9:16"), v.literal("4:5"), v.literal("1:1"), v.literal("2:1"),
  )),
  durationS: v.optional(v.number()),
  locale: v.optional(v.string()),
  abLabel: v.optional(v.string()),
  platform: v.optional(v.union(
    v.literal("meta"), v.literal("tiktok"), v.literal("youtube"),
    v.literal("ctv"), v.literal("dv360"), v.literal("x"),
    v.literal("linkedin"), v.literal("other"),
  )),
  endCard: v.optional(v.string()),
  notes: v.optional(v.string()),
});

const deliveryStatusValidator = v.union(
  v.literal("planned"), v.literal("in_review"),
  v.literal("approved"), v.literal("delivered"), v.literal("archived"),
);

// Hard ceiling on cartesian expansion. Mirrors
// `MATRIX_MAX_ROWS` in `src/lib/delivery-matrix/expand.ts`; the shared
// `expandVariantMatrix` in that file carries the canonical algorithm and
// test coverage. We re-implement the math inline here because Convex
// functions can't reliably import from `src/` at build time.
const DELIVERY_MATRIX_MAX_ROWS = 500;

// Pending media generations older than this are considered zombies and flipped to
// "failed" by the sweeper. LTX-2.3 video can take ~15min end-to-end; 30min gives
// a generous buffer before we assume the request was lost to a process crash /
// network flake / route timeout.
const STALE_MEDIA_THRESHOLD_MS = 30 * 60 * 1000;

export const createMediaAsset = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    kind: v.union(
      v.literal("image"),
      v.literal("video"),
      v.literal("audio"),
      v.literal("sfx"),
      v.literal("score"),
    ),
    sourceUrl: v.string(),
    modelId: v.string(),
    prompt: v.string(),
    negativePrompt: v.optional(v.string()),
    status: v.optional(v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"))),
    metadata: v.optional(v.record(v.string(), v.string())),
    identityScore: v.optional(v.number()),
    consistencyScore: v.optional(v.number()),
    wardrobeCompliance: v.optional(
      v.union(v.literal("matching"), v.literal("deviation"), v.literal("unknown")),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const assetId = await ctx.db.insert("mediaAssets", {
      storyboardId: args.storyboardId,
      userId,
      nodeId: args.nodeId,
      kind: args.kind,
      sourceUrl: args.sourceUrl,
      modelId: args.modelId,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      status: args.status ?? "completed",
      metadata: args.metadata,
      identityScore: args.identityScore,
      consistencyScore: args.consistencyScore,
      wardrobeCompliance: args.wardrobeCompliance,
      createdAt: now,
      updatedAt: now,
    });

    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .unique();
    if (node) {
      const variant = {
        mediaAssetId: assetId,
        url: args.sourceUrl,
        modelId: args.modelId,
        createdAt: now,
        // Propagate metadata (e.g. SFX volumeDb) onto the variant so
        // the reel export can read it without a second Convex fetch.
        ...(args.metadata ? { metadata: args.metadata } : {}),
      };
      const nextImages =
        args.kind === "image" ? [...node.media.images, variant] : node.media.images;
      const nextVideos =
        args.kind === "video" ? [...node.media.videos, variant] : node.media.videos;
      const existingAudios = node.media.audios ?? [];
      const nextAudios =
        args.kind === "audio" ? [...existingAudios, variant] : existingAudios;
      const existingSfxs = node.media.sfxs ?? [];
      const nextSfxs =
        args.kind === "sfx" ? [...existingSfxs, variant] : existingSfxs;

      await ctx.db.patch(node._id, {
        media: {
          images: nextImages,
          videos: nextVideos,
          audios: nextAudios,
          sfxs: nextSfxs,
          activeImageId: args.kind === "image" ? assetId : node.media.activeImageId,
          activeVideoId: args.kind === "video" ? assetId : node.media.activeVideoId,
          activeAudioId: args.kind === "audio" ? assetId : node.media.activeAudioId,
          activeSfxId: args.kind === "sfx" ? assetId : node.media.activeSfxId,
        },
        updatedAt: now,
      });
    }

    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
    return assetId;
  },
});

/**
 * Creates a `pending` media asset row before the upstream generation request is
 * fired. The returned assetId doubles as the job handle: the caller passes it to
 * {@link completeMediaGeneration} on success or {@link failMediaGeneration} on
 * failure/abort. The storyboardNodes row is NOT patched here — the node only
 * gains the media entry once the generation actually produces a URL.
 *
 * Pending rows survive page reloads and process restarts, so a user refreshing
 * mid-generation still sees a pending asset (and can be shown a spinner/retry).
 * Rows stuck in `pending` are cleaned up by {@link sweepStaleMediaGenerations}.
 */
export const startMediaGeneration = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    kind: v.union(
      v.literal("image"),
      v.literal("video"),
      v.literal("audio"),
      v.literal("sfx"),
      v.literal("score"),
    ),
    modelId: v.string(),
    prompt: v.string(),
    negativePrompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const assetId = await ctx.db.insert("mediaAssets", {
      storyboardId: args.storyboardId,
      userId,
      nodeId: args.nodeId,
      kind: args.kind,
      // Empty sourceUrl is the sentinel for "not yet completed"; filled in by
      // completeMediaGeneration. Schema requires v.string() so "" is used.
      sourceUrl: "",
      modelId: args.modelId,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return assetId;
  },
});

/**
 * Flips a pending row to `completed`, writes the final URL, optional consistency
 * scores, and patches the storyboardNodes row so the media surface in the UI
 * starts rendering. Mirrors the node-patching behavior that used to live in the
 * single-shot {@link createMediaAsset} path.
 */
export const completeMediaGeneration = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    sourceUrl: v.string(),
    modelId: v.optional(v.string()),
    identityScore: v.optional(v.number()),
    consistencyScore: v.optional(v.number()),
    wardrobeCompliance: v.optional(
      v.union(v.literal("matching"), v.literal("deviation"), v.literal("unknown")),
    ),
    metadata: v.optional(v.record(v.string(), v.string())),
    /** M8 — when true, the completion writes the sourceUrl onto the
     *  asset row but SKIPS patching the node's media variant arrays.
     *  Used by the multi-locale narration pipeline: we want a
     *  separate asset per dubbed locale but we don't want the dub
     *  to replace the source-language `activeAudioId`. The asset is
     *  linked to the shot via the `localeNarrations` table instead. */
    skipNodePatch: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    // Refuse to complete a row that was already terminal — otherwise a late
    // fetch resolving after the sweeper flipped the row to failed would clobber
    // the failure record.
    if (asset.status !== "pending") {
      return args.mediaAssetId;
    }

    const now = Date.now();
    await ctx.db.patch(args.mediaAssetId, {
      status: "completed",
      sourceUrl: args.sourceUrl,
      modelId: args.modelId ?? asset.modelId,
      identityScore: args.identityScore,
      consistencyScore: args.consistencyScore,
      wardrobeCompliance: args.wardrobeCompliance,
      metadata: args.metadata,
      updatedAt: now,
    });

    const node = args.skipNodePatch
      ? null
      : await ctx.db
          .query("storyboardNodes")
          .withIndex("by_storyboard_node", (q) =>
            q.eq("storyboardId", asset.storyboardId).eq("nodeId", asset.nodeId),
          )
          .unique();
    if (node) {
      const effectiveModelId = args.modelId ?? asset.modelId;
      const variant = {
        mediaAssetId: args.mediaAssetId,
        url: args.sourceUrl,
        modelId: effectiveModelId,
        createdAt: now,
        // See createMediaAsset — metadata flows onto the variant so
        // downstream readers (reel export) don't need an extra fetch.
        ...(args.metadata ? { metadata: args.metadata } : {}),
      };
      const nextImages =
        asset.kind === "image" ? [...node.media.images, variant] : node.media.images;
      const nextVideos =
        asset.kind === "video" ? [...node.media.videos, variant] : node.media.videos;
      const existingAudios = node.media.audios ?? [];
      const nextAudios =
        asset.kind === "audio" ? [...existingAudios, variant] : existingAudios;
      const existingSfxs = node.media.sfxs ?? [];
      const nextSfxs =
        asset.kind === "sfx" ? [...existingSfxs, variant] : existingSfxs;

      await ctx.db.patch(node._id, {
        media: {
          images: nextImages,
          videos: nextVideos,
          audios: nextAudios,
          sfxs: nextSfxs,
          activeImageId:
            asset.kind === "image" ? args.mediaAssetId : node.media.activeImageId,
          activeVideoId:
            asset.kind === "video" ? args.mediaAssetId : node.media.activeVideoId,
          activeAudioId:
            asset.kind === "audio" ? args.mediaAssetId : node.media.activeAudioId,
          activeSfxId:
            asset.kind === "sfx" ? args.mediaAssetId : node.media.activeSfxId,
        },
        updatedAt: now,
      });
    }

    await recomputeStoryboardStatsInternal(ctx, asset.storyboardId);
    return args.mediaAssetId;
  },
});

/**
 * Flips a pending row to `failed`, stashing the error message under metadata.error
 * so the UI can surface it. No-op if the row is already terminal. The storyboard
 * node is intentionally NOT patched — a failed generation should never leak into
 * the node's media arrays.
 */
export const failMediaGeneration = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    if (asset.status !== "pending") {
      return args.mediaAssetId;
    }
    const now = Date.now();
    // Cap the stored error message so a pathological upstream stack trace
    // doesn't blow up the row size.
    const truncatedError = args.errorMessage.slice(0, 1000);
    await ctx.db.patch(args.mediaAssetId, {
      status: "failed",
      metadata: { ...(asset.metadata ?? {}), error: truncatedError },
      updatedAt: now,
    });
    return args.mediaAssetId;
  },
});

/**
 * Marks rows stuck in `pending` beyond {@link STALE_MEDIA_THRESHOLD_MS} as
 * `failed` with a generic zombie error. Called on storyboard open so a
 * page-reload / process-crash mid-generation doesn't leave forever-spinning
 * placeholders.
 */
export const sweepStaleMediaGenerations = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const cutoff = Date.now() - STALE_MEDIA_THRESHOLD_MS;
    const candidates = await ctx.db
      .query("mediaAssets")
      .withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", args.storyboardId))
      .collect();
    let swept = 0;
    for (const row of candidates) {
      if (row.status === "pending" && row.updatedAt < cutoff) {
        await ctx.db.patch(row._id, {
          status: "failed",
          metadata: {
            ...(row.metadata ?? {}),
            error: "Generation exceeded the stale threshold and was marked failed by the sweeper.",
          },
          updatedAt: Date.now(),
        });
        swept += 1;
      }
    }
    return { swept };
  },
});

/**
 * Compensation for partial batch failures in `executeApprovedExecutionPlan`:
 * given a set of mediaAsset IDs that were created by earlier successful ops in
 * a batch which subsequently failed, flip each row to `"rolled_back"` and
 * remove it from its node's active media arrays. Preserves the row + prompt
 * for audit so reviewers can see what was generated and then reverted.
 *
 * Idempotent: rows already in `rolled_back`/`failed` are skipped. Rows still
 * `pending` are fast-forwarded to `rolled_back` (a concurrent complete call
 * that races this will short-circuit because it checks `status === "pending"`
 * before patching the node).
 */
export const revertBatchMediaAssets = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    mediaAssetIds: v.array(v.id("mediaAssets")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const reason = args.reason?.slice(0, 500);

    // Build a set for O(1) lookup when cleaning each node's media arrays.
    const rollbackSet = new Set<string>(args.mediaAssetIds.map((id) => String(id)));

    // Track which nodes need patching. We may encounter the same node
    // multiple times (one batch can touch the same node multiple ops, though
    // unusual) so dedupe by nodeId.
    const touchedNodeIds = new Set<string>();
    let reverted = 0;
    let skipped = 0;

    for (const assetId of args.mediaAssetIds) {
      const asset = await ctx.db.get(assetId);
      if (!asset) {
        skipped += 1;
        continue;
      }
      if (asset.storyboardId !== args.storyboardId) {
        // Wrong storyboard: caller error, but fail soft rather than abort
        // mid-loop and leave some assets compensated and others not.
        skipped += 1;
        continue;
      }
      if (asset.status === "rolled_back" || asset.status === "failed") {
        skipped += 1;
        continue;
      }
      await ctx.db.patch(assetId, {
        status: "rolled_back",
        metadata: {
          ...(asset.metadata ?? {}),
          ...(reason ? { rollbackReason: reason } : {}),
          rolledBackAt: String(now),
        },
        updatedAt: now,
      });
      touchedNodeIds.add(asset.nodeId);
      reverted += 1;
    }

    // Strip the reverted assets out of each affected node's media arrays and
    // clear activeImageId/activeVideoId if they point at a rolled-back asset.
    for (const nodeId of touchedNodeIds) {
      const node = await ctx.db
        .query("storyboardNodes")
        .withIndex("by_storyboard_node", (q) =>
          q.eq("storyboardId", args.storyboardId).eq("nodeId", nodeId),
        )
        .unique();
      if (!node) continue;
      const nextImages = node.media.images.filter(
        (entry) => !rollbackSet.has(String(entry.mediaAssetId)),
      );
      const nextVideos = node.media.videos.filter(
        (entry) => !rollbackSet.has(String(entry.mediaAssetId)),
      );
      const nextActiveImage =
        node.media.activeImageId && rollbackSet.has(String(node.media.activeImageId))
          ? nextImages[nextImages.length - 1]?.mediaAssetId
          : node.media.activeImageId;
      const nextActiveVideo =
        node.media.activeVideoId && rollbackSet.has(String(node.media.activeVideoId))
          ? nextVideos[nextVideos.length - 1]?.mediaAssetId
          : node.media.activeVideoId;
      await ctx.db.patch(node._id, {
        media: {
          images: nextImages,
          videos: nextVideos,
          activeImageId: nextActiveImage,
          activeVideoId: nextActiveVideo,
        },
        updatedAt: now,
      });
    }

    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);

    return { reverted, skipped };
  },
});

export const setActiveMediaVariant = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    mediaAssetId: v.id("mediaAssets"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const [node, asset] = await Promise.all([
      ctx.db
        .query("storyboardNodes")
        .withIndex("by_storyboard_node", (q) =>
          q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
        )
        .unique(),
      ctx.db.get(args.mediaAssetId),
    ]);

    if (!node || !asset || asset.storyboardId !== args.storyboardId) {
      throw new ConvexError("Node or media asset not found");
    }

    // Spread `node.media` and override only the active id for the
    // matching kind. The previous shape of this patch omitted
    // `audios` / `sfxs` / their active ids — a latent bug that wiped
    // narration + SFX attachments when a producer swapped an image
    // or video variant. Keep every field; mutate one.
    await ctx.db.patch(node._id, {
      media: {
        ...node.media,
        activeImageId:
          asset.kind === "image" ? args.mediaAssetId : node.media.activeImageId,
        activeVideoId:
          asset.kind === "video" ? args.mediaAssetId : node.media.activeVideoId,
        activeAudioId:
          asset.kind === "audio" ? args.mediaAssetId : node.media.activeAudioId,
        activeSfxId:
          asset.kind === "sfx" ? args.mediaAssetId : node.media.activeSfxId,
      },
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.storyboardId, { updatedAt: Date.now() });
    return node._id;
  },
});

export const updateConsistencyScores = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    identityScore: v.number(),
    consistencyScore: v.number(),
    wardrobeCompliance: v.union(v.literal("matching"), v.literal("deviation"), v.literal("unknown")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    await ctx.db.patch(args.mediaAssetId, {
      identityScore: args.identityScore,
      consistencyScore: args.consistencyScore,
      wardrobeCompliance: args.wardrobeCompliance,
      updatedAt: Date.now(),
    });
    return args.mediaAssetId;
  },
});

/**
 * Review take-status control. Passing `takeStatus: undefined` clears it.
 * Auth-guarded via the asset's owning storyboardId — any user with
 * storyboard-edit access may set the status (review notes aren't scoped to
 * the original author).
 */
export const setTakeStatus = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    takeStatus: v.optional(v.union(
      v.literal("print"),
      v.literal("hold"),
      v.literal("ng"),
      v.literal("noted"),
    )),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    await ctx.db.patch(args.mediaAssetId, {
      takeStatus: args.takeStatus,
      updatedAt: Date.now(),
    });
    return args.mediaAssetId;
  },
});

/**
 * M7 — update the volume (in dB) of an SFX media asset. Scoped
 * narrowly to `kind === "sfx"` so callers can't repurpose this
 * endpoint to mangle metadata on narration / image / video rows.
 *
 * The value is persisted in the asset's `metadata.volumeDb` slot as
 * a string (Convex's `v.record(v.string(), v.string())` shape). The
 * reel-export pipeline reads it back when pre-mixing the SFX under
 * narration; see the export-reel route for the read side.
 */
export const setSfxVolume = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    volumeDb: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    if (asset.kind !== "sfx") {
      throw new ConvexError(
        `setSfxVolume: asset kind is "${asset.kind}" (expected "sfx")`,
      );
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    // Clamp to the SFX window. Mirrors the constants in
    // `src/lib/sfx/index.ts` — duplicating them here avoids a
    // client-library import into Convex functions (which run on a
    // different bundle).
    const clampedVolume = Math.max(-40, Math.min(0, args.volumeDb));
    const nextMetadata = {
      ...(asset.metadata ?? {}),
      volumeDb: String(clampedVolume),
    };
    const now = Date.now();
    await ctx.db.patch(args.mediaAssetId, {
      metadata: nextMetadata,
      updatedAt: now,
    });

    // Also patch the matching variant on the node so the reel-manifest
    // reads consistent metadata (the manifest never fetches individual
    // mediaAssets, only reads the node's media variant arrays).
    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", asset.storyboardId).eq("nodeId", asset.nodeId),
      )
      .unique();
    if (node) {
      const existingSfxs = node.media.sfxs ?? [];
      const nextSfxs = existingSfxs.map((variant) =>
        variant.mediaAssetId === args.mediaAssetId
          ? { ...variant, metadata: nextMetadata }
          : variant,
      );
      await ctx.db.patch(node._id, {
        media: {
          ...node.media,
          sfxs: nextSfxs,
        },
        updatedAt: now,
      });
    }
    return { mediaAssetId: args.mediaAssetId, volumeDb: clampedVolume };
  },
});

/** Read the SFX-specific metadata off a media asset. Narrow to `sfx`
 *  kind so the route/UI can trust the shape. Returns null when the
 *  asset doesn't exist or isn't SFX — callers default to library
 *  constants (DEFAULT_SFX_VOLUME_DB) in that case. */
export const getSfxAssetMetadata = query({
  args: { mediaAssetId: v.id("mediaAssets") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) return null;
    if (asset.kind !== "sfx") return null;
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    const metadata = asset.metadata ?? {};
    const volumeStr = metadata.volumeDb;
    const volumeNum =
      typeof volumeStr === "string" && volumeStr.trim().length > 0
        ? Number(volumeStr)
        : undefined;
    return {
      mediaAssetId: args.mediaAssetId,
      prompt: asset.prompt,
      modelId: asset.modelId,
      sourceUrl: asset.sourceUrl,
      volumeDb:
        typeof volumeNum === "number" && Number.isFinite(volumeNum)
          ? volumeNum
          : null,
      durationS:
        typeof metadata.durationS === "string"
          ? Number(metadata.durationS)
          : null,
    };
  },
});

export const listNodeMedia = query({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    // M7 — widened to include audio + sfx so the PropertiesPanel's
    // SFX / narration variant pickers can share this one query.
    // M8 — score support too so the ReelScorePanel's variants picker
    // can list historical takes for a storyboard.
    kind: v.optional(v.union(
      v.literal("image"),
      v.literal("video"),
      v.literal("audio"),
      v.literal("sfx"),
      v.literal("score"),
    )),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const mediaRows = await ctx.db
      .query("mediaAssets")
      .withIndex("by_storyboard_node_kind_createdAt", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .order("desc")
      .take(limit);
    if (!args.kind) {
      return mediaRows;
    }
    return mediaRows.filter((row) => row.kind === args.kind);
  },
});

/**
 * M5 — dailies review loop. Returns the `nodeId`s of every shot whose
 * currently-active image has `takeStatus: "ng"` (producer flagged as
 * no-good). The `/api/storyboard/generate-shots-stream` route consumes
 * this when invoked with `flaggedOnly: true` so "Regenerate flagged"
 * can re-render only the rejected subset without touching approved
 * work.
 *
 * Scope: image takeStatus only for now — that's the status the Review
 * tab's Take-Status pill row writes to. Video + audio regeneration can
 * be added later without changing the shape by returning a richer map.
 */
export const listShotsWithFlaggedMedia = query({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const nodes = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_updatedAt", (q) =>
        q.eq("storyboardId", args.storyboardId),
      )
      .collect();

    const flaggedNodeIds: string[] = [];
    for (const node of nodes) {
      if (node.nodeType !== "shot") continue;
      const activeId = node.media.activeImageId;
      if (!activeId) continue;
      const asset = await ctx.db.get(activeId);
      if (!asset) continue;
      if (asset.takeStatus === "ng") {
        flaggedNodeIds.push(node.nodeId);
      }
    }
    return { flaggedNodeIds };
  },
});

// ---------------------------------------------------------------------------
// Delivery-variant surface (Enhancement #3: variant matrix)
// ---------------------------------------------------------------------------
// A "variant" is a row in `mediaAssets` with `masterAssetId` set. Masters are
// rows where `masterAssetId` is absent. Variants never appear in the node's
// media.images[] / media.videos[] arrays — the node surface tracks masters
// only. Variants are fetched on-demand via `listVariantsForMaster` using the
// `by_master_createdAt` index.

/**
 * Create a single delivery variant for a given master asset. The caller may
 * optionally provide a `sourceUrl` (e.g. the output of a manual reformat
 * step); in that case the new row is inserted directly in `completed` +
 * `in_review` state. Otherwise it lands as `pending` + `planned` and the UI
 * can later call `attachVariantSource` once the variant asset is produced.
 *
 * The storyboard node's media arrays are intentionally NOT patched — variants
 * live outside the master timeline.
 */
export const createDeliveryVariant = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    masterAssetId: v.id("mediaAssets"),
    variantSpec: deliveryVariantSpecValidator,
    sourceUrl: v.optional(v.string()),
    modelId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);

    const master = await ctx.db.get(args.masterAssetId);
    if (!master) {
      throw new ConvexError("Master asset not found");
    }
    if (master.storyboardId !== args.storyboardId) {
      throw new ConvexError("Master asset does not belong to this storyboard");
    }
    if (master.masterAssetId !== undefined) {
      throw new ConvexError("Cannot attach a variant to another variant");
    }

    const now = Date.now();
    const hasSource = args.sourceUrl !== undefined && args.sourceUrl.length > 0;
    const assetId = await ctx.db.insert("mediaAssets", {
      storyboardId: args.storyboardId,
      userId,
      nodeId: master.nodeId,
      kind: master.kind,
      sourceUrl: args.sourceUrl ?? "",
      modelId: args.modelId ?? master.modelId,
      prompt: master.prompt,
      status: hasSource ? "completed" : "pending",
      masterAssetId: args.masterAssetId,
      variantSpec: args.variantSpec,
      deliveryStatus: hasSource ? "in_review" : "planned",
      createdAt: now,
      updatedAt: now,
    });
    return assetId;
  },
});

/**
 * Cartesian-expand a matrix input into delivery-variant rows. The server-side
 * math mirrors `expandVariantMatrix` in `src/lib/delivery-matrix/expand.ts`
 * — see that file (+ its test suite) for canonical coverage of ordering and
 * the 500-row cap. Inlined here because Convex functions cannot import from
 * `src/` at build time.
 */
export const createDeliveryVariantMatrix = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    masterAssetId: v.id("mediaAssets"),
    matrix: v.object({
      aspects: v.optional(v.array(v.union(
        v.literal("2.39:1"), v.literal("1.85:1"), v.literal("16:9"),
        v.literal("9:16"), v.literal("4:5"), v.literal("1:1"), v.literal("2:1"),
      ))),
      durationsS: v.optional(v.array(v.number())),
      locales: v.optional(v.array(v.string())),
      abLabels: v.optional(v.array(v.string())),
      platform: v.optional(v.union(
        v.literal("meta"), v.literal("tiktok"), v.literal("youtube"),
        v.literal("ctv"), v.literal("dv360"), v.literal("x"),
        v.literal("linkedin"), v.literal("other"),
      )),
      endCard: v.optional(v.string()),
      notes: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);

    const master = await ctx.db.get(args.masterAssetId);
    if (!master) {
      throw new ConvexError("Master asset not found");
    }
    if (master.storyboardId !== args.storyboardId) {
      throw new ConvexError("Master asset does not belong to this storyboard");
    }
    if (master.masterAssetId !== undefined) {
      throw new ConvexError("Cannot attach a variant to another variant");
    }

    const aspects = args.matrix.aspects && args.matrix.aspects.length > 0
      ? args.matrix.aspects.map((a) => a as string | undefined)
      : [undefined];
    const durations = args.matrix.durationsS && args.matrix.durationsS.length > 0
      ? args.matrix.durationsS.map((d) => d as number | undefined)
      : [undefined];
    const locales = args.matrix.locales && args.matrix.locales.length > 0
      ? args.matrix.locales.map((l) => l as string | undefined)
      : [undefined];
    const abLabels = args.matrix.abLabels && args.matrix.abLabels.length > 0
      ? args.matrix.abLabels.map((l) => l as string | undefined)
      : [undefined];

    const total = aspects.length * durations.length * locales.length * abLabels.length;
    if (total > DELIVERY_MATRIX_MAX_ROWS) {
      throw new ConvexError(
        `Delivery matrix would produce ${total} variants; cap is ${DELIVERY_MATRIX_MAX_ROWS}.`,
      );
    }

    const now = Date.now();
    const createdIds: Id<"mediaAssets">[] = [];
    // Canonical iteration order: aspect (outer) > duration > locale > abLabel.
    for (const aspect of aspects) {
      for (const durationS of durations) {
        for (const locale of locales) {
          for (const abLabel of abLabels) {
            const spec: {
              aspect?: "2.39:1" | "1.85:1" | "16:9" | "9:16" | "4:5" | "1:1" | "2:1";
              durationS?: number;
              locale?: string;
              abLabel?: string;
              platform?: "meta" | "tiktok" | "youtube" | "ctv" | "dv360" | "x" | "linkedin" | "other";
              endCard?: string;
              notes?: string;
            } = {};
            if (aspect !== undefined) {
              spec.aspect = aspect as typeof spec.aspect;
            }
            if (durationS !== undefined) spec.durationS = durationS;
            if (locale !== undefined) spec.locale = locale;
            if (abLabel !== undefined) spec.abLabel = abLabel;
            if (args.matrix.platform !== undefined) spec.platform = args.matrix.platform;
            if (args.matrix.endCard !== undefined) spec.endCard = args.matrix.endCard;
            if (args.matrix.notes !== undefined) spec.notes = args.matrix.notes;

            const id = await ctx.db.insert("mediaAssets", {
              storyboardId: args.storyboardId,
              userId,
              nodeId: master.nodeId,
              kind: master.kind,
              sourceUrl: "",
              modelId: master.modelId,
              prompt: master.prompt,
              status: "pending",
              masterAssetId: args.masterAssetId,
              variantSpec: spec,
              deliveryStatus: "planned",
              createdAt: now,
              updatedAt: now,
            });
            createdIds.push(id);
          }
        }
      }
    }
    return { createdIds };
  },
});

/**
 * Patch a variant's `variantSpec`. Errors if the target is a master (i.e. has
 * no `masterAssetId`).
 */
export const updateDeliveryVariantSpec = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    variantSpec: deliveryVariantSpecValidator,
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    if (asset.masterAssetId === undefined) {
      throw new ConvexError("Target is a master, not a variant");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    await ctx.db.patch(args.mediaAssetId, {
      variantSpec: args.variantSpec,
      updatedAt: Date.now(),
    });
    return args.mediaAssetId;
  },
});

/**
 * Patch the delivery lifecycle status on a variant.
 */
export const updateDeliveryVariantStatus = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    deliveryStatus: deliveryStatusValidator,
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    if (asset.masterAssetId === undefined) {
      throw new ConvexError("Target is a master, not a variant");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    await ctx.db.patch(args.mediaAssetId, {
      deliveryStatus: args.deliveryStatus,
      updatedAt: Date.now(),
    });
    return args.mediaAssetId;
  },
});

/**
 * Attach a source URL to a pending variant — the typical "manual reformat
 * just landed" flow. Flips `status` pending -> completed and `deliveryStatus`
 * planned -> in_review.
 */
export const attachVariantSource = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
    sourceUrl: v.string(),
    modelId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    if (asset.masterAssetId === undefined) {
      throw new ConvexError("Target is a master, not a variant");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    const patch: Record<string, unknown> = {
      sourceUrl: args.sourceUrl,
      updatedAt: Date.now(),
    };
    if (args.modelId !== undefined) patch.modelId = args.modelId;
    if (asset.status === "pending") patch.status = "completed";
    if (asset.deliveryStatus === "planned") patch.deliveryStatus = "in_review";
    await ctx.db.patch(args.mediaAssetId, patch);
    return args.mediaAssetId;
  },
});

/**
 * Archive a variant. Sets `deliveryStatus` to "archived" and flips the
 * generation `status` to "rolled_back" so any listing that filters on
 * non-terminal statuses (e.g. review queues) drops it. The row stays around
 * for audit.
 */
export const archiveDeliveryVariant = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const asset = await ctx.db.get(args.mediaAssetId);
    if (!asset) {
      throw new ConvexError("Media asset not found");
    }
    if (asset.masterAssetId === undefined) {
      throw new ConvexError("Target is a master, not a variant");
    }
    await ensureStoryboardEditable(ctx, asset.storyboardId, userId);
    await ctx.db.patch(args.mediaAssetId, {
      deliveryStatus: "archived",
      status: "rolled_back",
      updatedAt: Date.now(),
    });
    return args.mediaAssetId;
  },
});

/**
 * Atomically swap a variant with its master. The variant becomes the new
 * master (its variant fields clear); the former master becomes a demoted
 * variant with an empty spec and `deliveryStatus: "archived"` so it doesn't
 * pollute the UI. The owning node's media.images[]/videos[] + active pointers
 * are retargeted so downstream UI continues to resolve the new master.
 */
export const promoteVariantToMaster = mutation({
  args: {
    mediaAssetId: v.id("mediaAssets"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const variant = await ctx.db.get(args.mediaAssetId);
    if (!variant) {
      throw new ConvexError("Media asset not found");
    }
    if (variant.masterAssetId === undefined) {
      throw new ConvexError("Target is already a master");
    }
    await ensureStoryboardEditable(ctx, variant.storyboardId, userId);

    const formerMasterId = variant.masterAssetId;
    const formerMaster = await ctx.db.get(formerMasterId);
    if (!formerMaster) {
      throw new ConvexError("Former master not found");
    }

    const now = Date.now();
    // Promote the variant: clear the three variant-scoped fields so it looks
    // like a plain master. We can't delete fields on patch, so pass
    // `undefined` — Convex drops optional fields set to undefined.
    await ctx.db.patch(args.mediaAssetId, {
      masterAssetId: undefined,
      variantSpec: undefined,
      deliveryStatus: undefined,
      updatedAt: now,
    });
    // Demote the old master: point it at the new master, tag with an empty
    // spec so it passes variant-only guards, and archive it.
    await ctx.db.patch(formerMasterId, {
      masterAssetId: args.mediaAssetId,
      variantSpec: {},
      deliveryStatus: "archived",
      updatedAt: now,
    });

    // Retarget the node's media arrays / active pointers.
    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", variant.storyboardId).eq("nodeId", variant.nodeId),
      )
      .unique();
    if (node) {
      const swap = <T extends { mediaAssetId: Id<"mediaAssets"> }>(arr: T[]): T[] =>
        arr.map((entry) =>
          entry.mediaAssetId === formerMasterId
            ? { ...entry, mediaAssetId: args.mediaAssetId, url: variant.sourceUrl || entry.url, modelId: variant.modelId || entry.modelId }
            : entry,
        );
      const nextImages = variant.kind === "image" ? swap(node.media.images) : node.media.images;
      const nextVideos = variant.kind === "video" ? swap(node.media.videos) : node.media.videos;
      const nextActiveImage =
        node.media.activeImageId === formerMasterId ? args.mediaAssetId : node.media.activeImageId;
      const nextActiveVideo =
        node.media.activeVideoId === formerMasterId ? args.mediaAssetId : node.media.activeVideoId;
      await ctx.db.patch(node._id, {
        media: {
          images: nextImages,
          videos: nextVideos,
          activeImageId: nextActiveImage,
          activeVideoId: nextActiveVideo,
        },
        updatedAt: now,
      });
    }

    return { newMasterId: args.mediaAssetId, demotedMasterId: formerMasterId };
  },
});

/**
 * List variants of a given master. Archived variants are excluded by default
 * — pass `includeArchived: true` to see them (typically for audit views).
 */
export const listVariantsForMaster = query({
  args: {
    storyboardId: v.id("storyboards"),
    masterAssetId: v.id("mediaAssets"),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const rows = await ctx.db
      .query("mediaAssets")
      .withIndex("by_master_createdAt", (q) => q.eq("masterAssetId", args.masterAssetId))
      .order("asc")
      .collect();
    const includeArchived = args.includeArchived ?? false;
    return rows
      .filter((row) => row.storyboardId === args.storyboardId)
      .filter((row) => includeArchived || row.deliveryStatus !== "archived")
      .map((row) => ({
        id: row._id,
        masterAssetId: row.masterAssetId!,
        kind: row.kind,
        sourceUrl: row.sourceUrl,
        modelId: row.modelId,
        generationStatus: row.status,
        deliveryStatus: row.deliveryStatus ?? "planned",
        variantSpec: row.variantSpec ?? {},
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  },
});
