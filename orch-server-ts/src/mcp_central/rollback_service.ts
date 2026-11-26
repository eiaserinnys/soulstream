import { AgentsSdkHostedToolSchema } from "@soulstream/agent-profile-contract";
import { isRecord } from "@soulstream/wire-schema/json-record";

import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { invalidInput, notFound } from "./errors.js";
import type { McpCentralRepository } from "./repository.js";
import { collectSecretReferences } from "./secret_refs.js";
import {
  applyIconChange,
  brokenReference,
  parseSnapshotDefinition,
  profileSnapshot,
  resolveRollbackUploadIcon,
  stringArray,
} from "./service_shared.js";
import { parseWriteOptions } from "./server_validation.js";
import type { McpIcon, McpServerDefinition } from "./types.js";

export function createRollbackService(options: {
  readonly repository: McpCentralRepository;
}) {
  const { repository } = options;

  async function rollback(revisionIdValue: unknown, writeOptions?: unknown): Promise<{ current_revision: number; result: void }> {
    if (
      typeof revisionIdValue !== "number"
      || !Number.isInteger(revisionIdValue)
      || revisionIdValue <= 0
    ) {
      throw invalidInput("revision id must be a positive integer");
    }
    const write = parseWriteOptions(writeOptions);
    return repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const revision = await repository.getRevision(tx, revisionIdValue);
      if (revision === null) {
        throw notFound("MCP_REVISION_NOT_FOUND", `revision not found: ${revisionIdValue}`);
      }
      switch (revision.target) {
        case "server":
          await rollbackServer(tx, revision.target_id, revision.snapshot);
          break;
        case "profile":
          await rollbackProfile(tx, revision.target_id, revision.snapshot);
          break;
        case "binding":
          await rollbackBinding(tx, revision.target_id, revision.snapshot);
          break;
      }
    });
  }

  async function rollbackServer(
    tx: LivePostgresSql,
    id: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    const current = await repository.getServer(tx, id);
    if (snapshot.deleted === true) {
      if (current !== null) {
        const profiles = await repository.listProfiles(tx);
        const users = profiles.filter((profile) => profile.mcp_servers.includes(id));
        if (users.length > 0) {
          throw brokenReference(`server ${id} is referenced by profiles`);
        }
        await repository.deleteIconsForServer(tx, id);
        await repository.deleteServerRow(tx, id);
      }
      await repository.insertRevision(tx, "server", id, { deleted: true, id });
      return;
    }

    const definition = parseSnapshotDefinition(
      { name: snapshot.name ?? undefined, type: snapshot.type, config: snapshot.config },
      "server snapshot",
    );
    const nodeScope = stringArray(snapshot.node_scope);
    const nodeOverrides: Record<string, McpServerDefinition> = {};
    if (isRecord(snapshot.node_overrides)) {
      for (const [nodeId, override] of Object.entries(snapshot.node_overrides)) {
        nodeOverrides[nodeId] = parseSnapshotDefinition(
          override,
          `server snapshot override ${nodeId}`,
        );
      }
    }
    const managed = await repository.listManagedNodes(tx);
    const managedIds = new Set(managed.map((node) => node.node_id));
    for (const nodeId of nodeScope) {
      if (!managedIds.has(nodeId)) throw brokenReference(`node_scope node is missing: ${nodeId}`);
    }
    for (const nodeId of Object.keys(nodeOverrides)) {
      if (!nodeScope.includes(nodeId)) {
        throw brokenReference(`node_overrides key is not in node_scope: ${nodeId}`);
      }
    }
    await assertSecretsExist(tx, collectSecretReferences([definition.config, nodeOverrides]));

    const snapshotIcon = isRecord(snapshot.icon)
      && (snapshot.icon.kind === "brand" || snapshot.icon.kind === "symbol" || snapshot.icon.kind === "upload")
      ? (snapshot.icon as unknown as McpIcon)
      : null;
    const nextIcon = await resolveRollbackUploadIcon(repository, tx, id, snapshotIcon);
    const saved = await repository.upsertServer(tx, {
      id,
      name: definition.name ?? null,
      type: definition.type,
      config: definition.config as Record<string, unknown>,
      node_scope: nodeScope,
      node_overrides: nodeOverrides,
      icon: nextIcon,
    });
    await applyIconChange(repository, tx, id, current?.icon ?? null, nextIcon);
    await repository.insertRevision(tx, "server", id, { ...saved });
  }

  async function rollbackProfile(
    tx: LivePostgresSql,
    id: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    if (snapshot.deleted === true) {
      const bindings = await repository.listBindings(tx);
      if (bindings.some((binding) => binding.mcp_profile_id === id)) {
        throw brokenReference(`profile ${id} is bound to agents`);
      }
      await repository.deleteProfileRow(tx, id);
      await repository.insertRevision(tx, "profile", id, { deleted: true, id });
      return;
    }

    const servers = stringArray(snapshot.mcp_servers);
    const existingServers = new Set((await repository.listServers(tx)).map((server) => server.id));
    for (const serverId of servers) {
      if (!existingServers.has(serverId)) {
        throw brokenReference(`profile snapshot references a missing server: ${serverId}`);
      }
    }
    const hostedTools = Array.isArray(snapshot.hosted_tools) ? snapshot.hosted_tools : [];
    for (const tool of hostedTools) {
      if (!AgentsSdkHostedToolSchema.safeParse(tool).success) {
        throw brokenReference("profile snapshot has an invalid hosted tool");
      }
    }
    await assertSecretsExist(tx, collectSecretReferences(hostedTools));
    const saved = await repository.upsertProfile(tx, {
      id,
      name: typeof snapshot.name === "string" ? snapshot.name : null,
      description: typeof snapshot.description === "string" ? snapshot.description : null,
      mcp_servers: servers,
      hosted_tools: hostedTools,
      ...(snapshot.node_scope === undefined ? {} : { node_scope: stringArray(snapshot.node_scope) }),
    });
    await repository.insertRevision(tx, "profile", id, profileSnapshot(saved));
  }

  async function rollbackBinding(
    tx: LivePostgresSql,
    targetId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    const separator = targetId.lastIndexOf(":");
    if (separator <= 0) throw brokenReference(`binding target id is invalid: ${targetId}`);
    const agentId = targetId.slice(0, separator);
    const nodeId = targetId.slice(separator + 1);
    if (snapshot.deleted === true) {
      const removed = await repository.deleteBinding(tx, agentId, nodeId);
      if (removed !== null) {
        await repository.insertRevision(tx, "binding", targetId, { ...removed, deleted: true });
      }
      return;
    }
    const profileId = snapshot.mcp_profile_id;
    if (typeof profileId !== "string") throw brokenReference("binding snapshot has no profile");
    const profile = await repository.getProfile(tx, profileId);
    if (profile === null) throw brokenReference(`binding snapshot references a missing profile: ${profileId}`);
    const managed = await repository.listManagedNodes(tx);
    if (!managed.some((node) => node.node_id === nodeId)) {
      throw brokenReference(`binding snapshot references a missing node: ${nodeId}`);
    }
    const saved = await repository.upsertBinding(tx, agentId, nodeId, profileId);
    await repository.insertRevision(tx, "binding", targetId, { ...saved });
    if (!profile.node_scope.includes(nodeId)) {
      const updated = await repository.setProfileNodeScope(tx, profileId, [...profile.node_scope, nodeId]);
      if (updated !== null) {
        await repository.insertRevision(tx, "profile", profileId, profileSnapshot(updated));
      }
    }
  }

  async function assertSecretsExist(tx: LivePostgresSql, names: Set<string>): Promise<void> {
    if (names.size === 0) return;
    const rows = await repository.listSecrets(tx);
    const existing = new Set(rows.map((row) => row.name));
    for (const name of names) {
      if (!existing.has(name)) {
        throw brokenReference(`secret reference is missing: ${name}`);
      }
    }
  }

  return { rollback };
}
