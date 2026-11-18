import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { SERVICE_CALLER } from "../auth/service_caller.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import {
  SessionResourceAccessError,
  type SessionRequestAccessGuard,
} from "../session/session_resource_access.js";

/**
 * External access grants (design 2.1, 2.7).
 *
 * The grant row is the single credential record shared by expiring access links
 * (#1457) and inbound webhooks (#1458). This unit implements the key auth mode
 * only; signature verification is #1458 work.
 */

export const ACCESS_LINK_KEY_PREFIX = "ssxl";
export const INBOUND_WEBHOOK_KEY_PREFIX = "ssxw";

export type ExternalAccessKind = "link" | "inbound_webhook";
export type ExternalAccessPermission =
  | "send"
  | "read_own"
  | "read_history"
  | "control";
export type ExternalAccessAuthMode = "key" | "signature";

interface ExternalAccessGrantRow extends ExternalAccessGrant {
  target_session_exists: boolean;
}

export interface ExternalAccessGrant {
  id: string;
  kind: ExternalAccessKind;
  owner_email: string;
  label: string;
  target_session_id: string;
  permissions: ExternalAccessPermission[];
  auth_mode: ExternalAccessAuthMode;
  key_hash: string | null;
  signing_secret: string | null;
  preamble: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
}

/** Grant row as shown to its owner: the key material never leaves the store. */
export type ExternalAccessGrantSummary = Omit<
  ExternalAccessGrant,
  "key_hash" | "signing_secret"
>;

export type ResolveExternalAccessGrantResult =
  | { ok: true; grant: ExternalAccessGrant }
  | { ok: false; code: "unauthorized" | "forbidden"; status: 401 | 403 };

export interface IssueExternalAccessGrantInput {
  kind: ExternalAccessKind;
  ownerEmail: string;
  label: string;
  targetSessionId: string;
  permissions: readonly ExternalAccessPermission[];
  /** Required for links (design 2.1); optional for inbound webhooks. */
  expiresInSeconds?: number | null;
  preamble?: string | null;
}

export interface IssuedExternalAccessGrant {
  grant: ExternalAccessGrantSummary;
  /** The only time the raw key is exposed; only its sha256 is stored. */
  key: string;
}

export type ExternalGrantIssuerAuthorizer = (
  user: { email: string },
) => string | null | undefined | Promise<string | null | undefined>;

export interface ExternalAccessGrantRepositoryOptions {
  sql: SqlClient;
  /** Same judgment as createLiveAuthUserAuthorizer: null/undefined means allowed. */
  authorizeUser: ExternalGrantIssuerAuthorizer;
  /** Session folder ACL check; must receive owner_email as accessEmail. */
  requireSessionAccess: SessionRequestAccessGuard["requireSessionAccess"];
  now?: () => Date;
}

export class ExternalAccessGrantRepository {
  constructor(private readonly options: ExternalAccessGrantRepositoryOptions) {}

  async issue(
    input: IssueExternalAccessGrantInput,
  ): Promise<IssuedExternalAccessGrant> {
    if (input.kind === "link"
      && (input.expiresInSeconds === undefined || input.expiresInSeconds === null
        || !Number.isFinite(input.expiresInSeconds) || input.expiresInSeconds <= 0)) {
      throw new Error("Access links require expiresInSeconds");
    }
    const now = this.currentTime();
    const expiresAt = input.expiresInSeconds === undefined || input.expiresInSeconds === null
      ? null
      : new Date(now.getTime() + input.expiresInSeconds * 1000);
    const id = randomUUID();
    const key = buildExternalAccessKey(id, input.kind);
    const rows = await this.options.sql<ExternalAccessGrantSummary[]>`
      INSERT INTO external_access_grants (
        id, kind, owner_email, label, target_session_id, permissions,
        auth_mode, key_hash, signing_secret, preamble, expires_at, created_at
      ) VALUES (
        ${id}, ${input.kind}, ${input.ownerEmail}, ${input.label},
        ${input.targetSessionId}, ${[...input.permissions]}::TEXT[],
        'key', ${hashExternalAccessKey(key)}, NULL, ${input.preamble ?? null},
        ${expiresAt}, ${now}
      )
      RETURNING id, kind, owner_email, label, target_session_id, permissions,
                auth_mode, expires_at, revoked_at, created_at, last_used_at
    `;
    const grant = rows[0];
    if (grant === undefined) throw new Error("External access grant insert returned no row");
    return { grant, key };
  }

  async list(ownerEmail: string): Promise<ExternalAccessGrantSummary[]> {
    return await this.options.sql<ExternalAccessGrantSummary[]>`
      SELECT id, kind, owner_email, label, target_session_id, permissions,
             auth_mode, expires_at, revoked_at, created_at, last_used_at
      FROM external_access_grants
      WHERE owner_email = ${ownerEmail}
      ORDER BY created_at DESC
    `;
  }

