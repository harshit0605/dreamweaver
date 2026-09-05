import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ensureStoryboardEditable, ensureStoryboardOwner, requireUser } from "./storyboardAccess";
import { BUILT_IN_STORYBOARD_TEMPLATES, getStoryboardTemplateById } from "./storyboardTemplates";
import { recomputeStoryboardStatsInternal } from "./storyboardStats";

const nodeType = v.union(
  v.literal("scene"),
  v.literal("shot"),
  v.literal("branch"),
  v.literal("merge"),
  v.literal("character_ref"),
  v.literal("background_ref"),
);

const edgeType = v.union(
  v.literal("serial"),
  v.literal("parallel"),
  v.literal("branch"),
  v.literal("merge"),
);

const consistencyStatus = v.union(
  v.literal("ok"),
  v.literal("warning"),
  v.literal("blocked"),
);

const shotMetaValidator = v.object({
  number: v.optional(v.string()),
  size: v.optional(v.union(
    v.literal("ECU"), v.literal("CU"), v.literal("MCU"),
    v.literal("MS"), v.literal("MLS"), v.literal("WS"), v.literal("EWS"),
  )),
  angle: v.optional(v.union(
    v.literal("eye_level"), v.literal("high"), v.literal("low"),
    v.literal("dutch"), v.literal("birds_eye"), v.literal("worms_eye"),
  )),
  lensMm: v.optional(v.number()),
  tStop: v.optional(v.string()),
  move: v.optional(v.union(
    v.literal("static"), v.literal("push_in"), v.literal("pull_out"),
    v.literal("dolly"), v.literal("track"), v.literal("tilt"),
    v.literal("pan"), v.literal("whip_pan"), v.literal("handheld"),
    v.literal("steadicam"), v.literal("crane"), v.literal("drone"),
  )),
  aspect: v.optional(v.union(
    v.literal("2.39:1"), v.literal("1.85:1"), v.literal("16:9"),
    v.literal("9:16"), v.literal("4:5"), v.literal("1:1"), v.literal("2:1"),
  )),
  durationS: v.optional(v.number()),
  screenDirection: v.optional(v.union(
    v.literal("left_to_right"), v.literal("right_to_left"), v.literal("neutral"),
  )),
  axisLineId: v.optional(v.string()),
  blockingNotes: v.optional(v.string()),
  props: v.optional(v.array(v.string())),
  sfx: v.optional(v.array(v.string())),
  vfx: v.optional(v.array(v.string())),
});

const storyboardStatus = v.union(v.literal("active"), v.literal("trashed"));
const librarySort = v.union(
  v.literal("updated_desc"),
  v.literal("updated_asc"),
  v.literal("title_asc"),
  v.literal("created_desc"),
);

const patchOperation = v.object({
  op: v.union(
    v.literal("create_node"),
    v.literal("update_node"),
    v.literal("delete_node"),
    v.literal("create_edge"),
    v.literal("update_edge"),
    v.literal("delete_edge"),
  ),
  nodeId: v.optional(v.string()),
  edgeId: v.optional(v.string()),
  nodeType: v.optional(nodeType),
  label: v.optional(v.string()),
  segment: v.optional(v.string()),
  position: v.optional(v.object({ x: v.number(), y: v.number() })),
  sourceNodeId: v.optional(v.string()),
  targetNodeId: v.optional(v.string()),
  edgeType: v.optional(edgeType),
  branchId: v.optional(v.string()),
  order: v.optional(v.number()),
  isPrimary: v.optional(v.boolean()),
  shotMeta: v.optional(shotMetaValidator),
});

const hashString = (raw: string) => {
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 33) ^ raw.charCodeAt(index);
  }
  return `ln_${(hash >>> 0).toString(16)}`;
};

const estimateTokens = (text: string) =>
  Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);

const MAX_PATCH_OPERATIONS_PER_APPROVAL = 1;

const toRollingSummary = (lines: string[], maxTokens: number) => {
  let used = 0;
  const accepted: string[] = [];
  for (const line of lines) {
    const next = estimateTokens(line);
    if (used + next > maxTokens) {
      break;
    }
    accepted.push(line);
    used += next;
  }
  return { summary: accepted.join("\n"), tokenBudgetUsed: used };
};

const stripSystemFields = <T extends Record<string, unknown>>(row: T) => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = row;
  return rest;
};

const defaultNodePayload = (
  nodeId: string,
  nodeKind: "scene" | "shot" | "branch" | "merge" | "character_ref" | "background_ref",
  label: string,
  segment: string,
  position: { x: number; y: number },
  now: number,
) => ({
  nodeId,
  nodeType: nodeKind,
  label,
  segment,
  position,
  entityRefs: {
    characterIds: [],
  },
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
  promptPack: {
    continuityDirectives: [],
  },
  media: {
    images: [],
    videos: [],
  },
  status: "draft" as const,
  createdAt: now,
  updatedAt: now,
});

const findPrimaryPath = (
  nodeId: string,
  incomingEdges: Map<string, Array<{ sourceNodeId: string; isPrimary: boolean; order?: number }>>,
) => {
  const path: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = nodeId;
  while (current && !visited.has(current)) {
    path.push(current);
    visited.add(current);
    const candidates = incomingEdges.get(current) ?? [];
    if (candidates.length === 0) {
      break;
    }
    const primary = candidates.find((edge) => edge.isPrimary);
    if (primary) {
      current = primary.sourceNodeId;
      continue;
    }
    const sorted = [...candidates].sort(
      (left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER),
    );
    current = sorted[0]?.sourceNodeId;
  }
  return path.reverse();
};

const extractAncestorNodeIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
};

const eventAffectsPath = (event: Record<string, unknown>, pathSet: Set<string>) => {
  const nodeId = typeof event.nodeId === "string" ? event.nodeId : "";
  if (nodeId && pathSet.has(nodeId)) {
    return true;
  }

  const ancestorNodeIds = extractAncestorNodeIds(event.ancestorNodeIds);
  if (ancestorNodeIds.length === 0) {
    return nodeId.length === 0;
  }
  return ancestorNodeIds.some((ancestorNodeId) => pathSet.has(ancestorNodeId));
};

const parseExecutionResult = (raw: string | undefined) => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { applied?: number; touchedNodeIds?: unknown };
    const touchedNodeIds = Array.isArray(parsed.touchedNodeIds)
      ? parsed.touchedNodeIds.filter((item): item is string => typeof item === "string")
      : [];
    if (typeof parsed.applied !== "number") {
      return null;
    }
    return {
      applied: parsed.applied,
      touchedNodeIds,
    };
  } catch {
    return null;
  }
};

