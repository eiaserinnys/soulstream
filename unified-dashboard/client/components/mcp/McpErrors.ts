import { McpApiError, type McpConfig } from "../../lib/mcp-api";
import type { DeleteTarget } from "./McpDialogs";

export class PartialProfileSaveError extends Error {}
export function errorText(
  error: unknown,
  config: McpConfig | null,
  target: DeleteTarget | null,
): string {
  if (error instanceof PartialProfileSaveError)
    return "일부 프로필에 추가됐습니다. 다시 읽은 뒤 나머지를 확인해 주세요.";
  if (!(error instanceof McpApiError))
    return "요청에 실패했습니다. 다시 시도해 주세요.";
  if (
    error.code.endsWith("_VERSION_CONFLICT") ||
    error.code === "MCP_REVISION_CONFLICT"
  )
    return "다른 곳에서 변경됐습니다. 다시 읽은 뒤 저장해 주세요.";
  if (error.code === "MCP_SERVER_INUSE")
    return `사용 중인 프로필: ${
      config?.profiles
        .filter((p) => p.mcp_servers.includes(target?.id ?? ""))
        .map((p) => p.name || p.id)
        .join(", ") || error.message
    }`;
  if (error.code === "MCP_PROFILE_INUSE")
    return `연결된 에이전트: ${
      config?.bindings
        .filter((b) => b.mcp_profile_id === target?.id)
        .map((b) => `${b.agent_id} (${b.node_id})`)
        .join(", ") || error.message
    }`;
  if (error.code === "MCP_SECRET_INUSE") {
    const secret = config?.secrets.find((s) => s.name === target?.id);
    return `사용 중인 서버: ${secret?.servers.join(", ") || "없음"} / 프로필: ${secret?.profiles.join(", ") || "없음"}`;
  }
  const messages: Record<string, string> = {
    MCP_DUPLICATE_SERVER_NAME:
      "같은 노드에서 쓰는 전송 이름입니다. 이름을 바꿔 주세요.",
    MCP_MIXED_SECRET_ENV_REF:
      "하나의 값에 비밀 참조와 환경 변수 참조를 함께 쓸 수 없습니다.",
    MCP_INVALID_ICON: "아이콘을 다시 선택해 주세요.",
    MCP_INVALID_ICON_UPLOAD: "이미지 형식과 크기를 확인해 주세요.",
    MCP_ROLLBACK_BROKEN_REFERENCE:
      "참조 대상이 없어 이 판으로 되돌릴 수 없습니다.",
  };
  return (
    messages[error.code] ??
    "요청에 실패했습니다. 입력과 연결 상태를 확인하고 다시 시도해 주세요."
  );
}
