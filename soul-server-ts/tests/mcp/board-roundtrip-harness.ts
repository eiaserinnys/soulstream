import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Fastify from "fastify";
import { vi } from "vitest";
import { createBoardProjectionHost } from "../../../orch-server-ts/src/board-yjs/board_projection_host.js";
import { BoardYjsMoveRepository } from "../../../orch-server-ts/src/board-yjs/board_yjs_move_repository.js";
import { BoardYjsRepository } from "../../../orch-server-ts/src/board-yjs/board_yjs_repository.js";
import { BoardYjsService } from "../../../orch-server-ts/src/board-yjs/board_yjs_service.js";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { registerBoardYjsHostProxyRoutes } from "../../../orch-server-ts/src/board/board_yjs_host_proxy.js";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { registerPersistenceHostRoutes } from "../../../orch-server-ts/src/control_plane/persistence_host_routes.js";
import { SessionReadRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import { registerFolderControlPlaneHostRoute } from "../../../orch-server-ts/src/folders/folder_control_plane_host_route.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { SqlFolderProjectIdentityRepository } from "../../../orch-server-ts/src/folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "../../../orch-server-ts/src/folders/folder_project_identity_service.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { createLiveFolderProvider } from "../../../orch-server-ts/src/runtime/live_folder_route_provider.js";
import { broadcastTargetedSessionCatalogDelta } from "../../../orch-server-ts/src/runtime/live_session_catalog_mutation_broadcaster.js";
import { InMemorySseReplayBroadcaster, type SessionStreamEvent } from "../../../orch-server-ts/src/sse/replay_broadcaster.js";
import { SessionBoardMoveService } from "../../../orch-server-ts/src/session/session_board_move_service.js";
import { createFullSchemaPostgresHarness } from "../../../orch-server-ts/tests/board_yjs_postgres_harness.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import { CatalogService } from "../../src/catalog/catalog_service.js";
import { BoardYjsHostClient } from "../../src/collaboration/board_yjs_host_client.js";
import { SessionDataHostClient } from "../../src/control_plane/session_data_host_client.js";
import { SessionDB } from "../../src/db/session_db.js";
import { FolderHostClient } from "../../src/folder/folder_host_client.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import * as catalog from "../../src/mcp/tools/catalog.js";
import * as customView from "../../src/mcp/tools/custom_view.js";

// Same SDK/HTTP/isolated PG boundary as the preceding folder and card roundtrips.
export async function createBoardRoundtripHarness() {
  const h = await createFullSchemaPostgresHarness();
  const resolver = createLiveDbSqlResolver({ sql: h.sql as never });
  const folderProvider = createLiveFolderProvider(resolver);
  const events: unknown[] = [];
  const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
  vi.spyOn(broadcaster, "append").mockImplementation(event => {
    events.push(event);
    return { id: "test-event", payload: event } as never;
  });
  const sql = createBoardYjsSqlAdapter(h.sql as never);
  const cards = new CardControlPlaneService(sql, { appendEventTx: async () => 1 }, {
    emitFolderUpdated: async () => {}, emitCardUpdated: async () => {},
  });
  const identity = new FolderProjectIdentityService({
    repository: new SqlFolderProjectIdentityRepository(resolver),
    withBoardApplication: async (_input, persist) => persist([]), hydratePage: async () => {},
  });
  const folders = { serviceProvider: async () => new FolderControlPlaneService(sql),
    cardServiceProvider: async () => cards, identity, authBearerToken: "service-token" };
  const repository = new BoardYjsRepository(resolver);
  const projectionHost = createBoardProjectionHost(resolver, repository);
  const moves = new BoardYjsMoveRepository(resolver);
  const sessionReads = new SessionReadRepository(h.sql);
  let board: BoardYjsService;
  let mover: SessionBoardMoveService;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never;
  const makeBoard = () => {
    board = new BoardYjsService({ repository, logger,
      auth: { authBearerToken: "service-token", environment: "production", dashboardAuthEnabled: false,
        resolveDashboardUserFromHeaders: async () => null },
      moveSessionBoardItem: input => mover.moveSessionBoardItem(input),
      persistBoardItemMove: input => moves.commitBoardItemMove(input),
    });
    mover = new SessionBoardMoveService({ board, repository: moves,
      onBoardMoveCommitted: async ({ sessionIds, movedBoardItem }) => {
        await broadcastTargetedSessionCatalogDelta(folderProvider, broadcaster, sessionIds,
          movedBoardItem ? { [movedBoardItem.id]: movedBoardItem } : {});
      },
    });
  };
  makeBoard();
  const app = Fastify();
  const host = { authBearerToken: "service-token", projectionHost, createService: () => board };
  let distinguishRemote = false;
  const listAgentProfiles = vi.fn(async (nodeId: string) => ({ roselin: { name: distinguishRemote && nodeId === "other-node" ? "다른 노드 이름" : "로젤린" } }));
  const oldBroadcaster = {
    emitCatalogUpdated: async (folders: unknown, sessions: unknown, items: unknown) => {
      events.push({ type: "catalog_updated", folders, sessions_delta: sessions, board_items_delta: items, nodeId: "test-node" });
    },
    emitCustomViewUpdated: async (_actor: string, customViewId: string, boardItemId: string, revision: number) => {
      events.push({ type: "custom_view_updated", customViewId, boardItemId, revision, nodeId: "test-node" });
    },
  };
  registerFolderControlPlaneHostRoute(app, folders);
  // Getter ensures each reset uses a fresh real Y.Doc service rather than a stale document cache.
  registerBoardYjsHostProxyRoutes(app, { ...host, get service() { return board; } });
  registerPersistenceHostRoutes(app, { authBearerToken: "service-token", repositoryProvider: async () => ({ sessionReads }) as never });
  const executionOptions = { authBearerToken: "service-token", folders,
    cards: { cardServiceProvider: folders.cardServiceProvider, provider: { listFolders: () => [], listSessionAssignments: () => ({}) },
      resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
    board: { host: { ...host, get service() { return board; } }, getSession: (id: string) => sessionReads.getSession(id),
      listAgentProfiles,
      broadcaster,
      catalogFolderProvider: folderProvider,
    },
  } as never;

  registerMcpHostRoutes(app, executionOptions);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const orch = { baseUrl, headers: { authorization: "Bearer service-token" } };
  const clientConfig = { orch, logger };
  const boardClient = new BoardYjsHostClient(clientConfig);
  const db = new SessionDB();
  db.configureFolderHost(new FolderHostClient(clientConfig));
  db.configureBoardProjectionHost(boardClient);
  // Actual old session HTTP read, used only by the generated-session enrollment branch.
  db.configureSessionDataHost(new SessionDataHostClient(clientConfig));
  const agentRegistry = new AgentRegistry([{ id: "roselin", name: "로젤린" } as never]);
  const runtime = { nodeId: "test-node", orch, logger, db, agentRegistry,
    catalogService: new CatalogService(db, oldBroadcaster as never, boardClient),
  } as unknown as McpRuntime;
  async function seed() {
    await board.close(); makeBoard(); events.length = 0;
    // Only the disposable harness-owned schema is cleared; no environment DATABASE_URL is used.
    const tables = await h.sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname=current_schema()`;
    await h.sql.unsafe(`TRUNCATE ${tables.map(t => '"' + t.tablename.replaceAll('"', '""') + '"').join(",")} RESTART IDENTITY CASCADE`);
    const actor = { actorKind: "system" as const, actorSessionId: null, actorUserId: null };
    for (const [id, name, parentFolderId] of [
      ["00000000-0000-4000-8000-000000000001", "A", null],
      ["00000000-0000-4000-8000-000000000002", "B", null],
      ["00000000-0000-4000-8000-000000000003", "하위", "00000000-0000-4000-8000-000000000001"],
    ] as const) await identity.create({ reservedId: id, name, parentFolderId, actor, idempotencyKey: `seed-${id}` });
    await h.sql`INSERT INTO folders(id,name) VALUES('claude','System')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,status,agent_id,display_name,folder_id)
      VALUES('header-session','test-node','running','roselin','세션','00000000-0000-4000-8000-000000000001'),
      ('argument-session','test-node','running','roselin','다른 세션','00000000-0000-4000-8000-000000000001'),
      ('generated','test-node','running','roselin','보드 없는 세션','00000000-0000-4000-8000-000000000001'),
      ('remote','other-node','running','roselin','원격','00000000-0000-4000-8000-000000000001'),
      ('archived','test-node','completed','roselin','보관 세션','00000000-0000-4000-8000-000000000001')`;
    await h.sql`INSERT INTO markdown_documents(id,title,body,version) VALUES('doc-1','문서','찾을 본문',1),('orphan','보드 없음','본문',1)`;
    await h.sql`INSERT INTO board_items(id,folder_id,membership_kind,item_type,item_id,x,y,metadata)
      VALUES('markdown:doc-1','00000000-0000-4000-8000-000000000001','primary','markdown','doc-1',0,0,'{}'),
      ('session:header-session','00000000-0000-4000-8000-000000000001','primary','session','header-session',280,0,'{}'),
      ('session:argument-session','00000000-0000-4000-8000-000000000001','primary','session','argument-session',560,0,'{}'),
      ('session:remote','00000000-0000-4000-8000-000000000001','primary','session','remote',0,160,'{}'),
      ('session:archived','00000000-0000-4000-8000-000000000001','primary','session','archived',280,160,'{}'),
      ('subfolder:child','00000000-0000-4000-8000-000000000001','primary','subfolder','00000000-0000-4000-8000-000000000003',840,0,'{}'),
      ('frame:frame-1','00000000-0000-4000-8000-000000000001','primary','frame','frame-1',840,160,'{}'),
      ('ref:doc-1','00000000-0000-4000-8000-000000000001','reference','markdown','ref-doc',560,160,'{}')`;
    await board.upsertCustomViewBoardItem({ folderId: "00000000-0000-4000-8000-000000000001", boardItemId: "custom_view:cv-1", customViewId: "cv-1",
      title: "뷰", html: "<p>before</p>", revision: 1, x: 0, y: 320 });
    await projectionHost.createCustomViewRecord({ id: "cv-1", boardItemId: "custom_view:cv-1", title: "뷰", html: "<p>before</p>",
      actorKind: "agent", actorSessionId: "header-session", idempotencyKey: "seed-view" });
    events.length = 0;
  }
  async function call(name: string, input: Record<string, unknown>, context: McpRequestContext) {
    const server = new McpServer({ name: "board-parity", version: "1" });
    catalog.registerCatalogTools(server, runtime); customView.registerCustomViewTools(server, runtime);
    const client = new Client({ name: "board-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await withMcpRequestContext(context, () => client.callTool({ name, arguments: input }));
    } finally { await client.close(); await server.close(); }
  }
  return { executionOptions, seed, call, events, h, projectionHost, listAgentProfiles,
    distinguishRemoteNames(value: boolean) { distinguishRemote = value; },
    async cleanup() { await board.close(); await app.close(); await h.cleanup(); } };
}
