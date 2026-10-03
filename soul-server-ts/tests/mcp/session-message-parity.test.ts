import { STATUS_CODES } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResult, type McpToolName } from "@soulstream/mcp-contract";
import { createActionHarness } from "../../../orch-server-ts/tests/session-action-command-test-helpers.js";
import { executeMcpTool } from "../../../orch-server-ts/src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../../../orch-server-ts/src/mcp/types.js";
import { PendingNodeCommandTimeoutError } from "../../../orch-server-ts/src/node/pending_commands.js";
import { sendMessageToSession } from "../../src/task/session_message_sender.js";

// Reuses the action-route harness: real owner routing, pending commands and ACK transport.
describe("session message worker remote and orchestrator parity", () => {
  afterEach(() => vi.restoreAllMocks());
  const external: McpCallContext = { principal: "external", callerSessionId: null, nodeId: "orch",
    externalCaller: { source: "llm", displayName: "닷" } };
  it.each([
    ["running", { delivered: true, outcome: "intervened", reason: "live", consumeWhen: "now" }],
    ["idle", { delivered: true, outcome: "auto_resumed", reason: "resumed", consumeWhen: "now" }],
    ["queued", { delivered: false, outcome: "queued", reason: "next_turn_required", consume_when: "next_turn", queue_position: 2 }],
    ["unknown", {}],
    ["missing", {}],
    ["rejected", { status: "error", code: "SESSION_NOT_FOUND", message: "Task not found" }],
  ])("preserves the whole result for %s", async (state, ack) => {
    const harness = createActionHarness({ createSession: state !== "missing", ackFor: () => ack });
    try {
      const next = await executeMcpTool({ sessionMessages: { router: harness.router, bridge: harness.bridge } } as unknown as McpHostOptions,
        "send_message_to_session" as McpToolName, { target_session_id: "sess-contract", message: "같은 메시지" }, external);
      const callerInfo = harness.sent.at(-1)?.caller_info;
      const fetchImpl: typeof fetch = async (_url, init) => {
        const response = await harness.app.inject({ method: "POST", url: "/api/sessions/sess-contract/intervene",
          payload: JSON.parse(String(init!.body)) });
        return new Response(response.body, { status: response.statusCode, statusText: STATUS_CODES[response.statusCode] });
      };
      const local = vi.fn();
      const old = await sendMessageToSession({ nodeId: "other-node", sessionLookup: { getSession: async () => ({ node_id: "fake-node" }) },
        taskManager: { addIntervention: local }, onResume: vi.fn(), logger: { warn: vi.fn() } as never,
        orch: { baseUrl: "http://orch", headers: {} }, fetchImpl },
      { targetSessionId: "sess-contract", message: "같은 메시지", callerInfo });

      // No IDs/timestamps occur in this result. Compare text formatting and structured result verbatim.
      expect(next).toEqual(jsonResult(old));
      expect(local).not.toHaveBeenCalled();
      if (state !== "missing") expect(harness.sent.at(-1)).toMatchObject({ caller_info: callerInfo, user: "agent" });
    } finally { await harness.app.close(); }
  });
  it("forwards an internal callerInfo unchanged", async () => {
    const h = createActionHarness({ ackFor: () => ({ delivered: true }) });
    try {
      const callerInfo = { source: "agent", display_name: "로젤린", agent_node: "node", agent_id: "roselin" };
      const result = await executeMcpTool({ sessionMessages: { router: h.router, bridge: h.bridge } } as unknown as McpHostOptions,
        "send_message_to_session" as McpToolName, { target_session_id: "sess-contract", message: "전달" },
        { ...external, principal: "internal", callerInfo });
      expect(result.isError).not.toBe(true);
      expect(h.sent[0]).toMatchObject({ caller_info: callerInfo });
    } finally { await h.app.close(); }
  });
  it("keeps unknown timeout verdict and does not retry", async () => {
    const send = vi.fn(async () => { throw new PendingNodeCommandTimeoutError({ commandType: "intervene", requestId: "timeout", timeoutMs: 30_000 }); });
    const h = createActionHarness({ bridgeOverride: { sendPendingCommand: send } });
    try {
      const result = await executeMcpTool({ sessionMessages: { router: h.router, bridge: { sendPendingCommand: send } } } as unknown as McpHostOptions,
        "send_message_to_session" as McpToolName, { target_session_id: "sess-contract", message: "전달" }, external);
      expect(result.structuredContent).toMatchObject({ ok: true, detail: { delivered: null, reason: "verdict_unknown", outcome: "unknown" } });
      expect(send).toHaveBeenCalledOnce();
    } finally { await h.app.close(); }
  });
  it("retries a 500 once with the same delivery identity", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue({ type: "intervene_ack", status: "ok", delivered: true });
    const h = createActionHarness();
    try {
      const payloads: unknown[] = [];
      const route = vi.spyOn(h.router, "routeExistingSessionPendingCommand");
      route.mockImplementation(async payload => { payloads.push(payload); return { payload } as never; });
      const result = await executeMcpTool({ sessionMessages: { router: h.router, bridge: { sendPendingCommand: send } } } as unknown as McpHostOptions,
        "send_message_to_session" as McpToolName, { target_session_id: "sess-contract", message: "전달" }, external);
      expect(result.structuredContent).toMatchObject({ ok: true, detail: { relayed: true, delivered: true } });
      expect(send).toHaveBeenCalledTimes(2);
      expect(payloads[0]).toEqual(payloads[1]);
      expect(payloads[0]).toHaveProperty("delivery_id", expect.any(String));
    } finally { await h.app.close(); }
  });
});
