import {
  CommandDispatchError,
  commandRequestId,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import {
  ReflectionCommandError,
  ReflectionCommands,
} from "./reflection_commands.js";

type ReflectBriefCmd = CommandLike & { type: "reflect_brief" };

interface ReflectionCommandFamilyDeps {
  send: SendFn;
  reflectionCommands: ReflectionCommands;
}

export function createReflectionCommandFamily(
  deps: ReflectionCommandFamilyDeps,
): CommandHandlerMap {
  return {
    reflect_brief: (cmd) => handleReflectBrief(deps, cmd as ReflectBriefCmd),
  };
}

async function handleReflectBrief(
  deps: ReflectionCommandFamilyDeps,
  cmd: ReflectBriefCmd,
): Promise<void> {
  try {
    await deps.send(
      await deps.reflectionCommands.reflectBrief({
        requestId: commandRequestId(cmd),
      }),
    );
  } catch (err) {
    if (err instanceof ReflectionCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
