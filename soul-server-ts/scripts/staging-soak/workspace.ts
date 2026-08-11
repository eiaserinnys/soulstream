import { copyFile, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

import type { ResolvedSoakConfig } from "./config.js";

export async function prepareSoakWorkspace(
  config: ResolvedSoakConfig,
  sourceClaudeAuthTokenPath: string,
): Promise<void> {
  for (const directory of [
    config.paths.config,
    config.paths.runtime,
    config.paths.runnerState,
    config.paths.runnerReleases,
    config.paths.eventOutbox,
    config.paths.incoming,
    config.paths.workspace,
    config.paths.logs,
    config.paths.pids,
    config.paths.captures,
    config.paths.databaseRelease,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  await copyFile(sourceClaudeAuthTokenPath, config.paths.claudeAuthToken);
  await chmod(config.paths.claudeAuthToken, 0o600);
  await writePrivate(config.paths.agentsConfig, agentsYaml(config));
  await writePrivate(config.paths.modelCatalog, modelCatalogYaml(config));
  await writePrivate(config.paths.mcpRegistry, mcpRegistryYaml(config));
  await writePrivate(config.paths.mcpProfiles, mcpProfilesYaml());
}

export async function assertPreparedWorkspace(config: ResolvedSoakConfig): Promise<void> {
  for (const path of [
    config.paths.agentsConfig,
    config.paths.modelCatalog,
    config.paths.mcpRegistry,
    config.paths.mcpProfiles,
    config.paths.claudeAuthToken,
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
