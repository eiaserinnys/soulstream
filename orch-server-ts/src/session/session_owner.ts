import type { DashboardUserRepository } from "../runtime/live_dashboard_access_provider.js";

export type SessionOwner = { ownerEmail: string; callerInfo: Record<string, unknown> };
export type SessionOwnerResolver = (sessionId: string) => Promise<SessionOwner | null>;
export function createSessionOwnerResolver(options: {
  getSession(id: string): Promise<Record<string, unknown> | null>;
  findUserByEmail: DashboardUserRepository["findUserByEmail"];
  findExternalAgent(id: string): Promise<{ id: string; ownerEmail: string } | null>;
}): SessionOwnerResolver {
  return async sessionId => {
    const visited = new Set<string>();
    async function resolve(id: string): Promise<SessionOwner | null> {
      if (visited.has(id)) return null;
      visited.add(id);
      const session = await options.getSession(id);
      if (!session) return null;
      const metadata = session.metadata;
      const callers = Array.isArray(metadata)
        ? metadata.filter(record).filter(e => e.type === "caller_info").map(e => e.value)
        : record(metadata) ? [metadata.caller_info ?? metadata.callerInfo] : [];
      for (const caller of callers.reverse()) {
        if (!record(caller) || typeof caller.email !== "string") continue;
        const email = caller.email.trim().toLowerCase();
        if (!email) continue;
        const externalId = caller.external_agent_id ?? (caller.source === "external-llm" ? caller.agent_id : undefined);
        if (externalId !== undefined) {
          if (typeof externalId !== "string") continue;
          const agent = await options.findExternalAgent(externalId);
          if (!agent || agent.ownerEmail !== email) continue;
        } else if (!["browser", "soul-app", "slack", "agent"].includes(String(caller.source))) continue;
        const user = await options.findUserByEmail(email);
        if (user) return { ownerEmail: user.email, callerInfo: { ...caller, email: user.email } };
      }
      for (const relation of [session.caller_session_id, session.predecessor_session_id]) {
        if (typeof relation === "string" && relation) {
          const owner = await resolve(relation);
          if (owner) return owner;
        }
      }
      return null;
    }
    return resolve(sessionId);
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Sender labels/agent user_id belong to the current sender, not the owning human. */
export function withVerifiedSessionOwner(caller: Record<string, unknown> | undefined, owner: SessionOwner | null) {
  const { email: _unverifiedEmail, external_agent_id: _unverifiedExternalAgent, ...sender } = caller ?? {};
  if (!owner) return caller ? sender : undefined;
  return { ...(caller ? sender : owner.callerInfo), email: owner.ownerEmail,
    ...(typeof owner.callerInfo.external_agent_id === "string" ? { external_agent_id: owner.callerInfo.external_agent_id } : {}) };
}
