import type { EngineUserInput, ReasoningEffort } from "../protocol.js";

export const CODEX_APP_SERVER_PROTOCOL_SOURCE = {
  generatedBy: "codex-cli 0.133.0",
  command:
    "codex app-server generate-ts --experimental --out .local/tmp/codex-app-server-schema",
  keyFiles: [
    "ClientRequest.ts",
    "InitializeParams.ts",
    "InitializeResponse.ts",
    "v2/ThreadStartParams.ts",
    "v2/ThreadResumeParams.ts",
    "v2/TurnStartParams.ts",
    "v2/TurnSteerParams.ts",
    "v2/TurnInterruptParams.ts",
    "ServerNotification.ts",
    "ServerRequest.ts",
  ],
} as const;

export const CODEX_APP_SERVER_METHODS = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
} as const;

export type CodexAppServerMethod =
  (typeof CODEX_APP_SERVER_METHODS)[keyof typeof CODEX_APP_SERVER_METHODS];

export type AppServerRequestId = string | number;
export type AppServerTransportUrl = "stdio://" | `unix://${string}`;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface InitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities: JsonObject | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type AskForApproval =
  | "untrusted"
  | "on-request"
  | "on-failure"
  | "never"
  | string;

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | string
  | JsonObject;

export type AppServerUserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; detail?: string; url: string }
  | { type: "localImage"; detail?: string; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: string | JsonObject | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | JsonObject | null;
  ephemeral?: boolean | null;
  sessionStartSource?: string | JsonObject | null;
  threadSource?: string | JsonObject | null;
  environments?: JsonObject[] | null;
  dynamicTools?: JsonObject[] | null;
  mockExperimentalField?: string | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

export interface ThreadResumeParams {
  threadId: string;
  history?: unknown[] | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: string | JsonObject | null;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | JsonObject | null;
  excludeTurns?: boolean;
  persistExtendedHistory: boolean;
}

export interface TurnStartParams {
  threadId: string;
  input: AppServerUserInput[];
  responsesapiClientMetadata?: Record<string, string | undefined> | null;
  environments?: JsonObject[] | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: string | JsonObject | null;
  sandboxPolicy?: SandboxMode | null;
  permissions?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: ReasoningEffort | null;
  summary?: string | JsonObject | null;
  personality?: string | JsonObject | null;
  outputSchema?: JsonValue | null;
  collaborationMode?: string | JsonObject | null;
}

export interface TurnSteerParams {
  threadId: string;
  input: AppServerUserInput[];
  responsesapiClientMetadata?: Record<string, string | undefined> | null;
  expectedTurnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface AppServerThread {
  id: string;
  sessionId?: string;
  turns?: AppServerTurn[];
  [key: string]: unknown;
}

export interface AppServerTurn {
  id: string;
  items: unknown[];
  itemsView: JsonObject;
  status: string;
  error: unknown | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface ThreadStartResponse {
  thread: AppServerThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  instructionSources: string[];
  approvalPolicy: AskForApproval;
  approvalsReviewer: unknown;
  sandbox: unknown;
  activePermissionProfile: unknown | null;
  reasoningEffort: ReasoningEffort | null;
}

export type ThreadResumeResponse = ThreadStartResponse;

export interface TurnStartResponse {
  turn: AppServerTurn;
}

export interface TurnSteerResponse {
  turnId: string;
}

export type TurnInterruptResponse = Record<string, never>;

export interface CodexAppServerMethodMap {
  initialize: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  "thread/start": {
    params: ThreadStartParams;
    result: ThreadStartResponse;
  };
  "thread/resume": {
    params: ThreadResumeParams;
    result: ThreadResumeResponse;
  };
  "turn/start": {
    params: TurnStartParams;
    result: TurnStartResponse;
  };
  "turn/steer": {
    params: TurnSteerParams;
    result: TurnSteerResponse;
  };
  "turn/interrupt": {
    params: TurnInterruptParams;
    result: TurnInterruptResponse;
  };
}

export type CodexAppServerRequest<M extends CodexAppServerMethod> = {
  id: AppServerRequestId;
  method: M;
  params: CodexAppServerMethodMap[M]["params"];
};

export type AppServerNotification =
  | {
      method: "turn/started";
      params: { threadId: string; turn: AppServerTurn };
    }
  | {
      method: "turn/completed";
      params: { threadId: string; turn: AppServerTurn };
    }
  | {
      method: string;
      params?: unknown;
    };

export type AppServerServerRequest = {
  id: AppServerRequestId;
  method: string;
  params?: unknown;
};

export function toCodexUserInput(input: EngineUserInput): AppServerUserInput[] {
  return [
    { type: "text", text: input.prompt, text_elements: [] },
    ...(input.imageAttachmentPaths ?? []).map((path) => ({
      type: "localImage" as const,
      path,
    })),
  ];
}
