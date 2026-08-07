import { describe, expect, it } from "vitest";

import { allocateContextBudget } from "../../src/context/compiler/budget.js";

const limits = {
  categories: {
    guidance: 8_000,
    atom_ref: 52_000,
    session_defaults: 0,
  },
  total: 60_000,
};

describe("context compiler budget", () => {
  it("cuts lower priority entries first", () => {
    const result = allocateContextBudget({
      limits: {
        categories: { ...limits.categories, guidance: 4 },
        total: 4,
      },
      entries: [
        {
          id: "low",
          category: "guidance",
          content: "low!",
          priority: 1,
          neverTruncate: false,
        },
        {
          id: "high",
          category: "guidance",
          content: "HIGH",
          priority: 10,
          neverTruncate: false,
        },
      ],
    });

    expect(result.entries.find((entry) => entry.id === "high")?.content).toBe("HIGH");
    expect(result.entries.find((entry) => entry.id === "low")?.content).toBeNull();
  });

  it("protects never_truncate entries even when they exceed the nominal budget", () => {
    const result = allocateContextBudget({
      limits: {
        categories: { ...limits.categories, guidance: 1 },
        total: 1,
      },
      entries: [{
        id: "safety",
        category: "guidance",
        content: "safety",
        priority: 0,
        neverTruncate: true,
      }],
    });

    expect(result.entries[0]).toMatchObject({ content: "safety", truncated: false });
    expect(result.usage.categories.guidance).toEqual({ limit: 1, used: 6, omitted: 0 });
  });

  it("replaces a cut atom source with its root anchor instead of an unreachable slice", () => {
    const anchor = 'compile_subtree(node_id="node-cut")';
    const result = allocateContextBudget({
      limits: {
        categories: { ...limits.categories, atom_ref: 5 },
        total: 5,
      },
      entries: [{
        id: "page:atom",
        category: "atom_ref",
        content: "123456789",
        fallback: anchor,
        fallbackAnchorCount: 1,
        priority: 0,
        neverTruncate: false,
      }],
    });

    expect(result.entries[0]).toMatchObject({
      content: anchor,
      truncated: true,
      anchorCount: 1,
    });
    expect(result.entries[0]?.content).toContain("node-cut");
    expect(result.entries[0]?.content).not.toBe("12345");
    expect(result.usage.categories.atom_ref).toEqual({
      limit: 5,
      used: anchor.length,
      omitted: 1,
    });
  });
});
