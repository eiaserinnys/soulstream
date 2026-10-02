import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { liveCardTools, LIVE_CARD_RESOURCE, type LiveCardQuery } from "@soulstream/mcp-contract";
export { LIVE_CARD_RESOURCE, liveCardOutputSchema, type LiveCardQuery } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";
import { registerLiveCardResource } from "./live_card_resource.js";
import { projectCards } from "../../../../plugins/chatgpt-card-renderer/src/card-data.js";

/** Reader must be the existing authorized FolderService path, never a public credential proxy. */
export function registerLiveCardView(server: McpServer, runtime: McpRuntime) {
 registerLiveCardResource(server);
 registerOrchestratorTools(server, runtime, Object.values(liveCardTools));
}
export function registerLiveCardViewLegacy(server:McpServer,readCards:(query:LiveCardQuery)=>Promise<unknown>){
 const read=async(query:LiveCardQuery)=>{
  try{
   const data=projectCards(await readCards(query),query.limit);
   return {content:[{type:"text" as const,text:`${data.total}개 중 ${data.cards.length}개 실제 카드를 조회했습니다.`}],structuredContent:{...data,sync:{folderId:query.folder_id??null,limit:query.limit,refreshSeconds:30,fetchedAt:new Date().toISOString()}}};
  }catch(error){
   const status=error&&typeof error==="object"?(error as {status?:number;statusCode?:number}).status??(error as {statusCode?:number}).statusCode:undefined;
   return {isError:true,content:[{type:"text" as const,text:"카드 동기화에 실패했습니다. 접근 권한과 서버 연결을 확인해 주세요."}],structuredContent:{syncError:{authorization:status===401||status===403}}};
  }
 };
 registerLiveCardResource(server);
 server.registerTool("show_live_card_view",liveCardTools.show_live_card_view.config,read);
 server.registerTool("list_live_cards",liveCardTools.list_live_cards.config,read);
}
