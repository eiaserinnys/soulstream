import type { FastifyReply, FastifyRequest } from "fastify";

export type AdminAccessProvider = {
  currentEmail: (
    request: FastifyRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;
  isAdminEmail: (email: string) => Promise<boolean> | boolean;
};

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: AdminAccessProvider,
): Promise<string | undefined> {
  const email = normalizedEmail(await provider.currentEmail(request));
  if (!email) {
    reply.code(401).send({ detail: "Authentication required" });
    return undefined;
  }
  if (!(await provider.isAdminEmail(email))) {
    reply.code(403).send({ detail: "Admin access required" });
    return undefined;
  }
  return email;
}

function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email || undefined;
}
