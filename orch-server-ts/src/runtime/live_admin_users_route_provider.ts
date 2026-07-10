import {
  AdminUsersRouteError,
  type AdminDashboardUser,
  type AdminUsersRouteProvider,
} from "../admin/admin_users_routes.js";
import type {
  DashboardUserRecord,
  DashboardUserRepository,
} from "./live_dashboard_access_provider.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type LiveAdminUsersRepository = DashboardUserRepository & Pick<
  AdminUsersRouteProvider,
  "listUsers" | "createUser" | "updateUser" | "deleteUser" | "canRemoveAdmin"
>;

export type CreateLiveAdminUsersRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

export type CreateLiveAdminUsersRouteProviderOptions = {
  readonly repository: LiveAdminUsersRepository;
  readonly currentEmail: AdminUsersRouteProvider["currentEmail"];
  readonly isAdminEmail: AdminUsersRouteProvider["isAdminEmail"];
  readonly listFolders: AdminUsersRouteProvider["listFolders"];
  readonly broadcastAccessChange: AdminUsersRouteProvider["broadcastAccessChange"];
};

export function createLiveAdminUsersRepository(
  options: CreateLiveAdminUsersRepositoryOptions,
): LiveAdminUsersRepository {
  async function findAdminUser(email: string): Promise<AdminDashboardUser | null> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    const rows = await (await options.sqlResolver.resolveSql())`
      SELECT email, display_name, is_admin, allowed_folder_ids, created_at, created_by
      FROM users
      WHERE email = ${normalizedEmail}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : adminUserFromRow(rows[0]);
  }

  return {
    async findUserByEmail(email) {
      const user = await findAdminUser(email);
      return user === null ? null : dashboardUserFromAdminUser(user);
    },
    async listUsers() {
      const rows = await (await options.sqlResolver.resolveSql())`
        SELECT email, display_name, is_admin, allowed_folder_ids, created_at, created_by
        FROM users
        ORDER BY email
      `;
      return rows.map(adminUserFromRow);
    },
    async createUser(input) {
      try {
        const rows = await (await options.sqlResolver.resolveSql())`
          INSERT INTO users (email, display_name, is_admin, allowed_folder_ids, created_by)
          VALUES (
            ${normalizeEmail(input.email)},
            ${cleanDisplayName(input.displayName)},
            ${input.isAdmin},
            ${normalizeFolderIds(input.allowedFolderIds)}::TEXT[],
            ${normalizeEmail(input.createdBy)}
          )
          RETURNING email, display_name, is_admin, allowed_folder_ids, created_at, created_by
        `;
        return requiredAdminUser(rows[0], "user create did not return a row");
      } catch (error) {
        if (postgresErrorCode(error) === "23505") {
          throw new AdminUsersRouteError(
            "USER_VALIDATION",
            "User already exists",
            400,
          );
        }
        throw error;
      }
    },
    async updateUser(email, update) {
      const existing = await findAdminUser(email);
      if (existing === null) throw userNotFoundError();
      const displayName = update.displayName === undefined
        ? existing.displayName
        : cleanDisplayName(update.displayName);
      const isAdmin = update.isAdmin === undefined
        ? existing.isAdmin
        : update.isAdmin === true;
      const allowedFolderIds = update.allowedFolderIds === undefined
        ? existing.allowedFolderIds
        : normalizeFolderIds(update.allowedFolderIds ?? []);
      const rows = await (await options.sqlResolver.resolveSql())`
        UPDATE users
        SET display_name = ${displayName},
            is_admin = ${isAdmin},
            allowed_folder_ids = ${allowedFolderIds}::TEXT[]
        WHERE email = ${existing.email}
        RETURNING email, display_name, is_admin, allowed_folder_ids, created_at, created_by
      `;
      if (rows[0] === undefined) throw userNotFoundError();
      return adminUserFromRow(rows[0]);
    },
    async deleteUser(email) {
      const rows = await (await options.sqlResolver.resolveSql())`
        DELETE FROM users
        WHERE email = ${normalizeEmail(email)}
        RETURNING email
      `;
      if (rows[0] === undefined) throw userNotFoundError();
    },
    async canRemoveAdmin(email) {
      const rows = await (await options.sqlResolver.resolveSql())`
        SELECT COUNT(*) AS count
        FROM users
        WHERE is_admin = TRUE AND email <> ${normalizeEmail(email)}
      `;
      return numberValue(rows[0]?.count) >= 1;
    },
  };
}

export function createLiveAdminUsersRouteProvider(
  options: CreateLiveAdminUsersRouteProviderOptions,
): AdminUsersRouteProvider {
  return {
    currentEmail: options.currentEmail,
    isAdminEmail: options.isAdminEmail,
    listUsers: options.repository.listUsers,
    listFolders: options.listFolders,
    createUser: options.repository.createUser,
    updateUser: options.repository.updateUser,
    deleteUser: options.repository.deleteUser,
    canRemoveAdmin: options.repository.canRemoveAdmin,
    broadcastAccessChange: options.broadcastAccessChange,
  };
}

function adminUserFromRow(row: Record<string, unknown>): AdminDashboardUser {
  return {
    email: normalizeEmail(row.email),
    displayName: stringOrNull(row.display_name ?? row.displayName),
    isAdmin: row.is_admin === true || row.isAdmin === true,
    allowedFolderIds: normalizeFolderIds(
      row.allowed_folder_ids ?? row.allowedFolderIds,
    ),
    createdAt: timestampString(row.created_at ?? row.createdAt),
    createdBy: stringOrNull(row.created_by ?? row.createdBy),
  };
}

function dashboardUserFromAdminUser(user: AdminDashboardUser): DashboardUserRecord {
  return {
    email: user.email,
    isAdmin: user.isAdmin,
    allowedFolderIds: [...user.allowedFolderIds],
  };
}

function requiredAdminUser(
  row: Record<string, unknown> | undefined,
  message: string,
): AdminDashboardUser {
  if (row === undefined) throw new Error(message);
  return adminUserFromRow(row);
}

function cleanDisplayName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeFolderIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const folderId = String(item).trim();
    if (!folderId || seen.has(folderId)) continue;
    seen.add(folderId);
    result.push(folderId);
  }
  return result;
}

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object" && "toISOString" in value) {
    const method = (value as { toISOString?: unknown }).toISOString;
    if (typeof method === "function") return String(method.call(value));
  }
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error("users.created_at must be a timestamp");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function userNotFoundError(): AdminUsersRouteError {
  return new AdminUsersRouteError("USER_NOT_FOUND", "User not found", 404);
}
