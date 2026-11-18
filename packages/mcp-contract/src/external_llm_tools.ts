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
  reply_to_external_request: {
    name: "reply_to_external_request", audience: "internal",
    config: {
      description: "Internal only. Reply to one external request using the request_handle from its external_sender context item. The turn's normal answer is not delivered externally. final=true closes the request and later replies are rejected; close with no text when there is nothing to answer.",
      inputSchema: { request_handle: z.string().min(1), text: z.string().optional(), final: z.boolean() },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
