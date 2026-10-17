import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backfillCardRefsTx,
  type CardRefSource,
  type ResolvedCardAlias,
} from "../../scripts/attachment-migration/backfill_card_refs.js";
import type { AttachmentReadActor } from "../../src/attachments/attachment_read_service.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../page/page_postgres_harness.js";
import { createLiveTestAttachmentService } from "./live_attachment_access_fixture.js";

const cardId = "card-ref-target";
const requestUrl = legacyUrl("request.png");
const evidenceUrl = legacyUrl("evidence.png");
const resultUrl = legacyUrl("result.png");
const reportUrl = legacyUrl("report.png");
const commentUrl = legacyUrl("comment.png");
const noteUrl = legacyUrl("note.png");
const historyUrl = legacyUrl("history.png");
const approvedOrigin = "https://soulstream.eiaserinnys.me";
const requestBody = `요청 ![첨부](${requestUrl})`;
const resultBody = `결과 ![첨부](${resultUrl})`;
const reportBody = `<p><img src="${reportUrl.replace(/&/g, "&amp;")}"></p>`;
const commentBody = `커멘트 ![첨부](${commentUrl})`;
const noteBody = `노트 ![첨부](${noteUrl})`;
const operationPayload = {
  evidence: [{ type: "image", label: "역사 증거", url: historyUrl }],
  result: `역사 결과 ![첨부](${legacyUrl("history-result.png")})`,
  caveat: "역사 원문 유지",
};