const refreshHistoryForNodes = async (
  ctx: {
    db: {
      query: (table: string) => {
        withIndex: (index: string, cb: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
          collect: () => Promise<Array<Record<string, unknown>>>;
          unique: () => Promise<Record<string, unknown> | null>;
        };
      };
      insert: (table: string, value: Record<string, unknown>) => Promise<string>;
      patch: (id: string, value: Record<string, unknown>) => Promise<void>;
    };
  },
  storyboardId: string,
  nodeIds: string[],
  userId: string,
) => {
  const [nodes, edges, events] = await Promise.all([
    ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_updatedAt", (q) => q.eq("storyboardId", storyboardId))
      .collect(),
    ctx.db
      .query("storyboardEdges")
      .withIndex("by_storyboard_edge", (q) => q.eq("storyboardId", storyboardId))
      .collect(),
    ctx.db
      .query("storyEvents")
      .withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", storyboardId))
      .collect(),
  ]);

  const incoming = new Map<string, Array<{ sourceNodeId: string; isPrimary: boolean; order?: number }>>();
  for (const edge of edges) {
    const target = String(edge.targetNodeId ?? "");
    const current = incoming.get(target) ?? [];
    current.push({
      sourceNodeId: String(edge.sourceNodeId ?? ""),
      isPrimary: Boolean(edge.isPrimary),
      order: typeof edge.order === "number" ? edge.order : undefined,
    });
    incoming.set(target, current);
  }

  for (const nodeId of nodeIds) {
    const node = nodes.find((row) => row.nodeId === nodeId);
    if (!node) {
      continue;
    }
    const primaryPath = findPrimaryPath(nodeId, incoming);
    const pathSet = new Set(primaryPath);
    const lineageEvents = events
      .filter((event) => eventAffectsPath(event, pathSet))
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));

    const highSalience = lineageEvents.filter((event) => Number(event.salience ?? 0) >= 0.6);
    const selected = (highSalience.length > 0 ? highSalience : lineageEvents)
      .slice(0, 20)
      .reverse();
    const summaryLines = selected.map((event, index) => `${index + 1}. ${String(event.summary ?? "")}`);
    const changeText =
      selected.length > 0
        ? `What changed since previous node: ${String(selected[selected.length - 1].summary ?? "")}`
        : "What changed since previous node: No approved changes.";

    const incomingForNode = incoming.get(nodeId) ?? [];
    const primaryIncoming = incomingForNode.find((edge) => edge.isPrimary)
      ?? [...incomingForNode].sort(
        (left, right) =>
          (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER),
      )[0];
    const secondaryIncoming = incomingForNode.filter(
      (edge) => !primaryIncoming || edge.sourceNodeId !== primaryIncoming.sourceNodeId,
    );

    const mergeCapsules = secondaryIncoming.map((edge) => {
      const secondaryPath = findPrimaryPath(edge.sourceNodeId, incoming);
      const secondaryPathSet = new Set(secondaryPath);
      const secondaryEvents = events
        .filter((event) => eventAffectsPath(event, secondaryPathSet))
        .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
        .slice(0, 3)
        .reverse();

      return {
        parentNodeId: edge.sourceNodeId,
        summary: secondaryEvents.map((event) => String(event.summary ?? "")).join(" | "),
        eventIds: secondaryEvents.map((event) => String(event._id ?? "")),
      };
    });

    const mergeCapsuleLines = mergeCapsules
      .filter((capsule) => capsule.summary.length > 0)
      .map((capsule) => `Merge capsule (${capsule.parentNodeId}): ${capsule.summary}`);

    const mergedSummary = toRollingSummary(
      [...summaryLines, ...mergeCapsuleLines, changeText],
      1200,
    );
    const lineageHash = hashString(
      JSON.stringify({
        path: primaryPath,
        versions: selected.map((event) => Number(event.eventVersion ?? 0)),
        secondaryParents: secondaryIncoming.map((edge) => edge.sourceNodeId),
      }),
    );

    const contextRow = await ctx.db
      .query("nodeHistoryContexts")
      .withIndex("by_storyboard_node_lineage", (q) =>
        q.eq("storyboardId", storyboardId).eq("nodeId", nodeId).eq("lineageHash", lineageHash),
      )
      .unique();

    const payload = {
      primaryEventIds: selected.map((event) => String(event._id ?? "")),
      mergeCapsules,
      rollingSummary: mergedSummary.summary,
      tokenBudgetUsed: mergedSummary.tokenBudgetUsed,
      generatedAt: Date.now(),
    };

    if (contextRow?._id) {
      await ctx.db.patch(String(contextRow._id), payload);
    } else {
      await ctx.db.insert("nodeHistoryContexts", {
        storyboardId,
        userId,
        nodeId,
        lineageHash,
        ...payload,
      });
    }

    const nodeRow = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", storyboardId).eq("nodeId", nodeId),
      )
      .unique();
    if (nodeRow?._id) {
      await ctx.db.patch(String(nodeRow._id), {
        historyContext: {
          eventIds: selected.map((event) => String(event._id ?? "")),
          rollingSummary: mergedSummary.summary,
          tokenBudgetUsed: mergedSummary.tokenBudgetUsed,
          lineageHash,
        },
        updatedAt: Date.now(),
      });
    }
  }
};

export const createStoryboard = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("graph_studio"), v.literal("agent_draft"))),
    visualTheme: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const storyboardId = await ctx.db.insert("storyboards", {
      userId,
      title: args.title,
      description: args.description,
      status: "active",
      isPinned: false,
      lastOpenedAt: now,
      deletionVersion: 0,
      nodeCount: 0,
      edgeCount: 0,
      imageCount: 0,
      videoCount: 0,
      mode: args.mode ?? "graph_studio",
      visualTheme: args.visualTheme ?? "cinematic_studio",
      createdAt: now,
      updatedAt: now,
    });
    return storyboardId;
  },
});

export const listTemplates = query({
  args: {},
  handler: async () =>
    BUILT_IN_STORYBOARD_TEMPLATES.map((template) => ({
      templateId: template.templateId,
      name: template.name,
      description: template.description,
      visualTheme: template.visualTheme,
      mode: template.mode,
    })),
});

export const listLibrary = query({
  args: {
    status: v.optional(storyboardStatus),
    search: v.optional(v.string()),
    sort: v.optional(librarySort),
    pinnedOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const userId = identity.tokenIdentifier;
    const status = args.status ?? "active";
    const sort = args.sort ?? "updated_desc";
    const limit = Math.min(Math.max(args.limit ?? 40, 1), 120);
    const cursor = args.cursor;
    const search = (args.search ?? "").trim().toLowerCase();
    const pinnedOnly = Boolean(args.pinnedOnly);

    let rows = await ctx.db
      .query("storyboards")
      .withIndex("by_user_status_updatedAt", (q) =>
        q.eq("userId", userId).eq("status", status),
      )
      .order("desc")
      .take(300);

    if (cursor) {
      rows = rows.filter((row) => Number(row.updatedAt ?? 0) < cursor);
    }

    if (pinnedOnly) {
      rows = rows.filter((row) => Boolean(row.isPinned));
    }

    if (search.length > 0) {
      rows = rows.filter((row) => {
        const title = String(row.title ?? "").toLowerCase();
        const description = String(row.description ?? "").toLowerCase();
        return title.includes(search) || description.includes(search);
      });
    }

    if (sort === "updated_asc") {
      rows.sort((left, right) => Number(left.updatedAt ?? 0) - Number(right.updatedAt ?? 0));
    } else if (sort === "title_asc") {
      rows.sort((left, right) => String(left.title ?? "").localeCompare(String(right.title ?? "")));
    } else if (sort === "created_desc") {
      rows.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
    } else {
      rows.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
    }

    return rows.slice(0, limit);
  },
});

export const getStoryboardMeta = query({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const storyboard = await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    return storyboard;
  },
});

