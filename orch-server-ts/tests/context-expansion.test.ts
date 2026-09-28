import { describe, expect, it } from "vitest";

import {
  expandAtomContexts,
  type AgentProfileRecord,
  type ContextBundleRecord,
} from "../src/index.js";

describe("expandAtomContexts", () => {
  it("preserves bundle reference order, entry order, and profile contexts", () => {
    const firstContext = { node_id: "11111111-2222-3333-4444-555555555555" };
    const secondContext = { node_id: "21111111-2222-3333-4444-555555555555" };
    const ownContext = { node_id: "31111111-2222-3333-4444-555555555555" };
    const profile = {
      contextBundles: ["second", "first"],
      atomContexts: [ownContext],
    } as Pick<AgentProfileRecord, "contextBundles" | "atomContexts">;
    const bundle = (bundleId: string, atomContexts: ContextBundleRecord["atomContexts"]): ContextBundleRecord => ({
      bundleId,
      description: "",
      atomContexts,
      version: 1,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    const bundles = new Map<string, ContextBundleRecord>([
      ["first", bundle("first", [{ node_id: "41111111-2222-3333-4444-555555555555" }, firstContext])],
      ["second", bundle("second", [secondContext])],
    ]);

    expect(expandAtomContexts(profile, bundles)).toEqual([
      secondContext,
      { node_id: "41111111-2222-3333-4444-555555555555" },
      firstContext,
      ownContext,
    ]);
    expect(profile.contextBundles).toEqual(["second", "first"]);
  });
});
