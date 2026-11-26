import {
  CommandDispatchError,
  type CommandHandlerMap,
  type SendFn,
} from "./command_family.js";
import {
  NodeGitCommandError,
  type NodeGitCommand,
  type NodeGitCommands,
} from "./node_git_commands.js";

interface NodeGitCommandFamilyDeps {
  send: SendFn;
  nodeGitCommands: NodeGitCommands;
}

export function createNodeGitCommandFamily(deps: NodeGitCommandFamilyDeps): CommandHandlerMap {
  const handle = async (cmd: unknown): Promise<void> => {
    try {
      await deps.send(await deps.nodeGitCommands.handle(cmd as NodeGitCommand));
    } catch (err) {
      if (err instanceof NodeGitCommandError) throw new CommandDispatchError(err.message);
      throw err;
    }
  };
  return {
    node_git_status: handle,
    node_git_identity_set: handle,
    node_git_ssh_key_create: handle,
    node_git_ssh_check: handle,
    node_git_clone_start: handle,
    node_git_clone_status: handle,
  };
}
