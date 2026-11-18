import type { AuthUserAuthorizer } from "../auth/auth_routes.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { postWebhook, type WebhookPost } from "../external_events/webhook_transport.js";
import type { NodeRegistryEvent } from "../node/registry.js";
import {
  activeSubscriptionIdsForSession,
  publishDueSubscriptions,
  publishSubscription,
} from "./outbound_publisher.js";
import {
  generateSigningSecret,
  OutboundWebhookRepository,
} from "./outbound_repository.js";
import {
  sendDelivery,
  sendNextDueDelivery,
  type DeliveryAttemptOutcome,
  type OutboundSessionAccess,
} from "./outbound_sender.js";
import type {
  CreateSubscriptionInput,
  DeliveryState,
  RedeliverResult,
  WebhookDeliveryRow,
  WebhookSubscriptionSummary,
} from "./outbound_types.js";
import { sendVerificationChallenge } from "./verification_challenge.js";

export const OUTBOUND_SWEEP_INTERVAL_MS = 30_000;

export type OutboundWebhookServiceOptions = {
  resolveSql: () => Promise<SqlClient>;
  authorizeUser: AuthUserAuthorizer;
  requireSessionAccess: OutboundSessionAccess;
  post?: WebhookPost;
  now?: () => number;
  warn?: (message: string) => void;
  sweepIntervalMs?: number;
};

/**
 * Outbound webhook lifecycle: publishes stored session events into pending
 * deliveries and drains due deliveries one at a time. The 30 second sweep
 * covers events that never reach the node event hub.
 */
export class OutboundWebhookService {
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly options: OutboundWebhookServiceOptions) {
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? (() => undefined);
    this.sweepIntervalMs = options.sweepIntervalMs ?? OUTBOUND_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.enqueue(async () => await this.sweep()), this.sweepIntervalMs);
    this.timer.unref();
    this.enqueue(async () => await this.sweep());
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.pending;
  }

  /** Node event hub sink. Events without a session id are left to the sweep. */
  accept(events: readonly NodeRegistryEvent[]): void {
    if (!this.started) return;
    const sessionIds = new Set<string>();
    for (const event of events) {
      if (event.type !== "node_session_session_updated" || event.committedIngress !== true) {
        continue;
      }
      const sessionId = sessionIdFromEvent(event.data);
      if (sessionId !== undefined) sessionIds.add(sessionId);
    }
    if (sessionIds.size === 0) return;
    this.enqueue(async () => {
      const sql = await this.options.resolveSql();
      const at = new Date(this.now());
      for (const sessionId of sessionIds) {
        for (const subscriptionId of await activeSubscriptionIdsForSession(sql, sessionId)) {
          await publishSubscription(sql, subscriptionId, at);
        }
      }
      await this.drain(sql);
    });
  }

  /** One sweep: publish every due subscription, then drain due deliveries. */
  async sweep(): Promise<void> {
    const sql = await this.options.resolveSql();
    await publishDueSubscriptions(sql, new Date(this.now()));
    await this.drain(sql);
  }

  generateSigningSecret(): string {
    return generateSigningSecret();
  }

  /** Sends the registration challenge through the same transport as deliveries. */
  async verifyChallenge(url: string, secret: string): Promise<void> {
    await sendVerificationChallenge({
      post: this.options.post ?? postWebhook,
      url,
      secret,
      now: this.now,
    });
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const sql = await this.options.resolveSql();
    const rows = await sql`
      SELECT 1 FROM sessions WHERE session_id = ${sessionId} LIMIT 1
    `;
    return rows.length > 0;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<WebhookSubscriptionSummary> {
    return await this.repository().createSubscription(input);
  }

  async listSubscriptions(ownerEmail: string): Promise<WebhookSubscriptionSummary[]> {
    return await this.repository().listSubscriptions(ownerEmail);
  }

  async getSubscription(
    ownerEmail: string,
    subscriptionId: string,
  ): Promise<WebhookSubscriptionSummary | null> {
    return await this.repository().getSubscription(ownerEmail, subscriptionId);
  }

  async listDeliveries(
    ownerEmail: string,
    subscriptionId: string,
    options: { state?: DeliveryState; limit?: number } = {},
  ): Promise<WebhookDeliveryRow[]> {
    return await this.repository().listDeliveries(ownerEmail, subscriptionId, options);
  }

  async deleteSubscription(ownerEmail: string, subscriptionId: string): Promise<boolean> {
    return await this.repository().deleteSubscription(ownerEmail, subscriptionId);
  }

  async setActive(
    ownerEmail: string,
    subscriptionId: string,
    active: boolean,
  ): Promise<WebhookSubscriptionSummary | null> {
    return await this.repository().setActive(ownerEmail, subscriptionId, active);
  }

  async redeliver(
    ownerEmail: string,
    subscriptionId: string,
    deliveryId: string,
  ): Promise<RedeliverResult> {
    const reset = await this.repository().resetForRedelivery(ownerEmail, subscriptionId, deliveryId);
    if (!reset.ok) return reset;
    const sql = await this.options.resolveSql();
    const outcome: DeliveryAttemptOutcome = await sendDelivery(this.senderDependencies(sql), deliveryId);
    return { ok: true, outcome };
  }

  private repository(): OutboundWebhookRepository {
    return new OutboundWebhookRepository({
      resolveSql: this.options.resolveSql,
      now: this.now,
    });
  }

  private senderDependencies(sql: SqlClient) {
    return {
      sql,
      post: this.options.post ?? postWebhook,
      authorizeUser: this.options.authorizeUser,
      requireSessionAccess: this.options.requireSessionAccess,
      now: this.now,
    };
  }

  private async drain(sql: SqlClient): Promise<void> {
    const deps = this.senderDependencies(sql);
    while (this.started && await sendNextDueDelivery(deps)) {
      // One delivery at a time; each attempt records its own next attempt.
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.pending = this.pending
      .then(work)
      .catch((error: unknown) => this.warn(`outbound webhook: ${String(error)}`));
  }
}

function sessionIdFromEvent(data: Record<string, unknown>): string | undefined {
  const nested = data.session;
  const candidates: unknown[] = [
    data.agentSessionId,
    data.agent_session_id,
    data.sessionId,
    data.session_id,
  ];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const session = nested as Record<string, unknown>;
    candidates.push(
      session.agentSessionId,
      session.agent_session_id,
      session.sessionId,
      session.session_id,
    );
  }
  return candidates.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
