import type { PushNotificationRepository } from "../push/push_notifier.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type CreateLivePushRegistrationRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

export function createLivePushRegistrationRepository(
  options: CreateLivePushRegistrationRepositoryOptions,
): PushNotificationRepository {
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
    async listTokens(email) {
      const sql = await options.sqlResolver.resolveSql();
      const rows = await sql`
        SELECT device_id, expo_token
        FROM push_tokens
        WHERE user_email = ${email}
      `;
      return rows.flatMap((row) => {
        const deviceId = stringValue(row.device_id ?? row.deviceId);
        const expoToken = stringValue(row.expo_token ?? row.expoToken);
        return deviceId && expoToken ? [{ deviceId, expoToken }] : [];
      });
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
