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
  type SessionBackgroundScheduleRouteOptions,
} from "../src/index.js";

type AckFactory = (message: Record<string, unknown>) => Record<string, unknown>;

export type BackgroundScheduleHarnessOptions = {
  ackFor?: AckFactory;
  attachTransport?: boolean;
  createSession?: boolean;
  bridgeOverride?: Partial<SessionCommandTransportBridge>;
};

export function createBackgroundScheduleHarness(options: BackgroundScheduleHarnessOptions = {}): {
  app: ReturnType<typeof createApp>;
  registry: InMemoryNodeRegistry;
  connectionId: string;
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  sent: Array<Record<string, unknown>>;
} {
  const sessionCache = new PerNodeSessionCache();
  const registry = new InMemoryNodeRegistry({
    sessionCache,
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType, nowMs }) =>
      `background-${commandType}-${sequence}-${nowMs}`,
  });
  const transports = new NodeCommandTransportHub();
  const router = new SessionCommandRouter({ registry });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
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

  const routeOptions: SessionBackgroundScheduleRouteOptions = {
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
    sessionBackgroundScheduleRoutes: routeOptions,
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
    case "claude_runtime_list_tasks":
      return {
        type: "claude_runtime_list_tasks_ack",
        status: "ok",
        tasks: [{ taskId: "bg-1" }],
      };
    case "claude_runtime_task_output":
      return {
        type: "claude_runtime_task_output_ack",
        status: "ok",
        taskId: message.taskId,
        output: "done",
        outputAvailable: true,
        truncated: false,
      };
    case "claude_runtime_stop_task":
      return {
        type: "claude_runtime_stop_task_ack",
        status: "ok",
        taskId: message.taskId,
        stopped: true,
      };
    case "claude_runtime_background_tasks":
      return {
        type: "claude_runtime_background_tasks_ack",
        status: "ok",
        backgrounded: true,
      };
    case "claude_runtime_list_schedules":
      return {
        type: "claude_runtime_list_schedules_ack",
        status: "ok",
        schedules: [{ scheduleId: "sched-1" }],
      };
    case "claude_runtime_delete_schedule":
      return {
        type: "claude_runtime_delete_schedule_ack",
        status: "cancelled",
        deleted: true,
        scheduleId: message.scheduleId,
      };
    default:
      return { type: "unknown_ack", status: "ok" };
  }
}
