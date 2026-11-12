import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationCatalog } from "../src/conversation/conversation_catalog.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { SessionReadRepository } from "../src/control_plane/repositories/session_read_repository.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

const catalog = repositoryModelCatalog();
const CATALOG = catalog.snapshot();


const fixture = JSON.parse(readFileSync(new URL("./fixtures/conversation-v1/adoptable.json", import.meta.url), "utf8"));
const persistent = [{ type: "persistent_session", value: { enabled: true } }];

describe("conversation adoptable candidates", () => {
  let db: FullSchemaPostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let body: { candidates: Array<Record<string, any>> };
  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    await db.sql`INSERT INTO folders(id,name) VALUES ('folder-ok','ok'),('folder-secret','secret')`;
    const session = (id: string, display: string | null, folder: string | null, node: string | null,
      preset: string | null, agent: string | null, at: string) => db.sql`
      INSERT INTO sessions(session_id,folder_id,display_name,node_id,model_preset,agent_id,created_at,updated_at,metadata)
      VALUES (${id},${folder},${display},${node},${preset},${agent},${at},${at},${db.sql.json(persistent)})`;
    await session("thread-1", "서소영 PAS", "folder-ok", "node-b", "preset-a", "profile-a", "2026-11-08T12:00:00Z");
    await session("sess-next", "이전 실행", "folder-ok", "node-b", "preset-a", "profile-a", "2026-11-07T20:00:00Z");
    await session("session-2", null, "folder-ok", null, null, null, "2026-11-07T09:00:00Z");
    await session("sess-secret", "비밀", "folder-secret", "node-b", "preset-a", "profile-a", "2026-11-08T13:00:00Z");
    await session("sess-other", "남의 스레드", "folder-ok", "node-b", "preset-a", "profile-a", "2026-11-08T14:00:00Z");
    await db.sql`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,active_session_id,selected_model,phase,notices)
      VALUES ('account-a','ns','key-1','thread-1','thread-1','n1:node-b:preset-a','complete','[]'::jsonb),
             ('account-b','ns','key-other','thread-9','thread-9','n1:node-b:preset-a','complete','[]'::jsonb)`;
    await db.sql`INSERT INTO conversation_executions(thread_id,session_id,ordinal,phase)
      VALUES ('thread-1','thread-1',0,'complete'),('thread-1','sess-next',1,'complete'),('thread-9','sess-other',0,'complete')`;

    const readRepo = new SessionReadRepository(db.sql as never);
    const access = {
      requireFolderAccess: async ({ folderId }: { folderId: string | null }) => {
        if (folderId === "folder-secret") throw new SessionResourceAccessError("folder_forbidden", "Folder access denied", 403);
      },
      requireSessionAccess: async () => {},
    };
    const settings = new PersistentSessionSettingsService({
      modelCatalog: catalog,
      reads: async () => readRepo as never,
      access: access as never,
      catalog: { renameSession: async () => {} } as never,
      commands: {} as never,
      createSession: async () => ({ status: 400, body: {} }) as never,
      presets: {
        resolveStaticForNode: () => ({ id: "claude-opus", default_effort: null }) as never,
        requireAvailable: () => {},
      } as never,
      profiles: {
        listAgentProfiles: async (nodeId: string) =>
          nodeId === "eiaserinnys" ? { "seosoyoung-pas": { name: "서소영" } } : undefined,
      },
    });
    const conversationCatalog = new ConversationCatalog({
      defaultNodeId: "eiaserinnys",
      listNodes: () => [{ nodeId: "eiaserinnys", connected: true }, { nodeId: "node-b", connected: true }],
      listKnownForNode: (nodeId: string) => nodeId === "node-b"
        ? [{ id: "preset-a", label: "Preset A", backend: "claude", available: true, reason: null,
            reason_label: null, resets_at: null, usage_warning: false, weekly_headroom: null }]
        : [],
      listAgentProfiles: async (nodeId: string) =>
        nodeId === "node-b" ? { "profile-a": { name: "Profile A" } } : undefined,
    });
    const service = new ConversationService({
      sql: db.sql as never,
      access: access as never,
      reads: async () => readRepo as never,
      persistent: settings as never,
      catalog: conversationCatalog,
      create: async () => ({ status: 400, body: {} }) as never,
      waitForCreatedSession: async () => false,
    });
    app = Fastify({ logger: false });
    registerConversationRoutes(app, { service, resolveAccount: async () => "account-a" });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/adoptable" });
    expect(response.statusCode).toBe(200);
    body = response.json();
  }, 60_000);
  afterAll(async () => { await app?.close(); await db?.cleanup(); });
  it("lists a plain persistent session by its own id", () => {
    expect(body.candidates.find(candidate => candidate.id === "session-2")).toEqual({
      id: "session-2", title: "", updated_at: "2026-11-07T09:00:00.000Z",
    });
  });
  it("collapses execution sessions into their thread once", () => {
    const threads = body.candidates.filter(candidate => candidate.id === "thread-1");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      id: "thread-1",
      title: "서소영 PAS",
      profile: { id: "profile-a", label: "Profile A" },
      model: { id: "n1:node-b:preset-a", label: "Preset A", group: { id: "node-b", label: "node-b" } },
      updated_at: "2026-11-08T12:00:00.000Z",
    });
    expect(body.candidates.some(candidate => candidate.id === "sess-next")).toBe(false);
  });
  it("excludes sessions in denied folders and threads bound to another account", () => {
    const ids = body.candidates.map(candidate => candidate.id);
    expect(ids).not.toContain("sess-secret");
    expect(ids).not.toContain("sess-other");
    expect(ids).not.toContain("thread-9");
  });
  it("returns the published candidate shape newest first", () => {
    expect(body).toEqual(fixture);
  });
});
