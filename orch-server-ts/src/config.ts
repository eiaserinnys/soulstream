import { z } from "zod";
import { resolveDashboardLoginMode } from "./auth/login_mode.js";
import { loadExternalIngressEnvironment, EXTERNAL_INGRESS_ENVIRONMENT_VARIABLES, type ExternalIngressEnvironmentConfig } from "./config_external_ingress.js";
import { DEFAULT_DOMAIN_CATALOG_NODE_ID, DEFAULT_SKILL_CATALOG_NODE_ID } from "./skills/skill_catalog.js";

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

export type OrchServerEnvironmentConfig = Partial<ExternalIngressEnvironmentConfig> & {
  readonly node_name: string | null;
  readonly default_execution_node_id: string;
  readonly default_pas_agent_id: string | null;
  readonly host: string;
  readonly port: number;
  readonly trusted_proxy: typeof DEFAULT_TRUSTED_PROXY;
  readonly database_url: string;
  readonly dashboard_dir: string;
  readonly soulstream_public_url: string;
  readonly dashboard_user_folder_access_configured: boolean;
  readonly atom_enabled: boolean;
  readonly atom_server_url: string;
  readonly atom_public_url?: string;
  readonly atom_api_key: string;
  readonly atom_root_node_id: string | null;
  readonly skill_catalog_node_id: string;
  readonly domain_catalog_node_id: string;
  readonly auth_bearer_token: string;
  readonly cors_allowed_origins: readonly string[];
  readonly google_client_id: string;
  readonly google_client_secret: string;
  readonly google_callback_url: string;
  readonly google_ios_client_id: string;
  readonly allowed_email: string;
  readonly jwt_secret: string;
  readonly dashboard_admin_password: string;
  readonly tailscale_auth_enabled?: boolean;
  readonly tailscale_allowed_login?: string;
  readonly environment: string;
  readonly claude_oauth_client_id: string;
  readonly claude_oauth_callback_url: string;
  readonly codex_cli_path: string | null;
  readonly antigravity_cli_path: string | null;
  readonly typesafe_api_key: string;
  readonly turn_summary_openai_key: string;
  readonly usage_summary_poll_interval_seconds: number;
  readonly usage_summary_shared_accounts: readonly UsageSummarySharedAccountGroup[];
  readonly soul_runner_process_enabled: boolean;
  readonly soul_runner_lease_timeout_ms: number;
  readonly portable_node_releases_dir: string | null;
};

