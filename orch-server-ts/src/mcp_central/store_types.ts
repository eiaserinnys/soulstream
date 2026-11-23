import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import {
  toRevision,
  type McpBindingRecord,
  type McpIcon,
  type McpManagedNodeRecord,
  type McpProfileRecord,
  type McpRevisionRecord,
  type McpRevisionTarget,
  type McpServerDefinition,
  type McpServerRecord,
  type McpServerType,
} from "./types.js";

export type Sql = LivePostgresSql;

export type ServerRow = {
  id: string;
  name: string | null;
  type: string;
  config: unknown;
  node_scope: unknown;
  node_overrides: unknown;
  icon: unknown;
  version: number;
};

export type ProfileRow = {
  id: string;
  name: string | null;
  description: string | null;
  mcp_servers: unknown;
  hosted_tools: unknown;
  node_scope: unknown;
  version: number;
};

export type BindingRow = {
  agent_id: string;
  node_id: string;
  mcp_profile_id: string;
  version: number;
};

export type ManagedNodeRow = {
  node_id: string;
  central_active: boolean;
  activated_at: unknown;
  applied_mode: string | null;
  applied_revision: unknown;
  last_sync_at: unknown;
  last_sync_error: string | null;
  last_compare_id: string | null;
  last_verified_revision: unknown;
  last_verified_at: unknown;
};

export type SecretRow = { name: string; updated_at: unknown };

export type RevisionRow = {
  id: unknown;
  target: string;
  target_id: string;
  snapshot: unknown;
  created_at: unknown;
};

export type IconRow = {
  id: string;
  server_id: string | null;
  mime: string;
  content_hash: string;
};

export type IconBodyRow = { mime: string; body: Buffer; content_hash: string };

export type ServerWrite = {
  readonly id: string;
  readonly name: string | null;
  readonly type: McpServerType;
  readonly config: Record<string, unknown>;
  readonly node_scope: readonly string[];
  readonly node_overrides: Record<string, McpServerDefinition>;
  readonly icon: McpIcon | null;
};

export type ProfileWrite = {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly mcp_servers: readonly string[];
  readonly hosted_tools: readonly unknown[];
  /** 되돌리기처럼 node_scope까지 복원할 때만 준다. 없으면 기존 값을 둔다. */
  readonly node_scope?: readonly string[];
};

export type IconDraftWrite = {
  readonly id: string;
  readonly mime: string;
  readonly body: Buffer;
  readonly width: number;
  readonly height: number;
  readonly content_hash: string;
};

export function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function mapServer(row: ServerRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type as McpServerType,
    config: asRecord(row.config),
    node_scope: asStringArray(row.node_scope),
    node_overrides: asRecord(row.node_overrides) as Record<string, McpServerDefinition>,
    icon: (row.icon ?? null) as McpIcon | null,
    version: row.version,
  };
}

export function mapProfile(row: ProfileRow): McpProfileRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mcp_servers: asStringArray(row.mcp_servers),
    hosted_tools: Array.isArray(row.hosted_tools) ? row.hosted_tools : [],
    node_scope: asStringArray(row.node_scope),
    version: row.version,
  };
}

export function mapBinding(row: BindingRow): McpBindingRecord {
  return {
    agent_id: row.agent_id,
    node_id: row.node_id,
    mcp_profile_id: row.mcp_profile_id,
    version: row.version,
  };
}

export function mapManagedNode(row: ManagedNodeRow): McpManagedNodeRecord {
  return {
    node_id: row.node_id,
    central_active: row.central_active,
    activated_at: iso(row.activated_at),
    applied_mode: row.applied_mode,
    applied_revision: toRevision(row.applied_revision),
    last_sync_at: iso(row.last_sync_at),
    last_sync_error: row.last_sync_error,
    last_compare_id: row.last_compare_id,
    last_verified_revision:
      row.last_verified_revision === null || row.last_verified_revision === undefined
        ? null
        : toRevision(row.last_verified_revision),
    last_verified_at: iso(row.last_verified_at),
  };
}

export function mapRevision(row: RevisionRow): McpRevisionRecord {
  return {
    id: toRevision(row.id),
    target: row.target as McpRevisionTarget,
    target_id: row.target_id,
    snapshot: asRecord(row.snapshot),
    created_at: iso(row.created_at) ?? "",
  };
}