export const createStoryboardFromTemplate = mutation({
  args: {
    templateId: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const template = getStoryboardTemplateById(args.templateId);
    const storyboardId = await ctx.db.insert("storyboards", {
      userId,
      title: (args.title ?? template.name).trim(),
      description: template.description,
      mode: template.mode,
      visualTheme: template.visualTheme,
      status: "active",
      isPinned: false,
      templateId: template.templateId,
      lastOpenedAt: now,
      deletionVersion: 0,
      nodeCount: 0,
      edgeCount: 0,
      imageCount: 0,
      videoCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    for (const node of template.nodes) {
      await ctx.db.insert("storyboardNodes", {
        storyboardId,
        userId,
        ...defaultNodePayload(
          node.nodeId,
          node.nodeType,
          node.label,
          node.segment,
          node.position,
          now,
        ),
      });
    }

    for (const edge of template.edges) {
      await ctx.db.insert("storyboardEdges", {
        storyboardId,
        userId,
        edgeId: edge.edgeId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        edgeType: edge.edgeType,
        branchId: edge.branchId,
        order: edge.order,
        isPrimary: edge.isPrimary ?? false,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (template.nodes.length > 0) {
      await ctx.db.insert("storyEvents", {
        storyboardId,
        userId,
        nodeId: template.nodes[0].nodeId,
        eventType: "node_edit",
        summary: `Seeded from template: ${template.name}`,
        salience: 0.8,
        eventVersion: 1,
        ancestorNodeIds: template.nodes.map((row) => row.nodeId),
        createdAt: now,
      });
      await refreshHistoryForNodes(
        ctx,
        storyboardId,
        template.nodes.map((row) => row.nodeId),
        userId,
      );
    }

    await recomputeStoryboardStatsInternal(ctx, storyboardId);
    return storyboardId;
  },
});

export const renameStoryboard = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const storyboard = await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    if ((storyboard.status ?? "active") !== "active") {
      throw new ConvexError("Cannot rename trashed storyboard");
    }
    await ctx.db.patch(args.storyboardId, {
      title: args.title.trim(),
      updatedAt: Date.now(),
    });
    return args.storyboardId;
  },
});

export const setStoryboardPinned = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    isPinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    await ctx.db.patch(args.storyboardId, {
      isPinned: args.isPinned,
      updatedAt: Date.now(),
    });
    return args.storyboardId;
  },
});

export const touchStoryboardOpened = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    await ctx.db.patch(args.storyboardId, {
      lastOpenedAt: Date.now(),
    });
    return args.storyboardId;
  },
});

export const updateEditorState = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    viewport: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        zoom: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const storyboard = await ensureStoryboardEditable(
      ctx,
      args.storyboardId,
      userId,
    );
    const existingEditorState =
      (storyboard.editorState as
        | { viewport?: { x: number; y: number; zoom: number } }
        | undefined) ?? {};
    const nextEditorState = {
      ...existingEditorState,
      ...(args.viewport !== undefined ? { viewport: args.viewport } : {}),
    };
    await ctx.db.patch(args.storyboardId, {
      editorState: nextEditorState,
      updatedAt: Date.now(),
    });
    return args.storyboardId;
  },
});

/**
 * M8 — attach a reel-level background score to a storyboard. The
 * `mediaAssetId` must point at a `kind: "score"` row; anything else
 * gets rejected so we can't e.g. accidentally use a narration track
 * as a music bed. Pass `null` to detach the current score.
 */
export const setStoryboardScore = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    mediaAssetId: v.union(v.id("mediaAssets"), v.null()),
    volumeDb: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    if (args.mediaAssetId !== null) {
      const asset = await ctx.db.get(args.mediaAssetId);
      if (!asset) {
        throw new ConvexError("Score media asset not found");
      }
      if (asset.kind !== "score") {
        throw new ConvexError(
          `setStoryboardScore: asset kind is "${asset.kind}" (expected "score")`,
        );
      }
      if (asset.storyboardId !== args.storyboardId) {
        throw new ConvexError(
          "Score media asset belongs to a different storyboard",
        );
      }
    }
    // Clamp the volume into the score dB window so a stray value can't
    // produce an inaudible or clipping mix at export time.
    const clampedVolume =
      typeof args.volumeDb === "number"
        ? Math.max(-40, Math.min(0, args.volumeDb))
        : undefined;
    await ctx.db.patch(args.storyboardId, {
      activeScoreId: args.mediaAssetId ?? undefined,
      scoreVolumeDb: clampedVolume,
      updatedAt: Date.now(),
    });
    return { storyboardId: args.storyboardId, volumeDb: clampedVolume };
  },
});

/** Read the active score + its metadata for a storyboard. Returns
 *  `null` when no score is attached. Used by the reel export pipeline
 *  and the Score panel UI. */
export const getStoryboardScore = query({
  args: { storyboardId: v.id("storyboards") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const storyboard = await ctx.db.get(args.storyboardId);
    if (!storyboard) return null;
    const scoreId = storyboard.activeScoreId;
    if (!scoreId) return null;
    const asset = await ctx.db.get(scoreId);
    if (!asset || asset.kind !== "score") return null;
    return {
      mediaAssetId: asset._id,
      sourceUrl: asset.sourceUrl,
      prompt: asset.prompt,
      modelId: asset.modelId,
      volumeDb:
        typeof storyboard.scoreVolumeDb === "number"
          ? storyboard.scoreVolumeDb
          : null,
      durationS:
        typeof asset.metadata?.durationS === "string"
          ? Number(asset.metadata.durationS)
          : null,
    };
  },
});

export const trashStoryboard = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const storyboard = await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    const now = Date.now();
    if ((storyboard.status ?? "active") === "trashed") {
      return args.storyboardId;
    }
    await ctx.db.patch(args.storyboardId, {
      status: "trashed",
      trashedAt: now,
      purgeAt: now + 1000 * 60 * 60 * 24 * 30,
      deletionVersion: Number(storyboard.deletionVersion ?? 0) + 1,
      updatedAt: now,
    });
    return args.storyboardId;
  },
});

export const restoreStoryboard = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const storyboard = await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    await ctx.db.patch(args.storyboardId, {
      status: "active",
      trashedAt: undefined,
      purgeAt: undefined,
      deletionVersion: Number(storyboard.deletionVersion ?? 0) + 1,
      updatedAt: Date.now(),
    });
    return args.storyboardId;
  },
});

const TABLE_INDEX_BY_STORYBOARD: Array<{ table: string; index: string }> = [
  { table: "storyboardNodes", index: "by_storyboard_updatedAt" },
  { table: "storyboardEdges", index: "by_storyboard_edge" },
  { table: "characters", index: "by_storyboard_character" },
  { table: "wardrobeVariants", index: "by_storyboard_character" },
  { table: "backgrounds", index: "by_storyboard_background" },
  { table: "scenes", index: "by_storyboard_scene" },
  { table: "shots", index: "by_storyboard_shot" },
  { table: "storyEvents", index: "by_storyboard_createdAt" },
  { table: "nodeHistoryContexts", index: "by_storyboard_node_lineage" },
  { table: "mediaAssets", index: "by_storyboard_createdAt" },
  { table: "approvalTasks", index: "by_storyboard_createdAt" },
  { table: "narrativeBranches", index: "by_storyboard_branch_updatedAt" },
  { table: "narrativeCommits", index: "by_storyboard_branch_createdAt" },
  { table: "semanticDiffs", index: "by_storyboard_createdAt" },
  { table: "dryRunReports", index: "by_storyboard_branch_createdAt" },
  { table: "agentDelegations", index: "by_storyboard_run_createdAt" },
  { table: "identityPacks", index: "by_storyboard_pack" },
  { table: "globalConstraints", index: "by_storyboard_constraint" },
  { table: "continuityViolations", index: "by_storyboard_violation" },
  { table: "agentRuns", index: "by_storyboard_startedAt" },
  { table: "autonomousDailies", index: "by_storyboard_branch_createdAt" },
  { table: "simulationCriticRuns", index: "by_storyboard_branch_createdAt" },
  { table: "agentTeamAssignments", index: "by_storyboard" },
  { table: "toolCallAudits", index: "by_storyboard_createdAt" },
];

