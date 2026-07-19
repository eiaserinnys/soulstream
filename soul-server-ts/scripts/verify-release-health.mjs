#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import dotenv from "dotenv";
import postgres from "postgres";

import {
  deploymentEnvironmentPath,
  loadLegacyBackupContract,
  readDatabaseUrl,
} from "../../packages/db-schema/scripts/migration-contract.mjs";
import { readMigrationPlan } from "../../packages/db-schema/scripts/migrate.mjs";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for release health`);
  return value;
}

export function deriveOrchestratorHealthUrl(upstreamUrl) {
  const url = new URL(upstreamUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error("SOULSTREAM_UPSTREAM_URL must use ws:// or wss://");
  url.pathname = "/api/health";
  url.search = "";
  url.hash = "";
  return url;
}

function localBaseUrl(env) {
  const configuredHost = required(env, "HOST");
  const host = configuredHost === "0.0.0.0" || configuredHost === "::"
    ? "127.0.0.1"
    : configuredHost;
  return new URL(`http://${host}:${required(env, "PORT")}`);
}

async function fetchHealth(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.status !== "ok") throw new Error(`${url} did not report status=ok`);
  return body;
}

export async function readMcpHealth({ url, token, taskId }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  const client = new Client({ name: "soulstream-release-health", version: "1.0.0" });
  try {
    await client.connect(transport);
    await client.ping();
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    if (!names.has("get_task") || !names.has("list_my_turn_items")) {
      throw new Error("MCP canonical Task read tools are unavailable");
    }
    const tool = taskId ? "get_task" : "list_my_turn_items";
    const result = await client.callTool(taskId
      ? { name: tool, arguments: { task_id: taskId, view: "outline" } }
      : { name: tool, arguments: { limit: 1 } });
    if ("isError" in result && result.isError) {
      throw new Error(`MCP ${tool} returned an error result`);
    }
    return { ping: "ok", tool, task_id: taskId ?? null };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readDataHealth({ databaseUrl, taskId }) {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 5 });
  try {
    const plan = await readMigrationPlan(sql);
    if (plan.state !== "current" || plan.bootstrap.length > 0 || plan.pending.length > 0) {
      throw new Error("database migration ledger is not complete and current");
    }
    const rows = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM tasks) AS task_count,
        (SELECT COUNT(*)::int FROM markdown_documents) AS document_count,
        (SELECT COUNT(*)::int FROM schema_migrations) AS migration_count,
        EXISTS(SELECT 1 FROM tasks WHERE id = ${taskId}) AS task_exists
    `;
    const row = rows[0];
    if (taskId && !row?.task_exists) throw new Error(`canonical Task ${taskId} is missing`);
    const legacyBackup = await loadLegacyBackupContract();
    return {
      task_count: Number(row.task_count),
      document_count: Number(row.document_count),
      migration_count: Number(row.migration_count),
      task_id: taskId,
      legacy_task_tree_backup: {
        status: legacyBackup.status,
        stored_operations: legacyBackup.stored_operation_count,
        observed_operations: legacyBackup.observed_pre_drop_operation_count,
        missing_operations: legacyBackup.missing_operation_count,
      },
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function verifyReleaseHealth(
  {
    taskId,
    env = process.env,
    cwd = process.cwd(),
    fetchImpl = fetch,
    mcpRead = readMcpHealth,
    dataRead = readDataHealth,
  },
) {
  dotenv.config({
    path: deploymentEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  if (required(env, "MCP_ENABLED") !== "true") {
    throw new Error("MCP_ENABLED must be true for release health");
  }
  const base = localBaseUrl(env);
  const soulHealthUrl = new URL("/health", base);
  const mcpUrl = new URL(required(env, "MCP_PATH"), base);
  const orchHealthUrl = deriveOrchestratorHealthUrl(required(env, "SOULSTREAM_UPSTREAM_URL"));

  const [orchestrator, soul, mcp, data] = await Promise.all([
    fetchHealth(orchHealthUrl, fetchImpl),
    fetchHealth(soulHealthUrl, fetchImpl),
    mcpRead({ url: mcpUrl, token: env.AUTH_BEARER_TOKEN?.trim() ?? "", taskId }),
    dataRead({ databaseUrl: readDatabaseUrl(env), taskId }),
  ]);
  return {
    status: "ok",
    orchestrator: { url: orchHealthUrl.toString(), status: orchestrator.status },
    soul: { url: soulHealthUrl.toString(), status: soul.status },
    mcp,
    data,
  };
}

export function formatHealthError(error, env = process.env) {
  let text = error instanceof Error ? error.stack ?? error.message : String(error);
  for (const secret of [env.DATABASE_URL, env.AUTH_BEARER_TOKEN]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function taskIdArgument(argv) {
  const index = argv.indexOf("--task-id");
  return index >= 0 ? argv[index + 1] : null;
}

async function main() {
  try {
    const report = await verifyReleaseHealth({ taskId: taskIdArgument(process.argv.slice(2)) });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", message: formatHealthError(error) }));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
