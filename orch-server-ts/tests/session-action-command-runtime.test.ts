import { hashDeliveryPayload } from "@soulstream/wire-schema/delivery";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createOrchestratorRuntimeComposition,
  parseOrchServerConfig,
  registerSessionActionCommandRoutes,
  type SessionActionCommandRouteOptions,
} from "../src/index.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session action command runtime opt-in", () => {
  it("keeps routes off in runtime composition unless explicitly enabled", async () => {
    const disabled = createOrchestratorRuntimeComposition({
      config,
      loadSessionSnapshot: async () => ({ sessions: [] }),
    });

    const disabledResponse = await disabled.app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/intervene",
      payload: { text: "hello" },
    });
    expect(disabledResponse.statusCode).toBe(404);
    expect(disabledResponse.json()).not.toMatchObject({
      error: { code: "SESSION_OWNER_MISSING" },
    });
    expect(disabled.routeOptions.sessionActionCommandRoutes).toBeUndefined();
    await disabled.app.close();

    const enabled = createOrchestratorRuntimeComposition({
      config,
      enableSessionActionCommandRoutes: true,
      loadSessionSnapshot: async () => ({ sessions: [] }),
    });

    const enabledResponse = await enabled.app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/intervene",
      payload: { text: "hello" },
    });
    expect(enabledResponse.statusCode).toBe(404);
    expect(enabledResponse.json()).toMatchObject({
      error: { code: "SESSION_OWNER_MISSING" },
    });
    expect(enabled.routeOptions.sessionActionCommandRoutes).toBeDefined();
    await enabled.app.close();
  });
});

