export type FullSliceScenario =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8";
export type FullSliceBackend = "claude" | "codex";

export interface PublicHttpAck {
  operation: "create" | "intervene";
  status: number;
  body: Record<string, unknown>;
  deliveryId: string | null;
}

export interface RunnerIdentityObservation {
  registrationId: string;
  pid: number;
  startIdentity: string;
  alive: boolean;
}

export interface ExecuteFramesProbeObservation {
  call: "executeFrames";
  scenario: FullSliceScenario;
  backend: FullSliceBackend;
  pid: number;
  prompt: string;
  resumeSessionId: string | null;
}

export interface InterveneProbeObservation {
  call: "intervene";
  scenario: FullSliceScenario;
  backend: FullSliceBackend;
  pid: number;
  prompt: string;
  result: {
    status: string;
    mechanism: string;
    reason?: string;
  };
}

export interface InterruptProbeObservation {
  call: "interrupt";
  scenario: FullSliceScenario;
  backend: FullSliceBackend;
  pid: number;
}

export type EngineBoundaryProbeObservation =
  | ExecuteFramesProbeObservation
  | InterveneProbeObservation
  | InterruptProbeObservation;

export interface DeliveryObservation {
  rowCount: number;
  deliveryId: string;
  targetSessionId: string;
  state: string;
  aggregateState: string;
  consumedAt: string | null;
}

export interface FullSliceObservation {
  scenario: FullSliceScenario;
  backend: FullSliceBackend;
  sessionId: string;
  publicAcks: PublicHttpAck[];
  restart: {
    beforeConnectionId: string;
    afterConnectionId: string;
  } | null;
  runner: {
    first: RunnerIdentityObservation;
    reattached: RunnerIdentityObservation | null;
    successor: RunnerIdentityObservation | null;
    firstAliveAfterInitialTerminal: boolean | null;
  };
  silentWindow: {
    runnerAlive: boolean;
    sessionEndedCount: number;
    errorEventCount: number;
  } | null;
  engineBoundaryProbes: EngineBoundaryProbeObservation[];
  delivery: DeliveryObservation | null;
  durable: {
    status: string;
    assistantContents: string[];
    userMessageTexts: string[];
    interventionSentTexts: string[];
    sessionEndedCount: number;
    errorEventCount: number;
    completionNotificationCount: number;
    unfinishedDeliveryCount: number;
    ghostRunningCount: number;
  };
}
