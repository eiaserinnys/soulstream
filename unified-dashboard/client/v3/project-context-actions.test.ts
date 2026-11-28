import { describe, expect, it } from "vitest";

import { projectAtomProperties } from "./project-context-actions";

const block = { id: "atom", page_id: "p", parent_id: null, position_key: "a", block_type: "atom_ref", text: "", collapsed: false,
  properties: { instance: "atom", nodeId: "old", nodeTitle: "기존", depth: 3, titlesOnly: false, limit: 8, extra: "kept" } };

describe("atom reference properties", () => {
  it("replaces the edited fields and keeps the rest of the block's properties", () => {
    expect(projectAtomProperties({ blockId: "atom", nodeId: "new", nodeTitle: "새 노드", depth: 5, titlesOnly: true, mode: "titles", limit: 3 }, [block as never]))
      .toEqual({ instance: "atom", nodeId: "new", nodeTitle: "새 노드", depth: 5, titlesOnly: true, mode: "titles", limit: 3, extra: "kept" });
  });

  it("drops limit and mode when the reference no longer carries them", () => {
    const properties = projectAtomProperties({ blockId: "atom", nodeId: "new", nodeTitle: "새 노드", depth: 5, titlesOnly: true, limit: null }, [block as never]);
    expect(properties).not.toHaveProperty("limit");
    expect(properties).not.toHaveProperty("mode");
  });

  it("rejects depth outside 1 to 5 and an empty node", () => {
    expect(() => projectAtomProperties({ blockId: null, nodeId: "n", nodeTitle: "", depth: 6, titlesOnly: false }, [])).toThrow();
    expect(() => projectAtomProperties({ blockId: null, nodeId: " ", nodeTitle: "", depth: 2, titlesOnly: false }, [])).toThrow();
  });
});
