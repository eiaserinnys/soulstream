import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mcpToolDefinitions, type McpToolDefinition } from "../src/index.ts";
import { cardTools } from "../src/card_tools.ts";

const mutations = new Set(["update_agent_profile", "set_agent_mcp_profile", "rollback_agents_config",
  "apply_remote_agent_profile_update", "rollback_remote_agents_config", "set_agent_atom_contexts", "set_folder_system_prompt"]);
function assertPublicTools(definitions: readonly McpToolDefinition[]) {
  for (const definition of definitions) {
    if (definition.audience !== "all") continue;
    assert.equal(definition.name.startsWith("delete_"), false, definition.name);
    assert.equal(mutations.has(definition.name), false, definition.name);
    assert.notEqual(definition.config.annotations?.destructiveHint, true, definition.name);
  }
}
test("audience all never exposes delete, configuration or destructive tools", () => assertPublicTools(mcpToolDefinitions));
test("card assignee handoff is internal-only", () => {
  assert.equal(cardTools.transfer_card_assignee.audience, "internal");
});
test("agent card execution stays internal and create_card.run stays out of the external schema", () => {
  assert.equal(cardTools.run_card.audience, "internal");
  assert.equal("run" in cardTools.create_card.externalInputSchema!, false);
  assert.equal("run" in cardTools.create_card.config.inputSchema, true);
});
test("invariant detects each forbidden class even with an explicit false hint", () => {
  for (const definition of [
    { name: "delete_example", config: { inputSchema: {}, annotations: { destructiveHint: false } } },
    ...[...mutations].map(name => ({ name, config: { inputSchema: {} } })),
    { name: "example", config: { inputSchema: {}, annotations: { destructiveHint: true } } },
  ]) assert.throws(() => assertPublicTools([{ ...definition, audience: "all" }]));
});
