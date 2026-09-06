export interface ClaudeNativeTaskNotification {
  taskId: string;
  toolUseId: string;
  status: "completed" | "failed" | "stopped";
  outputFile?: string;
  summary?: string;
}

const ENVELOPE = /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/g;

export function parseClaudeNativeTaskNotification(text: string):
  ClaudeNativeTaskNotification | undefined {
  const openingCount = text.match(/<task-notification\b[^>]*>/g)?.length ?? 0;
  const closingCount = text.match(/<\/task-notification>/g)?.length ?? 0;
  if (openingCount !== 1 || closingCount !== 1) return undefined;
  const found = findClaudeNativeTaskNotifications(text);
  return found.length === 1 ? found[0] : undefined;
}

export function findClaudeNativeTaskNotifications(text: string): ClaudeNativeTaskNotification[] {
  const output: ClaudeNativeTaskNotification[] = [];
  for (const match of text.matchAll(ENVELOPE)) {
    const fields = directXmlFields(match[1] ?? "");
    if (!fields) continue;
    const taskId = fields.get("task-id");
    const toolUseId = fields.get("tool-use-id");
    const status = fields.get("status");
    if (
      !taskId || !toolUseId ||
      (status !== "completed" && status !== "failed" && status !== "stopped")
    ) continue;
    output.push({ taskId, toolUseId, status,
      ...(fields.get("output-file") ? { outputFile: fields.get("output-file") } : {}),
      ...(fields.get("summary") ? { summary: fields.get("summary") } : {}),
    });
  }
  return output;
}

function directXmlFields(body: string): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  const stack: string[] = [];
  let direct: { name: string; contentStart: number } | undefined;
  let lastIndex = 0;
  const tags = /<(\/)?([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?(\/?)>/g;
  for (const match of body.matchAll(tags)) {
    lastIndex = (match.index ?? 0) + match[0].length;
    const closing = match[1] === "/";
    const name = match[2]!;
    const selfClosing = match[3] === "/";
    if (closing) {
      if (stack.at(-1) !== name) return undefined;
      if (stack.length === 1 && direct?.name === name) {
        const value = body.slice(direct.contentStart, match.index).trim();
        if (!value || fields.has(name)) return undefined;
        fields.set(name, decodeXml(value));
        direct = undefined;
      }
      stack.pop();
      continue;
    }
    if (selfClosing) continue;
    if (stack.length === 0) {
      direct = { name, contentStart: (match.index ?? 0) + match[0].length };
    }
    stack.push(name);
  }
  if (stack.length > 0 || direct || /<[^>]*$/.test(body.slice(lastIndex))) return undefined;
  return fields;
}

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}
