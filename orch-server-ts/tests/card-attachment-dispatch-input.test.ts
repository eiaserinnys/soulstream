import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import { sendCardChangeOnce } from "../src/cards/card_change_delivery.js";
import { createCardDispatchRuntime } from "../src/cards/card_dispatch_runtime.js";
import { normalizeAttachmentLegacyPath } from "../src/attachments/attachment_read_service.js";
import { recordWorkReceipt, prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const OWNER = "card-owner@example.test";
const SOURCE_NODE = "sourceA";
const TARGET_NODE = "targetB";
const IMAGE_A = "/incoming/upload/a.png";
const IMAGE_B = "/incoming/upload/b.png";
const LOCAL_IMAGE = "/incoming/upload/local.png";

describe("card attachment dispatch input", () => {
  let h: PagePostgresHarness;
  let runtime: Awaited<ReturnType<typeof createCardDispatchRuntime>>;
  let createSession: ReturnType<typeof vi.fn>;
  let routeExisting: ReturnType<typeof vi.fn>;
  let sendPendingCommand: ReturnType<typeof vi.fn>;
  let sent: Record<string, any>[];

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/116_card_execution_requests.sql", import.meta.url), "utf8"));
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by)
      VALUES ('card_dispatch','{"nodeConcurrency":{"default":4}}','test')`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('attachment-dispatch','첨부 실행')`;

    sent = [];
    createSession = vi.fn((payload: Record<string, any>) => ({
      node: { nodeId: payload.nodeId },
      command: { payload },
      modelPresetId: payload.model_preset ?? "model",
    }));
    routeExisting = vi.fn(async (payload: Record<string, any>) => ({
      node: { nodeId: TARGET_NODE },
      command: { payload },
    }));
    sendPendingCommand = vi.fn(async (routed: { command: { payload: Record<string, any> } }) => {
      const payload = routed.command.payload;
      sent.push(payload);
      if (payload.type === "create_session") {
        await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
          VALUES(${payload.agentSessionId},${payload.nodeId},${payload.profile},'initializing',${payload.cardId},'attachment-dispatch',${payload.model_preset ?? null})
          ON CONFLICT(session_id) DO NOTHING`;
        const proof = { registrationId: `registration-${payload.agentSessionId}`, executionCommandId: `command-${payload.agentSessionId}` };
        await recordWorkReceipt(h, payload.agentSessionId, "running", proof);
        return { type: "session_created", status: "ok", agentSessionId: payload.agentSessionId };
      }
      if (payload.type === "ensure_session_running") {
        return { state: "started", execution: { registrationId: `registration-${payload.agentSessionId}`, executionCommandId: `command-${payload.agentSessionId}` } };
      }
      return { type: "ack", status: "ok" };
    });
    runtime = await createCardDispatchRuntime({
      sqlResolver: { resolveSql: async () => h.liveSql, close: async () => undefined },
      router: {
        selectNodeForCreate: ({ nodeId, profileId, modelPresetId }: { nodeId: string; profileId: string; modelPresetId?: string }) => ({
          nodeId, profileId, modelPresetId: modelPresetId ?? "model",
        }),
        createSession,
        routeExistingSessionPendingCommand: routeExisting,
        waitForCreatedSession: async () => true,
      } as any,
      bridge: { sendPendingCommand } as any,
      availability: { resolveForNode: () => ({ available: true }), requireAvailable: () => undefined } as any,
      notifier: {} as any,
      admin: {} as any,
      broadcaster: { append: () => undefined } as any,
      warn: vi.fn(),
      onFolderHeaderUpdated: async () => undefined,
      usageSnapshot: () => ({}) as any,
      ensureSystemFolder: async () => undefined,
      validateFolder: async () => true,
      resolveSessionOwner: async () => null,
      findUserByEmail: async (email) => ({ email, isAdmin: true, allowedFolderIds: [] }),
    });
  }, 60000);

  afterAll(async () => {
    await runtime?.dispatcher.drain();
    await h?.cleanup();
  });

  beforeEach(async () => {
    await runtime.dispatcher.drain();
    await h.sql`DELETE FROM attachment_legacy_aliases`;
    await h.sql`DELETE FROM file_assets`;
    createSession.mockClear();
    routeExisting.mockClear();
    sendPendingCommand.mockClear();
    sent.length = 0;
  });

  async function addAttachment(id: string, nodeId: string, path: string) {
    await h.sql`INSERT INTO file_assets(id,storage_key,storage_purpose,owner_kind,owner_key,registration_scope,
        original_name,mime_type,byte_size,upload_status)
      VALUES(${id},${`storage-${id}`},'attachment','user_email',${OWNER},NULL,${id},'image/png',10,'committed')`;
    await h.sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES(${nodeId},${normalizeAttachmentLegacyPath(path)},${id},${path},'resolved')`;
  }

  async function makeCard(attachments: CardAttachment[], queue = false) {
    const cards = await runtime.serviceProvider();
    const made = await cards.createCard({
      actorKind: "user",
      actorSessionId: null,
      actorUserId: OWNER,
      folderId: "attachment-dispatch",
      title: `첨부 ${randomUUID()}`,
      request: "첨부를 처리하세요.",
      attachments,
      queue,
      assignee: { kind: "agent", agentId: "profile" },
      nodeId: TARGET_NODE,
      modelPreset: "model",
      idempotencyKey: randomUUID(),
    });
    await runtime.dispatcher.drain();
    return { cards, cardId: made.operation.target_id };
  }

  function attachment(nodeId: string, path: string): CardAttachment {
    return { nodeId, path, name: path.split("/").at(-1)!, mimeType: "image/png" };
  }

  async function execute(cardId: string) {
    const current = (await (await runtime.serviceProvider()).getCard(cardId))!.card;
    return (await runtime.executionServiceProvider()).execute({
      actorKind: "user",
      actorSessionId: null,
      actorUserId: OWNER,
      cardId,
      expectedVersion: current.version,
      idempotencyKey: randomUUID(),
    });
  }

  it("dispatches mixed source aliases and same-node paths in order with deduplicated IDs", async () => {
    const assetA = `asset-${randomUUID()}`;
    const assetB = `asset-${randomUUID()}`;
    await addAttachment(assetA, SOURCE_NODE, IMAGE_A);
    await addAttachment(assetB, SOURCE_NODE, IMAGE_B);
    const { cardId } = await makeCard([
      attachment(SOURCE_NODE, IMAGE_A),
      attachment(TARGET_NODE, LOCAL_IMAGE),
      attachment(SOURCE_NODE, IMAGE_B),
      attachment(SOURCE_NODE, IMAGE_A),
    ], true);

    const command = sent.find(payload => payload.type === "create_session" && payload.cardId === cardId);
    if (!command) throw new Error("Card create command was not sent");
    expect(command).toMatchObject({
      nodeId: TARGET_NODE,
      attachment_ids: [assetA, assetB],
      attachment_paths: [LOCAL_IMAGE],
      attachment_bindings: [
        { attachment_id: assetA, node_id: SOURCE_NODE, path: IMAGE_A },
        { attachment_id: assetB, node_id: SOURCE_NODE, path: IMAGE_B },
      ],
    });
    expect(command.attachment_paths).not.toContain(IMAGE_A);
    expect(command.attachment_paths).not.toContain(IMAGE_B);
  });

  it("admits legacy limit resume and durable comment delivery through the runtime bridge", async () => {
    const asset = `asset-${randomUUID()}`;
    await addAttachment(asset, SOURCE_NODE, IMAGE_A);
    const { cards, cardId } = await makeCard([attachment(SOURCE_NODE, IMAGE_A)]);
    const sessionId = randomUUID();
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset,termination_reason,termination_event_id)
      VALUES(${sessionId},${TARGET_NODE},'profile','error',${cardId},'attachment-dispatch','model','limit_hit',1)`;
    await h.sql`UPDATE cards SET status='blocked',blocked_kind='limit',blocked_detail='사용량 한도',assignee_kind='session',
      assignee_agent_id=NULL,assignee_session_id=${sessionId} WHERE id=${cardId}`;

    await runtime.dispatcher.checkLimits();
    await runtime.dispatcher.drain();
    const resumed = sent.find(payload => payload.type === "intervene" && payload.text === "한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다.");
    expect(resumed).toMatchObject({
      attachment_ids: [asset],
      attachment_bindings: [{ attachment_id: asset, node_id: SOURCE_NODE, path: IMAGE_A }],
    });
    expect((await cards.getCard(cardId))!.card.status).toBe("running");

    await cards.addComment({ actorKind: "user", actorSessionId: null, actorUserId: OWNER, cardId, body: "계속 진행하세요.", idempotencyKey: randomUUID() });
    await runtime.dispatcher.drain();
    const commentDelivery = sent.find(payload => payload.type === "intervene" && payload.delivery_id && payload.text.includes("계속 진행하세요."));
    if (!commentDelivery) throw new Error("Card comment delivery was not sent");
    expect(commentDelivery).toMatchObject({
      attachment_ids: [asset],
      attachment_bindings: [{ attachment_id: asset, node_id: SOURCE_NODE, path: IMAGE_A }],
    });
    const stored = await h.sql<{ payload: Record<string, any> }[]>`SELECT payload FROM session_deliveries WHERE delivery_id=${commentDelivery.delivery_id}`;
    expect(stored[0]?.payload).toMatchObject({
      attachment_ids: [asset],
      attachment_bindings: [{ attachment_id: asset, node_id: SOURCE_NODE, path: IMAGE_A }],
    });
    expect(stored[0]?.payload.attachment_paths ?? []).not.toContain(IMAGE_A);
  });

  it("uses admitted source bindings for an explicit card execution launch", async () => {
    const asset = `asset-${randomUUID()}`;
    await addAttachment(asset, SOURCE_NODE, IMAGE_A);
    const { cardId } = await makeCard([attachment(SOURCE_NODE, IMAGE_A)]);

    await execute(cardId);

    expect(sent.find(payload => payload.type === "create_session" && payload.cardId === cardId)).toMatchObject({
      nodeId: TARGET_NODE,
      attachment_ids: [asset],
      attachment_bindings: [{ attachment_id: asset, node_id: SOURCE_NODE, path: IMAGE_A }],
    });
  });

  it("uses admitted source bindings when ensuring an existing card session", async () => {
    const asset = `asset-${randomUUID()}`;
    await addAttachment(asset, SOURCE_NODE, IMAGE_A);
    const { cardId } = await makeCard([attachment(SOURCE_NODE, IMAGE_A)]);
    const sessionId = randomUUID();
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES(${sessionId},${TARGET_NODE},'profile','completed',${cardId},'attachment-dispatch','model')`;
    await h.sql`UPDATE cards SET status='running',assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${sessionId} WHERE id=${cardId}`;

    await execute(cardId);

    expect(sent.find(payload => payload.type === "ensure_session_running" && payload.agentSessionId === sessionId)).toMatchObject({
      attachment_ids: [asset],
      attachment_bindings: [{ attachment_id: asset, node_id: SOURCE_NODE, path: IMAGE_A }],
    });
  });

  it("rejects a foreign alias with no stored reference on the exact card", async () => {
    const asset = `asset-${randomUUID()}`;
    await addAttachment(asset, SOURCE_NODE, IMAGE_A);
    const { cardId } = await makeCard([attachment(SOURCE_NODE, IMAGE_A)]);
    await h.sql`UPDATE cards SET attachment_refs=${h.sql.json([])} WHERE id=${cardId}`;

    await expect(execute(cardId)).rejects.toThrow("Attachment access denied");
    expect(sent.some(payload => payload.type === "create_session" && payload.cardId === cardId)).toBe(false);
  });

  it("keeps an unaliased same-node legacy path usable", async () => {
    const { cardId } = await makeCard([attachment(TARGET_NODE, LOCAL_IMAGE)]);

    await execute(cardId);

    expect(sent.find(payload => payload.type === "create_session" && payload.cardId === cardId)).toMatchObject({
      attachment_paths: [LOCAL_IMAGE],
    });
  });

  it("keeps the attachment-free card-change canonical payload and hash unchanged", async () => {
    const payload = {
      type: "intervene" as const,
      agentSessionId: "session-no-attachments",
      text: "카드가 변경됐습니다",
      user: "",
      delivery_id: "delivery-no-attachments",
      delivery_intent: "durable_next_turn" as const,
      source: "card_change",
      relation_key: "card-change:no-attachments",
      completion_id: "completion:no-attachments",
      caller_info: { source: "system" },
    };
    let registration: Record<string, any> | undefined;
    const repository = {
      register: async (input: Record<string, any>) => {
        registration = input;
        return { row: { delivery_id: payload.delivery_id, state: "queued" } as any, conflict: false };
      },
      claim: async () => null,
      get: async () => null,
    };

    await sendCardChangeOnce(repository as never, payload, async () => ({}));

    expect([registration?.payload, registration?.payloadHash]).toEqual([
      { text: "카드가 변경됐습니다", user: "", attachment_paths: null, context: null, caller_info: { source: "system" }, followup_key: null, followup_attempt: null, followup_task_ids: null },
      "a172fc63fce4b069ddcbe8c1fb8041a4acc0fda78e51ba8cdabe1d0583dc8785",
    ]);
  });
});
