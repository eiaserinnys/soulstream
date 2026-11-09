import { nodePairingTools } from "@soulstream/mcp-contract";
import { describe, expect, it } from "vitest";

import { NodeCredentialStore, NodePairingService } from "../src/node_credentials/index.js";
import { mcpToolHandlers } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { InMemoryNodeCredentialRepository } from "./node-credentials-test-support.js";

const context: McpCallContext = {
  principal: "internal",
  callerSessionId: "caller-session",
  nodeId: "orchestrator",
};

async function createHarness() {
  const repository = new InMemoryNodeCredentialRepository();
  const store = new NodeCredentialStore({ repository });
  await store.initialize();
  const connected = new Set<string>();
  const stored = new Set<string>();
  const service = new NodePairingService({
    store,
    isNodeConnected: nodeId => connected.has(nodeId),
    hasStoredNode: nodeId => stored.has(nodeId),
    now: () => 1_790_000_000_000,
  });
  const options = { nodePairing: service } as unknown as McpHostOptions;
  return { repository, store, service, options, connected, stored };
}

describe("node pairing MCP handlers", () => {
  it("approves, lists and revokes through internal tools without exposing secrets", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-tool", company_pc: false });

    const approved = await mcpToolHandlers.approve_node_pairing(
      harness.options,
      { user_code: start.user_code },
      context,
    );

    expect(approved.isError).toBeUndefined();
    expect(approved.structuredContent).toEqual({
      credential_id: expect.any(String),
      node_id: "node-tool",
      company_pc: false,
    });
    const approvedText = JSON.stringify(approved);
    expect(approvedText).not.toContain("token");
    expect(approvedText).not.toContain(start.device_code);
    expect(approvedText).not.toContain(harness.repository.rows[0]!.token_sha256);

    const listed = await mcpToolHandlers.list_node_credentials(harness.options, {}, context);

    expect(listed.isError).toBeUndefined();
    const records = (listed.structuredContent as { result: unknown[] }).result;
    expect(records).toHaveLength(1);
    const listedText = JSON.stringify(listed);
    expect(listedText).not.toContain("token");
    expect(listedText).not.toContain(start.device_code);
    expect(listedText).not.toContain(harness.repository.rows[0]!.token_sha256);

    const credentialId = (approved.structuredContent as { credential_id: string }).credential_id;
    const revoked = await mcpToolHandlers.revoke_node_credential(
      harness.options,
      { credential_id: credentialId },
      context,
    );

    expect(revoked.isError).toBeUndefined();
    expect(revoked.structuredContent).toMatchObject({
      credential_id: credentialId,
      node_id: "node-tool",
      revoked_at: expect.any(String),
    });

    const again = await mcpToolHandlers.revoke_node_credential(
      harness.options,
      { credential_id: credentialId },
      context,
    );
    expect(again.structuredContent).toEqual(revoked.structuredContent);
  });

  it("reports a conflict as a tool error naming the canonical source", async () => {
    const harness = await createHarness();
    harness.stored.add("node-stored");
    const start = await harness.service.start({ node_id: "node-stored", company_pc: true });

    const result = await mcpToolHandlers.approve_node_pairing(
      harness.options,
      { user_code: start.user_code },
      context,
    );

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain(
      "soulstream_node_heartbeats",
    );
    expect((result.structuredContent as { code?: string }).code).toBe("node_pairing_conflict");
    expect((result.structuredContent as { details?: unknown }).details).toEqual({
      reason: "stored_node",
    });
    expect(harness.repository.rows).toHaveLength(0);
  });

  it("reports unconfigured and unknown input without leaking anything", async () => {
    const unconfigured = await mcpToolHandlers.list_node_credentials(
      {} as McpHostOptions,
      {},
      context,
    );
    expect(unconfigured.isError).toBe(true);

    const harness = await createHarness();
    const unknown = await mcpToolHandlers.approve_node_pairing(
      harness.options,
      { user_code: "ZZZZ-ZZZZ" },
      context,
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ code: "node_pairing_not_found" });
  });

  it("declares the three tools as strict internal tools with no secret inputs", () => {
    for (const definition of Object.values(nodePairingTools)) {
      expect(definition.audience).toBe("internal");
      expect("strictInputSchema" in definition && definition.strictInputSchema).toBe(true);
    }
    expect(Object.keys(nodePairingTools.approve_node_pairing.config.inputSchema)).toEqual([
      "user_code",
    ]);
    expect(Object.keys(nodePairingTools.list_node_credentials.config.inputSchema)).toEqual([
      "include_revoked",
    ]);
    expect(Object.keys(nodePairingTools.revoke_node_credential.config.inputSchema)).toEqual([
      "credential_id",
    ]);
    const serialized = JSON.stringify(nodePairingTools);
    expect(serialized).not.toContain("device_code");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("token_sha256");
  });
});
