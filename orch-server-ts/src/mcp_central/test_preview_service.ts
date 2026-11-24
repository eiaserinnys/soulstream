import { isRecord } from "@soulstream/wire-schema/json-record";
import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { invalidInput, notFound } from "./errors.js";
import { mapValues } from "./node_snapshot.js";
import { collectSecretReferences, SECRET_REF_PATTERN } from "./secret_refs.js";
import { parseServerInput } from "./server_validation.js";
import type { McpCentralService } from "./service.js";
import type { McpCentralSyncService } from "./sync_service.js";
import type { McpConfigView, McpServerDefinition } from "./types.js";

export function createMcpTestPreviewService(options: { service: McpCentralService; sync: McpCentralSyncService; resolveSql: () => Promise<LivePostgresSql> }) {
  async function resolveSecrets(definition: McpServerDefinition, inline: Record<string, string>) {
    const names = new Set<string>();
    mapValues(definition.config, value => { collectSecretReferences(value, names); return value; });
    const missing = [...names].filter(name => !(name in inline));
    const sql = await options.resolveSql();
    const rows = missing.length ? await sql<{ name: string; value: string }[]>`SELECT name, value FROM mcp_secrets WHERE name = ANY(${missing})` : [];
    const secrets = new Map([...rows.map(row => [row.name, row.value] as const), ...Object.entries(inline)]);
    for (const name of names) if (!secrets.has(name)) throw notFound("MCP_SECRET_NOT_FOUND", "MCP secret not found");
    const config = mapValues(definition.config, value => value.replace(SECRET_REF_PATTERN, (match, kind: string, name: string) => kind === "secret" ? secrets.get(name)! : match));
    return { config, secrets: [...secrets.values()] };
  }

  async function test(body: unknown) {
    if (!isRecord(body) || typeof body.node_id !== "string" || !body.node_id || (body.server_id !== undefined && (typeof body.server_id !== "string" || !body.server_id)) || (typeof body.server_id === "string") === isRecord(body.draft_server)) throw invalidInput("node_id and one server definition are required");
    const nodeId = body.node_id;
    const serverId = typeof body.server_id === "string" ? body.server_id : undefined;
    let config: McpConfigView | undefined;
    let definition: McpServerDefinition | undefined;
    let id = serverId ?? "draft";
    let sensitive: string[] = [];
    if (body.inline_secrets !== undefined && !isRecord(body.inline_secrets)) throw invalidInput("inline_secrets must be an object");
    let inline = isRecord(body.inline_secrets) ? body.inline_secrets : {};
    if (Object.values(inline).some(value => typeof value !== "string")) throw invalidInput("inline_secrets must contain strings");
    const response = await options.sync.sendAux(nodeId, async () => {
      if (!definition) {
        if (!isRecord(body.draft_server)) throw invalidInput("draft_server is required");
        const draft = parseServerInput({ ...body.draft_server, ...(body.inline_secrets ? { inline_secrets: body.inline_secrets } : {}) });
        inline = { ...(draft.inline_secrets ?? {}), ...inline };
        id = typeof body.draft_server.id === "string" ? body.draft_server.id : "draft";
        definition = draft.node_overrides?.[nodeId] ?? draft;
      }
      const resolved = await resolveSecrets(definition, inline as Record<string, string>);
      const values = [...resolved.secrets];
      if (isRecord(resolved.config)) {
        for (const field of ["headers", "env"]) if (isRecord(resolved.config[field])) for (const value of Object.values(resolved.config[field])) if (typeof value === "string" && value) values.push(value);
        if (typeof resolved.config.url === "string") { try { for (const value of new URL(resolved.config.url).searchParams.values()) if (value) values.push(value); } catch { /* node reports invalid URL */ } }
        if (typeof resolved.config.full_command === "string") values.push(resolved.config.full_command);
      }
      sensitive = values.filter(Boolean).sort((a, b) => b.length - a.length);
      const command = { type: "test_mcp_server" as const, server: { id, name: definition.name ?? id, type: definition.type, config: resolved.config } };
      return command;
    }, serverId ? async () => {
      config = await options.service.getConfig();
      const server = config.servers.find(item => item.id === serverId);
      if (!server) throw notFound("MCP_SERVER_NOT_FOUND", "Server not found");
      definition = server.node_overrides[nodeId] ?? { type: server.type, config: server.config, ...(server.name ? { name: server.name } : {}) };
      return server.node_scope.includes(nodeId);
    } : undefined);
    const scrub = (value: unknown): unknown => {
      if (typeof value === "string") return sensitive.reduce((text, secret) => text.split(secret).join("[비공개]"), value);
      if (Array.isArray(value)) return value.map(scrub);
      if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
      return value;
    };
    return scrub(response);
  }

  async function preview(agentId: string, nodeId: string, profileId?: string) {
    let config: McpConfigView;
    let chosen: McpConfigView["profiles"][number] | undefined;
    const response = await options.sync.sendAux(nodeId, async () => {
      config = await options.service.getConfig();
      const id = profileId ?? config.bindings.find(item => item.agent_id === agentId && item.node_id === nodeId)?.mcp_profile_id;
      chosen = config.profiles.find(item => item.id === id);
      if (profileId && !chosen) throw notFound("MCP_PROFILE_NOT_FOUND", "Profile not found");
      const servers = chosen?.mcp_servers.flatMap(id => {
        const server = config.servers.find(item => item.id === id);
        if (!server || !server.node_scope.includes(nodeId)) return [];
        const def = server.node_overrides[nodeId] ?? server;
        return [{ server_id: id, name: def.name ?? id, type: def.type }];
      }) ?? [];
      return { type: "preview_agent_mcp" as const, agent_id: agentId, ...(profileId ? { mcp_profile_id: profileId, servers } : {}) };
    });
    const result: Record<string, unknown> = { ...response, current_revision: config!.current_revision };
    if (response.applied_mode !== "central" || response.applied_revision !== config!.current_revision) return result;
    for (const key of ["normal", "restricted"] as const) {
      const variant = response[key];
      if (!isRecord(variant) || variant.runnable !== true || !Array.isArray(variant.servers)) continue;
      const rows = variant.servers.map(row => {
        if (!isRecord(row)) return row;
        const server = config!.servers.find(item => item.id === row.server_id);
        return server ? { ...row, icon: server.icon, ...(server.node_overrides[nodeId] ? { node_override: true } : {}) } : row;
      });
      for (const id of chosen?.mcp_servers ?? []) {
        const server = config!.servers.find(item => item.id === id);
        if (!server || server.node_scope.includes(nodeId) || rows.some(row => isRecord(row) && row.server_id === id)) continue;
        rows.push({ server_id: id, name: server.name ?? id, type: server.type, included: false, excluded_reason: "이 노드 미적용", icon: server.icon });
      }
      result[key] = { ...variant, servers: rows };
    }
    return result;
  }
  return { test, preview };
}
