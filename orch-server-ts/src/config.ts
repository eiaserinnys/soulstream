import { z } from "zod";

import {
  USAGE_SUMMARY_PROVIDER_NAMES,
  type UsageSummarySharedAccountGroup,
} from "./usage/usage_summary_service.js";

export const DEFAULT_TRUSTED_PROXY = "loopback" as const;

const ConfigSchema = z
  .object({
    environment: z.string().min(1),
    databaseUrl: z.string().min(1),
    authBearerToken: z.string(),
    trustProxy: z.literal(DEFAULT_TRUSTED_PROXY).default(DEFAULT_TRUSTED_PROXY),
    r2_board_assets_access_key_id: z.string().optional(),
    r2_board_assets_secret_access_key: z.string().optional(),
    r2_board_assets_bucket: z.string().optional(),
    r2_board_assets_endpoint: z.string().optional(),
  })
  .strict();

export type OrchServerTsConfig = Omit<
  z.output<typeof ConfigSchema>,
  "trustProxy"
> & {
  readonly trustProxy?: typeof DEFAULT_TRUSTED_PROXY;
};

export type OrchServerEnvironmentConfig = {
  readonly node_name: string | null;
  readonly host: string;
  readonly port: number;
  readonly trusted_proxy: typeof DEFAULT_TRUSTED_PROXY;
  readonly database_url: string;
  readonly dashboard_dir: string;
  readonly dashboard_user_folder_access_configured: boolean;
  readonly r2_board_assets_access_key_id: string;
  readonly r2_board_assets_secret_access_key: string;
  readonly r2_board_assets_bucket: string;
  readonly r2_board_assets_endpoint: string;
  readonly atom_enabled: boolean;
  readonly atom_server_url: string;
  readonly atom_api_key: string;
  readonly atom_root_node_id: string | null;
  readonly auth_bearer_token: string;
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
  readonly model_catalog_path: string | null;
  readonly search_query_expansion_preset_id: string | null;
  readonly search_query_expansion_effort: string | null;
  readonly turn_summary_openai_key: string;
  readonly usage_summary_poll_interval_seconds: number;
  readonly usage_summary_shared_accounts: readonly UsageSummarySharedAccountGroup[];
  readonly soul_runner_process_enabled: boolean;
  readonly soul_runner_lease_timeout_ms: number;
};

export const ORCH_SERVER_ENVIRONMENT_VARIABLES = [
  "ENVIRONMENT",
  "CORS_ALLOWED_ORIGINS",
  "NODE_NAME",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "DASHBOARD_DIR",
  "R2_BOARD_ASSETS_ACCESS_KEY_ID",
  "R2_BOARD_ASSETS_SECRET_ACCESS_KEY",
  "R2_BOARD_ASSETS_BUCKET",
  "R2_BOARD_ASSETS_ENDPOINT",
  "ATOM_ENABLED",
  "ATOM_SERVER_URL",
  "ATOM_API_KEY",
  "ATOM_ROOT_NODE_ID",
  "AUTH_BEARER_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "GOOGLE_IOS_CLIENT_ID",
  "ALLOWED_EMAIL",
  "JWT_SECRET",
  "CLAUDE_OAUTH_CLIENT_ID",
  "CLAUDE_OAUTH_CALLBACK_URL",
  "MODEL_CATALOG_PATH",
  "SEARCH_QUERY_EXPANSION_PRESET_ID",
  "SEARCH_QUERY_EXPANSION_EFFORT",
  "TURN_SUMMARY_OPENAI_KEY",
  "USAGE_SUMMARY_POLL_INTERVAL_SECONDS",
  "USAGE_SUMMARY_SHARED_ACCOUNTS",
  "SOUL_RUNNER_PROCESS_ENABLED",
  "SOUL_RUNNER_LEASE_TIMEOUT_MS",
] as const;

export type OrchServerEnvironmentVariable =
  (typeof ORCH_SERVER_ENVIRONMENT_VARIABLES)[number];

export type EnvironmentSource = Readonly<
  Partial<Record<OrchServerEnvironmentVariable, string>> & {
    DASHBOARD_USER_FOLDER_ACCESS?: string;
  }
>;

export type EnvironmentConfigProvider = {
  readonly getConfig: () => Readonly<Record<string, unknown>>;
  readonly requireConfig: (key: string) => Promise<unknown>;
};

export const DEFAULT_ORCH_SERVER_PORT = 5200;
export const DEFAULT_USAGE_SUMMARY_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_SOUL_RUNNER_LEASE_TIMEOUT_MS = 1_800_000;

export function parseOrchServerConfig(input: unknown): OrchServerTsConfig {
  return ConfigSchema.parse(input);
}

