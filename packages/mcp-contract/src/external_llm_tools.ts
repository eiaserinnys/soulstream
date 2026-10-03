import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
export const externalLlmTools = {
  list_external_llm_recipients: {
    name: "list_external_llm_recipients", audience: "internal",
    config: {
      description: "Internal only. List active verified subscriptions. recipient_label is self-reported, not verified dot identity. No callback URLs or secrets are returned.",
      inputSchema: {}, annotations: { readOnlyHint: true },
    },
  },
  send_to_external_llm: {
    name: "send_to_external_llm", audience: "internal",
    config: {
      description: "Internal only. Send user data to exactly one active recipient_id. accepted_by_receiver confirms receipt only, not reading or processing. No automatic recipient selection or broadcast.",
      inputSchema: { recipient_id: z.string(), text: z.string(), title: z.string().optional() },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
