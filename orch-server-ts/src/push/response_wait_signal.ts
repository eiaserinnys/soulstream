export type ResponseWaitSignal = {
  readonly kind: "ask_user_question" | "exit_plan_mode" | "permission_prompt" | "tool_approval";
  readonly title: string;
  readonly prompt: string;
};

export function responseWaitSignal(
  event: Record<string, unknown>,
  cachedToolInput: unknown,
): ResponseWaitSignal | undefined {
  if (event.type === "input_request") {
    return {
      kind: "ask_user_question",
      title: "입력 요청",
      prompt: inputRequestExcerpt(event),
    };
  }
  if (
    event.type === "claude_runtime_mode_state" &&
    event.mode === "plan" &&
    event.active === false &&
    stringValue(event.tool_name, event.toolName) === "ExitPlanMode"
  ) {
    return {
      kind: "exit_plan_mode",
      title: "플랜 검토 요청",
      prompt: toolInputExcerpt(cachedToolInput) || "ExitPlanMode",
    };
  }
  if (event.type === "claude_runtime_notification") {
    const notificationType = normalizedString(event.notification_type, event.notificationType);
    const key = normalizedString(event.key);
    if (notificationType === "permission" || key === "permission") {
      const title = meaningful(event.title);
      const message = meaningful(event.message);
      return {
        kind: "permission_prompt",
        title: "권한 요청",
        prompt: title && message && title !== message ? `${title}: ${message}` : title || message,
      };
    }
  }
  if (event.type === "tool_approval_requested") {
    const toolName = meaningful(event.tool_name ?? event.toolName) || "tool";
    const excerpt = toolInputExcerpt(event.tool_input ?? event.toolInput);
    return {
      kind: "tool_approval",
      title: "도구 승인 요청",
      prompt: excerpt ? `${toolName}: ${excerpt}` : toolName,
    };
  }
  return undefined;
}

function inputRequestExcerpt(event: Record<string, unknown>): string {
  if (Array.isArray(event.questions)) {
    for (const question of event.questions) {
      const record = recordValue(question);
      const text = record === undefined
        ? meaningful(question)
        : firstMeaningful(record.question, record.header, record.label, record.description);
      if (text) return text;
    }
  }
  return firstMeaningful(event.prompt, event.message, event.title);
}

function toolInputExcerpt(value: unknown): string {
  const record = recordValue(value);
  if (record !== undefined) {
    const text = firstMeaningful(
      record.plan,
      record.message,
      record.summary,
      record.content,
      record.prompt,
      record.question,
      record.command,
    );
    if (text) return text;
    const values = Object.values(record);
    if (values.length === 1) return jsonPreview(values[0]);
  }
  return jsonPreview(value);
}

function jsonPreview(value: unknown): string {
  if (typeof value === "string") return meaningful(value);
  try {
    return meaningful(JSON.stringify(value));
  } catch {
    return meaningful(value);
  }
}

function firstMeaningful(...values: unknown[]): string {
  for (const value of values) {
    const text = meaningful(value);
    if (text) return text;
  }
  return "";
}

function meaningful(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!text || ["{}", "[]", "null", "undefined"].includes(text)) return "";
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

function normalizedString(...values: unknown[]): string {
  return stringValue(...values).toLowerCase();
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
