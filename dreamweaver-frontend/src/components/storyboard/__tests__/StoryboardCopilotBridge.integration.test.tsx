import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { fireEvent, render, waitFor, cleanup } from "@testing-library/react";
import { JSDOM } from "jsdom";
import type {
  RuntimeResolvedTeam,
  StoryNode,
  StoryNodeData,
  StoryEdge,
} from "@/app/storyboard/types";

type MutationCall = Record<string, unknown>;
type MutationFn = (args: MutationCall) => Promise<unknown>;

type HitlRenderParams = {
  args: Record<string, unknown>;
  status: string;
  respond?: (payload: Record<string, unknown>) => void;
  result?: unknown;
};

type HitlConfig = {
  name: string;
  render: (params: HitlRenderParams) => React.ReactElement;
};

const hitlRegistry = new Map<string, HitlConfig>();
const mutationSpyRegistry = new Map<string, { calls: MutationCall[]; fn: MutationFn }>();

const createMutationSpy = (
  handler?: (args: MutationCall) => unknown,
): { calls: MutationCall[]; fn: MutationFn } => {
  const calls: MutationCall[] = [];
  const fn: MutationFn = async (args) => {
    calls.push(args);
    if (handler) {
      return handler(args);
    }
    return undefined;
  };
  return { calls, fn };
};

