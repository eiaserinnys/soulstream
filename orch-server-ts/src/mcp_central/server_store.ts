import {
  mapServer,
  type IconBodyRow,
  type IconDraftWrite,
  type IconRow,
  type ServerRow,
  type ServerWrite,
  type Sql,
} from "./store_types.js";
import type { McpServerRecord } from "./types.js";

export function createServerStore() {
  return {
    async listServers(sql: Sql): Promise<McpServerRecord[]> {
      const rows = await sql<ServerRow[]>`
        SELECT id, name, type, config, node_scope, node_overrides, icon, version
        FROM mcp_servers ORDER BY id ASC
      `;
      return rows.map(mapServer);
    },

    async getServer(sql: Sql, id: string): Promise<McpServerRecord | null> {
      const rows = await sql<ServerRow[]>`
        SELECT id, name, type, config, node_scope, node_overrides, icon, version
        FROM mcp_servers WHERE id = ${id} LIMIT 1
      `;
      return rows[0] === undefined ? null : mapServer(rows[0]);
    },

    async upsertServer(sql: Sql, server: ServerWrite): Promise<McpServerRecord> {
      const rows = await sql<ServerRow[]>`
        INSERT INTO mcp_servers (id, name, type, config, node_scope, node_overrides, icon)
        VALUES (
          ${server.id}, ${server.name}, ${server.type}, ${sql.json(server.config)},
          ${sql.json([...server.node_scope])}, ${sql.json(server.node_overrides)},
          ${server.icon === null ? null : sql.json(server.icon)}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          config = EXCLUDED.config,
          node_scope = EXCLUDED.node_scope,
          node_overrides = EXCLUDED.node_overrides,
          icon = EXCLUDED.icon,
          version = mcp_servers.version + 1,
          updated_at = NOW()
        RETURNING id, name, type, config, node_scope, node_overrides, icon, version
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`failed to upsert mcp server ${server.id}`);
      return mapServer(row);
    },

    async deleteServerRow(sql: Sql, id: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM mcp_servers WHERE id = ${id} RETURNING id
      `;
      return rows[0] !== undefined;
    },

    async insertIconDraft(sql: Sql, icon: IconDraftWrite): Promise<void> {
      await sql`
        INSERT INTO mcp_server_icons (id, server_id, mime, body, width, height, content_hash)
        VALUES (
          ${icon.id}::uuid, NULL, ${icon.mime}, ${icon.body},
          ${icon.width}, ${icon.height}, ${icon.content_hash}
        )
      `;
    },

    async deleteStaleIconDrafts(sql: Sql): Promise<void> {
      await sql`
        DELETE FROM mcp_server_icons
        WHERE server_id IS NULL AND created_at < NOW() - INTERVAL '24 hours'
      `;
    },

    async getIconRow(sql: Sql, ref: string): Promise<IconRow | null> {
      const rows = await sql<IconRow[]>`
        SELECT id, server_id, mime, content_hash FROM mcp_server_icons WHERE id = ${ref}::uuid LIMIT 1
      `;
      return rows[0] ?? null;
    },

    async getIconBody(sql: Sql, ref: string): Promise<IconBodyRow | null> {
      const rows = await sql<IconBodyRow[]>`
        SELECT mime, body, content_hash FROM mcp_server_icons WHERE id = ${ref}::uuid LIMIT 1
      `;
      return rows[0] ?? null;
    },

    async attachIcon(sql: Sql, ref: string, serverId: string): Promise<void> {
      await sql`
        UPDATE mcp_server_icons SET server_id = ${serverId} WHERE id = ${ref}::uuid
      `;
    },

    async deleteIconOfServer(sql: Sql, ref: string, serverId: string): Promise<void> {
      await sql`
        DELETE FROM mcp_server_icons WHERE id = ${ref}::uuid AND server_id = ${serverId}
      `;
    },

    async deleteIconsForServer(sql: Sql, serverId: string): Promise<void> {
      await sql`DELETE FROM mcp_server_icons WHERE server_id = ${serverId}`;
    },
  };
}

export type ServerStore = ReturnType<typeof createServerStore>;
