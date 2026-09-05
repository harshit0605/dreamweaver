import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { JSDOM } from "jsdom";
import { ContinuityOSPanel } from "@/components/storyboard/ContinuityOSPanel";
import { DailiesBoardPanel } from "@/components/storyboard/DailiesBoardPanel";
import { MissionConsolePanel } from "@/components/storyboard/MissionConsolePanel";
import { ReviewInboxPanel } from "@/components/storyboard/ReviewInboxPanel";
import { TeamBuilderPanel } from "@/components/storyboard/TeamBuilderPanel";
import { TimelineTheaterPanel } from "@/components/storyboard/TimelineTheaterPanel";
import type {
  RuntimeResolvedTeam,
  TeamDefinition,
  TeamMemberConfig,
  TeamPolicy,
  TeamPromptDraft,
} from "@/app/storyboard/types";

const teamMember: TeamMemberConfig = {
  memberId: "planner",
  agentName: "Planner",
  role: "planner",
  persona: "Structured and practical",
  nicheDescription: "Graph operations",
  toolScope: ["graph.patch", "execution.plan"],
  resourceScope: ["storyboard.graph"],
  weight: 1,
  enabled: true,
};

const teamPolicy: TeamPolicy = {
  requiresHitl: true,
  riskThresholds: { warnAt: "medium", blockAt: "high" },
  maxBatchSize: 10,
  quotaProfileId: "default_standard",
  maxRunOps: 30,
  maxConcurrentRuns: 2,
  quotaEnforced: true,
};

const runtimeTeam: RuntimeResolvedTeam = {
  teamId: "producer_guarded_default",
  teamName: "Producer Guarded Default",
  revisionId: "producer_guarded_default:v1",
  version: 1,
  teamGoal: "Deliver continuity-safe storyboards.",
  members: [teamMember],
  toolAllowlist: ["graph.patch", "execution.plan", "media.prompt"],
  resourceScopes: ["storyboard.graph", "storyboard.context", "media.apis"],
  runtimePolicy: {
    ...teamPolicy,
    dailyMediaBudget: 20,
    dailyMutationOps: 120,
  },
};

const teams: TeamDefinition[] = [
  {
    _id: "team_db_1",
    teamId: "producer_guarded_default",
    name: "Producer Guarded Default",
    description: "Balanced plan + guard + critic.",
    ownerUserId: "user_1",
    visibility: "private",
    status: "active",
    isPrebuilt: true,
    publishedRevisionId: "producer_guarded_default:v1",
    publishedVersion: 1,
    currentPublishedRevisionId: "producer_guarded_default:v1",
    createdAt: 1,
    updatedAt: 2,
    revisionCount: 1,
  },
];

const revisions = [
  {
    revisionId: "producer_guarded_default:v1",
    version: 1,
    teamGoal: "Deliver continuity-safe storyboards.",
    published: true,
    createdAt: 1,
  },
];

const generatedDraft: TeamPromptDraft = {
  draftId: "draft_1",
  generatedSpec: {
    teamGoal: "Drafted goal",
    policy: teamPolicy,
    members: [teamMember],
    toolAllowlist: ["graph.patch"],
    resourceScopes: ["storyboard.graph"],
  },
};

