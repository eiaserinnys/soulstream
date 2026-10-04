import { createHash, randomBytes } from "node:crypto";
import { constantTimeStringEqual } from "@soulstream/mcp-contract";
import type { DashboardUserRepository } from "../runtime/live_dashboard_access_provider.js";
import { OwnedAgentError, type OwnedAgentRepository, type CredentialRecord } from "./types.js";

export const agentTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export class OwnedAgentService {
  constructor(private readonly repository: OwnedAgentRepository,
    private readonly findUser: DashboardUserRepository["findUserByEmail"], private readonly existingToken?: string) {}
  async user(email: string) {
    const user = await this.findUser(email);
    if (!user) throw new OwnedAgentError(403, "User access required");
    return user;
  }
  findAgent = (id: string) => this.repository.find(id);
  async list(email: string) {
    const user = await this.user(email);
    const existing = this.existingToken ? await this.repository.credential(agentTokenHash(this.existingToken)) : null;
    const agents = await Promise.all((await this.repository.list(user.email)).map(async agent => ({ ...agent,
      keys: (await this.repository.keys(agent.id)).map(key => this.publicKey(key, existing?.id)) })));
    return { agents, existingConnection: { configured: !!this.existingToken, registered: !!existing,
      canRegister: user.isAdmin && !!this.existingToken && !existing } };
  }
  async create(email: string, name: string) { return this.repository.create((await this.user(email)).email, name); }
  async requireOwned(email: string, id: string) {
    const user = await this.user(email); const agent = await this.repository.find(id);
    if (!agent || agent.ownerEmail !== user.email) throw new OwnedAgentError(404, "Agent not found");
    return agent;
  }
  async update(email: string, id: string, input: { name?: string; enabled?: boolean }) {
    await this.requireOwned(email, id);
    const agent = await this.repository.update(id, email, input);
    if (!agent) throw new OwnedAgentError(404, "Agent not found");
    return agent;
  }
  async issue(email: string, id: string) {
    await this.requireOwned(email, id);
    const token = "ss_agent_" + randomBytes(32).toString("base64url");
    return { credential: this.publicKey(await this.repository.issue(id, email, agentTokenHash(token))), token };
  }
  async revoke(email: string, id: string, keyId: string) {
    await this.requireOwned(email, id);
    if (!await this.repository.revoke(id, keyId)) throw new OwnedAgentError(404, "Credential not found");
  }
  async registerExisting(email: string, name = "Existing MCP connection") {
    if (!(await this.user(email)).isAdmin) throw new OwnedAgentError(403, "Admin access required");
    if (!this.existingToken) throw new OwnedAgentError(409, "Existing connection is not configured");
    const record = await this.repository.registerExisting(email, name, agentTokenHash(this.existingToken));
    return { agent: record.agent, credential: this.publicKey(record, record.id) };
  }
  /** Database authority is checked before legacy env compatibility, including tombstones. */
  async authenticate(token: string): Promise<{ agentId: string; ownerEmail: string; credentialId: string } | null> {
    let record: CredentialRecord | null;
    try { record = await this.repository.credential(agentTokenHash(token)); }
    catch { throw new OwnedAgentError(503, "Credential verification temporarily unavailable"); }
    if (record) {
      let user;
      try { user = await this.findUser(record.agent.ownerEmail); }
      catch { throw new OwnedAgentError(503, "Credential verification temporarily unavailable"); }
      if (record.revokedAt || !record.agent.enabled || !user)
        throw new OwnedAgentError(401, "Unauthorized");
      try { await this.repository.touch(record.id); }
      catch { throw new OwnedAgentError(503, "Credential verification temporarily unavailable"); }
      return { agentId: record.agentId, ownerEmail: record.agent.ownerEmail, credentialId: record.id };
    }
    if (this.existingToken && constantTimeStringEqual(token, this.existingToken)) return null;
    throw new OwnedAgentError(401, "Unauthorized");
  }
  private publicKey(key: { id: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }, existingId?: string) {
    return { id: key.id, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, revokedAt: key.revokedAt,
      isExistingConnection: key.id === existingId };
  }
}
