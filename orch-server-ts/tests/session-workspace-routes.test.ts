import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerSessionWorkspaceRoutes } from "../src/session/session_workspace_routes.js";

describe("session workspace routes", () => {
  it("serves workspace and a byte range", async () => {
    const app = Fastify();
    registerSessionWorkspaceRoutes(app, {
      accessProvider: { requireSessionAccess: async () => ({ restricted: false }) } as never,
      provider: {
        readWorkspace: async () => ({ session_id: "s", root: "/repo", node: {id: "n", status: "ok"}, snapshot: {state: "pending"}, attribution: "partial", files: [], read_only: [] }) as never,
        readFile: async (_session, _path, offset, length) => ({content_b64: Buffer.from("abcdef".slice(offset, offset + length!)).toString("base64"), content_type: "text/plain", size: 6, offset, length: length!}),
      },
    });
    expect((await app.inject({method: "GET", url: "/api/sessions/s/workspace"})).json().snapshot.state).toBe("pending");
    const response = await app.inject({method: "GET", url: "/api/sessions/s/workspace/file?path=a.txt", headers: {range: "bytes=1-3"}});
    expect(response.statusCode).toBe(206); expect(response.headers["content-range"]).toBe("bytes 1-3/6"); expect(response.body).toBe("bcd");
    await app.close();
  });
});
