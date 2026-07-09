import { describe, expect, it } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  type NodeAgentProfileProvider,
  type NodePortraitRequestOptions,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("node agent profile route proxy headers", () => {
  it("passes request auth headers to portrait provider fallback paths", async () => {
    const calls: NodePortraitRequestOptions[] = [];
    const provider: NodeAgentProfileProvider = {
      async listAgentProfiles() {
        return {};
      },
      async getAgentPortrait(_nodeId, _agentId, options) {
        calls.push(options ?? {});
        return { status: "missing" };
      },
      async getUserPortrait(_nodeId, options) {
        calls.push(options ?? {});
        return { status: "missing" };
      },
      async planAgentProfileUpdate() {
        return {};
      },
      async applyAgentProfileUpdate() {
        return {};
      },
      async listAgentsConfigSnapshots() {
        return {};
      },
      async rollbackAgentsConfig() {
        return {};
      },
    };
    const app = createApp({ config, nodeAgentProfileRoutes: { provider } });

    for (const url of [
      "/api/nodes/node-a/agents/agent-a/portrait",
      "/api/nodes/node-a/user/portrait",
    ]) {
      await app.inject({
        method: "GET",
        url,
        headers: {
          authorization: "Bearer caller-token",
          cookie: "session=abc",
        },
      });
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers).toEqual(
        expect.objectContaining({
          authorization: "Bearer caller-token",
          cookie: "session=abc",
        }),
      );
    }
    await app.close();
  });
});
