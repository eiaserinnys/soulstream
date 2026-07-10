import type { FastifyRequest } from "fastify";
import postgres from "postgres";

import {
  AUTH_COOKIE_NAME,
  type AuthJwtHelper,
  type AuthJwtPayload,
  type AuthTokenAccessResult,
  type AuthUserPayloadExtra,
} from "../auth/auth_routes.js";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { BoardItemAccessProvider } from "../board/board_item_routes.js";
import type { MarkdownDocumentAccessProvider } from "../board/markdown_document_routes.js";
import type { FolderAccessProvider } from "../folders/folder_routes.js";
import type { RunbookAccessProvider } from "../runbooks/runbook_route_types.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import {
  extractDashboardBearerToken,
  extractDashboardJwtCookieToken,
} from "./live_authenticated_user_resolver.js";

export type DashboardAccess = {
  readonly restricted: boolean;
  readonly allowedFolderIds: readonly string[];
};

export type DashboardUserRecord = {
  readonly email: string;
  readonly isAdmin: boolean;
  readonly allowedFolderIds: readonly string[];
};

export type DashboardUserRepository = {
  readonly findUserByEmail: (
    email: string,
  ) => DashboardUserRecord | null | Promise<DashboardUserRecord | null>;
  readonly close?: () => Promise<void>;
};

export type DashboardPostgresSql = {
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;
  readonly end?: (options?: { readonly timeout?: number }) => Promise<void>;
};

export type DashboardPostgresFactory = (
  databaseUrl: string,
  options: { readonly max: number },
) => DashboardPostgresSql;

export type CreatePostgresDashboardUserRepositoryOptions = {
  readonly sql?: DashboardPostgresSql;
  readonly postgresFactory?: DashboardPostgresFactory;
  readonly databaseUrl?: string;
  readonly configProvider?: LiveConfigProviderBoundary;
  readonly maxConnections?: number;
  readonly closeTimeoutSeconds?: number;
};

export type CreateLiveDashboardAccessProviderOptions = {
  readonly configProvider: LiveConfigProviderBoundary;
  readonly jwt: AuthJwtHelper;
  readonly repository?: DashboardUserRepository;
  readonly cookieName?: string;
};

export type DashboardAccessResolveContext = {
  readonly accessEmail?: string | null;
};

export type LiveDashboardAccessProvider =
  & FolderAccessProvider
  & BoardItemAccessProvider
  & MarkdownDocumentAccessProvider
  & RunbookAccessProvider
  & {
    readonly isAdminEmail: (email: string) => Promise<boolean>;
    readonly resolveAccess: (
      request: FastifyRequest,
      context?: DashboardAccessResolveContext,
    ) => Promise<DashboardAccess>;
    readonly userPayloadExtra: AuthUserPayloadExtra;
    readonly close: () => Promise<void>;
  };

type AccessIdentity =
  | { readonly mode: "service_token"; readonly accessEmail: string | null }
  | { readonly mode: "dashboard"; readonly email: string };

const DEFAULT_POSTGRES_MAX_CONNECTIONS = 5;
const DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS = 5;

export class DashboardAccessError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "DashboardAccessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createLiveDashboardAccessProvider(
  options: CreateLiveDashboardAccessProviderOptions,
): LiveDashboardAccessProvider {
  const repository = options.repository ??
    createPostgresDashboardUserRepository({ configProvider: options.configProvider });
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;

  return {
    async isAdminEmail(email) {
      const user = await repository.findUserByEmail(normalizeDashboardEmail(email));
      return user?.isAdmin === true;
    },
    async resolveAccess(
      request: FastifyRequest,
      context?: DashboardAccessResolveContext,
    ) {
      const identity = await resolveAccessIdentity({
        request,
        configProvider: options.configProvider,
        jwt: options.jwt,
        cookieName,
        accessEmail: context?.accessEmail,
      });
      if (identity.mode === "service_token" && identity.accessEmail === null) {
        return unrestrictedAccess();
      }
      const email = identity.mode === "service_token"
        ? identity.accessEmail
        : identity.email;
      return accessForUser(await repository.findUserByEmail(normalizeDashboardEmail(email)));
    },
    async userPayloadExtra(payload: AuthJwtPayload) {
      const email = normalizeDashboardEmail(payload.email);
      const user = await repository.findUserByEmail(email);
      return {
        isAdmin: user?.isAdmin === true,
        dashboardAccess: accessPayload(accessForUser(user)),
      };
    },
    async close() {
      await repository.close?.();
    },
  };
}

