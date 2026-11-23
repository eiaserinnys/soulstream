import { AUTH_COOKIE_NAME } from "../auth/auth_routes.js";

/** Auth headers the orchestrator relays to node dashboard HTTP routes. */
export type NodeForwardRequestHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

export type NodeForwardAuthUser = {
  readonly payload: { readonly email?: string; readonly name?: string };
  readonly carrier: "cookie" | "bearer" | "tailscale";
};

/**
 * Mints a short dashboard cookie for callers the orchestrator identified
 * without a cookie or Authorization header (Tailscale Serve login). The node
 * verifies it with the same JWT_SECRET as a password or Google login cookie.
 */
export type NodeForwardAuthIssuer = {
  readonly resolveUser: (
    headers: NodeForwardRequestHeaders,
  ) => Promise<NodeForwardAuthUser | null>;
  readonly readJwtSecret: () => Promise<unknown>;
  readonly signJwt: (payload: Record<string, unknown>, secret: string) => string;
  readonly nowMs?: () => number;
};

export const NODE_FORWARD_JWT_TTL_SECONDS = 300;

export async function buildNodeForwardAuthHeaders(
  headers: NodeForwardRequestHeaders | undefined,
  issuer: NodeForwardAuthIssuer | undefined,
): Promise<Readonly<Record<string, string>> | undefined> {
  const forwarded: Record<string, string> = {};
  const cookie = headerValue(headers, "cookie");
  if (cookie) forwarded.cookie = cookie;
  const authorization = headerValue(headers, "authorization");
  if (authorization) forwarded.authorization = authorization;
  if (Object.keys(forwarded).length > 0) return forwarded;
  if (issuer === undefined) return undefined;
  const token = await issueForwardToken(headers ?? {}, issuer);
  return token === undefined
    ? undefined
    : { cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

async function issueForwardToken(
  headers: NodeForwardRequestHeaders,
  issuer: NodeForwardAuthIssuer,
): Promise<string | undefined> {
  try {
    const user = await issuer.resolveUser(headers);
    if (user === null || user.carrier !== "tailscale") return undefined;
    const email = user.payload.email;
    if (typeof email !== "string" || email.length === 0) return undefined;
    const secret = await issuer.readJwtSecret();
    if (typeof secret !== "string" || secret.length === 0) return undefined;
    const nowSeconds = Math.floor((issuer.nowMs?.() ?? Date.now()) / 1000);
    return issuer.signJwt({
      sub: email,
      email,
      name: user.payload.name ?? email,
      exp: nowSeconds + NODE_FORWARD_JWT_TTL_SECONDS,
    }, secret);
  } catch {
    // Same as before this issuer existed: the node answers without credentials.
    return undefined;
  }
}

export function headerValue(
  headers: NodeForwardRequestHeaders | undefined,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === normalized) {
      return Array.isArray(value) ? value.join("; ") : value;
    }
  }
  return undefined;
}
