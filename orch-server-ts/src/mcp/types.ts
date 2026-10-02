import type { CallToolResult } from "@soulstream/mcp-contract";
import type { FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";

export interface McpCallContext {
  principal: "internal" | "external";
  callerSessionId: string | null;
  nodeId: string;
}

export interface McpHostOptions {
  authBearerToken: string;
  environment?: string;
  folders: FolderControlPlaneHostRouteOptions;
}

export type McpToolHandler = (
  dependencies: McpHostOptions,
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<CallToolResult>;
