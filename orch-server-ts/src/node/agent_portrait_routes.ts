import { AGENT_PROFILE_PORTRAIT_UPLOAD_BODY_LIMIT_BYTES } from "@soulstream/agent-profile-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  IMMUTABLE_CACHE_CONTROL,
  PRIVATE_NO_CACHE,
  ifNoneMatchHit,
  sendWithEtag,
  sha256Etag,
} from "../http/conditional_cache.js";
import { projectAgentPortrait, type AgentPortraitRepository } from "./agent_portrait_model.js";
import { parsePortraitBytes } from "./agent_profile_routes.js";

export type AgentPortraitRouteOptions = {
  readonly repository: AgentPortraitRepository;
};

export const agentPortraitRouteAuthRequirements = {
  "GET /api/agent-portraits": true,
  "GET /api/agent-portraits/:agent_id": true,
  "HEAD /api/agent-portraits/:agent_id": true,
  "PUT /api/agent-portraits/:agent_id": true,
  "DELETE /api/agent-portraits/:agent_id": true,
  "GET /api/nodes/:node_id/agents/:agent_id/portrait": true,
  "GET /api/agents/:agent_id/portrait": true,
} as const;

type AgentParams = { agent_id: string };

export function registerAgentPortraitRoutes(
  app: FastifyInstance,
  options: AgentPortraitRouteOptions,
): void {
  const { repository } = options;

  app.get("/api/agent-portraits", async (request, reply) => {
    await repository.ready();
    const body = JSON.stringify({ portraits: repository.list().map(projectAgentPortrait) });
    return sendWithEtag(request, reply, {
      etag: sha256Etag(body),
      cacheControl: PRIVATE_NO_CACHE,
      contentType: "application/json; charset=utf-8",
      body,
    });
  });

  app.route<{ Params: AgentParams; Querystring: { v?: string } }>({
    method: ["GET", "HEAD"],
    url: "/api/agent-portraits/:agent_id",
    handler: async (request, reply) => {
      await repository.ready();
      const summary = repository.summary(request.params.agent_id);
      if (summary === null) return reply.code(404).send({ detail: "Portrait not found" });
      const etag = `"${summary.sha256}"`;
      const cacheControl = request.query.v === summary.sha256
        ? IMMUTABLE_CACHE_CONTROL
        : PRIVATE_NO_CACHE;
      reply.header("ETag", etag).header("Cache-Control", cacheControl);
      if (ifNoneMatchHit(request.headers["if-none-match"], etag)) return reply.code(304).send();
      reply.type(summary.mime);
      if (request.method === "HEAD") {
        return reply.header("Content-Length", summary.byteSize).send();
      }
      const content = await repository.get(summary.agentId);
      if (content === null) return reply.code(404).send({ detail: "Portrait not found" });
      return reply.send(content.body);
    },
  });

  app.put<{ Params: AgentParams }>(
    "/api/agent-portraits/:agent_id",
    { bodyLimit: AGENT_PROFILE_PORTRAIT_UPLOAD_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = parsePortraitBytes(request.body);
      if (!parsed.ok) return reply.code(422).send({ detail: parsed.error });
      await repository.ready();
      const summary = await repository.put({ agentId: request.params.agent_id, ...parsed.value });
      return reply.send(projectAgentPortrait(summary));
    },
  );

  app.delete<{ Params: AgentParams }>("/api/agent-portraits/:agent_id", async (request, reply) => {
    await repository.ready();
    await repository.remove(request.params.agent_id);
    return reply.code(204).send();
  });

  // 이미 나간 앱 빌드와 노드가 보낸 avatar_url이 쓰는 옛 주소. 노드와 상관없이 중앙 바이트를 준다.
  const sendLegacy = async (
    request: FastifyRequest<{ Params: AgentParams }>,
    reply: FastifyReply,
  ) => {
    await repository.ready();
    const summary = repository.summary(request.params.agent_id);
    if (summary === null) return reply.code(204).send();
    const etag = `"${summary.sha256}"`;
    if (ifNoneMatchHit(request.headers["if-none-match"], etag)) {
      return reply.header("ETag", etag).header("Cache-Control", PRIVATE_NO_CACHE).code(304).send();
    }
    const content = await repository.get(summary.agentId);
    if (content === null) return reply.code(204).send();
    return sendWithEtag(request, reply, {
      etag,
      cacheControl: PRIVATE_NO_CACHE,
      contentType: summary.mime,
      body: content.body,
    });
  };
  app.get<{ Params: AgentParams & { node_id: string } }>(
    "/api/nodes/:node_id/agents/:agent_id/portrait",
    sendLegacy,
  );
  app.get<{ Params: AgentParams }>("/api/agents/:agent_id/portrait", sendLegacy);
}
