import { AgentsSdkHostedToolSchema } from "@soulstream/agent-profile-contract";

import { conflict, invalidInput, notFound } from "./errors.js";
import type { McpCentralRepository } from "./repository.js";
import { extractHostedToolSecrets } from "./secret_refs.js";
import {
  assertProfileId,
  bindingTargetId,
  profileSnapshot,
  uniqueProfileId,
} from "./service_shared.js";
import {
  parseBindingInput,
  parseProfileInput,
  parseWriteOptions,
} from "./server_validation.js";
import type {
  McpBindingInput,
  McpBindingRecord,
  McpProfileView,
} from "./types.js";

export function createProfileService(options: {
  readonly repository: McpCentralRepository;
}) {
  const { repository } = options;

  async function putProfile(
    idValue: unknown,
    input: unknown,
    writeOptions?: unknown,
  ): Promise<McpProfileView> {
    const id = assertProfileId(idValue);
    const parsed = parseProfileInput(input);
    const write = parseWriteOptions(writeOptions);
    return repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const existing = await repository.getProfile(tx, id);
      if (write.expectedVersion !== undefined) {
        if (existing === null) throw notFound("MCP_PROFILE_NOT_FOUND", `profile not found: ${id}`);
        if (existing.version !== write.expectedVersion) {
          throw conflict("MCP_PROFILE_VERSION_CONFLICT", "profile version does not match");
        }
      }
      const servers = await repository.listServers(tx);
      const serverIds = new Set(servers.map((server) => server.id));
      for (const serverId of parsed.mcp_servers ?? []) {
        if (!serverIds.has(serverId)) {
          throw invalidInput(`profile.mcp_servers contains an unknown server: ${serverId}`);
        }
      }
      for (const tool of parsed.hosted_tools ?? []) {
        if (!AgentsSdkHostedToolSchema.safeParse(tool).success) {
          throw invalidInput("profile.hosted_tools contains an invalid tool");
        }
      }
      const extracted = extractHostedToolSecrets(id, parsed.hosted_tools ?? []);
      for (const [name, value] of extracted.secrets) {
        await repository.upsertSecret(tx, name, value);
      }
      const saved = await repository.upsertProfile(tx, {
        id,
        name: parsed.name ?? null,
        description: parsed.description ?? null,
        mcp_servers: parsed.mcp_servers ?? [],
        hosted_tools: extracted.hosted_tools,
      });
      await repository.insertRevision(tx, "profile", id, profileSnapshot(saved));
      return saved;
    });
  }

  async function deleteProfile(idValue: unknown, writeOptions?: unknown): Promise<void> {
    const id = assertProfileId(idValue);
    const write = parseWriteOptions(writeOptions);
    await repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const existing = await repository.getProfile(tx, id);
      if (existing === null) throw notFound("MCP_PROFILE_NOT_FOUND", `profile not found: ${id}`);
      if (write.expectedVersion !== undefined && existing.version !== write.expectedVersion) {
        throw conflict("MCP_PROFILE_VERSION_CONFLICT", "profile version does not match");
      }
      const bindings = await repository.listBindings(tx);
      if (bindings.some((binding) => binding.mcp_profile_id === id)) {
        throw conflict("MCP_PROFILE_INUSE", `profile is bound to agents: ${id}`);
      }
      await repository.deleteProfileRow(tx, id);
      await repository.insertRevision(tx, "profile", id, { deleted: true, id });
    });
  }

  async function setAgentBindings(
    agentIdValue: unknown,
    input: unknown,
    writeOptions?: unknown,
  ): Promise<McpBindingRecord[]> {
    if (typeof agentIdValue !== "string" || agentIdValue.length === 0) {
      throw invalidInput("agent id must be a non-empty string");
    }
    const agentId = agentIdValue;
    const parsed: McpBindingInput = parseBindingInput(input);
    const write = parseWriteOptions(writeOptions);
    return repository.writeConfig({ expectedRevision: write.expectedRevision }, async (tx) => {
      const managed = await repository.listManagedNodes(tx);
      const managedIds = new Set(managed.map((node) => node.node_id));
      for (const nodeId of parsed.node_ids) {
        if (!managedIds.has(nodeId)) {
          throw invalidInput(`node_ids contains an unknown node: ${nodeId}`);
        }
      }

      let profileId = parsed.mcp_profile_id;
      if (profileId !== null) {
        const profile = await repository.getProfile(tx, profileId);
        if (profile === null) throw notFound("MCP_PROFILE_NOT_FOUND", `profile not found: ${profileId}`);
        if (parsed.fork === true) {
          const profiles = await repository.listProfiles(tx);
          const cloneId = uniqueProfileId(
            `${profile.id}-${agentId}`,
            profiles.map((item) => item.id),
          );
          const clone = await repository.insertProfileClone(tx, {
            id: cloneId,
            name: profile.name,
            description: profile.description,
            mcp_servers: profile.mcp_servers,
            hosted_tools: profile.hosted_tools,
            node_scope: parsed.node_ids,
          });
          await repository.insertRevision(tx, "profile", cloneId, profileSnapshot(clone));
          profileId = cloneId;
        }
      }

      const result: McpBindingRecord[] = [];
      for (const nodeId of parsed.node_ids) {
        if (profileId === null) {
          const removed = await repository.deleteBinding(tx, agentId, nodeId);
          if (removed !== null) {
            await repository.insertRevision(tx, "binding", bindingTargetId(agentId, nodeId), {
              ...removed,
              deleted: true,
            });
          }
        } else {
          const saved = await repository.upsertBinding(tx, agentId, nodeId, profileId);
          await repository.insertRevision(tx, "binding", bindingTargetId(agentId, nodeId), {
            ...saved,
          });
          result.push(saved);
        }
      }

      if (profileId !== null) {
        const profile = await repository.getProfile(tx, profileId);
        if (profile !== null) {
          const scope = [...profile.node_scope];
          for (const nodeId of parsed.node_ids) {
            if (!scope.includes(nodeId)) scope.push(nodeId);
          }
          const updated = await repository.setProfileNodeScope(tx, profileId, scope);
          if (updated !== null) {
            await repository.insertRevision(tx, "profile", profileId, profileSnapshot(updated));
          }
        }
      }
      return result;
    });
  }

  return { putProfile, deleteProfile, setAgentBindings };
}

export type ProfileService = ReturnType<typeof createProfileService>;
