import { describe, expect, it } from "vitest";

import { InMemoryNodeRegistry } from "../src/index.js";

describe("node registry user info", () => {
  it("preserves registration user info and refreshes it", () => {
    const registry = new InMemoryNodeRegistry();
    const registration = registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      user: { name: "Ada", email: "ada@example.com" },
    });
    expect(registry.getUserInfo("node-a")).toEqual({
      name: "Ada",
      email: "ada@example.com",
    });

    registry.refreshNodeRegistration(
      { nodeId: "node-a", connectionId: registration.node.connectionId },
      {
        type: "node_register",
        node_id: "node-a",
        user: { name: "Ada Lovelace", email: "ada@example.com" },
      },
    );
    expect(registry.getUserInfo("node-a")).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
  });
});
