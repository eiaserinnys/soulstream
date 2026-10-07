import { sessionMessageTools } from "./session_message_tools.js";
import { externalLlmTools } from "./external_llm_tools.js";
import { clusterTools } from "./multi_node.js";
import { cardOrchestrationTools } from "./card_orchestration.js";
import { ownedAgentTools } from "./owned_agents.js";
import { recurringJobTools } from "./recurring_jobs.js";
import type { z } from "zod";
import { boardTools } from "./board_tools.js";
import { sessionTools } from "./session_tools.js";
import { cardTools } from "./card_tools.js";
import { folderObjectTools } from "./folder_tools.js";
import { pageTools } from "./page_tools.js";
import { liveCardTools } from "./live_card_view_tools.js";
import { skillTools } from "./skills_tools.js";
import { persistentSessionSettingsTools } from "./persistent_session_settings_tools.js";

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
  /** Reject unknown top-level input keys when registering and executing this tool. */
  strictInputSchema?: boolean;
  /** Input schema shown to and enforced for external callers when it differs from `config.inputSchema`. */
  externalInputSchema?: z.ZodRawShape;
  /** Forward timeout for the worker-to-orchestrator call when the default is too short. */
  timeoutMs?: number;
}

export const mcpTools = {
  ...sessionMessageTools,
  ...externalLlmTools,
  ...clusterTools,
  ...cardOrchestrationTools,
  ...recurringJobTools,
  ...ownedAgentTools,
  ...folderObjectTools,
  ...cardTools,
  ...boardTools,
  ...pageTools,
  ...liveCardTools,
  ...skillTools,
  ...sessionTools,
  ...persistentSessionSettingsTools,
} as const satisfies Record<string, McpToolDefinition>;

export const mcpToolDefinitions = Object.values(mcpTools);
export type McpToolName = keyof typeof mcpTools;
