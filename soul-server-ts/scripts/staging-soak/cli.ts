import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildServiceEnvironments,
  resolveSoakConfig,
  type ResolvedSoakConfig,
  type SoakConfigFile,
} from "./config.js";
import { prepareStagingDatabase, stagingDatabaseUrl } from "./database.js";
import { SoakProcessController } from "./process_controller.js";
import { runSoakWorkload } from "./workload.js";
import { assertPreparedWorkspace, prepareSoakWorkspace } from "./workspace.js";

const APPROVAL_ARGUMENT = "--confirm-staging-only";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

await main();

async function main(): Promise<void> {
  const command = process.argv[2];
  const configPath = argumentValue("--config");
  if (!command || !configPath) usage();
  const config = await loadConfig(configPath);

  if (command === "doctor") {
    const secrets = resolveInputSecrets(config, false);
    await access(secrets.sourceClaudeAuthTokenPath);
    await access(resolve(secrets.sourceCodexHomePath, "auth.json"));
    await assertBuildArtifacts(config);
    report({ status: "ok", command, isolation: isolationSummary(config) });
    return;
  }
  if (command === "stop") {
    const controller = new SoakProcessController(config, { orch: {}, soul: {} });
    await controller.stopAll();
    report({ status: "ok", command });
    return;
  }

  requireApproval();
  const secrets = resolveInputSecrets(config, true);
  if (command === "prepare") {
    await prepareSoakWorkspace(
      config,
      secrets.sourceClaudeAuthTokenPath,
      secrets.sourceCodexHomePath,
    );
    const prepared = await prepareStagingDatabase(config, secrets.databaseAdminUrl);
    report({
      status: "ok",
      command,
      database: { name: config.databaseName, created: prepared.created, migration: prepared.migrationMode },
      isolation: isolationSummary(config),
    });
    return;
  }

  await assertPreparedWorkspace(config);
  await assertBuildArtifacts(config);
  const environments = buildServiceEnvironments(config, {
    databaseUrl: stagingDatabaseUrl(secrets.databaseAdminUrl, config.databaseName),
    authBearerToken: secrets.authBearerToken,
    claudeAuthTokenPath: config.paths.claudeAuthToken,
    codexHomePath: config.paths.codexHome,
  });
  const controller = new SoakProcessController(config, environments);
  if (command === "start") {
    await controller.startAll();
    report({ status: "ok", command, isolation: isolationSummary(config) });
    return;
  }
  if (command === "restart-soul") {
    await controller.restartSoul();
    report({ status: "ok", command });
    return;
  }
  if (command === "run") {
    const backend = argumentValue("--backend") ?? "claude";
    if (backend !== "claude" && backend !== "codex") {
      throw new Error("--backend must be claude or codex");
    }
    const result = await runSoakWorkload({
      config,
      bearerToken: secrets.authBearerToken,
      controller,
      backend,
    });
    report({ status: "ok", command, result });
    return;
  }
  usage();
}

async function loadConfig(path: string): Promise<ResolvedSoakConfig> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as SoakConfigFile;
  return resolveSoakConfig(parsed, repositoryRoot);
}

function resolveInputSecrets(config: ResolvedSoakConfig, requireAuth: boolean): {
  databaseAdminUrl: string;
  authBearerToken: string;
  sourceClaudeAuthTokenPath: string;
  sourceCodexHomePath: string;
} {
  const databaseAdminUrl = requiredEnv(config.databaseAdminUrlEnv);
  const sourceClaudeAuthTokenPath = requiredEnv(config.claudeAuthTokenPathEnv);
  const sourceCodexHomePath = requiredEnv(config.codexHomePathEnv);
  const authBearerToken = requireAuth ? requiredEnv(config.authBearerTokenEnv) :
    process.env[config.authBearerTokenEnv]?.trim() ?? "doctor-not-used";
  stagingDatabaseUrl(databaseAdminUrl, config.databaseName);
  return {
    databaseAdminUrl,
    authBearerToken,
    sourceClaudeAuthTokenPath,
    sourceCodexHomePath,
  };
}

async function assertBuildArtifacts(config: ResolvedSoakConfig): Promise<void> {
  for (const path of [
    resolve(config.repositoryRoot, "orch-server-ts/dist/production_main.js"),
    resolve(config.repositoryRoot, "soul-server-ts/dist/main.js"),
    resolve(config.repositoryRoot, "soul-server-ts/dist/runner/runner_entry.js"),
  ]) await access(path);
}

function requireApproval(): void {
  if (!process.argv.includes(APPROVAL_ARGUMENT)) {
    throw new Error(`${APPROVAL_ARGUMENT} is required for staging mutation or real OAuth use`);
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isolationSummary(config: ResolvedSoakConfig): Record<string, unknown> {
  return {
    host: config.host,
    ports: { orch: config.orchPort, soul: config.soulPort },
    databaseName: config.databaseName,
    stagingRoot: config.stagingRoot,
    maxSessions: config.maxSessions,
    flags: {
      runnerProcess: true,
      mcpStatelessPublic: true,
      mcpStatefulInternal: true,
      orchLeaseReconciliation: true,
      immutableRunnerRelease: true,
    },
  };
}

function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  throw new Error(
    "usage: pnpm soak:runner <doctor|prepare|start|restart-soul|run|stop> "
      + "--config <path> [--backend claude|codex] [--confirm-staging-only]",
  );
}
