import { asRecord } from "@soulstream/wire-schema/json-record";
import { isServiceCaller, type ServiceCaller } from "../auth/service_caller.js";
import type { FastifyRequest } from "fastify";
import postgres from "postgres";

import {
  AUTH_COOKIE_NAME,
  type AuthJwtHelper,
  type AuthJwtPayload,
  type AuthTokenAccessResult,
  type AuthUserPayloadExtra,
} from "../auth/auth_routes.js";
import { resolveTailscaleIdentity } from "../auth/tailscale_identity.js";
import { resolveDashboardLoginMode } from "../auth/login_mode.js";
import {
  serviceBearerFailure,
  verifyServiceBearerAuthorization,
} from "../auth/service_bearer.js";
import type { NodeCredentialResolver } from "../node_credentials/types.js";
import type { BoardItemAccessProvider } from "../board/board_item_routes.js";
import type { MarkdownDocumentAccessProvider } from "../board/markdown_document_routes.js";
import type { FolderAccessProvider } from "../folders/folder_routes.js";
import type { OAuthResourceAccess } from "../oauth/oauth_access.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import { requireLiveDatabaseUrl } from "./live_db_sql.js";
import {
  extractDashboardBearerToken,
  extractDashboardJwtCookieToken,
  type LiveDashboardTokenVerifier,
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
  readonly repository: DashboardUserRepository;
  readonly cookieName?: string;
  readonly verifyDashboardToken?: LiveDashboardTokenVerifier;
  readonly resolveOAuthAccess?: (request: FastifyRequest) => Promise<OAuthResourceAccess | null>;
  /** Node pairing credentials; `null` is explicit outside production composition. */
  readonly nodeCredentials: NodeCredentialResolver | null;
};

export type DashboardAccessResolveContext = {
  readonly accessEmail?: string | null;
};

