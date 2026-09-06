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
  /**
   * Structured failure code forwarded to orch so an input error can be mapped to
   * a 4xx instead of the generic "node unavailable" 503.
   */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "CommandDispatchError";
    this.code = code;
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
