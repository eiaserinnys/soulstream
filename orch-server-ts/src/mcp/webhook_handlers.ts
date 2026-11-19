import { z } from "zod";
import { errorResult, jsonResult, webhookTools, type CallToolResult } from "@soulstream/mcp-contract";

import {
  createOutboundWebhook,
  deleteOutboundWebhook,
  inboundWebhookIdSchema,
  inboundWebhookRequestsQuerySchema,
  issueInboundWebhook,
  listInboundWebhookRequests,
  listInboundWebhooks,
  listOutboundWebhookDeliveries,
  listOutboundWebhooks,
  normalizeWebhookOwnerEmail,
  outboundWebhookDeliveryQuerySchema,
  redeliverOutboundWebhook,
  revokeInboundWebhook,
  setOutboundWebhookActive,
  type WebhookManagementResult,
} from "../webhooks/webhook_management.js";
import type { McpHostOptions, McpToolHandler } from "./types.js";

/**
 * Webhook management tools (card #1458). The owner is the caller session's
 * verified owner, normalized like the settings-screen routes, so both surfaces
 * list and change the same webhooks. The commands are the routes' shared
 * `webhook_management.ts`; errors are the routes' code words and never carry
 * secrets, keys or receiver URLs.
 */

type WebhookToolName = keyof typeof webhookTools;
type WebhookToolDefinition = (typeof webhookTools)[WebhookToolName];
type Webhooks = NonNullable<McpHostOptions["webhooks"]>;
type ToolWork<Definition extends WebhookToolDefinition> = (
  webhooks: Webhooks,
  ownerEmail: string,
  input: z.infer<z.ZodObject<Definition["config"]["inputSchema"]>>,
) => Promise<CallToolResult>;

const UNAVAILABLE = "webhooks_unavailable";

function webhookTool<Definition extends WebhookToolDefinition>(
  definition: Definition,
  work: ToolWork<Definition>,
): McpToolHandler {
  // The definition union widens the inferred object; each tool's input is its own shape.
  const schema = z.object(definition.config.inputSchema).strict() as unknown as z.ZodType<
    z.infer<z.ZodObject<Definition["config"]["inputSchema"]>>
  >;
  return async (options, args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
    if (explicit && context.callerSessionId && explicit !== context.callerSessionId) {
      return errorResult("caller_session_id does not match authenticated session");
    }
    if (!options.webhooks) return errorResult(UNAVAILABLE);
    try {
      const sessionId = context.callerSessionId || explicit;
      const owner = sessionId && options.resolveSessionOwner
        ? await options.resolveSessionOwner(sessionId)
        : null;
      const ownerEmail = normalizeWebhookOwnerEmail(owner?.ownerEmail);
      if (!ownerEmail) return errorResult("Verified session owner required");
      const input = schema.parse(args);
      return await work(options.webhooks, ownerEmail, input);
    } catch (error) {
      if (error instanceof z.ZodError) return errorResult(invalidRequest(error));
      logSafeFailure(options, definition.name, error);
      return errorResult("unavailable");
    }
  };
}

