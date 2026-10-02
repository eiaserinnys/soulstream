import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { ExternalEventsService, eventName, credentialOwner } from "../../src/external_events/service.js";
import { resolvePublicCallback, postWebhook } from "../../src/external_events/webhook_transport.js";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const subscription = { name: "soulstream.message.created", arguments: { recipient_label: "primary-dot" },
  delivery: { mode: "webhook", url: "https://receiver.example/events", secret } };
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-events-")); paths.push(dir);
  let now = Date.now();
  const post = vi.fn(async (_url: string, body: string, headers: Record<string, string>) => {
    const payload = new Webhook(secret).verify(body, headers) as { type?: string; challenge?: string };
    return { status: 200, body: JSON.stringify(payload.type === "verification" ? { challenge: payload.challenge } : {}) };
  });
  const path = join(dir, "private", "subscriptions.json");
  const owner = credentialOwner("/mcp/dot", "token-one");
  const service = await ExternalEventsService.open({ path, owner, post, now: () => now });
  return { service, post, path, owner, advance: (ms: number) => { now += ms; } };
}
describe("external Events subscriptions and explicit delivery", () => {
  it("verifies signatures before activation, upserts deterministically, persists and sends one event", async () => {
    const f = await fixture();
    const a = await f.service.subscribe(subscription);
    const b = await f.service.subscribe({ ...subscription, ttlMs: 1_000 });
    expect(a.id).toBe(b.id);
    expect(f.service.recipients()).toEqual([expect.objectContaining({ recipient_id: a.id, recipient_label: "primary-dot" })]);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.path, ".."))).mode & 0o777).toBe(0o700);
    const reloaded = await ExternalEventsService.open({ path: f.path, owner: f.owner, post: f.post });
    expect(reloaded.recipients()).toHaveLength(1);
    expect(await reloaded.send(a.id, "hello", "session-test", "title")).toMatchObject({ ok: true, status: "accepted_by_receiver" });
    const body = JSON.parse(f.post.mock.calls.at(-1)![1]);
    expect(body).toMatchObject({ name: eventName, data: { text: "hello", sender_session_id: "session-test", title: "title" } });
    expect(JSON.stringify(reloaded.recipients())).not.toContain("receiver.example");
    expect(JSON.stringify(reloaded.recipients())).not.toContain(secret);
  });
  it("does not send to missing, expired, unsubscribed or previous credential subscriptions", async () => {
    const f = await fixture();
    expect(await f.service.send("missing", "text", "sender")).toEqual({ ok: false, status: "not_sent", reason: "no_active_recipient" });
    const a = await f.service.subscribe({ ...subscription, ttlMs: 100 });
    f.advance(101);
    expect((await f.service.send(a.id, "text", "sender")).status).toBe("not_sent");
    await f.service.subscribe(subscription);
    const rotated = await ExternalEventsService.open({ path: f.path, owner: credentialOwner("/mcp/dot", "token-two"), post: f.post });
    expect(rotated.recipients()).toEqual([]);
    expect((await rotated.send(a.id, "text", "sender")).status).toBe("not_sent");
    await f.service.unsubscribe(subscription);
    await f.service.unsubscribe(subscription);
    expect(f.service.recipients()).toEqual([]);
  });
  it("verifies a replacement secret and signs refresh deliveries with both keys for one minute", async () => {
    const f = await fixture(); const a = await f.service.subscribe(subscription);
    const replacement = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    f.post.mockImplementationOnce(async (_url, body, headers) => {
      const payload = new Webhook(replacement).verify(body, headers) as { challenge: string };
      return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    });
    await f.service.subscribe({ ...subscription, delivery: { ...subscription.delivery, secret: replacement } });
    expect((await f.service.send(a.id, "during rotation", "sender")).status).toBe("accepted_by_receiver");
    const call = f.post.mock.calls.at(-1)!;
    expect(() => new Webhook(secret).verify(call[1], call[2])).not.toThrow();
    expect(() => new Webhook(replacement).verify(call[1], call[2])).not.toThrow();
    f.advance(60_001);
    f.post.mockImplementationOnce(async (_url, body, headers) => {
      expect(() => new Webhook(replacement).verify(body, headers)).not.toThrow();
      expect(() => new Webhook(secret).verify(body, headers)).toThrow();
      return { status: 200, body: "{}" };
    });
    expect((await f.service.send(a.id, "after rotation", "sender")).status).toBe("accepted_by_receiver");
  });
  it("requires a verified echo, finite bounded leases and valid secrets", async () => {
    const f = await fixture();
    f.post.mockResolvedValueOnce({ status: 200, body: '{}' });
    await expect(f.service.subscribe(subscription)).rejects.toThrow("verification_failed");
    expect(f.service.recipients()).toEqual([]);
    await expect(f.service.subscribe({ ...subscription, delivery: { ...subscription.delivery, secret: "whsec_bad" } })).rejects.toThrow();
    const a = await f.service.subscribe({ ...subscription, ttlMs: null });
    expect(Date.parse(a.refreshBefore!) - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(a.refreshBefore).not.toBeNull();
  });
  it("retries only transient failures at most three times and deactivates on 410", async () => {
    const f = await fixture(); const a = await f.service.subscribe(subscription);
    f.post.mockClear();
    f.post.mockResolvedValueOnce({ status: 503, body: "secret URL" }).mockResolvedValueOnce({ status: 429, body: "" }).mockResolvedValueOnce({ status: 200, body: "" });
    expect((await f.service.send(a.id, "text", "sender")).status).toBe("accepted_by_receiver");
    expect(f.post).toHaveBeenCalledTimes(3);
    expect(new Set(f.post.mock.calls.map(call => call[2]["webhook-id"])).size).toBe(1);
    f.post.mockClear(); f.post.mockResolvedValueOnce({ status: 410, body: "private response" });
    expect(await f.service.send(a.id, "text", "sender")).toMatchObject({ status: "delivery_failed", reason: "http_410" });
    expect(f.post).toHaveBeenCalledTimes(1); expect(f.service.recipients()).toEqual([]);
  });
});
describe("webhook SSRF boundary", () => {
  it("rejects non-HTTPS and all private/literal/mapped addresses, including mixed DNS answers", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      await expect(resolvePublicCallback("https://receiver.example", async () => [{ address, family: address.includes(":") ? 6 : 4 }])).rejects.toThrow("unsafe_callback");
    }
    await expect(resolvePublicCallback("http://receiver.example")).rejects.toThrow("unsafe_callback");
    await expect(resolvePublicCallback("https://receiver.example", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }])).rejects.toThrow("unsafe_callback");
    expect((await resolvePublicCallback("https://receiver.example", async () => [{ address: "8.8.8.8", family: 4 }])).address).toBe("8.8.8.8");
  });
  it("pins the validated connection address and refuses redirects", async () => {
    const request = vi.fn((_url, options, callback) => {
      const response = new (requireEventEmitter())();
      response.statusCode = 302;
      const req = new (requireEventEmitter())();
      req.setTimeout = () => req; req.destroy = () => req;
      req.end = () => { callback(response); response.emit("end"); };
      options.lookup("receiver.example", {}, (_error: unknown, address: unknown) => { expect(address).toBe("8.8.8.8"); });
      expect(options.servername).toBe("receiver.example");
      return req;
    });
    await expect(postWebhook("https://receiver.example", "{}", {}, { resolve: async () => [{ address: "8.8.8.8", family: 4 }], request: request as never })).rejects.toThrow("redirect_forbidden");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
import { EventEmitter } from "node:events";
function requireEventEmitter() { return EventEmitter; }
