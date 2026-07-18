import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  SessionCommandTransportBridge,
  SessionCommandRouter,
  createApp,
  loadContractFixtures,
  type NodeRegistrationPayload,
} from "../src/index.js";

const WAIT_FOR_INSTRUCTION_PROMPT =
  "업무 현황을 파악한 후, 사용자의 다음 지시를 대기해주세요.";
const EXECUTE_INSTRUCTION_PROMPT =
  "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.";

const fixtures = loadContractFixtures();
const config = {
  environment: "test" as const,
  databaseUrl: "postgresql://test/test",
  authBearerToken: "test-token",
};

async function createSession(
  requestPayload: Record<string, unknown>,
): Promise<{
  response: Awaited<ReturnType<ReturnType<typeof createApp>["inject"]>>;
  command: Record<string, unknown> | undefined;
}> {
  const sessionCache = new PerNodeSessionCache();
  const registry = new InMemoryNodeRegistry({ sessionCache });
  const transports = new NodeCommandTransportHub();
  const router = new SessionCommandRouter({ registry });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const connectionId = registry.registerNode(
    fixtures.fakeNodeReconnect.registration as NodeRegistrationPayload,
  ).node.connectionId;
  let command: Record<string, unknown> | undefined;
  transports.attach({
    nodeId: "fake-node",
    connectionId,
    transport: {
      send: (data) => {
        command = JSON.parse(data) as Record<string, unknown>;
        registry.receiveNodeMessage(
          { nodeId: "fake-node", connectionId },
          {
            type: "session_created",
            requestId: command.requestId,
            agentSessionId: command.agentSessionId,
          },
        );
      },
    },
  });
  const app = createApp({ config, sessionCommandRoutes: { router, bridge } });
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { profile: "claude-roselin", ...requestPayload },
  });
  return { response, command };
}

describe("POST /api/sessions initial_instruction contract", () => {
  it.each([
    {
      label: "초기 지시 없음",
      requestPayload: { initial_instruction: "" },
      expectedPrompt: WAIT_FOR_INSTRUCTION_PROMPT,
    },
    {
      label: "초기 지시 있음",
      requestPayload: { initial_instruction: "  결과를 표로 정리해줘.  " },
      expectedPrompt: `${EXECUTE_INSTRUCTION_PROMPT}\n결과를 표로 정리해줘.`,
    },
    {
      label: "초기 지시가 공백뿐",
      requestPayload: { initial_instruction: " \n\t " },
      expectedPrompt: WAIT_FOR_INSTRUCTION_PROMPT,
    },
    {
      label: "prompt와 함께 전달",
      requestPayload: {
        prompt: "레거시 prompt는 사용하지 않는다.",
        initial_instruction: "  서버 정본을 따른다.  ",
      },
      expectedPrompt: `${EXECUTE_INSTRUCTION_PROMPT}\n서버 정본을 따른다.`,
    },
  ])("$label", async ({ requestPayload, expectedPrompt }) => {
    const { response, command } = await createSession(requestPayload);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ prompt: expectedPrompt });
    expect(command).toMatchObject({
      type: "create_session",
      prompt: expectedPrompt,
    });
    expect(command).not.toHaveProperty("initial_instruction");
  });

  it("rejects a non-string initial_instruction even when legacy prompt is present", async () => {
    const { response, command } = await createSession({
      prompt: "legacy prompt",
      initial_instruction: null,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "initial_instruction must be a string",
      },
    });
    expect(command).toBeUndefined();
  });
});
