import { describe, expect, it, vi } from "vitest";

import { createAgentAttachmentRegistration } from "../src/attachments/agent_attachment_registration.js";
import type { OwnedAttachmentCommitService } from "../src/attachments/attachment_commit_contract.js";
import { AttachmentCommitError } from "../src/attachments/attachment_commit_service.js";
import type { AttachmentAssetRow } from "../src/attachments/attachment_read_service.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";

const CHECKSUM = "a".repeat(64);

function makeSql(options: {
  sessions?: Array<Record<string, unknown>>;
  cards?: Array<Record<string, unknown>>;
}) {
  const calls: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push(text.replace(/\s+/g, " ").trim());
    if (text.includes("FROM sessions")) return options.sessions ?? [];
    if (text.includes("FROM cards")) return options.cards ?? [];
    void values;
    return [];
  }) as unknown as RepositorySql;
  return { sql, calls };
}

function makeCommit(overrides: { checksumSha256?: string; fail?: Error } = {}) {
  const putSmall = vi.fn(async ({ spec }: { spec: { attachmentId: string; originalName: string; mimeType: string; byteSize: number; checksumSha256?: string } }) => {
    if (overrides.fail) throw overrides.fail;
    return {
      attachmentId: spec.attachmentId,
      storageKey: `session-attachments/originals/${spec.attachmentId}`,
      storageEndpoint: "https://r2.example",
      storageBucket: "soulstream",
      originalName: spec.originalName,
      mimeType: spec.mimeType,
      byteSize: spec.byteSize,
      checksumSha256: overrides.checksumSha256 ?? (spec.checksumSha256 ?? CHECKSUM).toLowerCase(),
    };
  });
  return { commit: { putSmall } as unknown as OwnedAttachmentCommitService, putSmall };
}

function makeAsset(overrides: Partial<AttachmentAssetRow> = {}): AttachmentAssetRow {
  return {
    id: "asset-1",
    storageKey: "session-attachments/originals/asset-1",
    storagePurpose: "attachment",
    storageEndpoint: "https://r2.example",
    storageBucket: "soulstream",
    ownerKind: "agent_session",
    ownerKey: "session-1",
    registrationScope: { type: "card", id: "card-1" },
    sourceSessionId: "session-1",
    originalName: "report.csv",
    mimeType: "text/csv",
    byteSize: 4,
    width: null,
    height: null,
    checksumSha256: CHECKSUM,
    uploadStatus: "committed",
    ...overrides,
  };
}

const sessionRow = { node_id: "node-1", card_id: "card-1", execution_command_id: "exec-1" };
const producer = { sessionId: "session-1", nodeId: "node-1", outputCommandId: "exec-1" };

function input(overrides: Partial<{ producer: typeof producer; targetScope: { type: "card"; id: string } | null }> = {}) {
  return {
    producer: overrides.producer ?? producer,
    targetScope: overrides.targetScope === undefined ? { type: "card" as const, id: "card-1" } : overrides.targetScope,
    name: "report.csv",
    mimeType: "text/csv",
    byteSize: 4,
    checksumSha256: CHECKSUM,
    body: new Uint8Array([1, 2, 3, 4]),
    signal: new AbortController().signal,
  };
}

describe("agent attachment registration", () => {
  it("registers the producer-owned asset and returns the shared descriptor", async () => {
    const { sql } = makeSql({ sessions: [sessionRow], cards: [{ id: "card-1", assignee_session_id: "session-1" }] });
    const { commit, putSmall } = makeCommit();
    const readAsset = vi.fn(async (id: string) => makeAsset({ id }));
    const register = createAgentAttachmentRegistration({ sql, commit, readAsset });

    const result = await register(input());

    expect(putSmall).toHaveBeenCalledOnce();
    const call = putSmall.mock.calls[0]![0] as unknown as { spec: Record<string, unknown>; body: Uint8Array };
    expect(call.spec).toMatchObject({
      owner: { kind: "agent_session", key: "session-1" },
      registration: {
        registrationScope: { type: "card", id: "card-1" },
        sourceNodeId: "node-1",
        sourceSessionId: "session-1",
        outputCommandId: "exec-1",
      },
      originalName: "report.csv",
      mimeType: "text/csv",
      byteSize: 4,
      checksumSha256: CHECKSUM,
    });
    expect(call.body).toBeInstanceOf(Uint8Array);
    expect(readAsset).toHaveBeenCalledWith(result.attachment_id);
    expect(result.descriptor).toEqual({
      attachment_id: result.attachment_id,
      name: "report.csv",
      mime_type: "text/csv",
      byte_size: 4,
      checksum_sha256: CHECKSUM,
      width: null,
      height: null,
      preview_kind: "text",
      preview_mime_type: "text/plain",
    });
  });

  it("scopes registration to the owner when no card is given", async () => {
    const { sql } = makeSql({ sessions: [sessionRow] });
    const { commit, putSmall } = makeCommit();
    const register = createAgentAttachmentRegistration({
      sql,
      commit,
      readAsset: async (id) => makeAsset({ id, registrationScope: null }),
    });

    const result = await register(input({ targetScope: null }));

    const call = putSmall.mock.calls[0]![0] as unknown as { spec: { registration: Record<string, unknown> } };
    expect(call.spec.registration.registrationScope).toBeNull();
    expect(result.attachment_id).toHaveLength(36);
  });

  it("rejects a producer that does not match the trusted session before committing", async () => {
    const { sql } = makeSql({ sessions: [{ ...sessionRow, node_id: "other-node" }] });
    const { commit, putSmall } = makeCommit();
    const register = createAgentAttachmentRegistration({ sql, commit, readAsset: async () => makeAsset() });

    await expect(register(input())).rejects.toMatchObject({
      statusCode: 403,
      code: "ATTACHMENT_PRODUCER_MISMATCH",
    });
    expect(putSmall).not.toHaveBeenCalled();
  });

  it("does not return a success id when the commit fails", async () => {
    const { sql } = makeSql({ sessions: [sessionRow], cards: [{ id: "card-1", assignee_session_id: "session-1" }] });
    const failure = new AttachmentCommitError("storage_unavailable", 503, "storage down");
    const { commit } = makeCommit({ fail: failure });
    const register = createAgentAttachmentRegistration({ sql, commit, readAsset: async () => makeAsset() });

    await expect(register(input())).rejects.toBe(failure);
  });

  it("does not return a success id when the committed asset cannot be re-read", async () => {
    const { sql } = makeSql({ sessions: [sessionRow], cards: [{ id: "card-1", assignee_session_id: "session-1" }] });
    const { commit } = makeCommit();
    const register = createAgentAttachmentRegistration({ sql, commit, readAsset: async () => makeAsset({ uploadStatus: "pending" }) });

    await expect(register(input())).rejects.toMatchObject({ code: "ATTACHMENT_REGISTRATION_FAILED" });
  });

  it("does not return a success id when the stored checksum differs from the commit", async () => {
    const { sql } = makeSql({ sessions: [sessionRow], cards: [{ id: "card-1", assignee_session_id: "session-1" }] });
    const { commit } = makeCommit();
    const register = createAgentAttachmentRegistration({ sql, commit, readAsset: async () => makeAsset({ checksumSha256: "b".repeat(64) }) });

    await expect(register(input())).rejects.toMatchObject({ code: "ATTACHMENT_REGISTRATION_FAILED" });
  });
});
