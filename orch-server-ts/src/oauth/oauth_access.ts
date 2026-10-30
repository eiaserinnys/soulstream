import type { AuthUserAuthorizer } from "../auth/auth_routes.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { oauthAdapter } from "./oauth_adapter.js";

export const oauthScopes = ["conversations", "cards:read", "folders:read"] as const;

export type OAuthScope = (typeof oauthScopes)[number];

export type OAuthResourceAccess = {
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: readonly OAuthScope[];
};

export type OAuthScopeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly statusCode: 403; readonly detail: "Insufficient OAuth scope" };

type OAuthAccessTokenPayload = {
  accountId?: unknown;
  clientId?: unknown;
  scope?: unknown;
};

type OAuthClientPayload = {
  client_name?: unknown;
};

type OAuthProfilePayload = {
  email?: unknown;
  name?: unknown;
  picture?: unknown;
};

export type OAuthAccessTokenResolver = (token: string) => Promise<OAuthResourceAccess | null>;

/** Resolves an opaque bearer through the same adapter used by oidc-provider. */
export function createOAuthAccessTokenResolver(
  sql: SqlClient,
  authorizeUser?: AuthUserAuthorizer,
): OAuthAccessTokenResolver {
  const tokens = oauthAdapter(sql)("AccessToken");
  const clients = oauthAdapter(sql)("Client");
  const profiles = oauthAdapter(sql)("OAuthProfile");
  return async (token) => {
    if (token.length === 0 || token.length > 500) return null;
    const rawToken = await tokens.find(token) as OAuthAccessTokenPayload | undefined;
    if (typeof rawToken?.accountId !== "string" || typeof rawToken.clientId !== "string") return null;
    const email = rawToken.accountId;
    if (authorizeUser && await authorizeUser({ email })) return null;
    const rawClient = await clients.find(rawToken.clientId) as OAuthClientPayload | undefined;
    if (rawClient === undefined || typeof rawClient.client_name !== "string" || rawClient.client_name.length === 0) return null;
    const rawProfile = await profiles.find(normalizeOAuthEmail(email)) as OAuthProfilePayload | undefined;
    const scopes = typeof rawToken.scope === "string"
      ? rawToken.scope.split(" ").filter((scope): scope is OAuthScope => oauthScopes.includes(scope as OAuthScope))
      : [];
    return {
      email,
      displayName: typeof rawProfile?.name === "string" && rawProfile.name.length > 0
        ? rawProfile.name
        : email,
      ...(typeof rawProfile?.picture === "string" && rawProfile.picture.length > 0
        ? { avatarUrl: rawProfile.picture }
        : {}),
      clientId: rawToken.clientId,
      clientName: rawClient.client_name,
      scopes,
    };
  };
}

export async function persistOAuthProfile(
  sql: SqlClient,
  profile: { readonly email: string; readonly name?: string; readonly picture?: string },
): Promise<void> {
  const email = normalizeOAuthEmail(profile.email);
  if (!email) return;
  const payload = {
    email,
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.picture ? { picture: profile.picture } : {}),
  };
  await oauthAdapter(sql)("OAuthProfile").upsert(email, payload, undefined);
}

function normalizeOAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function oauthScopeForRoute(method: string, pathname: string): OAuthScope | null {
  const path = pathname.split("?", 1)[0] ?? pathname;
  if (path.startsWith("/api/conversations/v1/")) return "conversations";
  if (method.toUpperCase() !== "GET") return null;
  if (path === "/api/cards" || path.startsWith("/api/cards/")) return "cards:read";
  if (path === "/api/folders" || path.startsWith("/api/folders/")) return "folders:read";
  return null;
}

export function requireOAuthScope(
  access: OAuthResourceAccess | null,
  scope: OAuthScope,
): OAuthScopeCheck {
  return access?.scopes.includes(scope)
    ? { ok: true }
    : { ok: false, statusCode: 403, detail: "Insufficient OAuth scope" };
}
