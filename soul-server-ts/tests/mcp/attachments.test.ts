import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { AgentRegistry } from "../../src/agent_registry.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { EventAcknowledgementTimeoutError } from "../../src/upstream/event_outbox_pump.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const openClients: Client[] = [];
const openServers: ReturnType<typeof buildMcpServer>[] = [];

const attachmentResult = {
  attachment_id: "attachment-1",
  descriptor: {
    attachment_id: "attachment-1",
    name: "report.txt",
    mime_type: "text/plain",
    byte_size: 12,
    checksum_sha256: "abc123",
    width: null,
    height: null,
    preview_kind: "text" as const,
    preview_mime_type: "text/plain",
  },
};

const resolvedAttachmentResult = {
  ...attachmentResult,
  local_path: "/incoming/trusted-session/assets/attachment-1/report.txt",
};

function activeTask(params: {
  commandId?: string | null;
  workspaceDir?: string | null;
  engineWorkspaceDir?: string;
  registrationId?: string | null;
} = {}) {
  return {
    // Only worktree executions set resolvedWorkspaceDir; null models a plain session.
    resolvedWorkspaceDir: params.workspaceDir === null ? undefined : params.workspaceDir ?? "/workspace",
    agentProfileSnapshot: { workspace_dir: "/profile-workspace" },
    executionRegistration: params.registrationId === null
      ? undefined
      : { registrationId: params.registrationId ?? "registration-1", executionCommandId: "stale-command" },
    runner: {
      engine: { workspaceDir: params.engineWorkspaceDir ?? "/engine-workspace" },
      dispatcher: {
        activeExecutionCommandId: vi.fn(() => params.commandId === null ? undefined : params.commandId ?? "output-command-1"),
      },
    },
  };
}

function makeRuntime(params: {
  task?: ReturnType<typeof activeTask> | null;
  service?: { register: ReturnType<typeof vi.fn>; validateSessionOutput?: ReturnType<typeof vi.fn> };
  materializer?: { materialize: ReturnType<typeof vi.fn> };
  publisher?: { publish: ReturnType<typeof vi.fn> };
} = {}): McpRuntime {
  return {
    nodeId: "node-1",
    agentsConfigPath: "/test/agents.yaml",
    db: { resolveCardReferences: vi.fn(async () => []) },
    taskManager: { getTask: vi.fn(() => params.task) },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: new AgentRegistry([]),
    catalogService: {},
    logger: pino({ level: "silent" }),
    ...(params.service ? { producedAttachments: params.service } : {}),
    ...(params.materializer ? { attachmentMaterializer: params.materializer } : {}),
    ...(params.publisher ? { chatUiPublisher: params.publisher } : {}),
  } as unknown as McpRuntime;
}

async function createClient(runtime: McpRuntime): Promise<Client> {
  const server = buildMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "attachments-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openServers.push(server);
  openClients.push(client);
  return client;
}

async function callTool(
  client: Client,
  input: Record<string, unknown>,
  callerSessionId?: string,
  toolName = "register_attachment",
) {
  return withMcpRequestContext(
    callerSessionId ? { callerSessionId } : {},
    () => client.callTool({ name: toolName, arguments: input }),
  );
}

function errorText(result: Awaited<ReturnType<typeof callTool>>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.type === "text" ? item.text : "")
    .join("\n");
}

afterEach(async () => {
  while (openClients.length) await openClients.pop()?.close();
  while (openServers.length) await openServers.pop()?.close();
});

