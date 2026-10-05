/** @vitest-environment jsdom */
import {afterEach,expect,it} from "vitest";
import {cardWorkspaceLayout,cardWorkspaceLayoutForKey,resizeCardWorkspace} from "./card-workspace-layout";
import {readV3CardWorkspaceLayout,writeV3CardWorkspaceLayout,V3_CARD_WORKSPACE_STORAGE_KEY} from "./v3-session-panel-width";
afterEach(()=>localStorage.clear());
it("defaults to exactly 750 and 900 in wide windows and rounds the smaller pair",()=>{
 expect(cardWorkspaceLayout(2200)).toMatchObject({totalWidth:1666,cardWidth:750,chatWidth:900});
 expect(cardWorkspaceLayout(1072)).toMatchObject({totalWidth:1072,cardWidth:480,chatWidth:576,minimum:268});
});
it("clamps both handles to the absolute panel minimum and adjusts ratio at the pair minimum",()=>{
 const min=resizeCardWorkspace(1072,{totalWidth:900,ratio:0.7},500,"left");
 expect(min).toMatchObject({totalWidth:552,cardWidth:268,chatWidth:268,ratio:0.5});
 expect(resizeCardWorkspace(1072,null,-2000,"middle").cardWidth).toBe(268);
 expect(resizeCardWorkspace(1072,null,2000,"middle").chatWidth).toBe(268);
 expect(resizeCardWorkspace(2200,null,-1000,"left").totalWidth).toBe(2200);
 const smaller=cardWorkspaceLayout(1072,{totalWidth:2000,ratio:0.8});
 expect(smaller.totalWidth).toBe(1072);expect(smaller.chatWidth).toBe(268);
});
it("remembers explicit adjustments across openings and clears them with Home",()=>{
 expect(readV3CardWorkspaceLayout()).toBeNull();
 const chosen=resizeCardWorkspace(2200,null,100,"left");writeV3CardWorkspaceLayout(chosen);
 expect(readV3CardWorkspaceLayout()).toEqual({totalWidth:chosen.totalWidth,ratio:chosen.ratio});
 expect(cardWorkspaceLayout(2200,readV3CardWorkspaceLayout()).totalWidth).toBe(1566);
 writeV3CardWorkspaceLayout(cardWorkspaceLayoutForKey(2200,chosen,"Home","middle")!);
 expect(localStorage.getItem(V3_CARD_WORKSPACE_STORAGE_KEY)).toBeNull();
 expect(cardWorkspaceLayout(2200,readV3CardWorkspaceLayout()).cardWidth).toBe(750);
 expect(cardWorkspaceLayoutForKey(2200,null,"Enter","left")).toBeUndefined();
});
