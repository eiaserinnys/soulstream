import { z } from "zod";
import { DEFAULT_SKILL_CATALOG_NODE_ID } from "./skills/skill_catalog.js";

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
  readonly atom_enabled: boolean;
  readonly atom_server_url: string;
  readonly atom_api_key: string;
  readonly atom_root_node_id: string | null;
  readonly skill_catalog_node_id: string;
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
  readonly codex_cli_path: string | null;
  readonly model_catalog_path: string | null;
  readonly typesafe_api_key: string;
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
  "ATOM_ENABLED",
  "ATOM_SERVER_URL",
  "ATOM_API_KEY",
  "ATOM_ROOT_NODE_ID",
  "SKILL_CATALOG_NODE_ID",
  "AUTH_BEARER_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "GOOGLE_IOS_CLIENT_ID",
  "ALLOWED_EMAIL",
  "JWT_SECRET",
  "CLAUDE_OAUTH_CLIENT_ID",
  "CLAUDE_OAUTH_CALLBACK_URL",
  "CODEX_CLI_PATH",
  "MODEL_CATALOG_PATH",
  "TYPESAFE_API_KEY",
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
    atom_enabled: parseBoolean(env.ATOM_ENABLED, "ATOM_ENABLED", false),
    atom_server_url: env.ATOM_SERVER_URL ?? "",
    atom_api_key: env.ATOM_API_KEY ?? "",
    atom_root_node_id: optionalString(env.ATOM_ROOT_NODE_ID),
    skill_catalog_node_id: env.SKILL_CATALOG_NODE_ID ?? DEFAULT_SKILL_CATALOG_NODE_ID,
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
    codex_cli_path: optionalString(env.CODEX_CLI_PATH),
    model_catalog_path: optionalString(env.MODEL_CATALOG_PATH),
    typesafe_api_key: env.TYPESAFE_API_KEY ?? "",
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
