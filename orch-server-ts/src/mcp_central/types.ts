export type McpServerType = "stdio" | "streamable_http" | "sse";

export type McpBrandIcon = {
  readonly kind: "brand";
  readonly slug: string;
  readonly hex: string;
};

export type McpSymbolIcon = {
  readonly kind: "symbol";
  readonly name: string;
  readonly color: string;
};

/** 업로드 아이콘 참조. 응답에서는 `url`이 함께 실린다. */
export type McpUploadIcon = {
  readonly kind: "upload";
  readonly ref: string;
  readonly content_hash: string;
  readonly url?: string;
};

export type McpIcon = McpBrandIcon | McpSymbolIcon | McpUploadIcon;

/** 한 노드에 적용되는 서버 정의 전체. node_overrides의 값도 같은 꼴이다. */
export type McpServerDefinition = {
  readonly name?: string;
  readonly type: McpServerType;
  readonly config: Readonly<Record<string, unknown>>;
};

export type McpServerInput = McpServerDefinition & {
  readonly node_scope: readonly string[];
  readonly node_overrides?: Readonly<Record<string, McpServerDefinition>>;
  readonly icon?: McpIcon | null;
  readonly inline_secrets?: Readonly<Record<string, string>>;
};

export type McpServerRecord = {
  readonly id: string;
  readonly name: string | null;
  readonly type: McpServerType;
  readonly config: Record<string, unknown>;
  readonly node_scope: string[];
  readonly node_overrides: Record<string, McpServerDefinition>;
  readonly icon: McpIcon | null;
  readonly version: number;
};

export type McpServerView = McpServerRecord;

export type McpProfileInput = {
  readonly name?: string;
  readonly description?: string;
  readonly mcp_servers?: readonly string[];
  readonly hosted_tools?: readonly unknown[];
};

export type McpProfileRecord = {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly mcp_servers: string[];
  readonly hosted_tools: unknown[];
  readonly node_scope: string[];
  readonly version: number;
};

export type McpProfileView = McpProfileRecord;

export type McpBindingRecord = {
  readonly agent_id: string;
  readonly node_id: string;
  readonly mcp_profile_id: string;
  readonly version: number;
};

export type McpManagedNodeRecord = {
  readonly node_id: string;
  readonly central_active: boolean;
  readonly activated_at: string | null;
  readonly applied_mode: string | null;
  readonly applied_revision: number;
  readonly last_sync_at: string | null;
  readonly last_sync_error: string | null;
  readonly last_compare_id: string | null;
  readonly last_verified_revision: number | null;
  readonly last_verified_at: string | null;
};

export type McpManagedNodeAck = {
  readonly applied_mode?: string | null;
  readonly applied_revision?: number;
  readonly last_sync_at?: string | null;
  readonly last_sync_error?: string | null;
};

export type McpSecretMeta = {
  readonly name: string;
  readonly updated_at: string | null;
  readonly servers: string[];
  readonly profiles: string[];
};

export type McpConfigView = {
  readonly current_revision: number;
  readonly servers: McpServerView[];
  readonly profiles: McpProfileView[];
  readonly secrets: McpSecretMeta[];
  readonly bindings: McpBindingRecord[];
  readonly managed_nodes: McpManagedNodeRecord[];
};

export type McpRevisionTarget = "server" | "profile" | "binding";

export type McpRevisionRecord = {
  readonly id: number;
  readonly target: McpRevisionTarget;
  readonly target_id: string;
  readonly snapshot: Record<string, unknown>;
  readonly created_at: string;
};

export type McpWriteOptions = {
  readonly expectedRevision?: number;
  readonly expectedVersion?: number;
};

export type McpBindingInput = {
  readonly node_ids: readonly string[];
  readonly mcp_profile_id: string | null;
  readonly fork?: boolean;
};

export type McpUploadedIconRecord = {
  readonly ref: string;
  readonly content_hash: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
};

export type McpStoredIcon = {
  readonly mime: string;
  readonly body: Buffer;
  readonly content_hash: string;
};

export function toRevision(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
