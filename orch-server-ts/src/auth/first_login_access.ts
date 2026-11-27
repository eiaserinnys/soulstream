import { resolveDashboardLoginMode } from "./login_mode.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";

export const LOCAL_OWNER_EMAIL = "owner@local";
export const LOCAL_OWNER_NAME = "Owner";

export type EnsureLocalOwner = () => Promise<void>;

type LoginSettings = {
  readonly environment: string;
  readonly google_client_id?: string;
  readonly dashboard_admin_password?: string;
  readonly tailscale_auth_enabled?: boolean;
};

const NO_LOGIN_WARNING =
  "로그인 방식이 없어 운영 대시보드에 로그인할 수 없습니다. 비밀번호(DASHBOARD_ADMIN_PASSWORD와 JWT_SECRET), " +
  "Google(GOOGLE_CLIENT_ID), Tailscale(TAILSCALE_AUTH_ENABLED) 중 하나를 설정하세요.";

export function isDevelopmentEnvironment(environment: string): boolean {
  const name = environment.toLowerCase();
  return name === "development" || name === "dev";
}

/** Same row the installer writes; an existing row keeps its admin flag and folder access. */
export function createLocalOwnerEnsurer(
  options: Pick<LiveDbSqlResolver, "resolveSql">,
): EnsureLocalOwner {
  return async () => {
    const sql = await options.resolveSql();
    await sql`INSERT INTO users (email, display_name, is_admin) VALUES (${LOCAL_OWNER_EMAIL}, ${LOCAL_OWNER_NAME}, TRUE) ON CONFLICT (email) DO NOTHING`;
  };
}

export function warnWhenProductionHasNoLogin(
  settings: LoginSettings,
  warn: (message: string) => void,
): void {
  if (isDevelopmentEnvironment(settings.environment)) return;
  if (resolveDashboardLoginMode(settings) !== "none") return;
  warn(NO_LOGIN_WARNING);
}

/**
 * A development orchestrator with no login mode and no service token lets every
 * tokenless request through (service bearer development bypass). Those requests
 * act as the local owner.
 */
export function isDevelopmentNoLoginRequest(
  snapshot: Readonly<Record<string, unknown>>,
  headers: { readonly authorization?: string | string[] | undefined },
): boolean {
  if (headers.authorization !== undefined) return false;
  if (typeof snapshot.environment !== "string" || !isDevelopmentEnvironment(snapshot.environment)) return false;
  if (typeof snapshot.auth_bearer_token === "string" && snapshot.auth_bearer_token.length > 0) return false;
  return resolveDashboardLoginMode({
    google_client_id: stringOrEmpty(snapshot.google_client_id),
    dashboard_admin_password: stringOrEmpty(snapshot.dashboard_admin_password),
    tailscale_auth_enabled: snapshot.tailscale_auth_enabled === true,
  }) === "none";
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
