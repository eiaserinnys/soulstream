import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";
import { cardTools } from "../src/card_tools.ts";

test("dispatch_work is internal-only with a strict bounded intake shape", () => {
  const tool = cardTools.dispatch_work;
  assert.equal(tool.audience, "internal");
  assert.equal(tool.strictInputSchema, true);

  const input = z.object(tool.config.inputSchema).strict();
  assert.equal(input.safeParse({
    request: "이 카드 작업을 진행해 주세요",
    idempotency_key: "work-1",
    card_id: "card-1",
    brief: "완료 기준: 결과 저장",
    caller_session_id: "session-1",
  }).success, true);
  assert.equal(input.safeParse({
    request: "새 카드 작업",
    idempotency_key: "work-2",
    title: "새 작업",
    folder_id: "folder-1",
    agent_id: "agent-1",
    model_preset: "preset-1",
    node_id: "node-1",
  }).success, true);
  assert.equal(input.safeParse({
    request: "작업",
    idempotency_key: "work-3",
    card_id: "card-1",
    unknown: true,
  }).success, false);
  assert.equal(input.safeParse({
    request: "",
    idempotency_key: "work-4",
    card_id: "card-1",
  }).success, false);
});
