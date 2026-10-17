import { spawnSync } from "node:child_process";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../../src/board-yjs/board_yjs_sql.js";
import { projectCardAttachmentRows } from "../../src/cards/card_attachment_projection.js";
import {
  AttachmentTransportConnectionError,
  registerAttachmentRoutes,
  type AttachmentRouteOptions,
} from "../../src/attachments/attachment_routes.js";
import { createLiveAttachmentReadOptions } from "../../src/runtime/live_attachment_read_provider.js";
import { createLiveAttachmentReadRepository } from "../../src/runtime/live_attachment_read_repository.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../page/page_postgres_harness.js";

const describePostgres = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

const FOLDER_ID = "attachment-legacy-compatibility-folder";
const CARD_ID = "attachment-legacy-compatibility-card";
const ASSET_ID = "attachment-legacy-compatibility-asset";
const NODE_ID = "attachment-legacy-compatibility-node";
const SOURCE_SESSION_ID = "attachment-legacy-deleted-session";
const READER_EMAIL = "reader@example.test";
const BODY = Uint8Array.from([0, 1, 2, 3, 254, 255]);
const storageLocation = { endpoint: "https://r2.example.test", bucket: "private-attachments" };

const filesUrl = (nodeId: string, path: string) => {
  const query = new URLSearchParams({ nodeId, path });
  return "/api/attachments/files?" + query.toString();
};
const cardContentUrl = (cardId: string, assetId: string, download = false) =>
  "/api/attachments/" + encodeURIComponent(assetId) + "/content?context_type=card&context_id=" +
  encodeURIComponent(cardId) + (download ? "&download=true" : "");

