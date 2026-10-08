import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";
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
test("card check item tools are internal-only while existing review and comment tools remain public", () => {
  for (const name of ["set_card_items","add_card_item","report_card_item","update_card_now","add_card_note","list_card_notes"] as const)
    assert.equal(cardTools[name].audience,"internal",name);
  assert.equal(cardTools.request_card_review.audience,"all");
  assert.equal(cardTools.add_card_comment.audience,"all");
});
test("external LLMs can run cards with the shared card execution contract", () => {
  assert.equal(cardTools.run_card.audience, "all");
  assert.equal("externalInputSchema" in cardTools.create_card, false);
  assert.equal("run" in cardTools.create_card.config.inputSchema, true);
});
test("card reads expose the bounded small-result and paging contract", () => {
  const get = z.object(cardTools.get_card.config.inputSchema).strict();
  assert.equal(get.safeParse({ card_id: "card-1", caller_session_id: "session-1",
    include: ["request", "brief", "attachments", "comments", "notes", "reports", "sessions", "now_history", "questions_history"],
    limit: 50, text_limit: 4000, cursors: { notes: "next" }, since: "token" }).success, true);
  assert.equal(get.safeParse({ card_id: "card-1", limit: 51 }).success, false);
  assert.equal(get.safeParse({ card_id: "card-1", text_limit: 4001 }).success, false);
  assert.equal(get.safeParse({ card_id: "card-1", include: ["operation"] }).success, false);

  const list = z.object(cardTools.list_cards.config.inputSchema).strict();
  assert.equal(list.safeParse({ folder_id: "folder-1", status: "running", caller_session_id: "session-1",
    limit: 50, cursor: "next", all: false }).success, true);
  assert.equal(list.safeParse({ limit: 51 }).success, false);
});
test("invariant detects each forbidden class even with an explicit false hint", () => {
  for (const definition of [
    { name: "delete_example", config: { inputSchema: {}, annotations: { destructiveHint: false } } },
    ...[...mutations].map(name => ({ name, config: { inputSchema: {} } })),
    { name: "example", config: { inputSchema: {}, annotations: { destructiveHint: true } } },
  ]) assert.throws(() => assertPublicTools([{ ...definition, audience: "all" }]));
});
