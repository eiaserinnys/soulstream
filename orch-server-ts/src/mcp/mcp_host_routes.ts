import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { McpHostOptions } from "./types.js";
import { executeMcpTool, findMcpTool } from "./tool_executor.js";

export const mcpHostRouteAuthRequirements = { "POST /api/mcp/host/:tool": true } as const;

const requestSchema = z.object({
  args: z.record(z.string(), z.unknown()),
  context: z.object({ principal: z.enum(["internal", "external"]), caller_session_id: z.string().nullable(), node_id: z.string().min(1),
    execution: z.object({ registrationId: z.string().min(1), executionCommandId: z.string().min(1) }).strict().optional() }),
});

export function registerMcpHostRoutes(app: FastifyInstance, options: McpHostOptions): void {
  app.post<{ Params: { tool: string } }>("/api/mcp/host/:tool", async (request, reply) => {
    const authorization = verifyServiceBearerAuthorization(request.headers.authorization, options.authBearerToken, options.environment);
    if (!authorization.ok) return reply.code(authorization.statusCode).send({ detail: { error: { code: "UNAUTHORIZED", message: `bearer token is ${authorization.reason}` } } });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ detail: { error: { code: "INVALID_MCP_REQUEST", message: parsed.error.message } } });
    const definition = findMcpTool(request.params.tool);
    if (!definition) return reply.code(404).send({ detail: { error: { code: "MCP_TOOL_NOT_FOUND", message: `unknown tool: ${request.params.tool}` } } });
    const { args, context } = parsed.data;
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    const onClosed = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", onAborted);
    reply.raw.once("close", onClosed);
    try {
    return reply.send(await executeMcpTool(options, definition.name, args, {
      principal: context.principal, callerSessionId: context.caller_session_id, nodeId: context.node_id,
      execution: context.execution,
      signal: controller.signal,
    }));
    } finally {
      request.raw.removeListener("aborted", onAborted);
      reply.raw.removeListener("close", onClosed);
    }
  });
}
