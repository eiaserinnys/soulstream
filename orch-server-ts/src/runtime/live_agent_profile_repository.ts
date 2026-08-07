import type {
  AgentPortraitRecord,
  AgentPortraitWrite,
  AgentProfileRecord,
  AgentProfileRepository,
  AgentProfileWrite,
  SupportedPortraitMime,
} from "../node/agent_profile_routes.js";
import { AgentProfileVersionConflictError } from "../node/agent_profile_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export function createLiveAgentProfileRepository(
  sqlResolver: LiveDbSqlResolver,
): AgentProfileRepository {
  const profiles = new Map<string, AgentProfileRecord>();
  const remember = (profile: AgentProfileRecord): AgentProfileRecord => {
    profiles.set(profile.agentId, profile);
    return profile;
  };
  const repository: AgentProfileRepository = {
    snapshot() {
      return [...profiles.values()].sort((left, right) =>
        left.agentId.localeCompare(right.agentId)
      );
    },
    async list() {
      const rows = await optionalProfileRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT agent_id, name, atom_contexts, default_preset, aliases,
                 portrait_blob IS NOT NULL AS has_portrait, portrait_mime,
                 portrait_sha256, octet_length(portrait_blob) AS portrait_size,
                 version, created_at, updated_at
          FROM agent_profiles
          ORDER BY agent_id ASC
        `);
      const mapped = rows.map(mapProfile);
      profiles.clear();
      for (const profile of mapped) remember(profile);
      return mapped;
    },
    async get(agentId) {
      const rows = await optionalProfileRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT agent_id, name, atom_contexts, default_preset, aliases,
                 portrait_blob IS NOT NULL AS has_portrait, portrait_mime,
                 portrait_sha256, octet_length(portrait_blob) AS portrait_size,
                 version, created_at, updated_at
          FROM agent_profiles WHERE agent_id = ${agentId} LIMIT 1
        `);
      if (!rows[0]) {
        profiles.delete(agentId);
        return null;
      }
      return remember(mapProfile(rows[0]));
    },
    async put(input) {
      const rows = input.expectedVersion === null
        ? await insertProfile(sqlResolver, input)
        : await updateProfile(sqlResolver, input);
      if (!rows[0]) throw new AgentProfileVersionConflictError(input.agentId);
      return remember(mapProfile(rows[0]));
    },
    async delete(agentId, expectedVersion) {
      const rows = await (await sqlResolver.resolveSql())`
        DELETE FROM agent_profiles
        WHERE agent_id = ${agentId} AND version = ${expectedVersion}
        RETURNING agent_id
      `;
      if (rows[0]) {
        profiles.delete(agentId);
        return true;
      }
      const existing = await this.get(agentId);
      if (existing !== null) throw new AgentProfileVersionConflictError(agentId);
      return false;
    },
    async getPortrait(agentId) {
      const rows = await optionalProfileRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT portrait_blob, portrait_mime, portrait_sha256, version
          FROM agent_profiles
          WHERE agent_id = ${agentId} AND portrait_blob IS NOT NULL
          LIMIT 1
        `);
      return rows[0] ? mapPortrait(rows[0]) : null;
    },
    async putPortrait(input) {
      const rows = await updatePortrait(sqlResolver, input);
      if (!rows[0]) throw new AgentProfileVersionConflictError(input.agentId);
      return remember(mapProfile(rows[0]));
    },
    async deletePortrait(agentId, expectedVersion) {
      const rows = await updatePortrait(sqlResolver, {
        agentId,
        body: null,
        mime: null,
        sha256: null,
        expectedVersion,
      });
      if (rows[0]) return remember(mapProfile(rows[0]));
      const existing = await this.get(agentId);
      if (existing !== null) throw new AgentProfileVersionConflictError(agentId);
      return null;
    },
  };
  return repository;
}

async function optionalProfileRead(
  read: () => Promise<readonly Record<string, unknown>[]>,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return await read();
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

function isUndefinedTable(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "42P01";
}

async function insertProfile(sqlResolver: LiveDbSqlResolver, input: AgentProfileWrite) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    INSERT INTO agent_profiles (agent_id, name, atom_contexts, default_preset, aliases)
    VALUES (${input.agentId}, ${input.name}, ${sql.json(input.atomContexts)},
            ${input.defaultPreset}, ${sql.json(input.aliases)})
    ON CONFLICT (agent_id) DO NOTHING
    RETURNING agent_id, name, atom_contexts, default_preset, aliases,
              portrait_blob IS NOT NULL AS has_portrait, portrait_mime,
              portrait_sha256, octet_length(portrait_blob) AS portrait_size,
              version, created_at, updated_at
  `;
}

async function updateProfile(sqlResolver: LiveDbSqlResolver, input: AgentProfileWrite) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    UPDATE agent_profiles
    SET name = ${input.name}, atom_contexts = ${sql.json(input.atomContexts)},
        default_preset = ${input.defaultPreset}, aliases = ${sql.json(input.aliases)},
        version = version + 1, updated_at = NOW()
    WHERE agent_id = ${input.agentId} AND version = ${input.expectedVersion}
    RETURNING agent_id, name, atom_contexts, default_preset, aliases,
              portrait_blob IS NOT NULL AS has_portrait, portrait_mime,
              portrait_sha256, octet_length(portrait_blob) AS portrait_size,
              version, created_at, updated_at
  `;
}

type NullablePortraitWrite = Omit<AgentPortraitWrite, "body" | "mime" | "sha256"> & {
  readonly body: Buffer | null;
  readonly mime: SupportedPortraitMime | null;
  readonly sha256: string | null;
};

async function updatePortrait(
  sqlResolver: LiveDbSqlResolver,
  input: AgentPortraitWrite | NullablePortraitWrite,
) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    UPDATE agent_profiles
    SET portrait_blob = ${input.body}, portrait_mime = ${input.mime},
        portrait_sha256 = ${input.sha256}, version = version + 1, updated_at = NOW()
    WHERE agent_id = ${input.agentId} AND version = ${input.expectedVersion}
    RETURNING agent_id, name, atom_contexts, default_preset, aliases,
              portrait_blob IS NOT NULL AS has_portrait, portrait_mime,
              portrait_sha256, octet_length(portrait_blob) AS portrait_size,
              version, created_at, updated_at
  `;
}

function mapProfile(row: Record<string, unknown>): AgentProfileRecord {
  return {
    agentId: String(row.agent_id),
    name: String(row.name),
    atomContexts: arrayValue(row.atom_contexts) as AgentProfileRecord["atomContexts"],
    defaultPreset: typeof row.default_preset === "string" ? row.default_preset : null,
    aliases: arrayValue(row.aliases) as AgentProfileRecord["aliases"],
    hasPortrait: row.has_portrait === true,
    portrait: row.has_portrait === true
      ? {
          mime: row.portrait_mime as SupportedPortraitMime,
          size: Number(row.portrait_size),
          sha256: String(row.portrait_sha256),
        }
      : null,
    version: Number(row.version),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapPortrait(row: Record<string, unknown>): AgentPortraitRecord {
  return {
    body: Buffer.isBuffer(row.portrait_blob)
      ? row.portrait_blob
      : Buffer.from(row.portrait_blob as Uint8Array),
    mime: row.portrait_mime as SupportedPortraitMime,
    sha256: String(row.portrait_sha256),
    version: Number(row.version),
  };
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value) as unknown[];
  return [];
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
