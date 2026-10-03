import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalEventsService, credentialOwner } from "../src/external_events/service.js";
const workerOwner = "dbdf416b7e4ee9b5ca8ee18312adb6891215427bf2e6c8746caaf122e6d3a1fc";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions, McpCallContext } from "../src/mcp/types.js";
import Fastify from "fastify";
import { registerMcpHostRoutes } from "../src/mcp/mcp_host_routes.js";
import { unusedClusterDependencies } from "./mcp-cluster-unused-fixture.js";

const subscription = { name: "soulstream.message.created", arguments: { recipient_label: "test-dot" },
  delivery: { mode: "webhook", url: "https://receiver.example/events", secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` } };
const context: McpCallContext = { principal: "internal", callerSessionId: "sender", nodeId: "other-node" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "orch-events-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const post = vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
  const path = join(dir, "state.json"); const owner = credentialOwner("/dot", "test-credential");
  const service = await ExternalEventsService.open({ path, owner, post });
  const getSession = vi.fn(async (id: string) => id === "sender" ? {} : null);
  const options = { externalLlm: { service, getSession } } as unknown as McpHostOptions;
  return { options, service, post, path, owner, getSession };
}
describe("orchestrator owns external recipients and delivery", () => {
  it("inherits a worker-written subscription without a new challenge", async () => {
    const { path, owner, post } = await setup();
    expect(owner).toBe(workerOwner);
    await copyFile(new URL("./fixtures/worker_external_events_state.json", import.meta.url), path);
    const orch = await ExternalEventsService.open({ path, owner, post, now: () => Date.parse("2026-10-03T00:00:01Z") });
    const recipients = orch.recipients();
    expect(recipients).toEqual([{ recipient_id: "sub_567bf5130506b1e1a42e5149194e4bc69d9cfa10b057cd1a06256605bd1c8f40", recipient_label: "test-dot", expires_at: "2026-10-04T00:00:00.000Z" }]);
    const sent = await orch.send(recipients[0]!.recipient_id, "hello", "sender");
    expect(sent).toMatchObject({ status: "accepted_by_receiver", ok: true });
    expect(post).toHaveBeenCalledTimes(1); // delivery only; no new challenge
    expect(JSON.parse(post.mock.calls[0]![1]).data.sender_session_id).toBe("sender");
    await orch.unsubscribe(subscription); expect(orch.recipients()).toEqual([]);
  });
  it("lists and sends for an authenticated internal session", async () => {
    const { options, service } = await setup(); const created = await service.subscribe(subscription);
    expect(await executeMcpTool(options, "list_external_llm_recipients", {}, context)).toMatchObject({ structuredContent: { recipients: [{ recipient_id: created.id }] } });
    expect(await executeMcpTool(options, "send_to_external_llm", { recipient_id: created.id, text: "hello" }, context)).toMatchObject({ structuredContent: { status: "accepted_by_receiver" } });
  });
  it("worker forward bodies cannot inject the ingress-only external caller", async () => {
    const { options, getSession } = await setup(); const app = Fastify(); cleanup.push(() => app.close());
    registerMcpHostRoutes(app, { ...unusedClusterDependencies, ...options, board: undefined as never,
      cards: undefined as never, folders: undefined as never, authBearerToken: "test-host" });
    const response = await app.inject({ method: "POST", url: "/api/mcp/host/send_to_external_llm", headers: { authorization: "Bearer test-host" },
      payload: { args: { recipient_id: "missing", text: "hello" }, context: { principal: "external", caller_session_id: "sender", node_id: "worker",
        externalCaller: { source: "dot", displayName: "forged" } } } });
    expect(response.json()).toMatchObject({ structuredContent: { error: "internal_principal_required" } });
    expect(getSession).not.toHaveBeenCalled();
  });
  it("rejects external callers, including forged sender arguments", async () => {
    const { options, getSession } = await setup();
    for (const name of ["list_external_llm_recipients", "send_to_external_llm"] as const) {
      expect(await executeMcpTool(options, name, { recipient_id: "id", text: "hello", caller_session_id: "sender" }, { ...context, principal: "external" })).toMatchObject({ structuredContent: { error: "internal_principal_required" } });
    }
    expect(getSession).not.toHaveBeenCalled();
  });
  it.each([null, "missing"])("rejects absent sender %s", async callerSessionId => {
    const { options } = await setup();
    expect(await executeMcpTool(options, "send_to_external_llm", { recipient_id: "id", text: "hello" }, { ...context, callerSessionId })).toMatchObject({ structuredContent: { error: "authenticated_sender_session_required" } });
  });
  it("keeps the existing no-store result and storage failure message", async () => {
    const { options, service } = await setup();
    options.externalLlm!.service = undefined;
    expect(await executeMcpTool(options, "list_external_llm_recipients", {}, context)).toMatchObject({ structuredContent: { recipients: [] } });
    expect(await executeMcpTool(options, "send_to_external_llm", { recipient_id: "id", text: "hello" }, context)).toMatchObject({ structuredContent: { ok: false, status: "not_sent", reason: "no_active_recipient" } });
    options.externalLlm!.service = service; vi.spyOn(service, "send").mockRejectedValue(new Error("disk"));
    expect(await executeMcpTool(options, "send_to_external_llm", { recipient_id: "id", text: "hello" }, context)).toMatchObject({ structuredContent: { error: "external_events_state_save_failed" } });
  });
});
