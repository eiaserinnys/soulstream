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

export interface AgentConfigPlanOptions {
  includeTextDiff?: boolean;
}

export interface AgentConfigApplyOptions extends AgentConfigPlanOptions {
  expectedConfigChecksum?: string | null;
}

export type AgentConfigSemanticChange =
  | {
      op: "add_agent";
      agentId: string;
      before: null;
      after: AgentProfile;
    }
  | {
      op: "replace_agent";
      agentId: string;
      before: AgentProfile;
      after: AgentProfile;
    }
  | {
      op: "update_agent_atom_contexts";
      agentId: string;
      before: AgentAtomContext[];
      after: AgentAtomContext[];
    }
  | {
      op: "no_change";
      agentId: string;
      before: AgentProfile | AgentAtomContext[] | null;
      after: AgentProfile | AgentAtomContext[] | null;
    };

export interface AgentConfigPlan extends ConfigChangePlan<AgentsConfig> {
  semanticChanges: AgentConfigSemanticChange[];
  textDiffIncluded: boolean;
}

export type AgentConfigSemanticChangeWire = Omit<
  AgentConfigSemanticChange,
  "agentId"
> & {
  agent_id: string;
};

export interface AgentConfigApplyResult extends ConfigApplyResult<AgentsConfig> {
  semanticChanges?: AgentConfigSemanticChange[];
  textDiffIncluded?: boolean;
  reloadOk?: boolean;
}

export type AgentConfigSnapshotInfo = ConfigSnapshotInfo;

export function toAgentConfigSemanticChangeWire(
  changes: AgentConfigSemanticChange[],
): AgentConfigSemanticChangeWire[] {
  return changes.map(({ agentId, ...change }) => ({
    ...change,
    agent_id: agentId,
  } as AgentConfigSemanticChangeWire));
}

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
    options: AgentConfigPlanOptions = {},
  ): Promise<AgentConfigPlan> {
    return this.planWithSemanticChanges(
      (current) => profileUpdateSemanticChanges(current, profile, createIfMissing),
      (current) => replaceAgentProfile(current, profile, createIfMissing),
      options,
    );
  }

  replaceProfile(
    profile: AgentProfile,
    createIfMissing = false,
    options: AgentConfigApplyOptions = {},
  ): Promise<AgentConfigApplyResult> {
    const includeTextDiff = options.includeTextDiff ?? true;
    let semanticChanges: AgentConfigSemanticChange[] = [];
    return this.store.apply((current) => {
      semanticChanges = profileUpdateSemanticChanges(current, profile, createIfMissing);
      if (isNoChangeOnly(semanticChanges)) return current;
      return replaceAgentProfile(current, profile, createIfMissing);
    }, {
      includeTextDiff,
      expectedConfigChecksum: options.expectedConfigChecksum,
    }).then((result) => ({
      ...result,
      changed: !isNoChangeOnly(semanticChanges),
      semanticChanges,
      textDiffIncluded: includeTextDiff,
      reloadOk: true,
    }));
  }

  planSetAgentAtomContexts(
    agentId: string,
    atomContexts: AgentAtomContext[],
    options: AgentConfigPlanOptions = {},
  ): Promise<AgentConfigPlan> {
    return this.planWithSemanticChanges(
      (current) => atomContextsSemanticChanges(current, agentId, atomContexts),
      (current) => setAgentAtomContexts(current, agentId, atomContexts),
      options,
    );
  }

  setAgentAtomContexts(
    agentId: string,
    atomContexts: AgentAtomContext[],
  ): Promise<AgentConfigApplyResult> {
    let semanticChanges: AgentConfigSemanticChange[] = [];
    return this.store.apply((current) => {
      semanticChanges = atomContextsSemanticChanges(current, agentId, atomContexts);
      if (isNoChangeOnly(semanticChanges)) return current;
      return setAgentAtomContexts(current, agentId, atomContexts);
    }).then((result) => ({
      ...result,
      changed: !isNoChangeOnly(semanticChanges),
      semanticChanges,
      textDiffIncluded: true,
      reloadOk: true,
    }));
  }

  rollback(
    snapshotPathOrId: string,
    options: AgentConfigPlanOptions = {},
  ): Promise<AgentConfigApplyResult> {
    const includeTextDiff = options.includeTextDiff ?? true;
    return this.store.rollback(snapshotPathOrId, { includeTextDiff }).then((result) => ({
      ...result,
      textDiffIncluded: includeTextDiff,
      reloadOk: true,
    }));
  }

  private async planWithSemanticChanges(
    computeSemanticChanges: (current: AgentsConfig) => AgentConfigSemanticChange[],
    mutate: (current: AgentsConfig) => AgentsConfig,
    options: AgentConfigPlanOptions,
  ): Promise<AgentConfigPlan> {
    const includeTextDiff = options.includeTextDiff ?? false;
    let semanticChanges: AgentConfigSemanticChange[] = [];
    const plan = await this.store.plan((current) => {
      semanticChanges = computeSemanticChanges(current);
      if (isNoChangeOnly(semanticChanges)) return current;
      return mutate(current);
    }, { includeTextDiff });
    return {
      ...plan,
      changed: !isNoChangeOnly(semanticChanges),
      semanticChanges,
      textDiffIncluded: includeTextDiff,
    };
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
  } else if (semanticEqual(nextAgents[idx], profile)) {
    return current;
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
    if (semanticEqual(profile.atom_contexts ?? [], atomContexts)) return profile;
    return { ...profile, atom_contexts: atomContexts };
  });
  if (!found) {
    throw new Error(`agent not found: ${agentId}`);
  }
  return { ...current, agents: nextAgents };
}

function profileUpdateSemanticChanges(
  current: AgentsConfig,
  profile: AgentProfile,
  createIfMissing: boolean,
): AgentConfigSemanticChange[] {
  const existing = current.agents.find((p) => p.id === profile.id);
  if (!existing) {
    if (!createIfMissing) {
      throw new Error(`agent not found: ${profile.id}`);
    }
    return [{
      op: "add_agent",
      agentId: profile.id,
      before: null,
      after: profile,
    }];
  }
  if (semanticEqual(existing, profile)) {
    return [{
      op: "no_change",
      agentId: profile.id,
      before: existing,
      after: existing,
    }];
  }
  return [{
    op: "replace_agent",
    agentId: profile.id,
    before: existing,
    after: profile,
  }];
}

function atomContextsSemanticChanges(
  current: AgentsConfig,
  agentId: string,
  atomContexts: AgentAtomContext[],
): AgentConfigSemanticChange[] {
  const existing = current.agents.find((p) => p.id === agentId);
  if (!existing) {
    throw new Error(`agent not found: ${agentId}`);
  }
  const currentContexts = existing.atom_contexts ?? [];
  if (semanticEqual(currentContexts, atomContexts)) {
    return [{
      op: "no_change",
      agentId,
      before: currentContexts,
      after: currentContexts,
    }];
  }
  return [{
    op: "update_agent_atom_contexts",
    agentId,
    before: currentContexts,
    after: atomContexts,
  }];
}

function isNoChangeOnly(changes: AgentConfigSemanticChange[]): boolean {
  return changes.length === 0 || changes.every((change) => change.op === "no_change");
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJson(record[key])]),
    );
  }
  return value;
}
