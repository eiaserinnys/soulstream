import { describe, expect, it, vi } from "vitest";

import type { AttachmentAssetRow, AttachmentReadRepository } from "../src/attachments/attachment_read_service.js";
import { createWorkerAttachmentAccess } from "../src/attachments/worker_attachment_access.js";
import { createWorkerAttachmentRead } from "../src/attachments/worker_attachment_read.js";
import { createLiveWorkerAttachmentRepository } from "../src/runtime/live_worker_attachment_repository.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "../src/runtime/live_db_sql.js";

const attachment: AttachmentAssetRow = {
  id: "attachment-a",
  storageKey: "private/object-a",
  storagePurpose: "attachment",
  storageEndpoint: "https://r2.example.test",
  storageBucket: "private-attachments",
  ownerKind: null,
  ownerKey: null,
  registrationScope: null,
  sourceSessionId: null,
  originalName: "photo.png",
  mimeType: "image/png",
  byteSize: 4,
  width: 1,
  height: 1,
  checksumSha256: null,
  uploadStatus: "committed",
};

const input = {
  sessionId: "session-a",
  nodeId: "node-a",
  attachmentId: attachment.id,
  mode: "input" as const,
};

function makeFixture(options: {
  readonly refs?: readonly string[];
  readonly asset?: AttachmentAssetRow | null;
  readonly session?: { nodeId: string; cardId: string | null; assigneeCardIds: string[] };
  readonly delivery?: { targetSessionId: string | null; attachmentIds: string[] } | null;
} = {}) {
  const refs = new Set(options.refs ?? []);
  const assetRow = options.asset === undefined ? attachment : options.asset;
  const repository: AttachmentReadRepository = {
    getAsset: vi.fn(async (id) => id === attachment.id ? assetRow ?? null : null),
    getLegacyAlias: vi.fn(async () => null),
    getSqlScopeEvidence: vi.fn(async (scope) => ({
      scope,
      folderId: "folder-a",
      hasStoredRef: refs.has(`${scope.type}:${scope.id}`),
    })),
    listLegacyCandidateScopes: vi.fn(async () => []),
  };
  const findSession = vi.fn(async (id: string) => id === input.sessionId
    ? options.session ?? { nodeId: input.nodeId, cardId: "card-current", assigneeCardIds: ["card-assigned"] }
    : null);
  const findDelivery = vi.fn(async () => options.delivery ?? null);
  const access = createWorkerAttachmentAccess({ repository, findSession, findDelivery });
  const openObject = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "content-length": "4" },
  }));
  const service = createWorkerAttachmentRead({
    access,
    repository,
    resolveReadStorage: async () => ({
      storage: { openObject },
      identity: "test-binding",
      location: { endpoint: "https://r2.example.test", bucket: "private-attachments" },
    }),
  });
  return { service, repository, findSession, findDelivery, openObject, refs };
}

