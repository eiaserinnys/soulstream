import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { AgentRegistry } from "../../src/agent_registry.js";
import { EventAcknowledgementTimeoutError } from "../../src/upstream/event_outbox_pump.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const openClients: Client[] = [];
const openServers: ReturnType<typeof buildMcpServer>[] = [];

const validDocument = {
  schema_version: 1,
  title: "선택지",
  body: [{ id: "answer", kind: "text", parts: ["정리된 선택지"] }],
};

function makeRuntime(params: {
  publisher?: ReturnType<typeof vi.fn>;
  task?: Record<string, unknown>;
} = {}): McpRuntime {
  return {
    nodeId: "test-node",
    agentsConfigPath: "/test/agents.yaml",
    db: { resolveCardReferences: vi.fn(async () => []) },
    taskManager: { getTask: vi.fn(() => params.task) },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: new AgentRegistry([]),
    catalogService: {},
    logger: pino({ level: "silent" }),
    ...(params.publisher ? { chatUiPublisher: { publish: params.publisher } } : {}),
  } as unknown as McpRuntime;
}

async function createClient(runtime: McpRuntime): Promise<Client> {
  const server = buildMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "chat-ui-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openServers.push(server);
  openClients.push(client);
  return client;
}

function activeTask(): Record<string, unknown> {
  return {
    executionRegistration: { registrationId: "registration-1", executionCommandId: "command-1" },
    orchestrationPurpose: false,
  };
}

async function callTool(client: Client, args: Record<string, unknown>, callerSessionId?: string) {
  return withMcpRequestContext(
    callerSessionId ? { callerSessionId } : {},
    () => client.callTool({ name: "publish_chat_ui", arguments: args }),
  );
}

afterEach(async () => {
  while (openClients.length) await openClients.pop()?.close();
  while (openServers.length) await openServers.pop()?.close();
});

