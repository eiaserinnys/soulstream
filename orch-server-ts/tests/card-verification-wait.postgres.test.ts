import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

let h: PagePostgresHarness, cards: CardControlPlaneService;
const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
const context: McpCallContext = { principal: "internal", callerSessionId: "owner", nodeId: "node" };
let sequence = 0;
let cardSequence = 0;
const cardSession = new Map<string, string>();
const key = () => `verification-wait-${++sequence}`;
const wakeIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  h = await createPagePostgresHarness();
  await h.sql`INSERT INTO folders(id,name) VALUES('wait','검증 대기')`;
  await h.sql`INSERT INTO sessions(session_id,status) VALUES('owner','running')`;
  cards = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx });
}, 60000);
afterAll(async () => h?.cleanup());

async function makeCard(assignee = true) {
  const sessionId = `owner-${++cardSequence}`;
  await h.sql`INSERT INTO sessions(session_id,status) VALUES(${sessionId},'running')`;
  const made = await cards.createCard({ ...human, folderId: "wait", title: `검증 대기 카드 ${cardSequence}`, request: "",
    ...(assignee ? { assignee: { kind: "session" as const, sessionId } } : {}) });
  const id = made.operation.target_id;
  cardSession.set(id, sessionId);
  return id;
}
async function stored(id: string) {
  return (await h.sql<Record<string, unknown>[]>`SELECT * FROM cards WHERE id=${id}`)[0]!;
}
async function enterWait(id: string, waitingFor = "배포 뒤 확인", wakeAt = wakeIn(HOUR)) {
  const card = (await cards.getCard(id))!.card;
  await cards.setCardStatus({ ...human, cardId: id, status: "awaiting_verification", expectedVersion: card.version,
    idempotencyKey: key(), wakeAt, waitingFor });
  return wakeAt;
}
function restApp() {
  const app = Fastify();
  registerCardRoutes(app, {
    nodeCredentials: null,
    provider: { listFolders: () => [{ id: "wait" }], listSessionAssignments: () => ({}) },
    accessProvider: { resolveAccess: () => ({ restricted: false }) },
    resolveDashboardUserId: () => human.actorUserId, authBearerToken: "service", environment: "production",
    cardServiceProvider: async () => cards,
  });
  return app;
}

it("stores the MCP wait fields with snake_case columns and a board now line", async () => {
  const id = await makeCard();
  const wakeAt = wakeIn(HOUR);
  const options = { cards: { cardServiceProvider: async () => cards,
    provider: { listFolders: () => [{ id: "wait" }], listSessionAssignments: () => ({}) },
    resolveAccess: () => ({ restricted: false }) } } as unknown as McpHostOptions;
  const result = await executeMcpTool(options, "set_card_status", { card_id: id, status: "awaiting_verification",
    expected_version: 1, idempotency_key: key(), wake_at: wakeAt, waiting_for: "  배포 뒤 확인  " },
    { ...context, callerSessionId: cardSession.get(id)! });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect("structuredContent" in result ? result.structuredContent : undefined)
    .toMatchObject({ card: { id, status: "awaiting_verification" } });
  const row = await stored(id);
  expect(row).toMatchObject({ status: "awaiting_verification", waiting_for: "배포 뒤 확인" });
  expect((row.wake_at as Date).toISOString()).toBe(new Date(wakeAt).toISOString());
  expect(row.now).toMatchObject({ turn: "outside", ask: null });
  expect((row.now as { text: string }).text).toMatch(/^배포 뒤 확인, .+에 다시 확인$/);
});

