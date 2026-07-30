import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  AGENT_COMMON_FILES_DIR_ENV,
  SCRATCH_WORKSPACE_DIR_ENV,
  SOULSTREAM_AGENT_ID_ENV,
} from "../../../src/engine/scratch_workspace_env.js";

const { mockCreateTransport, mockClientCtor } = vi.hoisted(() => ({
  mockCreateTransport: vi.fn(),
  mockClientCtor: vi.fn(),
}));

vi.mock("../../../src/engine/codex_app_server/stdio_transport.js", () => ({
  createStdioAppServerTransport: vi.fn((options: unknown) => {
    mockCreateTransport(options);
    return { kind: "mock-transport" };
  }),
}));

vi.mock("../../../src/engine/codex_app_server/client.js", () => ({
  AppServerRpcError: class AppServerRpcError extends Error {
    public readonly code: number;
    constructor(message: string, code = -32000) {
      super(message);
      this.code = code;
    }
  },
  CodexAppServerClient: class MockCodexAppServerClient {
    constructor(transport: unknown) {
      mockClientCtor(transport);
    }
  },
}));

async function withProcessEnvValue(
  key: string,
  value: string | undefined,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = process.env[key];
  try {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("CodexAppServerEngineAdapter env", () => {
  it("passes scratch workspace env to the stdio transport after sanitize", async () => {
    await withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, "/srv/agent-common", async () => {
      const { CodexAppServerEngineAdapter } = await import(
        "../../../src/engine/codex_app_server/adapter.js"
      );

      new CodexAppServerEngineAdapter(
        {
          workspaceDir: "/tmp/right-app-server-work",
          agentId: "app-server-agent",
          processEnv: {
            OPENAI_API_KEY: "",
            [SCRATCH_WORKSPACE_DIR_ENV]: "/tmp/wrong-app-server-work",
            [SOULSTREAM_AGENT_ID_ENV]: "wrong-agent",
            [AGENT_COMMON_FILES_DIR_ENV]: "/tmp/wrong-common",
          },
        },
        pino({ level: "silent" }),
      );

      const options = mockCreateTransport.mock.calls[0][0] as {
        env: Record<string, string>;
        cwd: string;
      };
      expect(options.cwd).toBe("/tmp/right-app-server-work");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env[SCRATCH_WORKSPACE_DIR_ENV]).toBe("/tmp/right-app-server-work");
      expect(options.env[SOULSTREAM_AGENT_ID_ENV]).toBe("app-server-agent");
      expect(options.env[AGENT_COMMON_FILES_DIR_ENV]).toBe("/srv/agent-common");
      expect(mockClientCtor).toHaveBeenCalledWith({ kind: "mock-transport" });
    });
  });
});