describe("publish_chat_ui", () => {
  it("keeps the advertised description under the client limit and explains the title", async () => {
    const client = await createClient(makeRuntime());
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "publish_chat_ui");
    const description = tool?.description ?? "";

    expect(tool?.description).toEqual(expect.any(String));
    expect(description.length).toBeLessThanOrEqual(2000);
    expect(description).toContain("title은 맨 위에 제목으로 표시되니");
  });

  it("requires an authenticated caller and an active execution registration", async () => {
    const publisher = vi.fn(async () => ({ eventId: 41 }));
    const client = await createClient(makeRuntime({ publisher, task: activeTask() }));
    const args = { publication_key: "summary", document: validDocument };

    const missingCaller = await callTool(client, args);
    expect(missingCaller.isError).toBe(true);
    expect(publisher).not.toHaveBeenCalled();

    const missingRegistrationClient = await createClient(makeRuntime({
      publisher,
      task: { orchestrationPurpose: false },
    }));
    const missingRegistration = await callTool(missingRegistrationClient, args, "session-1");
    expect(missingRegistration.isError).toBe(true);
    expect(publisher).not.toHaveBeenCalled();
  });

  it("returns validation paths and does not publish an invalid document", async () => {
    const publisher = vi.fn(async () => ({ eventId: 41 }));
    const client = await createClient(makeRuntime({ publisher, task: activeTask() }));
    const result = await callTool(client, {
      publication_key: "summary",
      document: {
        schema_version: 1,
        units: {
          krw: { dims: { "currency:KRW": 1 }, symbol: "원", scale: 1 },
          usd: { dims: { "currency:USD": 1 }, symbol: "$", scale: 1 },
        },
        data: {
          local: { value: 1, unit: "krw" },
          foreign: { value: 1, unit: "usd" },
        },
        computed: {
          total: {
            op: "add",
            args: [
              { op: "ref", ref: { data: "local" } },
              { op: "ref", ref: { data: "foreign" } },
            ],
          },
        },
        body: [],
      },
    }, "session-1");

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "INVALID_CHAT_UI",
      errors: [{ path: "computed.total.args[1]", reason: expect.any(String) }],
    });
    expect(publisher).not.toHaveBeenCalled();
  });

  it("publishes one allowlisted assistant event and returns the committed event id", async () => {
    const publisher = vi.fn(async () => ({ eventId: 41 }));
    const client = await createClient(makeRuntime({ publisher, task: activeTask() }));
    const result = await callTool(client, {
      publication_key: "summary",
      document: validDocument,
    }, "session-1");

    expect(publisher).toHaveBeenCalledTimes(1);
    const [sessionId, event, registrationId] = publisher.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(sessionId).toBe("session-1");
    expect(registrationId).toBe("registration-1");
    expect(Object.keys(event).sort()).toEqual([
      "_dedupe_key", "content", "timestamp", "type", "ui",
    ]);
    expect(event.type).toBe("assistant_message");
    expect(event.content).toBe("**선택지**\n\n정리된 선택지");
    expect(event.timestamp).toEqual(expect.any(Number));
    expect(event).not.toHaveProperty("_final_for_live_stream");
    expect(event).not.toHaveProperty("_live_only");
    expect(event).not.toHaveProperty("streamIdentity");
    expect(event).not.toHaveProperty("liveSeq");
    expect(event).not.toHaveProperty("tool_use_id");
    expect(result.structuredContent).toMatchObject({
      status: "committed",
      event_id: 41,
      revision: 1,
      text: "**선택지**\n\n정리된 선택지",
    });
  });

  it("derives stable identities from session, publication key, and canonical document", async () => {
    const publisher = vi.fn(async () => ({ eventId: 41 }));
    const client = await createClient(makeRuntime({ publisher, task: activeTask() }));
    const firstDocument = {
      schema_version: 1,
      title: "요약",
      data: { z_value: { value: "z" }, a_value: { value: "a" } },
      body: [{ id: "answer", kind: "text", parts: ["본문"] }],
    };
    const reorderedDocument = {
      body: [{ id: "answer", kind: "text", parts: ["본문"] }],
      data: { a_value: { value: "a" }, z_value: { value: "z" } },
      title: "요약",
      schema_version: 1,
    };

    await callTool(client, { publication_key: "same", document: firstDocument }, "session-1");
    await callTool(client, { publication_key: "same", document: reorderedDocument }, "session-1");
    await callTool(client, {
      publication_key: "same",
      document: { ...reorderedDocument, title: "다른 문서" },
    }, "session-1");
    await callTool(client, { publication_key: "same", document: firstDocument }, "session-2");

    const events = publisher.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const uiIds = events.map((event) => (event.ui as Record<string, unknown>).ui_id);
    const hashes = events.map((event) => (event.ui as Record<string, unknown>).hash);
    const dedupeKeys = events.map((event) => event._dedupe_key);
    expect(uiIds[0]).toBe(uiIds[1]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(dedupeKeys[0]).toBe(dedupeKeys[1]);
    expect(uiIds[2]).not.toBe(uiIds[0]);
    expect(uiIds[3]).not.toBe(uiIds[0]);
  });

  it("returns delivery_unconfirmed for ACK timeout and PUBLISH_FAILED for other failures", async () => {
    const timeoutPublisher = vi.fn(async () => {
      throw new EventAcknowledgementTimeoutError(9, 30_000);
    });
    const timeoutClient = await createClient(makeRuntime({ publisher: timeoutPublisher, task: activeTask() }));
    const timeout = await callTool(timeoutClient, {
      publication_key: "summary",
      document: validDocument,
    }, "session-1");
    expect(timeout.isError).not.toBe(true);
    expect(timeout.structuredContent).toMatchObject({
      status: "delivery_unconfirmed",
      ui_id: expect.any(String),
      hash: expect.any(String),
      text: "저장 확인 응답을 기다리지 못했습니다. 화면에는 이미 도착했을 수 있습니다. 같은 publication_key와 같은 문서로 다시 부르면 중복되지 않습니다.",
    });

    const failedPublisher = vi.fn(async () => {
      throw new Error("dead-letter");
    });
    const failedClient = await createClient(makeRuntime({ publisher: failedPublisher, task: activeTask() }));
    const failed = await callTool(failedClient, {
      publication_key: "summary",
      document: validDocument,
    }, "session-1");
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      code: "PUBLISH_FAILED",
      reason: "dead-letter",
    });
  });

  it("reports a missing publisher as PUBLISH_FAILED", async () => {
    const client = await createClient(makeRuntime({ task: activeTask() }));
    const result = await callTool(client, {
      publication_key: "summary",
      document: validDocument,
    }, "session-1");

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "PUBLISH_FAILED",
      reason: expect.any(String),
    });
  });
});
