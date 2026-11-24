import type { InMemoryNodeRegistry } from "../node/registry.js";
import { supportsCentralMcpConfig } from "../node/registry_helpers.js";

export async function checkMcpSendGate<T>(options: {
  nodeId: string;
  registry: InMemoryNodeRegistry;
  readGate: (nodeId: string) => Promise<{ managed: T | null; hasBindings: boolean }>;
  inScope?: () => Promise<boolean>;
}) {
  const gate = await options.readGate(options.nodeId);
  if (!gate.managed) return { ok: false as const, reason: "unmanaged" as const };
  const node = options.registry.getConnectedNode(options.nodeId);
  if (!node) return { ok: false as const, reason: "disconnected" as const };
  if (!supportsCentralMcpConfig(node.capabilities)) return { ok: false as const, reason: "unsupported" as const };
  if (options.inScope && !await options.inScope()) return { ok: false as const, reason: "out_of_scope" as const };
  return { ok: true as const, node, managed: gate.managed, hasBindings: gate.hasBindings };
}
