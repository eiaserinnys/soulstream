import { createHash } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  agentPortraitUrl,
  type AgentPortraitRepository,
} from "../src/node/agent_portrait_model.js";
import { registerAgentPortraitRoutes } from "../src/node/agent_portrait_routes.js";
import { createFakeAgentPortraits } from "./fake_agent_portraits.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("roselin")]);
const pngSha = createHash("sha256").update(png).digest("hex");

function seeded() {
  return createFakeAgentPortraits([{ agentId: "roselin", body: png, mime: "image/png", sha256: pngSha }]);
}

function appWith(repository: AgentPortraitRepository) {
  const app = Fastify();
  registerAgentPortraitRoutes(app, { repository });
  return app;
}

describe("central agent portrait routes", () => {
  it("lists portraits with version urls, skips deletion markers and answers If-None-Match with 304", async () => {
    const repository = seeded();
    await repository.remove("blossom");
    const app = appWith(repository);

    const listed = await app.inject({ method: "GET", url: "/api/agent-portraits" });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("private, no-cache");
    expect(listed.json()).toEqual({
      portraits: [{
        agent_id: "roselin",
        sha256: pngSha,
        mime: "image/png",
        byte_size: png.length,
        updated_at: expect.any(String),
        url: `/api/agent-portraits/roselin?v=${pngSha}`,
      }],
    });

    const etag = String(listed.headers.etag);
    const again = await app.inject({ method: "GET", url: "/api/agent-portraits", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    await app.close();
  });

  it("serves bytes immutable only when v matches the current sha256", async () => {
    const app = appWith(seeded());

    const versioned = await app.inject({ method: "GET", url: `/api/agent-portraits/roselin?v=${pngSha}` });
    expect(versioned.statusCode).toBe(200);
    expect(versioned.headers["content-type"]).toContain("image/png");
    expect(versioned.headers.etag).toBe(`"${pngSha}"`);
    expect(versioned.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(versioned.rawPayload.equals(png)).toBe(true);

    for (const url of ["/api/agent-portraits/roselin", `/api/agent-portraits/roselin?v=${"0".repeat(64)}`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-cache");
      expect(response.rawPayload.equals(png)).toBe(true);
    }

    const conditional = await app.inject({
      method: "GET",
      url: `/api/agent-portraits/roselin?v=${pngSha}`,
      headers: { "if-none-match": `"${pngSha}"` },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.headers["cache-control"]).toBe("private, max-age=31536000, immutable");

    const head = await app.inject({ method: "HEAD", url: "/api/agent-portraits/roselin" });
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toBe(`"${pngSha}"`);
    expect(head.body).toBe("");

    expect((await app.inject({ method: "GET", url: "/api/agent-portraits/missing" })).statusCode).toBe(404);
    await app.close();
  });

  it("PUT validates and replaces, DELETE leaves a marker, and the list and url follow", async () => {
    const repository = createFakeAgentPortraits();
    const app = appWith(repository);
    const payload = { data_base64: png.toString("base64"), mime: "image/png", sha256: pngSha };

    const put = await app.inject({ method: "PUT", url: "/api/agent-portraits/blossom", payload });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ agent_id: "blossom", sha256: pngSha, url: `/api/agent-portraits/blossom?v=${pngSha}` });
    expect(agentPortraitUrl({ agentId: "blossom", sha256: pngSha })).toBe(put.json().url);

    const wrongMime = await app.inject({ method: "PUT", url: "/api/agent-portraits/blossom", payload: { ...payload, mime: "image/jpeg" } });
    expect(wrongMime.statusCode).toBe(422);
    const wrongSha = await app.inject({ method: "PUT", url: "/api/agent-portraits/blossom", payload: { ...payload, sha256: "f".repeat(64) } });
    expect(wrongSha.statusCode).toBe(422);

    expect((await app.inject({ method: "DELETE", url: "/api/agent-portraits/blossom" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/agent-portraits" })).json()).toEqual({ portraits: [] });
    expect((await app.inject({ method: "GET", url: "/api/agent-portraits/blossom" })).statusCode).toBe(404);
    expect(repository.hasRecord("blossom")).toBe(true);

    // 지운 기록도 다시 올리면 덮는다.
    expect((await app.inject({ method: "PUT", url: "/api/agent-portraits/blossom", payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agent-portraits/blossom" })).statusCode).toBe(200);
    await app.close();
  });

  it("old node and agent portrait urls serve the central bytes whatever the node id is", async () => {
    const app = appWith(seeded());

    for (const url of [
      "/api/nodes/eiaserinnys/agents/roselin/portrait",
      "/api/nodes/silent-manari-ts/agents/roselin/portrait",
      "/api/agents/roselin/portrait",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-cache");
      expect(response.headers.etag).toBe(`"${pngSha}"`);
      expect(response.rawPayload.equals(png)).toBe(true);
    }
    const conditional = await app.inject({
      method: "GET",
      url: "/api/nodes/eiaserinnys/agents/roselin/portrait",
      headers: { "if-none-match": `"${pngSha}"` },
    });
    expect(conditional.statusCode).toBe(304);
    expect((await app.inject({ method: "GET", url: "/api/nodes/silent-manari-ts/agents/nobody/portrait" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/agents/nobody/portrait" })).statusCode).toBe(204);
    await app.close();
  });
});
