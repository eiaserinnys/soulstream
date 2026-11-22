import type { IncomingHttpHeaders } from "node:http";

/** Serve strips incoming identity headers; only loopback traffic may reach this service. */
export function resolveTailscaleIdentity(headers: IncomingHttpHeaders, allowedLogin: string): string | null {
  if (headers["tailscale-funnel-request"] !== undefined) return null;
  const login = headers["tailscale-user-login"];
  if (typeof login !== "string") return null;
  const normalized = login.trim().toLowerCase();
  return normalized && normalized === allowedLogin ? normalized : null;
}
