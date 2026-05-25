import {
  AgentProfileSchema,
  type AgentProfile,
  type AgentRegistry,
  type AgentsConfig,
} from "../agent_registry.js";
import type {
  AgentConfigApplyResult,
  AgentConfigPlan,
  AgentConfigService,
  AgentConfigSnapshotInfo,
} from "../agent_config_service.js";
import { toAgentConfigSemanticChangeWire } from "../agent_config_service.js";

export type AgentConfigCommandHandler = Pick<
  AgentConfigService,
  "listSnapshots" | "planProfileUpdate" | "replaceProfile" | "rollback"
>;

type AgentCatalogSource = Pick<AgentRegistry, "list" | "supportedBackends">;

export interface PlanAgentProfileUpdateParams {
  requestId: string;
  profile: unknown;
  createIfMissing?: boolean;
  includeTextDiff?: boolean;
}

export interface ApplyAgentProfileUpdateParams extends PlanAgentProfileUpdateParams {
  expectedConfigChecksum?: string | null;
}

export interface ListAgentsConfigSnapshotsParams {
  requestId: string;
}

export interface RollbackAgentsConfigParams {
  requestId: string;
  snapshotPath?: string;
  snapshotId?: string;
  includeTextDiff?: boolean;
}

export class AgentConfigCommandError extends Error {}

/**
 * Owns read-only agents.yaml planning commands coming from the orchestrator.
 */
export class AgentConfigCommands {
  constructor(
    private readonly service?: AgentConfigCommandHandler,
    private readonly agentRegistry?: AgentCatalogSource,
  ) {}

  async planProfileUpdate(
    params: PlanAgentProfileUpdateParams,
  ): Promise<Record<string, unknown>> {
    if (!this.service) {
      throw new AgentConfigCommandError(
        "plan_agent_profile_update handler requires agent_config_service dependency",
      );
    }
    const profile = AgentProfileSchema.safeParse(params.profile);
    if (!profile.success) {
      throw new AgentConfigCommandError(`invalid profile: ${profile.error.message}`);
    }
    const plan: AgentConfigPlan = await this.service.planProfileUpdate(
      profile.data,
      params.createIfMissing ?? false,
      { includeTextDiff: params.includeTextDiff ?? false },
    );
    return {
      type: "plan_agent_profile_update",
      requestId: params.requestId,
      ok: true,
      config_path: plan.configPath,
      config_checksum: plan.configChecksum,
      base_config_checksum: plan.baseConfigChecksum,
      changed: plan.changed,
      semantic_changes: toAgentConfigSemanticChangeWire(plan.semanticChanges),
      text_diff_included: plan.textDiffIncluded,
      diff: plan.diff,
      snapshot_root: plan.snapshotRoot,
      comment_preservation: plan.commentPreservation,
    };
  }

