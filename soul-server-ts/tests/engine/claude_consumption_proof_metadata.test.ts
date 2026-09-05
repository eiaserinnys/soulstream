import { describe, expect, it } from "vitest";

import { ClaudeSdkEventMapper } from "../../src/engine/claude_sdk_event_mapper.js";
import { ClaudeRuntimeState } from "../../src/engine/claude_sdk_runtime_state.js";
import { mapClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import {
  readClaudeResultReceiptMetadata,
} from "../../src/engine/claude_result_receipt_metadata.js";
import {
  readClaudeToolResultReceiptMetadata,
} from "../../src/engine/claude_tool_result_receipt_metadata.js";
import { claudeEngineEventMetadata } from "../../src/engine/claude_adapter.js";
import { restoreRunnerEngineEventMetadata } from "../../src/runner/engine_event_stream.js";
import { readClaudeSdkSessionMetadata } from
  "../../src/engine/claude_sdk_session_metadata.js";

describe("Claude consumption proof metadata", () => {
  it("SDK Result user_message_uuid를 public SSE 밖의 runner metadata로 왕복한다", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    const result = mapper.mapResultMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      user_message_uuid: "f07454b2-da48-5793-b30a-4727c591e424",
    })[0]!;
    const payload = mapClaudeClientEvent(result)[0]!;
    const serialized = JSON.parse(JSON.stringify(payload));
    const metadata = claudeEngineEventMetadata(payload);
    restoreRunnerEngineEventMetadata(serialized, metadata);

    expect(payload.type).toBe("result");
    expect(JSON.stringify(payload)).not.toContain("user_message_uuid");
    expect(readClaudeResultReceiptMetadata(serialized)).toEqual({
      inputUuid: "f07454b2-da48-5793-b30a-4727c591e424",
    });
  });

  it("tool_result의 typed envelope만 내부 proof metadata로 보존한다", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    mapper.mapAssistantMessage({
      message: {
        content: [{
          type: "tool_use",
          id: "lookup-tool",
          name: "TaskOutput",
          input: { task_id: "task-1", block: true, timeout: 60_000 },
        }],
      },
    });
    const result = mapper.mapUserMessage({
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "lookup-tool",
          content: "<output>status=running은 본문일 뿐</output>",
          is_error: false,
        }],
      },
      tool_use_result: {
        task_id: "task-1",
        retrieval_status: "success",
        status: "completed",
        output: "status=running은 본문일 뿐",
      },
    })[0]!;
    const payload = mapClaudeClientEvent(result)[0]!;
    const serialized = JSON.parse(JSON.stringify(payload));
    restoreRunnerEngineEventMetadata(serialized, claudeEngineEventMetadata(payload));

    expect(JSON.stringify(payload)).not.toContain("retrieval_status");
    expect(readClaudeToolResultReceiptMetadata(serialized)).toEqual({
      envelope: {
        task_id: "task-1",
        retrieval_status: "success",
        status: "completed",
        output: "status=running은 본문일 뿐",
      },
    });
  });

  it("synthetic background Bash generation keeps the SDK init session internally", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    mapper.mapSdkMessage({
      type: "system",
      subtype: "init",
      session_id: "sdk-session-init",
    } as never);
    mapper.mapSdkMessage({
      type: "assistant",
      uuid: "assistant-bash",
      message: {
        content: [{
          type: "tool_use",
          id: "toolu-bash",
          name: "Bash",
          input: { command: "sleep 30 &" },
        }],
      },
    } as never);
    const events = mapper.mapSdkMessage({
      type: "user",
      uuid: "user-bash",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu-bash",
          content: "background task started",
          is_error: false,
        }],
      },
      tool_use_result: {
        backgroundTaskId: "bash-task-1",
        rawOutputPath: "/tmp/bash-task-1.out",
      },
    } as never);
    const background = events.find(
      (event) => event.type === "claude_runtime_task_started",
    );

    expect(background).toMatchObject({
      type: "claude_runtime_task_started",
      taskId: "bash-task-1",
      toolUseId: "toolu-bash",
    });
    expect(background && "sessionId" in background ? background.sessionId : undefined)
      .toBeUndefined();
    expect(readClaudeSdkSessionMetadata(background!)).toEqual({
      sessionId: "sdk-session-init",
    });
    const payload = mapClaudeClientEvent(background!)[0]!;
    const serialized = JSON.parse(JSON.stringify(payload));
    restoreRunnerEngineEventMetadata(serialized, claudeEngineEventMetadata(payload));

    expect(JSON.stringify(payload)).not.toContain("sdk-session-init");
    expect(readClaudeSdkSessionMetadata(serialized)).toEqual({
      sessionId: "sdk-session-init",
    });
  });
});
