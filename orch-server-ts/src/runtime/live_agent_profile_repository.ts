import { type AgentProfileRecord, type AgentProfileRepository, type AgentProfileWrite, AgentProfileVersionConflictError } from "../node/agent_profile_routes.js";
import type { AgentPortraitRepository } from "../node/agent_portrait_model.js";
import { optionalRead, type LiveDbSqlResolver } from "./live_db_sql.js";

/** 프로필 행의 portrait_* 칸은 읽지 않는다. 초상 유무와 메타는 중앙 초상 저장소의 메모리 목록에서 붙인다. */
export function createLiveAgentProfileRepository(
  sqlResolver: LiveDbSqlResolver,
  portraits: Pick<AgentPortraitRepository, "ready" | "summary">,
): AgentProfileRepository {
  const profiles = new Map<string, AgentProfileRecord>();
  const withPortrait = (profile: AgentProfileRecord): AgentProfileRecord => {
    const summary = portraits.summary(profile.agentId);
    return {
      ...profile,
      hasPortrait: summary !== null,
      portrait: summary === null
        ? null
        : { mime: summary.mime, size: summary.byteSize, sha256: summary.sha256 },
    };
  };
  const remember = (profile: AgentProfileRecord): AgentProfileRecord => {
    profiles.set(profile.agentId, profile);
    return profile;
  };
  const repository: AgentProfileRepository = {
    snapshot() {
      return [...profiles.values()]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map(withPortrait);
    },
    async list() {
      await portraits.ready();
      const rows = await optionalRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT agent_id, name, context_bundles, atom_contexts, default_preset, aliases,
                 version, created_at, updated_at
          FROM agent_profiles
          ORDER BY agent_id ASC
        `);
      const mapped = rows.map(mapProfile);
      profiles.clear();
      for (const profile of mapped) remember(profile);
      return mapped.map(withPortrait);
    },
    async get(agentId) {
      await portraits.ready();
      const rows = await optionalRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT agent_id, name, context_bundles, atom_contexts, default_preset, aliases,
                 version, created_at, updated_at
          FROM agent_profiles WHERE agent_id = ${agentId} LIMIT 1
        `);
      if (!rows[0]) {
        profiles.delete(agentId);
        return null;
      }
      return withPortrait(remember(mapProfile(rows[0])));
    },
    async put(input) {
      const rows = input.expectedVersion === null
        ? await insertProfile(sqlResolver, input)
        : await updateProfile(sqlResolver, input);
      if (!rows[0]) throw new AgentProfileVersionConflictError(input.agentId);
      await portraits.ready();
      return withPortrait(remember(mapProfile(rows[0])));
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
  };
  return repository;
}

async function insertProfile(sqlResolver: LiveDbSqlResolver, input: AgentProfileWrite) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    INSERT INTO agent_profiles (agent_id, name, context_bundles, atom_contexts, default_preset, aliases)
    VALUES (${input.agentId}, ${input.name}, ${sql.json(input.contextBundles)}, ${sql.json(input.atomContexts)},
            ${input.defaultPreset}, ${sql.json(input.aliases)})
    ON CONFLICT (agent_id) DO NOTHING
    RETURNING agent_id, name, context_bundles, atom_contexts, default_preset, aliases,
              version, created_at, updated_at
  `;
}

async function updateProfile(sqlResolver: LiveDbSqlResolver, input: AgentProfileWrite) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    UPDATE agent_profiles
    SET name = ${input.name}, context_bundles = ${sql.json(input.contextBundles)},
        atom_contexts = ${sql.json(input.atomContexts)},
        default_preset = ${input.defaultPreset}, aliases = ${sql.json(input.aliases)},
        version = version + 1, updated_at = NOW()
    WHERE agent_id = ${input.agentId} AND version = ${input.expectedVersion}
    RETURNING agent_id, name, context_bundles, atom_contexts, default_preset, aliases,
              version, created_at, updated_at
  `;
}

function mapProfile(row: Record<string, unknown>): AgentProfileRecord {
  return {
    agentId: String(row.agent_id),
    name: String(row.name),
    contextBundles: arrayValue(row.context_bundles) as AgentProfileRecord["contextBundles"],
    atomContexts: arrayValue(row.atom_contexts) as AgentProfileRecord["atomContexts"],
    defaultPreset: typeof row.default_preset === "string" ? row.default_preset : null,
    aliases: arrayValue(row.aliases) as AgentProfileRecord["aliases"],
    hasPortrait: false,
    portrait: null,
    version: Number(row.version),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
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
