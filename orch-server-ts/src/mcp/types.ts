import type { CallToolResult } from "@soulstream/mcp-contract";
import type { FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";
import type { CardRouteBodyOptions } from "../cards/card_route_body.js";
import type { FolderAccess } from "../folders/folder_route_access.js";

export interface McpCallContext {
  principal: "internal" | "external";
  callerSessionId: string | null;
  nodeId: string;
  execution?: { registrationId: string; executionCommandId: string };
}

export interface McpHostOptions {
  authBearerToken: string;
  environment?: string;
  folders: FolderControlPlaneHostRouteOptions;
  cards: CardRouteBodyOptions & { resolveAccess: () => FolderAccess | Promise<FolderAccess> };
}

export type McpToolHandler = (
  dependencies: McpHostOptions,
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<CallToolResult>;