describe("worker attachment read service", () => {
  it("allows a current session event reference and streams the original bytes", async () => {
    const fixture = makeFixture({ refs: ["session:session-a"] });

    await expect(fixture.service.metadata(input)).resolves.toMatchObject({
      descriptor: { attachment_id: attachment.id },
      upload_status: "committed",
    });
    const response = await fixture.service.content(input);

    expect(await response.text()).toBe("\u0001\u0002\u0003\u0004");
    expect(fixture.repository.getSqlScopeEvidence).toHaveBeenCalledWith(
      { type: "session", id: "session-a" }, attachment.id,
    );
  });

  it("allows the exact canonical delivery attachment as session input", async () => {
    const fixture = makeFixture({ delivery: {
      targetSessionId: input.sessionId,
      attachmentIds: [attachment.id],
    } });

    await expect(fixture.service.content({ ...input, deliveryId: "delivery-a" }))
      .resolves.toMatchObject({ status: 200 });
    expect(fixture.findDelivery).toHaveBeenCalledWith("delivery-a");
  });

  it("allows an actual reference in a card assigned to the current session", async () => {
    const fixture = makeFixture({ refs: ["card:card-assigned"] });

    await expect(fixture.service.metadata({ ...input, mode: "resolve" }))
      .resolves.toMatchObject({ upload_status: "committed" });

    const membership = makeFixture({ refs: ["card:card-current"] });
    await expect(membership.service.metadata({ ...input, mode: "resolve" }))
      .resolves.toMatchObject({ upload_status: "committed" });
  });

  it("rejects canonical delivery-only access for resolve mode", async () => {
    const fixture = makeFixture({ delivery: {
      targetSessionId: input.sessionId,
      attachmentIds: [attachment.id],
    } });

    await expect(fixture.service.metadata({ ...input, mode: "resolve" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_REF_REQUIRED", statusCode: 403 });
    expect(fixture.findDelivery).not.toHaveBeenCalled();
  });

  const deniedCases: Array<[string, Parameters<typeof makeFixture>[0], string]> = [
    ["node mismatch", { session: {
      nodeId: "node-b", cardId: null, assigneeCardIds: [],
    } }, "ATTACHMENT_NODE_MISMATCH"],
    ["another session reference", { refs: ["session:session-b"] }, "ATTACHMENT_REF_REQUIRED"],
    ["registration hint", {
      asset: { ...attachment, registrationScope: { type: "session", id: input.sessionId } },
    }, "ATTACHMENT_REF_REQUIRED"],
    ["owner identity", {
      asset: { ...attachment, ownerKind: "agent_session", ownerKey: input.sessionId },
    }, "ATTACHMENT_REF_REQUIRED"],
  ];
  it.each(deniedCases)("rejects $0", async (_name, fixtureOptions, code) => {
    const fixture = makeFixture(fixtureOptions);
    await expect(fixture.service.metadata(input)).rejects.toMatchObject({ code, statusCode: 403 });
  });

  it("requires a matching delivery target and rejects delivery IDs in resolve mode", async () => {
    const wrongTarget = makeFixture({ delivery: {
      targetSessionId: "session-other",
      attachmentIds: [attachment.id],
    } });
    await expect(wrongTarget.service.metadata({ ...input, deliveryId: "delivery-a" }))
      .rejects.toMatchObject({ statusCode: 403 });

    const omittedAttachment = makeFixture({ delivery: {
      targetSessionId: input.sessionId,
      attachmentIds: [],
    } });
    await expect(omittedAttachment.service.metadata({ ...input, deliveryId: "delivery-a" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_REF_REQUIRED", statusCode: 403 });

    const invalidContext = makeFixture();
    await expect(invalidContext.service.metadata({ ...input, mode: "resolve", deliveryId: "delivery-a" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_INVALID_CONTEXT", statusCode: 422 });
  });

  it("preserves missing and pending read outcomes", async () => {
    const missing = makeFixture({ asset: null });
    await expect(missing.service.metadata(input))
      .rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND", statusCode: 404 });
    expect(missing.findSession).not.toHaveBeenCalled();

    const pending = makeFixture({
      refs: ["session:session-a"],
      asset: { ...attachment, uploadStatus: "pending" },
    });
    await expect(pending.service.metadata(input))
      .rejects.toMatchObject({ code: "ATTACHMENT_NOT_COMMITTED", statusCode: 409 });
  });

  it("authorizes content independently after metadata", async () => {
    const fixture = makeFixture({ refs: ["session:session-a"] });
    await fixture.service.metadata(input);
    fixture.refs.delete("session:session-a");

    await expect(fixture.service.content(input))
      .rejects.toMatchObject({ code: "ATTACHMENT_REF_REQUIRED", statusCode: 403 });
    expect(fixture.openObject).not.toHaveBeenCalled();
  });

  it("reads the worker session, assigned cards and canonical delivery from central SQL", async () => {
    const sqlCalls: Array<{ query: string; values: unknown[] }> = [];
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ").replace(/\s+/g, " ").toLowerCase();
      sqlCalls.push({ query, values });
      if (query.includes("left join cards c")) return [{
        node_id: "node-a",
        card_id: "card-current",
        assignee_card_id: "card-assigned",
      }];
      if (query.includes("from session_deliveries")) return [{
        target_session_id: "session-a",
        payload: { attachment_ids: [attachment.id] },
      }];
      if (query.includes("from events e")) return [{
        id: "session-a",
        folder_id: "folder-a",
        has_stored_ref: true,
      }];
      if (query.includes("from cards c")) return [{
        id: "card-current",
        folder_id: "folder-a",
        has_stored_ref: true,
      }];
      return [];
    }, { json: vi.fn((value: unknown) => value) }) as unknown as LivePostgresSql;
    const resolver: LiveDbSqlResolver = { resolveSql: async () => sql, close: async () => undefined };
    const repository = createLiveWorkerAttachmentRepository(resolver);

    await expect(repository.findSession(input.sessionId)).resolves.toEqual({
      nodeId: input.nodeId,
      cardId: "card-current",
      assigneeCardIds: ["card-assigned"],
    });
    await expect(repository.findDelivery("delivery-a")).resolves.toEqual({
      targetSessionId: input.sessionId,
      attachmentIds: [attachment.id],
    });
    await expect(repository.getSqlScopeEvidence({ type: "session", id: input.sessionId }, attachment.id))
      .resolves.toMatchObject({ hasStoredRef: true });
    expect(sqlCalls.some(({ query }) => query.includes("where s.session_id ="))).toBe(true);
    expect(sqlCalls.some(({ query }) => query.includes("where delivery_id ="))).toBe(true);
  });
});
