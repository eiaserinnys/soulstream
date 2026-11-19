import { z } from "zod";
import {
  INBOUND_WEBHOOK_REQUESTS_DEFAULT_LIMIT,
  INBOUND_WEBHOOK_REQUESTS_MAX_LIMIT,
  OUTBOUND_WEBHOOK_DELIVERY_STATES,
  inboundWebhookIssueFields,
  outboundWebhookCreateFields,
} from "@soulstream/mcp-contract";

import type { AuthUserAuthorizer } from "../auth/auth_routes.js";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import type {
  ExternalAccessGrantRepository,
  ExternalAccessGrantSummary,
} from "../external_access/external_access_grant_repository.js";
import type {
  ExternalGrantRecentSummary,
  ExternalInputService,
} from "../external_access/external_input_service.js";
import { WebhookError } from "../external_events/webhook_transport.js";
import {
  SessionResourceAccessError,
  type SessionRequestAccessGuard,
  type SessionResourceAccessProvider,
} from "../session/session_resource_access.js";
import type { OutboundWebhookService } from "./outbound_service.js";
import type { WebhookDeliveryRow } from "./outbound_types.js";

/**
 * Webhook management commands shared by the settings-screen routes and the
 * MCP webhook tools (card #1458). Callers resolve and pass the owner email;
 * every judgment (target session access, the challenge before registration,
 * owner-scoped reads and writes) lives here once. Failures are returned as
 * route code words and never carry secrets, keys or receiver URLs.
 */

export type InboundWebhookManagement = {
  grants: Pick<
    ExternalAccessGrantRepository,
    "issueInboundWebhook" | "list" | "revoke" | "findOwned"
  >;
  requests: Pick<ExternalInputService, "listRecentRequests" | "summarizeGrants">;
  requireSessionAccess: SessionRequestAccessGuard["requireSessionAccess"];
  /** Public origin the receive URLs are built from; trailing slashes collapse. */
  publicUrl: string;
};

export type OutboundWebhookManagement = {
  service: Pick<
    OutboundWebhookService,
    | "sessionExists"
    | "generateSigningSecret"
    | "verifyChallenge"
    | "createSubscription"
    | "listSubscriptions"
    | "getSubscription"
    | "listDeliveries"
    | "redeliver"
    | "setActive"
    | "deleteSubscription"
  >;
  authorizeUser: AuthUserAuthorizer;
  sessionAccess: Pick<SessionResourceAccessProvider, "requireSessionAccess">;
};

export type WebhookManagementFailure =
  | { ok: false; code: "session_not_found" | "forbidden" | "not_found" | "subscription_inactive" }
  | { ok: false; code: "challenge_failed"; reason: string };

export type WebhookManagementResult<T> = { ok: true; value: T } | WebhookManagementFailure;

