import type {
  ProviderUsageCommandHandler,
  ProviderUsageName,
  ProviderUsageResponse,
} from "../auth/provider_usage.js";

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

export type ProviderUsageCommand = CommandLike & {
  type: "provider_usage_get";
  provider?: unknown;
};

export class ProviderUsageCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUsageCommandError";
  }
}

export class ProviderUsageCommands {
  constructor(
    private readonly deps: {
      providerUsage: ProviderUsageCommandHandler;
    },
  ) {}

  async handle(cmd: ProviderUsageCommand): Promise<ProviderUsageResponse> {
    const provider = normalizeProvider(cmd.provider);
    return this.deps.providerUsage.fetchUsage(
      commandRequestId(cmd),
      cmd.type,
      provider,
    );
  }
}

function normalizeProvider(value: unknown): ProviderUsageName | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "claude" || value === "codex" || value === "gemini") {
    return value;
  }
  throw new ProviderUsageCommandError("provider must be one of: claude, codex, gemini");
}

function commandRequestId(cmd: CommandLike): string {
  return cmd.requestId ?? cmd.request_id ?? "";
}