describePostgres("legacy card attachment compatibility through PostgreSQL and HTTP", () => {
  let h: PagePostgresHarness;
  let app: FastifyInstance | undefined;
  const getNode = vi.fn(async (nodeId: string) => nodeId === "offline-node" ? { id: nodeId, nodeId } : null);
  const downloadAttachment = vi.fn(async () => {
    throw new AttachmentTransportConnectionError("connection refused");
  });

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES (${FOLDER_ID},'첨부 호환')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES (${SOURCE_SESSION_ID},'terminated')`;
    await h.sql`INSERT INTO file_assets(
      id,storage_key,storage_purpose,storage_endpoint,storage_bucket,owner_kind,owner_key,
      registration_scope,source_session_id,original_name,mime_type,byte_size,upload_status
    ) VALUES (
      ${ASSET_ID},${"private/" + ASSET_ID},'attachment',${storageLocation.endpoint},${storageLocation.bucket},
      NULL,NULL,NULL,${SOURCE_SESSION_ID},'legacy.bin','application/octet-stream',${BODY.length},'committed'
    )`;
    const legacyUrl = filesUrl(NODE_ID, "/legacy/attachment.bin");
    await h.sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES (${NODE_ID},'/legacy/attachment.bin',${ASSET_ID},'C:\\legacy\\attachment.bin','resolved')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,attachment_refs)
      VALUES (${CARD_ID},${FOLDER_ID},'a0','Legacy attachment',${`![legacy](${legacyUrl})`},
        ${h.sql.json([{ attachment_id: ASSET_ID, legacy_url: legacyUrl }])}::jsonb)`;
    await h.sql`DELETE FROM sessions WHERE session_id=${SOURCE_SESSION_ID}`;

    const repository = createLiveAttachmentReadRepository(createLiveDbSqlResolver({ sql: h.liveSql }));
    const attachmentRead = createLiveAttachmentReadOptions({
      repository,
      resolveEmail: async (request: FastifyRequest) => {
        const value = request.headers["x-test-email"];
        return typeof value === "string" ? value : READER_EMAIL;
      },
      resolveReadStorage: async () => ({
        storage: {
          async openObject(input) {
            const headers = {
              "content-type": "application/octet-stream",
              "accept-ranges": "bytes",
            };
            if (input.method === "HEAD") {
              return new Response(null, { status: 200, headers: { ...headers, "content-length": String(BODY.length) } });
            }
            if (input.range !== undefined) {
              const match = /^bytes=(\d+)-(\d+)$/.exec(input.range);
              if (match === null) throw new Error("Unexpected test range");
              const start = Number(match[1]);
              const end = Number(match[2]);
              const bytes = BODY.slice(start, end + 1);
              return new Response(bytes, {
                status: 206,
                headers: {
                  ...headers,
                  "content-length": String(bytes.length),
                  "content-range": `bytes ${start}-${end}/${BODY.length}`,
                },
              });
            }
            return new Response(BODY, {
              status: 200,
              headers: { ...headers, "content-length": String(BODY.length) },
            });
          },
        },
        identity: "compatibility-test",
        location: storageLocation,
      }),
      readPageAttachmentEvidence: async () => null,
      dashboardAccessProvider: {
        async resolveAccess(_request: unknown, context?: { accessEmail?: string | null }) {
          return context?.accessEmail === READER_EMAIL
            ? { restricted: false, allowedFolderIds: [FOLDER_ID] }
            : { restricted: true, allowedFolderIds: [] };
        },
      } as never,
      sessionResourceAccessProvider: {
        async requireSessionAccess() {
          throw Object.assign(new Error("Session unavailable"), { statusCode: 403 });
        },
      } as never,
      folderProvider: {
        async listFolders() { return [{ id: FOLDER_ID, parentFolderId: null }]; },
        async listSessionAssignments() { return {}; },
      } as never,
    });

    app = Fastify({ logger: false });
    const routes = {
      assetRead: attachmentRead,
      provider: { getNode },
      accessProvider: {
        async resolveAccess() { return { restricted: false }; },
        async requireSessionAccess() {},
      },
      transport: {
        async uploadAttachment() { throw new Error("unused"); },
        async legacyUploadAttachment() { throw new Error("unused"); },
        async deleteSessionAttachments() { throw new Error("unused"); },
        downloadAttachment,
      },
    } satisfies AttachmentRouteOptions;
    registerAttachmentRoutes(app, routes);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.cleanup();
  });

  it("projects the old link and preserves authorized bytes, downloads, ranges, and offline failure", async () => {
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    const stored = (await h.sql.unsafe(
      "SELECT id,request,attachment_refs FROM cards WHERE id=$1",
      [CARD_ID],
    ))[0] as Record<string, unknown>;
    const [projected] = await projectCardAttachmentRows(sql, [stored]);
    const legacyUrl = filesUrl(NODE_ID, "/legacy/attachment.bin");
    expect(projected!.request).toBe(`![legacy](${cardContentUrl(CARD_ID, ASSET_ID)})`);
    expect((await h.sql`SELECT request FROM cards WHERE id=${CARD_ID}`)[0]!.request).toBe(`![legacy](${legacyUrl})`);

    const oldUrl = filesUrl(NODE_ID, "/legacy/attachment.bin") + "&download=true";
    const newUrl = cardContentUrl(CARD_ID, ASSET_ID, true);
    const oldResponse = await app!.inject({ method: "GET", url: oldUrl });
    const newResponse = await app!.inject({ method: "GET", url: newUrl });
    expect(oldResponse.statusCode).toBe(200);
    expect(newResponse.statusCode).toBe(200);
    expect([...oldResponse.rawPayload]).toEqual([...BODY]);
    expect(newResponse.rawPayload).toEqual(oldResponse.rawPayload);
    for (const header of ["content-type", "content-length", "content-disposition", "accept-ranges"]) {
      expect(newResponse.headers[header]).toBe(oldResponse.headers[header]);
    }
    expect(oldResponse.headers["content-disposition"]).toContain("attachment");

    const oldRange = await app!.inject({ method: "GET", url: oldUrl, headers: { range: "bytes=1-3" } });
    const newRange = await app!.inject({ method: "GET", url: newUrl, headers: { range: "bytes=1-3" } });
    expect(oldRange.statusCode).toBe(206);
    expect(newRange.statusCode).toBe(206);
    expect(newRange.rawPayload).toEqual(oldRange.rawPayload);
    expect([...oldRange.rawPayload]).toEqual([...BODY.slice(1, 4)]);
    expect(newRange.headers["content-range"]).toBe(oldRange.headers["content-range"]);

    const deniedOld = await app!.inject({ method: "GET", url: oldUrl, headers: { "x-test-email": "blocked@example.test" } });
    const deniedNew = await app!.inject({ method: "GET", url: newUrl, headers: { "x-test-email": "blocked@example.test" } });
    expect(deniedOld.statusCode).toBe(403);
    expect(deniedNew.statusCode).toBe(403);
    expect(getNode).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();

    const offline = await app!.inject({
      method: "GET",
      url: filesUrl("offline-node", "/legacy/unresolved.bin"),
    });
    expect(offline.statusCode).toBe(503);
    expect(offline.json()).toMatchObject({ detail: "Node temporarily unavailable: connection refused" });
    expect(getNode).toHaveBeenCalledWith("offline-node");
    expect(downloadAttachment).toHaveBeenCalledWith(
      { id: "offline-node", nodeId: "offline-node" },
      "/legacy/unresolved.bin",
    );
  });
});
