import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";
import { mcpTools } from "../src/index.ts";
import { webhookTools } from "../src/webhook_tools.ts";

// The orchestrator's single outbound POST (verification or redelivery) may take up to 10s.
const ORCH_OUTBOUND_POST_DEADLINE_MS = 10_000;

test("webhook tools are the eight internal tools in the shared catalog", () => {
  assert.deepEqual(Object.keys(webhookTools).sort(), [
    "create_inbound_webhook", "create_outbound_webhook", "delete_outbound_webhook",
    "list_webhook_activity", "list_webhooks", "redeliver_outbound_webhook",
    "revoke_inbound_webhook", "set_outbound_webhook_active",
  ]);
  for (const [name, tool] of Object.entries(webhookTools)) {
    assert.equal(tool.audience, "internal", name);
    assert.equal(mcpTools[name as keyof typeof mcpTools], tool, name);
  }
});

test("tools that send to the receiver outlast the orchestrator's send deadline", () => {
  for (const tool of [webhookTools.create_outbound_webhook, webhookTools.redeliver_outbound_webhook]) {
    assert.ok(tool.timeoutMs > ORCH_OUTBOUND_POST_DEADLINE_MS, tool.name);
  }
});

test("webhook inputs keep the management route limits", () => {
  const inbound = z.object(webhookTools.create_inbound_webhook.config.inputSchema);
  const valid = { target_session_id: "0f6d8c2a-4b31-4d7e-9a15-9c8b7a6d5e4f", label: "알림", auth_mode: "key" };
  assert.equal(inbound.safeParse(valid).success, true);
  assert.equal(inbound.safeParse({ ...valid, label: "가".repeat(81) }).success, false);
  assert.equal(inbound.safeParse({ ...valid, expires_in_seconds: 59 }).success, false);
  const outbound = z.object(webhookTools.create_outbound_webhook.config.inputSchema);
  const create = { target_session_id: "s1", label: "받는 곳", url: "https://receiver.example/hook", event_types: ["session.reply"] };
  assert.equal(outbound.safeParse(create).success, true);
  assert.equal(outbound.safeParse({ ...create, url: "http://receiver.example/hook" }).success, false);
  assert.equal(outbound.safeParse({ ...create, event_types: [] }).success, false);
  assert.equal(outbound.safeParse({ ...create, event_types: ["session.reply", "session.reply"] }).success, false);
});
