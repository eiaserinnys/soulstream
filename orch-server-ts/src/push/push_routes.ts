import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type PushJwtUser = {
  email?: string | null;
  [key: string]: unknown;
};

export type PushJwtUserResolver = (
  request: FastifyRequest,
) => Promise<PushJwtUser | null | undefined> | PushJwtUser | null | undefined;

export type PushRegistrationRepository = {
  upsertToken: (
    email: string,
    deviceId: string,
    token: string,
  ) => Promise<void> | void;
  deleteToken: (email: string, deviceId: string) => Promise<void> | void;
};

export type PushRouteOptions = {
  repository: PushRegistrationRepository;
  resolveJwtUser: PushJwtUserResolver;
};

export const PUSH_JWT_REQUIRED_DETAIL =
  "JWT authentication required for push registration";

export const pushRouteAuthRequirements = {
  "POST /api/push/register": true,
  "DELETE /api/push/register/:device_id": true,
} as const;

type RegisterPayload = {
  token: string;
  deviceId: string;
};

export function registerPushRoutes(
  app: FastifyInstance,
  options: PushRouteOptions,
): void {
  app.post("/api/push/register", async (request, reply) => {
    const user = await requireJwtUser(request, reply, options.resolveJwtUser);
    if (user === undefined) return reply;
    const payload = parseRegisterPayload(request.body);
    if (!payload.ok) {
      return reply.code(422).send({ detail: payload.detail });
    }
    await options.repository.upsertToken(user.email, payload.value.deviceId, payload.value.token);
    return { ok: true };
  });

  app.delete<{ Params: { device_id: string } }>(
    "/api/push/register/:device_id",
    async (request, reply) => {
      const user = await requireJwtUser(request, reply, options.resolveJwtUser);
      if (user === undefined) return reply;
      await options.repository.deleteToken(user.email, request.params.device_id);
      return { ok: true };
    },
  );
}

async function requireJwtUser(
  request: FastifyRequest,
  reply: FastifyReply,
  resolver: PushJwtUserResolver,
): Promise<{ email: string } | undefined> {
  const user = await resolver(request);
  if (typeof user?.email !== "string" || user.email.length === 0) {
    reply.code(401).send({ detail: PUSH_JWT_REQUIRED_DETAIL });
    return undefined;
  }
  return { email: user.email };
}

function parseRegisterPayload(
  body: unknown,
): { ok: true; value: RegisterPayload } | { ok: false; detail: string } {
  if (!isJsonObject(body)) {
    return { ok: false, detail: "Request body must be a JSON object" };
  }
  if (typeof body.token !== "string") {
    return { ok: false, detail: "token is required" };
  }
  if (typeof body.deviceId !== "string") {
    return { ok: false, detail: "deviceId is required" };
  }
  return {
    ok: true,
    value: {
      token: body.token,
      deviceId: body.deviceId,
    },
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