export type LiveDashboardAccessProvider =
  & FolderAccessProvider
  & BoardItemAccessProvider
  & MarkdownDocumentAccessProvider
  & {
    readonly isAdminEmail: (email: string) => Promise<boolean>;
    readonly resolveAccess: (
      request: FastifyRequest | ServiceCaller,
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
  if (options.repository === undefined) {
    throw new Error("repository is required");
  }
  const repository = options.repository;
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;

  return {
    async isAdminEmail(email) {
      const user = await repository.findUserByEmail(normalizeDashboardEmail(email));
      return user?.isAdmin === true;
    },
    async resolveAccess(
      request: FastifyRequest | ServiceCaller,
      context?: DashboardAccessResolveContext,
    ) {
      const identity = await resolveAccessIdentity({
        request,
        configProvider: options.configProvider,
        jwt: options.jwt,
        verifyDashboardToken: options.verifyDashboardToken,
        resolveOAuthAccess: options.resolveOAuthAccess,
        cookieName,
        accessEmail: context?.accessEmail,
        nodeCredentials: options.nodeCredentials,
      });
      if (identity.mode === "service_token" && identity.accessEmail === null) {
        return serviceTokenAccessWithoutEmail();
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
    const databaseUrl = options.databaseUrl ?? await requireLiveDatabaseUrl(options.configProvider);
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
  readonly request: FastifyRequest | ServiceCaller;
  readonly configProvider: LiveConfigProviderBoundary;
  readonly jwt: AuthJwtHelper;
  readonly verifyDashboardToken?: LiveDashboardTokenVerifier;
  readonly resolveOAuthAccess?: (request: FastifyRequest) => Promise<OAuthResourceAccess | null>;
  readonly cookieName: string;
  readonly accessEmail?: string | null;
  readonly nodeCredentials: NodeCredentialResolver | null;
}): Promise<AccessIdentity> {
  if (isServiceCaller(input.request)) return { mode: "service_token", accessEmail: input.accessEmail ?? null };
  const snapshot = await input.configProvider.getConfig();
  const configuredBearer = optionalConfigString(snapshot, "auth_bearer_token");
  const environment = requiredSnapshotString(snapshot, "environment");
  const googleClientId = requiredSnapshotString(snapshot, "google_client_id");
  const loginMode = resolveDashboardLoginMode({
    google_client_id: googleClientId,
    tailscale_auth_enabled: snapshot.tailscale_auth_enabled === true,
    dashboard_admin_password:
      optionalConfigString(snapshot, "dashboard_admin_password") ?? "",
  });
  const accessEmail = input.accessEmail !== undefined
    ? input.accessEmail
    : extractAccessEmail(input.request);

  if (loginMode !== "none" && loginMode !== "tailscale") {
    const cookieToken = extractDashboardJwtCookieToken(input.request, input.cookieName);
    if (cookieToken) {
      const payload = await verifyDashboardToken({ ...input, request: input.request }, cookieToken);
      if (payload) {
        return { mode: "dashboard", email: normalizeDashboardEmail(payload.email) };
      }
    }
  }

  const bearer = verifyServiceBearer(
    input.request,
    configuredBearer ?? "",
    environment,
    input.nodeCredentials,
    loginMode === "password" || loginMode === "tailscale",
  );
  if (bearer.ok) return { mode: "service_token", accessEmail };

  if (loginMode === "tailscale") {
    const email = resolveTailscaleIdentity(input.request.headers, optionalConfigString(snapshot, "tailscale_allowed_login") ?? "");
    if (email) return { mode: "dashboard", email };
    throw new DashboardAccessError("AUTHENTICATION_REQUIRED", bearer.detail, bearer.statusCode ?? 401);
  }

  if (loginMode === "google") {
    const dashboardToken = extractDashboardBearerToken(input.request);
    if (dashboardToken) {
      const payload = await verifyDashboardToken({ ...input, request: input.request }, dashboardToken);
      if (payload) {
        return { mode: "dashboard", email: normalizeDashboardEmail(payload.email) };
      }
    }
  }

  const oauthAccess = await input.resolveOAuthAccess?.(input.request);
  if (oauthAccess) return { mode: "dashboard", email: normalizeDashboardEmail(oauthAccess.email) };

  throw new DashboardAccessError(
    "AUTHENTICATION_REQUIRED",
    bearer.detail,
    bearer.statusCode ?? 401,
  );
}

async function verifyDashboardToken(
  input: {
    readonly request: FastifyRequest;
    readonly jwt: AuthJwtHelper;
    readonly verifyDashboardToken?: LiveDashboardTokenVerifier;
  },
  token: string,
): Promise<AuthJwtPayload | null> {
  return input.verifyDashboardToken === undefined
    ? await input.jwt.verifyToken(token)
    : await input.verifyDashboardToken(input.request, token);
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

/** Access for the worker service identity, which supplies no access email. */
export function serviceTokenAccessWithoutEmail(): DashboardAccess {
  return unrestrictedAccess();
}

function restrictedAccess(allowedFolderIds: readonly string[]): DashboardAccess {
  return { restricted: true, allowedFolderIds: [...allowedFolderIds] };
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
    asRecord(request.query)?.access_email,
    asRecord(request.query)?.accessEmail,
    asRecord(request.body)?.access_email,
    asRecord(request.body)?.accessEmail,
    asRecord(asRecord(request.body)?.caller_info)?.email,
    asRecord(asRecord(request.body)?.caller_info)?.callerEmail,
    asRecord(asRecord(request.body)?.callerInfo)?.email,
    asRecord(asRecord(request.body)?.callerInfo)?.callerEmail,
  ]) {
    if (typeof value === "string") return value;
  }
  return null;
}

function verifyServiceBearer(
  request: FastifyRequest,
  configuredBearer: string,
  environment: string,
  nodeCredentials: NodeCredentialResolver | null,
  rejectDevelopmentBypass: boolean,
): AuthTokenAccessResult {
  const verification = verifyServiceBearerAuthorization(
    request.headers.authorization,
    {
      configuredToken: configuredBearer,
      environment,
      nodeCredentials,
    },
  );
  if (verification.ok && verification.developmentBypass && rejectDevelopmentBypass) {
    return serviceBearerFailure({ ok: false, reason: "missing", statusCode: 401 });
  }
  return verification.ok ? { ok: true } : serviceBearerFailure(verification);
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

function defaultPostgresFactory(
  databaseUrl: string,
  options: { readonly max: number },
): DashboardPostgresSql {
  return postgres(databaseUrl, options) as unknown as DashboardPostgresSql;
}