const setupMutationSpies = () => {
  mutationSpyRegistry.clear();
  mutationSpyRegistry.set("approvals:createTask", createMutationSpy(() => "task_1"));
  mutationSpyRegistry.set("approvals:resolveTask", createMutationSpy(() => "task_1"));
  // markExecutionStarted/Finished bracket every HITL approval so the
  // UI can show "executing…" vs a final status. Both return the
  // approval task id unchanged.
  mutationSpyRegistry.set(
    "approvals:markExecutionStarted",
    createMutationSpy(() => "task_1"),
  );
  mutationSpyRegistry.set(
    "approvals:markExecutionFinished",
    createMutationSpy(() => "task_1"),
  );
  mutationSpyRegistry.set("storyboards:applyGraphPatch", createMutationSpy(() => ({ touchedNodeIds: ["node_1"] })));
  mutationSpyRegistry.set("storyboards:recordStoryEvent", createMutationSpy(() => "event_1"));
  mutationSpyRegistry.set("storyboards:refreshNodeHistoryContexts", createMutationSpy(() => ({ refreshed: 1 })));
  mutationSpyRegistry.set("mediaAssets:createMediaAsset", createMutationSpy(() => "media_1"));
  // revertBatchMediaAssets rolls back a batch when the producer rejects
  // mid-batch. Returns the number of assets reverted.
  mutationSpyRegistry.set(
    "mediaAssets:revertBatchMediaAssets",
    createMutationSpy(() => ({ reverted: 0 })),
  );
  // M6 — per-character TTS voice assignment. Returns the pack id so
  // the caller can chain UI refreshes; the spy just echoes the input.
  mutationSpyRegistry.set(
    "continuityOS:setIdentityPackVoice",
    createMutationSpy(() => "pack_1"),
  );
  // M8 — reel-level score attach; called after createMediaAsset in the
  // request_generate_score handler. Returns a trivial ack.
  mutationSpyRegistry.set(
    "storyboards:setStoryboardScore",
    createMutationSpy(() => ({
      storyboardId: "sb_1",
      volumeDb: -18,
    })),
  );
  // M9 Phase 2 — beat-assignment approval flow. `setNodeNarrativeFields`
  // patches each assigned shot's beatType + actNumber;
  // `upsertBeatPlan` persists the plan row keyed by (storyboard, branch).
  mutationSpyRegistry.set(
    "narrativeState:setNodeNarrativeFields",
    createMutationSpy((args) => ({ nodeId: String(args.nodeId ?? "") })),
  );
  mutationSpyRegistry.set(
    "narrativeState:upsertBeatPlan",
    createMutationSpy(() => "beat_plan_1"),
  );
  // M9 Phase 3 — hook + remix variants commit N narrative-git branches
  // on approve. createBranch is idempotent, commitPlanOps writes the
  // variant's ops to that branch, upsertVariant records metadata so
  // Variant Compare can enumerate candidates.
  mutationSpyRegistry.set(
    "narrativeGit:createBranch",
    createMutationSpy((args) => args.branchId ?? "branch_1"),
  );
  mutationSpyRegistry.set(
    "narrativeState:upsertVariant",
    createMutationSpy((args) => `variant_${String(args.branchId ?? "v")}`),
  );
  // M9 Phase 4 — transition + motif mutations for the new HITL handlers.
  mutationSpyRegistry.set(
    "narrativeState:setEdgeTransitionIntent",
    createMutationSpy((args) => ({ edgeId: String(args.edgeId ?? "") })),
  );
  mutationSpyRegistry.set(
    "narrativeState:upsertMotif",
    createMutationSpy((args) => `motif_${String(args.motifKey ?? "m")}`),
  );
  mutationSpyRegistry.set(
    "storyboards:compileNodePromptPack",
    createMutationSpy((args) => ({
      prompt: String(args.basePrompt ?? ""),
      negativePrompt: String(args.negativePrompt ?? ""),
    })),
  );
  mutationSpyRegistry.set(
    "narrativeGit:simulateExecutionPlan",
    createMutationSpy(() => ({
      valid: true,
      riskLevel: "low",
      summary: "Dry-run passed.",
      issues: [],
      estimatedTotalCost: 0.18,
      estimatedDurationSec: 1.6,
      planHash: "plan_hash_1",
    })),
  );
  mutationSpyRegistry.set(
    "narrativeGit:commitPlanOps",
    createMutationSpy(() => ({
      commitId: "commit_1",
      branchId: "main",
      operationCount: 1,
    })),
  );
  mutationSpyRegistry.set(
    "narrativeGit:rollbackToCommit",
    createMutationSpy(() => ({
      rolledBackTo: "commit_1",
      branchId: "main",
    })),
  );
  mutationSpyRegistry.set(
    "narrativeGit:applyMergePolicy",
    createMutationSpy(() => ({
      commitId: "merge_commit_1",
      branchId: "main",
      operationCount: 1,
      summary: "Applied merge policy.",
    })),
  );
  mutationSpyRegistry.set(
    "dailies:generateAutonomousDailies",
    createMutationSpy(() => ({
      reelId: "reel_1",
    })),
  );
  mutationSpyRegistry.set("dailies:updateDailiesStatus", createMutationSpy(() => "reel_1"));
  // Autonomous dailies path also writes the raw agent output via
  // upsertAgentDailies; simulation critic runs write via
  // upsertAgentSimulationRun. Both are side-effect mutations with no
  // interesting return value for the bridge.
  mutationSpyRegistry.set(
    "dailies:upsertAgentDailies",
    createMutationSpy(() => "reel_1"),
  );
  mutationSpyRegistry.set(
    "dailies:upsertAgentSimulationRun",
    createMutationSpy(() => "sim_1"),
  );
  mutationSpyRegistry.set(
    "dailies:runSimulationCritic",
    createMutationSpy(() => ({
      simulationRunId: "sim_1",
    })),
  );
  mutationSpyRegistry.set("dailies:updateSimulationRunStatus", createMutationSpy(() => "sim_1"));
  mutationSpyRegistry.set("agentRuns:startRun", createMutationSpy(() => "run_db_1"));
  mutationSpyRegistry.set("agentRuns:finishRun", createMutationSpy(() => "run_db_1"));
  mutationSpyRegistry.set(
    "quotas:checkAndReserveRunBudget",
    createMutationSpy(() => ({
      reserved: true,
      usage: { mediaBudgetUsed: 1, mutationOpsUsed: 1, activeRuns: 1 },
    })),
  );
  mutationSpyRegistry.set(
    "quotas:releaseRunBudget",
    createMutationSpy(() => ({
      released: true,
      usage: { mediaBudgetUsed: 1, mutationOpsUsed: 1, activeRuns: 0 },
    })),
  );
  mutationSpyRegistry.set("agentTeams:assignTeamToStoryboard", createMutationSpy(() => "assignment_1"));
  mutationSpyRegistry.set("agentTeams:createTeam", createMutationSpy(() => ({ teamId: "team_1", revisionId: "team_1:v1" })));
  mutationSpyRegistry.set("agentTeams:updateRevisionMember", createMutationSpy(() => ({ memberId: "planner" })));
  mutationSpyRegistry.set("agentTeams:publishRevision", createMutationSpy(() => ({ teamId: "team_1", revisionId: "team_1:v1" })));
  mutationSpyRegistry.set("agentTeams:generateTeamFromPrompt", createMutationSpy(() => ({
    draftId: "draft_1",
    generatedSpec: {
      teamGoal: "Goal",
      policy: {
        requiresHitl: true,
        riskThresholds: { warnAt: "medium", blockAt: "high" },
        maxBatchSize: 4,
        quotaProfileId: "default_standard",
        maxRunOps: 24,
        maxConcurrentRuns: 2,
        quotaEnforced: true,
      },
      members: [],
      toolAllowlist: ["graph.patch"],
      resourceScopes: ["storyboard.graph"],
    },
  })));
  mutationSpyRegistry.set("agentTeams:applyPromptDraftToRevision", createMutationSpy(() => ({ revisionId: "team_1:v2" })));
  mutationSpyRegistry.set("toolAudits:recordToolCallAudit", createMutationSpy(() => "audit_1"));
};