it("returns 400 for wait fields at the wrong boundary and keeps other invalid bodies at 422", async () => {
  const id = await makeCard();
  const app = restApp();
  try {
    const status = async (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/cards/${id}/status`, payload });
    const version = () => cards.getCard(id).then(detail => detail!.card.version);
    const wakeAt = wakeIn(HOUR);
    for (const payload of [
      { status: "awaiting_verification" },
      { status: "awaiting_verification", wakeAt },
      { status: "awaiting_verification", waitingFor: "배포 뒤 확인" },
      { status: "running", wakeAt, waitingFor: "배포 뒤 확인" },
      { status: "running", waitingFor: "배포 뒤 확인" },
    ]) {
      const res = await status({ ...payload, expectedVersion: await version(), idempotencyKey: key() });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().detail.error.code).toBe("INVALID_CARD_REQUEST");
    }
    for (const payload of [
      { status: "awaiting_verification", wakeAt, waitingFor: "배포 뒤 확인" },
      { wakeAt, waitingFor: "배포 뒤 확인" },
      { wake_at: wakeAt, waiting_for: "배포 뒤 확인" },
    ]) {
      const res = await app.inject({ method: "PATCH", url: `/api/cards/${id}`,
        payload: { ...payload, expectedVersion: await version(), idempotencyKey: key() } });
      expect(res.statusCode, res.body).toBe(400);
    }
    const malformed = await status({ status: "awaiting_verification", expectedVersion: await version(),
      idempotencyKey: key(), wakeAt: "2026-11-12T09:00", waitingFor: "배포 뒤 확인" });
    expect(malformed.statusCode, malformed.body).toBe(422);
    expect((await stored(id)).status).toBe("todo");
  } finally { await app.close(); }
});

it("accepts a REST wait entry and serializes camelCase ISO values back", async () => {
  const id = await makeCard();
  const app = restApp();
  try {
    const wakeAt = wakeIn(HOUR);
    const res = await app.inject({ method: "POST", url: `/api/cards/${id}/status`, payload: {
      status: "awaiting_verification", expectedVersion: 1, idempotencyKey: key(), wakeAt, waitingFor: "배포 확인" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().card).toMatchObject({ status: "awaiting_verification", wakeAt: new Date(wakeAt).toISOString(), waitingFor: "배포 확인" });
    const row = await stored(id);
    expect(row.status).toBe("awaiting_verification");
    expect(row.wake_at).toBeInstanceOf(Date);
    expect(row.waiting_for).toBe("배포 확인");
  } finally { await app.close(); }
});

it("rejects a wait without an assignee and invalid wait values through the service", async () => {
  const unassigned = await makeCard(false);
  await expect(cards.setCardStatus({ ...human, cardId: unassigned, status: "awaiting_verification", expectedVersion: 1,
    idempotencyKey: key(), wakeAt: wakeIn(HOUR), waitingFor: "배포 확인" }))
    .rejects.toMatchObject({ statusCode: 422, message: "검증 대기는 담당 세션이 있는 카드만 설정할 수 있습니다" });
  const id = await makeCard();
  const attempt = (wakeAt: string, waitingFor: string) => cards.setCardStatus({ ...human, cardId: id,
    status: "awaiting_verification", expectedVersion: 1, idempotencyKey: key(), wakeAt, waitingFor });
  await expect(attempt(wakeIn(-HOUR), "배포 확인")).rejects.toMatchObject({ statusCode: 422, message: "wake_at은 지금보다 뒤여야 합니다" });
  await expect(attempt(wakeIn(8 * 24 * HOUR), "배포 확인")).rejects.toMatchObject({ statusCode: 422,
    message: "wake_at은 지금부터 7일 이내여야 합니다" });
  await expect(attempt("2026-11-12T09:00", "배포 확인")).rejects.toMatchObject({ statusCode: 422,
    message: "wake_at은 오프셋이 있는 ISO 8601 시각이어야 합니다" });
  await expect(attempt(wakeIn(HOUR), "가".repeat(37))).rejects.toMatchObject({ statusCode: 422,
    message: "waiting_for는 36자까지입니다. 지금 37자입니다" });
  expect((await stored(id)).status).toBe("todo");
});

it("replays the same idempotency key without a second operation or status write", async () => {
  const id = await makeCard();
  const params = { ...human, cardId: id, status: "awaiting_verification" as const, expectedVersion: 1,
    idempotencyKey: "verification-replay", wakeAt: wakeIn(HOUR), waitingFor: "배포 확인" };
  const first = await cards.setCardStatus(params);
  const versionAfterFirst = (await stored(id)).version;
  const second = await cards.setCardStatus(params);
  expect(first.idempotent).toBeFalsy();
  expect(second.idempotent).toBe(true);
  const operations = await h.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM folder_operations
    WHERE operation_type='set_card_status' AND target_id=${id}`;
  expect(operations[0]!.count).toBe("1");
  expect((await stored(id)).version).toBe(versionAfterFirst);
});

it("clears both wait fields when leaving for any other status", async () => {
  const id = await makeCard();
  for (const status of ["todo", "queued", "blocked", "running", "review", "on_hold", "done", "cancelled"] as const) {
    await enterWait(id);
    expect(await stored(id)).toMatchObject({ status: "awaiting_verification", waiting_for: "배포 뒤 확인" });
    const before = (await cards.getCard(id))!.card;
    await cards.setCardStatus({ ...human, cardId: id, status, expectedVersion: before.version, idempotencyKey: key() });
    expect(await stored(id)).toMatchObject({ status, wake_at: null, waiting_for: null });
  }
});

it("keeps status_changed_at when resetting the wait and preserves the fields on a title-only change", async () => {
  const id = await makeCard();
  await enterWait(id, "첫 확인", wakeIn(HOUR));
  const first = await stored(id);
  const secondWake = wakeIn(2 * HOUR);
  const current = (await cards.getCard(id))!.card;
  await cards.setCardStatus({ ...human, cardId: id, status: "awaiting_verification", expectedVersion: current.version,
    idempotencyKey: key(), wakeAt: secondWake, waitingFor: "두 번째 확인" });
  const reset = await stored(id);
  expect((reset.wake_at as Date).toISOString()).toBe(new Date(secondWake).toISOString());
  expect(reset.waiting_for).toBe("두 번째 확인");
  expect(reset.status_changed_at).toEqual(first.status_changed_at);
  const beforeTitle = (await cards.getCard(id))!.card;
  await cards.patchCard({ ...human, cardId: id, title: "제목만 변경", expectedVersion: beforeTitle.version, idempotencyKey: key() });
  const titled = await stored(id);
  expect(titled).toMatchObject({ title: "제목만 변경", status: "awaiting_verification", waiting_for: "두 번째 확인" });
  expect((titled.wake_at as Date).toISOString()).toBe(new Date(secondWake).toISOString());
});

it("clears the wait through the other status-writing entrypoints", async () => {
  const reviewId = await makeCard();
  await enterWait(reviewId);
  await cards.requestCardReview({ actorKind: "agent", actorSessionId: cardSession.get(reviewId)!, cardId: reviewId, idempotencyKey: key() });
  expect(await stored(reviewId)).toMatchObject({ status: "review", wake_at: null, waiting_for: null });

  const questionId = await makeCard();
  await enterWait(questionId);
  await cards.askQuestion({ actorKind: "agent", actorSessionId: cardSession.get(questionId)!, cardId: questionId,
    text: "확인 필요", options: ["예", "아니오"], idempotencyKey: key() });
  expect(await stored(questionId)).toMatchObject({ status: "blocked", blocked_kind: "question", wake_at: null, waiting_for: null });
});