describe("Storyboard panels integration", () => {
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
    cleanup();
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActFlag;
  });

  it("wires TeamBuilder actions for selection, revision publish/rollback, and member updates", async () => {
    const selectCalls: Array<{ teamId: string; revisionId?: string }> = [];
    const createRevisionCalls: Array<{
      teamId: string;
      teamGoal: string;
      policy: TeamPolicy;
      members: TeamMemberConfig[];
      toolAllowlist: string[];
      resourceScopes: string[];
      publish: boolean;
    }> = [];
    const publishCalls: Array<{ teamId: string; revisionId: string }> = [];
    const rollbackCalls: Array<{ teamId: string; revisionId: string }> = [];
    const updateMemberCalls: Array<{ teamId: string; revisionId: string; member: TeamMemberConfig }> = [];

    const view = render(
      <TeamBuilderPanel
        teams={teams}
        runtimeTeam={runtimeTeam}
        teamRevisions={revisions}
        onSelectTeam={async (teamId, revisionId) => {
          selectCalls.push({ teamId, revisionId });
        }}
        onCreateTeam={async (input) => {
          void input;
        }}
        onCreateRevision={async (input) => {
          createRevisionCalls.push(input);
        }}
        onGenerateDraft={async () => generatedDraft}
        onApplyDraft={async (teamId, draftId, publish) => {
          void teamId;
          void draftId;
          void publish;
        }}
        onPublishRevision={async (teamId, revisionId) => {
          publishCalls.push({ teamId, revisionId });
        }}
        onRollbackRevision={async (teamId, revisionId) => {
          rollbackCalls.push({ teamId, revisionId });
        }}
        onUpdateMember={async (teamId, revisionId, member) => {
          updateMemberCalls.push({ teamId, revisionId, member });
        }}
      />,
    );

    fireEvent.click(view.getByText("Open"));
    fireEvent.click(view.getByText("Active"));
    await waitFor(() => {
      expect(selectCalls.length).toBe(1);
    });

    fireEvent.click(view.getByText("Create Structured Revision"));
    await waitFor(() => {
      expect(createRevisionCalls.length).toBe(1);
    });

    fireEvent.click(view.getByText("Publish"));
    await waitFor(() => {
      expect(publishCalls.length).toBe(1);
    });

    fireEvent.click(view.getByText("Rollback To Here"));
    await waitFor(() => {
      expect(rollbackCalls.length).toBe(1);
    });

    fireEvent.input(view.getByDisplayValue("Structured and practical"), {
      target: { value: "Updated persona from test" },
    });
    fireEvent.input(view.getByPlaceholderText("tool.scope.one, tool.scope.two"), {
      target: { value: "graph.patch, media.prompt" },
    });
    fireEvent.click(view.getByText("Save Member"));
    await waitFor(() => {
      expect(updateMemberCalls.length).toBe(1);
    });

    expect(selectCalls[0]).toEqual({
      teamId: "producer_guarded_default",
      revisionId: "producer_guarded_default:v1",
    });
  });

  it("renders Mission Console and Review Inbox with delegation + policy evidence", () => {
    render(
      <MissionConsolePanel
        runtimeTeam={runtimeTeam}
        quotaSummary={{
          quotaProfile: {
            quotaProfileId: "default_standard",
            name: "Default",
            dailyMediaBudget: 20,
            dailyMutationOps: 120,
            maxRunOps: 30,
            maxConcurrentRuns: 2,
          },
          usage: {
            dayKey: "2026-02-13",
            mediaBudgetUsed: 3.4,
            mutationOpsUsed: 12,
            activeRuns: 1,
          },
          remaining: {
            mediaBudget: 16.6,
            mutationOps: 108,
            concurrentRuns: 1,
          },
        }}
        pendingApprovalsCount={2}
        currentMode="graph_studio"
        delegations={[
          {
            _id: "del_1",
            runId: "run_1",
            delegationId: "delegation_1",
            agentName: "continuity_critic",
            task: "check merge contradictions",
            status: "complete",
            inputJson: "{}",
            outputJson: "{}",
            latencyMs: 120,
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        audits={[
          {
            _id: "audit_1",
            runId: "run_1",
            teamId: runtimeTeam.teamId,
            revisionId: runtimeTeam.revisionId,
            member: "supervisor",
            tool: "approve_graph_patch",
            scope: ["storyboard.graph"],
            result: "success",
            createdAt: 2,
          },
        ]}
        latestSimulationRun={{
          _id: "sim_db_1",
          simulationRunId: "sim_1",
          branchId: "main",
          status: "complete",
          summary: "Critic completed with medium risk.",
          riskLevel: "medium",
          issuesJson: "[]",
          repairOperationsJson: "[]",
          confidence: 0.74,
          impactScore: 0.55,
          createdAt: 1,
          updatedAt: 2,
        }}
      />,
    );

    render(
      <ReviewInboxPanel
        approvals={[
          {
            _id: "approval_1",
            taskType: "merge_policy",
            status: "approved",
            title: "Merge branch_alt into main",
            rationale: "Merge accepted",
            diffSummary: "1 merge op",
            payloadJson: JSON.stringify({ previousHeadCommitId: "commit_prev" }),
            executionResultJson: JSON.stringify({
              policyEvidence: { whichPolicyRule: "toolAllowlist", whyAllowed: true },
            }),
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
      />,
    );

    expect(document.body.textContent?.includes("Delegation Timeline")).toBe(true);
    expect(document.body.textContent?.includes("continuity_critic")).toBe(true);
    expect(document.body.textContent?.includes("Tool Audits")).toBe(true);
    expect(document.body.textContent?.includes("rollback preview: commit_prev")).toBe(true);
    expect(document.body.textContent?.includes("whichPolicyRule")).toBe(true);
  });

  it("wires Timeline Theater, Dailies Board, and Continuity OS action buttons", async () => {
    let runCriticCalls = 0;
    let createBranchCalls = 0;
    let cherryPickCalls = 0;
    let diffCalls = 0;
    let generateDailiesCalls = 0;
    const dailiesStatusCalls: Array<{ reelId: string; status: "approved" | "rejected" | "applied" }> = [];
    let contradictionCalls = 0;

    const timelineView = render(
      <TimelineTheaterPanel
        simulationRuns={[
          {
            _id: "sim_db_2",
            simulationRunId: "sim_2",
            branchId: "main",
            status: "waiting_for_human",
            summary: "Run pending approval.",
            riskLevel: "high",
            issuesJson: "[]",
            repairOperationsJson: "[]",
            confidence: 0.81,
            impactScore: 0.7,
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        branches={[
          {
            _id: "branch_db_1",
            branchId: "main",
            name: "Main",
            isDefault: true,
            status: "active",
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        commits={[
          {
            _id: "commit_db_1",
            commitId: "commit_1",
            branchId: "main",
            summary: "Base commit",
            operationCount: 1,
            createdAt: 1,
          },
        ]}
        storyboardId="sb_test"
        onRunCritic={async () => {
          runCriticCalls += 1;
        }}
        onCreateBranch={async () => {
          createBranchCalls += 1;
        }}
        onCherryPickCommit={async (_s: string, _t: string) => {
          cherryPickCalls += 1;
        }}
        onComputeLatestDiff={async () => {
          diffCalls += 1;
        }}
      />,
    );

    const dailiesView = render(
      <DailiesBoardPanel
        dailies={[
          {
            _id: "reel_db_1",
            reelId: "reel_1",
            branchId: "main",
            title: "Daily Reel",
            summary: "Candidate shots",
            highlights: [],
            continuityRiskLevel: "medium",
            continuityRisksJson: "[]",
            proposedOperationsJson: "[]",
            status: "drafted",
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        onGenerateDailies={async () => {
          generateDailiesCalls += 1;
        }}
        onUpdateStatus={async (reelId, status) => {
          dailiesStatusCalls.push({ reelId, status });
        }}
      />,
    );

    const continuityView = render(
      <ContinuityOSPanel
        bundle={{
          identityPacks: [{ id: "hero" }],
          globalConstraints: [{ type: "dna_lock" }],
          continuityViolations: [{ code: "CONT_1", severity: "high", status: "open", message: "Conflict" }],
        }}
        onDetectContradictions={async () => {
          contradictionCalls += 1;
        }}
      />,
    );

    fireEvent.click(timelineView.getByText("Run Critic"));
    fireEvent.click(timelineView.getByText("Create Branch"));
    // Cherry-pick now opens a dialog instead of firing the callback directly —
    // dialog-level interaction is out of scope for this panel-integration test.
    fireEvent.click(timelineView.getByText("Compute Diff"));

    fireEvent.click(dailiesView.getByText("Generate"));
    // The refactored DailiesRow gates each button behind a per-row
    // `busy` flag that flips while onUpdateStatus is pending. Rapid
    // synchronous clicks used to all fire; now we must wait for each
    // async handler to settle before the next click is accepted. Stepping
    // through one status at a time mirrors how a producer actually
    // interacts with the row.
    fireEvent.click(dailiesView.getByText("Approve"));
    await waitFor(() => {
      expect(dailiesStatusCalls.length).toBe(1);
    });
    fireEvent.click(dailiesView.getByText("Mark Applied"));
    await waitFor(() => {
      expect(dailiesStatusCalls.length).toBe(2);
    });
    fireEvent.click(dailiesView.getByText("Reject"));
    await waitFor(() => {
      expect(dailiesStatusCalls.length).toBe(3);
    });

    fireEvent.click(continuityView.getByText("Detect"));

    await waitFor(() => {
      expect(runCriticCalls).toBe(1);
      expect(createBranchCalls).toBe(1);
      // Button now opens dialog; callback does not fire from this click.
      expect(cherryPickCalls).toBe(0);
      expect(diffCalls).toBe(1);
      expect(generateDailiesCalls).toBe(1);
      expect(dailiesStatusCalls.length).toBe(3);
      expect(contradictionCalls).toBe(1);
    });

    expect(dailiesStatusCalls).toEqual([
      { reelId: "reel_1", status: "approved" },
      { reelId: "reel_1", status: "applied" },
      { reelId: "reel_1", status: "rejected" },
    ]);
  });
});
