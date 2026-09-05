/**
 * M9.5 L3 — MotifMapPanel render + interaction integration test.
 *
 * Pinned behaviors:
 *   * Empty registry without form props returns null (no panel chrome).
 *   * Panel chrome renders when motifs are present.
 *   * "Plant motif" toggle opens an inline form with the expected
 *     fields (key, role, target, description, visual vocabulary).
 *   * Cancel toggles the form closed without dispatching anything.
 *   * Source/payoff node-chip clicks call onFocusNode.
 *   * Incomplete motifs surface "no plant" / "no payoff" badges.
 *
 * Form-data submission is NOT exercised here — bun-test + jsdom +
 * React 19 controlled inputs don't propagate `fireEvent.change`
 * deterministically for our text inputs in this environment. The
 * form's submit chain is end-to-end-tested via:
 *   * Bridge integration test for `request_motif_plant` (the agent
 *     path that drops into the same upsertMotif mutation).
 *   * The L1 unit test on `lib/narrative/motif-status.ts` covers
 *     the derived `landedStatus` rules.
 *   * Playwright L6 `director-transitions-motifs.spec.ts` exercises
 *     the form against real Convex.
 *
 * Sort order is exercised via `lib/narrative/__tests__/motif-status.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
} from "@testing-library/react";
import { JSDOM } from "jsdom";
import { MotifMapPanel } from "@/components/storyboard/MotifMapPanel";
import type {
  NarrativeMotifRecord,
  StoryNode,
  StoryNodeData,
} from "@/app/storyboard/types";

const buildShot = (id: string, label: string): StoryNode => {
  const data: StoryNodeData = {
    label,
    segment: "x",
    nodeType: "shot",
    entityRefs: { characterIds: [] },
    continuity: {
      identityLockVersion: 1,
      wardrobeVariantIds: [],
      consistencyStatus: "ok",
    },
    historyContext: {
      eventIds: [],
      rollingSummary: "",
      tokenBudgetUsed: 0,
      lineageHash: "ln",
    },
    promptPack: { continuityDirectives: [] },
    media: { images: [], videos: [] },
  };
  return { id, type: "custom", position: { x: 0, y: 0 }, data };
};

const buildMotif = (
  motifKey: string,
  overrides: Partial<NarrativeMotifRecord> = {},
): NarrativeMotifRecord => ({
  _id: `m_${motifKey}`,
  motifKey,
  description: `Description for ${motifKey}`,
  sourceNodeIds: [],
  payoffNodeIds: [],
  visualVocabulary: undefined,
  landedStatus: "unplanted",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

let originalWindow: typeof globalThis.window | undefined;
let originalDocument: typeof globalThis.document | undefined;
let originalNavigator: typeof globalThis.navigator | undefined;
let originalActFlag: unknown;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  originalNavigator = globalThis.navigator;
  originalActFlag = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: originalDocument,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
  });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActFlag;
});

describe("MotifMapPanel — render conditions", () => {
  it("returns null when no motifs and no plant form", () => {
    const view = render(<MotifMapPanel motifs={[]} />);
    // Panel hides entirely on pre-M9 storyboards.
    expect(view.container.firstChild).toBeNull();
  });

  it("renders panel chrome when motifs present even without form props", () => {
    const view = render(
      <MotifMapPanel motifs={[buildMotif("red-umbrella")]} />,
    );
    expect(view.getByText(/1 motif/)).toBeTruthy();
    // Plant form is gated on form props; without them it's hidden.
    expect(view.queryByText(/^Plant motif$/)).toBeNull();
  });

  it("renders 'Plant motif' button when form props supplied", () => {
    const view = render(
      <MotifMapPanel
        motifs={[]}
        shotNodes={[buildShot("n1", "Opening")]}
        onPlantMotif={async () => {}}
      />,
    );
    expect(view.getByText("Plant motif")).toBeTruthy();
    // Empty-state copy guides the producer.
    expect(view.getByText(/No motifs yet/)).toBeTruthy();
  });

  it("groups motifs and renders status badges for each landed bucket", () => {
    const view = render(
      <MotifMapPanel
        motifs={[
          buildMotif("landed", {
            sourceNodeIds: ["n3"],
            payoffNodeIds: ["n18"],
          }),
          buildMotif("planted-only", { sourceNodeIds: ["n5"] }),
          buildMotif("orphaned-only", { payoffNodeIds: ["n22"] }),
        ]}
      />,
    );
    // Status badges + group labels surface each bucket. "orphaned"
    // can appear twice (header chip + row badge) so use getAllByText
    // for the multi-match cases.
    expect(view.getAllByText("landed").length).toBeGreaterThan(0);
    expect(view.getAllByText("planted").length).toBeGreaterThan(0);
    expect(view.getAllByText("orphaned").length).toBeGreaterThan(0);
    // Header summarises gap counts.
    expect(view.getByText(/need payoff/)).toBeTruthy();
  });
});

describe("MotifMapPanel — Plant form toggle", () => {
  it("opens form on Plant click and closes on Cancel", () => {
    const view = render(
      <MotifMapPanel
        motifs={[]}
        shotNodes={[buildShot("n1", "Opening")]}
        onPlantMotif={async () => {}}
      />,
    );
    // Closed initially — submit button isn't in the DOM.
    expect(view.queryByRole("button", { name: "Plant" })).toBeNull();
    fireEvent.click(view.getByText("Plant motif"));
    // Form is open — Cancel + submit "Plant" button visible.
    expect(view.getByText("Cancel")).toBeTruthy();
    expect(view.getByRole("button", { name: "Plant" })).toBeTruthy();
    // Form has all expected fields by aria-label.
    expect(view.getByLabelText("Motif key (slug-cased)")).toBeTruthy();
    expect(view.getByLabelText("Motif role")).toBeTruthy();
    expect(view.getByLabelText("Target shot")).toBeTruthy();
    expect(view.getByLabelText("Motif description")).toBeTruthy();
    expect(view.getByLabelText("Visual vocabulary")).toBeTruthy();
    fireEvent.click(view.getByText("Cancel"));
    expect(view.queryByRole("button", { name: "Plant" })).toBeNull();
  });

  it("submit button is disabled on initial open (no key/description)", () => {
    const view = render(
      <MotifMapPanel
        motifs={[]}
        shotNodes={[buildShot("n1", "Opening")]}
        onPlantMotif={async () => {}}
      />,
    );
    fireEvent.click(view.getByText("Plant motif"));
    const submit = view.getByRole("button", { name: "Plant" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("target shot dropdown defaults to first shot in the list", () => {
    const view = render(
      <MotifMapPanel
        motifs={[]}
        shotNodes={[buildShot("n1", "Opening"), buildShot("n2", "Mid")]}
        onPlantMotif={async () => {}}
      />,
    );
    fireEvent.click(view.getByText("Plant motif"));
    const targetSelect = view.getByLabelText("Target shot") as HTMLSelectElement;
    // Producer should not have to pick — useState seeds with shotNodes[0].
    expect(targetSelect.value).toBe("n1");
  });

  it("role dropdown defaults to plant", () => {
    const view = render(
      <MotifMapPanel
        motifs={[]}
        shotNodes={[buildShot("n1", "Opening")]}
        onPlantMotif={async () => {}}
      />,
    );
    fireEvent.click(view.getByText("Plant motif"));
    const roleSelect = view.getByLabelText("Motif role") as HTMLSelectElement;
    expect(roleSelect.value).toBe("plant");
  });
});

describe("MotifMapPanel — node chip interactions", () => {
  it("renders 'no plant' / 'no payoff' badges for incomplete motifs", () => {
    const view = render(
      <MotifMapPanel
        motifs={[
          buildMotif("planted-only", { sourceNodeIds: ["n3"] }),
          buildMotif("orphaned-only", { payoffNodeIds: ["n18"] }),
        ]}
      />,
    );
    expect(view.getByText("no payoff")).toBeTruthy();
    expect(view.getByText("no plant")).toBeTruthy();
  });

  it("calls onFocusNode when a source or payoff chip is clicked", () => {
    const focused: string[] = [];
    const view = render(
      <MotifMapPanel
        motifs={[
          buildMotif("red-umbrella", {
            sourceNodeIds: ["n3"],
            payoffNodeIds: ["n18"],
          }),
        ]}
        onFocusNode={(id) => focused.push(id)}
      />,
    );
    // Click the source chip then the payoff chip — both delegate to
    // the same focus callback.
    fireEvent.click(view.getByTitle("Focus n3"));
    fireEvent.click(view.getByTitle("Focus n18"));
    expect(focused).toEqual(["n3", "n18"]);
  });

  it("renders visualVocabulary when present", () => {
    const view = render(
      <MotifMapPanel
        motifs={[
          buildMotif("red-umbrella", {
            sourceNodeIds: ["n3"],
            visualVocabulary: "crimson fabric, rain-beaded, gray sky",
          }),
        ]}
      />,
    );
    expect(view.getByText(/crimson fabric, rain-beaded/)).toBeTruthy();
  });
});
