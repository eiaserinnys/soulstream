import type { ResolvedMcpServer } from "../mcp_config_service.js";

export interface McpSecretRef {
  server: string;
  field: "headers" | "env";
  key: string;
  env: string;
}

export const RUNNER_MCP_SECRETS_ENV = "SOUL_RUNNER_MCP_SECRETS";

type ServerFields = ResolvedMcpServer & { headers?: Record<string, string>; env?: Record<string, string> };

/** Replace only values that still equal the registry's host environment value. */
export function externalizeMcpSecrets(
  servers: readonly ResolvedMcpServer[],
  declarations: readonly McpSecretRef[],
  env: NodeJS.ProcessEnv,
): { servers: ResolvedMcpServer[]; refs: McpSecretRef[] } {
  const refs: McpSecretRef[] = [];
  const result = servers.map((original) => {
    const server: ServerFields = { ...original };
    for (const field of ["headers", "env"] as const) {
      const originalRecord = server[field];
      if (!originalRecord) continue;
      const record = { ...originalRecord };
      for (const ref of declarations) {
        if (ref.server !== server.name || ref.field !== field) continue;
        const value = env[ref.env];
        if (value && record[ref.key] === value) {
          delete record[ref.key];
          refs.push(ref);
        }
      }
      Object.assign(server, { [field]: record });
    }
    return server;
  });
  return { servers: result, refs };
}

export function restoreMcpSecrets(
  servers: readonly ResolvedMcpServer[],
  refs: readonly McpSecretRef[],
  env: Record<string, string | undefined>,
): ResolvedMcpServer[] {
  for (const ref of refs) {
    if (!env[ref.env]) throw new Error(`MCP secret env ${ref.env} is not set`);
  }
  return servers.map((original) => {
    const server: ServerFields = { ...original };
    for (const field of ["headers", "env"] as const) {
      const matching = refs.filter((ref) => ref.server === server.name && ref.field === field);
      if (matching.length === 0) continue;
      const record = { ...server[field] };
      for (const ref of matching) record[ref.key] = env[ref.env]!;
      Object.assign(server, { [field]: record });
    }
    return server;
  });
}

/** Consume before creating any adapter or CLI environment. */
export function consumeRunnerMcpSecrets(
  servers: readonly ResolvedMcpServer[],
  refs: readonly McpSecretRef[],
  processEnv: NodeJS.ProcessEnv,
): ResolvedMcpServer[] {
  const serialized = processEnv[RUNNER_MCP_SECRETS_ENV];
  delete processEnv[RUNNER_MCP_SECRETS_ENV];
  let secrets: Record<string, string | undefined> = {};
  if (serialized) {
    try {
      secrets = JSON.parse(serialized) as Record<string, string | undefined>;
    } catch {
      throw new Error("Invalid runner MCP secrets environment");
    }
  }
  return restoreMcpSecrets(servers, refs, secrets);
}

export function runnerMcpSecretValues(
  refs: readonly McpSecretRef[],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(refs.map((ref) => {
    const value = env[ref.env];
    if (!value) throw new Error(`MCP secret env ${ref.env} is not set`);
    return [ref.env, value];
  }));
}
