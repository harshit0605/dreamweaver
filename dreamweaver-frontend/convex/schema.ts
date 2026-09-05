import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const nodeTypeValidator = v.union(
  v.literal("scene"),
  v.literal("shot"),
  v.literal("branch"),
  v.literal("merge"),
  v.literal("character_ref"),
  v.literal("background_ref"),
);

const consistencyStatusValidator = v.union(
  v.literal("ok"),
  v.literal("warning"),
  v.literal("blocked"),
);

const mediaVariantValidator = v.object({
  mediaAssetId: v.id("mediaAssets"),
  url: v.string(),
  modelId: v.string(),
  createdAt: v.number(),
  // M7 — loose per-variant metadata map. Currently used by SFX to
  // carry `volumeDb` (stringified) so the reel export can read the
  // producer's volume trim without a second Convex query per shot.
  // Generic enough to add kind-specific bits later (e.g. per-video
  // seed, per-image prompt hash) without another schema bump.
  metadata: v.optional(v.record(v.string(), v.string())),
});

const approvalStatusValidator = v.union(
  v.literal("queued"),
  v.literal("executing"),
  v.literal("waiting_for_human"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("cancelled"),
  v.literal("complete"),
  v.literal("failed"),
);

const riskLevelValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("critical"),
);

const teamVisibilityValidator = v.union(
  v.literal("private"),
  v.literal("workspace"),
  v.literal("public_read"),
);

const teamStatusValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
);

const secretStatusValidator = v.union(
  v.literal("active"),
  v.literal("revoked"),
);

