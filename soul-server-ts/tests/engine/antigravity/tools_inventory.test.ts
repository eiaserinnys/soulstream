import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { ANTIGRAVITY_AGENT_TOOLS } from "../../../src/engine/antigravity/agent_tools.js";
it("matches the complete accepted tool inventory measured by mini-soulstream-ts", () => {
  const inventory=JSON.parse(readFileSync(new URL("./fixtures/tools_inventory.json",import.meta.url),"utf8"));
  expect([...ANTIGRAVITY_AGENT_TOOLS]).toEqual(inventory);
});
