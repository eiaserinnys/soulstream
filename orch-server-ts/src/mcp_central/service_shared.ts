import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { invalidInput, McpCentralError } from "./errors.js";
import { invalidIconUploadError } from "./icon_validation.js";
import type { McpCentralRepository } from "./repository.js";
import { collectSecretReferences } from "./secret_refs.js";
import { parseServerDefinition } from "./server_validation.js";
import type {
  McpIcon,
  McpProfileRecord,
  McpSecretMeta,
  McpServerDefinition,
  McpServerRecord,
  McpServerView,
} from "./types.js";

export function iconView(icon: McpIcon | null): McpIcon | null {
  if (icon?.kind !== "upload") return icon;
  return {
    ...icon,
    url: `/api/mcp/server-icons/${icon.ref}?v=${icon.content_hash}`,
  };
}

export function serverView(server: McpServerRecord): McpServerView {
  return { ...server, icon: iconView(server.icon) };
}

export function assertServerId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) {
    throw invalidInput("server id must be a non-empty string");
  }
  return id;
}

export function assertProfileId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) {
    throw invalidInput("profile id must be a non-empty string");
  }
  return id;
}

export function effectiveName(server: McpServerRecord, nodeId: string): string {
  const override = server.node_overrides[nodeId];
  const definition = override ?? { name: server.name ?? undefined, type: server.type };
  return definition.name ?? server.id;
}

export function assertTransportNames(server: McpServerRecord): void {
  for (const nodeId of server.node_scope) {
    const name = effectiveName(server, nodeId);
    if (name.includes("__")) {
      throw invalidInput(`server name must not contain '__': ${name}`);
    }
  }
}

export function profileSnapshot(profile: McpProfileRecord): Record<string, unknown> {
  return { ...profile };
}

export function bindingTargetId(agentId: string, nodeId: string): string {
  return `${agentId}:${nodeId}`;
}

export function secretReferences(
  servers: readonly McpServerRecord[],
  profiles: readonly McpProfileRecord[],
): Map<string, { servers: Set<string>; profiles: Set<string> }> {
  const references = new Map<string, { servers: Set<string>; profiles: Set<string> }>();
  const add = (name: string, kind: "servers" | "profiles", owner: string): void => {
    let entry = references.get(name);
    if (entry === undefined) {
      entry = { servers: new Set(), profiles: new Set() };
      references.set(name, entry);
    }
    entry[kind].add(owner);
  };
  for (const server of servers) {
    const names = collectSecretReferences(server.config);
    for (const name of collectSecretReferences(server.node_overrides, names)) {
      add(name, "servers", server.id);
    }
  }
  for (const profile of profiles) {
    for (const name of collectSecretReferences(profile.hosted_tools)) {
      add(name, "profiles", profile.id);
    }
  }
  return references;
}

export async function buildSecretMetas(
  repository: McpCentralRepository,
  sql: LivePostgresSql,
  onlyName?: string,
): Promise<McpSecretMeta[]> {
  const [secretRows, servers, profiles] = await Promise.all([
    repository.listSecrets(sql),
    repository.listServers(sql),
    repository.listProfiles(sql),
  ]);
  const references = secretReferences(servers, profiles);
  return secretRows
    .filter((row) => onlyName === undefined || row.name === onlyName)
    .map((row) => {
      const entry = references.get(row.name);
      return {
        name: row.name,
        updated_at: row.updated_at,
        servers: [...(entry?.servers ?? [])].sort(),
        profiles: [...(entry?.profiles ?? [])].sort(),
      };
    });
}

/** 업로드 아이콘 참조가 이 서버가 쓸 수 있는 행인지 같은 트랜잭션에서 확인한다. */
export async function resolveUploadIcon(
  repository: McpCentralRepository,
  tx: LivePostgresSql,
  serverId: string,
  icon: McpIcon | null,
): Promise<McpIcon | null> {
  if (icon?.kind !== "upload") return icon;
  const row = await repository.getIconRow(tx, icon.ref);
  if (row === null) throw invalidIconUploadError(`upload icon row is missing: ${icon.ref}`);
  if (row.content_hash !== icon.content_hash) {
    throw invalidIconUploadError("upload icon content_hash does not match");
  }
  if (row.server_id !== null && row.server_id !== serverId) {
    throw invalidIconUploadError("upload icon row belongs to another server");
  }
  return icon;
}

/**
 * 되돌리기의 업로드 아이콘. 스냅샷의 행이 이미 없으면 아이콘 없음으로
 * 복원하고, 다른 서버 소유이거나 내용 해시가 다르면 깨진 참조다.
 */
export async function resolveRollbackUploadIcon(
  repository: McpCentralRepository,
  tx: LivePostgresSql,
  serverId: string,
  icon: McpIcon | null,
): Promise<McpIcon | null> {
  if (icon?.kind !== "upload") return icon;
  const row = await repository.getIconRow(tx, icon.ref);
  if (row === null) return null;
  if (row.content_hash !== icon.content_hash) {
    throw brokenReference("upload icon content_hash does not match");
  }
  if (row.server_id !== null && row.server_id !== serverId) {
    throw brokenReference("upload icon row belongs to another server");
  }
  return icon;
}

/** 이전 소유 업로드 행 정리와 새 아이콘 결합을 한 트랜잭션에서 처리한다. */
export async function applyIconChange(
  repository: McpCentralRepository,
  tx: LivePostgresSql,
  serverId: string,
  previous: McpIcon | null,
  next: McpIcon | null,
): Promise<void> {
  if (
    previous?.kind === "upload"
    && (next?.kind !== "upload" || next.ref !== previous.ref)
  ) {
    await repository.deleteIconOfServer(tx, previous.ref, serverId);
  }
  if (next?.kind === "upload") {
    await repository.attachIcon(tx, next.ref, serverId);
  }
}

export function parseSnapshotDefinition(value: unknown, label: string): McpServerDefinition {
  try {
    return parseServerDefinition(value, label);
  } catch (error) {
    if (error instanceof McpCentralError) throw brokenReference(`${label} is invalid`);
    throw error;
  }
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function uniqueProfileId(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base;
  let index = 2;
  while (existing.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function brokenReference(message: string): McpCentralError {
  return new McpCentralError("MCP_ROLLBACK_BROKEN_REFERENCE", 409, message);
}
