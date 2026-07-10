import type { PushRegistrationRepository } from "../push/push_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type CreateLivePushRegistrationRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

export function createLivePushRegistrationRepository(
  options: CreateLivePushRegistrationRepositoryOptions,
): PushRegistrationRepository {
  return {
    async upsertToken(email, deviceId, token) {
      const sql = await options.sqlResolver.resolveSql();
      await sql`
        INSERT INTO push_tokens (user_email, device_id, expo_token, updated_at)
        VALUES (${email}, ${deviceId}, ${token}, NOW())
        ON CONFLICT (user_email, device_id)
        DO UPDATE SET expo_token = EXCLUDED.expo_token, updated_at = NOW()
      `;
    },
    async deleteToken(email, deviceId) {
      const sql = await options.sqlResolver.resolveSql();
      await sql`
        DELETE FROM push_tokens
        WHERE user_email = ${email} AND device_id = ${deviceId}
      `;
    },
  };
}
