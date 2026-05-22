import { describe, expect, it } from "vitest";

import {
  CODEX_APP_SERVER_METHODS,
  CODEX_APP_SERVER_PROTOCOL_SOURCE,
  toCodexUserInput,
} from "../../../src/engine/codex_app_server/protocol.js";

describe("codex app-server protocol boundary", () => {
  it("keeps supported method literals in one canonical map", () => {
    expect(CODEX_APP_SERVER_METHODS).toEqual({
      initialize: "initialize",
      threadStart: "thread/start",
      threadResume: "thread/resume",
      turnStart: "turn/start",
      turnSteer: "turn/steer",
      turnInterrupt: "turn/interrupt",
    });
  });

  it("documents the generated protocol source and refresh command", () => {
    expect(CODEX_APP_SERVER_PROTOCOL_SOURCE.generatedBy).toBe("codex-cli 0.133.0");
    expect(CODEX_APP_SERVER_PROTOCOL_SOURCE.command).toContain(
      "codex app-server generate-ts --experimental",
    );
    expect(CODEX_APP_SERVER_PROTOCOL_SOURCE.keyFiles).toContain(
      "ClientRequest.ts",
    );
    expect(CODEX_APP_SERVER_PROTOCOL_SOURCE.keyFiles).toContain(
      "v2/TurnSteerParams.ts",
    );
  });

  it("maps EngineUserInput to generated UserInput[] shape", () => {
    expect(
      toCodexUserInput({
        prompt: "hello",
        imageAttachmentPaths: ["/tmp/a.png", "/tmp/b.png"],
      }),
    ).toEqual([
      { type: "text", text: "hello", text_elements: [] },
      { type: "localImage", path: "/tmp/a.png" },
      { type: "localImage", path: "/tmp/b.png" },
    ]);
  });

  it("trims empty imageAttachmentPaths and keeps text-only input valid", () => {
    expect(toCodexUserInput({ prompt: "hello" })).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });
});
