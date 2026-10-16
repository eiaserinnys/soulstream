import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { OpenCodeEngineAdapter } from "../../../src/engine/opencode/adapter.js";

describe("OpenCode DeepSeek live contract", () => {
  it.skipIf(process.env.OPENCODE_LIVE !== "1")("reads a file, follows instructions, and resumes the same backend session", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-live-"));
    const workspaceDir = join(root, "workspace");
    const sessionDirectory = join(root, "session");
    const marker = "OPENCODE_READ_TOOL_398";
    const instructionMarker = "OPENCODE_INSTRUCTIONS_398";
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "live-marker.txt"), marker);
    const engine = new OpenCodeEngineAdapter({
      workspaceDir,
      agentId: "opencode-live-test",
      sessionDirectory,
      executablePath: process.env.OPENCODE_CLI_PATH,
      processEnv: process.env,
    }, pino({ level: "silent" }));
    const collect = async (params: Parameters<OpenCodeEngineAdapter["execute"]>[0]) => {
      const events = [];
      for await (const event of engine.execute(params)) events.push(event);
      return events;
    };

    try {
      const first = await collect({
        agentSessionId: "opencode-live-session-398",
        model: "opencode/deepseek-v4.1-flash-free",
        systemPrompt: `Include the literal marker ${instructionMarker} in your final answer.`,
        prompt: "Use the read tool to read live-marker.txt and reply with its exact content.",
      });
      const sessionId = first.find((event) => event.type === "session");
      const firstText = first.filter((event) => event.type === "assistant_message")
        .map((event) => event.type === "assistant_message" ? event.content : "").join("\n");
      expect(sessionId?.type === "session" ? sessionId.session_id : undefined).toBeTruthy();
      expect(first.some((event) => event.type === "tool_start" && event.tool_name === "read")).toBe(true);
      expect(first.some((event) => event.type === "complete")).toBe(true);
      expect(first.some((event) => event.type === "error" && event.fatal)).toBe(false);
      expect(firstText).toContain(marker);
      expect(firstText).toContain(instructionMarker);

      const resumed = await collect({
        agentSessionId: "opencode-live-session-398",
        model: "opencode/deepseek-v4.1-flash-free",
        prompt: "Repeat the read marker and instruction marker from our previous turn.",
        resumeSessionId: sessionId?.type === "session" ? sessionId.session_id : undefined,
      });
      const resumedText = resumed.filter((event) => event.type === "assistant_message")
        .map((event) => event.type === "assistant_message" ? event.content : "").join("\n");
      expect(resumed.find((event) => event.type === "session")).toMatchObject({
        type: "session",
        session_id: sessionId?.type === "session" ? sessionId.session_id : undefined,
      });
      expect(resumed.some((event) => event.type === "complete")).toBe(true);
      expect(resumed.some((event) => event.type === "error" && event.fatal)).toBe(false);
      expect(resumedText).toContain(marker);
      expect(resumedText).toContain(instructionMarker);
      process.stdout.write(`OPENCODE_LIVE_RESULT session=${sessionId?.type === "session" ? sessionId.session_id : "missing"} marker=${marker} resumed=${resumed.find((event) => event.type === "session")?.type === "session" ? "same" : "missing"}\n`);
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
