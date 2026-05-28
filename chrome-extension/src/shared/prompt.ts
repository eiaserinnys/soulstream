import { actionDefinition, type PageActionPayload } from "./schema.js";

function field(label: string, value: string): string {
  return value ? `- ${label}: ${value}` : `- ${label}: (empty)`;
}

function block(label: string, value: string): string {
  if (!value) return `## ${label}\n\n(empty)`;
  return `## ${label}\n\n${value}`;
}

export function buildSoulstreamPrompt(payload: PageActionPayload): string {
  const action = actionDefinition(payload.action);
  const bodyLabel = payload.bodyTruncated
    ? `본문 후보 (truncated at ${payload.bodyCharLimit} chars)`
    : "본문 후보";
  const extractionNote = payload.extractionError
    ? `${payload.extractionStatus}: ${payload.extractionError}`
    : payload.extractionStatus;

  return [
    "Chrome 확장에서 사용자가 우클릭 메뉴로 보낸 페이지입니다.",
    "",
    `작업: ${action.title}`,
    `지시: ${action.instruction}`,
    "",
    "## 페이지 메타",
    "",
    field("URL", payload.url),
    field("Title", payload.title),
    field("Meta description", payload.metaDescription),
    field("Extraction", extractionNote),
    field("Source", payload.source),
    "",
    block("선택 영역", payload.selectionText),
    "",
    block(bodyLabel, payload.bodyText),
    "",
    "## 처리 원칙",
    "",
    "- 제공된 페이지 정보만 근거로 삼아줘.",
    "- 본문 후보가 비어 있거나 잘렸으면 그 한계를 결과에 명시해줘.",
    "- URL은 출처로 보존해줘.",
  ].join("\n");
}
