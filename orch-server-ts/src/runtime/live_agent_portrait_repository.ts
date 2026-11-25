import type {
  AgentPortraitContent,
  AgentPortraitRepository,
  AgentPortraitSource,
  AgentPortraitSummary,
  AgentPortraitWrite,
} from "../node/agent_portrait_model.js";
import type { SupportedPortraitMime } from "../node/agent_profile_routes.js";
import { optionalRead, type LiveDbSqlResolver } from "./live_db_sql.js";

/**
 * 중앙 초상 저장소. 목록(agent_id → sha256 등)은 메모리에 들고, 시작할 때 읽고 쓰기마다 고친다.
 * 바이트는 요청 때 DB에서 읽는다. 지운 기록(칸이 모두 NULL인 행)은 memory에 null로 남는다.
 */
export function createLiveAgentPortraitRepository(
  sqlResolver: LiveDbSqlResolver,
  warn: (message: string) => void = () => {},
): AgentPortraitRepository {
  const index = new Map<string, AgentPortraitSummary | null>();
  let readyPromise: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    const sql = await sqlResolver.resolveSql();
    // agent_profiles 칸의 바이트를 한 번만 옮긴다. 행이 이미 있으면(지운 기록 포함) 건드리지 않는다.
    const moved = await optionalRead(async () => sql`
      INSERT INTO agent_portraits
        (agent_id, portrait_blob, portrait_mime, portrait_sha256, byte_size, source, updated_at)
      SELECT agent_id, portrait_blob, portrait_mime, portrait_sha256,
             octet_length(portrait_blob), 'profile', updated_at
      FROM agent_profiles
      WHERE portrait_blob IS NOT NULL
      ON CONFLICT (agent_id) DO NOTHING
      RETURNING agent_id
    `);
    if (moved.length > 0) warn(`agent portraits moved from agent_profiles: ${moved.length}`);
    const rows = await optionalRead(async () => sql`
      SELECT agent_id, portrait_mime, portrait_sha256, byte_size, updated_at,
             (portrait_blob IS NULL) AS deleted
      FROM agent_portraits
    `);
    index.clear();
    for (const row of rows) index.set(String(row.agent_id), row.deleted === true ? null : mapSummary(row));
  };

  const repository: AgentPortraitRepository = {
    ready() {
      readyPromise ??= load().catch((error) => {
        readyPromise = undefined;
        throw error;
      });
      return readyPromise;
    },
    list() {
      return [...index.values()]
        .filter((entry): entry is AgentPortraitSummary => entry !== null)
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
    },
    summary: (agentId) => index.get(agentId) ?? null,
    hasRecord: (agentId) => index.has(agentId),
    async get(agentId) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT agent_id, portrait_blob, portrait_mime, portrait_sha256, byte_size, updated_at
        FROM agent_portraits
        WHERE agent_id = ${agentId} AND portrait_blob IS NOT NULL
      `;
      return rows[0] === undefined ? null : mapContent(rows[0]);
    },
    async put(input) {
      const summary = await upsert(sqlResolver, input, "upload", true);
      if (summary === null) throw new Error(`Portrait write for ${input.agentId} returned no row`);
      index.set(summary.agentId, summary);
      return summary;
    },
    async remove(agentId) {
      const sql = await sqlResolver.resolveSql();
      await sql`
        INSERT INTO agent_portraits (agent_id, source, updated_at)
        VALUES (${agentId}, 'upload', NOW())
        ON CONFLICT (agent_id) DO UPDATE
        SET portrait_blob = NULL, portrait_mime = NULL, portrait_sha256 = NULL,
            byte_size = NULL, source = 'upload', updated_at = NOW()
      `;
      index.set(agentId, null);
    },
    async seedFromNode(input) {
      const summary = await upsert(sqlResolver, input, "node", false);
      if (summary === null) return false;
      index.set(summary.agentId, summary);
      return true;
    },
  };
  return repository;
}

async function upsert(
  sqlResolver: LiveDbSqlResolver,
  input: AgentPortraitWrite,
  source: AgentPortraitSource,
  overwrite: boolean,
): Promise<AgentPortraitSummary | null> {
  const sql = await sqlResolver.resolveSql();
  const rows = overwrite
    ? await sql`
        INSERT INTO agent_portraits
          (agent_id, portrait_blob, portrait_mime, portrait_sha256, byte_size, source, updated_at)
        VALUES (${input.agentId}, ${input.body}, ${input.mime}, ${input.sha256},
                ${input.body.length}, ${source}, NOW())
        ON CONFLICT (agent_id) DO UPDATE
        SET portrait_blob = EXCLUDED.portrait_blob, portrait_mime = EXCLUDED.portrait_mime,
            portrait_sha256 = EXCLUDED.portrait_sha256, byte_size = EXCLUDED.byte_size,
            source = EXCLUDED.source, updated_at = NOW()
        RETURNING agent_id, portrait_mime, portrait_sha256, byte_size, updated_at
      `
    : await sql`
        INSERT INTO agent_portraits
          (agent_id, portrait_blob, portrait_mime, portrait_sha256, byte_size, source, updated_at)
        VALUES (${input.agentId}, ${input.body}, ${input.mime}, ${input.sha256},
                ${input.body.length}, ${source}, NOW())
        ON CONFLICT (agent_id) DO NOTHING
        RETURNING agent_id, portrait_mime, portrait_sha256, byte_size, updated_at
      `;
  return rows[0] === undefined ? null : mapSummary(rows[0]);
}

function mapSummary(row: Record<string, unknown>): AgentPortraitSummary {
  return {
    agentId: String(row.agent_id),
    sha256: String(row.portrait_sha256),
    mime: row.portrait_mime as SupportedPortraitMime,
    byteSize: Number(row.byte_size),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapContent(row: Record<string, unknown>): AgentPortraitContent {
  const blob = row.portrait_blob;
  return {
    ...mapSummary(row),
    body: Buffer.isBuffer(blob) ? blob : Buffer.from(blob as Uint8Array),
  };
}
