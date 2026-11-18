import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AdminAccessProvider } from "../admin/admin_access.js";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import {
  SessionResourceAccessError,
  type SessionRequestAccessGuard,
} from "../session/session_resource_access.js";
import type {
  ExternalAccessGrantRepository,
  ExternalAccessGrantSummary,
  ExternalAccessPermission,
} from "./external_access_grant_repository.js";

/**
 * Access link management API (design 3.1).
 *
 * Signed-in users issue, list, and revoke their own expiring links. The raw key
 * leaves the store only in the issue response; list and revoke responses carry
 * the grant summary without key material or URL. The public `/x/<key>` surface
 * is a separate unit and is not registered here.
 */

export const accessLinkRouteAuthRequirements = {
  "POST /api/access-links": true,
  "GET /api/access-links": true,
  "DELETE /api/access-links/:id": true,
} as const;

export type AccessLinkRouteOptions = Pick<AdminAccessProvider, "currentEmail"> & {
  grants: Pick<ExternalAccessGrantRepository, "issue" | "list" | "revoke">;
  requireSessionAccess: SessionRequestAccessGuard["requireSessionAccess"];
  /** Public origin the link URLs are built from; a trailing slash is collapsed. */
  publicUrl: string;
};

const PERMISSIONS = [
  "send",
  "read_own",
  "read_history",
  "control",
] as const satisfies readonly ExternalAccessPermission[];
const DEFAULT_PERMISSIONS: readonly ExternalAccessPermission[] = ["send", "read_own"];
const MAX_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;

const issueBodySchema = z
  .object({
    target_session_id: z.uuid(),
    label: z.string().trim().min(1).max(80),
    permissions: z.array(z.enum(PERMISSIONS)).min(1).optional(),
    expires_in_seconds: z.number().int().min(60).max(MAX_EXPIRES_IN_SECONDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.permissions !== undefined
      && new Set(value.permissions).size !== value.permissions.length) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "permissions must not repeat",
      });
    }
  });

const grantIdParamsSchema = z.object({ id: z.uuid() }).strict();

class AccessLinkRouteError extends Error {
  constructor(readonly statusCode: 401 | 404, message: string) {
    super(message);
    this.name = "AccessLinkRouteError";
  }
}

export function registerAccessLinkRoutes(
  app: FastifyInstance,
  options: AccessLinkRouteOptions,
): void {
  app.post("/api/access-links", async (request, reply) => {
    try {
      const email = await requireEmail(options, request);
      const input = issueBodySchema.parse(request.body ?? {});
      const permissions = input.permissions ?? DEFAULT_PERMISSIONS;
      await requireTargetSessionAccess(options, email, input.target_session_id);
      const issued = await options.grants.issue({
        kind: "link",
        ownerEmail: email,
        label: input.label,
        targetSessionId: input.target_session_id,
        permissions,
        expiresInSeconds: input.expires_in_seconds,
      });
      reply.code(201).header("Cache-Control", "no-store");
      return {
        id: issued.grant.id,
        url: buildAccessLinkUrl(options.publicUrl, issued.key),
        label: issued.grant.label,
        target_session_id: issued.grant.target_session_id,
        permissions: issued.grant.permissions,
        expires_at: issued.grant.expires_at?.toISOString() ?? null,
      };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/access-links", async (request, reply) => {
    try {
      const email = await requireEmail(options, request);
      const grants = await options.grants.list(email);
      return grants
        .filter((grant) => grant.kind === "link")
        .map(accessLinkSummary);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/access-links/:id", async (request, reply) => {
    try {
      const email = await requireEmail(options, request);
      const { id } = grantIdParamsSchema.parse(request.params);
      const revoked = await options.grants.revoke(email, id);
      if (revoked === null) {
        throw new AccessLinkRouteError(404, "Access link not found");
      }
      return accessLinkSummary(revoked);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

/** `${publicUrl}/x/${key}` with any trailing slashes on the origin collapsed. */
export function buildAccessLinkUrl(publicUrl: string, key: string): string {
  return `${publicUrl.trim().replace(/\/+$/, "")}/x/${key}`;
}

async function requireEmail(
  options: AccessLinkRouteOptions,
  request: FastifyRequest,
): Promise<string> {
  const email = (await options.currentEmail(request))?.trim().toLowerCase();
  if (!email) throw new AccessLinkRouteError(401, "Authentication required");
  return email;
}

/**
 * The same access judgment `resolveGrant` makes before serving a link: the
 * service caller path with the login email as the access email. A missing
 * `accessEmail` would make the service-token path unrestricted.
 */
async function requireTargetSessionAccess(
  options: AccessLinkRouteOptions,
  email: string,
  sessionId: string,
): Promise<void> {
  try {
    await options.requireSessionAccess({
      request: SERVICE_CALLER,
      sessionId,
      accessEmail: email,
    });
  } catch (error) {
    // A missing session and a session this user cannot reach answer the same 404.
    if (error instanceof SessionResourceAccessError) {
      throw new AccessLinkRouteError(404, "Session not found");
    }
    throw error;
  }
}

function accessLinkSummary(grant: ExternalAccessGrantSummary) {
  return {
    id: grant.id,
    label: grant.label,
    target_session_id: grant.target_session_id,
    permissions: grant.permissions,
    created_at: grant.created_at.toISOString(),
    expires_at: grant.expires_at?.toISOString() ?? null,
    revoked_at: grant.revoked_at?.toISOString() ?? null,
    last_used_at: grant.last_used_at?.toISOString() ?? null,
  };
}

function sendRouteError(reply: FastifyReply, error: unknown) {
  const status = error instanceof AccessLinkRouteError
    ? error.statusCode
    : error instanceof z.ZodError
    ? 422
    : 503;
  return reply.code(status).send({
    detail: error instanceof AccessLinkRouteError
      ? error.message
      : status === 422
      ? "Invalid access link request"
      : "Access link storage temporarily unavailable",
  });
}
