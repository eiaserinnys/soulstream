import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  SessionCommandRouter,
  SessionCommandTransportBridge,
  createApp,
  loadContractFixtures,
  type CreateSessionNodeCommandPayload,
  type NodeRegistrationPayload,
  type SessionActionCommandRouteOptions,
} from "../src/index.js";

type AckFactory = (message: Record<string, unknown>) => Record<string, unknown>;

export type ActionHarnessOptions = {
  ackFor?: AckFactory;
  attachTransport?: boolean;
  createSession?: boolean;
  bridgeOverride?: Partial<SessionCommandTransportBridge>;
};

export function createHarnessCore(): {
  registry: InMemoryNodeRegistry;
  transports: NodeCommandTransportHub;
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
} {
  const sessionCache = new PerNodeSessionCache();
  const registry = new InMemoryNodeRegistry({
    sessionCache,
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType, nowMs }) =>
      `action-${commandType}-${sequence}-${nowMs}`,
  });
  const transports = new NodeCommandTransportHub();
  const router = new SessionCommandRouter({ registry });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  return { registry, transports, router, bridge };
}

export function createActionHarness(options: ActionHarnessOptions = {}): {
  app: ReturnType<typeof createApp>;
  registry: InMemoryNodeRegistry;
  connectionId: string;
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  sent: Array<Record<string, unknown>>;
} {
  const { registry, transports, router, bridge } = createHarnessCore();
  const connectionId = registry.registerNode(
    reconnectFixture().registration as NodeRegistrationPayload,
  ).node.connectionId;
  if (options.createSession ?? true) {
    createExistingSession(registry);
  }
  const sent: Array<Record<string, unknown>> = [];

  if (options.attachTransport ?? true) {
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

  const routeOptions: SessionActionCommandRouteOptions = {
    router,
    bridge: options.bridgeOverride
      ? ({
          sendPendingCommand:
            options.bridgeOverride.sendPendingCommand ??
            bridge.sendPendingCommand.bind(bridge),
          sendFireAndForgetCommand:
            options.bridgeOverride.sendFireAndForgetCommand ??
            bridge.sendFireAndForgetCommand.bind(bridge),
        } as SessionCommandTransportBridge)
      : bridge,
  };
  const app = createApp({
    config: {
      environment: "test",
      databaseUrl: "postgresql://test/test",
      authBearerToken: "test-token",
    },
    sessionActionCommandRoutes: routeOptions,
  });

  return { app, registry, connectionId, router, bridge, sent };
}

function createExistingSession(registry: InMemoryNodeRegistry): void {
  const command = registry.createCommand(
    "fake-node",
    reconnectFixture().command as CreateSessionNodeCommandPayload,
  );
  registry.receiveNodeMessage("fake-node", {
    ...reconnectFixture().ack,
    requestId: command.requestId,
  });
}

function reconnectFixture(): ReturnType<typeof loadContractFixtures>["fakeNodeReconnect"] {
  return loadContractFixtures().fakeNodeReconnect;
}

function defaultAckFor(message: Record<string, unknown>): Record<string, unknown> {
  switch (message.type) {
    case "intervene":
      return { type: "intervene_ack", status: "ok" };
    case "interrupt_session":
      return { type: "interrupt_session_ack", status: "ok" };
    case "acknowledge_session_review":
      return {
        type: "acknowledge_session_review_ack",
        status: "ok",
        reviewState: "acknowledged",
        changed: true,
        agentSessionId: message.agentSessionId,
      };
    case "approve_tool":
    case "reject_tool":
      return {
        type: "tool_approval_ack",
        status: "ok",
        approvalId: message.approvalId,
      };
    case "realtime_create_call":
      return { type: "realtime_call_created", status: "ok" };
    case "realtime_event":
      return { type: "realtime_event_ack", status: "ok" };
    case "realtime_resolve_tool_approval":
      return { type: "realtime_tool_approval_ack", status: "ok" };
    default:
      return { type: "unknown_ack", status: "ok" };
  }
}
