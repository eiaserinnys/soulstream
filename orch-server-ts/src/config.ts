import { z } from "zod";

export const DEFAULT_TRUSTED_PROXY = "loopback" as const;

const ConfigSchema = z
  .object({
    environment: z.string().min(1),
    databaseUrl: z.string().min(1),
    authBearerToken: z.string(),
    boardYjsHostMode: z.enum(["node", "orch"]).default("node"),
    trustProxy: z.literal(DEFAULT_TRUSTED_PROXY).default(DEFAULT_TRUSTED_PROXY),
    r2_board_assets_access_key_id: z.string().optional(),
    r2_board_assets_secret_access_key: z.string().optional(),
    r2_board_assets_bucket: z.string().optional(),
    r2_board_assets_endpoint: z.string().optional(),
  })
  .strict();

export type OrchServerTsConfig = Omit<
  z.output<typeof ConfigSchema>,
  "boardYjsHostMode" | "trustProxy"
> & {
  readonly boardYjsHostMode?: "node" | "orch";
  readonly trustProxy?: typeof DEFAULT_TRUSTED_PROXY;
};

export type DashboardFolderAccessRule = {
  readonly restricted: boolean;
  readonly allowedFolderIds: readonly string[];
};

export type OrchServerEnvironmentConfig = {
  readonly node_name: string | null;
  readonly host: string;
  readonly port: number;
  readonly trusted_proxy: typeof DEFAULT_TRUSTED_PROXY;
  readonly database_url: string;
  readonly dashboard_dir: string;
  readonly dashboard_user_folder_access: Readonly<Record<string, DashboardFolderAccessRule>>;
  readonly r2_board_assets_access_key_id: string;
  readonly r2_board_assets_secret_access_key: string;
  readonly r2_board_assets_bucket: string;
  readonly r2_board_assets_endpoint: string;
  readonly atom_enabled: boolean;
  readonly atom_server_url: string;
  readonly atom_api_key: string;
  readonly atom_root_node_id: string | null;
  readonly auth_bearer_token: string;
  readonly board_yjs_host_mode: "node" | "orch";
  readonly cors_allowed_origins: readonly string[];
  readonly google_client_id: string;
  readonly google_client_secret: string;
  readonly google_callback_url: string;
  readonly google_ios_client_id: string;
  readonly allowed_email: string;
  readonly jwt_secret: string;
  readonly environment: string;
  readonly claude_oauth_client_id: string;
  readonly claude_oauth_callback_url: string;
  readonly usage_summary_poll_interval_seconds: number;
};

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type EnvironmentConfigProvider = {
  readonly getConfig: () => Readonly<Record<string, unknown>>;
  readonly requireConfig: (key: string) => Promise<unknown>;
};

export const DEFAULT_ORCH_SERVER_PORT = 5200;
export const DEFAULT_USAGE_SUMMARY_POLL_INTERVAL_SECONDS = 300;

export function parseOrchServerConfig(input: unknown): OrchServerTsConfig {
  return ConfigSchema.parse(input);
}

// The production process environment is intentionally read only at this boundary.
export function loadOrchServerEnvironment(
  env: EnvironmentSource = process.env,
): OrchServerEnvironmentConfig {
  const environment = requiredString(env, "ENVIRONMENT");
  const corsAllowedOrigins = parseCorsOrigins(env.CORS_ALLOWED_ORIGINS);
  if (environment.toLowerCase() === "production" && corsAllowedOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must be set in production");
  }
  return {
    node_name: optionalString(env.NODE_NAME),
    host: requiredString(env, "HOST"),
    port: parsePort(env.PORT),
    trusted_proxy: DEFAULT_TRUSTED_PROXY,
    database_url: requiredString(env, "DATABASE_URL"),
    dashboard_dir: env.DASHBOARD_DIR ?? "",
    dashboard_user_folder_access: parseDashboardFolderAccess(
      env.DASHBOARD_USER_FOLDER_ACCESS,
    ),
    r2_board_assets_access_key_id: env.R2_BOARD_ASSETS_ACCESS_KEY_ID ?? "",
    r2_board_assets_secret_access_key: env.R2_BOARD_ASSETS_SECRET_ACCESS_KEY ?? "",
    r2_board_assets_bucket: env.R2_BOARD_ASSETS_BUCKET ?? "",
    r2_board_assets_endpoint: env.R2_BOARD_ASSETS_ENDPOINT ?? "",
    atom_enabled: parseBoolean(env.ATOM_ENABLED, "ATOM_ENABLED", false),
    atom_server_url: env.ATOM_SERVER_URL ?? "",
    atom_api_key: env.ATOM_API_KEY ?? "",
    atom_root_node_id: optionalString(env.ATOM_ROOT_NODE_ID),
    auth_bearer_token: env.AUTH_BEARER_TOKEN ?? "",
    board_yjs_host_mode: parseBoardYjsHostMode(env.BOARD_YJS_HOST_MODE),
    cors_allowed_origins: corsAllowedOrigins,
    google_client_id: env.GOOGLE_CLIENT_ID ?? "",
    google_client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    google_callback_url: env.GOOGLE_CALLBACK_URL ?? "",
    google_ios_client_id: env.GOOGLE_IOS_CLIENT_ID ?? "",
    allowed_email: env.ALLOWED_EMAIL ?? "",
    jwt_secret: env.JWT_SECRET ?? "",
    environment,
    claude_oauth_client_id: requiredString(env, "CLAUDE_OAUTH_CLIENT_ID"),
    claude_oauth_callback_url: requiredString(env, "CLAUDE_OAUTH_CALLBACK_URL"),
    usage_summary_poll_interval_seconds: parsePositiveInteger(
      env.USAGE_SUMMARY_POLL_INTERVAL_SECONDS,
      "USAGE_SUMMARY_POLL_INTERVAL_SECONDS",
      DEFAULT_USAGE_SUMMARY_POLL_INTERVAL_SECONDS,
    ),
  };
}

