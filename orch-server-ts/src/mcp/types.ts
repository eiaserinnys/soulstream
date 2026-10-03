import type { SessionActionCommandRouteOptions } from "../session/session_action_command_routes.js";
import type { RecurringJobHostRouteOptions } from "../recurring-jobs/recurring_job_host_routes.js";
import type { CardOrchestrationRouteOptions } from "../cards/card_orchestration_routes.js";
import type { NodeSnapshotRouteOptions } from "../node/node_snapshot_routes.js";
import type { NodeAgentProfileRouteOptions } from "../node/node_agent_profile_routes.js";
import type { CogitoRouteOptions } from "../cogito/cogito_routes.js";
import type { SessionCommandRouteOptions } from "../session/session_command_routes.js";
import type { FastifyBaseLogger } from "fastify";
import type { PageYjsService } from "../page/page_service.js";
import type { AtomHttpClient } from "../atom/atom_routes.js";
import type { SessionMcpDependencies } from "./session_handlers.js";
import type { CallToolResult } from "@soulstream/mcp-contract";
import type { FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";
import type { CardRouteBodyOptions } from "../cards/card_route_body.js";
import type { FolderAccess } from "../folders/folder_route_access.js";
import type { BoardYjsHostProxyRouteOptions } from "../board/board_yjs_host_proxy.js";
import type { NodeAgentProfileProvider } from "../node/node_agent_profile_routes.js";
import type { InMemorySseReplayBroadcaster, SessionStreamEvent } from "../sse/replay_broadcaster.js";

export interface McpCallContext {
  signal?: AbortSignal;
  principal: "internal" | "external";
  callerSessionId: string | null;
  nodeId: string;
  callerInfo?: Record<string, unknown>;
  /** Set only by the orchestrator's own external ingress; never accepted from the worker forward body. */
  externalCaller?: { source: string; displayName: string };
  execution?: { registrationId: string; executionCommandId: string };
}

export interface McpHostOptions {
  sessionMessages?: SessionActionCommandRouteOptions;
  sessions?: SessionMcpDependencies;
  authBearerToken: string;
  recurringJobs: RecurringJobHostRouteOptions;
  cardOrchestration: CardOrchestrationRouteOptions;
  cluster: {
    nodes: NodeSnapshotRouteOptions;
    nodeAgentProfiles: NodeAgentProfileRouteOptions;
    cogito: CogitoRouteOptions;
    sessions: SessionCommandRouteOptions;
    readSession(sessionId: string): Promise<{ folder_id?: string | null } | null>;
    logger: Pick<FastifyBaseLogger, "warn">;
  };
  environment?: string;
  folders: FolderControlPlaneHostRouteOptions;
  pages?: { service: PageYjsService; logger: Pick<FastifyBaseLogger, "error"> };
  skills?: { enabled: boolean; serverUrl: string; apiKey: string; nodeId: string; typesafeApiKey: string; httpClient: AtomHttpClient; logger?: Pick<FastifyBaseLogger, "warn"> };
  cards: CardRouteBodyOptions & { resolveAccess: () => FolderAccess | Promise<FolderAccess> };
  board: {
    host: BoardYjsHostProxyRouteOptions;
    getSession: (id: string) => Promise<{ folder_id: string | null } | null>;
    listAgentProfiles: NodeAgentProfileProvider["listAgentProfiles"];
    broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  };
}

export type McpToolHandler = (
  dependencies: McpHostOptions,
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<CallToolResult>;
