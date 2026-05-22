import type {
  AppServerNotification,
  AppServerServerRequest,
  InitializeParams,
  InitializeResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./protocol.js";
import {
  AppServerRpcError,
  JsonRpcAppServerClient,
  type AppServerTransport,
  type JsonRpcAppServerClientOptions,
} from "./transport.js";

export { AppServerRpcError };

export class CodexAppServerClient {
  private readonly rpc: JsonRpcAppServerClient;

  constructor(
    transport: AppServerTransport,
    options: JsonRpcAppServerClientOptions = {},
  ) {
    this.rpc = new JsonRpcAppServerClient(transport, options);
  }

  get pendingRequestCount(): number {
    return this.rpc.pendingRequestCount;
  }

  initialize(params: InitializeParams): Promise<InitializeResponse> {
    return this.rpc.request("initialize", params);
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.rpc.request("thread/start", params);
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.rpc.request("thread/resume", params);
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.rpc.request("turn/start", params);
  }

  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.rpc.request("turn/steer", params);
  }

  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.rpc.request("turn/interrupt", params);
  }

  onNotification(handler: (notification: AppServerNotification) => void): () => void {
    return this.rpc.onNotification((message) => {
      handler(message as AppServerNotification);
    });
  }

  onServerRequest(handler: (request: AppServerServerRequest) => void): () => void {
    return this.rpc.onServerRequest(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    return this.rpc.onError(handler);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}
