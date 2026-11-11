import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";
import { cardMaintenanceTools } from "../src/card_maintenance_tools.ts";
import { cardTools } from "../src/card_tools.ts";
import { mcpToolDefinitions } from "../src/index.ts";

const update = z.object(cardTools.update_unstarted_card.config.inputSchema).strict();
const merge = z.object(cardTools.merge_cards.config.inputSchema).strict();
const bulk = z.object(cardTools.bulk_set_card_status.config.inputSchema).strict();

test("the three card maintenance tools are strict internal tools and are part of the shared contract", () => {
  for (const name of ["update_unstarted_card", "merge_cards", "bulk_set_card_status"] as const) {
    assert.equal(cardMaintenanceTools[name].name, name);
    assert.equal(cardMaintenanceTools[name].audience, "internal");
    assert.equal(cardMaintenanceTools[name].strictInputSchema, true);
    assert.equal(mcpToolDefinitions.some(tool => tool.name === name && tool.audience === "all"), false);
    assert.equal(mcpToolDefinitions.some(tool => tool.name === name && tool.audience === "internal"), true);
  }
});

test("update_unstarted_card requires a card and an idempotency key and accepts empty request/brief", () => {
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", request: "" }).success, true);
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", brief: "" }).success, true);
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", title: "제목", request: "원문", brief: "인계",
    agent_id: "roselin", model_preset: "sol", node_id: "node-1", expected_version: 3,
    caller_session_id: "session-1" }).success, true);
  assert.equal(update.safeParse({ idempotency_key: "k" }).success, false);
  assert.equal(update.safeParse({ card_id: "card-1" }).success, false);
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", expected_version: 0 }).success, false);
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", expected_version: 1.5 }).success, false);
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", request: null }).success, false);
  assert.equal(update.safeParse({ card_id: "card-1", idempotency_key: "k", unknown_field: "x" }).success, false);
});

test("merge_cards bounds the source list to 1~9 and keeps the order it was given", () => {
  assert.equal(merge.safeParse({ target_card_id: "target", source_card_ids: ["source-1"], idempotency_key: "k" }).success, true);
  assert.equal(merge.safeParse({ target_card_id: "target", source_card_ids: Array.from({ length: 9 }, (_, i) => `s${i}`),
    idempotency_key: "k", title: "합친 카드" }).success, true);
  assert.equal(merge.safeParse({ target_card_id: "target", source_card_ids: [], idempotency_key: "k" }).success, false);
  assert.equal(merge.safeParse({ target_card_id: "target", source_card_ids: Array.from({ length: 10 }, (_, i) => `s${i}`),
    idempotency_key: "k" }).success, false);
  assert.equal(merge.safeParse({ source_card_ids: ["source-1"], idempotency_key: "k" }).success, false);
  assert.equal(merge.safeParse({ target_card_id: "target", source_card_ids: ["source-1"] }).success, false);
  assert.equal(merge.safeParse({ target_card_id: "target", source_card_ids: ["source-1"], idempotency_key: "k", extra: 1 }).success, false);
});

test("bulk_set_card_status bounds the card list to 1~20 and only accepts the four maintenance targets", () => {
  assert.equal(bulk.safeParse({ card_ids: ["card-1"], status: "on_hold", idempotency_key: "k" }).success, true);
  assert.equal(bulk.safeParse({ card_ids: Array.from({ length: 20 }, (_, i) => `c${i}`), status: "cancelled",
    idempotency_key: "k", reason: "" }).success, true);
  assert.equal(bulk.safeParse({ card_ids: [], status: "todo", idempotency_key: "k" }).success, false);
  assert.equal(bulk.safeParse({ card_ids: Array.from({ length: 21 }, (_, i) => `c${i}`), status: "todo",
    idempotency_key: "k" }).success, false);
  for (const status of ["todo", "queued", "on_hold", "cancelled"] as const)
    assert.equal(bulk.safeParse({ card_ids: ["card-1"], status, idempotency_key: "k" }).success, true, status);
  for (const status of ["running", "done", "review", "blocked"])
    assert.equal(bulk.safeParse({ card_ids: ["card-1"], status, idempotency_key: "k" }).success, false, status);
  assert.equal(bulk.safeParse({ card_ids: ["card-1"], idempotency_key: "k" }).success, false);
  assert.equal(bulk.safeParse({ card_ids: ["card-1"], status: "todo", idempotency_key: "k", reason: null }).success, false);
});

test("create_card points pre-start edits at update_unstarted_card", () => {
  assert.equal(cardTools.create_card.config.description,
    "요청 원문을 담은 카드를 드래프트로 만든다. 시작 전 수정은 update_unstarted_card를 쓴다. queue=true면 대기열에 올려 순서가 오면 시스템이 실행한다. assignee를 생략하면 만든 세션의 에이전트가 담당이 되고, 담당이 에이전트일 때 node_id와 model_preset을 생략하면 만든 세션의 값이 들어가며, brief에 인계 내용을 적는다.");
});