export const ORCH_SERVER_ENVIRONMENT_VARIABLES = [
  ...EXTERNAL_INGRESS_ENVIRONMENT_VARIABLES,
  "ENVIRONMENT",
  "CORS_ALLOWED_ORIGINS",
  "NODE_NAME",
  "DEFAULT_EXECUTION_NODE_ID",
  "DEFAULT_PAS_AGENT_ID",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "DASHBOARD_DIR",
  "SOULSTREAM_PUBLIC_URL",
  "ATOM_ENABLED",
  "ATOM_SERVER_URL",
  "ATOM_PUBLIC_URL",
  "ATOM_API_KEY",
  "ATOM_ROOT_NODE_ID",
  "SKILL_CATALOG_NODE_ID",
  "DOMAIN_CATALOG_NODE_ID",
  "AUTH_BEARER_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "GOOGLE_IOS_CLIENT_ID",
  "ALLOWED_EMAIL",
  "JWT_SECRET",
  "DASHBOARD_ADMIN_PASSWORD",
  "TAILSCALE_AUTH_ENABLED",
  "TAILSCALE_ALLOWED_LOGIN",
  "CLAUDE_OAUTH_CLIENT_ID",
  "CLAUDE_OAUTH_CALLBACK_URL",
  "CODEX_CLI_PATH",
  "AGY_CLI_PATH",
  "TYPESAFE_API_KEY",
  "TURN_SUMMARY_OPENAI_KEY",
  "USAGE_SUMMARY_POLL_INTERVAL_SECONDS",
  "USAGE_SUMMARY_SHARED_ACCOUNTS",
  "SOUL_RUNNER_PROCESS_ENABLED",
  "SOUL_RUNNER_LEASE_TIMEOUT_MS",
  "PORTABLE_NODE_RELEASES_DIR",
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

/**
 * Node that runs cards, conversations, and persistent sessions that name no node.
 * It is separate from NODE_NAME, which labels the external MCP ingress caller.
 * This is the only place the legacy central node value lives in the orchestrator.
 */
export const DEFAULT_EXECUTION_NODE_ID = "eiaserinnys";

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
  const environment = requiredEnvString(env, "ENVIRONMENT");
  const isProduction = environment.toLowerCase() === "production";
  const corsAllowedOrigins = parseCorsOrigins(env.CORS_ALLOWED_ORIGINS);
  if (isProduction && corsAllowedOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must be set in production");
  }
  const authBearerToken = env.AUTH_BEARER_TOKEN ?? "";
  if (isProduction && authBearerToken.trim().length === 0) {
    throw new Error("AUTH_BEARER_TOKEN must be set in production");
  }
  const googleClientId = env.GOOGLE_CLIENT_ID ?? "";
  const dashboardAdminPassword = env.DASHBOARD_ADMIN_PASSWORD ?? "";
  const jwtSecret = env.JWT_SECRET ?? "";
  const tailscaleEnabled = parseBoolean(env.TAILSCALE_AUTH_ENABLED, "TAILSCALE_AUTH_ENABLED", false);
  const tailscaleMode = !googleClientId && tailscaleEnabled;
  const tailscaleLogin = (env.TAILSCALE_ALLOWED_LOGIN ?? "").trim().toLowerCase();
  const host = requiredEnvString(env, "HOST");
  if (tailscaleMode && (!tailscaleLogin || /\s/.test(tailscaleLogin))) {
    throw new Error("TAILSCALE_ALLOWED_LOGIN must be a non-empty login without whitespace");
  }
  if (tailscaleMode && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("HOST must be loopback in Tailscale mode");
  }
  if (
    resolveDashboardLoginMode({
      google_client_id: googleClientId,
      dashboard_admin_password: dashboardAdminPassword,
      tailscale_auth_enabled: tailscaleEnabled,
    }) === "password" &&
    jwtSecret.trim().length === 0
  ) {
    throw new Error(
      "JWT_SECRET must be set when DASHBOARD_ADMIN_PASSWORD enables password login",
    );
  }
  return {
    ...loadExternalIngressEnvironment(env),
    node_name: optionalString(env.NODE_NAME),
    default_execution_node_id:
      (env.DEFAULT_EXECUTION_NODE_ID?.trim() ?? "") || DEFAULT_EXECUTION_NODE_ID,
    default_pas_agent_id: optionalNonEmptyString(env.DEFAULT_PAS_AGENT_ID),
    host,
    port: parsePort(env.PORT),
    trusted_proxy: DEFAULT_TRUSTED_PROXY,
    database_url: requiredEnvString(env, "DATABASE_URL"),
    dashboard_dir: env.DASHBOARD_DIR ?? "",
    soulstream_public_url: publicOrigin(requiredEnvString(env, "SOULSTREAM_PUBLIC_URL")),
    dashboard_user_folder_access_configured:
      (env.DASHBOARD_USER_FOLDER_ACCESS?.trim() ?? "").length > 0,
    atom_enabled: parseBoolean(env.ATOM_ENABLED, "ATOM_ENABLED", false),
    atom_server_url: env.ATOM_SERVER_URL ?? "",
    ...(optionalNonEmptyString(env.ATOM_PUBLIC_URL) ? { atom_public_url: optionalNonEmptyString(env.ATOM_PUBLIC_URL) as string } : {}),
    atom_api_key: env.ATOM_API_KEY ?? "",
    atom_root_node_id: optionalString(env.ATOM_ROOT_NODE_ID),
    skill_catalog_node_id: env.SKILL_CATALOG_NODE_ID ?? DEFAULT_SKILL_CATALOG_NODE_ID,
    domain_catalog_node_id: env.DOMAIN_CATALOG_NODE_ID ?? DEFAULT_DOMAIN_CATALOG_NODE_ID,
    auth_bearer_token: authBearerToken,
    cors_allowed_origins: corsAllowedOrigins,
    google_client_id: googleClientId,
    google_client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    google_callback_url: env.GOOGLE_CALLBACK_URL ?? "",
    google_ios_client_id: env.GOOGLE_IOS_CLIENT_ID ?? "",
    allowed_email: env.ALLOWED_EMAIL ?? "",
    jwt_secret: jwtSecret,
    dashboard_admin_password: dashboardAdminPassword,
    ...(tailscaleMode ? { tailscale_auth_enabled: true, tailscale_allowed_login: tailscaleLogin } : {}),
    environment,
    claude_oauth_client_id: env.CLAUDE_OAUTH_CLIENT_ID ?? "",
    claude_oauth_callback_url: env.CLAUDE_OAUTH_CALLBACK_URL ?? "",
    codex_cli_path: optionalString(env.CODEX_CLI_PATH),
    antigravity_cli_path: optionalString(env.AGY_CLI_PATH),
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
    portable_node_releases_dir: optionalString(env.PORTABLE_NODE_RELEASES_DIR),
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

function requiredEnvString(env: EnvironmentSource, key: OrchServerEnvironmentVariable): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function publicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("SOULSTREAM_PUBLIC_URL must be an absolute HTTP origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SOULSTREAM_PUBLIC_URL must be an absolute HTTP origin");
  }
  return url.origin;
}

function optionalString(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function optionalNonEmptyString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
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
    "provider:node-a,node-b groups for claude, codex, or antigravity",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
