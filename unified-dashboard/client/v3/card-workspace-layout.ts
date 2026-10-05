import { MIN_WORKSPACE_SPLIT, WORKSPACE_SPLIT_STEP } from "./folder-workspace-run-model";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";

export const CARD_WORKSPACE_DEFAULT_CARD_WIDTH = 750;
export const CARD_WORKSPACE_DEFAULT_CHAT_WIDTH = 900;
export interface CardWorkspaceLayout { totalWidth:number; ratio:number }
const defaultRatio=CARD_WORKSPACE_DEFAULT_CARD_WIDTH/(CARD_WORKSPACE_DEFAULT_CARD_WIDTH+CARD_WORKSPACE_DEFAULT_CHAT_WIDTH);

export function cardWorkspaceLayout(workspaceWidth:number,requested:CardWorkspaceLayout|null=null) {
 const minimum=workspaceWidth*MIN_WORKSPACE_SPLIT/100;
 const totalWidth=Math.min(workspaceWidth,Math.max(minimum*2+V3_PANEL_GAP_PX,requested?.totalWidth??CARD_WORKSPACE_DEFAULT_CARD_WIDTH+V3_PANEL_GAP_PX+CARD_WORKSPACE_DEFAULT_CHAT_WIDTH));
 const contentWidth=Math.max(0,totalWidth-V3_PANEL_GAP_PX);
 const ratio=contentWidth?Math.max(minimum/contentWidth,Math.min(requested?.ratio??defaultRatio,1-minimum/contentWidth)):defaultRatio;
 const cardWidth=Math.max(Math.min(minimum,contentWidth/2),Math.min(Math.round(contentWidth*ratio),contentWidth-minimum));
 return {totalWidth,ratio,cardWidth,chatWidth:contentWidth-cardWidth,minimum};
}

export function resizeCardWorkspace(workspaceWidth:number,current:CardWorkspaceLayout|null,deltaPx:number,edge:"left"|"middle") {
 const layout=cardWorkspaceLayout(workspaceWidth,current);
 return cardWorkspaceLayout(workspaceWidth,edge==="left"
  ?{totalWidth:layout.totalWidth-deltaPx,ratio:layout.ratio}
  :{totalWidth:layout.totalWidth,ratio:(layout.cardWidth+deltaPx)/(layout.totalWidth-V3_PANEL_GAP_PX)});
}

export function cardWorkspaceLayoutForKey(workspaceWidth:number,current:CardWorkspaceLayout|null,key:string,edge:"left"|"middle"):CardWorkspaceLayout|null|undefined {
 if(key==="Home")return null;
 if(key!=="ArrowLeft"&&key!=="ArrowRight")return undefined;
 return resizeCardWorkspace(workspaceWidth,current,(key==="ArrowLeft"?-1:1)*workspaceWidth*WORKSPACE_SPLIT_STEP/100,edge);
}