// The production process environment is intentionally read only at this boundary.
export function loadOrchServerEnvironment(
  env: EnvironmentSource = process.env,
): OrchServerEnvironmentConfig {
  const environment = requiredString(env, "ENVIRONMENT");
  const isProduction = environment.toLowerCase() === "production";
  const corsAllowedOrigins = parseCorsOrigins(env.CORS_ALLOWED_ORIGINS);
  if (isProduction && corsAllowedOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must be set in production");
  }
  const authBearerToken = env.AUTH_BEARER_TOKEN ?? "";
  if (isProduction && authBearerToken.trim().length === 0) {
    throw new Error("AUTH_BEARER_TOKEN must be set in production");
  }
  return {
    node_name: optionalString(env.NODE_NAME),
    host: requiredString(env, "HOST"),
    port: parsePort(env.PORT),
    trusted_proxy: DEFAULT_TRUSTED_PROXY,
    database_url: requiredString(env, "DATABASE_URL"),
    dashboard_dir: env.DASHBOARD_DIR ?? "",
    dashboard_user_folder_access_configured:
      (env.DASHBOARD_USER_FOLDER_ACCESS?.trim() ?? "").length > 0,
    r2_board_assets_access_key_id: env.R2_BOARD_ASSETS_ACCESS_KEY_ID ?? "",
    r2_board_assets_secret_access_key: env.R2_BOARD_ASSETS_SECRET_ACCESS_KEY ?? "",
    r2_board_assets_bucket: env.R2_BOARD_ASSETS_BUCKET ?? "",
    r2_board_assets_endpoint: env.R2_BOARD_ASSETS_ENDPOINT ?? "",
    atom_enabled: parseBoolean(env.ATOM_ENABLED, "ATOM_ENABLED", false),
    atom_server_url: env.ATOM_SERVER_URL ?? "",
    atom_api_key: env.ATOM_API_KEY ?? "",
    atom_root_node_id: optionalString(env.ATOM_ROOT_NODE_ID),
    auth_bearer_token: authBearerToken,
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
    model_catalog_path: optionalString(env.MODEL_CATALOG_PATH),
    search_query_expansion_preset_id: optionalString(
      env.SEARCH_QUERY_EXPANSION_PRESET_ID,
    ),
    search_query_expansion_effort: optionalString(
      env.SEARCH_QUERY_EXPANSION_EFFORT,
    ),
    turn_summary_openai_key: env.TURN_SUMMARY_OPENAI_KEY ?? "",
    usage_summary_poll_interval_seconds: parsePositiveInteger(
      env.USAGE_SUMMARY_POLL_INTERVAL_SECONDS,
      "USAGE_SUMMARY_POLL_INTERVAL_SECONDS",
      DEFAULT_USAGE_SUMMARY_POLL_INTERVAL_SECONDS,
    ),
    usage_summary_shared_accounts: parseUsageSummarySharedAccounts(
      env.USAGE_SUMMARY_SHARED_ACCOUNTS,
    ),
    soul_runner_process_enabled: parseBoolean(
      env.SOUL_RUNNER_PROCESS_ENABLED,
      "SOUL_RUNNER_PROCESS_ENABLED",
      false,
    ),
    soul_runner_lease_timeout_ms: parsePositiveInteger(
      env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
      "SOUL_RUNNER_LEASE_TIMEOUT_MS",
      DEFAULT_SOUL_RUNNER_LEASE_TIMEOUT_MS,
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

function requiredString(env: EnvironmentSource, key: OrchServerEnvironmentVariable): string {
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
  key: OrchServerEnvironmentVariable,
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

function parseUsageSummarySharedAccounts(
  value: string | undefined,
): UsageSummarySharedAccountGroup[] {
  const source = value?.trim() ?? "";
  if (source.length === 0) return [];
  const providers = new Set<string>(USAGE_SUMMARY_PROVIDER_NAMES);
  const memberships = new Set<string>();
  return source.split(";").map((rawGroup) => {
    const parts = rawGroup.split(":");
    if (parts.length !== 2) throw invalidUsageSummarySharedAccounts();
    const provider = parts[0]?.trim();
    if (provider === undefined || !providers.has(provider)) {
      throw invalidUsageSummarySharedAccounts();
    }
    const nodeIds = parts[1]?.split(",").map((nodeId) => nodeId.trim()) ?? [];
    if (nodeIds.length < 2 || nodeIds.some((nodeId) => nodeId.length === 0)) {
      throw invalidUsageSummarySharedAccounts();
    }
    if (new Set(nodeIds).size !== nodeIds.length) {
      throw invalidUsageSummarySharedAccounts();
    }
    for (const nodeId of nodeIds) {
      const membership = `${provider}:${nodeId}`;
      if (memberships.has(membership)) throw invalidUsageSummarySharedAccounts();
      memberships.add(membership);
    }
    return {
      provider: provider as UsageSummarySharedAccountGroup["provider"],
      nodeIds,
    };
  });
}

function invalidUsageSummarySharedAccounts(): Error {
  return new Error(
    "USAGE_SUMMARY_SHARED_ACCOUNTS must contain semicolon-separated " +
    "provider:node-a,node-b groups for claude, codex, or gemini",
  );
}

function parseBoolean(
  value: string | undefined,
  key: OrchServerEnvironmentVariable,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${key} must be one of true/false, 1/0, yes/no, on/off`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
