import type { z } from "zod";
import { sessionTools } from "./session_tools.js";
import { cardTools } from "./card_tools.js";
import { folderObjectTools } from "./folder_tools.js";

/** Mirrors the MCP SDK tool annotations without importing the SDK. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** The registration config both servers hand to their MCP surface unchanged. */
export interface McpToolConfig {
  title?: string;
  description?: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  annotations?: McpToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface McpToolDefinition {
  /** Forward timeout for the worker-to-orchestrator call when the default is too short. */
  timeoutMs?: number;
  name: string;
  config: McpToolConfig;
  /** "internal" tools need a caller session and are never listed to external callers. */
  audience: "all" | "internal";
}

export const mcpTools = {
  ...folderObjectTools,
  ...cardTools,
  ...sessionTools,
} as const satisfies Record<string, McpToolDefinition>;

export const mcpToolDefinitions = Object.values(mcpTools);
export type McpToolName = keyof typeof mcpTools;
