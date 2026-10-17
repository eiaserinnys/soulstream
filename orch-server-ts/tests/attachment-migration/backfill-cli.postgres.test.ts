import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCardBackfillCli } from "../../scripts/attachment-migration/backfill_card_refs.js";
import { runMessageBackfillCli } from "../../scripts/attachment-migration/backfill_message_refs.js";
import { INVENTORY_SCHEMA_VERSION } from "../../scripts/attachment-migration/inventory_contract.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../page/page_postgres_harness.js";
import { createLiveTestAttachmentService } from "./live_attachment_access_fixture.js";

const origin = "https://soulstream.eiaserinnys.me";
const folder = "backfill-cli-folder";

describe("attachment ref backfill CLI PostgreSQL contract", () => {
  let harness: PagePostgresHarness;
  let tempDir: string;
  let outputNumber = 0;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    tempDir = await mkdtemp(path.join(tmpdir(), "attachment-backfill-cli-"));
    await harness.sql`INSERT INTO folders (id, name) VALUES
      (${folder}, 'CLI ref 검증'), ('backfill-cli-other-folder', '다른 권한 폴더')`;
    await harness.sql`INSERT INTO sessions (session_id, node_id, folder_id)
      VALUES ('backfill-cli-attachment-producer', 'node-a', ${folder})`;
    await harness.sql`
      INSERT INTO file_assets (
        id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
        original_name, mime_type, byte_size, upload_status, source_session_id
      ) VALUES
        ('existing-asset', 'private/existing-asset', 'attachment', 'https://r2.example.test', 'private-attachments', 'existing.png', 'image/png', 3, 'committed', NULL),
        ('cli-message-asset', 'private/cli-message-asset', 'attachment', 'https://r2.example.test', 'private-attachments', 'message.png', 'image/png', 3, 'committed', NULL),
        ('cli-card-asset', 'private/cli-card-asset', 'attachment', 'https://r2.example.test', 'private-attachments', 'card.png', 'image/png', 3, 'committed', 'backfill-cli-attachment-producer'),
        ('cli-report-asset', 'private/cli-report-asset', 'attachment', 'https://r2.example.test', 'private-attachments', 'report.png', 'image/png', 3, 'committed', NULL)
    `;
    await harness.sql`
      INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES ('node-a', '/legacy/cli-message.png', 'cli-message-asset', '/legacy/cli-message.png', 'resolved'),
        ('node-a', 'cli-card.png', 'cli-card-asset', 'cli-card.png', 'resolved'),
        ('node-a', 'cli-report.png', 'cli-report-asset', 'cli-report.png', 'resolved')
    `;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("gates writes, honors limit and only, and leaves the full message payload unchanged on rerun", async () => {
    const rows = [101, 102].map((eventId) => ({
      session_id: `backfill-cli-message-${eventId}`, event_id: eventId,
      payload: { text: `message-${eventId}`, attachments: ["/legacy/cli-message.png"], attachment_ids: ["existing-asset"], attachment_count: 2,
        timestamp: "2026-10-17T00:00:00.000Z", caller_info: { source: "browser", id: eventId } },
    }));
    for (const row of rows) {
      await harness.sql`INSERT INTO sessions (session_id, node_id, folder_id) VALUES (${row.session_id}, 'node-a', ${folder})`;
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES (${row.session_id}, ${row.event_id}, 'user_message', ${harness.sql.json(row.payload)}::jsonb, ${`search ${row.event_id}`})
      `;
    }
    const manifest = await writeManifest(rows.map((row) => messageIdentity(row.session_id, row.event_id)));
    const before = await readMessagePayloads(rows);
    const readService = await createLiveTestAttachmentService(harness.liveSql, {
      "reader@example.com": [folder], "outsider@example.com": ["backfill-cli-other-folder"],
    });
    const reader = { kind: "user" as const, email: "reader@example.com" };
    await expect(readService.content(reader, "cli-message-asset", { type: "session", id: rows[0]!.session_id }, { method: "GET" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_ACCESS_DENIED", statusCode: 403 });

    const hashOnly = await invokeMessage(manifest, ["--approved-manifest-sha256", manifest.sha256]);
    expect(hashOnly[0]).toMatchObject({ apply: false, identities_selected: 2, source_events_updated: 0 });
    await expect(invokeMessage(manifest, ["--apply"])).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", "0".repeat(64)]))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await readMessagePayloads(rows)).toEqual(before);

    const limited = await invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256, "--limit", "1"]);
    expect(limited[0]).toMatchObject({ identities_selected: 1, source_events_selected: 1, source_events_updated: 1 });
    await expect(readService.content(reader, "cli-message-asset", { type: "session", id: rows[0]!.session_id }, { method: "GET" }))
      .resolves.toBeInstanceOf(Response);
    await expect(readService.content(reader, "cli-message-asset", { type: "session", id: rows[1]!.session_id }, { method: "GET" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_ACCESS_DENIED", statusCode: 403 });
    const onlySecond = await invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256, "--only", "identity-message-102"]);
    expect(onlySecond[0]).toMatchObject({ identities_selected: 1, source_events_selected: 1, source_events_updated: 1 });

    const afterFirstPass = await readMessagePayloads(rows);
    for (const [index, stored] of afterFirstPass.entries()) {
      expect(stored).toEqual({
        ...rows[index]!.payload, attachment_ids: ["existing-asset", "cli-message-asset"], attachment_count: 3,
      });
    }
    const rerun = await invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256]);
    expect(rerun[0]).toMatchObject({ source_events_updated: 0, source_events_unchanged: 2 });
    expect(await readMessagePayloads(rows)).toEqual(afterFirstPass);
  });

  it("rolls back a message payload update when a database trigger fails afterward", async () => {
    const sessionId = "backfill-cli-message-rollback";
    const eventId = 103;
    const payload = { text: "preserve all", attachments: ["/legacy/cli-message.png"], attachment_ids: [], attachment_count: 1,
      timestamp: "2026-10-17T00:00:00.000Z", caller_info: { source: "browser" } };
    await harness.sql`INSERT INTO sessions (session_id, node_id, folder_id) VALUES (${sessionId}, 'node-a', ${folder})`;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      VALUES (${sessionId}, ${eventId}, 'user_message', ${harness.sql.json(payload)}::jsonb, 'rollback search text')
    `;
    await harness.sql.unsafe(`
      CREATE FUNCTION fail_cli_message_backfill() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.session_id = '${sessionId}' THEN RAISE EXCEPTION 'injected message write failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_cli_message_backfill AFTER UPDATE OF payload ON events
        FOR EACH ROW EXECUTE FUNCTION fail_cli_message_backfill();
    `);
    const manifest = await writeManifest([messageIdentity(sessionId, eventId)]);
    const report = await invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256]);
    expect(report.some((record) => record.code === "P0001")).toBe(true);
    const stored = (await harness.sql<{ payload: unknown; search_vector: string | null }[]>`
      SELECT payload, search_vector::text AS search_vector FROM events WHERE session_id=${sessionId} AND id=${eventId}
    `)[0]!;
    expect(stored.payload).toEqual(payload);
    expect(stored.search_vector).toBe("'rollback':1 'search':2 'text':3");
  });

  it("revalidates message absolute URLs against the explicit origin allowlist", async () => {
    const approvedUrl = `${origin}/api/attachments/files?nodeId=node-a&path=%2Flegacy%2Fcli-message.png`;
    const externalUrl = "https://outside.example.test/api/attachments/files?nodeId=node-a&path=%2Flegacy%2Fcli-message.png";
    const rows = [
      { session_id: "backfill-cli-message-approved-url", event_id: 105, url: approvedUrl },
      { session_id: "backfill-cli-message-external-url", event_id: 106, url: externalUrl },
    ];
    for (const row of rows) {
      await harness.sql`INSERT INTO sessions (session_id, node_id, folder_id) VALUES (${row.session_id}, 'node-a', ${folder})`;
      await harness.sql`INSERT INTO events (session_id, id, event_type, payload)
        VALUES (${row.session_id}, ${row.event_id}, 'user_message', ${harness.sql.json({ text: "keep", attachments: [row.url], attachment_ids: [], attachment_count: 1 })}::jsonb)`;
    }
    const manifest = await writeManifest(rows.map((row) => messageIdentity(
      row.session_id, row.event_id, "/legacy/cli-message.png", "/payload/attachments/0", row.url,
    )));

    const report = await invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256]);
    expect(report[0]).toMatchObject({ source_events_updated: 1 });
    expect(report.some((record) => record.code === "SOURCE_CHANGED" && record.event_id === 106)).toBe(true);
    expect(await readMessagePayloads(rows)).toEqual([
      { text: "keep", attachments: [approvedUrl], attachment_ids: ["cli-message-asset"], attachment_count: 2 },
      { text: "keep", attachments: [externalUrl], attachment_ids: [], attachment_count: 1 },
    ]);
  });

  it("preserves alias deduplication and attachment binding count in PostgreSQL JSONB", async () => {
    const sessionId = "backfill-cli-message-aliases";
    const eventId = 104;
    const payload = {
      text: "three locations",
      attachments: ["/legacy/cli-message.png", "/legacy/cli-message-alias.png"],
      attachment_paths: ["/legacy/cli-message-bound.png"],
      attachment_ids: ["existing-asset"], attachment_count: 44,
      attachment_bindings: [{ attachment_id: "existing-asset", path: "/legacy/cli-message-bound.png" }],
      timestamp: "2026-10-17T00:00:00.000Z", caller_info: { source: "browser" },
    };
    await harness.sql`INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES ('node-a', '/legacy/cli-message-alias.png', 'cli-message-asset', '/legacy/cli-message-alias.png', 'resolved'),
        ('node-a', '/legacy/cli-message-bound.png', 'existing-asset', '/legacy/cli-message-bound.png', 'resolved')`;
    await harness.sql`INSERT INTO sessions (session_id, node_id, folder_id) VALUES (${sessionId}, 'node-a', ${folder})`;
    await harness.sql`INSERT INTO events (session_id, id, event_type, payload) VALUES
      (${sessionId}, ${eventId}, 'user_message', ${harness.sql.json(payload)}::jsonb)`;
    const manifest = await writeManifest([
      messageIdentity(sessionId, eventId, "/legacy/cli-message.png", "/payload/attachments/0"),
      messageIdentity(sessionId, eventId, "/legacy/cli-message-alias.png", "/payload/attachments/1"),
      messageIdentity(sessionId, eventId, "/legacy/cli-message-bound.png", "/payload/attachment_paths/0"),
    ]);
    const report = await invokeMessage(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256]);
    expect(report[0]).toMatchObject({ source_events_updated: 1 });
    const stored = (await harness.sql<{ payload: Record<string, unknown>; payload_type: string; ids_type: string }[]>`
      SELECT payload, jsonb_typeof(payload) AS payload_type,
        jsonb_typeof(payload->'attachment_ids') AS ids_type
      FROM events WHERE session_id=${sessionId} AND id=${eventId}
    `)[0]!;
    expect(stored.payload_type).toBe("object");
    expect(stored.ids_type).toBe("array");
    expect(stored.payload).toEqual({ ...payload, attachment_ids: ["existing-asset", "cli-message-asset"], attachment_count: 4 });
  });

  it("revalidates exact approved card URLs and selects cards through the CLI", async () => {
    const firstUrl = `${origin}/api/attachments/files?nodeId=node-a&path=cli-card.png`;
    const secondUrl = "/api/attachments/files?nodeId=node-a&path=cli-card.png";
    await insertCard("backfill-cli-card-1", `first ![attachment](${firstUrl})`);
    await insertCard("backfill-cli-card-2", `second ![attachment](${secondUrl})`);
    const manifest = await writeManifest([
      cardIdentity("backfill-cli-card-1", firstUrl, "identity-card-1"),
      cardIdentity("backfill-cli-card-2", secondUrl, "identity-card-2"),
    ]);
    const readService = await createLiveTestAttachmentService(harness.liveSql, {
      "reader@example.com": [folder], "outsider@example.com": ["backfill-cli-other-folder"],
    });
    const reader = { kind: "user" as const, email: "reader@example.com" };
    await expect(readService.content(reader, "cli-card-asset", { type: "card", id: "backfill-cli-card-1" }, { method: "GET" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_ACCESS_DENIED", statusCode: 403 });
    const untouched = await readCardRows(["backfill-cli-card-1", "backfill-cli-card-2"]);
    const hashOnly = await invokeCard(manifest, ["--approved-manifest-sha256", manifest.sha256]);
    expect(hashOnly[0]).toMatchObject({ apply: false, identities_selected: 2, cards_updated: 0 });
    await expect(invokeCard(manifest, ["--apply"])).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(invokeCard(manifest, ["--apply", "--approved-manifest-sha256", "0".repeat(64)]))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await readCardRows(["backfill-cli-card-1", "backfill-cli-card-2"])).toEqual(untouched);

    const limited = await invokeCard(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256, "--limit", "1"]);
    expect(limited[0]).toMatchObject({ identities_selected: 1, source_refs_selected: 1, cards_updated: 1 });
    await expect(readService.content(reader, "cli-card-asset", { type: "card", id: "backfill-cli-card-1" }, { method: "GET" }))
      .resolves.toBeInstanceOf(Response);
    await expect(readService.content(reader, "cli-card-asset", { type: "card", id: "backfill-cli-card-2" }, { method: "GET" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_ACCESS_DENIED", statusCode: 403 });
    const onlySecond = await invokeCard(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256, "--only", "identity-card-2"]);
    expect(onlySecond[0]).toMatchObject({ identities_selected: 1, source_refs_selected: 1, cards_updated: 1 });
    const applied = await readCardRows(["backfill-cli-card-1", "backfill-cli-card-2"]);
    expect(applied.map((row) => row.version)).toEqual([2, 2]);
    expect(applied[0]!.attachment_refs).toEqual([{ attachment_id: "cli-card-asset", legacy_url: firstUrl.replace(origin, "") }]);
    expect(applied[1]!.attachment_refs).toEqual([{ attachment_id: "cli-card-asset", legacy_url: secondUrl }]);

    const rerun = await invokeCard(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256]);
    expect(rerun[0]).toMatchObject({ cards_updated: 0, cards_unchanged: 2 });
    expect(await readCardRows(["backfill-cli-card-1", "backfill-cli-card-2"])).toEqual(applied);
    await harness.sql`DELETE FROM sessions WHERE session_id='backfill-cli-attachment-producer'`;
    await expect(readService.content(reader, "cli-card-asset", { type: "card", id: "backfill-cli-card-2" }, { method: "GET" }))
      .resolves.toBeInstanceOf(Response);
    await expect(readService.content({ kind: "user", email: "outsider@example.com" }, "cli-card-asset",
      { type: "card", id: "backfill-cli-card-2" }, { method: "GET" })).rejects.toMatchObject({ statusCode: 403 });

    const externalUrl = `https://outside.example.test/api/attachments/files?nodeId=node-a&path=cli-card.png`;
    await insertCard("backfill-cli-card-external", `external ![attachment](${externalUrl})`);
    const externalManifest = await writeManifest([cardIdentity("backfill-cli-card-external", externalUrl, "identity-external", `external ![attachment](${externalUrl})`)]);
    const externalReport = await invokeCard(externalManifest, ["--apply", "--approved-manifest-sha256", externalManifest.sha256]);
    expect(externalReport.some((record) => record.code === "SOURCE_CHANGED")).toBe(true);
    expect(await readCardRows(["backfill-cli-card-external"])).toEqual([
      { id: "backfill-cli-card-external", request: `external ![attachment](${externalUrl})`, attachment_refs: [], version: 1 },
    ]);

    const arbitraryUrl = `${origin}/unrelated?nodeId=node-a&path=cli-card.png`;
    await insertCard("backfill-cli-card-arbitrary", `arbitrary ![attachment](${arbitraryUrl})`);
    const arbitraryManifest = await writeManifest([cardIdentity("backfill-cli-card-arbitrary", arbitraryUrl, "identity-arbitrary")]);
    const arbitraryReport = await invokeCard(arbitraryManifest, ["--apply", "--approved-manifest-sha256", arbitraryManifest.sha256]);
    expect(arbitraryReport.some((record) => record.code === "SOURCE_CHANGED")).toBe(true);
    expect(await readCardRows(["backfill-cli-card-arbitrary"])).toEqual([
      { id: "backfill-cli-card-arbitrary", request: `arbitrary ![attachment](${arbitraryUrl})`, attachment_refs: [], version: 1 },
    ]);

    const changedUrl = `${origin}/api/attachments/files?path=cli-card.png&nodeId=node-a`;
    await insertCard("backfill-cli-card-exact", `current ${firstUrl}`);
    const staleManifest = await writeManifest([cardIdentity("backfill-cli-card-exact", changedUrl, "identity-stale-url", `current ![attachment](${firstUrl})`, firstUrl)]);
    const staleReport = await invokeCard(staleManifest, ["--apply", "--approved-manifest-sha256", staleManifest.sha256]);
    expect(staleReport.some((record) => record.code === "SOURCE_CHANGED")).toBe(true);
  });

  it("rolls back card child refs and parent refs when a failure follows the child update", async () => {
    const cardId = "backfill-cli-card-rollback";
    const reportId = "backfill-cli-card-rollback-report";
    const reportUrl = "/api/attachments/files?nodeId=node-a&path=cli-report.png";
    const body = `original report ![attachment](${reportUrl})`;
    const evidenceUrl = "/api/attachments/files?nodeId=node-a&path=cli-card.png";
    const items = [{
      id: 1, title: "Current evidence", state: "done", result: "Keep item result",
      evidence: [{ type: "image", label: "Current evidence", url: evidenceUrl }],
      caveat: "Keep item caveat", rev: 1, confirmed: null, fixOpen: 0, reopened: null,
      from: null, createdAt: "2026-10-17T00:00:00.000Z", reportedAt: null,
    }];
    await insertCard(cardId, "original card request");
    await harness.sql`UPDATE cards SET items=${harness.sql.json(items)}::jsonb WHERE id=${cardId}`;
    await harness.sql`INSERT INTO card_reports (id, card_id, title, format, body)
      VALUES (${reportId}, ${cardId}, 'Rollback', 'markdown', ${body})`;
    await harness.sql.unsafe(`
      CREATE FUNCTION fail_cli_card_parent_backfill() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${cardId}' THEN
          IF EXISTS (
            SELECT 1 FROM card_reports
            WHERE id = '${reportId}'
              AND attachment_refs @> '[{"attachment_id":"cli-report-asset"}]'::jsonb
          ) THEN
            RAISE EXCEPTION 'injected card parent failure after report refs update' USING ERRCODE = 'P1234';
          END IF;
          RAISE EXCEPTION 'parent update ran before report refs update' USING ERRCODE = 'P1235';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_cli_card_parent_backfill AFTER UPDATE OF attachment_refs ON cards
        FOR EACH ROW EXECUTE FUNCTION fail_cli_card_parent_backfill();
    `);
    const manifest = await writeManifest([
      cardReportIdentity(cardId, reportId, body, reportUrl),
      cardEvidenceIdentity(cardId, evidenceUrl),
    ]);
    const report = await invokeCard(manifest, ["--apply", "--approved-manifest-sha256", manifest.sha256]);
    expect(report.some((record) => record.code === "P1234")).toBe(true);
    const card = (await harness.sql<{ request: string; attachment_refs: unknown; items: unknown; version: number }[]>`
      SELECT request, attachment_refs, items, version FROM cards WHERE id=${cardId}
    `)[0]!;
    expect(card).toEqual({ request: "original card request", attachment_refs: [], items, version: 1 });
    const savedReport = (await harness.sql<{ body: string; attachment_refs: unknown }[]>`
      SELECT body, attachment_refs FROM card_reports WHERE id=${reportId}
    `)[0]!;
    expect(savedReport).toEqual({ body, attachment_refs: [] });
  });

  async function writeManifest(identities: Record<string, unknown>[]) {
    const file = path.join(tempDir, `manifest-${outputNumber++}.jsonl`);
    const content = [
      { record_type: "manifest_metadata", schema_version: INVENTORY_SCHEMA_VERSION, dry_run: true, writes_enabled: false, coverage_complete: true },
      ...identities,
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(file, content, "utf8");
    return { file, sha256: createHash("sha256").update(content).digest("hex") };
  }
  async function invokeMessage(manifest: { file: string; sha256: string }, flags: string[]) {
    return await runMessageBackfillCli([
      "--manifest", manifest.file, "--output", outputPath(), "--allowed-origins", JSON.stringify([origin]), ...flags,
    ], harness.liveSql as never);
  }
  async function invokeCard(manifest: { file: string; sha256: string }, flags: string[]) {
    return await runCardBackfillCli([
      "--manifest", manifest.file, "--output", outputPath(), "--allowed-origins", JSON.stringify([origin]), ...flags,
    ], harness.liveSql as never);
  }
  function outputPath() { return path.join(tempDir, `report-${outputNumber++}.jsonl`); }
  function messageIdentity(sessionId: string, eventId: number, rawPath = "/legacy/cli-message.png", pointer = "/payload/attachments/0", rawUrl?: string) {
    return identity(`identity-message-${eventId}`, rawPath, [{
      source_kind: "message", source_table: "events", source_pk: String(eventId), pointer,
      session_id: sessionId, event_id: eventId, raw_path: rawPath,
      ...(rawUrl === undefined ? {} : { raw_url: rawUrl }), changed_after_cutoff: false,
      owner: { status: "unverified", reason: "test fixture", source: "fixture" },
    }]);
  }
  function cardIdentity(cardId: string, rawUrl: string, identityKey: string, sourceRequest?: string, currentUrl = rawUrl) {
    const request = sourceRequest ?? `${cardId === "backfill-cli-card-1" ? "first" : "second"} ![attachment](${rawUrl})`;
    return identity(identityKey, "cli-card.png", [{
      source_kind: "card_request", source_table: "cards", source_pk: cardId, pointer: "/request",
      card_id: cardId, raw_url: rawUrl, raw_path: "cli-card.png", body_offset: request.indexOf(currentUrl),
      changed_after_cutoff: false, owner: { status: "unverified", reason: "test fixture", source: "fixture" },
    }]);
  }
  function cardReportIdentity(cardId: string, reportId: string, body: string, rawUrl: string) {
    return identity("identity-card-report-rollback", "cli-report.png", [{
      source_kind: "report", source_table: "card_reports", source_pk: reportId, pointer: "/body", card_id: cardId,
      raw_url: rawUrl, raw_path: "cli-report.png", body_offset: body.indexOf(rawUrl), changed_after_cutoff: false,
      owner: { status: "unverified", reason: "test fixture", source: "fixture" },
    }]);
  }
  function cardEvidenceIdentity(cardId: string, rawUrl: string) {
    return identity("identity-card-evidence-rollback", "cli-card.png", [{
      source_kind: "card_item", source_table: "cards", source_pk: cardId, pointer: "/items/0/evidence/0/url",
      card_id: cardId, raw_url: rawUrl, raw_path: "cli-card.png", changed_after_cutoff: false,
      owner: { status: "unverified", reason: "test fixture", source: "fixture" },
    }]);
  }
  function identity(identityKey: string, normalizedPath: string, references: Record<string, unknown>[]) {
    return {
      identity_key: identityKey, legacy_node_id: "node-a", normalized_path: normalizedPath,
      name: path.posix.basename(normalizedPath), declared_mime: null, inferred_mime: "image/png",
      owner: { status: "unverified", reason: "test fixture", source: "fixture" }, status: "verified_source",
      references, source_occurrence_count: references.length, unreferenced_incoming: false,
      stat_before: null, stat_after: null, after_cutoff: false, coverage_complete: true, proposed_ref_action: "add",
    };
  }
  async function insertCard(id: string, request: string) {
    await harness.sql`INSERT INTO cards (id, folder_id, position_key, title, request, version)
      VALUES (${id}, ${folder}, ${id}, ${id}, ${request}, 1)`;
  }
  async function readMessagePayloads(rows: Array<{ session_id: string; event_id: number }>) {
    const stored: unknown[] = [];
    for (const row of rows) {
      stored.push((await harness.sql<{ payload: unknown }[]>`
        SELECT payload FROM events WHERE session_id=${row.session_id} AND id=${row.event_id}
      `)[0]!.payload);
    }
    return stored;
  }
  async function readCardRows(ids: string[]) {
    const rows: Array<{ id: string; request: string; attachment_refs: unknown; version: number }> = [];
    for (const id of ids) {
      const row = (await harness.sql<{ id: string; request: string; attachment_refs: unknown; version: number }[]>`
        SELECT id, request, attachment_refs, version FROM cards WHERE id=${id}
      `)[0]!;
      rows.push(row);
    }
    return rows;
  }
});
