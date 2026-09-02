export interface PendingRuntimeTaskFollowup {
  taskId: string;
  status?: string;
  outputFile?: string;
  summary?: string;
  description?: string;
  toolUseId?: string;
  error?: string;
  terminalRevision: string;
  firstSeen: number;
}

export function buildClaudeRuntimeTaskFollowupPrompt(
  items: PendingRuntimeTaskFollowup[],
): string {
  const allCompleted = items.every((item) => item.status === "completed");
  const taskLines = items.map((item, index) => {
    const fields = [
      `task_id=${item.taskId}`,
      item.status ? `status=${item.status}` : undefined,
      item.outputFile ? `output_file=${item.outputFile}` : undefined,
      item.summary ? `summary=${item.summary}` : undefined,
      item.description ? `description=${item.description}` : undefined,
      item.toolUseId ? `tool_use_id=${item.toolUseId}` : undefined,
      item.error ? `error=${item.error}` : undefined,
    ].filter(Boolean);
    return `${index + 1}. ${fields.join(" | ")}`;
  });
  const statusNotes = items
    .map((item, index) => formatRuntimeTaskStatusNote(index + 1, item))
    .filter(Boolean);

  return [
    "<claude-runtime-background-task-followup>",
    allCompleted
      ? "백그라운드 Claude runtime task가 완료되었습니다."
      : "백그라운드 Claude runtime task가 종료되었습니다. 일부 항목은 완료되지 않았을 수 있습니다.",
    allCompleted
      ? "아래 완료 항목을 확인하고 사용자가 기대한 다음 작업을 즉시 이어서 진행하세요."
      : "아래 항목의 실제 status를 먼저 확인하고, 완료되지 않은 항목은 필요한 경우 다른 방식으로 작업을 재수립하세요.",
    "output_file이나 summary가 있으면 먼저 읽어 실제 결과를 검증하세요.",
    ...statusNotes,
    "직전 응답을 그대로 반복하지 마세요. 진행할 수 없다면 이유와 필요한 사용자 확인을 명시하세요.",
    "",
    ...taskLines,
    "</claude-runtime-background-task-followup>",
  ].join("\n");
}

export function buildFollowupKey(
  sessionId: string,
  items: PendingRuntimeTaskFollowup[],
): string {
  return `${sessionId}:${items.map((item) => item.taskId).join(",")}`;
}

export function buildTaskKey(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

function formatRuntimeTaskStatusNote(
  index: number,
  item: PendingRuntimeTaskFollowup,
): string | undefined {
  switch (item.status) {
    case "completed":
      return undefined;
    case "failed":
      return `${index}. status=failed 항목은 실패했습니다. error나 output_file이 있으면 원인을 확인한 뒤 재시도 가능 여부를 판단하세요.`;
    case "stopped":
      return `${index}. status=stopped 항목은 완료 전에 중단되었습니다. 결과가 없을 수 있습니다. output_file이나 summary가 있으면 부분 결과만 신뢰하세요.`;
    case "killed":
      return `${index}. status=killed 항목은 완료 전에 강제 종료되었습니다. 결과가 없을 수 있습니다. 턴 종료 teardown 등으로 끊긴 작업은 필요한 경우 다른 방식으로 재수립하세요.`;
    default:
      return item.status
        ? `${index}. status=${item.status} 항목은 완료 여부를 단정하지 말고 실제 결과를 먼저 확인하세요.`
        : undefined;
  }
}
