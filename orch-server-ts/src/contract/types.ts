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
      type: string;
      agentSessionId: string;
      inputRequestId: string;
      answers: Record<string, unknown>;
      requestId: string;
      requestIdMustNotEqual: string;
    };
    subscribeEvents: {
      type: string;
      agentSessionId: string;
      subscribeId: string;
      requestId: string;
      fireAndForget: boolean;
    };
  };
  inbound: Record<string, unknown>;
};

export type SseReplayGapFixture = ContractFixture & {
  common: {
    snapshotRefetchOn: string[];
  };
  sessionStream: {
    expectedReplayEventIds: number[];
  };
  taskStream: {
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
  ack: {
    type: string;
  };
  eventRelay: {
    type: string;
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
    forwardedHeaders: string[];
  };
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