mock.module("@copilotkit/react-core", () => {
  return {
    useCoAgent: () => ({
      setState: () => undefined,
      state: {},
      running: false,
    }),
    useCopilotReadable: () => undefined,
    useCopilotAction: () => undefined,
    useHumanInTheLoop: (config: HitlConfig) => {
      hitlRegistry.set(config.name, config);
    },
  };
});

mock.module("@copilotkit/react-ui", () => {
  return {
    CopilotSidebar: ({ labels }: { labels: { title: string } }) => (
      <div data-testid="copilot-sidebar">{labels.title}</div>
    ),
  };
});

mock.module("convex/react", () => {
  return {
    useMutation: (ref: unknown) => {
      const key = String(ref);
      const entry = mutationSpyRegistry.get(key);
      if (!entry) {
        throw new Error(`No mutation spy registered for ${key}`);
      }
      return entry.fn;
    },
    // bun's mock.module is process-wide, not file-scoped — once any test
    // in the run registers this mock, every subsequent import of
    // `convex/react` in OTHER test files resolves to this stub. Without
    // a `useQuery` export here, sibling tests that only needed
    // useQuery explode with "Export named 'useQuery' not found" during
    // module evaluation. Providing a no-op useQuery keeps those tests
    // loading cleanly; the mock stub returns `undefined` which the
    // production code already treats as "loading".
    useQuery: () => undefined,
  };
});

// Pre-existing: the bridge calls `useRouter()` at module mount. Without
// this mock next/navigation throws 'invariant expected app router to be
// mounted' because jsdom + @testing-library/react doesn't set up the
// Next app-router context. We only stub the methods the bridge actually
// calls — push() for programmatic navigation; the rest are present so
// any future addition keeps working without a test change.
mock.module("next/navigation", () => {
  return {
    useRouter: () => ({
      push: () => undefined,
      replace: () => undefined,
      prefetch: () => undefined,
      back: () => undefined,
      forward: () => undefined,
      refresh: () => undefined,
    }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
  };
});

const buildNode = (id: string, imageUrl?: string): StoryNode => {
  const data: StoryNodeData = {
    label: `Node ${id}`,
    segment: "A cinematic beat in the alleyway.",
    nodeType: "scene",
    entityRefs: {
      characterIds: imageUrl ? ["char_1"] : [],
    },
    continuity: {
      identityLockVersion: 1,
      wardrobeVariantIds: imageUrl ? ["wardrobe_A"] : [],
      consistencyStatus: "ok",
    },
    historyContext: {
      eventIds: [],
      rollingSummary: "The hero escaped and enters a crowded alley.",
      tokenBudgetUsed: 100,
      lineageHash: "ln_node",
    },
    promptPack: {
      continuityDirectives: [],
    },
    media: {
      images: imageUrl
        ? [
            {
              id: "img_existing",
              kind: "image",
              url: imageUrl,
              modelId: "seed",
              prompt: "existing",
              status: "completed",
              createdAt: Date.now(),
            },
          ]
        : [],
      videos: [],
    },
    image: imageUrl,
    imageHistory: imageUrl ? [imageUrl] : [],
  };
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data,
  };
};