describe("session intervention attachment admission", () => {
  const deliveryId = "99999999-9999-4999-8999-999999999999";
  const binding = { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" };

  function makeApp(admitAttachmentInput?: SessionActionCommandRouteOptions["admitAttachmentInput"]) {
    const { router, bridge } = createHarnessCore();
    const commands: Array<Record<string, any>> = [];
    const route = vi.spyOn(router, "routeExistingSessionPendingCommand").mockImplementation(
      async (payload: unknown) => {
        commands.push(payload as Record<string, any>);
        return payload as never;
      },
    );
    const send = vi.spyOn(bridge, "sendPendingCommand").mockResolvedValue(
      { type: "intervene_ack", status: "ok" } as never,
    );
    const hashes = new Map<string, string>();
    const register = vi.fn(async (params: Record<string, any>) => {
      const known = hashes.get(params.deliveryId);
      if (known === undefined) hashes.set(params.deliveryId, params.payloadHash);
      return {
        inserted: known === undefined,
        conflict: known !== undefined && known !== params.payloadHash,
        row: { delivery_id: params.deliveryId, state: "pending", aggregate_state: "pending" },
      };
    });
    const app = createApp({ config });
    registerSessionActionCommandRoutes(app, {
      router,
      bridge,
      deliveryRepositoryProvider: async () => ({ register }),
      ...(admitAttachmentInput === undefined ? {} : { admitAttachmentInput }),
    } as unknown as SessionActionCommandRouteOptions);
    return { app, register, route, send, commands };
  }

  const intervene = (app: ReturnType<typeof createApp>, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/intervene",
      payload: {
        user: "operator",
        delivery_id: deliveryId,
        delivery_intent: "human_live_steer",
        source: "browser",
        ...payload,
      },
    });

  it("admits paths before registering the hash and sending the worker command", async () => {
    const requestBody = {
      text: "see file",
      attachment_paths: ["/tmp/a.png"],
      caller_info: { source: "browser", email: "spoof@example.com" },
    };
    let seenCaller: FastifyRequest | undefined;
    const admit = vi.fn(async (caller: unknown, input: { attachmentPaths?: string[] }) => {
      seenCaller = caller as FastifyRequest;
      return {
        attachment_ids: ["att-a"],
        attachment_paths: input.attachmentPaths ?? [],
        attachment_bindings: [binding],
      };
    });
    const { app, register, route, send, commands } = makeApp(admit);

    const response = await intervene(app, requestBody);

    expect(response.statusCode).toBe(200);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![1]).toEqual({
      sessionId: "sess-1",
      attachmentPaths: ["/tmp/a.png"],
    });
    const stored = register.mock.calls[0]![0];
    expect(stored.payload).toMatchObject({
      attachment_paths: ["/tmp/a.png"],
      attachment_ids: ["att-a"],
      attachment_bindings: [binding],
    });
    expect(stored.payloadHash).toBe(hashDeliveryPayload({
      ...stored.payload,
      source: stored.source,
      completion_id: stored.completionId,
      relation_key: stored.relationKey,
    }));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      attachment_paths: ["/tmp/a.png"],
      attachment_ids: stored.payload.attachment_ids,
      attachment_bindings: stored.payload.attachment_bindings,
    });
    expect(admit.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[0]!);
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(route.mock.invocationCallOrder[0]!);
    expect(send).toHaveBeenCalledTimes(1);
    expect(seenCaller!.body).toMatchObject(requestBody);
    expect(seenCaller!.body).not.toHaveProperty("attachment_ids");
    expect(seenCaller!.body).not.toHaveProperty("attachment_bindings");
    await app.close();
  });

  it("skips the admission callback for a text-only message", async () => {
    const admit = vi.fn();
    const { app, register } = makeApp(admit);

    const response = await intervene(app, { text: "hello" });

    expect(response.statusCode).toBe(200);
    expect(admit).not.toHaveBeenCalled();
    expect(register.mock.calls[0]![0].payload).not.toHaveProperty("attachment_ids");
    await app.close();
  });

  it("keeps the admission failure status and sends nothing to the worker", async () => {
    const denied = Object.assign(new Error("Attachment access denied"), {
      code: "ATTACHMENT_ACCESS_DENIED",
      statusCode: 403,
    });
    const { app, register, route, send } = makeApp(vi.fn(async () => { throw denied; }));

    const response = await intervene(app, { text: "x", attachment_ids: ["att-a"] });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "ATTACHMENT_ACCESS_DENIED", message: "Attachment access denied" },
    });
    expect(register).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the existing 409 when the same delivery id carries different ids", async () => {
    const { app, route } = makeApp(vi.fn(async (_caller: unknown, input: { attachmentIds?: string[] }) => ({
      attachment_ids: input.attachmentIds ?? [],
      attachment_paths: [],
      attachment_bindings: [],
    })));

    const first = await intervene(app, { text: "same", attachment_ids: ["att-a"] });
    const second = await intervene(app, { text: "same", attachment_ids: ["att-b"] });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: "DELIVERY_IDENTITY_CONFLICT", deliveryId },
    });
    expect(route).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("refuses ids without a callback but still sends path-only messages", async () => {
    const { app, register, route, commands } = makeApp();

    const withIds = await intervene(app, { text: "x", attachment_ids: ["att-a"] });
    expect(withIds.statusCode).toBe(503);
    expect(withIds.json()).toMatchObject({ error: { code: "ATTACHMENT_INPUT_UNAVAILABLE" } });
    expect(register).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();

    const pathOnly = await intervene(app, { text: "x", attachment_paths: ["/tmp/a.png"] });
    expect(pathOnly.statusCode).toBe(200);
    expect(commands[0]).toMatchObject({ attachment_paths: ["/tmp/a.png"] });
    expect(commands[0]).not.toHaveProperty("attachment_ids");
    await app.close();
  });

  it("rejects request bindings with 400 before admission", async () => {
    const admit = vi.fn();
    const { app, register } = makeApp(admit);

    const response = await intervene(app, {
      text: "x",
      attachment_ids: ["att-a"],
      attachment_bindings: [binding],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(admit).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    await app.close();
  });
});
