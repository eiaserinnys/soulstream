import type { createI18n } from "@soulstream/i18n";
import type { McpPreviewResult as WireMcpPreviewResult, McpPreviewVariant as WireMcpPreviewVariant } from "../../../packages/wire-schema/generated/typescript/index";

export type McpIcon =
  | { kind: "brand"; slug: string; hex: string }
  | { kind: "symbol"; name: string; color: string }
  | { kind: "upload"; ref: string; content_hash: string; url?: string };
export type McpType = "stdio" | "streamable_http" | "sse";
export type Definition = {
  name?: string;
  type: McpType;
  config: Record<string, unknown>;
};
export type McpServer = Omit<Definition, "name"> & {
  id: string;
  name: string | null;
  node_scope: string[];
  node_overrides: Record<string, Definition>;
  icon: McpIcon | null;
  version: number;
};
export type McpProfile = {
  id: string;
  name: string | null;
  description: string | null;
  mcp_servers: string[];
  hosted_tools: unknown[];
  node_scope: string[];
  version: number;
};
export type McpSecret = {
  name: string;
  updated_at: string | null;
  servers: string[];
  profiles: string[];
};
export type McpConfig = {
  current_revision: number;
  servers: McpServer[];
  profiles: McpProfile[];
  secrets: McpSecret[];
  bindings: {
    agent_id: string;
    node_id: string;
    mcp_profile_id: string;
    version: number;
  }[];
  managed_nodes: {
    node_id: string;
    connected: boolean;
    central_sync_supported: boolean;
    applied_revision: number;
    ack: { revision: number } | null;
  }[];
};
export type McpRevision = {
  id: number;
  target: string;
  target_id: string;
  created_at: string;
};
export type McpBindingInput = {
  node_ids: string[];
  mcp_profile_id: string | null;
  expected_version?: number;
  expected_revision?: number;
  fork?: boolean;
};
export type McpTestInput = { node_id: string } & (
  | { server_id: string }
  | { draft_server: Definition & { id: string; node_scope: string[]; node_overrides?: Record<string, Definition> }; inline_secrets?: Record<string, string> }
);
export type McpTestResult =
  | { ok: true; latency_ms: number; server_info?: { name: string; version: string }; tool_count: number; tools: string[] }
  | { ok: false; latency_ms: number; error_stage: "config" | "connect" | "initialize" | "list_tools" | "timeout"; error_message: string };
export type McpPreviewRow = WireMcpPreviewVariant["servers"][number] & {
  icon?: McpIcon | null;
  node_override?: boolean;
};
export type McpPreviewResult = Omit<WireMcpPreviewResult, "normal" | "restricted"> & {
  current_revision: number;
  normal: Omit<WireMcpPreviewVariant, "servers"> & { servers: McpPreviewRow[] };
  restricted: Omit<WireMcpPreviewVariant, "servers"> & { servers: McpPreviewRow[] };
};
export class McpApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function isMcpVersionConflict(error: McpApiError): boolean {
  return error.code.endsWith("_VERSION_CONFLICT") || error.code === "MCP_REVISION_CONFLICT";
}

export function mcpRequestErrorText(error: unknown, t: ReturnType<typeof createI18n>["t"]): string {
  if (!(error instanceof McpApiError)) return t("mcp.requestFailed");
  const codes: Record<string, string> = {
    MCP_NODE_NOT_MANAGED: t("mcp.nodeNotManaged"),
    MCP_SERVER_OUT_OF_SCOPE: t("mcp.serverOutOfScope"),
    MCP_PORTABLE_NODE: t("mcp.portableNode"),
  };
  if (codes[error.code]) return codes[error.code];
  if (error.status === 403) return t("mcp.adminOnly");
  if (error.status === 404) return t("mcp.requestTargetNotFound");
  if (error.status === 503) {
    if (/[가-힣]/.test(error.message)) return error.message; // i18n-ignore: 서버가 이미 한국어로 보낸 오류인지 판별한다.
    return t("mcp.nodeUnavailable");
  }
  return t("mcp.requestFailed");
}
export function createMcpApi(request: typeof fetch = fetch) {
  async function call<T>(
    path: string,
    method = "GET",
    body?: object,
  ): Promise<T> {
    const response = await request(path, {
      method,
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) {
      const error = ((await response.json().catch(() => ({}))) ?? {}) as {
        code?: string;
        message?: string;
        detail?: string;
      };
      throw new McpApiError(
        response.status,
        error.code ?? "",
        error.message ?? error.detail ?? "",
      );
    }
    return response.json() as Promise<T>;
  }
  const path = (kind: string, id: string) =>
    `/api/mcp/${kind}/${encodeURIComponent(id)}`;
  const del = (kind: string, id: string, version?: number) =>
    call<{ current_revision: number }>(
      `${path(kind, id)}${version === undefined ? "" : `?expected_version=${version}`}`,
      "DELETE",
    );
  return {
    config: () => call<McpConfig>("/api/mcp/config"),
    setAgentMcpBinding: (id: string, body: McpBindingInput) =>
      call<{ current_revision: number; bindings: McpConfig["bindings"] }>(path("agents", id), "PUT", body),
    testMcpServer: (body: McpTestInput) => call<McpTestResult>("/api/mcp/servers/test", "POST", body),
    previewAgentMcp: (id: string, nodeId: string, profileId?: string) =>
      call<McpPreviewResult>(`${path("agents", id)}/preview?node_id=${encodeURIComponent(nodeId)}${profileId === undefined ? "" : `&mcp_profile_id=${encodeURIComponent(profileId)}`}`),
    putServer: (
      id: string,
      body: Definition & {
        node_scope: string[];
        node_overrides?: Record<string, Definition>;
        icon?: McpIcon | null;
        inline_secrets?: Record<string, string>;
        expected_version?: number;
        expected_revision?: number;
      },
    ) =>
      call<{ current_revision: number; server: McpServer }>(
        path("servers", id),
        "PUT",
        body,
      ),
    deleteServer: (id: string, version: number) => del("servers", id, version),
    putProfile: (
      id: string,
      body: {
        name: string;
        description: string;
        mcp_servers: string[];
        hosted_tools: unknown[];
        expected_version?: number;
        expected_revision?: number;
      },
    ) =>
      call<{ current_revision: number; profile: McpProfile }>(
        path("profiles", id),
        "PUT",
        body,
      ),
    deleteProfile: (id: string, version: number) =>
      del("profiles", id, version),
    putSecret: (name: string, value: string, revision: number) =>
      call(path("secrets", name), "PUT", {
        value,
        expected_revision: revision,
      }),
    deleteSecret: (name: string, revision: number) =>
      call(`${path("secrets", name)}?expected_revision=${revision}`, "DELETE"),
    uploadIcon: (data_base64: string) =>
      call<{ ref: string; content_hash: string; url: string }>(
        "/api/mcp/server-icons",
        "POST",
        { data_base64 },
      ),
    revisions: (target: "server" | "profile", id: string) =>
      call<{ revisions: McpRevision[] }>(
        `/api/mcp/revisions?target=${target}&target_id=${encodeURIComponent(id)}`,
      ),
    rollback: (id: number, revision: number) =>
      call(`/api/mcp/revisions/${id}/rollback`, "POST", {
        expected_revision: revision,
      }),
  };
}
