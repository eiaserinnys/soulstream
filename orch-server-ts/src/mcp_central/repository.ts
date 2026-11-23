import { conflict, notFound } from "./errors.js";
import { createProfileStore } from "./profile_store.js";
import { createServerStore } from "./server_store.js";
import type { Sql } from "./store_types.js";
import {
  toRevision,
  type McpConfigView,
  type McpManagedNodeAck,
} from "./types.js";

export type {
  IconDraftWrite,
  ProfileWrite,
  ServerWrite,
} from "./store_types.js";

export type McpCentralRepository = ReturnType<typeof createMcpCentralRepository>;

export function createMcpCentralRepository(options: {
  readonly resolveSql: () => Promise<Sql>;
}) {
  const servers = createServerStore();
  const profiles = createProfileStore();

  async function transaction<T>(run: (tx: Sql) => Promise<T>): Promise<T> {
    const sql = await options.resolveSql();
    const begin = sql.begin;
    if (begin === undefined) {
      throw new Error("PostgreSQL client does not support transactions");
    }
    return await begin(run);
  }

  /**
   * 설정 쓰기의 첫 문장. 판을 잠그고 올린 뒤 판정 행을 읽는다. 기대 판이
   * 주어졌는데 0행이면 409다. 최초에는 상태 행을 만든 뒤 다시 시도한다.
   */
  async function bumpRevision(tx: Sql, expectedRevision?: number): Promise<number> {
    if (expectedRevision === undefined) {
      const bumped = await tx<{ current_revision: unknown }[]>`
        UPDATE mcp_config_state
        SET current_revision = current_revision + 1, updated_at = NOW()
        WHERE id = 1
        RETURNING current_revision
      `;
      if (bumped[0] !== undefined) return toRevision(bumped[0].current_revision);
      await tx`INSERT INTO mcp_config_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
      const retried = await tx<{ current_revision: unknown }[]>`
        UPDATE mcp_config_state
        SET current_revision = current_revision + 1, updated_at = NOW()
        WHERE id = 1
        RETURNING current_revision
      `;
      return toRevision(retried[0]?.current_revision ?? 1);
    }

    const bumped = await tx<{ current_revision: unknown }[]>`
      UPDATE mcp_config_state
      SET current_revision = current_revision + 1, updated_at = NOW()
      WHERE id = 1 AND current_revision = ${expectedRevision}
      RETURNING current_revision
    `;
    if (bumped[0] !== undefined) return toRevision(bumped[0].current_revision);
    if (expectedRevision === 0) {
      await tx`INSERT INTO mcp_config_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
      const retried = await tx<{ current_revision: unknown }[]>`
        UPDATE mcp_config_state
        SET current_revision = current_revision + 1, updated_at = NOW()
        WHERE id = 1 AND current_revision = 0
        RETURNING current_revision
      `;
      if (retried[0] !== undefined) return toRevision(retried[0].current_revision);
    }
    throw conflict("MCP_REVISION_CONFLICT", "current_revision does not match expectedRevision");
  }

  /** 기록 쓰기의 첫 문장. 판은 올리지 않고 설정 쓰기와 순서만 맞춘다. */
  async function lockStateRow(tx: Sql): Promise<number> {
    const locked = await tx<{ current_revision: unknown }[]>`
      SELECT current_revision FROM mcp_config_state WHERE id = 1 FOR UPDATE
    `;
    if (locked[0] !== undefined) return toRevision(locked[0].current_revision);
    await tx`INSERT INTO mcp_config_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    const retried = await tx<{ current_revision: unknown }[]>`
      SELECT current_revision FROM mcp_config_state WHERE id = 1 FOR UPDATE
    `;
    return toRevision(retried[0]?.current_revision ?? 0);
  }

  async function getState(sql: Sql): Promise<number> {
    const rows = await sql<{ current_revision: unknown }[]>`
      SELECT current_revision FROM mcp_config_state WHERE id = 1
    `;
    return toRevision(rows[0]?.current_revision ?? 0);
  }

  return {
    ...servers,
    ...profiles,

    read<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
      return options.resolveSql().then(run);
    },

    writeConfig<T>(
      writeOptions: { readonly expectedRevision?: number },
      run: (tx: Sql, revision: number) => Promise<T>,
    ): Promise<{ current_revision: number; result: T }> {
      return transaction(async (tx) => {
        const revision = await bumpRevision(tx, writeOptions.expectedRevision);
        const result = await run(tx, revision);
        return { current_revision: revision, result };
      });
    },

    writeRecord<T>(run: (tx: Sql) => Promise<T>): Promise<T> {
      return transaction(async (tx) => {
        await lockStateRow(tx);
        return run(tx);
      });
    },

    async updateManagedNodeAck(nodeId: string, ack: McpManagedNodeAck): Promise<void> {
      const sql = await options.resolveSql();
      const rows = await sql<{ node_id: string }[]>`
        UPDATE mcp_managed_nodes SET
          central_active = CASE WHEN ${ack.activate === true} THEN true ELSE central_active END,
          activated_at = CASE WHEN ${ack.activate === true} THEN COALESCE(activated_at, NOW()) ELSE activated_at END,
          applied_mode = CASE WHEN ${ack.applied_mode !== undefined}
            THEN ${ack.applied_mode ?? null} ELSE applied_mode END,
          applied_revision = CASE WHEN ${ack.applied_revision !== undefined}
            THEN ${ack.applied_revision ?? null}::bigint ELSE applied_revision END,
          last_sync_at = CASE WHEN ${ack.last_sync_at !== undefined}
            THEN ${ack.last_sync_at ?? null}::timestamptz ELSE last_sync_at END,
          last_sync_error = CASE WHEN ${ack.last_sync_error !== undefined}
            THEN ${ack.last_sync_error ?? null} ELSE last_sync_error END,
          updated_at = NOW()
        WHERE node_id = ${nodeId}
        RETURNING node_id
      `;
      if (rows[0] === undefined) {
        throw notFound("MCP_NODE_NOT_FOUND", `managed node not found: ${nodeId}`);
      }
    },

    getState,

    /** 시험과 화면이 같은 모양을 쓰도록 설정 전체를 한 번에 읽는다. */
    async readConfig(sql: Sql): Promise<Omit<McpConfigView, "secrets">> {
      const [currentRevision, serverRows, profileRows, bindings, managedNodes] = await Promise.all([
        getState(sql),
        servers.listServers(sql),
        profiles.listProfiles(sql),
        profiles.listBindings(sql),
        profiles.listManagedNodes(sql),
      ]);
      return {
        current_revision: currentRevision,
        servers: serverRows,
        profiles: profileRows,
        bindings,
        managed_nodes: managedNodes,
      };
    },
  };
}
