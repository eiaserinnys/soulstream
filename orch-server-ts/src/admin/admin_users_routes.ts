import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type AdminDashboardUser = {
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  allowedFolderIds: string[];
  createdAt: string;
  createdBy: string | null;
};

export type AdminUserCreateInput = {
  email: string;
  displayName?: string | null;
  isAdmin: boolean;
  allowedFolderIds: string[];
  createdBy: string;
};

export type AdminUserUpdateInput = {
  displayName?: string | null;
  isAdmin?: boolean | null;
  allowedFolderIds?: string[] | null;
};

export type AdminUsersRouteProvider = {
  currentEmail: (
    request: FastifyRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;
  isAdminEmail: (email: string) => Promise<boolean> | boolean;
  listUsers: () => Promise<readonly AdminDashboardUser[]> | readonly AdminDashboardUser[];
  listFolders: () => Promise<readonly unknown[]> | readonly unknown[];
  createUser: (input: AdminUserCreateInput) => Promise<AdminDashboardUser>;
  updateUser: (
    email: string,
    update: AdminUserUpdateInput,
  ) => Promise<AdminDashboardUser>;
  deleteUser: (email: string) => Promise<void>;
  canRemoveAdmin: (email: string) => Promise<boolean> | boolean;
  broadcastAccessChange: () => Promise<void> | void;
};

export type AdminUsersRouteOptions = {
  provider: AdminUsersRouteProvider;
};

export class AdminUsersRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "AdminUsersRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

type AdminUsersParams = {
  email: string;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LAST_ADMIN_DETAIL = "At least one admin user is required";

export const adminUsersRouteAuthRequirements = {
  "GET /api/admin/users": true,
  "POST /api/admin/users": true,
  "PATCH /api/admin/users/:email": true,
  "DELETE /api/admin/users/:email": true,
} as const;

export function registerAdminUsersRoutes(
  app: FastifyInstance,
  options: AdminUsersRouteOptions,
): void {
  app.get("/api/admin/users", async (request, reply) => {
    const adminEmail = await requireAdmin(request, reply, options.provider);
    if (adminEmail === undefined) return reply;

    const [users, folders] = await Promise.all([
      options.provider.listUsers(),
      options.provider.listFolders(),
    ]);
    return reply.send({ users, folders });
  });

  app.post("/api/admin/users", async (request, reply) => {
    const adminEmail = await requireAdmin(request, reply, options.provider);
    if (adminEmail === undefined) return reply;

    const body = parseObjectBody(request.body);
    if (!body.ok) return badRequest(reply, body.message);
    const createInput = parseCreateBody(body.value, adminEmail);
    if (!createInput.ok) return badRequest(reply, createInput.message);

    try {
      const user = await options.provider.createUser(createInput.value);
      await options.provider.broadcastAccessChange();
      return reply.code(201).send({ user });
    } catch (error) {
      return sendProviderError(reply, error, 400);
    }
  });

  app.patch<{ Params: AdminUsersParams }>(
    "/api/admin/users/:email",
    async (request, reply) => {
      const adminEmail = await requireAdmin(request, reply, options.provider);
      if (adminEmail === undefined) return reply;

      const targetEmail = normalizeEmail(adminUsersParams(request).email);
      if (!targetEmail.ok) return badRequest(reply, targetEmail.message);

      const body = parseObjectBody(request.body);
      if (!body.ok) return badRequest(reply, body.message);
      const update = parsePatchBody(body.value);
      if (!update.ok) return badRequest(reply, update.message);

      if (
        targetEmail.value === adminEmail &&
        hasOwn(body.value, "isAdmin") &&
        update.value.isAdmin === false &&
        !(await options.provider.canRemoveAdmin(targetEmail.value))
      ) {
        return reply.code(400).send({ detail: LAST_ADMIN_DETAIL });
      }

      try {
        const user = await options.provider.updateUser(targetEmail.value, update.value);
        await options.provider.broadcastAccessChange();
        return reply.send({ user });
      } catch (error) {
        return sendProviderError(reply, error, 400);
      }
    },
  );

  app.delete<{ Params: AdminUsersParams }>(
    "/api/admin/users/:email",
    async (request, reply) => {
      const adminEmail = await requireAdmin(request, reply, options.provider);
      if (adminEmail === undefined) return reply;

      const targetEmail = normalizeEmail(adminUsersParams(request).email);
      if (!targetEmail.ok) return badRequest(reply, targetEmail.message);

      if (
        targetEmail.value === adminEmail &&
        !(await options.provider.canRemoveAdmin(targetEmail.value))
      ) {
        return reply.code(400).send({ detail: LAST_ADMIN_DETAIL });
      }

      try {
        await options.provider.deleteUser(targetEmail.value);
        await options.provider.broadcastAccessChange();
        return reply.send({ success: true });
      } catch (error) {
        return sendProviderError(reply, error, 400);
      }
    },
  );
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: AdminUsersRouteProvider,
): Promise<string | undefined> {
  const email = normalizeEmail(await provider.currentEmail(request));
  if (!email.ok) {
    reply.code(401).send({ detail: "Authentication required" });
    return undefined;
  }
  if (!(await provider.isAdminEmail(email.value))) {
    reply.code(403).send({ detail: "Admin access required" });
    return undefined;
  }
  return email.value;
}

function parseCreateBody(
  body: Record<string, unknown>,
  adminEmail: string,
): Validation<AdminUserCreateInput> {
  const email = normalizeEmail(body.email);
  if (!email.ok) return email;

  const displayName = optionalStringOrNull(body, "displayName");
  if (!displayName.ok) return displayName;
  const isAdmin = optionalBooleanOrNull(body, "isAdmin");
  if (!isAdmin.ok) return isAdmin;
  if (isAdmin.value === null) {
    return { ok: false, message: "isAdmin must be a boolean" };
  }
  const allowedFolderIds = optionalFolderIds(body, "allowedFolderIds", []);
  if (!allowedFolderIds.ok) return allowedFolderIds;
  if (allowedFolderIds.value === null) {
    return { ok: false, message: "allowedFolderIds must be an array" };
  }

  return {
    ok: true,
    value: {
      email: email.value,
      ...(displayName.value !== undefined ? { displayName: displayName.value } : {}),
      isAdmin: isAdmin.value ?? false,
      allowedFolderIds: allowedFolderIds.value,
      createdBy: adminEmail,
    },
  };
}

function parsePatchBody(
  body: Record<string, unknown>,
): Validation<AdminUserUpdateInput> {
  const update: AdminUserUpdateInput = {};
  if (hasOwn(body, "displayName")) {
    const displayName = optionalStringOrNull(body, "displayName");
    if (!displayName.ok) return displayName;
    update.displayName = displayName.value ?? null;
  }
  if (hasOwn(body, "isAdmin")) {
    const isAdmin = optionalBooleanOrNull(body, "isAdmin");
    if (!isAdmin.ok) return isAdmin;
    update.isAdmin = isAdmin.value ?? null;
  }
  if (hasOwn(body, "allowedFolderIds")) {
    const allowedFolderIds = optionalFolderIds(body, "allowedFolderIds", undefined);
    if (!allowedFolderIds.ok) return allowedFolderIds;
    update.allowedFolderIds = allowedFolderIds.value ?? null;
  }
  return { ok: true, value: update };
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function optionalStringOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<string | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null || typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string or null` };
}

function optionalBooleanOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<boolean | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null || typeof value === "boolean") return { ok: true, value };
  return { ok: false, message: `${key} must be a boolean or null` };
}

function optionalFolderIds(
  body: Record<string, unknown>,
  key: string,
  defaultValue: string[] | undefined,
): Validation<string[] | null> {
  if (!hasOwn(body, key)) {
    return { ok: true, value: defaultValue ?? null };
  }
  const value = body[key];
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, message: `${key} must be an array` };
  }
  return { ok: true, value: normalizeFolderIds(value) };
}

function normalizeEmail(value: unknown): Validation<string> {
  if (typeof value !== "string") return { ok: false, message: "Invalid email" };
  const email = value.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, message: "Invalid email" };
  }
  return { ok: true, value: email };
}

function normalizeFolderIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const folderId = String(value).trim();
    if (!folderId || seen.has(folderId)) continue;
    seen.add(folderId);
    result.push(folderId);
  }
  return result;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ detail: message });
}

function sendProviderError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatusCode: number,
): FastifyReply {
  if (error instanceof AdminUsersRouteError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  const message = error instanceof Error ? error.message : "Admin users route failed";
  return reply.code(fallbackStatusCode).send({ detail: message });
}

function adminUsersParams(request: FastifyRequest): AdminUsersParams {
  return request.params as AdminUsersParams;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
