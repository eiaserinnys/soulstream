import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { NodeRegistryEvent } from "../node/registry_types.js";
import {
  PendingNodeCommandRejectedError,
  type NodeCommandResponse,
  type RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import { supportsClaudeAccountPool } from "../node/registry_helpers.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";

import type { ClaudeCentralSettingsRepository } from "./settings_repository.js";
import type {
  ClaudeCentralAccountRecord,
  ClaudeCentralPoolSyncAccount,
  ClaudeCentralPoolSyncPayload,
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

/**
 * 중앙 계정 스냅샷을 `claude_central_pool_sync` pending command로 보낸다.
 * 이 명령은 아직 wire-schema의 ControlCommandType에 없으므로(노드 단위가 같은
 * 계약으로 만든다) 전송 경계에서만 명시적 캐스트를 쓴다. 계약의 칸 이름은 바꾸지 않는다.
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

  async sendToNode(nodeId: string): Promise<boolean> {
    const node = this.registry.getConnectedNode(nodeId);
    if (node === undefined || !supportsClaudeAccountPool(node.capabilities)) return false;
    if (this.warnedConnections.get(nodeId) === node.connectionId) return false;

    try {
      const settings = await this.settings.read();
      const receive = settings.nodes[nodeId] ?? settings.default_receive;
      const accounts = receive ? await this.listAccounts() : [];
      const payload: ClaudeCentralPoolSyncPayload = {
        type: "claude_central_pool_sync",
        revision: this.now(),
        receive,
        accounts,
      };
      const command = this.registry.createCommand(
        nodeId,
        payload as unknown as RequestResponseNodeCommandPayload,
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
