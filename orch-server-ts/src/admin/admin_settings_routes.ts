import type { FastifyInstance, FastifyReply } from "fastify";

import {
  SessionReviewPolicyError,
  sessionReviewPolicyApiPayload,
  type SessionReviewPolicy,
} from "../system/session_review_policy.js";
import {
  requireAdmin,
  type AdminAccessProvider,
} from "./admin_access.js";

export type AdminSettingsProvider = AdminAccessProvider & {
  getSessionReviewPolicy: () => Promise<SessionReviewPolicy>;
  updateSessionReviewPolicy: (input: {
    sourceAllowlist: readonly unknown[];
    expectedVersion: number;
    updatedBy: string;
  }) => Promise<SessionReviewPolicy>;
};

export const adminSettingsRouteAuthRequirements = {
  "GET /api/admin/settings/session-review-policy": true,
  "PUT /api/admin/settings/session-review-policy": true,
} as const;

export function registerAdminSettingsRoutes(
  app: FastifyInstance,
  provider: AdminSettingsProvider,
): void {
  app.get("/api/admin/settings/session-review-policy", async (request, reply) => {
    const adminEmail = await requireAdmin(request, reply, provider);
    if (adminEmail === undefined) return reply;
    try {
      return reply.send(sessionReviewPolicyApiPayload(
        await provider.getSessionReviewPolicy(),
      ));
    } catch (error) {
      return sendPolicyError(reply, error);
    }
  });

  app.put("/api/admin/settings/session-review-policy", async (request, reply) => {
    const adminEmail = await requireAdmin(request, reply, provider);
    if (adminEmail === undefined) return reply;
    const body = objectBody(request.body);
    if (!body) return policyError(reply, 422, "SESSION_REVIEW_POLICY_INVALID", "Request body must be a JSON object");
    if (!Array.isArray(body.sourceAllowlist)) {
      return policyError(reply, 422, "SESSION_REVIEW_POLICY_INVALID", "sourceAllowlist must be an array");
    }
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      return policyError(reply, 422, "SESSION_REVIEW_POLICY_INVALID", "expectedVersion must be a positive integer");
    }
    try {
      const policy = await provider.updateSessionReviewPolicy({
        sourceAllowlist: body.sourceAllowlist,
        expectedVersion: Number(body.expectedVersion),
        updatedBy: adminEmail,
      });
      return reply.send(sessionReviewPolicyApiPayload(policy));
    } catch (error) {
      return sendPolicyError(reply, error);
    }
  });
}

function objectBody(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sendPolicyError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SessionReviewPolicyError) {
    return policyError(reply, error.statusCode, error.code, error.message);
  }
  throw error;
}

function policyError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ detail: { error: { code, message } } });
}
