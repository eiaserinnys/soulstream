import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { NodeRegistryEvent } from "../node/registry_types.js";
import {
  PendingNodeCommandRejectedError,
  type ClaudeCentralPoolSyncNodeCommandPayload,
  type NodeCommandResponse,
} from "../node/pending_commands.js";
import { supportsClaudeAccountPool } from "../node/registry_helpers.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";

import type { ClaudeCentralSettingsRepository } from "./settings_repository.js";
import type {
  ClaudeCentralAccountRecord,
  ClaudeCentralPoolSyncAccount,
  ClaudeCentralUsageObservation,
} from "./types.js";

const DEFAULT_SYNC_TIMEOUT_MS = 10_000;

export type ClaudeCentralPoolSyncServiceOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly bridge: Pick<SessionCommandTransportBridge, "sendPendingCommand">;
  readonly settings: Pick<ClaudeCentralSettingsRepository, "read">;
  readonly listAccounts: () => Promise<readonly ClaudeCentralPoolSyncAccount[]>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onWarning?: (message: string, error?: unknown) => void;
};

type Deferred<TValue> = {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
};

/** 한 노드로 가는 전송을 직렬화하고, 도는 동안 들어온 요청을 하나로 합친다. */
type NodeSendQueue = {
  running: boolean;
  followUp: Deferred<boolean> | null;
};

/**
 * 중앙 계정 스냅샷을 `claude_central_pool_sync` pending command로 보낸다.
 * 이 명령은 wire-schema의 ControlCommandType에 있고, 송신 payload는
 * pending_commands의 `ClaudeCentralPoolSyncNodeCommandPayload` 타입을 쓴다.
 * 계약의 칸 이름은 바꾸지 않는다.
 */
export class ClaudeCentralPoolSyncService {
  private readonly registry: InMemoryNodeRegistry;
  private readonly bridge: Pick<SessionCommandTransportBridge, "sendPendingCommand">;
  private readonly settings: Pick<ClaudeCentralSettingsRepository, "read">;
  private readonly listAccounts: () => Promise<readonly ClaudeCentralPoolSyncAccount[]>;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onWarning?: (message: string, error?: unknown) => void;
  /** 명령을 모르는 노드에 경고를 한 번만 남기기 위한 연결별 기록. */
  private readonly warnedConnections = new Map<string, string>();
  private readonly sendQueues = new Map<string, NodeSendQueue>();
  /** 같은 서비스 안에서 revision이 늘 앞의 값보다 크도록 마지막 값을 기억한다. */
  private lastRevision = 0;

  constructor(options: ClaudeCentralPoolSyncServiceOptions) {
    this.registry = options.registry;
    this.bridge = options.bridge;
    this.settings = options.settings;
    this.listAccounts = options.listAccounts;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
  }

  /** 연결된 풀 지원 노드 전부에 보낸다. 한 노드 실패가 다른 노드를 막지 않는다. */
  async sendAll(): Promise<void> {
    const nodes = this.registry.listConnectedNodes()
      .filter((node) => supportsClaudeAccountPool(node.capabilities));
    await Promise.all(nodes.map((node) => this.sendToNode(node.nodeId)));
  }

  /**
   * 노드마다 전송을 하나씩 직렬화한다. 전송이 도는 동안 들어온 요청은 하나로 합쳐,
   * 끝난 뒤 설정과 계정을 새로 읽어 한 번 더 보낸다. 돌려주는 promise는 부른 시점
   * 이후의 설정을 읽은 전송이 끝나야 풀린다.
   */
  async sendToNode(nodeId: string): Promise<boolean> {
    if (!this.canSend(nodeId)) return false;

    const queue = this.sendQueue(nodeId);
    if (queue.running) {
      queue.followUp ??= createDeferred<boolean>();
      return queue.followUp.promise;
    }
    queue.running = true;
    return this.runSendQueue(nodeId, queue);
  }

  /** 노드 등록 이벤트(ack 직후)에 한 번 보낸다. 새 연결은 경고 기록을 지운다. */
  acceptNodeEvents(events: readonly NodeRegistryEvent[]): void {
    for (const event of events) {
      if (event.type !== "node_registered") continue;
      this.warnedConnections.delete(event.nodeId);
      const nodeId = event.nodeId;
      queueMicrotask(() => {
        void this.sendToNode(nodeId).catch((error: unknown) => {
          this.warn(`claude_central_pool_sync failed for node ${nodeId}`, error);
        });
      });
    }
  }