  async applyProfileUpdate(
    params: ApplyAgentProfileUpdateParams,
  ): Promise<Record<string, unknown>> {
    if (!this.service) {
      throw new AgentConfigCommandError(
        "apply_agent_profile_update handler requires agent_config_service dependency",
      );
    }
    const profile = AgentProfileSchema.safeParse(params.profile);
    if (!profile.success) {
      throw new AgentConfigCommandError(`invalid profile: ${profile.error.message}`);
    }
    try {
      const result = await this.service.replaceProfile(
        profile.data,
        params.createIfMissing ?? false,
        {
          includeTextDiff: params.includeTextDiff ?? false,
          expectedConfigChecksum: params.expectedConfigChecksum,
        },
      );
      return agentConfigApplyResultWire(
        "apply_agent_profile_update",
        params.requestId,
        result,
        agentCatalogWire(this.agentRegistry, result.config),
      );
    } catch (err) {
      throw new AgentConfigCommandError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async listSnapshots(
    params: ListAgentsConfigSnapshotsParams,
  ): Promise<Record<string, unknown>> {
    if (!this.service) {
      throw new AgentConfigCommandError(
        "list_agents_config_snapshots handler requires agent_config_service dependency",
      );
    }
    const snapshots = this.service.listSnapshots();
    return {
      type: "list_agents_config_snapshots",
      requestId: params.requestId,
      ok: true,
      snapshots: snapshots.map(snapshotInfoWire),
    };
  }

  async rollback(
    params: RollbackAgentsConfigParams,
  ): Promise<Record<string, unknown>> {
    if (!this.service) {
      throw new AgentConfigCommandError(
        "rollback_agents_config handler requires agent_config_service dependency",
      );
    }
    const snapshotRef = params.snapshotPath ?? params.snapshotId;
    if (!snapshotRef) {
      throw new AgentConfigCommandError(
        "rollback_agents_config requires snapshot_path or snapshot_id",
      );
    }
    try {
      const result = await this.service.rollback(snapshotRef, {
        includeTextDiff: params.includeTextDiff ?? false,
      });
      return agentConfigApplyResultWire(
        "rollback_agents_config",
        params.requestId,
        result,
        agentCatalogWire(this.agentRegistry, result.config),
        {
          restored_snapshot_path: params.snapshotPath,
          restored_snapshot_id: params.snapshotId,
        },
      );
    } catch (err) {
      throw new AgentConfigCommandError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function snapshotInfoWire(snapshot: AgentConfigSnapshotInfo): Record<string, unknown> {
  return {
    snapshot_id: snapshot.snapshotId,
    snapshot_path: snapshot.snapshotPath,
    created_at: snapshot.createdAt,
    mtime: snapshot.mtime,
    size_bytes: snapshot.sizeBytes,
    config_path: snapshot.configPath,
    config_name: snapshot.configName,
    config_hash: snapshot.configHash,
  };
}

function agentConfigApplyResultWire(
  type: "apply_agent_profile_update" | "rollback_agents_config",
  requestId: string,
  result: AgentConfigApplyResult,
  catalog: ReturnType<typeof agentCatalogWire>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    type,
    requestId,
    ok: true,
    config_path: result.configPath,
    config_checksum: result.configChecksum,
    base_config_checksum: result.baseConfigChecksum,
    changed: result.changed,
    semantic_changes: result.semanticChanges
      ? toAgentConfigSemanticChangeWire(result.semanticChanges)
      : [],
    text_diff_included: result.textDiffIncluded ?? true,
    diff: result.diff,
    snapshot_path: result.snapshotPath,
    applied_at: result.appliedAt,
    reload_ok: result.reloadOk ?? true,
    snapshot_root: result.snapshotRoot,
    comment_preservation: result.commentPreservation,
    agent_count: catalog.agents.length,
    agents: catalog.agents,
    supported_backends: catalog.supported_backends,
    capabilities: catalog.capabilities,
  };
  if (type === "rollback_agents_config") {
    response.rollback_snapshot_path = result.snapshotPath;
  }
  return { ...response, ...extras };
}

function agentCatalogWire(
  agentRegistry: AgentCatalogSource | undefined,
  fallbackConfig: AgentsConfig,
): {
  agents: Record<string, unknown>[];
  supported_backends: string[];
  capabilities: { max_concurrent: number };
} {
  const agents = agentRegistry ? agentRegistry.list() : fallbackConfig.agents;
  const supportedBackends = agentRegistry
    ? agentRegistry.supportedBackends()
    : Array.from(new Set(agents.map((agent) => agent.backend)));
  return {
    agents: agents.map(agentProfileSummaryWire),
    supported_backends: supportedBackends,
    capabilities: { max_concurrent: agents.length },
  };
}

function agentProfileSummaryWire(profile: AgentProfile): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: profile.id,
    name: profile.name,
    backend: profile.backend,
    portrait_url: profile.portrait_path ? `/api/agents/${profile.id}/portrait` : "",
  };
  if (profile.max_turns !== undefined) {
    entry.max_turns = profile.max_turns;
  }
  return entry;
}
