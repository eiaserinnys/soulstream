import {
  UserPreferencesForeignKeyViolationError,
  type UserPreferencesRecord,
  type UserPreferencesRepository,
} from "../user/user_preferences_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type CreateLiveUserPreferencesRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

export function createLiveUserPreferencesRepository(
  options: CreateLiveUserPreferencesRepositoryOptions,
): UserPreferencesRepository {
  return {
    async get(email) {
      const rows = await (await options.sqlResolver.resolveSql())`
        SELECT email, prefs, background_blob, background_mime, updated_at
        FROM user_preferences
        WHERE email = ${email}
      `;
      return (rows[0] as UserPreferencesRecord | undefined) ?? null;
    },
    async put(email, prefs, putOptions) {
      try {
        const clearBackground = putOptions.clearBackground;
        const rows = await (await options.sqlResolver.resolveSql())`
          INSERT INTO user_preferences (email, prefs, background_blob, background_mime, updated_at)
          VALUES (${email}, ${JSON.stringify(prefs)}::jsonb, NULL, NULL, NOW())
          ON CONFLICT (email) DO UPDATE SET
            prefs = EXCLUDED.prefs,
            background_blob = CASE
              WHEN ${clearBackground} THEN NULL
              ELSE user_preferences.background_blob
            END,
            background_mime = CASE
              WHEN ${clearBackground} THEN NULL
              ELSE user_preferences.background_mime
            END,
            updated_at = NOW()
          RETURNING email, prefs, background_blob, background_mime, updated_at
        `;
        const row = rows[0] as UserPreferencesRecord | undefined;
        if (row === undefined) {
          throw new Error("user preferences upsert did not return a row");
        }
        return row;
      } catch (error) {
        if (postgresErrorCode(error) === "23503") {
          throw new UserPreferencesForeignKeyViolationError(errorMessage(error));
        }
        throw error;
      }
    },
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "user preferences foreign key violation";
}