describe("card ref backfill PostgreSQL contract", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`INSERT INTO folders (id, name) VALUES
      ('card-ref-folder', '첨부 ref 검증'), ('card-ref-other-folder', '다른 권한 폴더')`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, folder_id)
      VALUES ('card-ref-producer', 'node-a', 'card-ref-folder'),
        ('card-ref-reader', 'node-a', 'card-ref-folder')
    `;
    await harness.sql`
      INSERT INTO cards (
        id, folder_id, position_key, title, request, attachments, attachment_refs, items, version, status, blocked_detail
      ) VALUES (
        ${cardId}, 'card-ref-folder', 'a0', '첨부 카드', ${requestBody},
        ${harness.sql.json([{ nodeId: "node-a", path: "structured.png", name: "structured.png" }])}::jsonb,
        ${harness.sql.json([])}::jsonb,
        ${harness.sql.json([{
          id: 1, title: "검증 항목", state: "done", result: resultBody,
          evidence: [{ type: "image", label: "현재 증거", url: evidenceUrl }],
          caveat: "항목 주의", rev: 4, confirmed: { at: "2026-10-16T12:00:00.000Z", rev: 4 },
          fixOpen: 0, reopened: null, from: null, createdAt: "2026-10-16T00:00:00.000Z", reportedAt: null,
        }])}::jsonb,
        7, 'review', '카드 상태 보존'
      )
    `;
    await harness.sql`
      INSERT INTO cards (id, folder_id, position_key, title, request, version)
      VALUES ('card-ref-other', 'card-ref-folder', 'a1', '다른 카드', '그대로', 3)
    `;
    await insertAsset("asset-shared", 8);
    await insertAsset("asset-result", 9);
    await insertAsset("asset-report", 10);
    await insertAsset("asset-comment", 11);
    await insertAsset("asset-note", 12);
    await insertAsset("asset-history", 13);
    await harness.sql`
      INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES
        ('node-a', 'request.png', 'asset-shared', 'request.png', 'resolved'),
        ('node-a', 'structured.png', 'asset-shared', 'structured.png', 'resolved'),
        ('node-a', 'evidence.png', 'asset-shared', 'evidence.png', 'resolved'),
        ('node-a', 'result.png', 'asset-result', 'result.png', 'resolved'),
        ('node-a', 'report.png', 'asset-report', 'report.png', 'resolved'),
        ('node-a', 'comment.png', 'asset-comment', 'comment.png', 'resolved'),
        ('node-a', 'note.png', 'asset-note', 'note.png', 'resolved'),
        ('node-a', 'history.png', 'asset-history', 'history.png', 'resolved')
    `;
    await harness.sql`
      INSERT INTO card_reports (id, card_id, title, format, body)
      VALUES ('card-ref-report', ${cardId}, 'HTML 보고', 'html', ${reportBody})
    `;
    await harness.sql`
      INSERT INTO card_comments (id, card_id, author_kind, kind, body)
      VALUES ('card-ref-comment', ${cardId}, 'user', 'comment', ${commentBody}),
        ('card-ref-note', ${cardId}, 'agent', 'note', ${noteBody})
    `;
    await harness.sql`
      INSERT INTO folder_operations (id, folder_id, target_kind, target_id, operation_type, payload_json)
      VALUES ('card-ref-history', 'card-ref-folder', 'card', ${cardId}, 'report_card_item',
        ${harness.sql.json(operationPayload)}::jsonb)
    `;
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  it("stores each source ref, transitions current evidence, preserves original bodies and gates card reads", async () => {
    const sources = cardSources();
    const resolvedAliases = aliases();
    const service = await createLiveTestAttachmentService(harness.liveSql, {
      "reader@example.com": ["card-ref-folder"], "outsider@example.com": ["card-ref-other-folder"],
    });
    const reader: AttachmentReadActor = { kind: "user", email: "reader@example.com" };
    await expect(service.content(reader, "asset-shared", { type: "card", id: cardId }, { method: "GET" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_ACCESS_DENIED", statusCode: 403 });
    const result = await backfillCardRefsTx(harness.liveSql as never, {
      cardId, expectedVersion: 7, sources, resolvedAliases,
    });

    expect(result.status).toBe("updated");
    const card = (await harness.sql<{
      version: number; status: string; blocked_detail: string; request: string; attachments: unknown;
      items: unknown; attachment_refs: unknown; attachment_refs_kind: string;
    }[]>`
      SELECT version, status, blocked_detail, request, attachments, items, attachment_refs,
        jsonb_typeof(attachment_refs) AS attachment_refs_kind
      FROM cards WHERE id=${cardId}
    `)[0]!;
    expect(card.version).toBe(8);
    expect(card.status).toBe("review");
    expect(card.blocked_detail).toBe("카드 상태 보존");
    expect(card.request).toBe(requestBody);
    expect(card.attachments).toEqual([{ nodeId: "node-a", path: "structured.png", name: "structured.png" }]);
    expect(card.attachment_refs_kind).toBe("array");
    expect(card.attachment_refs).toEqual([
      { attachment_id: "asset-shared", legacy_url: requestUrl },
      { attachment_id: "asset-result", legacy_url: resultUrl },
      { attachment_id: "asset-history", legacy_url: historyUrl },
    ]);
    expect(card.items).toEqual([{
      id: 1, title: "검증 항목", state: "done", result: resultBody,
      evidence: [{ type: "image", label: "현재 증거", attachment_id: "asset-shared" }],
      caveat: "항목 주의", rev: 4, confirmed: { at: "2026-10-16T12:00:00.000Z", rev: 4 },
      fixOpen: 0, reopened: null, from: null, createdAt: "2026-10-16T00:00:00.000Z", reportedAt: null,
    }]);

    const report = (await harness.sql<{ body: string; attachment_refs: unknown; refs_kind: string }[]>`
      SELECT body, attachment_refs, jsonb_typeof(attachment_refs) AS refs_kind
      FROM card_reports WHERE id='card-ref-report'
    `)[0]!;
    expect(report.body).toBe(reportBody);
    expect(report.refs_kind).toBe("array");
    expect(report.attachment_refs).toEqual([{ attachment_id: "asset-report", legacy_url: reportUrl }]);
    const comments = await harness.sql<{ id: string; body: string; attachment_refs: unknown; refs_kind: string }[]>`
      SELECT id, body, attachment_refs, jsonb_typeof(attachment_refs) AS refs_kind
      FROM card_comments WHERE card_id=${cardId} ORDER BY id
    `;
    expect(comments).toEqual([
      { id: "card-ref-comment", body: commentBody, attachment_refs: [{ attachment_id: "asset-comment", legacy_url: commentUrl }], refs_kind: "array" },
      { id: "card-ref-note", body: noteBody, attachment_refs: [{ attachment_id: "asset-note", legacy_url: noteUrl }], refs_kind: "array" },
    ]);
    const operation = (await harness.sql<{ payload_json: unknown; payload_kind: string }[]>`
      SELECT payload_json, jsonb_typeof(payload_json) AS payload_kind
      FROM folder_operations WHERE id='card-ref-history'
    `)[0]!;
    expect(operation.payload_kind).toBe("object");
    expect(operation.payload_json).toEqual(operationPayload);

    const aliasRows = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM attachment_legacy_aliases WHERE node_id='node-a'
    `;
    expect(aliasRows[0]!.count).toBe(8);

    await harness.sql`DELETE FROM sessions WHERE session_id='card-ref-producer'`;
    const content = await service.content(reader, "asset-shared", { type: "card", id: cardId }, { method: "GET" });
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([1, 2, 3]);
    await expect(service.content({ kind: "user", email: "outsider@example.com" }, "asset-shared", { type: "card", id: cardId }, { method: "GET" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.content(reader, "asset-shared", { type: "card", id: "card-ref-other" }, { method: "GET" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_ACCESS_DENIED", statusCode: 403 });
  });

  it("does not overwrite concurrent card edits or sources that no longer match", async () => {
    await insertBackfillCard("card-ref-version", "원래 요청", 1);
    const source = reference("card_request", "cards", "card-ref-version", "/request", "request.png", requestUrl);
    await harness.sql`UPDATE cards SET version=2 WHERE id='card-ref-version'`;
    await expect(backfillCardRefsTx(harness.liveSql as never, {
      cardId: "card-ref-version", expectedVersion: 1, sources: [source], resolvedAliases: [aliases()[0]!],
    })).rejects.toMatchObject({ code: "CARD_VERSION_CONFLICT" });
    const versionCard = (await harness.sql<{ request: string; attachment_refs: unknown; version: number }[]>`
      SELECT request, attachment_refs, version FROM cards WHERE id='card-ref-version'
    `)[0]!;
    expect(versionCard).toEqual({ request: "원래 요청", attachment_refs: [], version: 2 });

    await insertBackfillCard("card-ref-changed", "요청이 바뀜", 1);
    const stale = reference("card_request", "cards", "card-ref-changed", "/request", "request.png", requestUrl);
    await expect(backfillCardRefsTx(harness.liveSql as never, {
      cardId: "card-ref-changed", expectedVersion: 1, sources: [stale], resolvedAliases: [aliases()[0]!],
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const changedCard = (await harness.sql<{ request: string; attachment_refs: unknown; version: number }[]>`
      SELECT request, attachment_refs, version FROM cards WHERE id='card-ref-changed'
    `)[0]!;
    expect(changedCard).toEqual({ request: "요청이 바뀜", attachment_refs: [], version: 1 });
  });

  it("revalidates exact approved absolute URLs and rejects unapproved origins", async () => {
    const approvedUrl = `${approvedOrigin}${legacyUrl("request.png")}`;
    await insertBackfillCard("card-ref-approved-url", `![x](${approvedUrl})`, 1);
    const approvedSource = reference("card_request", "cards", "card-ref-approved-url", "/request", "request.png", approvedUrl,
      `![x](${approvedUrl})`.indexOf(approvedUrl));
    const applied = await backfillCardRefsTx(harness.liveSql as never, {
      cardId: "card-ref-approved-url", expectedVersion: 1, sources: [approvedSource], resolvedAliases: [aliases()[0]!],
      allowedOrigins: [approvedOrigin],
    });
    expect(applied).toEqual({ status: "updated", sources_verified: 1 });
    const approvedStored = (await harness.sql<{ request: string; attachment_refs: unknown; version: number }[]>`
      SELECT request, attachment_refs, version FROM cards WHERE id='card-ref-approved-url'
    `)[0]!;
    expect(approvedStored).toEqual({
      request: `![x](${approvedUrl})`, attachment_refs: [{ attachment_id: "asset-shared", legacy_url: legacyUrl("request.png") }], version: 2,
    });

    const externalUrl = `https://outside.example.test${legacyUrl("request.png")}`;
    await insertBackfillCard("card-ref-external-url", `![x](${externalUrl})`, 1);
    const externalSource = reference("card_request", "cards", "card-ref-external-url", "/request", "request.png", externalUrl,
      `![x](${externalUrl})`.indexOf(externalUrl));
    await expect(backfillCardRefsTx(harness.liveSql as never, {
      cardId: "card-ref-external-url", expectedVersion: 1, sources: [externalSource], resolvedAliases: [aliases()[0]!],
      allowedOrigins: [approvedOrigin],
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const externalStored = (await harness.sql<{ request: string; attachment_refs: unknown; version: number }[]>`
      SELECT request, attachment_refs, version FROM cards WHERE id='card-ref-external-url'
    `)[0]!;
    expect(externalStored).toEqual({ request: `![x](${externalUrl})`, attachment_refs: [], version: 1 });
  });

  async function insertBackfillCard(id: string, request: string, version: number): Promise<void> {
    await harness.sql`
      INSERT INTO cards (id, folder_id, position_key, title, request, version)
      VALUES (${id}, 'card-ref-folder', ${id}, ${id}, ${request}, ${version})
    `;
  }

  async function insertAsset(id: string, byteSize: number): Promise<void> {
    await harness.sql`
      INSERT INTO file_assets (
        id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
        original_name, mime_type, byte_size, upload_status, source_session_id
      ) VALUES (
        ${id}, ${`private/${id}`}, 'attachment', 'https://r2.example.test', 'private-attachments',
        ${`${id}.png`}, 'image/png', ${byteSize}, 'committed', 'card-ref-producer'
      )
    `;
  }
});

function cardSources(): CardRefSource[] {
  return [
    reference("card_request", "cards", cardId, "/request", "request.png", requestUrl, requestBody.indexOf(requestUrl)),
    reference("card_request", "cards", cardId, "/attachments/0/path", "structured.png"),
    reference("card_item", "cards", cardId, "/items/0/evidence/0/url", "evidence.png", evidenceUrl),
    reference("card_item", "cards", cardId, "/items/0/result", "result.png", resultUrl, resultBody.indexOf(resultUrl)),
    reference("report", "card_reports", "card-ref-report", "/body", "report.png", reportUrl, reportBody.indexOf("src=")),
    reference("comment", "card_comments", "card-ref-comment", "/body", "comment.png", commentUrl, commentBody.indexOf(commentUrl)),
    reference("note", "card_comments", "card-ref-note", "/body", "note.png", noteUrl, noteBody.indexOf(noteUrl)),
    reference("item_history", "folder_operations", "card-ref-history", "/payload_json/evidence/0/url", "history.png", historyUrl),
  ];
}

function reference(
  sourceKind: CardRefSource["reference"]["source_kind"],
  sourceTable: CardRefSource["reference"]["source_table"],
  sourcePk: string,
  pointer: string,
  normalizedPath: string,
  rawUrl?: string,
  bodyOffset?: number,
): CardRefSource {
  const legacyPath = normalizedPath;
  return {
    identity_key: `node-a\u0000${normalizedPath}`,
    legacy_node_id: "node-a",
    normalized_path: normalizedPath,
    reference: {
      source_kind: sourceKind, source_table: sourceTable, source_pk: sourcePk, pointer,
      ...(sourceKind === "item_history" ? { operation_id: sourcePk } : {}),
      ...(sourceTable === "cards" ? { card_id: sourcePk } : { card_id: cardId }),
      ...(sourceKind === "message" ? { session_id: "unused-session", event_id: 1 } : {}),
      ...(rawUrl === undefined ? { raw_path: legacyPath } : { raw_url: rawUrl, raw_path: legacyPath }),
      ...(bodyOffset === undefined ? {} : { body_offset: bodyOffset }),
      changed_after_cutoff: false,
      owner: { status: "unverified", reason: "fixture", source: "fixture" },
    },
  };
}

function aliases(): ResolvedCardAlias[] {
  return [
    { node_id: "node-a", normalized_path: "request.png", attachment_id: "asset-shared" },
    { node_id: "node-a", normalized_path: "structured.png", attachment_id: "asset-shared" },
    { node_id: "node-a", normalized_path: "evidence.png", attachment_id: "asset-shared" },
    { node_id: "node-a", normalized_path: "result.png", attachment_id: "asset-result" },
    { node_id: "node-a", normalized_path: "report.png", attachment_id: "asset-report" },
    { node_id: "node-a", normalized_path: "comment.png", attachment_id: "asset-comment" },
    { node_id: "node-a", normalized_path: "note.png", attachment_id: "asset-note" },
    { node_id: "node-a", normalized_path: "history.png", attachment_id: "asset-history" },
  ];
}

function legacyUrl(path: string): string {
  const query = new URLSearchParams({ nodeId: "node-a", path });
  return `/api/attachments/files?${query.toString()}`;
}
