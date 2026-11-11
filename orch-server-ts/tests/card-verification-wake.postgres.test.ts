import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService, type CardMutationChange } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";

// Disposable DB with the real dispatcher and card mutations. Only message transport is mocked.
const HOUR = 60 * 60 * 1000;
const BASE = Date.parse("2026-11-07T05:00:00.000Z");
const WAKE_TEXT = "[검증 대기 시각] 기다리던 것: 배포 확인. 확인해 결과를 항목에 남기고, 아직이면 다시 검증 대기로 둔다.";

let h: PagePostgresHarness, cards: CardControlPlaneService;
let dispatcher: CardDispatcher;
let clock = BASE, orchestrationEnabled = false;
let sequence = 0;
const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
const key = () => `verification-wake-${++sequence}`;
const messages = vi.fn(async (_sessionId: string, _text: string, _admission?: unknown,
  _changeDelivery?: { deliveryId: string }) => {});
const delivered = new Set<string>();
const abandoned: { deliveryId: string; reason: string }[] = [];
const changes: CardMutationChange[] = [];
const warn = vi.fn();

beforeAll(async () => {
  h = await createPagePostgresHarness();
  await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN metadata JSONB,
    ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
  await h.sql`INSERT INTO folders(id,name) VALUES('wake','검증 대기')`;
  await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status) VALUES('owner','node','worker','model','running')`;
  await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
  await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES
    ('card_dispatch','{"nodeConcurrency":{"default":2}}','test'),('card_orchestration','{"enabled":false}','test')`;
  const sql = createFolderContentSqlAdapter(h.liveSql);
  const repo = new CardDispatchRepository(async () => sql);
  cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined, change => { changes.push(change); });
  dispatcher = new CardDispatcher({
    repository: repo, cards: async () => cards,
    resolveTarget: () => ({ nodeId: "node", agentId: "worker", modelPreset: "model", available: true, reason: null }),
    launch: async () => {}, sendMessage: messages, notify: async () => {},
    deliveryExists: async deliveryId => delivered.has(deliveryId),
    abandonDelivery: async (deliveryId, reason) => { abandoned.push({ deliveryId, reason }); },
    warn, now: () => clock,
    orchestration: { enabled: async () => orchestrationEnabled, kick: async () => {}, ownsSession: async () => false },
  });
}, 60000);
afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });
beforeEach(async () => {
  await dispatcher.drain();
  await h.sql`DELETE FROM folder_operations`;
  await h.sql`DELETE FROM cards`;
  clock = BASE;
  orchestrationEnabled = false;
  messages.mockClear(); warn.mockClear(); delivered.clear(); abandoned.length = 0; changes.length = 0;
});

const owners = new Map<string, string>();
async function makeWaitCard(waitingFor = "배포 확인") {
  const sessionId = `wake-owner-${++sequence}`;
  await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status) VALUES(${sessionId},'node','worker','model','running')`;
  const made = await cards.createCard({ ...human, folderId: "wake", title: "기다리는 카드", request: "",
    assignee: { kind: "session", sessionId } });
  const id = made.operation.target_id;
  owners.set(id, sessionId);
  await cards.setCardStatus({ ...human, cardId: id, status: "awaiting_verification", expectedVersion: 1,
    idempotencyKey: key(), wakeAt: new Date(Date.now() + HOUR).toISOString(), waitingFor });
  return id;
}
/** 시각이 지난 것으로 DB를 직접 옮긴다. 서비스는 설정 시점에 미래 시각만 받는다. */
async function due(id: string) {
  const wakeAt = new Date(BASE - HOUR).toISOString();
  await h.sql`UPDATE cards SET wake_at=${wakeAt} WHERE id=${id}`;
  return wakeAt;
}
async function stored(id: string) {
  return (await h.sql<Record<string, unknown>[]>`SELECT * FROM cards WHERE id=${id}`)[0]!;
}

it.each([true, false])("wakes the assignee at the deadline with a deterministic delivery (orchestration %s)", async enabled => {
  orchestrationEnabled = enabled;
  const id = await makeWaitCard();
  const wakeAt = await due(id);
  clock = BASE;
  await dispatcher.checkLimits();
  expect(messages).toHaveBeenCalledTimes(1);
  expect(messages.mock.calls[0]).toEqual([owners.get(id)!, WAKE_TEXT, undefined,
    { deliveryId: `card-verify-wake:${id}:${wakeAt}`, actorKind: "system", actorSessionId: null }]);
  const row = await stored(id);
  expect(row).toMatchObject({ status: "running", wake_at: null, waiting_for: null });
  expect(row.now).toMatchObject({ text: "담당이 기다리던 것을 확인합니다", turn: "agent", sessionId: owners.get(id)! });
  await dispatcher.checkLimits();
  expect(messages).toHaveBeenCalledTimes(1);
});

it("ignores a future deadline and an archived card", async () => {
  const future = await makeWaitCard();
  await h.sql`UPDATE cards SET wake_at=${new Date(BASE + HOUR).toISOString()} WHERE id=${future}`;
  const archived = await makeWaitCard();
  await h.sql`UPDATE cards SET wake_at=${new Date(BASE - HOUR).toISOString()},archived=TRUE WHERE id=${archived}`;
  clock = BASE;
  await dispatcher.checkLimits();
  expect(messages).not.toHaveBeenCalled();
  expect(await stored(future)).toMatchObject({ status: "awaiting_verification", waiting_for: "배포 확인" });
  expect(await stored(archived)).toMatchObject({ status: "awaiting_verification", waiting_for: "배포 확인" });
});

it("does not deliver twice when the delivery id is already recorded but still resumes the card", async () => {
  const id = await makeWaitCard();
  const wakeAt = await due(id);
  delivered.add(`card-verify-wake:${id}:${wakeAt}`);
  clock = BASE;
  await dispatcher.checkLimits();
  expect(messages).not.toHaveBeenCalled();
  expect((await stored(id)).status).toBe("running");
});

it("blocks with no_report when the assignee session is gone", async () => {
  const id = await makeWaitCard();
  await due(id);
  await h.sql`DELETE FROM sessions WHERE session_id=${owners.get(id)!}`;
  clock = BASE;
  await dispatcher.checkLimits();
  expect(messages).not.toHaveBeenCalled();
  expect(await stored(id)).toMatchObject({ status: "blocked", blocked_kind: "no_report",
    blocked_detail: "검증 대기 시각에 담당을 깨우지 못함: 담당 세션이 없습니다", wake_at: null, waiting_for: null });
  expect(changes.at(-1)?.committedCard).toMatchObject({ status: "blocked", blocked_kind: "no_report" });
});

it("blocks with no_report and abandons the delivery when the message fails", async () => {
  const id = await makeWaitCard();
  const wakeAt = await due(id);
  messages.mockRejectedValueOnce(new Error("전송 실패"));
  clock = BASE;
  await dispatcher.checkLimits();
  expect(abandoned).toEqual([{ deliveryId: `card-verify-wake:${id}:${wakeAt}`, reason: "Error: 전송 실패" }]);
  expect(await stored(id)).toMatchObject({ status: "blocked", blocked_kind: "no_report",
    blocked_detail: "검증 대기 시각에 담당을 깨우지 못함: Error: 전송 실패", wake_at: null, waiting_for: null });
});
