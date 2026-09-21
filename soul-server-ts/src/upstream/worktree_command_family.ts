import type { WorktreeService } from "../worktree/worktree_service.js";
import {
  CommandDispatchError,
  commandRequestId,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";

type WorktreeCommand = CommandLike & {
  input?: Record<string, unknown>;
};

export function createWorktreeCommandFamily(input: {
  send: SendFn;
  service?: WorktreeService;
}): CommandHandlerMap {
  const handle = (
    operation: "list" | "create" | "remove" | "deleteBranch",
  ) => async (raw: CommandLike): Promise<void> => {
    const cmd = raw as WorktreeCommand;
    if (!input.service) {
      throw new CommandDispatchError("Worktree MCP is disabled", "WORKTREE_MCP_DISABLED");
    }
    try {
      const result = await input.service[operation](cmd.input as never);
      await input.send({
        type: "worktree_result",
        requestId: commandRequestId(cmd),
        result,
      });
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "WORKTREE_FAILED";
      throw new CommandDispatchError(
        error instanceof Error ? error.message : String(error),
        code,
      );
    }
  };
  return {
    worktree_list: handle("list"),
    worktree_create: handle("create"),
    worktree_remove: handle("remove"),
    worktree_delete_branch: handle("deleteBranch"),
  };
}
