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
    </div>
  );
}
