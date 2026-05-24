import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  AgentsConfigSchema,
  type AgentAtomContext,
  type AgentProfile,
  type AgentRegistry,
  type AgentsConfig,
} from "./agent_registry.js";
import {
  ConfigStore,
  type ConfigApplyResult,
  type ConfigChangePlan,
  type ConfigSnapshotInfo,
} from "./config_store.js";

export interface AgentConfigServiceOptions {
  configPath: string;
  snapshotRoot?: string;
  agentRegistry?: Pick<AgentRegistry, "replace">;
}

export type AgentConfigPlan = ConfigChangePlan<AgentsConfig>;
export type AgentConfigApplyResult = ConfigApplyResult<AgentsConfig>;
export type AgentConfigSnapshotInfo = ConfigSnapshotInfo;

export class AgentConfigService {
  private readonly store: ConfigStore<AgentsConfig>;

  constructor(options: AgentConfigServiceOptions) {
    this.store = new ConfigStore({
      configPath: options.configPath,
      snapshotRoot: options.snapshotRoot,
      parse: parseAgentsConfigRaw,
      stringify: stringifyAgentsConfig,
      onAfterApply: (config) => {
        options.agentRegistry?.replace(config.agents);
      },
    });
  }

  readRaw(): { raw: string; parsed: AgentsConfig } {
    const { raw, config } = this.store.read();
    return { raw, parsed: config };
  }

  listSnapshots(): AgentConfigSnapshotInfo[] {
    return this.store.listSnapshots();
  }

  planProfileUpdate(
    profile: AgentProfile,
    createIfMissing = false,
  ): Promise<AgentConfigPlan> {
    return this.store.plan((current) =>
      replaceAgentProfile(current, profile, createIfMissing),
    );
  }

  replaceProfile(
    profile: AgentProfile,
    createIfMissing = false,
  ): Promise<AgentConfigApplyResult> {
    return this.store.apply((current) =>
      replaceAgentProfile(current, profile, createIfMissing),
    );
  }

  planSetAgentAtomContexts(
    agentId: string,
    atomContexts: AgentAtomContext[],
  ): Promise<AgentConfigPlan> {
    return this.store.plan((current) =>
      setAgentAtomContexts(current, agentId, atomContexts),
    );
  }

  setAgentAtomContexts(
    agentId: string,
    atomContexts: AgentAtomContext[],
  ): Promise<AgentConfigApplyResult> {
    return this.store.apply((current) =>
      setAgentAtomContexts(current, agentId, atomContexts),
    );
  }

  rollback(snapshotPath: string): Promise<AgentConfigApplyResult> {
    return this.store.rollback(snapshotPath);
  }
}

function parseAgentsConfigRaw(raw: string): AgentsConfig {
  const parsed: unknown = parseYaml(raw) ?? {};
  return AgentsConfigSchema.parse(parsed);
}

function stringifyAgentsConfig(config: AgentsConfig): string {
  return stringifyYaml(AgentsConfigSchema.parse(config));
}

function replaceAgentProfile(
  current: AgentsConfig,
  profile: AgentProfile,
  createIfMissing: boolean,
): AgentsConfig {
  const nextAgents = [...current.agents];
  const idx = nextAgents.findIndex((p) => p.id === profile.id);
  if (idx === -1) {
    if (!createIfMissing) {
      throw new Error(`agent not found: ${profile.id}`);
    }
    nextAgents.push(profile);
  } else {
    nextAgents[idx] = profile;
  }
  return { ...current, agents: nextAgents };
}

function setAgentAtomContexts(
  current: AgentsConfig,
  agentId: string,
  atomContexts: AgentAtomContext[],
): AgentsConfig {
  let found = false;
  const nextAgents = current.agents.map((profile) => {
    if (profile.id !== agentId) return profile;
    found = true;
    return { ...profile, atom_contexts: atomContexts };
  });
  if (!found) {
    throw new Error(`agent not found: ${agentId}`);
  }
  return { ...current, agents: nextAgents };
}
