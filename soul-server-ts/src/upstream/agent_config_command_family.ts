import {
  CommandDispatchError,
  commandRequestId,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import {
  AgentConfigCommandError,
  AgentConfigCommands,
} from "./agent_config_commands.js";

type PlanAgentProfileUpdateCmd = CommandLike & {
  type: "plan_agent_profile_update";
  profile?: unknown;
  create_if_missing?: boolean;
  createIfMissing?: boolean;
  include_text_diff?: boolean;
  includeTextDiff?: boolean;
};

type ApplyAgentProfileUpdateCmd = CommandLike & {
  type: "apply_agent_profile_update";
  profile?: unknown;
  create_if_missing?: boolean;
  createIfMissing?: boolean;
  include_text_diff?: boolean;
  includeTextDiff?: boolean;
  expected_config_checksum?: string | null;
  expectedConfigChecksum?: string | null;
};

type ListAgentsConfigSnapshotsCmd = CommandLike & {
  type: "list_agents_config_snapshots";
};

type RollbackAgentsConfigCmd = CommandLike & {
  type: "rollback_agents_config";
  snapshot_path?: string;
  snapshotPath?: string;
  snapshot_id?: string;
  snapshotId?: string;
  include_text_diff?: boolean;
  includeTextDiff?: boolean;
};

interface AgentConfigCommandFamilyDeps {
  send: SendFn;
  agentConfigCommands: AgentConfigCommands;
}

export function createAgentConfigCommandFamily(
  deps: AgentConfigCommandFamilyDeps,
): CommandHandlerMap {
  return {
    plan_agent_profile_update: (cmd) =>
      handlePlanAgentProfileUpdate(deps, cmd as PlanAgentProfileUpdateCmd),
    apply_agent_profile_update: (cmd) =>
      handleApplyAgentProfileUpdate(deps, cmd as ApplyAgentProfileUpdateCmd),
    list_agents_config_snapshots: (cmd) =>
      handleListAgentsConfigSnapshots(deps, cmd as ListAgentsConfigSnapshotsCmd),
    rollback_agents_config: (cmd) =>
      handleRollbackAgentsConfig(deps, cmd as RollbackAgentsConfigCmd),
  };
}

async function handlePlanAgentProfileUpdate(
  deps: AgentConfigCommandFamilyDeps,
  cmd: PlanAgentProfileUpdateCmd,
): Promise<void> {
  try {
    await deps.send(
      await deps.agentConfigCommands.planProfileUpdate({
        requestId: commandRequestId(cmd),
        profile: cmd.profile,
        createIfMissing: cmd.create_if_missing ?? cmd.createIfMissing,
        includeTextDiff: cmd.include_text_diff ?? cmd.includeTextDiff,
      }),
    );
  } catch (err) {
    if (err instanceof AgentConfigCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleApplyAgentProfileUpdate(
  deps: AgentConfigCommandFamilyDeps,
  cmd: ApplyAgentProfileUpdateCmd,
): Promise<void> {
  try {
    await deps.send(
      await deps.agentConfigCommands.applyProfileUpdate({
        requestId: commandRequestId(cmd),
        profile: cmd.profile,
        createIfMissing: cmd.create_if_missing ?? cmd.createIfMissing,
        includeTextDiff: cmd.include_text_diff ?? cmd.includeTextDiff,
        expectedConfigChecksum:
          cmd.expected_config_checksum ?? cmd.expectedConfigChecksum,
      }),
    );
  } catch (err) {
    if (err instanceof AgentConfigCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleListAgentsConfigSnapshots(
  deps: AgentConfigCommandFamilyDeps,
  cmd: ListAgentsConfigSnapshotsCmd,
): Promise<void> {
  try {
    await deps.send(
      await deps.agentConfigCommands.listSnapshots({
        requestId: commandRequestId(cmd),
      }),
    );
  } catch (err) {
    if (err instanceof AgentConfigCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleRollbackAgentsConfig(
  deps: AgentConfigCommandFamilyDeps,
  cmd: RollbackAgentsConfigCmd,
): Promise<void> {
  try {
    await deps.send(
      await deps.agentConfigCommands.rollback({
        requestId: commandRequestId(cmd),
        snapshotPath: cmd.snapshot_path ?? cmd.snapshotPath,
        snapshotId: cmd.snapshot_id ?? cmd.snapshotId,
        includeTextDiff: cmd.include_text_diff ?? cmd.includeTextDiff,
      }),
    );
  } catch (err) {
    if (err instanceof AgentConfigCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