export default defineSchema({
  generations: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("image"), v.literal("video"), v.literal("audio")),
    prompt: v.string(),
    modelId: v.string(),
    resultUrls: v.array(v.string()),
    status: v.union(v.literal("completed"), v.literal("failed")),
    createdAt: v.number(),
    metadata: v.optional(v.record(v.string(), v.string())),
  }).index("by_user_createdAt", ["userId", "createdAt"]),

  storyboards: defineTable({
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    activeBranch: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("trashed"))),
    isPinned: v.optional(v.boolean()),
    lastOpenedAt: v.optional(v.number()),
    trashedAt: v.optional(v.number()),
    purgeAt: v.optional(v.number()),
    deletionVersion: v.optional(v.number()),
    templateId: v.optional(v.string()),
    coverImageUrl: v.optional(v.string()),
    nodeCount: v.optional(v.number()),
    edgeCount: v.optional(v.number()),
    imageCount: v.optional(v.number()),
    videoCount: v.optional(v.number()),
    mode: v.union(v.literal("graph_studio"), v.literal("agent_draft")),
    visualTheme: v.string(),
    // Editor UI state persisted across reloads. Currently just the ReactFlow
    // viewport (pan/zoom); kept as a typed object rather than a JSON string
    // so readers don't need a parse step and the schema documents what's in
    // there. Optional so pre-existing storyboards don't need a backfill.
    editorState: v.optional(
      v.object({
        viewport: v.optional(
          v.object({
            x: v.number(),
            y: v.number(),
            zoom: v.number(),
          }),
        ),
      }),
    ),
    // M8 — reel-level background score track. Points at a
    // `mediaAssets` row with `kind: "score"`. Optional — a storyboard
    // without a score exports fine (just no music layer). Separate
    // from per-shot `activeSfxId`s because the score spans the whole
    // reel and is picked / swapped at the storyboard scope.
    activeScoreId: v.optional(v.id("mediaAssets")),
    /** Score volume in dB, clamped to [-40, 0]. Stored as a number
     *  here (unlike SFX which tucks it into variant metadata) because
     *  there's exactly one active score per storyboard, so a dedicated
     *  field is simpler than spelunking into a mediaAsset metadata
     *  map on every reel export. */
    scoreVolumeDb: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_updatedAt", ["userId", "updatedAt"])
    .index("by_user_status_updatedAt", ["userId", "status", "updatedAt"])
    .index("by_user_status_pinned_updatedAt", ["userId", "status", "isPinned", "updatedAt"])
    .index("by_user_status_purgeAt", ["userId", "status", "purgeAt"])
    .index("by_status_purgeAt", ["status", "purgeAt"]),

  storyboardNodes: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    nodeId: v.string(),
    nodeType: nodeTypeValidator,
    label: v.string(),
    segment: v.string(),
    position: v.object({
      x: v.number(),
      y: v.number(),
    }),
    entityRefs: v.object({
      characterIds: v.array(v.string()),
      backgroundId: v.optional(v.string()),
      sceneId: v.optional(v.string()),
      shotId: v.optional(v.string()),
      // Per-character facing direction in this shot's first frame. Emitted
      // by the ViMax storyboard_artist's decompose_visual_description step
      // and consumed by the M3 #5 smart shot-batch selector to pick the
      // portrait view that matches the character's in-shot facing.
      // Stored as a parallel array so Convex doesn't need record-valued
      // validators. Each entry's `characterId` must appear in
      // `characterIds`; facings that aren't known are simply omitted.
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
    continuity: v.object({
      identityLockVersion: v.number(),
      wardrobeVariantIds: v.array(v.string()),
      consistencyStatus: consistencyStatusValidator,
    }),
    historyContext: v.object({
      eventIds: v.array(v.id("storyEvents")),
      rollingSummary: v.string(),
      tokenBudgetUsed: v.number(),
      lineageHash: v.string(),
    }),
    promptPack: v.object({
      imagePrompt: v.optional(v.string()),
      videoPrompt: v.optional(v.string()),
      negativePrompt: v.optional(v.string()),
      // M5 #5 — optional narration override for per-shot TTS. When
      // present, the audio batch route uses this verbatim instead of
      // its auto-extracted narration from `segment`. Keeps producer
      // edits durable across repeat audio-batch runs.
      audioDesc: v.optional(v.string()),
      continuityDirectives: v.array(v.string()),
    }),
    shotMeta: v.optional(
      v.object({
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
      }),
    ),
    media: v.object({
      images: v.array(mediaVariantValidator),
      videos: v.array(mediaVariantValidator),
      // Per-shot TTS / ambient tracks. Sharing `mediaVariantValidator`
      // keeps the schema narrow — audio assets look structurally like
      // images + videos (url + modelId + createdAt) and flow through
      // the same startMediaGeneration / completeMediaGeneration
      // mutations with `kind: "audio"`.
      audios: v.optional(v.array(mediaVariantValidator)),
      // M7 — per-shot SFX (ambient / foley) track. Mixed UNDER the
      // narration by the reel export pipeline. Kept separate from
      // `audios` so swapping between generated SFX variants doesn't
      // clobber the TTS take and vice-versa.
      sfxs: v.optional(v.array(mediaVariantValidator)),
      activeImageId: v.optional(v.id("mediaAssets")),
      activeVideoId: v.optional(v.id("mediaAssets")),
      activeAudioId: v.optional(v.id("mediaAssets")),
      activeSfxId: v.optional(v.id("mediaAssets")),
    }),
    status: v.union(v.literal("draft"), v.literal("ready"), v.literal("blocked")),
    // M9 — narrative-refinement metadata. All optional; populated by
    // the beat_analyst / tension_analyst / motif_tracker subagents or
    // directly by producers via the beat ribbon / motif map UI.
    // Free-form string fields (beatType, hookType) are validated at
    // the route boundary so new structures can be added without a
    // schema migration.
    beatType: v.optional(v.string()),
    actNumber: v.optional(v.number()),
    tensionLevel: v.optional(v.number()),
    motifIds: v.optional(v.array(v.string())),
    hookType: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_node", ["storyboardId", "nodeId"])
    .index("by_storyboard_updatedAt", ["storyboardId", "updatedAt"]),

  storyboardEdges: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    edgeId: v.string(),
    sourceNodeId: v.string(),
    targetNodeId: v.string(),
    edgeType: v.union(
      v.literal("serial"),
      v.literal("parallel"),
      v.literal("branch"),
      v.literal("merge"),
    ),
    branchId: v.optional(v.string()),
    order: v.optional(v.number()),
    mergeMetadata: v.optional(
      v.object({
        policy: v.string(),
        summary: v.string(),
      }),
    ),
    isPrimary: v.boolean(),
    // M9 — transition intent. Populated by transition_maestro proposals
    // or directly on the canvas. Free-form so new cinematic transitions
    // don't require a schema bump (route boundary validates against the
    // known vocabulary: match_cut, j_cut, l_cut, time_jump,
    // cross_cut_accelerate, hard_cut, dissolve, fade_to_black, ...).
    transitionIntent: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_edge", ["storyboardId", "edgeId"])
    .index("by_storyboard_target", ["storyboardId", "targetNodeId"]),

  characters: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    characterId: v.string(),
    name: v.string(),
    description: v.string(),
    identityProfile: v.object({
      facialMarkers: v.array(v.string()),
      ageBand: v.string(),
      bodySilhouette: v.string(),
      skinHairSignature: v.string(),
      voiceTags: v.array(v.string()),
    }),
    lockVersion: v.number(),
    activeWardrobeVariantId: v.optional(v.id("wardrobeVariants")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_character", ["storyboardId", "characterId"]),

  wardrobeVariants: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    characterId: v.string(),
    variantId: v.string(),
    name: v.string(),
    description: v.string(),
    palette: v.array(v.string()),
    props: v.array(v.string()),
    hairMakeupDelta: v.string(),
    isDefault: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_character", ["storyboardId", "characterId"])
    .index("by_character_variant", ["characterId", "variantId"]),

  backgrounds: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    backgroundId: v.string(),
    name: v.string(),
    description: v.string(),
    visualDirectives: v.array(v.string()),
    referenceImageUrl: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_background", ["storyboardId", "backgroundId"]),

  scenes: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    sceneId: v.string(),
    title: v.string(),
    synopsis: v.string(),
    location: v.optional(v.string()),
    timeOfDay: v.optional(v.string()),
    tone: v.optional(v.string()),
    characterIds: v.array(v.string()),
    backgroundId: v.optional(v.string()),
    continuityNotes: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_scene", ["storyboardId", "sceneId"]),

  shots: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    shotId: v.string(),
    sceneId: v.optional(v.string()),
    title: v.string(),
    beat: v.string(),
    cameraMovement: v.optional(v.string()),
    framing: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    promptNotes: v.array(v.string()),
    characterIds: v.array(v.string()),
    backgroundId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_shot", ["storyboardId", "shotId"])
    .index("by_scene_shot", ["sceneId", "shotId"]),

  storyEvents: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
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
    salience: v.number(),
    eventVersion: v.number(),
    ancestorNodeIds: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_storyboard_createdAt", ["storyboardId", "createdAt"])
    .index("by_storyboard_node_createdAt", ["storyboardId", "nodeId", "createdAt"]),

  nodeHistoryContexts: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    nodeId: v.string(),
    lineageHash: v.string(),
    primaryEventIds: v.array(v.id("storyEvents")),
    mergeCapsules: v.array(
      v.object({
        parentNodeId: v.string(),
        summary: v.string(),
        eventIds: v.array(v.id("storyEvents")),
      }),
    ),
    rollingSummary: v.string(),
    tokenBudgetUsed: v.number(),
    generatedAt: v.number(),
  }).index("by_storyboard_node_lineage", ["storyboardId", "nodeId", "lineageHash"]),

  mediaAssets: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    nodeId: v.string(),
    // M7 — "sfx" is the per-shot ambient/foley track mixed UNDER
    // narration.
    // M8 — "score" is the reel-level background music track mixed
    // UNDER (narration + sfx). Distinct kind so reel-export can
    // pick it up with its own amix pass, and so the schema stays
    // honest about scope (`score` rows carry a dummy nodeId like
    // `__storyboard__` since they aren't shot-scoped).
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
    // "rolled_back" is the terminal state for assets that were successfully
    // generated as part of a batch plan, but the batch partially failed and
    // the adapter compensated earlier successes. The row is preserved for
    // audit/debug but is removed from the node's active media arrays.
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("rolled_back"),
    ),
    identityScore: v.optional(v.number()),
    wardrobeCompliance: v.optional(
      v.union(v.literal("matching"), v.literal("deviation"), v.literal("unknown")),
    ),
    consistencyScore: v.optional(v.number()),
    metadata: v.optional(v.record(v.string(), v.string())),
    masterAssetId: v.optional(v.id("mediaAssets")),
    variantSpec: v.optional(v.object({
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
    })),
    deliveryStatus: v.optional(v.union(
      v.literal("planned"),
      v.literal("in_review"),
      v.literal("approved"),
      v.literal("delivered"),
      v.literal("archived"),
    )),
    // Take status: director / script supervisor review label on the master.
    // Optional — absence means the asset hasn't been marked yet.
    takeStatus: v.optional(v.union(
      v.literal("print"),
      v.literal("hold"),
      v.literal("ng"),
      v.literal("noted"),
    )),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_node_kind_createdAt", ["storyboardId", "nodeId", "kind", "createdAt"])
    .index("by_storyboard_createdAt", ["storyboardId", "createdAt"])
    .index("by_master_createdAt", ["masterAssetId", "createdAt"])
    .index("by_storyboard_deliveryStatus_updatedAt", ["storyboardId", "deliveryStatus", "updatedAt"]),

  mediaComments: defineTable({
    storyboardId: v.id("storyboards"),
    mediaAssetId: v.id("mediaAssets"),
    userId: v.string(),
    // Denormalized author display fields so the review surface can show a
    // name/email chip without a separate user-lookup round-trip. Optional
    // because older rows / server-generated comments may not populate them.
    authorName: v.optional(v.string()),
    authorEmail: v.optional(v.string()),
    // Top-level comments leave this unset; replies point at their parent.
    // Single-level threading is enforced at the mutation layer.
    parentCommentId: v.optional(v.id("mediaComments")),
    // Millisecond offset from the start of the asset (for video). When unset
    // the comment applies to the whole asset.
    timecodeMs: v.optional(v.number()),
    body: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("resolved"),
      v.literal("deleted"),
    ),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_asset_createdAt", ["mediaAssetId", "createdAt"])
    .index("by_asset_timecode", ["mediaAssetId", "timecodeMs"])
    .index("by_storyboard_status_createdAt", ["storyboardId", "status", "createdAt"])
    .index("by_parent_createdAt", ["parentCommentId", "createdAt"]),

  approvalTasks: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    taskType: v.union(
      v.literal("graph_patch"),
      v.literal("media_prompt"),
      v.literal("execution_plan"),
      v.literal("batch_ops"),
      v.literal("merge_policy"),
      v.literal("repair_plan"),
      v.literal("dailies_batch"),
      v.literal("simulation_critic_batch"),
    ),
    status: approvalStatusValidator,
    dedupeKey: v.optional(v.string()),
    title: v.string(),
    rationale: v.string(),
    diffSummary: v.optional(v.string()),
    payloadJson: v.string(),
    // Provenance of the task: "agent" if the row was created by a LangGraph
    // agent run (via upsertAgentDailies / upsertAgentSimulationRun), "human"
    // for direct UI-driven creates. Optional for backward compatibility with
    // rows written before this field existed; unset rows should be treated
    // as "human" by readers.
    origin: v.optional(v.union(v.literal("agent"), v.literal("human"))),
    executionResultJson: v.optional(v.string()),
    executionStartedAt: v.optional(v.number()),
    executionFinishedAt: v.optional(v.number()),
    decision: v.optional(
      v.object({
        approved: v.boolean(),
        editedPayloadJson: v.optional(v.string()),
        reviewerId: v.string(),
        justification: v.optional(v.string()),
        decidedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_dedupe", ["storyboardId", "dedupeKey"])
    .index("by_storyboard_status_createdAt", ["storyboardId", "status", "createdAt"])
    .index("by_storyboard_createdAt", ["storyboardId", "createdAt"]),

  narrativeBranches: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    name: v.string(),
    parentBranchId: v.optional(v.string()),
    parentCommitId: v.optional(v.string()),
    headCommitId: v.optional(v.string()),
    isDefault: v.boolean(),
    status: v.union(v.literal("active"), v.literal("archived")),
    cutTier: v.optional(
      v.union(
        v.literal("assembly"),
        v.literal("editors"),
        v.literal("directors"),
        v.literal("producers"),
        v.literal("pictureLock"),
        v.literal("online"),
        v.literal("delivered"),
      ),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_branch", ["storyboardId", "branchId"])
    .index("by_storyboard_default", ["storyboardId", "isDefault"])
    .index("by_storyboard_branch_updatedAt", ["storyboardId", "updatedAt"]),

  narrativeCommits: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    commitId: v.string(),
    parentCommitId: v.optional(v.string()),
    summary: v.string(),
    rationale: v.optional(v.string()),
    operationCount: v.number(),
    operationsJson: v.string(),
    semanticSummary: v.string(),
    snapshotJson: v.string(),
    appliedByRunId: v.optional(v.string()),
    reviewRound: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_storyboard_branch_createdAt", ["storyboardId", "branchId", "createdAt"])
    .index("by_storyboard_commit", ["storyboardId", "commitId"]),

  semanticDiffs: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    fromCommitId: v.string(),
    toCommitId: v.string(),
    diffJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_storyboard_createdAt", ["storyboardId", "createdAt"])
    .index("by_storyboard_pair", ["storyboardId", "fromCommitId", "toCommitId"]),

  dryRunReports: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    planHash: v.string(),
    operationCount: v.number(),
    valid: v.boolean(),
    riskLevel: riskLevelValidator,
    summary: v.string(),
    issuesJson: v.string(),
    estimatedTotalCost: v.number(),
    estimatedDurationSec: v.number(),
    createdAt: v.number(),
  })
    .index("by_storyboard_branch_createdAt", ["storyboardId", "branchId", "createdAt"])
    .index("by_storyboard_planHash", ["storyboardId", "planHash"]),

  agentDelegations: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    runId: v.string(),
    delegationId: v.string(),
    agentName: v.string(),
    task: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("complete"), v.literal("failed")),
    inputJson: v.string(),
    outputJson: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_run_createdAt", ["storyboardId", "runId", "createdAt"])
    .index("by_storyboard_delegation", ["storyboardId", "delegationId"]),

  identityPacks: defineTable({
    userId: v.string(),
    storyboardId: v.id("storyboards"),
    packId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    dnaJson: v.string(),
    sourceCharacterId: v.optional(v.string()),
    visibility: v.union(v.literal("project"), v.literal("workspace_opt_in")),
    published: v.boolean(),
    // Distinguishes packs that represent a generated / fictional character
    // ("generated", default) from packs backed by an AutoCameo real-person
    // photo ("cameo"). The cameo flag is set by `identityReferences:
    // addCameoReference` and surfaces as a badge in the character chip UI so
    // producers can tell at a glance which characters carry real-world
    // consent obligations.
    sourceType: v.optional(v.union(
      v.literal("generated"),
      v.literal("cameo"),
    )),
    // M6 — per-character TTS voice assignment. When set, the audio
    // batch route picks this voice for shots where this character is
    // the (only) detected speaker. Falls back to the batch's default
    // voice for narration-only shots or shots with multiple speakers.
    // Kept as a free-form string (not a validator-enforced literal)
    // so producers can point at any OpenAI TTS voice without a schema
    // migration; validation happens at the route boundary.
    voice: v.optional(v.string()),
    // M8 — optional ElevenLabs voice clone attached to this pack. When
    // set, the audio batch routes this character's lines through
    // ElevenLabs TTS using the clone's voice id, overriding the
    // `voice` preset above for that character's solo-speaker shots.
    // Multi-speaker mixes still honor it line-by-line via
    // `SpeakerVoiceMap` / the clone lookup path.
    voiceCloneId: v.optional(v.id("voiceClones")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_pack", ["storyboardId", "packId"])
    .index("by_user_visibility_updatedAt", ["userId", "visibility", "updatedAt"]),

  // Reference imagery attached to an identity pack. Kept separate from
  // `mediaAssets` (which is scene/shot-scoped via a required `nodeId`) so
  // reference-imagery semantics don't pollute the media pipeline. Supports
  // future roles (wardrobe photosets, AutoCameo anchors) via the `role`
  // discriminator — the MVP only writes rows with role="portrait".
  identityReferenceAssets: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    ownerPackId: v.id("identityPacks"),
    role: v.union(
      v.literal("portrait"),
      v.literal("wardrobe"),
      v.literal("cameo_reference"),
    ),
    portraitView: v.optional(v.union(
      v.literal("front"),
      v.literal("side"),
      v.literal("back"),
      v.literal("three_quarter"),
      v.literal("custom"),
    )),
    sourceUrl: v.string(),
    modelId: v.optional(v.string()),
    prompt: v.optional(v.string()),
    notes: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("archived"),
    ),
    // M3 #6 AutoCameo fields. Only populated on rows with role="cameo_reference".
    // Consent must be recorded BEFORE the row is inserted; the shot-batch
    // pipeline refuses to use cameo refs whose status is not "approved".
    // Watermark is applied client-side by `applyCameoWatermark` in
    // `src/lib/cameo/` and the result's sha256 is stored for forensic audit.
    consentStatus: v.optional(v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
    )),
    watermarkApplied: v.optional(v.boolean()),
    attributionText: v.optional(v.string()),
    uploadedByUserId: v.optional(v.string()),
    cameoSourcePhotoHash: v.optional(v.string()),
    // Optional back-reference to the Convex `_storage` row that holds
    // the watermarked PNG bytes. Present when the cameo was uploaded
    // via `storage:generateCameoUploadUrl`; absent on legacy rows that
    // stored the image inline as a data URL. When present, read-path
    // code may refresh `sourceUrl` by re-resolving the storage id
    // (e.g. if the CDN URL rotates).
    cameoStorageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_pack_createdAt", ["ownerPackId", "createdAt"])
    .index("by_storyboard_role_createdAt", ["storyboardId", "role", "createdAt"]),

  globalConstraints: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    constraintId: v.string(),
    name: v.string(),
    description: v.string(),
    severity: riskLevelValidator,
    scope: v.union(v.literal("character"), v.literal("narration"), v.literal("visual"), v.literal("timeline")),
    expressionJson: v.string(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_constraint", ["storyboardId", "constraintId"])
    .index("by_storyboard_enabled_updatedAt", ["storyboardId", "enabled", "updatedAt"]),

  continuityViolations: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    violationId: v.string(),
    branchId: v.optional(v.string()),
    code: v.string(),
    severity: riskLevelValidator,
    status: v.union(v.literal("open"), v.literal("acknowledged"), v.literal("resolved")),
    message: v.string(),
    nodeIds: v.array(v.string()),
    edgeIds: v.array(v.string()),
    suggestedFix: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_status_createdAt", ["storyboardId", "status", "createdAt"])
    .index("by_storyboard_violation", ["storyboardId", "violationId"]),

  agentRuns: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    runId: v.string(),
    agentName: v.string(),
    graphId: v.string(),
    intent: v.string(),
    status: approvalStatusValidator,
    actionsJson: v.string(),
    diagnostics: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_storyboard_startedAt", ["storyboardId", "startedAt"])
    .index("by_runId", ["runId"]),

  autonomousDailies: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    reelId: v.string(),
    title: v.string(),
    summary: v.string(),
    clipNodeIds: v.array(v.string()),
    clipMediaAssetIds: v.array(v.id("mediaAssets")),
    highlights: v.array(v.string()),
    continuityRiskLevel: riskLevelValidator,
    continuityRisksJson: v.string(),
    proposedOperationsJson: v.string(),
    status: v.union(
      v.literal("drafted"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("applied"),
    ),
    // Join to the `approvalTasks` row that carries the full executionPlan
    // + decision audit trail. Optional because legacy rows created before
    // this field was introduced won't have one.
    approvalTaskId: v.optional(v.id("approvalTasks")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_branch_createdAt", ["storyboardId", "branchId", "createdAt"])
    .index("by_storyboard_reel", ["storyboardId", "reelId"]),

  simulationCriticRuns: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    simulationRunId: v.string(),
    sourcePlanId: v.optional(v.string()),
    status: v.union(
      v.literal("complete"),
      v.literal("failed"),
      v.literal("waiting_for_human"),
      v.literal("applied"),
      v.literal("rejected"),
    ),
    summary: v.string(),
    riskLevel: riskLevelValidator,
    issuesJson: v.string(),
    repairOperationsJson: v.string(),
    confidence: v.number(),
    impactScore: v.number(),
    // Join to the `approvalTasks` row that carries the full executionPlan
    // + decision audit trail. Optional for legacy rows.
    approvalTaskId: v.optional(v.id("approvalTasks")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_branch_createdAt", ["storyboardId", "branchId", "createdAt"])
    .index("by_storyboard_run", ["storyboardId", "simulationRunId"]),

  agentTeams: defineTable({
    teamId: v.string(),
    name: v.string(),
    description: v.string(),
    ownerUserId: v.string(),
    visibility: teamVisibilityValidator,
    status: teamStatusValidator,
    isPrebuilt: v.boolean(),
    currentPublishedRevisionId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_updatedAt", ["ownerUserId", "updatedAt"])
    .index("by_owner_team", ["ownerUserId", "teamId"])
    .index("by_owner_prebuilt_updatedAt", ["ownerUserId", "isPrebuilt", "updatedAt"]),

  agentTeamRevisions: defineTable({
    teamId: v.id("agentTeams"),
    revisionId: v.string(),
    version: v.number(),
    teamGoal: v.string(),
    policyJson: v.string(),
    membersJson: v.string(),
    toolAllowlistJson: v.string(),
    resourceScopesJson: v.string(),
    published: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_team_revision", ["teamId", "revisionId"])
    .index("by_team_version", ["teamId", "version"])
    .index("by_team_published_createdAt", ["teamId", "published", "createdAt"]),

  agentTeamAssignments: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    activeTeamId: v.id("agentTeams"),
    activeRevisionId: v.string(),
    fallbackTeamId: v.optional(v.id("agentTeams")),
    updatedAt: v.number(),
  })
    .index("by_storyboard", ["storyboardId"])
    .index("by_user_updatedAt", ["userId", "updatedAt"]),

  agentTeamMembers: defineTable({
    teamId: v.id("agentTeams"),
    revisionId: v.string(),
    memberId: v.string(),
    agentName: v.string(),
    role: v.string(),
    persona: v.string(),
    nicheDescription: v.string(),
    toolScope: v.array(v.string()),
    resourceScope: v.array(v.string()),
    weight: v.number(),
    enabled: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_team_revision", ["teamId", "revisionId"])
    .index("by_team_revision_agent", ["teamId", "revisionId", "agentName"]),

  agentTeamRunPolicies: defineTable({
    teamId: v.id("agentTeams"),
    revisionId: v.string(),
    requiresHitl: v.boolean(),
    riskThresholdsJson: v.string(),
    maxBatchSize: v.number(),
    quotaProfileId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_team_revision", ["teamId", "revisionId"])
    .index("by_quota_profile", ["quotaProfileId"]),

  quotaProfiles: defineTable({
    ownerUserId: v.string(),
    quotaProfileId: v.string(),
    name: v.string(),
    dailyMediaBudget: v.number(),
    dailyMutationOps: v.number(),
    maxRunOps: v.number(),
    maxConcurrentRuns: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_profile", ["ownerUserId", "quotaProfileId"])
    .index("by_owner_updatedAt", ["ownerUserId", "updatedAt"]),

  quotaUsageWindows: defineTable({
    ownerUserId: v.string(),
    quotaProfileId: v.string(),
    dayKey: v.string(),
    mediaBudgetUsed: v.number(),
    mutationOpsUsed: v.number(),
    activeRuns: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_profile_day", ["ownerUserId", "quotaProfileId", "dayKey"])
    .index("by_owner_day_updatedAt", ["ownerUserId", "dayKey", "updatedAt"]),

  secretHandles: defineTable({
    handleId: v.string(),
    provider: v.string(),
    scope: v.string(),
    ownerUserId: v.string(),
    secretRef: v.string(),
    status: secretStatusValidator,
    createdAt: v.number(),
  })
    .index("by_owner_handle", ["ownerUserId", "handleId"])
    .index("by_owner_provider_createdAt", ["ownerUserId", "provider", "createdAt"]),

  toolCallAudits: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    runId: v.optional(v.string()),
    teamId: v.optional(v.string()),
    revisionId: v.optional(v.string()),
    member: v.string(),
    tool: v.string(),
    scope: v.array(v.string()),
    result: v.union(v.literal("success"), v.literal("failure"), v.literal("blocked")),
    detailsJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_storyboard_createdAt", ["storyboardId", "createdAt"])
    .index("by_storyboard_run_createdAt", ["storyboardId", "runId", "createdAt"]),

  teamPromptDrafts: defineTable({
    draftId: v.string(),
    ownerUserId: v.string(),
    inputPrompt: v.string(),
    generatedSpecJson: v.string(),
    accepted: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_createdAt", ["ownerUserId", "createdAt"])
    .index("by_owner_draft", ["ownerUserId", "draftId"]),

  // M5 #6 — persisted record of every reel export. Separate from
  // mediaAssets (which is node-scoped via a required nodeId) so the
  // storyboard-level reel doesn't need a synthetic node. Each row
  // carries enough metadata to re-play or re-download without
  // rebuilding the manifest.
  // M7 — subtitle translation cache. Producers often re-fetch the
  // same locale (switching between vtt/srt formats, reloading the
  // player dialog, etc.); translating the same source cues over and
  // over wastes OpenAI tokens without changing output. One row per
  // (storyboardId, locale); `cuesHash` fingerprints the source texts
  // so we can invalidate the row when the reel's dialogue changes.
  subtitleTranslations: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    locale: v.string(),
    /** Stable fingerprint of the source cue texts — when the reel's
     *  dialogue changes this hash changes and the cache is bypassed. */
    cuesHash: v.string(),
    /** JSON-encoded `string[]` with one translated body per source
     *  cue, in order. Paired with the source cue list's speaker
     *  prefixes at read time. */
    translatedTextsJson: v.string(),
    /** Provider id for observability (e.g. `"gpt-4o-mini"`). Lets us
     *  invalidate old rows after a provider swap if the quality
     *  shifts. */
    provider: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_locale", ["storyboardId", "locale"])
    .index("by_user_updatedAt", ["userId", "updatedAt"]),

  // M8 — producer-owned character voice clones. Keyed on the
  // producer's userId (voice clones follow the producer account, not
  // the storyboard, so the same clone can be reused across projects).
  // Each row carries the ElevenLabs voice id, a short preview clip
  // url, and optional usage metadata.
  //
  // Identity packs attach a clone via an optional `voiceCloneId`
  // field on `identityPacks`; when the audio batch encounters a
  // speaker whose pack has a clone attached, the TTS call is routed
  // through ElevenLabs with that voice instead of the six OpenAI
  // presets. Fallback to the OpenAI voice stays intact when the
  // clone's provider errors (graceful degradation).
  voiceClones: defineTable({
    userId: v.string(),
    /** Producer-facing display name, e.g. "Maya (warm, medium-pitch)". */
    name: v.string(),
    /** Optional description — tags, provenance ("sampled from XYZ
     *  with consent"), character arc notes. */
    description: v.optional(v.string()),
    /** ElevenLabs voice id returned at clone time. This is the only
     *  identifier the TTS runtime needs; everything else is metadata. */
    elevenlabsVoiceId: v.string(),
    /** URL of a short (≤30s) preview sample, stored in Convex
     *  `_storage`. Surfaced in the picker so producers can audition
     *  before assigning. Optional — older clones may not have one. */
    previewUrl: v.optional(v.string()),
    /** Optional locale the clone was trained in. Defaults to English
     *  when absent. Useful when a producer clones a Spanish-speaking
     *  actor and wants the voice clamped to that locale. */
    locale: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_createdAt", ["userId", "createdAt"]),

  // M8 — per-locale narration audio tracks. Each row attaches a
  // `kind: "audio"` mediaAsset to a (nodeId, locale) pair so the reel
  // pipeline can ship a dubbed reel per language without clobbering
  // the source-language narration.
  //
  // Schema note: the source language (English) lives on the node's
  // `media.audios` array as it always has; only translated locales
  // land in this table. Keeps the common case (single-language reels)
  // zero-overhead and makes the "which languages does this reel
  // support?" query trivial: `list by storyboard + group by locale`.
  localeNarrations: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    nodeId: v.string(),
    /** BCP-47-ish locale code (e.g. "es", "fr-CA", "ja"). Producers
     *  pick from the same 10-locale roster exposed in the subtitles
     *  picker. */
    locale: v.string(),
    /** The `kind: "audio"` mediaAsset holding the dubbed narration
     *  for this (node, locale) pair. Stored separately so a single
     *  asset row serves variant history; the latest upsert wins. */
    mediaAssetId: v.id("mediaAssets"),
    /** Copy of the translated prompt used to generate this dub.
     *  Kept here as an observability convenience — the reel
     *  pipeline never reads it, but producers debugging a bad dub
     *  want to see what the TTS was fed. */
    translatedText: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_locale_node", [
      "storyboardId",
      "locale",
      "nodeId",
    ])
    .index("by_storyboard_node", ["storyboardId", "nodeId"]),

  reelExports: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    storageId: v.id("_storage"),
    sourceUrl: v.string(),
    shotCount: v.number(),
    totalDurationS: v.number(),
    byteLength: v.number(),
    // Snapshot of the manifest title at export time — useful when the
    // producer renames the storyboard later.
    title: v.string(),
    createdAt: v.number(),
  })
    .index("by_storyboard_createdAt", ["storyboardId", "createdAt"])
    .index("by_user_createdAt", ["userId", "createdAt"]),

  // ============================================================
  // M9 — Narrative refinement tables
  // ============================================================
  // Beat plan per (storyboard, branch). One row per active structure
  // (a branch can only have one structure at a time; switching
  // replaces the row). `beats` is an ordered list of slots; each slot
  // carries `nodeId` when a storyboard node has been assigned to it.
  // Status transitions: "planned" → "assigned" (node pinned) →
  // "missing" (was assigned but producer deleted the node).
  narrativeBeats: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    structure: v.union(
      v.literal("save_the_cat"),
      v.literal("harmon_circle"),
      v.literal("three_act"),
      v.literal("kishotenketsu"),
      v.literal("hook_first"),
    ),
    beats: v.array(
      v.object({
        beatKey: v.string(),
        expectedActNumber: v.optional(v.number()),
        nodeId: v.optional(v.string()),
        status: v.union(
          v.literal("planned"),
          v.literal("assigned"),
          v.literal("missing"),
        ),
        rationale: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_branch", ["storyboardId", "branchId"])
    .index("by_user_updatedAt", ["userId", "updatedAt"]),

  // Motif registry. A motif is any recurring visual, prop, line, or
  // sfx that spans multiple nodes. Setup nodes (source) plant the
  // motif; payoff nodes land it. `landedStatus` summarizes whether
  // every plant has a callback.
  narrativeMotifs: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    motifKey: v.string(),
    description: v.string(),
    sourceNodeIds: v.array(v.string()),
    payoffNodeIds: v.array(v.string()),
    // Free-form description of the visual vocabulary (palette, prop,
    // composition cue) so visual_director can echo it in the payoff
    // shot's image prompt.
    visualVocabulary: v.optional(v.string()),
    landedStatus: v.union(
      v.literal("unplanted"),
      v.literal("planted"),
      v.literal("landed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_motifKey", ["storyboardId", "motifKey"])
    .index("by_storyboard_updatedAt", ["storyboardId", "updatedAt"]),

  // Links each narrative-git branch to its generator + rationale. Lets
  // us build a variant catalog ("show me every cold-open variant this
  // producer has tried") without walking every branch's commit log.
  narrativeVariants: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    variantType: v.union(
      v.literal("hook"),
      v.literal("structural"),
      v.literal("transition"),
      v.literal("remix"),
    ),
    rationale: v.string(),
    // The agent run that produced this variant — useful for tracing
    // which chat turn spawned which branch.
    generatedByRunId: v.optional(v.string()),
    producerPicked: v.boolean(),
    // When this variant was branched off another variant (not the
    // primary timeline), record the parent so we can reconstruct a
    // variant tree.
    parentBranchId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_type", ["storyboardId", "variantType"])
    .index("by_storyboard_branch", ["storyboardId", "branchId"])
    .index("by_user_updatedAt", ["userId", "updatedAt"]),

  // Cached reel-level narrative state per (storyboard, branch). Acts
  // as the Convex mirror of the LangGraph `reel_narrative_state`
  // working memory. JSON payloads keep the ontology flexible — we
  // intentionally don't pre-commit to a rigid beat schema since the
  // structure changes per-branch (Save-the-Cat vs Harmon vs hook-first
  // all have different beat vocabularies).
  reelNarrativeState: defineTable({
    storyboardId: v.id("storyboards"),
    userId: v.string(),
    branchId: v.string(),
    structure: v.string(),
    beatMapJson: v.string(),
    motifRegistryJson: v.string(),
    tensionSamplesJson: v.string(),
    characterWantNeedJson: v.string(),
    computedAt: v.number(),
    // Commit id this state was computed from. Reconcile + invalidate
    // when the branch head moves past this commit.
    computedFromCommitId: v.optional(v.string()),
    stale: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_storyboard_branch", ["storyboardId", "branchId"])
    .index("by_user_updatedAt", ["userId", "updatedAt"]),
});
