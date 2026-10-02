import type { z } from "zod";
import { boardTools } from "./board_tools.js";
import { sessionTools } from "./session_tools.js";
import { cardTools } from "./card_tools.js";
import { folderObjectTools } from "./folder_tools.js";
import { pageTools } from "./page_tools.js";
import { liveCardTools } from "./live_card_view_tools.js";
import { skillTools } from "./skills_tools.js";

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
  outputSchema?: z.ZodRawShape | z.ZodObject;
  annotations?: McpToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface McpToolDefinition {
  name: string;
  config: McpToolConfig;
  /** "internal" tools need a caller session and are never listed to external callers. */
  audience: "all" | "internal";
  /** Input schema shown to and enforced for external callers when it differs from `config.inputSchema`. */
  externalInputSchema?: z.ZodRawShape;
  /** Forward timeout for the worker-to-orchestrator call when the default is too short. */
  timeoutMs?: number;
}

export const mcpTools = {
  ...folderObjectTools,
  ...cardTools,
  ...boardTools,
  ...pageTools,
  ...liveCardTools,
  ...skillTools,
  ...sessionTools,
} as const satisfies Record<string, McpToolDefinition>;

export const mcpToolDefinitions = Object.values(mcpTools);
export type McpToolName = keyof typeof mcpTools;
