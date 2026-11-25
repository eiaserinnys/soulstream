import { useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { ConfigModal } from "../components/ConfigModal";
import type { McpIcon } from "../lib/mcp-api";
import {
  McpIconPicker,
  McpIconTile,
  McpServerIcons,
} from "../components/mcp/McpIcons";
import { McpValueUnit } from "../components/mcp/DefinitionEditor";
import { newUnit, type Unit } from "../components/mcp/definition";
import { AgentMcpConnectionPane } from "../components/mcp/AgentMcpConnectionPane";

const sampleRequest: typeof fetch = async (input) => {
  if (String(input).includes("/preview?")) return Response.json({ applied_mode: "central", applied_revision: 3, current_revision: 3, effective_backend: "sample", default_preset: null, isolation_enabled: true,
    normal: { runnable: true, servers: [{ server_id: "example", name: "예시 서버", type: "streamable_http", included: true, node_override: true }] },
    restricted: { runnable: true, servers: [{ server_id: "soulstream", name: "soulstream", type: "streamable_http", included: true }] } });
  return Response.json({ current_revision: 3, managed_nodes: [{ node_id: "example-node", connected: true, central_sync_supported: true, applied_revision: 3, ack: null }],
    servers: [{ id: "example", name: "예시 서버", type: "streamable_http", config: {}, node_scope: ["example-node"], node_overrides: {}, icon: null, version: 1 }],
    profiles: [{ id: "example-profile", name: "예시 프로필", description: null, mcp_servers: ["example"], hosted_tools: [], node_scope: ["example-node"], version: 1 }],
    bindings: [{ agent_id: "example-agent", node_id: "example-node", mcp_profile_id: "example-profile", version: 1 }], secrets: [] });
};

export function McpReviewSample() {
  const [open, setOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [icon, setIcon] = useState<McpIcon | null>({
    kind: "symbol",
    name: "plug",
    color: "node-user",
  });
  const [unit, setUnit] = useState<Unit>(
    newUnit({
      kind: "header",
      name: "Authorization",
      value: "{{secret:example-name}}",
    }),
  );
  const servers = [
    {
      id: "example",
      name: "example",
      type: "streamable_http" as const,
      config: {},
      node_scope: [],
      node_overrides: {},
      icon,
      version: 1,
    },
  ];
  return (
    <div className="space-y-3">
      <Button type="button" onClick={() => setOpen(true)}>
        MCP 설정 열기
      </Button>
      <ConfigModal open={open} initialTab="mcp" onOpenChange={setOpen} />
      <div className="flex gap-2">
        <McpIconTile id="example" icon={icon} />
        <McpServerIcons ids={["example"]} servers={servers} />
      </div>
      <Button type="button" onClick={() => setShowPicker(!showPicker)}>
        아이콘 고르기 표본
      </Button>
      {showPicker ? (
        <McpIconPicker
          id="example"
          name="example"
          url="https://example.invalid"
          value={icon}
          onChange={setIcon}
          upload={async () => {
            throw new Error("sample");
          }}
        />
      ) : null}
      <McpValueUnit
        unit={unit}
        onChange={setUnit}
        onRemove={() =>
          setUnit(newUnit({ kind: "header", name: "", value: "{{secret:}}" }))
        }
        onSecretValue={() => undefined}
      />
      <AgentMcpConnectionPane agentId="example-agent" nodeId="example-node" request={sampleRequest} onEditProfile={() => undefined} />
    </div>
  );
}
