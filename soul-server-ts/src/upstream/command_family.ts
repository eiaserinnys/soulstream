export type SendFn = (data: unknown) => Promise<void>;

export interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

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
