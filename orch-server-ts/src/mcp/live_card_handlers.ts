import { projectCards } from "../../../plugins/chatgpt-card-renderer/src/card-data.js";
import type { liveCardTools } from "@soulstream/mcp-contract";
import { listCardRouteBody, cardRouteErrorResponse } from "../cards/card_route_body.js";
import type { McpToolHandler } from "./types.js";

const read: McpToolHandler = async (options, args) => {
  try {
    let raw;
    try { raw = await listCardRouteBody(options.cards, { folderId: args.folder_id }, options.cards.resolveAccess); }
    catch (error) { const response = cardRouteErrorResponse(error); throw Object.assign(new Error("card list failed"), { status: response.status }); }
    const data = projectCards(JSON.parse(JSON.stringify(raw)), args.limit as number);
    return { content: [{ type: "text", text: `${data.total}개 중 ${data.cards.length}개 실제 카드를 조회했습니다.` }],
      structuredContent: { ...data, sync: { folderId: args.folder_id ?? null, limit: args.limit, refreshSeconds: 30, fetchedAt: new Date().toISOString() } } };
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode : undefined;
    return { isError: true, content: [{ type: "text", text: "카드 동기화에 실패했습니다. 접근 권한과 서버 연결을 확인해 주세요." }], structuredContent: { syncError: { authorization: status === 401 || status === 403 } } };
  }
};
export const liveCardHandlers = { show_live_card_view: read, list_live_cards: read } satisfies Record<keyof typeof liveCardTools, McpToolHandler>;
