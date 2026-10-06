import { MIN_WORKSPACE_SPLIT, WORKSPACE_SPLIT_STEP } from "./folder-workspace-run-model";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";

export const CARD_WORKSPACE_DEFAULT_CARD_WIDTH = 750;
export const CARD_WORKSPACE_DEFAULT_CHAT_WIDTH = 900;
export interface CardWorkspaceLayout { totalWidth:number|null; ratio:number|null }
const defaultRatio=CARD_WORKSPACE_DEFAULT_CARD_WIDTH/(CARD_WORKSPACE_DEFAULT_CARD_WIDTH+CARD_WORKSPACE_DEFAULT_CHAT_WIDTH);

export function cardWorkspaceLayout(workspaceWidth:number,requested:CardWorkspaceLayout|null=null) {
 const available=Math.max(0,workspaceWidth);
 const totalMinimum=Math.min(available,available*MIN_WORKSPACE_SPLIT/100*2+V3_PANEL_GAP_PX);
 const totalWidth=Math.min(available,Math.max(totalMinimum,requested?.totalWidth??CARD_WORKSPACE_DEFAULT_CARD_WIDTH+V3_PANEL_GAP_PX+CARD_WORKSPACE_DEFAULT_CHAT_WIDTH));
 const gap=Math.min(V3_PANEL_GAP_PX,totalWidth);
 const contentWidth=totalWidth-gap;
 const minimum=Math.min(available*MIN_WORKSPACE_SPLIT/100,contentWidth/2);
 const ratio=contentWidth?Math.max(minimum/contentWidth,Math.min(requested?.ratio??defaultRatio,1-minimum/contentWidth)):defaultRatio;
 const cardWidth=Math.max(Math.min(minimum,contentWidth/2),Math.min(Math.round(contentWidth*ratio),contentWidth-minimum));
 return {totalWidth,ratio,cardWidth,chatWidth:contentWidth-cardWidth,minimum,totalMinimum,gap};
}

export function resizeCardWorkspace(workspaceWidth:number,current:CardWorkspaceLayout|null,deltaPx:number,edge:"left"|"middle"):CardWorkspaceLayout|undefined {
 const layout=cardWorkspaceLayout(workspaceWidth,current);
 if(edge==="left"){
  const next=cardWorkspaceLayout(workspaceWidth,{totalWidth:layout.totalWidth-deltaPx,ratio:current?.ratio??null});
  return next.totalWidth===layout.totalWidth?undefined:{totalWidth:next.totalWidth,ratio:current?.ratio??null};
 }
 if(layout.totalWidth===layout.gap)return undefined;
 const next=cardWorkspaceLayout(workspaceWidth,{totalWidth:layout.totalWidth,ratio:(layout.cardWidth+deltaPx)/(layout.totalWidth-layout.gap)});
 return next.cardWidth===layout.cardWidth?undefined:{totalWidth:current?.totalWidth??null,ratio:next.ratio};
}

export function cardWorkspaceLayoutForKey(workspaceWidth:number,current:CardWorkspaceLayout|null,key:string,edge:"left"|"middle"):CardWorkspaceLayout|null|undefined {
 if(key==="Home")return null;
 if(key!=="ArrowLeft"&&key!=="ArrowRight")return undefined;
 return resizeCardWorkspace(workspaceWidth,current,(key==="ArrowLeft"?-1:1)*workspaceWidth*WORKSPACE_SPLIT_STEP/100,edge);
}
