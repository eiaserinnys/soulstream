import type { NodeCommandResponse } from "../node/pending_commands.js";

export type ContractFixture = {
  version: number;
};

export type RouteInventoryFixture = ContractFixture & {
  routes: Array<{
    order: number;
    methods: string[];
    path: string;
    name: string;
    authRequired: boolean;
  }>;
};

export type UpstreamWsWireFixture = ContractFixture & {
  outbound: {
    respond: {
      type: "respond";
      agentSessionId: string;
      inputRequestId: string;
      answers: Record<string, unknown>;
      requestId: string;
      requestIdMustNotEqual: string;
    };
    subscribeEvents: {
      type: "subscribe_events";
      agentSessionId: string;
      subscribeId: string;
      requestId: string;
      fireAndForget: boolean;
    };
  };
  inbound: {
    nodeRegister: {
      type: "node_register";
      node_id: string;
      [key: string]: unknown;
    };
    commandAck: NodeCommandResponse & {
      type: "session_created";
      requestId: string;
      agentSessionId: string;
    };
    commandError: NodeCommandResponse & {
      type: "error";
      requestId: string;
      message: string;
    };
    eventRelay: NodeCommandResponse & {
      type: "event";
      agentSessionId: string;
      event: Record<string, unknown>;
    };
    sessionsUpdate: {
      type: "sessions_update";
      sessions: unknown[];
    };
  };
};

export type SseReplayGapFixture = ContractFixture & {
  common: {
    resumeInputs: {
      lastEventIdHeader: string;
      lastEventIdQuery: string;
      instanceIdQuery: string;
    };
    streamMeta: {
      type: "stream_meta";
      instance_id: string;
      latest_id: number;
    };
    snapshotRefetchOn: string[];
  };
  sessionStream: {
    events: Array<Record<string, unknown>>;
    resumeFrom: number;
    expectedReplayEventIds: number[];
  };
  taskStream: {
    changes: Array<Record<string, unknown>>;
    resumeFrom: number;
    expectedReplayEventIds: number[];
  };
  gap: {
    ringMaxlen: number;
    lastEventIdBeforeOldest: number;
    expectedLatestId: number;
  };
};

export type FakeNodeReconnectFixture = ContractFixture & {
  registration: {
    type: string;
  };
  command: {
    type: string;
    agentSessionId: string;
    prompt: string;
  };
  ack: {
    type: string;
    agentSessionId?: string;
  };
  eventRelay: {
    type: string;
    agentSessionId?: string;
    event?: Record<string, unknown>;
  };
  sessionsUpdateAfterReconnect: {
    type: string;
    sessions: unknown[];
  };
};

export type BoardYjsHostProxyFixture = ContractFixture & {
  cardinality: {
    zeroHostsStatus: number;
    twoHostsStatus: number;
    oneHostStatus: number;
  };
  proxy: {
    method: "POST";
    route: string;
    upstreamPath: string;
    forwardedHeaders: string[];
  };
  directOperations: Array<{
    operation: string;
    body: Record<string, unknown>;
  }>;
  negativeAssertions: string[];
};

export type DbFunctionContractFixture = ContractFixture & {
  functions: Array<{
    name: string;
    args: string;
    returns?: string;
    returnsContains?: string[];
  }>;
};

export type OrchContractFixtures = {
  routeInventory: RouteInventoryFixture;
  upstreamWsWire: UpstreamWsWireFixture;
  sseReplayGap: SseReplayGapFixture;
  fakeNodeReconnect: FakeNodeReconnectFixture;
  boardYjsHostProxy: BoardYjsHostProxyFixture;
  dbFunctionContract: DbFunctionContractFixture;
};
