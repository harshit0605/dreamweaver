import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { JSDOM } from "jsdom";

type QueryArgs = Record<string, unknown> | "skip";
type MutationArgs = Record<string, unknown>;

const queryCalls = new Map<string, QueryArgs[]>();
const mutationCalls = new Map<string, MutationArgs[]>();
let routeStoryboardId = "sb_route_1";

const recordQuery = (key: string, args: QueryArgs) => {
  const calls = queryCalls.get(key) ?? [];
  calls.push(args);
  queryCalls.set(key, calls);
};

const recordMutation = (key: string, args: MutationArgs) => {
  const calls = mutationCalls.get(key) ?? [];
  calls.push(args);
  mutationCalls.set(key, calls);
};

mock.module("reactflow/dist/style.css", () => ({}));

mock.module("reactflow", () => {
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useNodesState: <T,>(initial: T[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => undefined] as const;
    },
    useEdgesState: <T,>(initial: T[]) => {
      const [state, setState] = React.useState(initial);
      return [state, setState, () => undefined] as const;
    },
    addEdge: <T,>(edge: T, list: T[]) => [...list, edge],
  };
});

mock.module("next/navigation", () => ({
  useParams: () => ({ storyboardId: routeStoryboardId }),
  // Components downstream of the editor route (StoryboardCopilotBridge,
  // ReelPlayer, etc.) call useRouter() at mount; without a stub it
  // throws 'invariant expected app router to be mounted' from
  // next/navigation. Stubbing only the methods actually exercised keeps
  // the mock minimal; extend as needed for future callers.
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
}));

mock.module("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "user_1" } },
      isPending: false,
    }),
  },
}));

// Convex useQuery must return a STABLE reference across calls for any
// given key — production Convex memoizes by query args; when the
// result doesn't change, the same object identity is returned so
// dependent useEffects don't re-fire. If the mock returned a fresh
// object literal on every render, page.tsx's `useEffect(... snapshot)`
// would call setNodes/setEdges every render and spin into a
// "Maximum update depth exceeded" loop. Caching by key here gives
// each query a persistent identity for the lifetime of a test.
const queryResultCache = new Map<string, unknown>();

const getStableQueryResult = (key: string): unknown => {
  if (queryResultCache.has(key)) return queryResultCache.get(key);
  let value: unknown;
  if (key === "storyboards:getStoryboardSnapshot") {
    value = {
      storyboard: {
        _id: routeStoryboardId,
        title: "Route Storyboard",
        updatedAt: Date.now() - 20_000,
      },
      nodes: [],
      edges: [],
      approvals: [],
    };
  } else if (
    key === "approvals:listForStoryboard"
    || key === "narrativeGit:listDelegations"
    || key === "toolAudits:listForStoryboard"
    || key === "dailies:listAutonomousDailies"
    || key === "dailies:listSimulationRuns"
    || key === "narrativeGit:listBranches"
    || key === "narrativeGit:listBranchCommits"
  ) {
    value = [];
  } else if (key === "continuityOS:listConstraintBundle") {
    value = { continuityViolations: [] };
  } else if (key === "agentTeams:listTeams") {
    value = [];
  } else if (key === "agentTeams:resolveEffectiveRuntimeConfig") {
    value = null;
  } else if (key === "quotas:getUsageSummary") {
    value = null;
  } else {
    value = undefined;
  }
  queryResultCache.set(key, value);
  return value;
};

mock.module("convex/react", () => ({
  useQuery: (ref: unknown, args: QueryArgs) => {
    const key = String(ref);
    recordQuery(key, args);
    if (args === "skip") {
      return undefined;
    }
    return getStableQueryResult(key);
  },
  useMutation: (ref: unknown) => {
    const key = String(ref);
    return async (args: MutationArgs) => {
      recordMutation(key, args);
      if (key === "approvals:createTask") {
        return "task_1";
      }
      return null;
    };
  },
}));

mock.module("@/components/storyboard/StoryGraph", () => ({
  __esModule: true,
  default: () => <div data-testid="story-graph" />,
}));

mock.module("@/components/storyboard/ChatPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="chat-panel" />,
}));

mock.module("@/components/storyboard/PropertiesPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="properties-panel" />,
}));

mock.module("@/components/storyboard/CanvasToolbar", () => ({
  __esModule: true,
  default: () => <div data-testid="canvas-toolbar" />,
}));

mock.module("@/components/storyboard/StoryboardCopilotBridge", () => ({
  StoryboardCopilotBridge: () => <div data-testid="copilot-bridge" />,
}));

mock.module("@/components/storyboard/OutlinePanel", () => ({
  OutlinePanel: () => <div data-testid="outline-panel" />,
}));

mock.module("@/components/storyboard/ProductionHubDrawer", () => ({
  ProductionHubDrawer: () => <div data-testid="production-drawer" />,
}));

import StoryboardEditorRoutePage from "@/app/storyboard/[storyboardId]/page";

describe("Storyboard editor route persistence wiring", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalActFlag = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/storyboard/sb_route_1",
    });
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, "getComputedStyle", {
      value: dom.window.getComputedStyle.bind(dom.window),
      configurable: true,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
      configurable: true,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      value: (id: number) => clearTimeout(id),
      configurable: true,
    });
    routeStoryboardId = "sb_route_1";
    queryCalls.clear();
    mutationCalls.clear();
    // Clear the stable-identity cache between tests so a different
    // routeStoryboardId / different fixture doesn't leak across cases.
    queryResultCache.clear();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    cleanup();
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
    Object.defineProperty(globalThis, "getComputedStyle", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "requestAnimationFrame", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { value: undefined, configurable: true });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActFlag;
  });

  it("uses route param storyboardId for snapshot query and touch mutation", async () => {
    const view = render(<StoryboardEditorRoutePage />);
    expect(view.getByTestId("story-graph")).toBeTruthy();

    await waitFor(() => {
      const snapshotCalls = queryCalls.get("storyboards:getStoryboardSnapshot") ?? [];
      expect(snapshotCalls.length).toBeGreaterThan(0);
      expect(snapshotCalls[0]).toMatchObject({ storyboardId: "sb_route_1" });
    });

    await waitFor(() => {
      const touchCalls = mutationCalls.get("storyboards:touchStoryboardOpened") ?? [];
      expect(touchCalls.length).toBe(1);
      expect(touchCalls[0]).toMatchObject({ storyboardId: "sb_route_1" });
    });
  });
});
