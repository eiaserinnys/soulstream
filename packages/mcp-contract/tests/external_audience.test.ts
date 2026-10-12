import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";
import { mcpToolDefinitions, type McpToolDefinition } from "../src/index.ts";
import { cardTools } from "../src/card_tools.ts";
import { sessionTools } from "../src/session_tools.ts";

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
test("PAS period history is a strict internal read-only tool", () => {
  const definition = sessionTools.list_persistent_session_history;
  assert.equal(definition.audience, "internal");
  assert.equal(definition.strictInputSchema, true);
  assert.equal(definition.config.annotations?.readOnlyHint, true);
  assert.equal(mcpToolDefinitions.some((tool) => tool.name === definition.name && tool.audience === "all"), false);

  const input = z.object(definition.config.inputSchema).strict();
  assert.equal(input.safeParse({ since: "2026-10-05T00:00:00+09:00", until: "2026-10-06T00:00:00+09:00" }).success, true);
  assert.equal(input.safeParse({ session_id: "pas-1", since: "2026-10-05T00:00:00+09:00",
    until: "2026-10-06T00:00:00+09:00", email: "someone@example.com" }).success, false);
  assert.equal(input.safeParse({ session_id: "pas-1", since: "2026-10-05T00:00:00+09:00",
    until: "2026-10-06T00:00:00+09:00", caller_session_id: "forged" }).success, false);
  assert.equal(input.safeParse({ since: "2026-10-05T00:00:00+09:00", until: "2026-10-06T00:00:00+09:00", limit: 101 }).success, false);
  assert.equal(input.safeParse({ since: "2026-10-05T00:00:00+09:00", until: "2026-10-06T00:00:00+09:00", max_text_chars: 99 }).success, false);
});
test("turn usage reads are strict internal-only read-only tools", () => {
  for (const definition of [sessionTools.list_turn_usage, sessionTools.summarize_turn_usage]) {
    assert.equal(definition.audience, "internal");
    assert.equal(definition.strictInputSchema, true);
    assert.equal(definition.config.annotations?.readOnlyHint, true);
    assert.equal(mcpToolDefinitions.some((tool) => tool.name === definition.name && tool.audience === "all"), false);
  }

  const list = z.object(sessionTools.list_turn_usage.config.inputSchema).strict();
  assert.equal(list.safeParse({ session_id: "session-1" }).success, true);
  assert.equal(list.safeParse({ since: "2026-10-05T00:00:00+09:00" }).success, true);
  assert.equal(list.safeParse({}).success, true); // the paired handler requires session_id or since.
  assert.equal(list.safeParse({ session_id: "session-1", caller_session_id: "forged" }).success, false);
  assert.equal(list.safeParse({ session_id: "session-1", limit: 201 }).success, false);

  const summary = z.object(sessionTools.summarize_turn_usage.config.inputSchema).strict();
  assert.equal(summary.safeParse({ since: "2026-10-05T00:00:00+09:00" }).success, true);
  assert.equal(summary.safeParse({ since: "2026-10-05T00:00:00+09:00", extra: true }).success, false);
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
