import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Webhook } from "standardwebhooks";
import { constantTimeStringEqual } from "../security/constant_time_string_equal.js";
import { eventName, identitySchema, maxLeaseMs, subscribeSchema, type SubscriptionRecord } from "./contracts.js";
import { SubscriptionStore } from "./store.js";
import { postWebhook, WebhookError, type WebhookPost } from "./webhook_transport.js";
export { eventName } from "./contracts.js";

export function credentialOwner(path: string, credential: string) {
  return createHash("sha256").update(JSON.stringify(["soulstream.external.events", path, credential])).digest("hex");
}
function subscriptionId(owner: string, request: ReturnType<typeof identitySchema.parse>) {
  return "sub_" + createHash("sha256").update(JSON.stringify([owner, request.name, request.arguments.recipient_label, request.delivery.url])).digest("hex");
}
const noRecipient = { ok: false as const, status: "not_sent" as const, reason: "no_active_recipient" };
export class ExternalEventsService {
  private constructor(private readonly store: SubscriptionStore, readonly owner: string,
    private readonly post: WebhookPost, private readonly now: () => number) {}
  static async open(options: { path: string; owner: string; post?: WebhookPost; now?: () => number }) {
    return new ExternalEventsService(await SubscriptionStore.open(options.path), options.owner, options.post ?? postWebhook, options.now ?? Date.now);
  }
  private valid(record: SubscriptionRecord | undefined): record is SubscriptionRecord {
    return Boolean(record && record.owner === this.owner && record.active && record.expiresAt > this.now());
  }
  recipients() {
    return this.store.values().filter(record => this.valid(record)).map(record => ({
      recipient_id: record.id, recipient_label: record.arguments.recipient_label,
      expires_at: new Date(record.expiresAt).toISOString(),
      ...(record.lastDelivery ? { last_delivery: record.lastDelivery } : {}),
    }));
  }
  private headers(secret: string, id: string, eventId: string, body: string, previous?: SubscriptionRecord["previousSecret"]) {
    const signedAt = new Date();
    const signatures = [new Webhook(secret).sign(eventId, signedAt, body)];
    if (previous && previous.until > this.now()) signatures.push(new Webhook(previous.secret).sign(eventId, signedAt, body));
    return { "Content-Type": "application/json", "webhook-id": eventId,
      "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
      "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": id };
  }
  async subscribe(input: unknown) {
    const request = subscribeSchema.parse(input);
    const id = subscriptionId(this.owner, request);
    const previous = this.store.get(id);
    const verifiedAt = this.now();
    // Reuse only this owner's recent, still-active verification of the same URL and key.
    const cached = this.valid(previous) && previous.secret === request.delivery.secret && verifiedAt - previous.verifiedAt <= 300_000;
    if (!cached) {
      const challenge = randomUUID(); const body = JSON.stringify({ type: "verification", challenge });
      try {
        const response = await this.post(request.delivery.url, body, this.headers(request.delivery.secret, id, "verification_" + randomUUID(), body));
        const echo: unknown = JSON.parse(response.body);
        if (response.status < 200 || response.status >= 300 || !echo || typeof echo !== "object"
          || !("challenge" in echo) || typeof echo.challenge !== "string" || !constantTimeStringEqual(challenge, echo.challenge)) throw new Error();
      } catch { throw new WebhookError("verification_failed"); }
    }
    const expiresAt = this.now() + Math.min(request.ttlMs ?? maxLeaseMs, maxLeaseMs);
    await this.store.update(id, current => ({ id, owner: this.owner, arguments: request.arguments,
      callback: request.delivery.url, secret: request.delivery.secret, expiresAt, active: true,
      verifiedAt: cached ? previous!.verifiedAt : verifiedAt,
      ...(current && this.valid(current) && current.secret !== request.delivery.secret
        ? { previousSecret: { secret: current.secret, until: this.now() + 60_000 } }
        : current?.previousSecret ? { previousSecret: current.previousSecret } : {}),
      ...(current?.lastDelivery ? { lastDelivery: current.lastDelivery } : {}),
    }));
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }
  async unsubscribe(input: unknown) {
    const request = identitySchema.parse(input);
    await this.store.update(subscriptionId(this.owner, request), () => undefined);
    return {};
  }
  async send(id: string, text: string, senderSessionId: string, title?: string) {
    const record = this.store.get(id);
    if (!this.valid(record)) return noRecipient;
    const eventId = "evt_" + randomUUID(); const sentAt = new Date(this.now()).toISOString();
    const body = JSON.stringify({ eventId, name: eventName, timestamp: sentAt, data: {
      message_id: eventId, text, ...(title !== undefined ? { title } : {}), sender_session_id: senderSessionId, sent_at: sentAt,
    }, cursor: null });
    let reason = "payload_too_large"; let status: number | undefined; let accepted = false;
    if (Buffer.byteLength(body) <= 262_144) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!this.valid(this.store.get(id))) return noRecipient;
        let transient = false;
        try {
          const response = await this.post(record.callback, body, this.headers(record.secret, id, eventId, body, record.previousSecret));
          status = response.status; accepted = status >= 200 && status < 300; reason = `http_${status}`;
          transient = status === 429 || status >= 500;
        } catch (error) {
          reason = error instanceof WebhookError ? error.reason : "network_error";
          transient = error instanceof WebhookError && error.transient;
        }
        if (accepted || !transient || attempt === 2) break;
        await delay(250 * 2 ** attempt);
      }
    }
    const delivery = { status: accepted ? "accepted_by_receiver" as const : "delivery_failed" as const,
      time: new Date(this.now()).toISOString(), ...(status !== undefined ? { http_status: status } : {}),
      ...(!accepted ? { reason } : {}) };
    await this.store.update(id, current => current ? { ...current, lastDelivery: delivery, active: current.active && status !== 410 } : undefined);
    return { ok: accepted, status: delivery.status, event_id: eventId, ...(status !== undefined ? { http_status: status } : {}),
      ...(accepted ? { receipt: "Accepted by receiver; reading and processing are not confirmed." } : { reason }) };
  }
}