export const inboundWebhookIssueSchema = z.object(inboundWebhookIssueFields).strict();
export const inboundWebhookIdSchema = z.object({ id: z.uuid() }).strict();
export const inboundWebhookRequestsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(INBOUND_WEBHOOK_REQUESTS_MAX_LIMIT)
    .default(INBOUND_WEBHOOK_REQUESTS_DEFAULT_LIMIT),
});
export const outboundWebhookCreateSchema = z.object(outboundWebhookCreateFields).strict();
export const outboundWebhookActiveSchema = z.object({ active: z.boolean() }).strict();
export const outboundWebhookDeliveryQuerySchema = z.object({
  state: z.enum(OUTBOUND_WEBHOOK_DELIVERY_STATES).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export type InboundWebhookIssueInput = z.infer<typeof inboundWebhookIssueSchema>;
export type OutboundWebhookCreateInput = z.infer<typeof outboundWebhookCreateSchema>;
export type OutboundWebhookDeliveryQuery = z.infer<typeof outboundWebhookDeliveryQuerySchema>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner email both surfaces key on: trimmed and lower-cased, empty is none. */
export function normalizeWebhookOwnerEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/** Outbound ids that are not UUIDs answer not_found, never a storage query. */
export function outboundWebhookId(value: string): string | null {
  return UUID_PATTERN.test(value) ? value : null;
}

/** `${publicUrl}/api/hooks/${grantId}` with trailing slashes on the origin collapsed. */
export function buildInboundWebhookUrl(publicUrl: string, grantId: string): string {
  return `${publicUrl.trim().replace(/\/+$/, "")}/api/hooks/${grantId}`;
}

/** `${publicUrl}/x/${key}/hook`: the header-less receive URL of a key webhook. */
export function buildInboundWebhookKeyUrl(publicUrl: string, secret: string): string {
  return `${publicUrl.trim().replace(/\/+$/, "")}/x/${secret}/hook`;
}

export async function issueInboundWebhook(
  management: InboundWebhookManagement,
  ownerEmail: string,
  input: InboundWebhookIssueInput,
) {
  if (!(await targetSessionReachable(management, ownerEmail, input.target_session_id))) {
    return failure("session_not_found");
  }
  const issued = await management.grants.issueInboundWebhook({
    ownerEmail,
    label: input.label,
    targetSessionId: input.target_session_id,
    authMode: input.auth_mode,
    preamble: input.preamble ?? null,
    expiresInSeconds: input.expires_in_seconds ?? null,
  });
  return success({
    id: issued.grant.id,
    url: buildInboundWebhookUrl(management.publicUrl, issued.grant.id),
    // The header-less receive URL exists only for key mode; the secret is
    // still shown exactly once, in this result.
    ...(issued.grant.auth_mode === "key"
      ? { key_url: buildInboundWebhookKeyUrl(management.publicUrl, issued.secret) }
      : {}),
    auth_mode: issued.grant.auth_mode,
    secret: issued.secret,
    label: issued.grant.label,
    target_session_id: issued.grant.target_session_id,
    preamble: issued.grant.preamble,
    created_at: issued.grant.created_at.toISOString(),
    expires_at: issued.grant.expires_at?.toISOString() ?? null,
  });
}

export async function listInboundWebhooks(
  management: InboundWebhookManagement,
  ownerEmail: string,
) {
  const grants = await management.grants.list(ownerEmail, "inbound_webhook");
  const summaries = await management.requests.summarizeGrants(grants.map((grant) => grant.id));
  return grants.map((grant) =>
    inboundWebhookSummary(grant, management.publicUrl, summaries.get(grant.id))
  );
}

export async function listInboundWebhookRequests(
  management: InboundWebhookManagement,
  ownerEmail: string,
  grantId: string,
  limit: number,
) {
  const grant = await management.grants.findOwned(ownerEmail, grantId, "inbound_webhook");
  if (grant === null) return failure("not_found");
  return success({ items: await management.requests.listRecentRequests(grant.id, limit) });
}

export async function revokeInboundWebhook(
  management: InboundWebhookManagement,
  ownerEmail: string,
  grantId: string,
) {
  const revoked = await management.grants.revoke(ownerEmail, grantId, "inbound_webhook");
  if (revoked === null) return failure("not_found");
  return success(inboundWebhookSummary(revoked, management.publicUrl, undefined));
}

export async function createOutboundWebhook(
  management: OutboundWebhookManagement,
  ownerEmail: string,
  input: OutboundWebhookCreateInput,
): Promise<WebhookManagementResult<{
  subscription: Awaited<ReturnType<OutboundWebhookService["createSubscription"]>>;
  signing_secret: string;
}>> {
  if (!(await management.service.sessionExists(input.target_session_id))) {
    return failure("session_not_found");
  }
  if (!(await issuerCanAccessSession(management, ownerEmail, input.target_session_id))) {
    return failure("forbidden");
  }
  const signingSecret = management.service.generateSigningSecret();
  try {
    await management.service.verifyChallenge(input.url, signingSecret);
  } catch (error) {
    return {
      ok: false,
      code: "challenge_failed",
      reason: error instanceof WebhookError ? error.reason : "verification_failed",
    };
  }
  const subscription = await management.service.createSubscription({
    ownerEmail,
    label: input.label,
    targetSessionId: input.target_session_id,
    url: input.url,
    eventTypes: input.event_types,
    signingSecret,
  });
  return success({ subscription, signing_secret: signingSecret });
}

export async function listOutboundWebhooks(
  management: OutboundWebhookManagement,
  ownerEmail: string,
) {
  return { subscriptions: await management.service.listSubscriptions(ownerEmail) };
}

export async function listOutboundWebhookDeliveries(
  management: OutboundWebhookManagement,
  ownerEmail: string,
  subscriptionId: string,
  query: OutboundWebhookDeliveryQuery,
) {
  const id = outboundWebhookId(subscriptionId);
  if (id === null || await management.service.getSubscription(ownerEmail, id) === null) {
    return failure("not_found");
  }
  const deliveries = await management.service.listDeliveries(ownerEmail, id, {
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });
  return success({ deliveries: deliveries.map(deliveryView) });
}

export async function redeliverOutboundWebhook(
  management: OutboundWebhookManagement,
  ownerEmail: string,
  subscriptionId: string,
  deliveryId: string,
) {
  const id = outboundWebhookId(subscriptionId);
  const delivery = outboundWebhookId(deliveryId);
  if (id === null || delivery === null) return failure("not_found");
  const result = await management.service.redeliver(ownerEmail, id, delivery);
  if (!result.ok) {
    return failure(result.reason === "subscription_inactive" ? "subscription_inactive" : "not_found");
  }
  return success({ outcome: result.outcome });
}

export async function setOutboundWebhookActive(
  management: OutboundWebhookManagement,
  ownerEmail: string,
  subscriptionId: string,
  active: boolean,
) {
  const id = outboundWebhookId(subscriptionId);
  const subscription = id === null
    ? null
    : await management.service.setActive(ownerEmail, id, active);
  return subscription === null ? failure("not_found") : success({ subscription });
}

export async function deleteOutboundWebhook(
  management: OutboundWebhookManagement,
  ownerEmail: string,
  subscriptionId: string,
) {
  const id = outboundWebhookId(subscriptionId);
  if (id === null || !(await management.service.deleteSubscription(ownerEmail, id))) {
    return failure("not_found");
  }
  return success({ deleted: true as const });
}

/**
 * The same access judgment `resolveGrant` makes before serving a webhook: the
 * service caller path with the owner email as the access email. A missing
 * `accessEmail` would make the service-token path unrestricted. A missing
 * session and a session this owner cannot reach answer the same way.
 */
async function targetSessionReachable(
  management: InboundWebhookManagement,
  ownerEmail: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await management.requireSessionAccess({
      request: SERVICE_CALLER,
      sessionId,
      accessEmail: ownerEmail,
    });
    return true;
  } catch (error) {
    if (error instanceof SessionResourceAccessError) return false;
    throw error;
  }
}

/** Same access judgment as the sender: the user is allowed and still reaches the session. */
async function issuerCanAccessSession(
  management: OutboundWebhookManagement,
  ownerEmail: string,
  sessionId: string,
): Promise<boolean> {
  try {
    if (await management.authorizeUser({ email: ownerEmail })) return false;
    await management.sessionAccess.requireSessionAccess({
      request: SERVICE_CALLER,
      sessionId,
      accessEmail: ownerEmail,
    });
    return true;
  } catch {
    return false;
  }
}

function inboundWebhookSummary(
  grant: ExternalAccessGrantSummary,
  publicUrl: string,
  recent: ExternalGrantRecentSummary | undefined,
) {
  return {
    id: grant.id,
    label: grant.label,
    target_session_id: grant.target_session_id,
    auth_mode: grant.auth_mode,
    preamble: grant.preamble,
    url: buildInboundWebhookUrl(publicUrl, grant.id),
    created_at: grant.created_at.toISOString(),
    expires_at: grant.expires_at?.toISOString() ?? null,
    revoked_at: grant.revoked_at?.toISOString() ?? null,
    last_used_at: grant.last_used_at?.toISOString() ?? null,
    state: grantState(grant),
    ...(recent === undefined ? {} : { recent }),
  };
}

function grantState(grant: ExternalAccessGrantSummary): "active" | "expired" | "revoked" {
  if (grant.revoked_at !== null) return "revoked";
  if (grant.expires_at !== null && grant.expires_at.getTime() <= Date.now()) return "expired";
  return "active";
}

function deliveryView(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    event_id: row.event_id,
    event_type: row.event_type,
    state: row.state,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
  };
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function failure(
  code: "session_not_found" | "forbidden" | "not_found" | "subscription_inactive",
): WebhookManagementFailure {
  return { ok: false, code };
}
