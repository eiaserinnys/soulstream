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
  tokenResponse?: ClaudeAuthTokenExchangeResponse;
  tokenExchange?: NodeClaudeAuthRouteOptions["tokenExchange"];
  profileResponse?: NodeClaudeAuthHttpResponse;
  profileHttpError?: Error;
  pkce?: NodeClaudeAuthRouteOptions["pkce"];
  profileHttpClient?: NodeClaudeAuthRouteOptions["profileHttpClient"];
  provider?: NodeClaudeAuthRouteOptions["provider"];
  sessionStore?: TSessionStore;
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
    connectionId = registry.registerNode(
      loadContractFixtures().fakeNodeReconnect
        .registration as NodeRegistrationPayload,
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
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              ...defaultAckFor(message),
              ...options.ackFor?.(message),
              requestId: message.requestId,
            },
          );
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
  };

  const app = createApp({ config, nodeClaudeAuthRoutes: routeOptions });
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
