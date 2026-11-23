import { randomUUID } from "node:crypto";

import { isRecord } from "@soulstream/wire-schema/json-record";

import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { conflict, invalidInput, notFound } from "./errors.js";
import { parseIconUpload, validateIcon } from "./icon_validation.js";
import { createProfileService } from "./profile_service.js";
import { createMcpCentralRepository } from "./repository.js";
import { createRollbackService } from "./rollback_service.js";
import { assertSecretName, extractServerSecrets } from "./secret_refs.js";
import {
  applyIconChange,
  assertServerId,
  assertTransportNames,
  buildSecretMetas,
  effectiveName,
  resolveUploadIcon,
  secretReferences,
  serverView,
} from "./service_shared.js";
import { parseServerInput, parseWriteOptions } from "./server_validation.js";
import {
  type McpConfigView,
  type McpManagedNodeAck,
  type McpRevisionRecord,
  type McpRevisionTarget,
  type McpSecretMeta,
  type McpServerDefinition,
  type McpServerRecord,
  type McpServerView,
  type McpStoredIcon,
  type McpUploadedIconRecord,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type McpCentralServiceOptions = {
  readonly resolveSql: () => Promise<LivePostgresSql>;
};

export type McpCentralService = ReturnType<typeof createMcpCentralService>;

export function createMcpCentralService(options: McpCentralServiceOptions) {
  const repository = createMcpCentralRepository({ resolveSql: options.resolveSql });
  const profileService = createProfileService({ repository });
  const rollbackService = createRollbackService({ repository });

  async function getConfig(): Promise<McpConfigView> {
    const sql = await options.resolveSql();
    const base = await repository.readConfig(sql);
    const secrets = await buildSecretMetas(repository, sql);
    return {
      ...base,
      servers: base.servers.map(serverView),
      secrets,
    };
  }

  async function putServer(
    idValue: unknown,
    input: unknown,
    writeOptions?: unknown,
  ): Promise<McpServerView> {
    const id = assertServerId(idValue);
    const parsed = parseServerInput(input);
    const requestedIcon = isRecord(input) ? validateIcon(input.icon) : null;
    const write = parseWriteOptions(writeOptions);

    return repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const managed = await repository.listManagedNodes(tx);
      const managedIds = new Set(managed.map((node) => node.node_id));
      for (const nodeId of parsed.node_scope) {
        if (!managedIds.has(nodeId)) {
          throw invalidInput(`node_scope contains an unknown node: ${nodeId}`);
        }
      }

      const existing = await repository.getServer(tx, id);
      if (write.expectedVersion !== undefined) {
        if (existing === null) throw notFound("MCP_SERVER_NOT_FOUND", `server not found: ${id}`);
        if (existing.version !== write.expectedVersion) {
          throw conflict("MCP_SERVER_VERSION_CONFLICT", "server version does not match");
        }
      }

      const nodeOverrides = parsed.node_overrides ?? {};
      const definition: McpServerDefinition = {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        type: parsed.type,
        config: parsed.config,
      };
      const candidate: McpServerRecord = {
        id,
        name: parsed.name ?? null,
        type: parsed.type,
        config: parsed.config as Record<string, unknown>,
        node_scope: [...parsed.node_scope],
        node_overrides: nodeOverrides,
        icon: requestedIcon,
        version: existing?.version ?? 0,
      };
      assertTransportNames(candidate);

      const others = (await repository.listServers(tx)).filter((server) => server.id !== id);
      for (const nodeId of candidate.node_scope) {
        const name = effectiveName(candidate, nodeId);
        for (const other of others) {
          if (!other.node_scope.includes(nodeId)) continue;
          if (effectiveName(other, nodeId) === name) {
            throw conflict(
              "MCP_DUPLICATE_SERVER_NAME",
              `server name is already used on node ${nodeId}: ${name}`,
            );
          }
        }
      }

      const extracted = extractServerSecrets(id, definition, nodeOverrides);
      for (const [name, value] of extracted.secrets) {
        await repository.upsertSecret(tx, name, value);
      }
      for (const [name, value] of Object.entries(parsed.inline_secrets ?? {})) {
        await repository.upsertSecret(tx, name, value);
      }

      const nextIcon = await resolveUploadIcon(repository, tx, id, requestedIcon);

      const saved = await repository.upsertServer(tx, {
        id,
        name: parsed.name ?? null,
        type: parsed.type,
        config: extracted.definition.config as Record<string, unknown>,
        node_scope: candidate.node_scope,
        node_overrides: extracted.node_overrides,
        icon: nextIcon,
      });
      // 소유 표시(server_id)는 서버 행이 있어야 붙일 수 있어 저장 뒤에 정리한다.
      await applyIconChange(repository, tx, id, existing?.icon ?? null, nextIcon);
      await repository.insertRevision(tx, "server", id, { ...saved });
      return serverView(saved);
    });
  }

  async function deleteServer(idValue: unknown, writeOptions?: unknown): Promise<void> {
    const id = assertServerId(idValue);
    const write = parseWriteOptions(writeOptions);
    await repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const existing = await repository.getServer(tx, id);
      if (existing === null) throw notFound("MCP_SERVER_NOT_FOUND", `server not found: ${id}`);
      if (write.expectedVersion !== undefined && existing.version !== write.expectedVersion) {
        throw conflict("MCP_SERVER_VERSION_CONFLICT", "server version does not match");
      }
      const profiles = await repository.listProfiles(tx);
      const users = profiles.filter((profile) => profile.mcp_servers.includes(id));
      if (users.length > 0) {
        throw conflict(
          "MCP_SERVER_INUSE",
          `server is referenced by profiles: ${users.map((profile) => profile.id).join(", ")}`,
        );
      }
      await repository.deleteIconsForServer(tx, id);
      await repository.deleteServerRow(tx, id);
      await repository.insertRevision(tx, "server", id, { deleted: true, id });
    });
  }

  async function putSecret(
    nameValue: unknown,
    value: unknown,
    writeOptions?: unknown,
  ): Promise<McpSecretMeta> {
    if (typeof nameValue !== "string") throw invalidInput("secret name must be a string");
    const name = nameValue;
    assertSecretName(name);
    if (typeof value !== "string") throw invalidInput("secret value must be a string");
    const write = parseWriteOptions(writeOptions);
    return repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      await repository.upsertSecret(tx, name, value);
      const metas = await buildSecretMetas(repository, tx, name);
      const meta = metas[0];
      if (meta === undefined) throw new Error(`secret metadata missing after write: ${name}`);
      return meta;
    });
  }

  async function deleteSecret(nameValue: unknown, writeOptions?: unknown): Promise<void> {
    if (typeof nameValue !== "string") throw invalidInput("secret name must be a string");
    const name = nameValue;
    assertSecretName(name);
    const write = parseWriteOptions(writeOptions);
    await repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const [servers, profiles, secretRows] = await Promise.all([
        repository.listServers(tx),
        repository.listProfiles(tx),
        repository.listSecrets(tx),
      ]);
      if (!secretRows.some((row) => row.name === name)) {
        throw notFound("MCP_SECRET_NOT_FOUND", `secret not found: ${name}`);
      }
      const references = secretReferences(servers, profiles).get(name);
      if (references !== undefined) {
        throw conflict(
          "MCP_SECRET_INUSE",
          `secret is referenced by servers ${[...references.servers].join(", ")}`
            + ` and profiles ${[...references.profiles].join(", ")}`,
        );
      }
      await repository.deleteSecretRow(tx, name);
    });
  }

  async function addManagedNode(nodeIdValue: unknown, writeOptions?: unknown): Promise<void> {
    if (typeof nodeIdValue !== "string" || nodeIdValue.length === 0) {
      throw invalidInput("node id must be a non-empty string");
    }
    const write = parseWriteOptions(writeOptions);
    await repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      await repository.insertManagedNode(tx, nodeIdValue);
    });
  }

  function updateManagedNodeAck(nodeId: string, ack: McpManagedNodeAck): Promise<void> {
    return repository.updateManagedNodeAck(nodeId, ack);
  }

  async function listRevisions(filterValue?: unknown): Promise<McpRevisionRecord[]> {
    const filter: { target?: McpRevisionTarget; target_id?: string } = {};
    if (filterValue !== undefined) {
      if (!isRecord(filterValue)) throw invalidInput("revision filter must be an object");
      if (filterValue.target !== undefined) {
        if (
          filterValue.target !== "server"
          && filterValue.target !== "profile"
          && filterValue.target !== "binding"
        ) {
          throw invalidInput("revision target must be server, profile or binding");
        }
        filter.target = filterValue.target;
      }
      if (filterValue.target_id !== undefined) {
        if (typeof filterValue.target_id !== "string") {
          throw invalidInput("revision target_id must be a string");
        }
        filter.target_id = filterValue.target_id;
      }
    }
    const sql = await options.resolveSql();
    return repository.listRevisions(sql, filter);
  }

  async function uploadServerIcon(input: unknown): Promise<McpUploadedIconRecord> {
    const decoded = parseIconUpload(input);
    return repository.writeRecord(async (tx) => {
      const ref = randomUUID();
      await repository.insertIconDraft(tx, {
        id: ref,
        mime: decoded.mime,
        body: decoded.body,
        width: decoded.width,
        height: decoded.height,
        content_hash: decoded.content_hash,
      });
      await repository.deleteStaleIconDrafts(tx);
      return {
        ref,
        content_hash: decoded.content_hash,
        mime: decoded.mime,
        width: decoded.width,
        height: decoded.height,
        url: `/api/mcp/server-icons/${ref}?v=${decoded.content_hash}`,
      };
    });
  }

  async function getServerIcon(ref: unknown): Promise<McpStoredIcon | null> {
    if (typeof ref !== "string" || !UUID_PATTERN.test(ref)) return null;
    const sql = await options.resolveSql();
    const row = await repository.getIconBody(sql, ref);
    return row === null
      ? null
      : { mime: row.mime, body: row.body, content_hash: row.content_hash };
  }

  return {
    getConfig,
    putServer,
    deleteServer,
    putProfile: profileService.putProfile,
    deleteProfile: profileService.deleteProfile,
    setAgentBindings: profileService.setAgentBindings,
    putSecret,
    deleteSecret,
    addManagedNode,
    updateManagedNodeAck,
    listRevisions,
    rollback: rollbackService.rollback,
    uploadServerIcon,
    getServerIcon,
  };
}
