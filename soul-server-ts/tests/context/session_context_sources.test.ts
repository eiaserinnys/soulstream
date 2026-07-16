import { describe, expect, it } from "vitest";

import {
  extractAtomContextSourceSpecs,
  withoutSessionContextSourceMarkers,
} from "../../src/context/session_context_sources.js";

describe("session context source markers", () => {
  it("parses valid atom nodes, deduplicates them, and ignores malformed entries", () => {
    expect(extractAtomContextSourceSpecs([
      {
        key: "atom_context_sources",
        content: {
          nodes: [
            { node_id: "node-a", depth: 3, titles_only: false },
            { node_id: "node-a", depth: 7, titles_only: true },
            { node_id: "node-b", depth: 4, titles_only: true },
            { node_id: "", depth: 2 },
            null,
          ],
        },
      },
    ])).toEqual([
      { nodeId: "node-a", depth: 3, titlesOnly: false },
      { nodeId: "node-b", depth: 4, titlesOnly: true },
    ]);
  });

  it("filters both page and atom resolver markers while preserving user context", () => {
    expect(withoutSessionContextSourceMarkers([
      { key: "page_context_sources", content: { pages: [] } },
      { key: "atom_context_sources", content: { nodes: [] } },
      { key: "session_guidance", content: "지침" },
    ])).toEqual([{ key: "session_guidance", content: "지침" }]);
  });
});
