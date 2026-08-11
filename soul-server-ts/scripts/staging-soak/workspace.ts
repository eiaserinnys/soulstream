import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { ResolvedSoakConfig } from "./config.js";

export async function prepareSoakWorkspace(
  config: ResolvedSoakConfig,
  sourceClaudeAuthTokenPath: string,
  sourceCodexHomePath: string,
): Promise<void> {
  for (const directory of [
    config.paths.config,
    config.paths.runtime,
    config.paths.runnerStateStorage,
    config.paths.runnerReleases,
    config.paths.eventOutbox,
    config.paths.incoming,
    config.paths.workspace,
    config.paths.logs,
    config.paths.pids,
    config.paths.captures,
    config.paths.databaseRelease,
    config.paths.codexHome,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await ensureRunnerStateAlias(config);

  await copyFile(sourceClaudeAuthTokenPath, config.paths.claudeAuthToken);
  await chmod(config.paths.claudeAuthToken, 0o600);
  await copyFile(`${sourceCodexHomePath}/auth.json`, `${config.paths.codexHome}/auth.json`);
  await chmod(`${config.paths.codexHome}/auth.json`, 0o600);
  await writePrivate(
    `${config.paths.codexHome}/config.toml`,
    "# Isolated runner staging soak; MCP is supplied by Soulstream.\n",
  );
  await writePrivate(config.paths.agentsConfig, agentsYaml(config));
  await writePrivate(config.paths.modelCatalog, modelCatalogYaml(config));
  await writePrivate(config.paths.mcpRegistry, mcpRegistryYaml(config));
  await writePrivate(config.paths.mcpProfiles, mcpProfilesYaml());
}

async function ensureRunnerStateAlias(config: ResolvedSoakConfig): Promise<void> {
  try {
    const stat = await lstat(config.paths.runnerState);
    if (!stat.isSymbolicLink()) {
      throw new Error(`staging runner state alias is not a symlink: ${config.paths.runnerState}`);
    }
    const target = await readlink(config.paths.runnerState);
    if (target !== config.paths.runnerStateStorage) {
      throw new Error(`staging runner state alias points outside its owned storage: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await symlink(config.paths.runnerStateStorage, config.paths.runnerState, "dir");
  }
}

export async function assertPreparedWorkspace(config: ResolvedSoakConfig): Promise<void> {
  for (const path of [
    config.paths.agentsConfig,
    config.paths.modelCatalog,
    config.paths.mcpRegistry,
    config.paths.mcpProfiles,
    config.paths.claudeAuthToken,
    `${config.paths.codexHome}/auth.json`,
  ]) {
    const content = await readFile(path, "utf8");
    if (content.length === 0) throw new Error(`staging preparation file is empty: ${path}`);
  }
}

function agentsYaml(config: ResolvedSoakConfig): string {
  return [
    "agents:",
    `  - id: ${yaml(config.profile)}`,
    "    name: Runner staging soak",
    "    backend: claude",
    `    workspace_dir: ${yaml(config.paths.workspace)}`,
    `    default_preset: ${yaml(config.modelPreset)}`,
    "    claude_permission_mode: bypassPermissions",
    "    mcp_profile: staging-soak",
    `  - id: ${yaml(config.codexProfile)}`,
    "    name: Runner staging soak Codex",
    "    backend: codex",
    `    workspace_dir: ${yaml(config.paths.workspace)}`,
    `    default_preset: ${yaml(config.codexModelPreset)}`,
    "    mcp_profile: staging-soak",
    "",
  ].join("\n");
}

function modelCatalogYaml(config: ResolvedSoakConfig): string {
  return [
    "presets:",
    `  - id: ${yaml(config.modelPreset)}`,
    "    label: Claude staging soak",
    "    backend: claude",
    "    model: sonnet",
    `  - id: ${yaml(config.codexModelPreset)}`,
    "    label: Codex staging soak",
    "    backend: codex",
    "    model: gpt-5.6-sol",
    "",
  ].join("\n");
}

function mcpRegistryYaml(config: ResolvedSoakConfig): string {
  return [
    "servers:",
    "  - id: soulstream",
    "    type: streamable_http",
    `    url: ${yaml(`http://${config.host}:${config.soulPort}/mcp`)}`,
    "    headers:",
    "      Authorization:",
    "        env: SOULSTREAM_MCP_AUTH",
    "",
  ].join("\n");
}

function mcpProfilesYaml(): string {
  return [
    "profiles:",
    "  - id: staging-soak",
    "    mcp_servers: [soulstream]",
    "",
  ].join("\n");
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
