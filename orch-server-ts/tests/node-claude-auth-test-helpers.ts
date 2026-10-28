import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  SessionCommandTransportBridge,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type ClaudeAuthSessionRecord,
  type ClaudeAuthSessionStore,
  type ClaudeAuthTokenExchangeRequest,
  type ClaudeAuthTokenExchangeResponse,
  type CreateAppOptions,
  type NodeClaudeAuthHttpRequest,
  type NodeClaudeAuthHttpResponse,
  type NodeClaudeAuthRouteOptions,
  type NodeRegistrationPayload,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type AckFactory = (message: Record<string, unknown>) => Record<string, unknown>;

export type ClaudeAuthHarnessOptions<
  TSessionStore extends ClaudeAuthSessionStore = MemoryClaudeAuthSessionStore,
> = {
  ackFor?: AckFactory;
  attachTransport?: boolean;
  registerNode?: boolean;
  claudeAccountPoolEnabled?: boolean;
  tokenResponse?: ClaudeAuthTokenExchangeResponse;
  tokenExchange?: NodeClaudeAuthRouteOptions["tokenExchange"];
  profileResponse?: NodeClaudeAuthHttpResponse;
  profileHttpError?: Error;
  pkce?: NodeClaudeAuthRouteOptions["pkce"];
  profileHttpClient?: NodeClaudeAuthRouteOptions["profileHttpClient"];
  provider?: NodeClaudeAuthRouteOptions["provider"];
  config?: CreateAppOptions["config"];
  productionAuth?: CreateAppOptions["productionAuth"];
  logDestination?: CreateAppOptions["logDestination"];
  timeoutMs?: number;
  withholdAck?: (message: Record<string, unknown>) => boolean;
  sessionStore?: TSessionStore;
  usageSummary?: NodeClaudeAuthRouteOptions["usageSummary"];
};

export type ClaudeAuthHarness<
  TSessionStore extends ClaudeAuthSessionStore = MemoryClaudeAuthSessionStore,
> = {
  app: ReturnType<typeof createApp>;
  bridge: SessionCommandTransportBridge;
  connectionId: string | undefined;
  profileRequests: NodeClaudeAuthHttpRequest[];
  registry: InMemoryNodeRegistry;
  routeOptions: NodeClaudeAuthRouteOptions;
  sent: Array<Record<string, unknown>>;
  sessionStore: TSessionStore;
  tokenRequests: ClaudeAuthTokenExchangeRequest[];
  transports: NodeCommandTransportHub;
};

export class MemoryClaudeAuthSessionStore implements ClaudeAuthSessionStore {
  readonly created: Array<{
    state: string;
    verifier: string;
    metadata: Record<string, string | undefined>;
  }> = [];
  readonly popped: string[] = [];

  private readonly sessions = new Map<string, ClaudeAuthSessionRecord>();

  create(
    state: string,
    verifier: string,
    options: { metadata: Record<string, string | undefined> },
  ): void {
    const record = { verifier, metadata: { ...options.metadata } };
    this.sessions.set(state, record);
    this.created.push({ state, verifier, metadata: record.metadata });
  }

  pop(state: string): ClaudeAuthSessionRecord | undefined {
    this.popped.push(state);
    const record = this.sessions.get(state);
    this.sessions.delete(state);
    return record;
  }

  seed(state: string, record: ClaudeAuthSessionRecord): void {
    this.sessions.set(state, record);
  }
}

export function createClaudeAuthHarness(
  options?: ClaudeAuthHarnessOptions<MemoryClaudeAuthSessionStore>,
): ClaudeAuthHarness<MemoryClaudeAuthSessionStore>;
export function createClaudeAuthHarness<
  TSessionStore extends ClaudeAuthSessionStore,
