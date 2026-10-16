import { describe, expect, it } from "vitest";
import {
  assertAttachmentProducerTx,
  requireCardAttachmentTx,
  type TrustedAttachmentProducer,
} from "../src/cards/card_attachment_policy.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";

type Handler = (text: string, values: unknown[]) => readonly Record<string, unknown>[];

function fakeSql(handler: Handler): { sql: RepositorySql; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve(handler(text, values));
  }) as unknown as RepositorySql;
  return { sql, calls };
}

async function rejection(promise: Promise<unknown>): Promise<{ statusCode?: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; code?: string };
  }
  throw new Error("expected the call to reject");
}

const producer: TrustedAttachmentProducer = {
  sessionId: "session-owner",
  nodeId: "node-a",
  outputCommandId: "command-1",
};

const producerSession = { node_id: "node-a", card_id: "card-1", execution_command_id: "command-1" };

function committedAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "asset-1",
    storage_key: "session-attachments/originals/asset-1",
    storage_purpose: "attachment",
    storage_endpoint: "https://r2.example.test",
    storage_bucket: "private-files",
    owner_kind: "agent_session",
    owner_key: "session-owner",
    registration_scope: { type: "card", id: "card-1" },
    source_session_id: "session-owner",
    original_name: "photo.png",
    mime_type: "image/png",
    byte_size: "2048",
    width: 100,
    height: 80,
    checksum_sha256: null,
    upload_status: "committed",
    ...overrides,
  };
}

describe("assertAttachmentProducerTx", () => {
  it("accepts the card assignee producing a card-scoped attachment", async () => {
    const { sql } = fakeSql((text) =>
      text.includes("FROM sessions")
        ? [producerSession]
        : [{ id: "card-1", assignee_session_id: "session-owner" }],
    );
    await expect(assertAttachmentProducerTx(sql, producer, { type: "card", id: "card-1" })).resolves.toBeUndefined();
  });

  it("accepts a card session (not the assignee) producing a card-scoped attachment", async () => {
    const { sql } = fakeSql((text) =>
      text.includes("FROM sessions")
        ? [producerSession]
        : [{ id: "card-1", assignee_session_id: "someone-else" }],
    );
    await expect(assertAttachmentProducerTx(sql, producer, { type: "card", id: "card-1" })).resolves.toBeUndefined();
  });

  it("stops before the card lookup when the scope is null", async () => {
    const { sql, calls } = fakeSql(() => [producerSession]);
    await assertAttachmentProducerTx(sql, producer, null);
    expect(calls.some((call) => call.text.includes("FROM cards"))).toBe(false);
  });

  it("rejects an unknown producer session, a node mismatch and a commandless session", async () => {
    const unknown = fakeSql(() => []).sql;
    expect(await rejection(assertAttachmentProducerTx(unknown, producer, null))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_PRODUCER_MISMATCH",
    });

    const wrongNode = fakeSql(() => [{ ...producerSession, node_id: "node-b" }]).sql;
    expect(await rejection(assertAttachmentProducerTx(wrongNode, producer, null))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_PRODUCER_MISMATCH",
    });

    const commandless = fakeSql(() => [{ ...producerSession, execution_command_id: null }]).sql;
    expect(await rejection(assertAttachmentProducerTx(commandless, producer, null))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_PRODUCER_MISMATCH",
    });
  });

  it("rejects a missing card and an unrelated producer", async () => {
    const missingCard = fakeSql((text) => (text.includes("FROM sessions") ? [producerSession] : [])).sql;
    expect(await rejection(assertAttachmentProducerTx(missingCard, producer, { type: "card", id: "card-1" }))).toMatchObject({
      statusCode: 404,
      code: "CARD_NOT_FOUND",
    });

    const unrelated = fakeSql((text) =>
      text.includes("FROM sessions")
        ? [{ node_id: "node-a", card_id: "card-9", execution_command_id: "command-1" }]
        : [{ id: "card-1", assignee_session_id: "someone-else" }],
    ).sql;
    expect(await rejection(assertAttachmentProducerTx(unrelated, producer, { type: "card", id: "card-1" }))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_CARD_SCOPE_DENIED",
    });
  });
});

