import type {
  ContextBundleRecord,
  ContextBundleRepository,
  ContextBundleWrite,
} from "../node/context_bundle_routes.js";
import { ContextBundleVersionConflictError } from "../node/context_bundle_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export function createLiveContextBundleRepository(
  sqlResolver: LiveDbSqlResolver,
): ContextBundleRepository {
  return {
    async list() {
      const rows = await optionalBundleRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT bundle_id, description, atom_contexts, version, created_at, updated_at
          FROM context_bundles
          ORDER BY bundle_id ASC
        `);
      return rows.map(mapBundle);
    },
    async get(bundleId) {
      const rows = await optionalBundleRead(async () =>
        (await sqlResolver.resolveSql())`
          SELECT bundle_id, description, atom_contexts, version, created_at, updated_at
          FROM context_bundles
          WHERE bundle_id = ${bundleId}
          LIMIT 1
        `);
      return rows[0] ? mapBundle(rows[0]) : null;
    },
    async put(input) {
      const rows = input.expectedVersion === null
        ? await insertBundle(sqlResolver, input)
        : await updateBundle(sqlResolver, input);
      if (!rows[0]) throw new ContextBundleVersionConflictError(input.bundleId);
      return mapBundle(rows[0]);
    },
    async delete(bundleId, expectedVersion) {
      const rows = await (await sqlResolver.resolveSql())`
        DELETE FROM context_bundles
        WHERE bundle_id = ${bundleId} AND version = ${expectedVersion}
        RETURNING bundle_id
      `;
      if (rows[0]) return true;
      if (await this.get(bundleId) !== null) {
        throw new ContextBundleVersionConflictError(bundleId);
      }
      return false;
    },
  };
}

async function optionalBundleRead(
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

async function insertBundle(sqlResolver: LiveDbSqlResolver, input: ContextBundleWrite) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    INSERT INTO context_bundles (bundle_id, description, atom_contexts)
    VALUES (${input.bundleId}, ${input.description}, ${sql.json(input.atomContexts)})
    ON CONFLICT (bundle_id) DO NOTHING
    RETURNING bundle_id, description, atom_contexts, version, created_at, updated_at
  `;
}

async function updateBundle(sqlResolver: LiveDbSqlResolver, input: ContextBundleWrite) {
  const sql = await sqlResolver.resolveSql();
  return sql`
    UPDATE context_bundles
    SET description = ${input.description}, atom_contexts = ${sql.json(input.atomContexts)},
        version = version + 1, updated_at = NOW()
    WHERE bundle_id = ${input.bundleId} AND version = ${input.expectedVersion}
    RETURNING bundle_id, description, atom_contexts, version, created_at, updated_at
  `;
}

function mapBundle(row: Record<string, unknown>): ContextBundleRecord {
  return {
    bundleId: String(row.bundle_id),
    description: String(row.description ?? ""),
    atomContexts: arrayValue(row.atom_contexts) as ContextBundleRecord["atomContexts"],
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