const createGraph = (): { nodes: StoryNode[]; edges: StoryEdge[] } => ({
  nodes: [buildNode("node_1", "https://img.example/base.png"), buildNode("node_2")],
  edges: [{ id: "e1", source: "node_1", target: "node_2" } as StoryEdge],
});

const runtimeTeam: RuntimeResolvedTeam = {
  teamId: "producer_guarded_default",
  teamName: "Producer Guarded Default",
  revisionId: "producer_guarded_default:v1",
  version: 1,
  teamGoal: "Deliver safe storyboard proposals with strict HITL.",
  members: [],
  toolAllowlist: ["graph.patch", "media.prompt", "media.image.generate", "media.video.generate", "execution.plan"],
  resourceScopes: ["storyboard.graph", "storyboard.context", "media.apis"],
  runtimePolicy: {
    requiresHitl: true,
    riskThresholds: {
      warnAt: "medium",
      blockAt: "high",
    },
    maxBatchSize: 12,
    quotaProfileId: "default_standard",
    maxRunOps: 24,
    maxConcurrentRuns: 2,
    quotaEnforced: true,
    dailyMediaBudget: 20,
    dailyMutationOps: 120,
  },
};

describe("StoryboardCopilotBridge UI integration", () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalActFlag = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/",
    });
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    process.env.NEXT_PUBLIC_API_URL = "http://api.local";
    hitlRegistry.clear();
    setupMutationSpies();
    cleanup();
  });

  afterEach(() => {
    cleanup();
    hitlRegistry.clear();
    mutationSpyRegistry.clear();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActFlag;
  });

  it("wires approve_graph_patch card approve button to full execution chain", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("approve_graph_patch");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("approve_graph_patch not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        patchId: "patch_1",
        title: "Add branch",
        rationale: "Need alternate path",
        diffSummary: "Create one branch node.",
        operations: [
          {
            op: "create_node",
            nodeId: "branch_1",
            nodeType: "branch",
            label: "Parallel path",
            segment: "Alternative story starts",
            position: { x: 100, y: 200 },
          },
        ],
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    const response = responses[0];
    expect(response.approved).toBe(true);
    expect(mutationSpyRegistry.get("approvals:createTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:resolveTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:applyGraphPatch")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:recordStoryEvent")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:refreshNodeHistoryContexts")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("agentRuns:startRun")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("agentRuns:finishRun")?.calls.length).toBe(1);
  });

  it("wires approve_media_prompt card approve button to full media execution chain", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/api/storyboard/media-proxy")) {
        const endpoint = String(body.endpoint ?? "");
        const payload = typeof body.payload === "object" && body.payload !== null
          ? body.payload as Record<string, unknown>
          : {};
        if (endpoint === "/api/image/compose") {
          expect(Array.isArray(payload.input_images)).toBe(true);
          return new Response(
            JSON.stringify({
              status: 200,
              ok: true,
              data: {
                id: "img_1",
                model: "gpt-image-1",
                images: [{ url: "https://img.example/generated.png" }],
              },
            }),
            { status: 200 },
          );
        }
        if (endpoint === "/api/consistency/evaluate") {
          return new Response(
            JSON.stringify({
              status: 200,
              ok: true,
              data: {
                identity_score: 0.95,
                consistency_score: 0.94,
                wardrobe_compliance: "matching",
              },
            }),
            { status: 200 },
          );
        }
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("approve_media_prompt");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("approve_media_prompt not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        nodeId: "node_1",
        mediaType: "image",
        prompt: "Cinematic neon still",
        negativePrompt: "identity drift",
        contextSummary: "Rolling context summary",
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve Prompt"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    const response = responses[0];
    expect(response.approved).toBe(true);
    expect(mutationSpyRegistry.get("approvals:createTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:resolveTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("mediaAssets:createMediaAsset")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:compileNodePromptPack")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:recordStoryEvent")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:refreshNodeHistoryContexts")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("agentRuns:startRun")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("agentRuns:finishRun")?.calls.length).toBe(1);
  });

  it("wires approve_execution_plan card approve button to dry-run + commit chain", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("approve_execution_plan");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("approve_execution_plan not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        planId: "plan_1",
        storyboardId: "storyboard_1",
        branchId: "main",
        title: "Apply plan",
        rationale: "Need safe multi-op apply",
        operations: [
          {
            opId: "op_1",
            op: "create_node",
            title: "Create branch node",
            rationale: "Add divergence",
            nodeId: "branch_1",
            requiresHitl: true,
            payload: {
              nodeType: "branch",
              label: "Parallel path",
              segment: "Alternative branch",
              position: { x: 120, y: 240 },
            },
          },
        ],
        dryRun: {
          valid: true,
          riskLevel: "low",
          summary: "Dry-run passed.",
          issues: [],
          estimatedTotalCost: 0.18,
          estimatedDurationSec: 1.6,
          planHash: "plan_hash_1",
        },
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(mutationSpyRegistry.get("narrativeGit:simulateExecutionPlan")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:createTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:resolveTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("storyboards:recordStoryEvent")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("agentRuns:startRun")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("agentRuns:finishRun")?.calls.length).toBe(1);
  });

  it("renders simulation critic preview card and continues to approve_batch_ops payload", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("preview_simulation_critic_plan");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("preview_simulation_critic_plan not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        simulationRunId: "sim_1",
        storyboardId: "storyboard_1",
        branchId: "main",
        summary: "Simulation critic found pacing and causality risks.",
        riskLevel: "high",
        confidence: 0.78,
        impactScore: 0.67,
        issues: [
          {
            code: "SIM_PACING_DENSITY",
            severity: "medium",
            message: "Event density is too high for emotional readability.",
            suggestedFix: "Insert bridge beat before climax.",
          },
        ],
        executionPlan: {
          planId: "critic_plan_1",
          storyboardId: "storyboard_1",
          branchId: "main",
          title: "Simulation Critic Repair Batch",
          rationale: "Repair pacing and causality",
          operations: [
            {
              opId: "op_critic_1",
              op: "update_node",
              nodeId: "node_2",
              title: "Repair pacing",
              payload: { suggestedFix: "Add transition shot" },
            },
          ],
          dryRun: {
            valid: true,
            riskLevel: "medium",
            summary: "Dry-run completed.",
            issues: [],
            estimatedTotalCost: 0.15,
            estimatedDurationSec: 1.8,
            planHash: "critic_hash_1",
          },
        },
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Continue to Batch Approval"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    expect(responses[0]?.nextAction).toBe("approve_batch_ops");
    expect(mutationSpyRegistry.get("approvals:createTask")?.calls.length).toBe(0);
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(0);
  });

  it("wires approve_dailies_batch card approve selected button to batch execution + dailies status", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/api/storyboard/media-proxy")) {
        return new Response(
          JSON.stringify({
            status: 200,
            ok: true,
            data: {
              images: [{ url: "https://img.example/dailies_batch.png" }],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("approve_dailies_batch");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("approve_dailies_batch not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        planId: "daily_plan_1",
        storyboardId: "storyboard_1",
        branchId: "main",
        title: "Autonomous Dailies Batch",
        rationale: "Apply selected dailies operations",
        sourceId: "reel_1",
        operations: [
          {
            opId: "op_1",
            op: "create_node",
            nodeId: "bridge_1",
            title: "Bridge scene",
            payload: {
              nodeType: "scene",
              label: "Bridge Scene",
              segment: "Continuity bridge",
              position: { x: 80, y: 120 },
            },
          },
          {
            opId: "op_2",
            op: "generate_image",
            nodeId: "node_2",
            title: "Generate missing daily clip",
            payload: {
              prompt: "Cinematic still for daily cut",
            },
          },
        ],
        dryRun: {
          valid: true,
          riskLevel: "medium",
          summary: "Dailies plan review",
          issues: [],
          estimatedTotalCost: 0.44,
          estimatedDurationSec: 4.1,
          planHash: "daily_hash_1",
        },
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve Selected"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(mutationSpyRegistry.get("narrativeGit:simulateExecutionPlan")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("mediaAssets:createMediaAsset")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("dailies:updateDailiesStatus")?.calls.length).toBe(1);
  });

  it("wires approve_merge_policy card approve button to merge execution mutation", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("approve_merge_policy");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("approve_merge_policy not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        branchId: "main",
        sourceBranchId: "branch_alt",
        targetBranchId: "main",
        policy: "prefer_target_on_conflict",
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(mutationSpyRegistry.get("narrativeGit:applyMergePolicy")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:createTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:resolveTask")?.calls.length).toBe(1);
  });

  it("wires select_agent_team card approve button to assignment mutation", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("select_agent_team");
    expect(hitl).toBeDefined();
    if (!hitl) {
      throw new Error("select_agent_team not registered");
    }

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        teamId: "continuity_first",
        revisionId: "continuity_first:v1",
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    expect(mutationSpyRegistry.get("agentTeams:assignTeamToStoryboard")?.calls.length).toBe(1);
  });

  // ===========================================================================
  // M9.5 L3 — bridge scenarios for the 5 M9 HITL cards
  // ===========================================================================
  //
  // Each scenario follows the existing pattern:
  //   1. mount the bridge → resolve the registered HITL handler
  //   2. invoke render() with synthetic agent args
  //   3. simulate Approve (or Edit / Reject) on the rendered card
  //   4. assert the mutation chain spy registered the right calls
  //
  // What we're testing: the BRIDGE↔CONVEX contract. The agent side is
  // covered by the L2 routing tests in storyboard-agent/tests/. The
  // panel-level UX (NarrativeBar drag, MotifMapPanel form, Variant
  // Compare promote) is in dedicated integration test files.

  it("wires request_beat_assignment approve button to setNodeNarrativeFields + upsertBeatPlan chain", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("request_beat_assignment");
    expect(hitl).toBeDefined();
    if (!hitl) throw new Error("request_beat_assignment not registered");

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        storyboardId: "storyboard_1",
        branchId: "main",
        structure: "save_the_cat",
        assignments: [
          { nodeId: "node_1", beatKey: "opening_image", actNumber: 1 },
          { nodeId: "node_2", beatKey: "catalyst", actNumber: 1 },
        ],
        rationale: "Producer asked for a beat pass.",
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    // Two assignments → two setNodeNarrativeFields calls in order;
    // then exactly one upsertBeatPlan that replaces the row.
    const fieldsSpy = mutationSpyRegistry.get("narrativeState:setNodeNarrativeFields");
    expect(fieldsSpy?.calls.length).toBe(2);
    expect(fieldsSpy?.calls[0]?.nodeId).toBe("node_1");
    expect(fieldsSpy?.calls[0]?.beatType).toBe("opening_image");
    expect(fieldsSpy?.calls[1]?.nodeId).toBe("node_2");
    expect(fieldsSpy?.calls[1]?.beatType).toBe("catalyst");

    const planSpy = mutationSpyRegistry.get("narrativeState:upsertBeatPlan");
    expect(planSpy?.calls.length).toBe(1);
    expect(planSpy?.calls[0]?.structure).toBe("save_the_cat");
    expect(planSpy?.calls[0]?.branchId).toBe("main");
    const beats = planSpy?.calls[0]?.beats as Array<Record<string, unknown>>;
    expect(Array.isArray(beats)).toBe(true);
    expect(beats.length).toBe(2);
    expect(beats[0]?.status).toBe("assigned");
  });

  it("wires request_hook_variants approve button to createBranch + commitPlanOps + upsertVariant per variant", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("request_hook_variants");
    expect(hitl).toBeDefined();
    if (!hitl) throw new Error("request_hook_variants not registered");

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        storyboardId: "storyboard_1",
        parentBranchId: "main",
        variantCount: 3,
        rationale: "Three short-form cold opens.",
        variants: [
          {
            variantId: "question",
            rationale: "Open on an unanswered question.",
            expectedRetention: "high",
            branchName: "Hook variant question",
            planOps: [
              {
                op: "create_node",
                title: "Question hook shot",
                rationale: "Provoke curiosity.",
              },
            ],
          },
          {
            variantId: "stakes",
            rationale: "Reveal the threat up front.",
            expectedRetention: "high",
            branchName: "Hook variant stakes",
            planOps: [
              {
                op: "create_node",
                title: "Stakes hook shot",
                rationale: "Worst-case reveal.",
              },
            ],
          },
          {
            variantId: "rhyme",
            rationale: "Match-cut into act 1.",
            expectedRetention: "experimental",
            branchName: "Hook variant rhyme",
            planOps: [
              {
                op: "create_node",
                title: "Visual rhyme hook",
                rationale: "Match cut.",
              },
            ],
          },
        ],
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    expect(responses[0]?.variantType).toBe("hook");
    // 3 variants × full chain — createBranch, commitPlanOps,
    // upsertVariant each fire 3 times.
    expect(mutationSpyRegistry.get("narrativeGit:createBranch")?.calls.length).toBe(3);
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(3);
    expect(mutationSpyRegistry.get("narrativeState:upsertVariant")?.calls.length).toBe(3);

    // Branch ids follow the variant/hook-<id> convention.
    const branchSpy = mutationSpyRegistry.get("narrativeGit:createBranch");
    const branchIds = branchSpy?.calls.map((c) => c.branchId);
    expect(branchIds).toEqual([
      "variant/hook-question",
      "variant/hook-stakes",
      "variant/hook-rhyme",
    ]);

    // Each variant marked as type="hook" so listVariants can group.
    const variantSpy = mutationSpyRegistry.get("narrativeState:upsertVariant");
    for (const call of variantSpy?.calls ?? []) {
      expect(call.variantType).toBe("hook");
      expect(call.parentBranchId).toBe("main");
    }
  });

  it("wires request_structural_remix approve button to the same chain with variantType=remix", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("request_structural_remix");
    expect(hitl).toBeDefined();
    if (!hitl) throw new Error("request_structural_remix not registered");

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        storyboardId: "storyboard_1",
        parentBranchId: "main",
        targetStructure: "harmon_circle",
        variantCount: 2,
        rationale: "Reframe to Harmon circle.",
        variants: [
          {
            variantId: "in-medias-res",
            strategy: "in_medias_res",
            rationale: "Open mid-act-2.",
            branchName: "Remix harmon_circle in-medias-res",
            planOps: [
              {
                op: "update_node",
                title: "Reorder n1 to act 2 midpoint",
                nodeId: "node_1",
              },
            ],
          },
          {
            variantId: "harmon-reframe",
            strategy: "harmon_reframe",
            rationale: "Strict 8-beat circle.",
            branchName: "Remix harmon_circle harmon-reframe",
            planOps: [
              {
                op: "update_node",
                title: "Move catalyst to circle beat 'go'",
                nodeId: "node_2",
              },
            ],
          },
        ],
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    expect(responses[0]?.variantType).toBe("remix");
    expect(mutationSpyRegistry.get("narrativeGit:createBranch")?.calls.length).toBe(2);
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(2);
    expect(mutationSpyRegistry.get("narrativeState:upsertVariant")?.calls.length).toBe(2);
    // Remix branch ids follow the variant/remix-<structure>-<id> convention.
    const branchIds = mutationSpyRegistry
      .get("narrativeGit:createBranch")
      ?.calls.map((c) => c.branchId);
    expect(branchIds).toEqual([
      "variant/remix-harmon_circle-in-medias-res",
      "variant/remix-harmon_circle-harmon-reframe",
    ]);
    // variantType normalised to "remix" for narrativeVariants table.
    const variantTypes = mutationSpyRegistry
      .get("narrativeState:upsertVariant")
      ?.calls.map((c) => c.variantType);
    expect(variantTypes).toEqual(["remix", "remix"]);
  });

  it("wires request_transition_proposal approve button to setEdgeTransitionIntent (selecting the rank-1 proposal by default)", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    // The graph has edge e1 from node_1 → node_2; the bridge looks up
    // by (source, target) so we drive the agent payload with those ids.
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("request_transition_proposal");
    expect(hitl).toBeDefined();
    if (!hitl) throw new Error("request_transition_proposal not registered");

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        storyboardId: "storyboard_1",
        branchId: "main",
        sourceNodeId: "node_1",
        targetNodeId: "node_2",
        proposalCount: 2,
        rationale: "Producer asked for transitions.",
        proposals: [
          {
            intent: "match_cut",
            rationale: "Crimson umbrella bridges the cut.",
            sharedElement: "crimson umbrella",
            rank: 1,
          },
          {
            intent: "j_cut",
            rationale: "Audio leads picture.",
            rank: 2,
          },
        ],
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    expect(responses[0]?.selectedIntent).toBe("match_cut");
    expect(responses[0]?.edgeId).toBe("e1");

    const intentSpy = mutationSpyRegistry.get("narrativeState:setEdgeTransitionIntent");
    expect(intentSpy?.calls.length).toBe(1);
    expect(intentSpy?.calls[0]?.edgeId).toBe("e1");
    expect(intentSpy?.calls[0]?.transitionIntent).toBe("match_cut");

    // Approval task still gets created so the audit trail records the pick.
    expect(mutationSpyRegistry.get("approvals:createTask")?.calls.length).toBe(1);
    expect(mutationSpyRegistry.get("approvals:resolveTask")?.calls.length).toBe(1);
  });

  it("wires request_motif_plant approve button to upsertMotif with derived landedStatus", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("request_motif_plant");
    expect(hitl).toBeDefined();
    if (!hitl) throw new Error("request_motif_plant not registered");

    const responses: Record<string, unknown>[] = [];
    // Plant motif at node_1 (source) with a payoff at node_2 already
    // declared → derived landedStatus is "landed" (both arrays
    // populated). Mirrors detect_motif_gaps on the agent side.
    const card = hitl.render({
      status: "executing",
      args: {
        storyboardId: "storyboard_1",
        branchId: "main",
        motifKey: "red-umbrella",
        targetNodeId: "node_1",
        description: "Recurring crimson umbrella.",
        visualVocabulary: "crimson fabric, rain-beaded",
        sourceNodeIds: ["node_1"],
        payoffNodeIds: ["node_2"],
        planOps: [
          {
            op: "update_node",
            title: "Plant red umbrella at node_1",
            nodeId: "node_1",
          },
        ],
        rationale: "Land setup + payoff in one pass.",
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Approve"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(true);
    expect(responses[0]?.motifKey).toBe("red-umbrella");
    expect(responses[0]?.landedStatus).toBe("landed");

    // commitPlanOps fires once for the planOps; upsertMotif fires once.
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(1);
    const motifSpy = mutationSpyRegistry.get("narrativeState:upsertMotif");
    expect(motifSpy?.calls.length).toBe(1);
    expect(motifSpy?.calls[0]?.motifKey).toBe("red-umbrella");
    expect(motifSpy?.calls[0]?.landedStatus).toBe("landed");
    expect(motifSpy?.calls[0]?.sourceNodeIds).toEqual(["node_1"]);
    expect(motifSpy?.calls[0]?.payoffNodeIds).toEqual(["node_2"]);
    expect(motifSpy?.calls[0]?.visualVocabulary).toBe(
      "crimson fabric, rain-beaded",
    );
  });

  it("wires request_motif_plant reject button to no mutations + blockedReason", async () => {
    const { StoryboardCopilotBridge } = await import("@/components/storyboard/StoryboardCopilotBridge");
    const { nodes, edges } = createGraph();

    render(
      <StoryboardCopilotBridge
        storyboardId="storyboard_1"
        nodes={nodes}
        edges={edges}
        approvals={[]}
        mode="graph_studio"
        runtimeResolvedTeam={runtimeTeam}
        userIdentity={null}
      />,
    );

    const hitl = hitlRegistry.get("request_motif_plant");
    if (!hitl) throw new Error("request_motif_plant not registered");

    const responses: Record<string, unknown>[] = [];
    const card = hitl.render({
      status: "executing",
      args: {
        storyboardId: "storyboard_1",
        branchId: "main",
        motifKey: "red-umbrella",
        targetNodeId: "node_1",
        description: "x",
        visualVocabulary: "x",
        sourceNodeIds: ["node_1"],
        payoffNodeIds: [],
        planOps: [],
        rationale: "x",
      },
      respond: (payload) => {
        responses.push(payload);
      },
    });

    const cardView = render(card);
    fireEvent.click(cardView.getByText("Reject"));

    await waitFor(() => {
      expect(responses.length).toBe(1);
    });

    expect(responses[0]?.approved).toBe(false);
    expect(typeof responses[0]?.blockedReason).toBe("string");
    // No mutations on reject — the audit trail records the blocked
    // decision via toolAudits, not via the motif registry.
    expect(mutationSpyRegistry.get("narrativeState:upsertMotif")?.calls.length).toBe(0);
    expect(mutationSpyRegistry.get("narrativeGit:commitPlanOps")?.calls.length).toBe(0);
  });
});