  async revoke(
    ownerEmail: string,
    grantId: string,
  ): Promise<ExternalAccessGrantSummary | null> {
    const rows = await this.options.sql<ExternalAccessGrantSummary[]>`
      UPDATE external_access_grants
      SET revoked_at = NOW()
      WHERE id = ${grantId}
        AND owner_email = ${ownerEmail}
        AND revoked_at IS NULL
      RETURNING id, kind, owner_email, label, target_session_id, permissions,
                auth_mode, expires_at, revoked_at, created_at, last_used_at
    `;
    return rows[0] ?? null;
  }

  async touchLastUsedAt(grantId: string): Promise<void> {
    await this.options.sql`
      UPDATE external_access_grants
      SET last_used_at = NOW()
      WHERE id = ${grantId}
    `;
  }

  /**
   * Resolves a raw key to its grant. Every call re-reads the row (no cache) and
   * reports one generic `unauthorized` for any credential failure; a resolved
   * grant that lacks the required permission is `forbidden`.
   */
  async resolveGrant(
    rawKey: string,
    requiredPermission?: ExternalAccessPermission,
  ): Promise<ResolveExternalAccessGrantResult> {
    const parsed = parseExternalAccessKey(rawKey);
    if (parsed === null) return unauthorized();
    const rows = await this.options.sql<ExternalAccessGrantRow[]>`
      SELECT grant.id, grant.kind, grant.owner_email, grant.label,
             grant.target_session_id, grant.permissions, grant.auth_mode,
             grant.key_hash, grant.signing_secret, grant.preamble,
             grant.expires_at, grant.revoked_at, grant.created_at,
             grant.last_used_at,
             EXISTS (
               SELECT 1 FROM sessions target
               WHERE target.session_id = grant.target_session_id
             ) AS target_session_exists
      FROM external_access_grants grant
      WHERE grant.id = ${parsed.grantId}
    `;
    const grant = rows[0];
    if (grant === undefined || grant.target_session_exists !== true) {
      return unauthorized();
    }
    if (grant.auth_mode !== "key" || grant.key_hash === null) return unauthorized();
    if (!externalAccessKeyMatches(rawKey, grant.key_hash)) return unauthorized();
    if (grant.revoked_at !== null) return unauthorized();
    const now = this.currentTime().getTime();
    if (grant.expires_at !== null && grant.expires_at.getTime() <= now) {
      return unauthorized();
    }
    const denial = await this.options.authorizeUser({ email: grant.owner_email });
    if (denial !== null && denial !== undefined) return unauthorized();
    try {
      await this.options.requireSessionAccess({
        request: SERVICE_CALLER,
        sessionId: grant.target_session_id,
        // Without the email the service-token path is unrestricted (design 2.1).
        accessEmail: grant.owner_email,
      });
    } catch (error) {
      if (error instanceof SessionResourceAccessError) return unauthorized();
      throw error;
    }
    if (requiredPermission !== undefined
      && !grant.permissions.includes(requiredPermission)) {
      return { ok: false, code: "forbidden", status: 403 };
    }
    return { ok: true, grant };
  }

  private currentTime(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** `<prefix>_<grant id, 22 base64url chars>_<32 random bytes base64url>`. */
export function buildExternalAccessKey(
  grantId: string,
  kind: ExternalAccessKind,
): string {
  const prefix = kind === "inbound_webhook"
    ? INBOUND_WEBHOOK_KEY_PREFIX
    : ACCESS_LINK_KEY_PREFIX;
  return `${prefix}_${encodeGrantId(grantId)}_${randomBytes(32).toString("base64url")}`;
}

export function parseExternalAccessKey(
  rawKey: string,
): { grantId: string } | null {
  if (typeof rawKey !== "string") return null;
  // The secret is base64url and may itself contain "_", so the fixed-width
  // prefix and grant id token are read positionally.
  if (rawKey.length < 29) return null;
  const prefix = rawKey.slice(0, 4);
  if (prefix !== ACCESS_LINK_KEY_PREFIX && prefix !== INBOUND_WEBHOOK_KEY_PREFIX) {
    return null;
  }
  if (rawKey[4] !== "_" || rawKey[27] !== "_") return null;
  const token = rawKey.slice(5, 27);
  const secret = rawKey.slice(28);
  if (secret.length === 0) return null;
  const grantId = decodeGrantId(token);
  return grantId === null ? null : { grantId };
}

export function hashExternalAccessKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export function externalAccessKeyMatches(
  rawKey: string,
  storedHash: string,
): boolean {
  const computed = createHash("sha256").update(rawKey, "utf8").digest();
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(computed, stored);
}

function encodeGrantId(grantId: string): string {
  const hex = grantId.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error("External access grant id must be a UUID");
  }
  return Buffer.from(hex, "hex").toString("base64url");
}

function decodeGrantId(token: string): string | null {
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unauthorized(): ResolveExternalAccessGrantResult {
  return { ok: false, code: "unauthorized", status: 401 };
}
