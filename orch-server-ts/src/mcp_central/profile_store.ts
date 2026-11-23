import {
  iso,
  mapBinding,
  mapManagedNode,
  mapProfile,
  mapRevision,
  type BindingRow,
  type ManagedNodeRow,
  type ProfileRow,
  type ProfileWrite,
  type RevisionRow,
  type SecretRow,
  type Sql,
} from "./store_types.js";
import type {
  McpBindingRecord,
  McpManagedNodeRecord,
  McpProfileRecord,
  McpRevisionRecord,
  McpRevisionTarget,
} from "./types.js";

export function createProfileStore() {
  return {
    async listProfiles(sql: Sql): Promise<McpProfileRecord[]> {
      const rows = await sql<ProfileRow[]>`
        SELECT id, name, description, mcp_servers, hosted_tools, node_scope, version
        FROM mcp_profiles ORDER BY id ASC
      `;
      return rows.map(mapProfile);
    },

    async getProfile(sql: Sql, id: string): Promise<McpProfileRecord | null> {
      const rows = await sql<ProfileRow[]>`
        SELECT id, name, description, mcp_servers, hosted_tools, node_scope, version
        FROM mcp_profiles WHERE id = ${id} LIMIT 1
      `;
      return rows[0] === undefined ? null : mapProfile(rows[0]);
    },

    async upsertProfile(sql: Sql, profile: ProfileWrite): Promise<McpProfileRecord> {
      const rows = await sql<ProfileRow[]>`
        INSERT INTO mcp_profiles (id, name, description, mcp_servers, hosted_tools, node_scope)
        VALUES (
          ${profile.id}, ${profile.name}, ${profile.description},
          ${sql.json([...profile.mcp_servers])}, ${sql.json([...profile.hosted_tools])},
          ${sql.json(profile.node_scope === undefined ? [] : [...profile.node_scope])}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          mcp_servers = EXCLUDED.mcp_servers,
          hosted_tools = EXCLUDED.hosted_tools,
          node_scope = CASE WHEN ${profile.node_scope !== undefined}
            THEN EXCLUDED.node_scope ELSE mcp_profiles.node_scope END,
          version = mcp_profiles.version + 1,
          updated_at = NOW()
        RETURNING id, name, description, mcp_servers, hosted_tools, node_scope, version
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`failed to upsert mcp profile ${profile.id}`);
      return mapProfile(row);
    },

    async insertProfileClone(
      sql: Sql,
      profile: { id: string; name: string | null; description: string | null; mcp_servers: readonly string[]; hosted_tools: readonly unknown[]; node_scope: readonly string[] },
    ): Promise<McpProfileRecord> {
      const rows = await sql<ProfileRow[]>`
        INSERT INTO mcp_profiles (id, name, description, mcp_servers, hosted_tools, node_scope)
        VALUES (
          ${profile.id}, ${profile.name}, ${profile.description},
          ${sql.json([...profile.mcp_servers])}, ${sql.json([...profile.hosted_tools])},
          ${sql.json([...profile.node_scope])}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          mcp_servers = EXCLUDED.mcp_servers,
          hosted_tools = EXCLUDED.hosted_tools,
          node_scope = EXCLUDED.node_scope,
          version = mcp_profiles.version + 1,
          updated_at = NOW()
        RETURNING id, name, description, mcp_servers, hosted_tools, node_scope, version
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`failed to insert mcp profile ${profile.id}`);
      return mapProfile(row);
    },

    async deleteProfileRow(sql: Sql, id: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM mcp_profiles WHERE id = ${id} RETURNING id
      `;
      return rows[0] !== undefined;
    },

    async setProfileNodeScope(
      sql: Sql,
      id: string,
      nodeScope: readonly string[],
    ): Promise<McpProfileRecord | null> {
      const rows = await sql<ProfileRow[]>`
        UPDATE mcp_profiles SET node_scope = ${sql.json([...nodeScope])}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, name, description, mcp_servers, hosted_tools, node_scope, version
      `;
      return rows[0] === undefined ? null : mapProfile(rows[0]);
    },

    async listBindings(sql: Sql): Promise<McpBindingRecord[]> {
      const rows = await sql<BindingRow[]>`
        SELECT agent_id, node_id, mcp_profile_id, version
        FROM mcp_agent_bindings ORDER BY agent_id ASC, node_id ASC
      `;
      return rows.map(mapBinding);
    },

    async getBinding(sql: Sql, agentId: string, nodeId: string): Promise<McpBindingRecord | null> {
      const rows = await sql<BindingRow[]>`
        SELECT agent_id, node_id, mcp_profile_id, version
        FROM mcp_agent_bindings WHERE agent_id = ${agentId} AND node_id = ${nodeId} LIMIT 1
      `;
      return rows[0] === undefined ? null : mapBinding(rows[0]);
    },

    async upsertBinding(
      sql: Sql,
      agentId: string,
      nodeId: string,
      profileId: string,
    ): Promise<McpBindingRecord> {
      const rows = await sql<BindingRow[]>`
        INSERT INTO mcp_agent_bindings (agent_id, node_id, mcp_profile_id)
        VALUES (${agentId}, ${nodeId}, ${profileId})
        ON CONFLICT (agent_id, node_id) DO UPDATE SET
          mcp_profile_id = EXCLUDED.mcp_profile_id,
          version = mcp_agent_bindings.version + 1,
          updated_at = NOW()
        RETURNING agent_id, node_id, mcp_profile_id, version
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`failed to upsert mcp binding ${agentId}/${nodeId}`);
      return mapBinding(row);
    },

    async deleteBinding(sql: Sql, agentId: string, nodeId: string): Promise<McpBindingRecord | null> {
      const rows = await sql<BindingRow[]>`
        DELETE FROM mcp_agent_bindings WHERE agent_id = ${agentId} AND node_id = ${nodeId}
        RETURNING agent_id, node_id, mcp_profile_id, version
      `;
      return rows[0] === undefined ? null : mapBinding(rows[0]);
    },

    async listManagedNodes(sql: Sql): Promise<McpManagedNodeRecord[]> {
      const rows = await sql<ManagedNodeRow[]>`
        SELECT node_id, central_active, activated_at, applied_mode, applied_revision,
               last_sync_at, last_sync_error, last_compare_id, last_verified_revision,
               last_verified_at
        FROM mcp_managed_nodes ORDER BY node_id ASC
      `;
      return rows.map(mapManagedNode);
    },

    async insertManagedNode(sql: Sql, nodeId: string): Promise<boolean> {
      const rows = await sql<{ node_id: string }[]>`
        INSERT INTO mcp_managed_nodes (node_id) VALUES (${nodeId})
        ON CONFLICT (node_id) DO NOTHING
        RETURNING node_id
      `;
      return rows[0] !== undefined;
    },

    async listSecrets(sql: Sql): Promise<{ name: string; updated_at: string | null }[]> {
      const rows = await sql<SecretRow[]>`
        SELECT name, updated_at FROM mcp_secrets ORDER BY name ASC
      `;
      return rows.map((row) => ({ name: row.name, updated_at: iso(row.updated_at) }));
    },

    async upsertSecret(sql: Sql, name: string, value: string): Promise<void> {
      await sql`
        INSERT INTO mcp_secrets (name, value) VALUES (${name}, ${value})
        ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    },

    async deleteSecretRow(sql: Sql, name: string): Promise<boolean> {
      const rows = await sql<{ name: string }[]>`
        DELETE FROM mcp_secrets WHERE name = ${name} RETURNING name
      `;
      return rows[0] !== undefined;
    },

    async insertRevision(
      sql: Sql,
      target: McpRevisionTarget,
      targetId: string,
      snapshot: Record<string, unknown>,
    ): Promise<void> {
      await sql`
        INSERT INTO mcp_config_revisions (target, target_id, snapshot)
        VALUES (${target}, ${targetId}, ${sql.json(snapshot)})
      `;
    },

    async listRevisions(
      sql: Sql,
      filter: { readonly target?: McpRevisionTarget; readonly target_id?: string },
    ): Promise<McpRevisionRecord[]> {
      const target = filter.target;
      const targetId = filter.target_id;
      const rows = target === undefined
        ? targetId === undefined
          ? await sql<RevisionRow[]>`
              SELECT id, target, target_id, snapshot, created_at
              FROM mcp_config_revisions ORDER BY id DESC
            `
          : await sql<RevisionRow[]>`
              SELECT id, target, target_id, snapshot, created_at
              FROM mcp_config_revisions WHERE target_id = ${targetId} ORDER BY id DESC
            `
        : targetId === undefined
          ? await sql<RevisionRow[]>`
              SELECT id, target, target_id, snapshot, created_at
              FROM mcp_config_revisions WHERE target = ${target} ORDER BY id DESC
            `
          : await sql<RevisionRow[]>`
              SELECT id, target, target_id, snapshot, created_at
              FROM mcp_config_revisions
              WHERE target = ${target} AND target_id = ${targetId} ORDER BY id DESC
            `;
      return rows.map(mapRevision);
    },

    async getRevision(sql: Sql, id: number): Promise<McpRevisionRecord | null> {
      const rows = await sql<RevisionRow[]>`
        SELECT id, target, target_id, snapshot, created_at
        FROM mcp_config_revisions WHERE id = ${id} LIMIT 1
      `;
      return rows[0] === undefined ? null : mapRevision(rows[0]);
    },
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
