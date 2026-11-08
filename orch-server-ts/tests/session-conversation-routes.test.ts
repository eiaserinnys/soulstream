import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSessionConversationRoute } from "../src/session/session_conversation_routes.js";

describe("session conversation route", () => {
  it("checks access before reading and returns the projected conversation", async () => {
    const app = Fastify();
    const read = vi.fn(async (sessionId: string) => ({ sessionId, session: null, busy: false, tool: null, items: [] }));
    const ensureAccess = vi.fn(async (request, reply) => {
      if (request.headers.authorization === "allowed") return true;
      reply.code(403).send({ detail: "forbidden" });
      return false;
    });
    registerSessionConversationRoute(app, { read, ensureAccess });
    expect((await app.inject({ method: "GET", url: "/api/sessions/a/conversation" })).statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
    const response = await app.inject({ method: "GET", url: "/api/sessions/a/conversation?limit=50", headers: { authorization: "allowed" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: "a", session: null, busy: false, tool: null, items: [] });
    expect(read).toHaveBeenCalledWith("a", "50");
    await app.close();
  });
});
