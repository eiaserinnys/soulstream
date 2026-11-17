import { randomUUID } from "node:crypto";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import type { RunnerChildConfig } from "./runner_child_config.js";

export interface McpSecretRef {
  server: string;
  field: "headers" | "env";
  key: string;
  env: string;
  location?: "agent";
  agentIndex?: number;
  serverIndex?: number;
}

export const RUNNER_MCP_SECRETS_ENV = "SOUL_RUNNER_MCP_SECRETS";
type McpConfig = Pick<RunnerChildConfig, "agent" | "resolvedMcpServers">;
type Fields = { headers?: Record<string, string>; env?: Record<string, string> };
type Position = { location?: "agent"; agentIndex?: number; serverIndex: number };

function mapMcpServers<T extends McpConfig>(config: T, map: (server: ResolvedMcpServer, position: Position) => ResolvedMcpServer): T {
  const sdk = config.agent.agents_sdk;
  return {
    ...config,
    ...(config.resolvedMcpServers ? {
      resolvedMcpServers: config.resolvedMcpServers.map((server, serverIndex) => map(server, { serverIndex })),
    } : {}),
    agent: sdk ? { ...config.agent, agents_sdk: { ...sdk, agents: sdk.agents.map((agent, agentIndex) => ({
      ...agent,
      mcp_servers: agent.mcp_servers.map((server, serverIndex) => map(server, { location: "agent", agentIndex, serverIndex })),
    })) } } : config.agent,
  };
}

/** Remove every non-empty MCP field value, retaining values only in memory. */
export function externalizeMcpSecrets<T extends McpConfig>(config: T): {
  config: T; refs: McpSecretRef[]; secrets: Record<string, string>;
} {
  const refs: McpSecretRef[] = [];
  const secrets: Record<string, string> = {};
  const converted = mapMcpServers(config, (original, position) => {
    const server = { ...original };
    for (const field of ["headers", "env"] as const) {
      const originalRecord = (original as Fields)[field];
      if (!originalRecord) continue;
      const record = { ...originalRecord };
      for (const [key, value] of Object.entries(record)) {
        if (!value) continue;
        const slot = randomUUID();
        refs.push({ server: original.name ?? `#${position.serverIndex}`, field, key, env: slot, ...position });
        secrets[slot] = value;
        delete record[key];
      }
      Object.assign(server, { [field]: record });
    }
    return server;
  });
  return { config: converted, refs, secrets };
}

/** Consume before creating any adapter or CLI environment. */
export function consumeRunnerMcpSecrets<T extends McpConfig>(
  config: T,
  refs: readonly McpSecretRef[],
  processEnv: NodeJS.ProcessEnv,
): T {
  const serialized = processEnv[RUNNER_MCP_SECRETS_ENV];
  delete processEnv[RUNNER_MCP_SECRETS_ENV];
  let secrets: Record<string, string | undefined> = {};
  if (serialized) {
    try { secrets = JSON.parse(serialized) as Record<string, string | undefined>; }
    catch { throw new Error("Invalid runner MCP secrets environment"); }
  }
  for (const ref of refs) {
    if (!secrets?.[ref.env]) throw new Error(`Missing MCP secret: ${ref.server} ${ref.field} ${ref.key}`);
  }
  return mapMcpServers(config, (original, position) => {
    const matching = refs.filter((ref) => ref.serverIndex === undefined
      ? position.location === undefined && ref.server === original.name
      : ref.location === position.location && ref.agentIndex === position.agentIndex && ref.serverIndex === position.serverIndex);
    if (!matching.length) return original;
    const server = { ...original };
    for (const field of ["headers", "env"] as const) {
      const fieldRefs = matching.filter((ref) => ref.field === field);
      if (!fieldRefs.length) continue;
      const record = { ...(original as Fields)[field] };
      for (const ref of fieldRefs) record[ref.key] = secrets[ref.env]!;
      Object.assign(server, { [field]: record });
    }
    return server;
  });
}
