import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import { parse as parseYaml } from "yaml";

import {
  transformPortableConfig,
  type PortableConfigPolicy,
  type PortableConfigTransformResult,
} from "./portable_config_transform.js";

export class PortableConfigDisabledError extends Error {
  readonly code = "PORTABLE_CONFIG_DISABLED" as const;

  constructor() {
    super("portable config is not configured");
    this.name = "PortableConfigDisabledError";
  }
}

export class PortableConfigUnavailableError extends Error {
  readonly code = "PORTABLE_CONFIG_UNAVAILABLE" as const;

  constructor(
    readonly sourcePath: string,
    readonly reason: string,
  ) {
    super("portable config source is unavailable");
    this.name = "PortableConfigUnavailableError";
  }
}

export type PortableConfigServiceOptions = {
  readonly configDir: string | null;
  readonly secretsFile: string | null;
  readonly servingSourceCommit: string;
};

type PortablePolicyFile = PortableConfigPolicy & { readonly source_env_file: string };

type PortableConfigFiles = {
  readonly agentsConfigPath: string;
  readonly modelCatalogPath: string;
  readonly mcpRegistryPath: string;
  readonly mcpProfilesPath: string;
};

export class PortableConfigService {
  readonly servingSourceCommit: string;

  private readonly configDir: string | null;
  private readonly secretsFile: string | null;

  constructor(options: PortableConfigServiceOptions) {
    this.configDir = options.configDir;
    this.secretsFile = options.secretsFile;
    this.servingSourceCommit = options.servingSourceCommit;
  }

  get enabled(): boolean {
    return this.configDir !== null && this.secretsFile !== null;
  }

  async transform(companyPc: boolean): Promise<PortableConfigTransformResult> {
    if (this.configDir === null || this.secretsFile === null) {
      throw new PortableConfigDisabledError();
    }
    const files = this.resolveFiles(this.configDir);
    const [agentsConfig, modelCatalog, mcpRegistry, mcpProfiles, policySource] =
      await Promise.all([
        this.readYaml(files.agentsConfigPath),
        this.readYaml(files.modelCatalogPath),
        this.readYaml(files.mcpRegistryPath),
        this.readYaml(files.mcpProfilesPath),
        this.readText(this.secretsFile),
      ]);
    let policyDocument: unknown;
    try {
      policyDocument = JSON.parse(policySource);
    } catch (error) {
      throw this.unavailable(this.secretsFile, error);
    }
    const policy = parsePolicyFile(policyDocument);
    if (policy === null) {
      throw new PortableConfigUnavailableError(this.secretsFile, "InvalidPolicy");
    }
    const sourceEnv = await this.readEnvFile(policy.source_env_file);
    return transformPortableConfig({
      agentsConfig,
      modelCatalog,
      mcpRegistry,
      mcpProfiles,
      policy,
      sourceEnv,
      companyPc,
      sourceCommit: this.servingSourceCommit,
    });
  }

  private resolveFiles(configDir: string): PortableConfigFiles {
    return {
      agentsConfigPath: path.join(configDir, "agents.yaml"),
      modelCatalogPath: path.join(configDir, "model-catalog.yaml"),
      mcpRegistryPath: path.join(configDir, "mcp-registry.yaml"),
      mcpProfilesPath: path.join(configDir, "mcp-profiles.yaml"),
    };
  }

  private async readYaml(filePath: string): Promise<unknown> {
    const text = await this.readText(filePath);
    try {
      return parseYaml(text) ?? {};
    } catch (error) {
      throw this.unavailable(filePath, error);
    }
  }

  private async readEnvFile(filePath: string): Promise<Record<string, string>> {
    const text = await this.readText(filePath);
    let parsed: Record<string, string | undefined>;
    try {
      parsed = parseEnv(text);
    } catch (error) {
      throw this.unavailable(filePath, error);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") env[key] = value;
    }
    return env;
  }

  private async readText(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf-8");
    } catch (error) {
      throw this.unavailable(filePath, error);
    }
  }

  private unavailable(filePath: string, error: unknown): PortableConfigUnavailableError {
    return new PortableConfigUnavailableError(filePath, describeError(error));
  }
}

function parsePolicyFile(value: unknown): PortablePolicyFile | null {
  if (!isRecord(value)) return null;
  const sourceEnvFile = value.source_env_file;
  const sourceWorkspaceDir = value.source_workspace_dir;
  if (typeof sourceEnvFile !== "string" || sourceEnvFile.length === 0) return null;
  if (typeof sourceWorkspaceDir !== "string" || sourceWorkspaceDir.length === 0) return null;
  return {
    source_env_file: sourceEnvFile,
    source_workspace_dir: sourceWorkspaceDir,
    public_env: stringRecord(value.public_env) ?? {},
    mcp_public_urls: stringRecord(value.mcp_public_urls) ?? {},
    personal_allow: stringArray(value.personal_allow) ?? [],
    company_allow: stringArray(value.company_allow) ?? [],
  };
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    record[key] = entry;
  }
  return record;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name}:${code}` : error.name;
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