export function toOrchServerTsConfig(
  config: OrchServerEnvironmentConfig,
): OrchServerTsConfig {
  return parseOrchServerConfig({
    environment: config.environment,
    databaseUrl: config.database_url,
    authBearerToken: config.auth_bearer_token,
    boardYjsHostMode: config.board_yjs_host_mode,
    trustProxy: config.trusted_proxy,
    r2_board_assets_access_key_id: config.r2_board_assets_access_key_id,
    r2_board_assets_secret_access_key: config.r2_board_assets_secret_access_key,
    r2_board_assets_bucket: config.r2_board_assets_bucket,
    r2_board_assets_endpoint: config.r2_board_assets_endpoint,
  });
}

export function createEnvironmentConfigProvider(
  config: OrchServerEnvironmentConfig,
): EnvironmentConfigProvider {
  const snapshot: Readonly<Record<string, unknown>> = Object.freeze({
    ...config,
    databaseUrl: config.database_url,
  });
  return {
    getConfig: () => snapshot,
    async requireConfig(key) {
      if (!(key in snapshot)) {
        throw new Error(`Required config is missing: ${key}`);
      }
      return snapshot[key];
    },
  };
}

function requiredString(env: EnvironmentSource, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_ORCH_SERVER_PORT;
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer between 0 and 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  return port;
}

function parsePositiveInteger(
  value: string | undefined,
  key: string,
  defaultValue: number,
): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  key: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${key} must be one of true/false, 1/0, yes/no, on/off`);
}

function parseBoardYjsHostMode(
  value: string | undefined,
): OrchServerEnvironmentConfig["board_yjs_host_mode"] {
  if (value === undefined || value.trim().length === 0) return "node";
  const normalized = value.trim().toLowerCase();
  if (normalized === "node" || normalized === "orch") return normalized;
  throw new Error("BOARD_YJS_HOST_MODE must be one of node/orch");
}

function parseCorsOrigins(value: string | undefined): string[] {
  const source = value?.trim() ?? "";
  if (source.length === 0) return [];
  if (!source.startsWith("[")) {
    return source.split(",").map((item) => item.trim()).filter(Boolean);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`CORS_ALLOWED_ORIGINS must be a JSON array or CSV: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("CORS_ALLOWED_ORIGINS JSON value must be an array of strings");
  }
  return parsed;
}

function parseDashboardFolderAccess(
  value: string | undefined,
): Record<string, DashboardFolderAccessRule> {
  const source = value?.trim() ?? "";
  if (source.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`DASHBOARD_USER_FOLDER_ACCESS must be valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("DASHBOARD_USER_FOLDER_ACCESS must be a JSON object");
  }

  const normalized: Record<string, DashboardFolderAccessRule> = {};
  for (const [rawEmail, rawRule] of Object.entries(parsed)) {
    const email = rawEmail.trim().toLowerCase();
    if (email.length === 0) {
      throw new Error("DASHBOARD_USER_FOLDER_ACCESS contains an empty email key");
    }
    normalized[email] = normalizeFolderAccessRule(rawRule);
  }
  return normalized;
}

function normalizeFolderAccessRule(rawRule: unknown): DashboardFolderAccessRule {
  if (Array.isArray(rawRule)) {
    return { restricted: true, allowedFolderIds: normalizeFolderIds(rawRule) };
  }
  if (!isRecord(rawRule)) {
    throw new Error(
      "DASHBOARD_USER_FOLDER_ACCESS values must be objects or folder-id arrays",
    );
  }
  const folderIds = rawRule.allowedFolderIds ?? rawRule.allowed_folder_ids ?? [];
  if (!Array.isArray(folderIds)) throw new Error("allowedFolderIds must be an array");
  return {
    restricted: Boolean(rawRule.restricted ?? true),
    allowedFolderIds: normalizeFolderIds(folderIds),
  };
}

function normalizeFolderIds(values: readonly unknown[]): string[] {
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
