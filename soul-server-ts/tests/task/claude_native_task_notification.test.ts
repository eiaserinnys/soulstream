import { describe, expect, it } from "vitest";

import {
  findClaudeNativeTaskNotifications,
  parseClaudeNativeTaskNotification,
} from "../../src/task/claude_native_task_notification.js";

const exact = `<task-notification>
<task-id>task-1</task-id>
<tool-use-id>toolu-1</tool-use-id>
<status>completed</status>
<summary>done &amp; stored</summary>
</task-notification>`;

describe("Claude native task-notification parser", () => {
  it("parses one exact direct-field notification", () => {
    expect(parseClaudeNativeTaskNotification(exact)).toEqual({
      taskId: "task-1",
      toolUseId: "toolu-1",
      status: "completed",
      summary: "done & stored",
    });
    expect(findClaudeNativeTaskNotifications(`prefix\n${exact}\nsuffix`)).toHaveLength(1);
  });

  it.each([
    `<task-notification><task-id>task-1</task-id>`,
    `<task-notification><task-id>task-1</task-id><task-id>task-2</task-id><tool-use-id>toolu-1</tool-use-id><status>completed</status></task-notification>`,
    `${exact}\n${exact.replace("task-1", "task-2")}`,
    `<task-notification><wrapper><task-id>task-1</task-id></wrapper><tool-use-id>toolu-1</tool-use-id><status>completed</status></task-notification>`,
  ])("rejects malformed or ambiguous live XML", (text) => {
    expect(parseClaudeNativeTaskNotification(text)).toBeUndefined();
  });
});
