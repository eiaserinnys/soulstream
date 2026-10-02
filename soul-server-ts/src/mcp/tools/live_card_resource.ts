import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LIVE_CARD_RESOURCE } from "@soulstream/mcp-contract";
import { widgetHtml } from "../../../../plugins/chatgpt-card-renderer/src/widget-html.js";
export function registerLiveCardResource(server: McpServer) {
 server.registerResource("soulstream-live-cards",LIVE_CARD_RESOURCE,{},async()=>({contents:[{uri:LIVE_CARD_RESOURCE,mimeType:"text/html;profile=mcp-app",text:widgetHtml,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}}]}));
}
