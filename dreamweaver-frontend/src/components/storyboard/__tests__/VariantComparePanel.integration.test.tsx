/**
 * M9.5 L3 — VariantComparePanel integration test.
 *
 * Pinned behaviors:
 *   * Empty state when no variants are present (renders an empty
 *     panel header with hint copy, NOT null — producers need to know
 *     where to invoke the agent).
 *   * Variants grouped by type (hook / structural / remix /
 *     transition) with section headers + per-row badge.
 *   * Compare-pair toggle: clicking "Compare" on a variant calls
 *     onToggleCompareBranch with that branchId.
 *   * Clicking "Pick" calls onPromoteVariant with the row's record.
 *   * Producer-picked rows show the "Primary" badge + suppress the
 *     Compare/Pick buttons.
 *   * Archived branches' variant rows are hidden (the merge cleanup
 *     path archives losers; they should not clutter Variant Compare).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
} from "@testing-library/react";
import { JSDOM } from "jsdom";
import { VariantComparePanel } from "@/components/storyboard/VariantComparePanel";
import type {
  NarrativeBranchRecord,
  NarrativeVariantRecord,
} from "@/app/storyboard/types";

const buildBranch = (
  branchId: string,
  overrides: Partial<NarrativeBranchRecord> = {},
): NarrativeBranchRecord => ({
  _id: `b_${branchId}`,
  branchId,
  name: branchId.replace("/", " "),
  isDefault: false,
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const buildVariant = (
  branchId: string,
  overrides: Partial<NarrativeVariantRecord> = {},
): NarrativeVariantRecord => ({
  _id: `v_${branchId}`,
  branchId,
  variantType: "hook",
  rationale: `Rationale for ${branchId}`,
  producerPicked: false,
  parentBranchId: "main",
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

describe("VariantComparePanel — empty state", () => {
  it("renders empty hint when no variants exist", () => {
    const view = render(
      <VariantComparePanel
        variants={[]}
        branches={[]}
        compareBranchIds={[]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async () => {}}
      />,
    );
    // Empty state guides producers to the agent surface.
    expect(view.getByText("Variant Compare")).toBeTruthy();
    expect(view.getByText(/3 cold-open variants/)).toBeTruthy();
    expect(view.getByText(/structural remix/)).toBeTruthy();
  });
});

describe("VariantComparePanel — listing + grouping", () => {
  it("groups variants by variantType with each group's count visible", () => {
    const variants = [
      buildVariant("variant/hook-question", { variantType: "hook" }),
      buildVariant("variant/hook-stakes", { variantType: "hook" }),
      buildVariant("variant/remix-harmon-1", { variantType: "remix" }),
    ];
    const branches = [
      buildBranch("variant/hook-question", { name: "Hook variant question" }),
      buildBranch("variant/hook-stakes", { name: "Hook variant stakes" }),
      buildBranch("variant/remix-harmon-1", { name: "Remix Harmon" }),
    ];
    const view = render(
      <VariantComparePanel
        variants={variants}
        branches={branches}
        compareBranchIds={[]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async () => {}}
      />,
    );
    // 3 visible candidates.
    expect(view.getByText(/3 candidates/)).toBeTruthy();
    // Group headers
    expect(view.getByText("Cold-open hooks")).toBeTruthy();
    expect(view.getByText("Beat remixes")).toBeTruthy();
    // Each branch shows its name in the row.
    expect(view.getByText("Hook variant question")).toBeTruthy();
    expect(view.getByText("Hook variant stakes")).toBeTruthy();
    expect(view.getByText("Remix Harmon")).toBeTruthy();
  });

  it("hides variants whose branch is archived", () => {
    const variants = [
      buildVariant("variant/hook-question"),
      buildVariant("variant/hook-stakes"),
    ];
    const branches = [
      buildBranch("variant/hook-question"),
      // Sibling lost a merge race — was archived. Variant Compare
      // shouldn't surface it; the producer already moved on.
      buildBranch("variant/hook-stakes", { status: "archived" }),
    ];
    const view = render(
      <VariantComparePanel
        variants={variants}
        branches={branches}
        compareBranchIds={[]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async () => {}}
      />,
    );
    expect(view.getByText(/1 candidate/)).toBeTruthy();
    // The archived sibling's branch ID does NOT appear in the panel.
    expect(view.queryByText(/variant\/hook-stakes/)).toBeNull();
  });
});

describe("VariantComparePanel — compare pair toggle", () => {
  it("calls onToggleCompareBranch with the branchId when Compare is clicked", () => {
    const toggled: string[] = [];
    const view = render(
      <VariantComparePanel
        variants={[buildVariant("variant/hook-question")]}
        branches={[buildBranch("variant/hook-question")]}
        compareBranchIds={[]}
        onToggleCompareBranch={(id) => toggled.push(id)}
        onPromoteVariant={async () => {}}
      />,
    );
    fireEvent.click(view.getByText("Compare"));
    expect(toggled).toEqual(["variant/hook-question"]);
  });

  it("renders the active state when a branch is in the compare pair", () => {
    const view = render(
      <VariantComparePanel
        variants={[buildVariant("variant/hook-question")]}
        branches={[buildBranch("variant/hook-question")]}
        compareBranchIds={["variant/hook-question"]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async () => {}}
      />,
    );
    // When pinned, the button label flips so the producer can see
    // which slot they'd evict on a re-click.
    expect(view.getByText("Comparing")).toBeTruthy();
  });

  it("renders the compare-slots header when at least one branch is pinned", () => {
    const view = render(
      <VariantComparePanel
        variants={[buildVariant("variant/hook-question")]}
        branches={[buildBranch("variant/hook-question")]}
        compareBranchIds={["variant/hook-question"]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async () => {}}
      />,
    );
    expect(view.getByText("Comparing 1 / 2 slots")).toBeTruthy();
  });
});

describe("VariantComparePanel — promote / pick", () => {
  it("calls onPromoteVariant with the variant record when Pick is clicked", async () => {
    const picks: NarrativeVariantRecord[] = [];
    const variant = buildVariant("variant/hook-question", {
      variantType: "hook",
    });
    const view = render(
      <VariantComparePanel
        variants={[variant]}
        branches={[buildBranch("variant/hook-question")]}
        compareBranchIds={[]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async (v) => {
          picks.push(v);
        }}
      />,
    );
    fireEvent.click(view.getByText("Pick"));
    // Direct call — no async wait needed.
    expect(picks.length).toBe(1);
    expect(picks[0]?.branchId).toBe("variant/hook-question");
    expect(picks[0]?.variantType).toBe("hook");
  });

  it("hides Compare/Pick buttons on producer-picked rows + shows Primary badge", () => {
    const view = render(
      <VariantComparePanel
        variants={[
          buildVariant("variant/hook-question", { producerPicked: true }),
        ]}
        branches={[buildBranch("variant/hook-question")]}
        compareBranchIds={[]}
        onToggleCompareBranch={() => {}}
        onPromoteVariant={async () => {}}
      />,
    );
    expect(view.getByText("Primary")).toBeTruthy();
    expect(view.queryByText("Pick")).toBeNull();
    expect(view.queryByText("Compare")).toBeNull();
  });
});