describe("requireCardAttachmentTx", () => {
  const card = { id: "card-1", assignee_session_id: "session-owner" };
  const actor = { sessionId: "session-owner" };

  it("returns the mapped asset for the assignee's card-scoped file without leaking producer storage fields", async () => {
    const { sql } = fakeSql(() => [committedAsset()]);
    const asset = await requireCardAttachmentTx(sql, card, actor, "asset-1", "image");
    expect(asset).toEqual({
      id: "asset-1",
      storageKey: "session-attachments/originals/asset-1",
      storagePurpose: "attachment",
      storageEndpoint: "https://r2.example.test",
      storageBucket: "private-files",
      ownerKind: "agent_session",
      ownerKey: "session-owner",
      registrationScope: { type: "card", id: "card-1" },
      sourceSessionId: "session-owner",
      originalName: "photo.png",
      mimeType: "image/png",
      byteSize: 2048,
      width: 100,
      height: 80,
      checksumSha256: null,
      uploadStatus: "committed",
    });
    expect(asset).not.toHaveProperty("sourceNodeId");
    expect(asset).not.toHaveProperty("outputCommandId");
  });

  it("lets the card session's own registration link to the card", async () => {
    const { sql } = fakeSql((text) =>
      text.includes("FROM file_assets")
        ? [committedAsset({ owner_key: "session-member", source_session_id: "session-member" })]
        : [{ session_id: "session-member" }],
    );
    await expect(requireCardAttachmentTx(sql, card, actor, "asset-1", "image")).resolves.toMatchObject({
      ownerKey: "session-member",
    });
  });

  it("allows an unscoped file only for the current assignee", async () => {
    const { sql } = fakeSql(() => [committedAsset({ registration_scope: null })]);
    await expect(requireCardAttachmentTx(sql, card, actor, "asset-1", "link")).resolves.toMatchObject({ ownerKey: "session-owner" });

    const foreign = fakeSql(() => [committedAsset({ registration_scope: null, owner_key: "session-other", source_session_id: "session-other" })]).sql;
    expect(await rejection(requireCardAttachmentTx(foreign, card, actor, "asset-1", "link"))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_LINK_DENIED",
    });
  });

  it("rejects a different scope, a non-agent owner and a producer mismatch", async () => {
    const otherCard = fakeSql(() => [committedAsset({ registration_scope: { type: "card", id: "card-2" } })]).sql;
    expect(await rejection(requireCardAttachmentTx(otherCard, card, actor, "asset-1", "image"))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_CARD_SCOPE_DENIED",
    });

    const userOwned = fakeSql(() => [committedAsset({ owner_kind: "user_email", owner_key: "owner@example.test" })]).sql;
    expect(await rejection(requireCardAttachmentTx(userOwned, card, actor, "asset-1", "link"))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_LINK_DENIED",
    });

    const mismatch = fakeSql(() => [committedAsset({ source_session_id: "session-other" })]).sql;
    expect(await rejection(requireCardAttachmentTx(mismatch, card, actor, "asset-1", "image"))).toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_LINK_DENIED",
    });
  });

  it("rejects a missing, pending or non-attachment asset", async () => {
    const missing = fakeSql(() => []).sql;
    expect(await rejection(requireCardAttachmentTx(missing, card, actor, "asset-1", "link"))).toMatchObject({
      statusCode: 404,
      code: "ATTACHMENT_NOT_FOUND",
    });

    const pending = fakeSql(() => [committedAsset({ upload_status: "pending" })]).sql;
    expect(await rejection(requireCardAttachmentTx(pending, card, actor, "asset-1", "link"))).toMatchObject({
      statusCode: 409,
      code: "ATTACHMENT_NOT_COMMITTED",
    });
  });

  it("requires an image MIME for image evidence and accepts an opaque link", async () => {
    const opaque = fakeSql(() => [committedAsset({ mime_type: "application/octet-stream" })]).sql;
    expect(await rejection(requireCardAttachmentTx(opaque, card, actor, "asset-1", "image"))).toMatchObject({
      statusCode: 422,
      code: "ATTACHMENT_IMAGE_REQUIRED",
    });
    await expect(requireCardAttachmentTx(opaque, card, actor, "asset-1", "link")).resolves.toMatchObject({
      mimeType: "application/octet-stream",
    });
  });

  it("rejects a missing caller session", async () => {
    const { sql } = fakeSql(() => [committedAsset()]);
    expect(await rejection(requireCardAttachmentTx(sql, card, { sessionId: "" }, "asset-1", "link"))).toMatchObject({
      statusCode: 401,
      code: "ATTACHMENT_UNAUTHENTICATED",
    });
  });
});
