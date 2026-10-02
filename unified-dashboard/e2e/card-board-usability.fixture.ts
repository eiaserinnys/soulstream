import {test,expect,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {reviewCard,reviewTitle,reviewSession} from "../client/v3/components-review-fixtures";
import {DEFAULT_USER_PREFERENCES} from "../../packages/soul-ui/src/lib/user-preferences";
const output=path.resolve("../../../.local/artifacts/20261002-card-board-usability");
const seed=()=>["todo","queued","running","blocked","review","done"].flatMap((status,index)=>Array.from({length:index===0?4:1},(_,copy)=>({...reviewCard,id:`home-${index}-${copy}`,folderId:"folder-amber",status:status as typeof reviewCard.status,
 title:status==="todo"?reviewTitle:`${status} 카드`,latestActivity:{kind:status==="todo"?"instruction" as const:"report" as const,format:"markdown" as const,body:"긴 한국어 원문과 제목이 있어도 열과 카드 폭을 유지합니다. 마지막 지시와 보고는 카드 상세에서 이어 봅니다. ".repeat(6),createdAt:reviewCard.createdAt}})));
export async function fixture(page:Page,fontSize=17,longSession=false){
 const cards=seed(),reads:string[]=[],creates:Record<string,unknown>[]=[],writes:{id:string;body:Record<string,unknown>}[]=[];
 let failure=false,delay=false;
 await page.addInitScript(()=>{localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});
  const Native=EventSource,sources:EventSource[]=[];let sequence=0;
  window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);sources.push(this);}};
  Object.assign(window,{emitCard:(cardId:string)=>sources.filter(source=>source.url.includes("/api/sessions/stream")).forEach(source=>source.dispatchEvent(new MessageEvent("card_updated",{data:JSON.stringify({type:"card_updated",cardId,folderId:"folder-amber"}),lastEventId:`card-home-${++sequence}`})))});
 });
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
 await page.route("**/api/auth/config",route=>route.fulfill({json:{authEnabled:true,devModeEnabled:false}}));
 await page.route("**/api/auth/status",route=>route.fulfill({json:{authenticated:true,user:{email:"home@example.test",name:"검수"}}}));
 await page.route("**/api/user/preferences",route=>route.fulfill({json:{email:"home@example.test",preferences:{...DEFAULT_USER_PREFERENCES,chatFontSize:fontSize},hasBackground:false}}));
 await page.route("**/api/cards",async route=>{
  if(route.request().method()==="GET")return route.fulfill({json:{cards}});
  const body=route.request().postDataJSON();creates.push(body);
  if(failure)return route.fulfill({status:409,json:{message:"fixture create conflict"}});
  const card={...reviewCard,id:"created",folderId:body.folderId,title:body.title,request:body.request,status:"todo" as const};cards.push(card);return route.fulfill({status:201,json:{card}});
 });
 await page.route("**/api/cards/**",async route=>{
  const request=route.request(),parts=new URL(request.url()).pathname.split("/"),card=cards.find(card=>card.id===parts[3]);
  if(!card)return route.fulfill({status:404,json:{message:"fixture 카드 없음"}});
  if(request.method()==="POST"){
   const body=request.postDataJSON();writes.push({id:card.id,body});
   if(delay)await new Promise(done=>setTimeout(done,600));
   if(failure)return route.fulfill({status:409,json:{message:"fixture version conflict"}});
   if(body.expectedVersion!==card.version)return route.fulfill({status:409,json:{message:"expectedVersion 불일치"}});
   card.status=body.status;card.version++;
  }else reads.push(card.id);
  return route.fulfill({json:{card,reports:[{id:"report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
   questions:card.id==="home-3-0"?[{id:"q",text:"질문",answer:null,options:null,askedAt:"",answeredAt:null}]:[],sessions:[]}});
 });
 if(longSession)await page.route(/\/api\/sessions(?:\?.*)?$/,route=>route.fulfill({json:{sessions:[{...reviewSession,displayName:reviewTitle,prompt:reviewTitle,cardId:'home-0-0'}],total:1}}));
 await page.goto("/");await expect(page.getByTestId("card-home")).toBeVisible();
 const board=page.getByTestId("card-home").locator(".v3-card-board");await expect(board.locator("[data-board-column]")).toHaveCount(6);
 return {cards,reads,writes,creates,board,setFailure:(value:boolean)=>{failure=value;},setDelay:(value:boolean)=>{delay=value;}};
}