export function createPostgresDashboardUserRepository(
  options: CreatePostgresDashboardUserRepositoryOptions,
): DashboardUserRepository & { readonly close: () => Promise<void> } {
  let sql = options.sql;
  let ownsSql = false;
  const maxConnections = options.maxConnections ?? DEFAULT_POSTGRES_MAX_CONNECTIONS;
  const closeTimeoutSeconds = options.closeTimeoutSeconds ??
    DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS;

  async function resolveSql(): Promise<DashboardPostgresSql> {
    if (sql !== undefined) return sql;
    const databaseUrl = options.databaseUrl ?? await requireDatabaseUrl(options.configProvider);
    const factory = options.postgresFactory ?? defaultPostgresFactory;
    sql = factory(databaseUrl, { max: maxConnections });
    ownsSql = true;
    return sql;
  }

  return {
    async findUserByEmail(email) {
      const normalized = normalizeDashboardEmail(email);
      if (!normalized) return null;
      const rows = await (await resolveSql())`
        SELECT email, is_admin, allowed_folder_ids
        FROM users
        WHERE email = ${normalized}
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? null : dashboardUserFromRow(row);
    },
    async close() {
      if (ownsSql) {
        await sql?.end?.({ timeout: closeTimeoutSeconds });
        sql = undefined;
        ownsSql = false;
      }
    },
  };
}

export function normalizeDashboardEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

async function resolveAccessIdentity(input: {
  readonly request: FastifyRequest;
  readonly configProvider: LiveConfigProviderBoundary;
  readonly jwt: AuthJwtHelper;
  readonly cookieName: string;
  readonly accessEmail?: string | null;
}): Promise<AccessIdentity> {
  const snapshot = await input.configProvider.getConfig();
  const configuredBearer = optionalConfigString(snapshot, "auth_bearer_token");
  const environment = requiredSnapshotString(snapshot, "environment");
  const googleClientId = requiredSnapshotString(snapshot, "google_client_id");
  const accessEmail = input.accessEmail !== undefined
    ? input.accessEmail
    : extractAccessEmail(input.request);

  if (googleClientId.length > 0) {
    const cookieToken = extractDashboardJwtCookieToken(input.request, input.cookieName);
    if (cookieToken) {
      const payload = await input.jwt.verifyToken(cookieToken);
      if (payload) {
        return { mode: "dashboard", email: normalizeDashboardEmail(payload.email) };
      }
    }
  }

  let bearer: AuthTokenAccessResult;
  if (!configuredBearer) {
    if (!isProductionEnvironment(environment)) {
      return { mode: "service_token", accessEmail };
    }
    bearer = {
      ok: false,
      statusCode: 500,
      detail: "Authentication not configured",
    };
  } else {
    bearer = verifyServiceBearer(input.request, configuredBearer);
    if (bearer.ok) return { mode: "service_token", accessEmail };
  }

  if (googleClientId.length > 0) {
    const dashboardToken = extractDashboardBearerToken(input.request);
    if (dashboardToken) {
      const payload = await input.jwt.verifyToken(dashboardToken);
      if (payload) {
        return { mode: "dashboard", email: normalizeDashboardEmail(payload.email) };
      }
    }
  }

  throw new DashboardAccessError(
    "AUTHENTICATION_REQUIRED",
    bearer.detail,
    bearer.statusCode ?? 401,
  );
}

function accessForUser(user: DashboardUserRecord | null): DashboardAccess {
  if (user === null) return restrictedAccess([]);
  if (user.isAdmin || user.allowedFolderIds.length === 0) return unrestrictedAccess();
  return restrictedAccess(user.allowedFolderIds);
}

function accessPayload(access: DashboardAccess): DashboardAccess {
  return {
    restricted: access.restricted,
    allowedFolderIds: [...access.allowedFolderIds],
  };
}

function unrestrictedAccess(): DashboardAccess {
  return { restricted: false, allowedFolderIds: [] };
}

function restrictedAccess(allowedFolderIds: readonly string[]): DashboardAccess {
  return { restricted: true, allowedFolderIds: [...allowedFolderIds] };
}

async function requireDatabaseUrl(
  configProvider: LiveConfigProviderBoundary | undefined,
): Promise<string> {
  if (configProvider === undefined) {
    throw new Error("databaseUrl is required");
  }
  let value: unknown;
  try {
    value = await configProvider.requireConfig("databaseUrl");
  } catch {
    throw new Error("databaseUrl is required");
  }
  if (typeof value !== "string") throw new Error("databaseUrl must be a string");
  if (value.length === 0) throw new Error("databaseUrl must be configured");
  return value;
}

function dashboardUserFromRow(row: Record<string, unknown>): DashboardUserRecord {
  return {
    email: normalizeDashboardEmail(stringValue(row.email)),
    isAdmin: row.is_admin === true || row.isAdmin === true,
    allowedFolderIds: normalizeFolderIds(
      row.allowed_folder_ids ?? row.allowedFolderIds,
    ),
  };
}

function normalizeFolderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((folderId): folderId is string => typeof folderId === "string")
    .map((folderId) => folderId.trim())
    .filter((folderId) => folderId.length > 0);
}

function extractAccessEmail(request: FastifyRequest): string | null {
  for (const value of [
    recordValue(request.query, "access_email"),
    recordValue(request.query, "accessEmail"),
    recordValue(request.body, "access_email"),
    recordValue(request.body, "accessEmail"),
    recordValue(recordValue(request.body, "caller_info"), "email"),
    recordValue(recordValue(request.body, "caller_info"), "callerEmail"),
    recordValue(recordValue(request.body, "callerInfo"), "email"),
    recordValue(recordValue(request.body, "callerInfo"), "callerEmail"),
  ]) {
    if (typeof value === "string") return value;
  }
  return null;
}

function verifyServiceBearer(
  request: FastifyRequest,
  configuredBearer: string,
): AuthTokenAccessResult {
  const verification = verifyServiceBearerAuthorization(
    request.headers.authorization,
    configuredBearer,
  );
  if (verification.ok) return { ok: true };
  if (verification.reason === "missing") {
    return {
      ok: false,
      statusCode: 401,
      detail: "Authorization header is required",
    };
  }
  if (verification.reason === "malformed") {
    return {
      ok: false,
      statusCode: 401,
      detail: "Bearer token format is invalid",
    };
  }
  return {
    ok: false,
    statusCode: 401,
    detail: "Invalid token",
  };
}

function recordValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredSnapshotString(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = snapshot[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalConfigString(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = snapshot[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function isProductionEnvironment(environment: string): boolean {
  return environment.toLowerCase() === "production";
}

function defaultPostgresFactory(
  databaseUrl: string,
  options: { readonly max: number },
): DashboardPostgresSql {
  return postgres(databaseUrl, options) as unknown as DashboardPostgresSql;
}