const purgeStoryboardInternal = async (
  ctx: {
    db: {
      query: (table: string) => {
        withIndex: (
          index: string,
          cb: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
        ) => { collect: () => Promise<Array<Record<string, unknown>>> };
      };
      delete: (id: Id<"storyboards"> | string) => Promise<void>;
      get: (id: Id<"storyboards">) => Promise<Record<string, unknown> | null>;
    };
  },
  storyboardId: Id<"storyboards">,
) => {
  for (const descriptor of TABLE_INDEX_BY_STORYBOARD) {
    const rows = await ctx.db
      .query(descriptor.table)
      .withIndex(descriptor.index, (q) => q.eq("storyboardId", storyboardId))
      .collect();
    for (const row of rows) {
      if (typeof row._id === "string") {
        await ctx.db.delete(row._id);
      }
    }
  }

  await ctx.db.delete(storyboardId);
};

export const deleteStoryboardPermanently = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const storyboard = await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    if ((storyboard.status ?? "active") !== "trashed") {
      throw new ConvexError("Storyboard must be in trash before permanent delete");
    }
    await purgeStoryboardInternal(ctx, args.storyboardId);
    return { purged: true };
  },
});

export const purgeExpiredTrashedStoryboards = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const rows = await ctx.db
      .query("storyboards")
      .withIndex("by_user_status_purgeAt", (q) => q.eq("userId", userId).eq("status", "trashed"))
      .collect();

    let purged = 0;
    for (const row of rows) {
      if (purged >= limit) {
        break;
      }
      if (typeof row.purgeAt === "number" && row.purgeAt <= now) {
        await purgeStoryboardInternal(ctx, row._id as Id<"storyboards">);
        purged += 1;
      }
    }
    return { purged };
  },
});

export const purgeExpiredTrashedStoryboardsInternal = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const trashedRows = await ctx.db
      .query("storyboards")
      .withIndex("by_status_purgeAt", (q) => q.eq("status", "trashed"))
      .collect();

    let purged = 0;
    for (const row of trashedRows) {
      if (purged >= limit) {
        break;
      }
      if (typeof row.purgeAt === "number" && row.purgeAt <= now) {
        await purgeStoryboardInternal(ctx, row._id as Id<"storyboards">);
        purged += 1;
      }
    }
    return { purged };
  },
});