>(
  options: ClaudeAuthHarnessOptions<TSessionStore> & {
    sessionStore: TSessionStore;
  },
): ClaudeAuthHarness<TSessionStore>;
export function createClaudeAuthHarness(
  options: ClaudeAuthHarnessOptions<ClaudeAuthSessionStore> = {},
): ClaudeAuthHarness<ClaudeAuthSessionStore> {
  const registry = new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType, nowMs }) =>
      `claude-${commandType}-${sequence}-${nowMs}`,
  });
  const transports = new NodeCommandTransportHub();
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const sent: Array<Record<string, unknown>> = [];
  let connectionId: string | undefined;

  if (options.registerNode ?? true) {
    const registration = loadContractFixtures().fakeNodeReconnect
      .registration as NodeRegistrationPayload;
    connectionId = registry.registerNode(
      options.claudeAccountPoolEnabled
        ? {
            ...registration,
            capabilities: {
              ...(registration.capabilities ?? {}),
              claude_account_pool_v1: true,
            },
          }
        : registration,
    ).node.connectionId;
  }

  if ((options.attachTransport ?? true) && connectionId !== undefined) {
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
        if (!options.withholdAck?.(message)) {
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              ...defaultAckFor(message),
              ...options.ackFor?.(message),
              requestId: message.requestId,
            },
          );
        }
        },
      },
    });
  }

  const sessionStore = options.sessionStore ?? new MemoryClaudeAuthSessionStore();
  const tokenRequests: ClaudeAuthTokenExchangeRequest[] = [];
  const profileRequests: NodeClaudeAuthHttpRequest[] = [];
  const routeOptions: NodeClaudeAuthRouteOptions = {
    registry,
    bridge,
    provider: options.provider ?? {
      getOAuthConfig: () => ({
        clientId: "claude-client-id",
        callbackUrl: "https://orch.example.com/api/nodes/claude-auth/callback",
      }),
    },
    pkce: options.pkce ?? {
      generateVerifier: () => "verifier-fixed",
      generateChallenge: () => "challenge-fixed",
      generateState: () => "state-fixed",
    },
    sessionStore,
    tokenExchange: options.tokenExchange ?? (async (request) => {
      tokenRequests.push(request);
      return (
        options.tokenResponse ?? {
          statusCode: 200,
          body: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: "user:profile",
          },
          text: '{"access_token":"access-token"}',
        }
      );
    }),
    profileHttpClient: options.profileHttpClient ?? (async (request) => {
      profileRequests.push(request);
      if (options.profileHttpError !== undefined) throw options.profileHttpError;
      return options.profileResponse ?? { statusCode: 200, body: { profiles: [] } };
    }),
    usageSummary: options.usageSummary ?? { refreshNode: async () => poolUsageSnapshot() },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const app = createApp({
    config: options.config ?? config,
    nodeClaudeAuthRoutes: routeOptions,
    ...(options.productionAuth === undefined ? {} : { productionAuth: options.productionAuth }),
    ...(options.logDestination === undefined ? {} : { logDestination: options.logDestination }),
  });
  return {
    app,
    bridge,
    connectionId,
    profileRequests,
    registry,
    routeOptions,
    sent,
    sessionStore,
    tokenRequests,
    transports,
  };
}

function defaultAckFor(message: Record<string, unknown>): Record<string, unknown> {
  switch (message.type) {
    case "claude_auth_status":
      return { type: "claude_auth_status_ack", authenticated: true };
    case "claude_auth_set_token":
      return { type: "claude_auth_set_token_ack", success: true };
    case "claude_auth_delete_token":
      return { type: "claude_auth_delete_token_ack", success: true };
    case "claude_auth_get_usage":
      return {
        type: "claude_auth_get_usage_ack",
        success: true,
        data: { totalCostUsd: 1.25 },
      };
    case "claude_auth_get_profile":
      return {
        type: "claude_auth_get_profile_ack",
        success: true,
        data: { email: "ada@example.com" },
      };
    case "claude_auth_accounts_list":
    case "claude_auth_account_update":
      return { type: `${message.type}_ack`, success: true, data: accountList() };
    case "claude_auth_account_delete":
      return {
        type: `${message.type}_ack`,
        success: true,
        data: { deferred: false, accounts: [], pool: null },
      };
    case "claude_auth_login_start":
    case "claude_auth_login_status":
    case "claude_auth_login_submit_code":
    case "claude_auth_login_cancel":
      return {
        type: `${message.type}_ack`,
        success: true,
        data: loginFlow(message.type === "claude_auth_login_status" ? "done" : "url_ready"),
      };
    case "provider_usage_get":
      return {
        type: "provider_usage_get_ack",
        success: true,
        data: { provider: message.provider ?? "all" },
      };
    default:
      return { type: "unknown_ack", success: true };
  }
}

function accountList() {
  return { mode: "pool", accounts: [], pool: null, fable_pool: null };
}

function loginFlow(state: "done" | "url_ready") {
  return {
    login_id: "login-a",
    account_id: null,
    state,
    auth_url: "https://claude.example.test/login",
    expires_at: "2026-10-12T04:00:00.000Z",
    error: null,
  };
}

function poolUsageSnapshot() {
  return {
    generatedAt: "2026-10-12T03:00:00.000Z",
    collectedAt: "2026-10-12T03:00:00.000Z",
    nodes: [],
  };
}
