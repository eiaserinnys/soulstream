import type { RealtimeAckType } from "./realtime_ack.js";
import type {
  CommandHandlerMap,
  SendFn,
} from "./command_family.js";
import {
  RealtimeCommandError,
  RealtimeCommands,
  type RealtimeCommandAck,
  type RealtimeCreateCallCommand,
  type RealtimeEventCommand,
  type RealtimeResolveToolApprovalCommand,
} from "./realtime_commands.js";

interface RealtimeCommandFamilyDeps {
  send: SendFn;
  realtimeCommands: RealtimeCommands;
}

export class RealtimeCommandDispatchError extends Error {
  constructor(
    readonly ackType: RealtimeAckType,
    readonly requestId: string,
    readonly agentSessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeCommandDispatchError";
  }
}

export function createRealtimeCommandFamily(
  deps: RealtimeCommandFamilyDeps,
): CommandHandlerMap {
  return {
    realtime_create_call: (cmd) =>
      handleRealtimeCreateCall(deps, cmd as RealtimeCreateCallCommand),
    realtime_event: (cmd) => handleRealtimeEvent(deps, cmd as RealtimeEventCommand),
    realtime_resolve_tool_approval: (cmd) =>
      handleRealtimeResolveToolApproval(
        deps,
        cmd as RealtimeResolveToolApprovalCommand,
      ),
  };
}

async function handleRealtimeCreateCall(
  deps: RealtimeCommandFamilyDeps,
  cmd: RealtimeCreateCallCommand,
): Promise<void> {
  await sendRealtimeCommand(deps, () => deps.realtimeCommands.createCall(cmd));
}

async function handleRealtimeEvent(
  deps: RealtimeCommandFamilyDeps,
  cmd: RealtimeEventCommand,
): Promise<void> {
  await sendRealtimeCommand(deps, () => deps.realtimeCommands.relayEvent(cmd));
}

async function handleRealtimeResolveToolApproval(
  deps: RealtimeCommandFamilyDeps,
  cmd: RealtimeResolveToolApprovalCommand,
): Promise<void> {
  await sendRealtimeCommand(deps, () =>
    deps.realtimeCommands.resolveToolApproval(cmd),
  );
}

async function sendRealtimeCommand(
  deps: RealtimeCommandFamilyDeps,
  buildAck: () => Promise<RealtimeCommandAck | null>,
): Promise<void> {
  try {
    const ack = await buildAck();
    if (ack) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof RealtimeCommandError) {
      throw new RealtimeCommandDispatchError(
        err.ackType,
        err.requestId,
        err.agentSessionId,
        err.message,
      );
    }
    throw err;
  }
}