export const duplicateStoryboard = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const source = await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    const now = Date.now();
    const targetStoryboardId = await ctx.db.insert("storyboards", {
      userId,
      title: (args.title ?? `Copy of ${source.title}`).trim(),
      description: source.description,
      activeBranch: source.activeBranch,
      mode: source.mode,
      visualTheme: source.visualTheme,
      status: "active",
      isPinned: false,
      lastOpenedAt: now,
      deletionVersion: 0,
      templateId: source.templateId,
      createdAt: now,
      updatedAt: now,
    });

    const [
      sourceNodes,
      sourceEdges,
      sourceCharacters,
      sourceWardrobes,
      sourceBackgrounds,
      sourceScenes,
      sourceShots,
      sourceEvents,
      sourceMedia,
      sourceBranches,
      sourceCommits,
      sourceDiffs,
      sourceIdentityPacks,
      sourceConstraints,
      sourceViolations,
      sourceAssignments,
    ] = await Promise.all([
      ctx.db.query("storyboardNodes").withIndex("by_storyboard_updatedAt", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("storyboardEdges").withIndex("by_storyboard_edge", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("characters").withIndex("by_storyboard_character", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("wardrobeVariants").withIndex("by_storyboard_character", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("backgrounds").withIndex("by_storyboard_background", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("scenes").withIndex("by_storyboard_scene", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("shots").withIndex("by_storyboard_shot", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("storyEvents").withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("mediaAssets").withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("narrativeBranches").withIndex("by_storyboard_branch_updatedAt", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("narrativeCommits").withIndex("by_storyboard_branch_createdAt", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("semanticDiffs").withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("identityPacks").withIndex("by_storyboard_pack", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("globalConstraints").withIndex("by_storyboard_constraint", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("continuityViolations").withIndex("by_storyboard_violation", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
      ctx.db.query("agentTeamAssignments").withIndex("by_storyboard", (q) => q.eq("storyboardId", args.storyboardId)).collect(),
    ]);

    const mediaIdMap = new Map<string, Id<"mediaAssets">>();
    for (const mediaRow of sourceMedia) {
      const newMediaId = await ctx.db.insert("mediaAssets", {
        ...stripSystemFields(mediaRow),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
      mediaIdMap.set(String(mediaRow._id), newMediaId);
    }

    for (const node of sourceNodes) {
      const remappedImages = Array.isArray(node.media?.images)
        ? node.media.images.map((variant: { mediaAssetId: Id<"mediaAssets">; url: string; modelId: string; createdAt: number }) => ({
          ...variant,
          mediaAssetId: mediaIdMap.get(String(variant.mediaAssetId)) ?? variant.mediaAssetId,
        }))
        : [];
      const remappedVideos = Array.isArray(node.media?.videos)
        ? node.media.videos.map((variant: { mediaAssetId: Id<"mediaAssets">; url: string; modelId: string; createdAt: number }) => ({
          ...variant,
          mediaAssetId: mediaIdMap.get(String(variant.mediaAssetId)) ?? variant.mediaAssetId,
        }))
        : [];

      await ctx.db.insert("storyboardNodes", {
        ...stripSystemFields(node),
        storyboardId: targetStoryboardId,
        userId,
        media: {
          images: remappedImages,
          videos: remappedVideos,
          activeImageId: node.media?.activeImageId ? mediaIdMap.get(String(node.media.activeImageId)) : undefined,
          activeVideoId: node.media?.activeVideoId ? mediaIdMap.get(String(node.media.activeVideoId)) : undefined,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const edge of sourceEdges) {
      await ctx.db.insert("storyboardEdges", {
        ...stripSystemFields(edge),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const character of sourceCharacters) {
      await ctx.db.insert("characters", {
        ...stripSystemFields(character),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const wardrobe of sourceWardrobes) {
      await ctx.db.insert("wardrobeVariants", {
        ...stripSystemFields(wardrobe),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const background of sourceBackgrounds) {
      await ctx.db.insert("backgrounds", {
        ...stripSystemFields(background),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const scene of sourceScenes) {
      await ctx.db.insert("scenes", {
        ...stripSystemFields(scene),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const shot of sourceShots) {
      await ctx.db.insert("shots", {
        ...stripSystemFields(shot),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const event of sourceEvents) {
      await ctx.db.insert("storyEvents", {
        ...stripSystemFields(event),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
      });
    }
    for (const branch of sourceBranches) {
      await ctx.db.insert("narrativeBranches", {
        ...stripSystemFields(branch),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const commit of sourceCommits) {
      await ctx.db.insert("narrativeCommits", {
        ...stripSystemFields(commit),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
      });
    }
    for (const diffRow of sourceDiffs) {
      await ctx.db.insert("semanticDiffs", {
        ...stripSystemFields(diffRow),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
      });
    }
    for (const pack of sourceIdentityPacks) {
      await ctx.db.insert("identityPacks", {
        ...stripSystemFields(pack),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const constraint of sourceConstraints) {
      await ctx.db.insert("globalConstraints", {
        ...stripSystemFields(constraint),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const violation of sourceViolations) {
      await ctx.db.insert("continuityViolations", {
        ...stripSystemFields(violation),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const assignment of sourceAssignments) {
      await ctx.db.insert("agentTeamAssignments", {
        ...stripSystemFields(assignment),
        storyboardId: targetStoryboardId,
        userId,
        createdAt: now,
        updatedAt: now,
      });
    }

    await refreshHistoryForNodes(
      ctx,
      targetStoryboardId,
      sourceNodes.map((node) => String(node.nodeId)),
      userId,
    );
    await recomputeStoryboardStatsInternal(ctx, targetStoryboardId);
    return targetStoryboardId;
  },
});

export const listMine = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    await listLibrary.handler(ctx, {
      status: "active",
      sort: "updated_desc",
      pinnedOnly: false,
      search: "",
      limit: args.limit,
      cursor: undefined,
    }),
});

export const recomputeStoryboardStats = mutation({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardOwner(ctx, args.storyboardId, userId);
    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
    return { ok: true };
  },
});

export const backfillStoryboardMetadata = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    const rows = await ctx.db
      .query("storyboards")
      .withIndex("by_user_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);

    let updated = 0;
    for (const row of rows) {
      const patch: Record<string, unknown> = {};
      if (typeof row.status !== "string") {
        patch.status = "active";
      }
      if (typeof row.isPinned !== "boolean") {
        patch.isPinned = false;
      }
      if (typeof row.deletionVersion !== "number") {
        patch.deletionVersion = 0;
      }
      if (typeof row.nodeCount !== "number" || typeof row.edgeCount !== "number" || typeof row.imageCount !== "number" || typeof row.videoCount !== "number") {
        await recomputeStoryboardStatsInternal(ctx, row._id);
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(row._id, patch);
        updated += 1;
      }
    }
    return { updated };
  },
});

export const getStoryboardSnapshot = query({
  args: {
    storyboardId: v.id("storyboards"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    const userId = identity.tokenIdentifier;
    const storyboardRow = await ctx.db.get(args.storyboardId);
    if (!storyboardRow || storyboardRow.userId !== userId || (storyboardRow.status ?? "active") !== "active") {
      return null;
    }
    const [storyboard, nodes, edges, approvals] = await Promise.all([
      Promise.resolve(storyboardRow),
      ctx.db
        .query("storyboardNodes")
        .withIndex("by_storyboard_updatedAt", (q) => q.eq("storyboardId", args.storyboardId))
        .collect(),
      ctx.db
        .query("storyboardEdges")
        .withIndex("by_storyboard_edge", (q) => q.eq("storyboardId", args.storyboardId))
        .collect(),
      ctx.db
        .query("approvalTasks")
        .withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", args.storyboardId))
        .order("desc")
        .take(20),
    ]);
    return { storyboard, nodes, edges, approvals };
  },
});

export const upsertNode = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    nodeType,
    label: v.string(),
    segment: v.string(),
    position: v.object({ x: v.number(), y: v.number() }),
    continuityStatus: v.optional(consistencyStatus),
    shotMeta: v.optional(shotMetaValidator),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .unique();
    if (!existing) {
      const id = await ctx.db.insert("storyboardNodes", {
        storyboardId: args.storyboardId,
        userId,
        ...defaultNodePayload(
          args.nodeId,
          args.nodeType,
          args.label,
          args.segment,
          args.position,
          now,
        ),
        ...(args.shotMeta !== undefined ? { shotMeta: args.shotMeta } : {}),
      });
      await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
      return id;
    }
    await ctx.db.patch(existing._id, {
      nodeType: args.nodeType,
      label: args.label,
      segment: args.segment,
      position: args.position,
      continuity: {
        ...existing.continuity,
        consistencyStatus: args.continuityStatus ?? existing.continuity.consistencyStatus,
      },
      shotMeta: args.shotMeta ?? existing.shotMeta,
      updatedAt: now,
    });
    await ctx.db.patch(args.storyboardId, { updatedAt: now });
    return existing._id;
  },
});

/**
 * Bulk-upsert N nodes in one Convex transaction. Used by the ViMax M1
 * screenplay-ingest pipeline to atomically insert a shot list without
 * spamming N individual `upsertNode` calls.
 *
 * Existing rows are patched in-place (same upsert semantics as `upsertNode`).
 * `recomputeStoryboardStatsInternal` runs once at the end, not per-node.
 */
export const bulkCreateNodes = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodes: v.array(
      v.object({
        nodeId: v.string(),
        nodeType,
        label: v.string(),
        segment: v.string(),
        position: v.object({ x: v.number(), y: v.number() }),
        continuityStatus: v.optional(consistencyStatus),
        shotMeta: v.optional(shotMetaValidator),
        promptPack: v.optional(
          v.object({
            imagePrompt: v.optional(v.string()),
            videoPrompt: v.optional(v.string()),
            negativePrompt: v.optional(v.string()),
            continuityDirectives: v.optional(v.array(v.string())),
          }),
        ),
        // Characters that appear in this shot — populated by the ViMax M1
        // ingester from the storyboard-artist's `ff_vis_char_idxs`. Matched
        // against `identityPacks.sourceCharacterId` for pack resolution.
        characterIds: v.optional(v.array(v.string())),
        // Per-character facing direction (loose end #4). Written as a
        // parallel array so the Convex validator stays record-free. Each
        // entry's characterId should also appear in `characterIds`;
        // entries that don't are retained on the row but ignored by the
        // shot-batch selector.
        characterFacings: v.optional(v.array(v.object({
          characterId: v.string(),
          facing: v.union(
            v.literal("toward_camera"),
            v.literal("away_from_camera"),
            v.literal("screen_left"),
            v.literal("screen_right"),
            v.literal("three_quarter_left"),
            v.literal("three_quarter_right"),
          ),
        }))),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();

    // Dedupe by nodeId within the batch — later entry wins. Keeps the caller
    // honest without blowing up on a repeated row.
    const seen = new Map<string, (typeof args.nodes)[number]>();
    for (const n of args.nodes) {
      seen.set(n.nodeId, n);
    }

    const insertedIds: Id<"storyboardNodes">[] = [];
    const patchedIds: Id<"storyboardNodes">[] = [];

    for (const n of seen.values()) {
      const existing = await ctx.db
        .query("storyboardNodes")
        .withIndex("by_storyboard_node", (q) =>
          q.eq("storyboardId", args.storyboardId).eq("nodeId", n.nodeId),
        )
        .unique();

      if (!existing) {
        const base = defaultNodePayload(
          n.nodeId,
          n.nodeType,
          n.label,
          n.segment,
          n.position,
          now,
        );
        const payload: Record<string, unknown> = {
          storyboardId: args.storyboardId,
          userId,
          ...base,
        };
        if (n.shotMeta !== undefined) payload.shotMeta = n.shotMeta;
        if (n.promptPack !== undefined) {
          payload.promptPack = {
            ...base.promptPack,
            imagePrompt: n.promptPack.imagePrompt,
            videoPrompt: n.promptPack.videoPrompt,
            negativePrompt: n.promptPack.negativePrompt,
            continuityDirectives:
              n.promptPack.continuityDirectives ?? base.promptPack.continuityDirectives,
          };
        }
        if (n.characterIds && n.characterIds.length > 0) {
          payload.entityRefs = {
            ...base.entityRefs,
            characterIds: n.characterIds,
            ...(n.characterFacings && n.characterFacings.length > 0
              ? { characterFacings: n.characterFacings }
              : {}),
          };
        } else if (n.characterFacings && n.characterFacings.length > 0) {
          // Facings supplied without explicit characterIds — unusual but
          // harmless; keep the facings so debug surfaces can show them.
          payload.entityRefs = {
            ...base.entityRefs,
            characterFacings: n.characterFacings,
          };
        }
        const id = await ctx.db.insert(
          "storyboardNodes",
          payload as Parameters<typeof ctx.db.insert>[1],
        );
        insertedIds.push(id);
      } else {
        const mergedPromptPack = n.promptPack
          ? {
              ...existing.promptPack,
              imagePrompt: n.promptPack.imagePrompt ?? existing.promptPack.imagePrompt,
              videoPrompt: n.promptPack.videoPrompt ?? existing.promptPack.videoPrompt,
              negativePrompt:
                n.promptPack.negativePrompt ?? existing.promptPack.negativePrompt,
              continuityDirectives:
                n.promptPack.continuityDirectives ?? existing.promptPack.continuityDirectives,
            }
          : existing.promptPack;
        const mergedEntityRefs: typeof existing.entityRefs = { ...existing.entityRefs };
        if (n.characterIds && n.characterIds.length > 0) {
          mergedEntityRefs.characterIds = n.characterIds;
        }
        if (n.characterFacings !== undefined) {
          // An explicit empty array clears the facings; a non-empty array
          // replaces the previous value. `undefined` leaves the existing
          // field intact.
          mergedEntityRefs.characterFacings =
            n.characterFacings.length > 0 ? n.characterFacings : undefined;
        }
        await ctx.db.patch(existing._id, {
          nodeType: n.nodeType,
          label: n.label,
          segment: n.segment,
          position: n.position,
          continuity: {
            ...existing.continuity,
            consistencyStatus:
              n.continuityStatus ?? existing.continuity.consistencyStatus,
          },
          shotMeta: n.shotMeta ?? existing.shotMeta,
          promptPack: mergedPromptPack,
          entityRefs: mergedEntityRefs,
          updatedAt: now,
        });
        patchedIds.push(existing._id);
      }
    }

    await ctx.db.patch(args.storyboardId, { updatedAt: now });
    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);

    return {
      insertedIds,
      patchedIds,
      total: insertedIds.length + patchedIds.length,
    };
  },
});

/**
 * Bulk-upsert N edges in one transaction. Same rationale as `bulkCreateNodes`.
 * Caller is responsible for ensuring sourceNodeId / targetNodeId refer to
 * nodes that already exist (typically by calling `bulkCreateNodes` first).
 */
export const bulkCreateEdges = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    edges: v.array(
      v.object({
        edgeId: v.string(),
        sourceNodeId: v.string(),
        targetNodeId: v.string(),
        edgeType,
        branchId: v.optional(v.string()),
        order: v.optional(v.number()),
        isPrimary: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();

    const seen = new Map<string, (typeof args.edges)[number]>();
    for (const e of args.edges) {
      seen.set(e.edgeId, e);
    }

    const insertedIds: Id<"storyboardEdges">[] = [];
    const patchedIds: Id<"storyboardEdges">[] = [];

    for (const e of seen.values()) {
      const existing = await ctx.db
        .query("storyboardEdges")
        .withIndex("by_storyboard_edge", (q) =>
          q.eq("storyboardId", args.storyboardId).eq("edgeId", e.edgeId),
        )
        .unique();

      if (!existing) {
        const id = await ctx.db.insert("storyboardEdges", {
          storyboardId: args.storyboardId,
          userId,
          edgeId: e.edgeId,
          sourceNodeId: e.sourceNodeId,
          targetNodeId: e.targetNodeId,
          edgeType: e.edgeType,
          branchId: e.branchId,
          order: e.order,
          isPrimary: e.isPrimary ?? false,
          createdAt: now,
          updatedAt: now,
        });
        insertedIds.push(id);
      } else {
        await ctx.db.patch(existing._id, {
          sourceNodeId: e.sourceNodeId,
          targetNodeId: e.targetNodeId,
          edgeType: e.edgeType,
          branchId: e.branchId,
          order: e.order,
          isPrimary: e.isPrimary ?? existing.isPrimary,
          updatedAt: now,
        });
        patchedIds.push(existing._id);
      }
    }

    await ctx.db.patch(args.storyboardId, { updatedAt: now });
    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);

    return {
      insertedIds,
      patchedIds,
      total: insertedIds.length + patchedIds.length,
    };
  },
});

/**
 * Patch only the `characterIds` inside a node's `entityRefs`. Used by the
 * "Characters in shot" chip-picker in the PropertiesPanel so users can
 * attach / detach character identity packs without blowing away other
 * entityRefs fields (backgroundId, sceneId, shotId).
 */
export const setNodeCharacterIds = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    characterIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .unique();
    if (!node) {
      throw new ConvexError("Node not found");
    }
    // Dedupe, preserve order, drop empties.
    const cleaned = Array.from(
      new Set(args.characterIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    );
    await ctx.db.patch(node._id, {
      entityRefs: {
        ...node.entityRefs,
        characterIds: cleaned,
      },
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.storyboardId, { updatedAt: Date.now() });
    return { nodeId: args.nodeId, characterIds: cleaned };
  },
});

/**
 * M5 #5 — update just the per-shot narration override (`promptPack.audioDesc`).
 * Kept as a dedicated mutation so the PropertiesPanel can patch this
 * single field without having to send the entire promptPack on each
 * keystroke. The audio batch route (`/api/storyboard/generate-shot-audios-stream`)
 * reads this field first in `deriveShotNarrationText`, so producer edits
 * persist across repeat batch runs.
 *
 * Pass an empty string to clear the override and fall back to the
 * auto-extracted narration.
 */
export const setNodeAudioDesc = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    audioDesc: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .unique();
    if (!node) {
      throw new ConvexError("Node not found");
    }
    const trimmed = args.audioDesc.trim();
    await ctx.db.patch(node._id, {
      promptPack: {
        ...node.promptPack,
        audioDesc: trimmed.length > 0 ? trimmed : undefined,
      },
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.storyboardId, { updatedAt: Date.now() });
    return { nodeId: args.nodeId, audioDesc: trimmed.length > 0 ? trimmed : null };
  },
});

export const deleteNode = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .unique();
    if (!node) {
      return;
    }
    const edges = await ctx.db
      .query("storyboardEdges")
      .withIndex("by_storyboard_edge", (q) => q.eq("storyboardId", args.storyboardId))
      .collect();
    await Promise.all(
      edges
        .filter((edge) => edge.sourceNodeId === args.nodeId || edge.targetNodeId === args.nodeId)
        .map((edge) => ctx.db.delete(edge._id)),
    );
    await ctx.db.delete(node._id);
    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
  },
});

export const upsertEdge = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    edgeId: v.string(),
    sourceNodeId: v.string(),
    targetNodeId: v.string(),
    edgeType,
    branchId: v.optional(v.string()),
    order: v.optional(v.number()),
    isPrimary: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const now = Date.now();
    const existing = await ctx.db
      .query("storyboardEdges")
      .withIndex("by_storyboard_edge", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("edgeId", args.edgeId),
      )
      .unique();
    if (!existing) {
      const id = await ctx.db.insert("storyboardEdges", {
        storyboardId: args.storyboardId,
        userId,
        edgeId: args.edgeId,
        sourceNodeId: args.sourceNodeId,
        targetNodeId: args.targetNodeId,
        edgeType: args.edgeType,
        branchId: args.branchId,
        order: args.order,
        isPrimary: args.isPrimary ?? false,
        createdAt: now,
        updatedAt: now,
      });
      await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
      return id;
    }
    await ctx.db.patch(existing._id, {
      sourceNodeId: args.sourceNodeId,
      targetNodeId: args.targetNodeId,
      edgeType: args.edgeType,
      branchId: args.branchId,
      order: args.order,
      isPrimary: args.isPrimary ?? existing.isPrimary,
      updatedAt: now,
    });
    await ctx.db.patch(args.storyboardId, { updatedAt: now });
    return existing._id;
  },
});

export const deleteEdge = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    edgeId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const edge = await ctx.db
      .query("storyboardEdges")
      .withIndex("by_storyboard_edge", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("edgeId", args.edgeId),
      )
      .unique();
    if (!edge) {
      return;
    }
    await ctx.db.delete(edge._id);
    await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
  },
});

export const recordStoryEvent = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.optional(v.string()),
    branchId: v.optional(v.string()),
    eventType: v.union(
      v.literal("node_edit"),
      v.literal("branch_create"),
      v.literal("branch_merge"),
      v.literal("media_select"),
      v.literal("continuity_update"),
      v.literal("character_edit"),
      v.literal("background_edit"),
      v.literal("scene_edit"),
      v.literal("shot_edit"),
      v.literal("prompt_update"),
      v.literal("dailies_generate"),
      v.literal("simulation_critic"),
    ),
    summary: v.string(),
    details: v.optional(v.string()),
    salience: v.optional(v.number()),
    ancestorNodeIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const previous = await ctx.db
      .query("storyEvents")
      .withIndex("by_storyboard_createdAt", (q) => q.eq("storyboardId", args.storyboardId))
      .order("desc")
      .take(1);
    const version = Number(previous[0]?.eventVersion ?? 0) + 1;
    const id = await ctx.db.insert("storyEvents", {
      storyboardId: args.storyboardId,
      userId,
      nodeId: args.nodeId,
      branchId: args.branchId,
      eventType: args.eventType,
      summary: args.summary,
      details: args.details,
      salience: Math.min(Math.max(args.salience ?? 0.7, 0), 1),
      eventVersion: version,
      ancestorNodeIds: args.ancestorNodeIds,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.storyboardId, { updatedAt: Date.now() });
    return id;
  },
});

export const compileNodePromptPack = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeId: v.string(),
    mediaType: v.union(v.literal("image"), v.literal("video")),
    basePrompt: v.optional(v.string()),
    negativePrompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);

    const node = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_node", (q) =>
        q.eq("storyboardId", args.storyboardId).eq("nodeId", args.nodeId),
      )
      .unique();
    if (!node) {
      throw new ConvexError("Node not found");
    }

    const continuityDirectives = [
      ...node.promptPack.continuityDirectives,
      ...(node.entityRefs.characterIds.length > 0
        ? [
            `Character lock: preserve immutable identity traits for ${node.entityRefs.characterIds.join(", ")}.`,
          ]
        : []),
      ...(node.continuity.wardrobeVariantIds.length > 0
        ? [
            `Wardrobe variants in play: ${node.continuity.wardrobeVariantIds.join(", ")}.`,
          ]
        : []),
      "Narrative continuity: preserve key events from rolling history and only introduce explicit new changes.",
    ];

    const basePrompt = args.basePrompt
      ?? (args.mediaType === "image" ? node.promptPack.imagePrompt : node.promptPack.videoPrompt)
      ?? node.segment;
    const rollingSummary = node.historyContext.rollingSummary;
    const continuityText = continuityDirectives.join(" ");

    const compiledPrompt = [
      basePrompt.trim(),
      rollingSummary ? `Rolling history context:\n${rollingSummary}` : "",
      continuityText,
      "What changed since previous node must remain explicit and visually coherent.",
    ]
      .filter((line) => line.length > 0)
      .join("\n\n");

    const compiledNegativePrompt = (args.negativePrompt ?? node.promptPack.negativePrompt ?? "").trim()
      || "identity drift, facial mismatch, inconsistent age silhouette, unintended costume swap";

    await ctx.db.patch(node._id, {
      promptPack: {
        ...node.promptPack,
        imagePrompt: args.mediaType === "image" ? compiledPrompt : node.promptPack.imagePrompt,
        videoPrompt: args.mediaType === "video" ? compiledPrompt : node.promptPack.videoPrompt,
        negativePrompt: compiledNegativePrompt,
        continuityDirectives,
      },
      updatedAt: Date.now(),
    });

    return {
      prompt: compiledPrompt,
      negativePrompt: compiledNegativePrompt,
      continuityDirectives,
      rollingSummary,
    };
  },
});

export const refreshNodeHistoryContexts = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    nodeIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    const nodes = await ctx.db
      .query("storyboardNodes")
      .withIndex("by_storyboard_updatedAt", (q) => q.eq("storyboardId", args.storyboardId))
      .collect();
    const targets = args.nodeIds && args.nodeIds.length > 0
      ? args.nodeIds
      : nodes.map((node) => node.nodeId);
    await refreshHistoryForNodes(ctx, args.storyboardId, targets, userId);
    await ctx.db.patch(args.storyboardId, { updatedAt: Date.now() });
    return { refreshed: targets.length };
  },
});

export const applyGraphPatch = mutation({
  args: {
    storyboardId: v.id("storyboards"),
    approvalTaskId: v.id("approvalTasks"),
    operations: v.array(patchOperation),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ensureStoryboardEditable(ctx, args.storyboardId, userId);
    if (args.operations.length === 0) {
      throw new ConvexError("Patch contains no operations");
    }
    if (args.operations.length > MAX_PATCH_OPERATIONS_PER_APPROVAL) {
      throw new ConvexError(
        `Patch exceeds max operations per approval (${MAX_PATCH_OPERATIONS_PER_APPROVAL})`,
      );
    }

    const approval = await ctx.db.get(args.approvalTaskId);
    if (!approval || approval.storyboardId !== args.storyboardId) {
      throw new ConvexError("Approval task not found");
    }
    const cachedResult = parseExecutionResult(approval.executionResultJson);
    if (approval.status === "complete" && cachedResult) {
      return cachedResult;
    }
    if (!approval.decision?.approved || approval.status === "rejected") {
      throw new ConvexError("Approval required before mutation");
    }

    if (approval.status === "executing") {
      throw new ConvexError("Patch is already executing");
    }

    const executionStart = Date.now();
    await ctx.db.patch(args.approvalTaskId, {
      status: "executing",
      executionStartedAt: executionStart,
      updatedAt: executionStart,
    });

    const touchedNodes = new Set<string>();
    try {
      for (const operation of args.operations) {
        if (operation.op === "create_node") {
          if (
            !operation.nodeId
            || !operation.nodeType
            || !operation.label
            || !operation.segment
            || !operation.position
          ) {
            throw new ConvexError("Invalid create_node operation");
          }
          const existingNode = await ctx.db
            .query("storyboardNodes")
            .withIndex("by_storyboard_node", (q) =>
              q.eq("storyboardId", args.storyboardId).eq("nodeId", operation.nodeId),
            )
            .unique();

          if (existingNode) {
            await ctx.db.patch(existingNode._id, {
              nodeType: operation.nodeType,
              label: operation.label,
              segment: operation.segment,
              position: operation.position,
              shotMeta: operation.shotMeta ?? existingNode.shotMeta,
              updatedAt: Date.now(),
            });
          } else {
            await ctx.db.insert("storyboardNodes", {
              storyboardId: args.storyboardId,
              userId,
              ...defaultNodePayload(
                operation.nodeId,
                operation.nodeType,
                operation.label,
                operation.segment,
                operation.position,
                Date.now(),
              ),
              ...(operation.shotMeta !== undefined ? { shotMeta: operation.shotMeta } : {}),
            });
          }
          touchedNodes.add(operation.nodeId);
          continue;
        }

        if (operation.op === "update_node") {
          if (!operation.nodeId) {
            throw new ConvexError("Invalid update_node operation");
          }
          const row = await ctx.db
            .query("storyboardNodes")
            .withIndex("by_storyboard_node", (q) =>
              q.eq("storyboardId", args.storyboardId).eq("nodeId", operation.nodeId),
            )
            .unique();
          if (!row) {
            throw new ConvexError(`Node not found for update: ${operation.nodeId}`);
          }
          await ctx.db.patch(row._id, {
            nodeType: operation.nodeType ?? row.nodeType,
            label: operation.label ?? row.label,
            segment: operation.segment ?? row.segment,
            position: operation.position ?? row.position,
            shotMeta: operation.shotMeta ?? row.shotMeta,
            updatedAt: Date.now(),
          });
          touchedNodes.add(operation.nodeId);
          continue;
        }

        if (operation.op === "delete_node") {
          if (!operation.nodeId) {
            throw new ConvexError("Invalid delete_node operation");
          }
          const row = await ctx.db
            .query("storyboardNodes")
            .withIndex("by_storyboard_node", (q) =>
              q.eq("storyboardId", args.storyboardId).eq("nodeId", operation.nodeId),
            )
            .unique();
          if (!row) {
            continue;
          }
          const allEdges = await ctx.db
            .query("storyboardEdges")
            .withIndex("by_storyboard_edge", (q) => q.eq("storyboardId", args.storyboardId))
            .collect();
          const linkedEdges = allEdges.filter(
            (edge) => edge.sourceNodeId === operation.nodeId || edge.targetNodeId === operation.nodeId,
          );
          for (const edge of linkedEdges) {
            touchedNodes.add(String(edge.sourceNodeId));
            touchedNodes.add(String(edge.targetNodeId));
            await ctx.db.delete(edge._id);
          }
          await ctx.db.delete(row._id);
          touchedNodes.delete(operation.nodeId);
          continue;
        }

        if (operation.op === "create_edge") {
          if (
            !operation.edgeId
            || !operation.sourceNodeId
            || !operation.targetNodeId
            || !operation.edgeType
          ) {
            throw new ConvexError("Invalid create_edge operation");
          }
          const [sourceNode, targetNode] = await Promise.all([
            ctx.db
              .query("storyboardNodes")
              .withIndex("by_storyboard_node", (q) =>
                q.eq("storyboardId", args.storyboardId).eq("nodeId", operation.sourceNodeId as string),
              )
              .unique(),
            ctx.db
              .query("storyboardNodes")
              .withIndex("by_storyboard_node", (q) =>
                q.eq("storyboardId", args.storyboardId).eq("nodeId", operation.targetNodeId as string),
              )
              .unique(),
          ]);
          if (!sourceNode || !targetNode) {
            throw new ConvexError("create_edge references missing source or target node");
          }

          const existingEdge = await ctx.db
            .query("storyboardEdges")
            .withIndex("by_storyboard_edge", (q) =>
              q.eq("storyboardId", args.storyboardId).eq("edgeId", operation.edgeId),
            )
            .unique();
          if (existingEdge) {
            await ctx.db.patch(existingEdge._id, {
              sourceNodeId: operation.sourceNodeId,
              targetNodeId: operation.targetNodeId,
              edgeType: operation.edgeType,
              branchId: operation.branchId,
              order: operation.order,
              isPrimary: operation.isPrimary ?? existingEdge.isPrimary,
              updatedAt: Date.now(),
            });
          } else {
            await ctx.db.insert("storyboardEdges", {
              storyboardId: args.storyboardId,
              userId,
              edgeId: operation.edgeId,
              sourceNodeId: operation.sourceNodeId,
              targetNodeId: operation.targetNodeId,
              edgeType: operation.edgeType,
              branchId: operation.branchId,
              order: operation.order,
              isPrimary: operation.isPrimary ?? false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
          touchedNodes.add(operation.sourceNodeId);
          touchedNodes.add(operation.targetNodeId);
          continue;
        }

        if (operation.op === "update_edge") {
          if (!operation.edgeId) {
            throw new ConvexError("Invalid update_edge operation");
          }
          const row = await ctx.db
            .query("storyboardEdges")
            .withIndex("by_storyboard_edge", (q) =>
              q.eq("storyboardId", args.storyboardId).eq("edgeId", operation.edgeId),
            )
            .unique();
          if (!row) {
            throw new ConvexError(`Edge not found for update: ${operation.edgeId}`);
          }

          const nextSourceNodeId = String(operation.sourceNodeId ?? row.sourceNodeId);
          const nextTargetNodeId = String(operation.targetNodeId ?? row.targetNodeId);
          const [sourceNode, targetNode] = await Promise.all([
            ctx.db
              .query("storyboardNodes")
              .withIndex("by_storyboard_node", (q) =>
                q.eq("storyboardId", args.storyboardId).eq("nodeId", nextSourceNodeId),
              )
              .unique(),
            ctx.db
              .query("storyboardNodes")
              .withIndex("by_storyboard_node", (q) =>
                q.eq("storyboardId", args.storyboardId).eq("nodeId", nextTargetNodeId),
              )
              .unique(),
          ]);
          if (!sourceNode || !targetNode) {
            throw new ConvexError("update_edge references missing source or target node");
          }

          await ctx.db.patch(row._id, {
            sourceNodeId: nextSourceNodeId,
            targetNodeId: nextTargetNodeId,
            edgeType: operation.edgeType ?? row.edgeType,
            branchId: operation.branchId ?? row.branchId,
            order: operation.order ?? row.order,
            isPrimary: operation.isPrimary ?? row.isPrimary,
            updatedAt: Date.now(),
          });
          touchedNodes.add(nextSourceNodeId);
          touchedNodes.add(nextTargetNodeId);
          continue;
        }

        if (operation.op === "delete_edge") {
          if (!operation.edgeId) {
            throw new ConvexError("Invalid delete_edge operation");
          }
          const row = await ctx.db
            .query("storyboardEdges")
            .withIndex("by_storyboard_edge", (q) =>
              q.eq("storyboardId", args.storyboardId).eq("edgeId", operation.edgeId),
            )
            .unique();
          if (!row) {
            continue;
          }
          touchedNodes.add(String(row.sourceNodeId));
          touchedNodes.add(String(row.targetNodeId));
          await ctx.db.delete(row._id);
        }
      }

      if (touchedNodes.size > 0) {
        await refreshHistoryForNodes(ctx, args.storyboardId, [...touchedNodes], userId);
      }

      const result = {
        applied: args.operations.length,
        touchedNodeIds: [...touchedNodes],
      };

      const executionFinishedAt = Date.now();
      await recomputeStoryboardStatsInternal(ctx, args.storyboardId);
      await ctx.db.patch(args.approvalTaskId, {
        status: "complete",
        executionResultJson: JSON.stringify(result),
        executionFinishedAt,
        updatedAt: executionFinishedAt,
      });
      await ctx.db.patch(args.storyboardId, { updatedAt: executionFinishedAt });
      return result;
    } catch (error) {
      const executionFinishedAt = Date.now();
      await ctx.db.patch(args.approvalTaskId, {
        status: "failed",
        executionFinishedAt,
        updatedAt: executionFinishedAt,
      });
      throw error;
    }
  },
});