describe("register_attachment", () => {
  it("uses the trusted caller, active dispatcher command, and task workspace", async () => {
    const register = vi.fn(async () => attachmentResult);
    const publish = vi.fn(async () => ({ eventId: 17 }));
    const task = activeTask();
    const client = await createClient(makeRuntime({ task, service: { register }, publisher: { publish } }));
    const input = {
      local_path: "reports/report.txt",
      name: "report.txt",
      mime_type: "text/plain",
      target_scope: { type: "card", id: "card-1" },
    };

    const result = await callTool(client, input, "trusted-session");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(attachmentResult);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0]).toEqual(input);
    expect(register.mock.calls[0]?.[1]).toEqual({
      sessionId: "trusted-session",
      nodeId: "node-1",
      outputCommandId: "output-command-1",
      workspaceDir: "/workspace",
      profileWorkspaceDir: "/profile-workspace",
    });
    expect(task.runner.dispatcher.activeExecutionCommandId).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("uses the running engine workspace when the session has no worktree", async () => {
    const register = vi.fn(async () => attachmentResult);
    const task = activeTask({ workspaceDir: null, engineWorkspaceDir: "/home/agent/workspace" });
    const client = await createClient(makeRuntime({ task, service: { register } }));

    const result = await callTool(client, { local_path: "proof.png" }, "trusted-session");

    expect(result.isError).not.toBe(true);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[1]).toMatchObject({
      outputCommandId: "output-command-1",
      workspaceDir: "/home/agent/workspace",
    });
  });

  it("rejects caller supplied provenance fields under the strict input schema", async () => {
    const register = vi.fn(async () => attachmentResult);
    const client = await createClient(makeRuntime({ task: activeTask(), service: { register } }));

    const result = await callTool(client, {
      local_path: "report.txt",
      caller_session_id: "forged-session",
      node_id: "forged-node",
      output_command_id: "forged-command",
      workspace_dir: "/forged-workspace",
    }, "trusted-session");

    expect(result.isError).toBe(true);
    expect(register).not.toHaveBeenCalled();
  });

  it("requires a trusted caller and an active execution with a workspace", async () => {
    const register = vi.fn(async () => attachmentResult);
    const noCallerRuntime = makeRuntime({ task: activeTask(), service: { register } });
    const noCallerClient = await createClient(noCallerRuntime);
    const noCaller = await callTool(noCallerClient, { local_path: "report.txt" });
    expect(noCaller.isError).toBe(true);
    expect(errorText(noCaller)).toContain("ATTACHMENT_UNAUTHENTICATED");
    expect(noCallerRuntime.taskManager.getTask).not.toHaveBeenCalled();

    const noTaskClient = await createClient(makeRuntime({ task: null, service: { register } }));
    const noTask = await callTool(noTaskClient, { local_path: "report.txt" }, "trusted-session");
    expect(noTask.isError).toBe(true);
    expect(errorText(noTask)).toContain("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED");

    const noCommandClient = await createClient(makeRuntime({
      task: activeTask({ commandId: null, workspaceDir: "   " }),
      service: { register },
    }));
    const noCommand = await callTool(noCommandClient, { local_path: "report.txt" }, "trusted-session");
    expect(noCommand.isError).toBe(true);
    expect(errorText(noCommand)).toContain("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED");
    expect(register).not.toHaveBeenCalled();
  });

  it("reports missing registration service and preserves service error codes", async () => {
    const unavailableClient = await createClient(makeRuntime({ task: activeTask() }));
    const unavailable = await callTool(unavailableClient, { local_path: "report.txt" }, "trusted-session");
    expect(unavailable.isError).toBe(true);
    expect(errorText(unavailable)).toContain("ATTACHMENT_REGISTRATION_UNAVAILABLE");

    const register = vi.fn(async () => {
      throw Object.assign(new Error("허용된 작업 폴더 밖의 파일은 첨부할 수 없습니다."), {
        code: "ATTACHMENT_PATH_DENIED",
      });
    });
    const failureClient = await createClient(makeRuntime({ task: activeTask(), service: { register } }));
    const failure = await callTool(failureClient, { local_path: "outside.txt" }, "trusted-session");
    expect(failure.isError).toBe(true);
    expect(errorText(failure)).toContain("ATTACHMENT_PATH_DENIED");
  });
});

