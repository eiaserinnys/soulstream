import type { FastifyRequest } from "fastify";

export function extractCookieToken(request: FastifyRequest, name: string): string | undefined {
  return parseCookies(request.headers.cookie)[name];
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const cookieHeader = Array.isArray(header) ? header.join("; ") : header;
  const result: Record<string, string> = {};
  for (const part of cookieHeader?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}


export function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    sameSite?: "Lax";
    maxAge?: number;
    path?: string;
    secure?: boolean;
  },
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function deleteCookie(name: string): string {
  return serializeCookie(name, "", { maxAge: 0 });
}
