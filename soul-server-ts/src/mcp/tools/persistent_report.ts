import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "@soulstream/mcp-contract";
import { z } from "zod";
import type { PersistentReportResult } from "@soulstream/wire-schema/persistent-report";
import { getCurrentMcpCallerSessionId } from "../request_context.js";
import type { McpRuntime } from "../runtime.js";

export function registerPersistentReportTools(server: McpServer, runtime: McpRuntime): void {
  const invoke = async (operation: "put" | "remove", input: Record<string, unknown>) => {
    const sessionId = getCurrentMcpCallerSessionId();
    if (!sessionId) return errorResult("호출 세션 정보를 찾을 수 없습니다");
    if (!runtime.persistentReports) return errorResult("보고 저장 서비스를 사용할 수 없습니다");
    try {
      const result = operation === "put"
        ? await runtime.persistentReports.put(sessionId,input)
        : await runtime.persistentReports.remove(sessionId,String(input.key));
      return toolResult(result);
    } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
  };
  server.registerTool("put_report_entry", {
    description: "호출한 영구 에이전트 세션의 보고 한 장을 저장한다. 같은 key는 원래 자리에서 통째로 교체하며 새 key는 끝에 추가한다. 최대 12장이다. key는 소문자·숫자로 시작하는 소문자·숫자·밑줄·하이픈 1~48자. kind: ask 또는 see. title 24자, card_numbers 정수 0~3개, context 120자, action은 보이는 글 100자(링크 주소는 세지 않음)·전체 원문 1,000자·링크 5개까지(글과 [글](https://…) 링크만), options 0~3개·각 12자, question_id 선택. see에 options가 있거나 state가 answered면 거절된다. state는 open 또는 answered이며 생략하면 open, answer는 40자 이내이며 생략하면 빈 문자열. updated_at은 서버가 적는다. 길이는 코드포인트로 센다. 없는 카드·질문, 한도와 형식 위반, 영구 세션이 아닌 호출은 거절 사유와 칸을 반환한다. 결과의 entries는 현재 장의 key와 title 목록이다. cq_와 card_로 시작하는 key는 서버가 쓰는 장이라 거부되고, 이 세션이 만들거나 실행시킨 카드의 번호를 넣은 장도 거부된다(그 카드는 서버가 판에 올린다).",
    inputSchema: z.object({key:z.string(),kind:z.string(),title:z.string(),card_numbers:z.array(z.number()),context:z.string(),action:z.string(),options:z.array(z.string()).optional(),question_id:z.string().optional(),state:z.string().optional(),answer:z.string().optional()}).passthrough(),
    annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:true},
  }, async input => invoke("put",input));
  server.registerTool("remove_report_entry", {
    description: "호출한 영구 에이전트 세션의 보고에서 key에 해당하는 한 장을 내린다. 없는 key는 판을 바꾸지 않는다. key는 소문자·숫자로 시작하는 소문자·숫자·밑줄·하이픈 1~48자다. 영구 세션이 아닌 호출과 형식 위반은 거절된다. 결과의 entries는 현재 장의 key와 title 목록이다.",
    inputSchema:z.object({key:z.string()}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true},
  }, async input => invoke("remove",input));
}

function toolResult(result: PersistentReportResult) {
  if (!result.ok) return { ...errorResult(result.errors.map(e=>`${e.path}: ${e.reason}`).join("\n")), structuredContent:result };
  return jsonResult({ok:true,changed:result.changed,entries:result.entries});
}
