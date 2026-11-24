import type { AgentProfile } from "@soulstream/agent-profile-contract";
import { selectCodexMcpServers } from "../engine/codex_app_server/params.js";
import { antigravityMcpGatewayUpstreams } from "../engine/antigravity/agent_definition.js";
import { openCodeMcpServers } from "../engine/opencode/config.js";
import type { ResolvedMcpServer } from "../mcp_config_service.js";
import { restrictedIsolationBackend } from "../runner/runner_process_isolation.js";
import type { IsolationPolicy } from "../security/session_isolation_contract.js";
import { sanitizeRestrictedMcpServers } from "../security/restricted_mcp_config.js";

type DisplayServer = { id: string; name?: string; type: string; url?: string; command?: string; args?: string[]; full_command?: string };
type Row = { server_id: string; name: string; type: string; included: boolean; excluded_reason?: string };
export function previewAgentMcp(input: {
  agent: AgentProfile; mode: "local" | "central"; revision: number; profileId?: string;
  servers: DisplayServer[]; backend?: AgentProfile["backend"]; defaultPreset?: string;
  allowlist?: Record<string, string[]>; codexMode: string; isolationEnabled: boolean;
  nodeId: string; localMcpPolicy: IsolationPolicy["localMcp"];
}) {
  const backend = input.backend ?? input.agent.backend;
  const servers = input.servers.map(server => ({ ...server, name: server.name ?? server.id })) as ResolvedMcpServer[];
  const rows = (included: Set<string>, reason: string): Row[] => input.servers.map(server => {
    const name = server.name ?? server.id;
    return { server_id: server.id, name, type: server.type, included: included.has(name),
      ...(included.has(name) ? {} : { excluded_reason: reason }) };
  });
  let supported = servers;
  if (backend === "codex") supported = selectCodexMcpServers(servers).supportedServers ?? [];
  if (backend === "antigravity") {
    const names = new Set(antigravityMcpGatewayUpstreams({ resolvedMcpServers: servers, logger: { warn() {} } }).map(item => item.name));
    supported = servers.filter(server => server.name && names.has(server.name));
  }
  if (backend === "opencode") {
    const selected = openCodeMcpServers({ workspaceDir: input.agent.workspace_dir, sessionDirectory: "", model: "", agentSessionId: "",
      processEnv: {}, resolvedMcpServers: servers, opencodeMcpToolAllowlist: input.allowlist, internalMcpUrl: "http://127.0.0.1/" });
    supported = servers.filter(server => server.name && selected?.[server.name]);
  }
  const normalRows = rows(new Set(supported.map(server => server.name!)), "백엔드에서 지원하지 않음");
  const normalBlocked = backend === "codex" && input.profileId !== undefined && input.codexMode !== "app-server";
  let restrictedBlocked = false;
  try { restrictedIsolationBackend(backend); } catch { restrictedBlocked = true; }
  if (backend === "codex" && input.codexMode !== "app-server") restrictedBlocked = true;
  const sanitized = sanitizeRestrictedMcpServers({ resolvedServers: supported, authenticatedSessionId: "preview", restrictedToken: "preview",
    localMcpPolicy: input.localMcpPolicy, actualInternalMcpUrl: "http://127.0.0.1/", nodeId: input.nodeId }).sanitizedServers;
  const restrictedRows = rows(new Set(sanitized.map(server => server.name!)), "격리 정책에서 제외됨");
  const internalName = input.localMcpPolicy.requiredServerId;
  if (!restrictedRows.some(row => row.name === internalName)) restrictedRows.unshift({ server_id: internalName, name: internalName, type: "streamable_http", included: true });
  return { applied_mode: input.mode, applied_revision: input.revision, effective_backend: backend, default_preset: input.defaultPreset ?? input.agent.default_preset ?? null,
    isolation_enabled: input.isolationEnabled,
    normal: { runnable: !normalBlocked, ...(normalBlocked ? { blocked_reason: "이 노드의 Codex 모드에서 MCP 프로필을 사용할 수 없습니다" } : {}), servers: normalRows },
    restricted: { runnable: !restrictedBlocked, ...(restrictedBlocked ? { blocked_reason: "이 백엔드는 격리 세션을 지원하지 않습니다" } : {}), servers: restrictedRows } };
}
