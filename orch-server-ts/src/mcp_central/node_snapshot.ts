import { isRecord } from "@soulstream/wire-schema/json-record";
import type { McpCentralSnapshot } from "@soulstream/wire-schema";
import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { createMcpCentralRepository } from "./repository.js";
import { SECRET_REF_PATTERN, collectSecretReferences, safeDecode } from "./secret_refs.js";

export class MissingMcpSecretError extends Error {
  readonly code = "MCP_SECRET_NOT_FOUND";
  constructor(name: string) { super(`MCP secret not found: ${name}`); }
}

/** Query values are stored encoded, unlike headers and environment values. */
function mapValues(value: unknown, replace: (value: string) => string, key = ""): unknown {
  if (typeof value === "string") {
    if ((key === "url" || key === "server_url") && value.includes("?")) {
      const index = value.indexOf("?");
      const query = value.slice(index + 1).split("&").map(part => {
        const equals = part.indexOf("=");
        if (equals < 0) return part;
        const raw = part.slice(equals + 1);
        const decoded = safeDecode(raw);
        const resolved = replace(decoded);
        return resolved === decoded ? part : `${part.slice(0, equals + 1)}${encodeURIComponent(resolved)}`;
      }).join("&");
      return `${replace(value.slice(0, index))}?${query}`;
    }
    return replace(value);
  }
  if (Array.isArray(value)) return value.map(item => mapValues(item, replace));
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.env === "string") return value;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapValues(item, replace, name)]));
  return value;
}

export async function buildNodeSnapshot(sql: LivePostgresSql, nodeId: string): Promise<{
  revision: number; runtime: McpCentralSnapshot; display: McpCentralSnapshot;
}> {
  if (!sql.begin) throw new Error("PostgreSQL client does not support transactions");
  return sql.begin(async tx => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const repository = createMcpCentralRepository({ resolveSql: async () => tx });
    const revision = await repository.getState(tx);
    const bindings = (await repository.listBindings(tx)).filter(binding => binding.node_id === nodeId);
    const profileIds = new Set(bindings.map(binding => binding.mcp_profile_id));
    const servers = (await repository.listServers(tx)).filter(server => server.node_scope.includes(nodeId));
    const serverIds = new Set(servers.map(server => server.id));
    const display: McpCentralSnapshot = {
      registry: { servers: servers.map(server => {
        const definition = server.node_overrides[nodeId] ?? { type: server.type, config: server.config, ...(server.name === null ? {} : { name: server.name }) };
        return { id: server.id, type: definition.type, ...(definition.name === undefined ? {} : { name: definition.name }), ...definition.config };
      }) },
      profiles: { profiles: (await repository.listProfiles(tx)).filter(profile => profileIds.has(profile.id)).map(profile => ({
        id: profile.id, ...(profile.name ? { name: profile.name } : {}),
        ...(profile.description === null ? {} : { description: profile.description }),
        mcp_servers: profile.mcp_servers.filter(id => serverIds.has(id)), hosted_tools: profile.hosted_tools,
      })) },
      agent_bindings: Object.fromEntries(bindings.map(binding => [binding.agent_id, binding.mcp_profile_id])),
    };
    const names = new Set<string>();
    const collect = (value: string) => { collectSecretReferences(value, names); return value; };
    mapValues(display.registry.servers, collect);
    const profiles = display.profiles.profiles as Array<Record<string, unknown>>;
    for (const profile of profiles) mapValues(profile.hosted_tools, collect);
    const rows = names.size === 0 ? [] : await tx<{ name: string; value: string }[]>`
      SELECT name, value FROM mcp_secrets WHERE name = ANY(${[...names]})
    `;
    const secrets = new Map(rows.map(row => [row.name, row.value]));
    for (const name of names) if (!secrets.has(name)) throw new MissingMcpSecretError(name);
    const resolve = (value: string) => value.replace(SECRET_REF_PATTERN, (match, kind: string, name: string) =>
      kind === "secret" ? secrets.get(name)! : match);
    const runtime: McpCentralSnapshot = {
      registry: { servers: mapValues(display.registry.servers, resolve) as object[] },
      profiles: { profiles: profiles.map(profile => ({ ...profile, hosted_tools: mapValues(profile.hosted_tools, resolve) })) },
      agent_bindings: display.agent_bindings,
    };
    return { revision, runtime, display };
  });
}