  private async runSendQueue(nodeId: string, queue: NodeSendQueue): Promise<boolean> {
    try {
      let result = await this.sendOnce(nodeId);
      while (queue.followUp !== null) {
        const followUp = queue.followUp;
        queue.followUp = null;
        result = await this.sendOnce(nodeId);
        followUp.resolve(result);
      }
      return result;
    } catch (error) {
      // 예상 밖 오류로도 기다리는 요청을 붙잡아 두지 않는다.
      this.warn(`claude_central_pool_sync failed for node ${nodeId}`, error);
      const followUp = queue.followUp;
      queue.followUp = null;
      followUp?.resolve(false);
      return false;
    } finally {
      queue.running = false;
      if (queue.followUp === null && this.sendQueues.get(nodeId) === queue) {
        this.sendQueues.delete(nodeId);
      }
    }
  }

  private async sendOnce(nodeId: string): Promise<boolean> {
    if (!this.canSend(nodeId)) return false;
    const node = this.registry.getConnectedNode(nodeId);
    if (node === undefined) return false;

    try {
      // revision은 설정을 읽기 전에 매긴다. 설정을 끄기 전에 시작한 전송이 더 큰
      // revision으로 계정을 되살리지 않도록, 같은 서비스 안에서 늘 앞의 값보다 크다.
      const revision = this.nextRevision();
      const settings = await this.settings.read();
      const receive = settings.nodes[nodeId] ?? settings.default_receive;
      const accounts = receive ? [...await this.listAccounts()] : [];
      const payload: ClaudeCentralPoolSyncNodeCommandPayload = {
        type: "claude_central_pool_sync",
        revision,
        receive,
        accounts,
      };
      const command = this.registry.createCommand(
        nodeId,
        payload,
        { timeoutMs: this.timeoutMs },
      );
      const response = await this.bridge.sendPendingCommand({ node, command });
      if (response.success === false) {
        const message = responseMessage(response);
        if (isUnsupportedMessage(message)) {
          this.warnUnsupported(nodeId, node.connectionId, message);
          return false;
        }
        this.warn(`claude_central_pool_sync was rejected by node ${nodeId}: ${message}`);
        return false;
      }
      return true;
    } catch (error) {
      if (isUnsupportedCommandError(error)) {
        this.warnUnsupported(nodeId, node.connectionId, unsupportedErrorMessage(error));
        return false;
      }
      this.warn(`claude_central_pool_sync failed for node ${nodeId}`, error);
      return false;
    }
  }

  private canSend(nodeId: string): boolean {
    const node = this.registry.getConnectedNode(nodeId);
    if (node === undefined || !supportsClaudeAccountPool(node.capabilities)) return false;
    return this.warnedConnections.get(nodeId) !== node.connectionId;
  }

  private sendQueue(nodeId: string): NodeSendQueue {
    let queue = this.sendQueues.get(nodeId);
    if (queue === undefined) {
      queue = { running: false, followUp: null };
      this.sendQueues.set(nodeId, queue);
    }
    return queue;
  }

  private nextRevision(): number {
    const candidate = this.now();
    this.lastRevision = candidate > this.lastRevision ? candidate : this.lastRevision + 1;
    return this.lastRevision;
  }

  private warnUnsupported(nodeId: string, connectionId: string, detail: string): void {
    this.warnedConnections.set(nodeId, connectionId);
    this.warn(
      `node ${nodeId} does not implement claude_central_pool_sync (${detail}); `
        + "central pool sync is disabled for this connection",
    );
  }

  private warn(message: string, error?: unknown): void {
    try {
      this.onWarning?.(message, error);
    } catch {
      // 경고 통지 실패가 동기화를 막지 않는다.
    }
  }
}

export function toPoolSyncAccount(input: {
  readonly record: ClaudeCentralAccountRecord;
  readonly observation: ClaudeCentralUsageObservation | null;
}): ClaudeCentralPoolSyncAccount {
  const { record, observation } = input;
  const withholdsToken = record.authState === "needs_relogin" || !record.enabled;
  return {
    id: record.id,
    email: record.email,
    plan: record.plan,
    enabled: record.enabled,
    priority: record.priority,
    auth_state: record.authState,
    relogin_reason: record.reloginReason,
    access_token: withholdsToken ? null : record.accessToken,
    expires_at: record.expiresAt,
    usage_raw: observation?.raw ?? null,
    usage_fetched_at: observation?.fetched_at ?? null,
  };
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isUnsupportedCommandError(error: unknown): boolean {
  if (!(error instanceof PendingNodeCommandRejectedError)) return false;
  if (error.response?.code === "CONTROL_COMMAND_NOT_IN_INVENTORY") return true;
  return isUnsupportedMessage(responseMessage(error.response) || error.message);
}

function unsupportedErrorMessage(error: unknown): string {
  if (error instanceof PendingNodeCommandRejectedError) {
    return responseMessage(error.response) || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedMessage(message: string): boolean {
  return /not implemented|unknown command/i.test(message);
}

function responseMessage(response: NodeCommandResponse | undefined): string {
  if (response === undefined) return "";
  if (typeof response.message === "string") return response.message;
  if (typeof response.error === "string") return response.error;
  return "";
}
