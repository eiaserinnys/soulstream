import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type {
  SSEEventAssistantMessage,
  SSEEventComplete,
  SSEEventTextDelta,
  SSEEventTextEnd,
  SSEEventTextStart,
} from "../generated/typescript/index.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/runtime_event_contract.json", import.meta.url), "utf8"),
) as {
  sessionOutputEvents: Record<string, unknown>;
  legacySessionOutputEvents: Record<string, unknown>;
};
const schema = JSON.parse(
  readFileSync(new URL("../src/upstream.schema.json", import.meta.url), "utf8"),
) as {
  $defs: Record<string, {
    additionalProperties?: boolean;
    properties?: Record<string, { const?: unknown; type?: string; items?: { type?: string } }>;
    required?: string[];
  }>;
};
const generatedTypes = readFileSync(new URL("../generated/typescript/index.ts", import.meta.url), "utf8");

function generatedInterface(name: string): string {
  const start = generatedTypes.indexOf(`export interface ${name} {`);
  const end = start < 0 ? -1 : generatedTypes.indexOf("\n}", start);
  return start < 0 || end < 0 ? "" : generatedTypes.slice(start, end + 2);
}

const marker = fixture.sessionOutputEvents.marker as SSEEventAssistantMessage;
const complete = fixture.sessionOutputEvents.complete as SSEEventComplete;
const textStart = fixture.sessionOutputEvents.textStart as SSEEventTextStart;
const textDelta = fixture.sessionOutputEvents.textDelta as SSEEventTextDelta;
const textEnd = fixture.sessionOutputEvents.textEnd as SSEEventTextEnd;

describe("session output attachment wire contract", () => {
  it("defines optional producer markers and command correlation in the source schema", () => {
    const assistantProperties = schema.$defs.SSEEventAssistantMessage.properties;
    expect(assistantProperties?.attachment_ids).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(assistantProperties?.attachment_output).toEqual({ const: true });
    expect(assistantProperties?.output_command_id).toEqual({ type: "string" });

    for (const eventName of ["SSEEventComplete", "SSEEventTextStart", "SSEEventTextDelta", "SSEEventTextEnd"]) {
      expect(schema.$defs[eventName].properties?.output_command_id).toEqual({ type: "string" });
    }
  });

  it("generates explicit optional field types for the typed output fixture", () => {
    const assistantInterface = generatedInterface("SSEEventAssistantMessage");
    expect(assistantInterface).toContain("attachment_ids?: string[];");
    expect(assistantInterface).toContain("attachment_output?: true;");
    expect(assistantInterface).toContain("output_command_id?: string;");
    for (const eventName of ["SSEEventComplete", "SSEEventTextStart", "SSEEventTextDelta", "SSEEventTextEnd"]) {
      expect(generatedInterface(eventName)).toContain("output_command_id?: string;");
    }
  });

  it("keeps marker and text lifecycle events correlated to the same output command", () => {
    const markerAttachmentIds: string[] = marker.attachment_ids ?? [];
    const markerOutput: true | undefined = marker.attachment_output;
    const commandIds: Array<string | undefined> = [
      marker.output_command_id,
      complete.output_command_id,
      textStart.output_command_id,
      textDelta.output_command_id,
      textEnd.output_command_id,
    ];

    expect(marker).toMatchObject({
      type: "assistant_message",
      content: "",
      attachment_ids: ["asset-output-1"],
      attachment_output: true,
      output_command_id: "command-output-1",
    });
    expect(markerAttachmentIds).toEqual(["asset-output-1"]);
    expect(markerOutput).toBe(true);
    expect(commandIds).toEqual(Array(5).fill("command-output-1"));
  });

  it("keeps legacy assistant and complete events valid without output fields", () => {
    const legacyAssistant = fixture.legacySessionOutputEvents.assistant as SSEEventAssistantMessage;
    const legacyComplete = fixture.legacySessionOutputEvents.complete as SSEEventComplete;
    expect(legacyAssistant).toEqual({ type: "assistant_message", text: "legacy response" });
    expect(legacyComplete).toEqual({ type: "complete" });
    expect(schema.$defs.SSEEventAssistantMessage.required).toEqual(["type"]);
    expect(schema.$defs.SSEEventComplete.required).toEqual(["type"]);
    expect(schema.$defs.SSEEventAssistantMessage.additionalProperties).toBe(true);
    expect(schema.$defs.SSEEventComplete.additionalProperties).toBe(true);
  });
});