describe("attach_session_output", () => {
  it("validates normalized IDs with trusted execution and publishes the durable marker without a workspace", async () => {
    const validateSessionOutput = vi.fn(async ({ attachment_ids }: { attachment_ids: string[] }) => ({ attachment_ids }));
    const publish = vi.fn(async () => ({ eventId: 73 }));
    const task = activeTask({ workspaceDir: null, engineWorkspaceDir: "   " });
    const client = await createClient(makeRuntime({
      task,
      service: { register: vi.fn(), validateSessionOutput },
      publisher: { publish },
    }));

    const result = await callTool(
      client,
      { attachment_ids: ["att-1", "att-2", "att-1"] },
      "trusted-session",
      "attach_session_output",
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      status: "committed",
      event_id: "73",
      output_command_id: "output-command-1",
      attachment_ids: ["att-1", "att-2"],
    });
    expect(validateSessionOutput).toHaveBeenCalledOnce();
    expect(validateSessionOutput.mock.calls[0]?.[0]).toEqual({ attachment_ids: ["att-1", "att-2"] });
    expect(validateSessionOutput.mock.calls[0]?.[1]).toEqual({
      sessionId: "trusted-session",
      nodeId: "node-1",
      outputCommandId: "output-command-1",
    });
    expect(task.runner.dispatcher.activeExecutionCommandId).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
    const [sessionId, event, registrationId] = publish.mock.calls[0]!;
    expect(sessionId).toBe("trusted-session");
    expect(registrationId).toBe("registration-1");
    expect(event).toMatchObject({
      type: "assistant_message",
      content: "",
      attachment_ids: ["att-1", "att-2"],
      attachment_output: true,
      output_command_id: "output-command-1",
      _dedupe_key: `session-output:${createHash("sha256")
        .update(JSON.stringify(["trusted-session", "output-command-1", ["att-1", "att-2"]]))
        .digest("hex")}`,
    });
  });

  it("rejects forged provenance and unauthenticated callers before validation", async () => {
    const validateSessionOutput = vi.fn(async ({ attachment_ids }: { attachment_ids: string[] }) => ({ attachment_ids }));
    const publish = vi.fn(async () => ({ eventId: 73 }));
    const client = await createClient(makeRuntime({
      task: activeTask(),
      service: { register: vi.fn(), validateSessionOutput },
      publisher: { publish },
    }));

    const forged = await callTool(client, {
      attachment_ids: ["att-1"],
      caller_session_id: "forged-session",
      node_id: "forged-node",
      output_command_id: "forged-command",
    }, "trusted-session", "attach_session_output");
    const unauthenticated = await callTool(client, { attachment_ids: ["att-1"] }, undefined, "attach_session_output");

    expect(forged.isError).toBe(true);
    expect(unauthenticated.isError).toBe(true);
    expect(errorText(unauthenticated)).toContain("ATTACHMENT_UNAUTHENTICATED");
    expect(validateSessionOutput).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("requires an active command and registration, and reports missing services explicitly", async () => {
    const validateSessionOutput = vi.fn(async ({ attachment_ids }: { attachment_ids: string[] }) => ({ attachment_ids }));
    const baseService = { register: vi.fn(), validateSessionOutput };
    const input = { attachment_ids: ["att-1"] };

    const noTask = await createClient(makeRuntime({ task: null, service: baseService, publisher: { publish: vi.fn() } }));
    const noTaskResult = await callTool(noTask, input, "trusted-session", "attach_session_output");
    expect(errorText(noTaskResult)).toContain("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED");

    const noCommandTask = activeTask({ commandId: null });
    const noCommand = await createClient(makeRuntime({ task: noCommandTask, service: baseService, publisher: { publish: vi.fn() } }));
    const noCommandResult = await callTool(noCommand, input, "trusted-session", "attach_session_output");
    expect(errorText(noCommandResult)).toContain("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED");

    const noRegistration = await createClient(makeRuntime({
      task: activeTask({ registrationId: null }),
      service: baseService,
      publisher: { publish: vi.fn() },
    }));
    const noRegistrationResult = await callTool(noRegistration, input, "trusted-session", "attach_session_output");
    expect(errorText(noRegistrationResult)).toContain("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED");

    const noValidator = await createClient(makeRuntime({ task: activeTask(), publisher: { publish: vi.fn() } }));
    const noValidatorResult = await callTool(noValidator, input, "trusted-session", "attach_session_output");
    expect(errorText(noValidatorResult)).toContain("ATTACHMENT_REGISTRATION_UNAVAILABLE");

    const noPublisher = await createClient(makeRuntime({
      task: activeTask(),
      service: baseService,
    }));
    const noPublisherResult = await callTool(noPublisher, input, "trusted-session", "attach_session_output");
    expect(errorText(noPublisherResult)).toContain("ATTACHMENT_REGISTRATION_UNAVAILABLE");
    expect(validateSessionOutput).not.toHaveBeenCalled();
  });

  it("does not publish when validation rejects or returns a different ID sequence", async () => {
    const publish = vi.fn(async () => ({ eventId: 73 }));
    const denied = vi.fn(async () => {
      throw Object.assign(new Error("다른 실행의 첨부입니다."), { code: "ATTACHMENT_PRODUCER_MISMATCH" });
    });
    const deniedClient = await createClient(makeRuntime({
      task: activeTask(),
      service: { register: vi.fn(), validateSessionOutput: denied },
      publisher: { publish },
    }));
    const deniedResult = await callTool(
      deniedClient,
      { attachment_ids: ["att-1", "att-2"] },
      "trusted-session",
      "attach_session_output",
    );
    expect(errorText(deniedResult)).toContain("ATTACHMENT_PRODUCER_MISMATCH");
    expect(publish).not.toHaveBeenCalled();

    const mismatched = vi.fn(async () => ({ attachment_ids: ["att-2", "att-1"] }));
    const mismatchedClient = await createClient(makeRuntime({
      task: activeTask(),
      service: { register: vi.fn(), validateSessionOutput: mismatched },
      publisher: { publish },
    }));
    const mismatchedResult = await callTool(
      mismatchedClient,
      { attachment_ids: ["att-1", "att-2"] },
      "trusted-session",
      "attach_session_output",
    );
    expect(errorText(mismatchedResult)).toContain("ATTACHMENT_REGISTRATION_UNAVAILABLE");
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish if the active command or registration changes during validation", async () => {
    const publish = vi.fn(async () => ({ eventId: 73 }));
    const commandTask = activeTask();
    commandTask.runner.dispatcher.activeExecutionCommandId = vi.fn()
      .mockReturnValueOnce("output-command-1")
      .mockReturnValueOnce("output-command-2");
    const commandValidator = vi.fn(async ({ attachment_ids }: { attachment_ids: string[] }) => ({ attachment_ids }));
    const commandClient = await createClient(makeRuntime({
      task: commandTask,
      service: { register: vi.fn(), validateSessionOutput: commandValidator },
      publisher: { publish },
    }));
    const commandResult = await callTool(
      commandClient,
      { attachment_ids: ["att-1"] },
      "trusted-session",
      "attach_session_output",
    );
    expect(errorText(commandResult)).toContain("ATTACHMENT_OUTPUT_EXECUTION_CHANGED");
    expect(publish).not.toHaveBeenCalled();

    const registrationTask = activeTask();
    const registrationValidator = vi.fn(async ({ attachment_ids }: { attachment_ids: string[] }) => {
      registrationTask.executionRegistration = { registrationId: "registration-2", executionCommandId: "new-command" };
      return { attachment_ids };
    });
    const registrationClient = await createClient(makeRuntime({
      task: registrationTask,
      service: { register: vi.fn(), validateSessionOutput: registrationValidator },
      publisher: { publish },
    }));
    const registrationResult = await callTool(
      registrationClient,
      { attachment_ids: ["att-1"] },
      "trusted-session",
      "attach_session_output",
    );
    expect(errorText(registrationResult)).toContain("ATTACHMENT_OUTPUT_EXECUTION_CHANGED");
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns delivery_unconfirmed on ACK timeout and leaves registration without an output event", async () => {
    const validateSessionOutput = vi.fn(async ({ attachment_ids }: { attachment_ids: string[] }) => ({ attachment_ids }));
    const publish = vi.fn(async () => { throw new EventAcknowledgementTimeoutError(1, 30_000); });
    const client = await createClient(makeRuntime({
      task: activeTask(),
      service: { register: vi.fn(), validateSessionOutput },
      publisher: { publish },
    }));

    const result = await callTool(
      client,
      { attachment_ids: ["att-1"] },
      "trusted-session",
      "attach_session_output",
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "delivery_unconfirmed", output_key: expect.any(String) });
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe("resolve_attachment", () => {
  it("uses the trusted caller and materializes one attachment in resolve mode", async () => {
    const materialize = vi.fn(async () => resolvedAttachmentResult);
    const task = activeTask({ commandId: null });
    const runtime = makeRuntime({ task, materializer: { materialize } });
    const client = await createClient(runtime);

    const result = await callTool(
      client,
      { attachment_id: "attachment-1" },
      "trusted-session",
      "resolve_attachment",
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(resolvedAttachmentResult);
    expect(runtime.taskManager.getTask).toHaveBeenCalledWith("trusted-session");
    expect(materialize).toHaveBeenCalledOnce();
    expect(materialize.mock.calls[0]?.[0]).toEqual({
      sessionId: "trusted-session",
      attachmentId: "attachment-1",
      mode: "resolve",
    });
    expect(task.runner.dispatcher.activeExecutionCommandId).not.toHaveBeenCalled();
  });

  it("rejects caller and registration scope fields from the request body", async () => {
    const materialize = vi.fn(async () => resolvedAttachmentResult);
    const client = await createClient(makeRuntime({ task: activeTask(), materializer: { materialize } }));

    const result = await callTool(client, {
      attachment_id: "attachment-1",
      caller_session_id: "forged-session",
      registration_scope: { type: "session", id: "forged-session" },
    }, "trusted-session", "resolve_attachment");

    expect(result.isError).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("requires a trusted caller, an existing task, and a materializer", async () => {
    const materialize = vi.fn(async () => resolvedAttachmentResult);
    const noCallerRuntime = makeRuntime({ task: activeTask(), materializer: { materialize } });
    const noCallerClient = await createClient(noCallerRuntime);
    const noCaller = await callTool(noCallerClient, { attachment_id: "attachment-1" }, undefined, "resolve_attachment");
    expect(noCaller.isError).toBe(true);
    expect(errorText(noCaller)).toContain("ATTACHMENT_UNAUTHENTICATED");
    expect(noCallerRuntime.taskManager.getTask).not.toHaveBeenCalled();

    const noTaskClient = await createClient(makeRuntime({ task: null, materializer: { materialize } }));
    const noTask = await callTool(noTaskClient, { attachment_id: "attachment-1" }, "trusted-session", "resolve_attachment");
    expect(noTask.isError).toBe(true);
    expect(errorText(noTask)).toContain("SESSION_NOT_FOUND");

    const unavailableClient = await createClient(makeRuntime({ task: activeTask() }));
    const unavailable = await callTool(unavailableClient, { attachment_id: "attachment-1" }, "trusted-session", "resolve_attachment");
    expect(unavailable.isError).toBe(true);
    expect(errorText(unavailable)).toContain("ATTACHMENT_INPUT_UNAVAILABLE");
    expect(materialize).not.toHaveBeenCalled();
  });

  it("preserves central reference denial codes", async () => {
    const materialize = vi.fn(async () => {
      throw Object.assign(new Error("Attachment access denied"), { code: "ATTACHMENT_ACCESS_DENIED" });
    });
    const client = await createClient(makeRuntime({ task: activeTask(), materializer: { materialize } }));

    const result = await callTool(client, { attachment_id: "attachment-1" }, "trusted-session", "resolve_attachment");

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("ATTACHMENT_ACCESS_DENIED");
    expect(errorText(result)).toContain("Attachment access denied");
  });
});
