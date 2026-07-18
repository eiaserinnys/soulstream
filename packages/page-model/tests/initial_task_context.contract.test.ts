import { describe, expect, it } from "vitest";

import {
  parseInitialTaskContextWire,
  serializeInitialTaskContext,
} from "../src/index.js";

describe("initial task context wire", () => {
  it("round-trips guidance and canonical atom display/runtime properties", () => {
    const context = {
      guidance: "  직접 지침  ",
      atomReferences: [{
        instance: "atom" as const,
        nodeId: "node-a",
        nodeTitle: "soulstream",
        depth: 5,
        titlesOnly: true,
      }],
    };
    const wire = serializeInitialTaskContext(context);

    expect(wire).toEqual({
      guidance: "직접 지침",
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "soulstream",
        depth: 5,
        titles_only: true,
      }],
    });
    expect(parseInitialTaskContextWire(wire)).toEqual({
      ok: true,
      value: { ...context, guidance: "직접 지침" },
    });
  });

  it("rejects invalid depth and missing node title at the shared boundary", () => {
    expect(parseInitialTaskContextWire({
      atom_references: [{
        instance: "atom",
        node_id: "node-a",
        node_title: "",
        depth: 6,
        titles_only: false,
      }],
    })).toMatchObject({ ok: false });
  });
});
