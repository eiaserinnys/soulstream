import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult, type CallToolResult } from "@soulstream/mcp-contract";
import {
  canonicalJson,
  renderText,
  validateChatUiDocument,
} from "@soulstream/chat-ui";
import { z } from "zod";
import { EventAcknowledgementTimeoutError } from "../../upstream/event_outbox_pump.js";
import { getCurrentMcpCallerSessionId } from "../request_context.js";
import type { McpRuntime } from "../runtime.js";

export function registerChatUiTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "publish_chat_ui",
    {
      description: `채팅 답변 안에 사용자가 직접 조작하는 화면 조각을 한 번 내보낸다. 값을 바꿔 가며 비교하거나 선택지를 고르게 할 때처럼 글보다 조작이 나은 경우에만 쓰고, 내보낸 내용을 글 답변에서 되풀이하지 않는다. 화면은 대화에 완성된 상태로 표시되고 고칠 수 없다(고치려면 새 publication_key로 다시 낸다). 조작은 사용자 화면에서만 계산되며 모델을 다시 부르지 않는다. 화면을 그리지 못하는 곳에서는 같은 내용이 글로 보인다.
document: {schema_version:1, title?, body:[노드], units?, data?, fields?, computed?, sources?, assumptions?:[문자열]}. title은 맨 위에 제목으로 표시되니 body의 heading으로 되풀이하지 않는다.
노드(모두 id 필수, visibleWhen?은 boolean 식): heading{level:1~3,parts} | text{parts,emphasis?:"strong"} | caption{parts} | group{layout:"stack"|"row"|"wrap",children} | slider{field,label} | checkbox{field,label} | form{items:[{field,label}],submitLabel,action:{type:"compose",parts?}} | button{label,action} | entity{label,details:parts,source?} | citation{source}. 종류는 kind에 적는다. entity는 누르면 details가 펼쳐지는 항목이다.
parts: 문자열 또는 {value:{data|field|computed:키},format?:"plain"|"number"|"percent",digits?,unit?}의 배열.
fields: 키→ number{initial,min,max,step,unit} | text{initial,maxLength} | boolean{initial} | choice{initial,options:[{id,label}]} | selection{initial:[],options}. 종류는 type에 적는다. choice와 selection의 initial은 options의 id이고 화면에는 label이 보인다.
units: 키→{dims:{차원:지수},symbol,scale}. 예: 원 {dims:{"currency:KRW":1},symbol:"원",scale:1}, 시간 {dims:{time:1},symbol:"h",scale:3600}, 무차원 {dims:{},symbol:"",scale:1}. 숫자 값에는 unit 키가 필수다.
data: 키→{value,unit?,source?}. computed: 키→식. 식: {op:"const",value,unit?} | {op:"ref",ref:{data|field|computed:키}} | add,mul(args 둘 이상) | sub,div,eq,lt,lte(args 둘) | and,or | not | if(args:[조건,참,거짓]). 차원이 맞지 않는 식은 거부된다. computed 수를 parts에 쓸 때는 unit을 준다.
action: {type:"compose",parts?}(입력창에 글을 더한다. 전송은 사용자가 한다) | {type:"set",field,value} | {type:"reset"} | {type:"copy"} | {type:"open_source",source}.
sources: 키→{type:"assumption",label,note?} | {type:"external_link",label,url(https)}. source에는 이 키를 쓴다.
키와 id는 영문자로 시작하는 영문, 숫자, 밑줄이다. 검증에 실패하면 결과의 path와 reason을 보고 고쳐 같은 publication_key로 다시 부른다.`,
      inputSchema: z.object({
        publication_key: z.string().min(1).max(64),
        document: z.record(z.string(), z.unknown()),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ publication_key, document }) => {
      const sessionId = getCurrentMcpCallerSessionId();
      if (!sessionId) return errorResult("호출 세션 정보를 찾을 수 없습니다.");

      const task = runtime.taskManager.getTask(sessionId);
      if (!task?.executionRegistration || task.orchestrationPurpose) {
        return errorResult("실행 중인 세션에서만 사용할 수 있습니다.");
      }

      const validation = validateChatUiDocument(document);
      if (!validation.ok) {
        const message = validation.errors
          .map((issue) => `${issue.path}: ${issue.reason}`)
          .join("\n");
        return errorResultWithContent(message, {
          code: "INVALID_CHAT_UI",
          errors: validation.errors,
        });
      }

      const doc = validation.document;
      const canonical = canonicalJson(doc);
      const hash = createHash("sha256").update(canonical).digest("hex");
      const uiId = `ui_${createHash("sha256")
        .update(`${sessionId}\n${publication_key}\n${hash}`)
        .digest("hex")
        .slice(0, 32)}`;
      const content = renderText(doc);
      const text = previewText(content);
      const outputCommandId = task.runner?.dispatcher.activeExecutionCommandId?.();
      const publisher = runtime.chatUiPublisher;
      if (!publisher) {
        return errorResultWithContent("chat UI event publisher is unavailable", {
          code: "PUBLISH_FAILED",
          reason: "chat UI event publisher is unavailable",
        });
      }

      const event = {
        type: "assistant_message",
        content,
        ...(outputCommandId ? { output_command_id: outputCommandId } : {}),
        ui: {
          schema_version: 1,
          ui_id: uiId,
          hash,
          revision: 1,
          document: doc,
        },
        timestamp: Date.now() / 1000,
        _dedupe_key: `chat-ui:${uiId}`,
      } as const;

      try {
        const { eventId } = await publisher.publish(
          sessionId,
          event,
          task.executionRegistration.registrationId,
        );
        return jsonResult({
          status: "committed",
          ui_id: uiId,
          hash,
          revision: 1,
          event_id: eventId,
          text,
        });
      } catch (error) {
        if (error instanceof EventAcknowledgementTimeoutError) {
          return jsonResult({
            status: "delivery_unconfirmed",
            ui_id: uiId,
            hash,
            text: "저장 확인 응답을 기다리지 못했습니다. 화면에는 이미 도착했을 수 있습니다. 같은 publication_key와 같은 문서로 다시 부르면 중복되지 않습니다.",
          });
        }
        const reason = error instanceof Error ? error.message : String(error);
        return errorResultWithContent(reason, { code: "PUBLISH_FAILED", reason });
      }
    },
  );
}

function previewText(content: string): string {
  const codePoints = Array.from(content);
  const truncated = codePoints.length > 400;
  return `${codePoints.slice(0, 400).join("")}${truncated ? "…" : ""}`;
}

function errorResultWithContent(
  message: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    ...errorResult(message),
    structuredContent,
  };
}
