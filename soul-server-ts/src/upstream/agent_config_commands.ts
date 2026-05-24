import { AgentProfileSchema } from "../agent_registry.js";
import type {
  AgentConfigPlan,
  AgentConfigService,
} from "../agent_config_service.js";
import { toAgentConfigSemanticChangeWire } from "../agent_config_service.js";

export type AgentConfigCommandHandler = Pick<
  AgentConfigService,
  "planProfileUpdate"
>;

export interface PlanAgentProfileUpdateParams {
  requestId: string;
  profile: unknown;
  createIfMissing?: boolean;
  includeTextDiff?: boolean;
}

export class AgentConfigCommandError extends Error {}

/**
 * Owns read-only agents.yaml planning commands coming from the orchestrator.
 */
export class AgentConfigCommands {
  constructor(private readonly service?: AgentConfigCommandHandler) {}

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
      changed: plan.changed,
      semantic_changes: toAgentConfigSemanticChangeWire(plan.semanticChanges),
      text_diff_included: plan.textDiffIncluded,
      diff: plan.diff,
      snapshot_root: plan.snapshotRoot,
      comment_preservation: plan.commentPreservation,
    };
  }
}