export const webhookHandlers = {
  create_inbound_webhook: webhookTool(webhookTools.create_inbound_webhook, async (webhooks, ownerEmail, input) => {
    if (!webhooks.inbound) return errorResult(UNAVAILABLE);
    const { caller_session_id: _caller, ...issue } = input;
    return fromOutcome(await issueInboundWebhook(webhooks.inbound, ownerEmail, issue));
  }),
  revoke_inbound_webhook: webhookTool(webhookTools.revoke_inbound_webhook, async (webhooks, ownerEmail, input) => {
    if (!webhooks.inbound) return errorResult(UNAVAILABLE);
    return fromOutcome(await revokeInboundWebhook(webhooks.inbound, ownerEmail, input.id));
  }),
  create_outbound_webhook: webhookTool(webhookTools.create_outbound_webhook, async (webhooks, ownerEmail, input) => {
    if (!webhooks.outbound) return errorResult(UNAVAILABLE);
    const { caller_session_id: _caller, ...create } = input;
    return fromOutcome(await createOutboundWebhook(webhooks.outbound, ownerEmail, create));
  }),
  set_outbound_webhook_active: webhookTool(webhookTools.set_outbound_webhook_active, async (webhooks, ownerEmail, input) => {
    if (!webhooks.outbound) return errorResult(UNAVAILABLE);
    return fromOutcome(
      await setOutboundWebhookActive(webhooks.outbound, ownerEmail, input.id, input.active),
    );
  }),
  delete_outbound_webhook: webhookTool(webhookTools.delete_outbound_webhook, async (webhooks, ownerEmail, input) => {
    if (!webhooks.outbound) return errorResult(UNAVAILABLE);
    return fromOutcome(await deleteOutboundWebhook(webhooks.outbound, ownerEmail, input.id));
  }),
  redeliver_outbound_webhook: webhookTool(webhookTools.redeliver_outbound_webhook, async (webhooks, ownerEmail, input) => {
    if (!webhooks.outbound) return errorResult(UNAVAILABLE);
    return fromOutcome(
      await redeliverOutboundWebhook(webhooks.outbound, ownerEmail, input.id, input.delivery_id),
    );
  }),
  list_webhooks: webhookTool(webhookTools.list_webhooks, async (webhooks, ownerEmail, input) => {
    if (input.direction === "inbound") {
      if (!webhooks.inbound) return errorResult(UNAVAILABLE);
      return jsonResult({ webhooks: await listInboundWebhooks(webhooks.inbound, ownerEmail) });
    }
    if (!webhooks.outbound) return errorResult(UNAVAILABLE);
    return jsonResult(await listOutboundWebhooks(webhooks.outbound, ownerEmail));
  }),
  list_webhook_activity: webhookTool(webhookTools.list_webhook_activity, async (webhooks, ownerEmail, input) => {
    if (input.direction === "inbound") {
      if (!webhooks.inbound) return errorResult(UNAVAILABLE);
      // Delivery states belong to outbound subscriptions only.
      if (input.state !== undefined) return errorResult("invalid_request: state");
      const { id } = inboundWebhookIdSchema.parse({ id: input.id });
      const { limit } = inboundWebhookRequestsQuerySchema.parse({ limit: input.limit });
      return fromOutcome(await listInboundWebhookRequests(webhooks.inbound, ownerEmail, id, limit));
    }
    if (!webhooks.outbound) return errorResult(UNAVAILABLE);
    const query = outboundWebhookDeliveryQuerySchema.parse({ state: input.state, limit: input.limit });
    return fromOutcome(
      await listOutboundWebhookDeliveries(webhooks.outbound, ownerEmail, input.id, query),
    );
  }),
} satisfies Record<WebhookToolName, McpToolHandler>;

function fromOutcome(outcome: WebhookManagementResult<unknown>): CallToolResult {
  if (outcome.ok) return jsonResult(outcome.value);
  return errorResult(
    outcome.code === "challenge_failed" ? `challenge_failed: ${outcome.reason}` : outcome.code,
  );
}

/** Only the path of the first problem: zod messages may echo the rejected value. */
function invalidRequest(error: z.ZodError): string {
  const path = error.issues[0]?.path.join(".") ?? "";
  return path ? `invalid_request: ${path}` : "invalid_request";
}

/**
 * Database failures can carry whole rows (including signing secrets) in their
 * message and detail, so only the error code, constraint and name are logged.
 */
function logSafeFailure(options: McpHostOptions, tool: WebhookToolName, error: unknown): void {
  const fields: Record<string, unknown> = { tool };
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      name?: unknown;
    };
    if (typeof candidate.code === "string" || typeof candidate.code === "number") {
      fields.error_code = String(candidate.code);
    }
    // postgres.js names it `constraint_name`.
    const constraint = candidate.constraint_name ?? candidate.constraint;
    if (typeof constraint === "string") fields.constraint = constraint;
    if (typeof candidate.name === "string") fields.error_name = candidate.name;
  }
  options.cluster.logger.warn(fields, "webhook tool failed");
}
