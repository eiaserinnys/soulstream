import type { ClaudeClient } from "./claude_adapter.js";

/**
 * Worker-owned Claude client registry.
 *
 * Engine adapters are turn/execution scoped, while one persistent SDK Query is
 * session scoped. This registry is instantiated only when runtime-v2 is enabled.
 */
export class ClaudeSessionClientRegistry {
  private readonly clients = new Map<string, ClaudeClient>();

  constructor(private readonly createClient: (sessionId: string) => ClaudeClient) {}

  acquire(sessionId: string): ClaudeClient {
    const existing = this.clients.get(sessionId);
    if (existing) return existing;
    const client = this.createClient(sessionId);
    this.clients.set(sessionId, client);
    return client;
  }

  async close(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;
    this.clients.delete(sessionId);
    await client.close?.();
  }

  async shutdown(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(async (client) => await client.close?.()));
  }

  size(): number {
    return this.clients.size;
  }
}
