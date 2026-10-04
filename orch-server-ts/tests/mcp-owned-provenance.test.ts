import { afterEach, expect, it, vi } from "vitest";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import { createSessionOwnerResolver } from "../src/session/session_owner.js";
import * as sessionRoutes from "../src/session/session_command_routes.js";
import type { McpHostOptions } from "../src/mcp/types.js";
afterEach(() => vi.restoreAllMocks());
it("remote delegation keeps actual agent labels and user_id while verifying human/external owner", async () => {
  const ownerEmail = "person@example.test";
  const rows: Record<string, Record<string, unknown>> = {
    human: { metadata: [{ type: "caller_info", value: { source: "browser", email: ownerEmail } }] },
    child: { caller_session_id: "human" },
    dot: { metadata: [{ type: "caller_info", value: { source: "dot", external_agent_id: "dot-agent", email: ownerEmail } }] },
    dotChild: { caller_session_id: "dot" },
  };
  const resolveSessionOwner = createSessionOwnerResolver({ getSession: async id => rows[id] ?? null,
    findUserByEmail: async email => email === ownerEmail ? { email, isAdmin: false, allowedFolderIds: [] } : null,
    findExternalAgent: async id => id === "dot-agent" ? { id, ownerEmail } : null });
  const create = vi.spyOn(sessionRoutes, "executeCreateSessionRoute").mockResolvedValue({ status: 201, body: {} });
  const options = { resolveSessionOwner, cluster: { sessions: {}, logger: { warn: vi.fn() } } } as unknown as McpHostOptions;
  const sender = { source: "agent", agent_id: "roselin", user_id: "roselin", agent_name: "로젤린", display_name: "로젤린",
    avatar_url: "/portrait", agent_node: "node", email: "untrusted@example.test" };
  for (const callerSessionId of ["child", "dotChild", "unknown"]) {
    const result = await executeMcpTool(options, "create_remote_agent_session", { prompt: "delegate", node_id: "node", folder_id: "folder" },
      { principal: "internal", callerSessionId, nodeId: "node", callerInfo: sender });
    expect(result.isError).not.toBe(true);
    const body = create.mock.calls.at(-1)![2] as Record<string, any>;
    const { email: _email, ...labels } = sender;
    expect(body.caller_info).toMatchObject(labels);
    if (callerSessionId === "unknown") expect(body.caller_info).not.toHaveProperty("email");
    else expect(body.caller_info.email).toBe(ownerEmail);
    if (callerSessionId === "dotChild") expect(body.caller_info.external_agent_id).toBe("dot-agent");
    rows[`new-${callerSessionId}`] = { caller_session_id: callerSessionId, metadata: [{ type: "caller_info", value: body.caller_info }] };
    if (callerSessionId !== "unknown") expect(await resolveSessionOwner(`new-${callerSessionId}`)).toMatchObject({ ownerEmail,
      callerInfo: { source: "agent", user_id: "roselin", agent_id: "roselin" } });
    else expect(await resolveSessionOwner(`new-${callerSessionId}`)).toBeNull();
  }
});
