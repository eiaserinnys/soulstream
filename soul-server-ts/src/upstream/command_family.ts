export type SendFn = (data: unknown) => Promise<void>;

export interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
  agentSessionId?: string;
  session_id?: string;
}

export type CommandTraceFields = {
  type: string | null;
  requestId: string | null;
  sessionId: string | null;
};

export type CommandHandler = (cmd: CommandLike) => Promise<void>;
export type CommandHandlerMap = Record<string, CommandHandler>;

export class CommandDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandDispatchError";
  }
}

export function commandRequestId(cmd: CommandLike): string {
  return cmd.requestId ?? cmd.request_id ?? "";
}

export function commandTraceFields(cmd: CommandLike): CommandTraceFields {
  return {
    type: nonEmptyString(cmd.type),
    requestId: nonEmptyString(cmd.requestId ?? cmd.request_id),
    sessionId: nonEmptyString(cmd.agentSessionId ?? cmd.session_id),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
