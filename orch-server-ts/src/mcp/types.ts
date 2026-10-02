import type { RecurringJobHostRouteOptions } from "../recurring-jobs/recurring_job_host_routes.js";
import type { CardOrchestrationRouteOptions } from "../cards/card_orchestration_routes.js";
import type { NodeSnapshotRouteOptions } from "../node/node_snapshot_routes.js";
import type { NodeAgentProfileRouteOptions } from "../node/node_agent_profile_routes.js";
import type { CogitoRouteOptions } from "../cogito/cogito_routes.js";
import type { SessionCommandRouteOptions } from "../session/session_command_routes.js";
import type { FastifyBaseLogger } from "fastify";
import type { CallToolResult } from "@soulstream/mcp-contract";
import type { FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";
import type { CardRouteBodyOptions } from "../cards/card_route_body.js";
import type { FolderAccess } from "../folders/folder_route_access.js";

export interface McpCallContext {
  principal: "internal" | "external";
  callerSessionId: string | null;
  nodeId: string;
  callerInfo?: Record<string, unknown>;
  execution?: { registrationId: string; executionCommandId: string };
}

export interface McpHostOptions {
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
  cards: CardRouteBodyOptions & { resolveAccess: () => FolderAccess | Promise<FolderAccess> };
}

export type McpToolHandler = (
  dependencies: McpHostOptions,
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<CallToolResult>;
