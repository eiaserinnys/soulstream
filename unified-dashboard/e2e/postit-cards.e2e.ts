import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output=path.resolve("../../../.local/artifacts/20261001-postit-product");
const phase=process.env.POSTIT_PHASE??"after";
const finishOnly=process.env.POSTIT_FINISH_ONLY==="1";
const folderOnly=process.env.POSTIT_FOLDER_ONLY==="1";
const verifyDrag=process.env.POSTIT_VERIFY_DRAG==="1";
mkdirSync(output,{recursive:true});
const original="실제 원문 미리보기입니다. 길어도 카드의 크기와 아래 담당·상태 위치는 유지합니다. 제목으로 보고 본문을 대신하지 않습니다. ";
const makeCards=()=>Array.from({length:9},(_,i)=>({...reviewCard,id:`qa-postit-${i}`,folderId:"folder-amber",
  title:i===0||i===3?"아주 긴 한국어 제목으로 두 줄 제한과 작은 액션이 있어도 본문 및 푸터 영역이 유지되는지 확인합니다":`제품 카드 ${i+1}`,
  status:(["review","running","blocked","queued","done","todo","cancelled","running","queued"] as const)[i],
  positionKey:String(i),queuePositionKey:String(i),assigneeKind:i===2?null:reviewCard.assigneeKind,
  latestActivity:i===1?null:{kind:i%2===0?"report" as const:"instruction" as const,format:i===2?"html" as const:"markdown" as const,
    body:i===2?'<p>첫 문단 &amp; 원문</p><p>둘째<br>줄</p><img src="https://resource.example.test/preview.png"><iframe src="https://resource.example.test/frame"></iframe><script>window.evil=1</script>':original.repeat(i===0?8:1),createdAt:reviewCard.createdAt},
}));

async function prepare(page:Page,width:number,theme:"dark"|"light") {
  const cards=makeCards();const detailReads:string[]=[],external:string[]=[];
  const mutations:Array<{id:string;suffix:string;body:Record<string,unknown>}>=[];
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
  await page.addInitScript(theme=>{
    localStorage.setItem("soul-dashboard-theme",theme);localStorage.setItem("ls.webglGlass","0");
    Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});
  },theme);
  await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
  page.on("request",request=>{if(request.url().includes("resource.example.test"))external.push(request.url());});
  await page.route("https://resource.example.test/**",route=>route.abort());
  await page.route("**/api/cards/**",async route=>{
    const match=new URL(route.request().url()).pathname.match(/^\/api\/cards\/([^/]+)(.*)$/);
    const card=cards.find(card=>card.id===match?.[1]);if(!card)return route.fulfill({status:404,body:"{}"});
    const method=route.request().method(),suffix=match?.[2];
    if(method==="GET"&&suffix==="")detailReads.push(card.id);
    else if(method==="POST"&&(suffix==="/status"||suffix==="/queue-position")) {
      const payload=route.request().postDataJSON();
      if(payload.expectedVersion!==card.version)return route.fulfill({status:409,body:'{"error":"version mismatch"}'});
      mutations.push({id:card.id,suffix,body:payload});
      if(suffix==="/status") {
        if(card.status!=="review"||payload.status!=="done")return route.fulfill({status:422,body:'{"error":"invalid transition"}'});
        card.status="done";card.version++;
      } else {
      const after=payload.afterCardId;
      card.queuePositionKey=after?"99":"-1";card.version++;
      }
    }
    else return route.fulfill({status:405,body:'{"error":"unhandled fixture operation"}'});
    await route.fulfill({contentType:"application/json",body:JSON.stringify({card,reports:[],comments:[],questions:[],sessions:[]})});
  });
  return {cards,detailReads,external,mutations};
}

async function capture(page:Page,name:string) {
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${phase}-${name}.png`),animations:"disabled"});
}
async function geometry(page:Page) {
  return page.locator(".v3-postit-card").evaluateAll(nodes=>nodes.map(node=>{
    const card=node as HTMLElement,r=card.getBoundingClientRect(),s=getComputedStyle(card);
    const open=card.querySelector<HTMLElement>(".v3-postit-open")!,body=card.querySelector<HTMLElement>(".v3-postit-body")!,footer=card.querySelector<HTMLElement>(".v3-postit-footer")!;
    return {id:card.dataset.cardId,width:card.offsetWidth,height:card.offsetHeight,box:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},transform:s.transform,
      bodyHeight:getComputedStyle(body).lineHeight,bodyFont:getComputedStyle(body).fontSize,
      footerTrack:footer.offsetTop,bodyTrack:body.offsetTop,padding:getComputedStyle(open).padding,
      action:card.querySelector<HTMLElement>(".dashboard-icon-cap")?.offsetWidth??null};
  }));
}

for(const width of [390,1440,1920]) test(`main and folder at ${width}`,async({page})=>{
  const state=await prepare(page,width,"dark");await page.goto("/");
  await expect(page.locator(phase==="before"?".v3-card-row":".v3-postit-card").first()).toBeVisible();
  if(!finishOnly&&!folderOnly)await capture(page,`main-${width}`);
  if(phase!=="before"&&!folderOnly) {
    if(!finishOnly) {
    expect(state.detailReads).toHaveLength(0);
    const metrics=await geometry(page);expect(metrics.length).toBe(6);
    metrics.forEach(card=>{expect(card.width).toBe(320);expect(card.height).toBe(280);expect(card.bodyFont).toBe("17px");expect(card.bodyHeight).toBe("25px");expect(card.footerTrack).toBe(226);if(card.action)expect(card.action).toBe(32);});
    expect(state.external).toEqual([]);
    const rotations=metrics.map(card=>card.transform);
    await page.reload();await expect(page.locator(".v3-postit-card").first()).toBeVisible();
    expect((await geometry(page)).map(card=>card.transform)).toEqual(rotations);
    }
    const card=page.locator('.v3-postit-card[data-card-id="qa-postit-0"]');
    await card.locator(".v3-postit-open").focus();await page.keyboard.press("Enter");
    await expect(page.getByTestId("card-detail")).toBeVisible();await page.getByRole("button",{name:"카드 닫기",exact:true}).click();
    await card.getByRole("button",{name:"완료",exact:true}).click();
    await expect(card).toHaveCount(0);
    expect(state.mutations[0]).toMatchObject({id:"qa-postit-0",suffix:"/status",body:{status:"done",expectedVersion:1}});
    expect(state.cards[0].status).toBe("done");
    await expect(page.getByTestId("card-detail")).toHaveCount(0);
    if(verifyDrag) {
    const handle=page.locator('.v3-postit-card[data-card-id="qa-postit-3"] button[aria-label$="순서 변경"]');
    await handle.scrollIntoViewIfNeeded();await handle.focus();
    const other=page.locator('.v3-postit-card[data-card-id="qa-postit-8"]');
    const firstBox=await page.locator('.v3-postit-card[data-card-id="qa-postit-3"]').boundingBox(),otherBox=await other.boundingBox();
    await page.keyboard.press("Space");
    await expect(page.locator("[role=status]")).toContainText("qa-postit-3");
    await page.keyboard.press(Math.abs(otherBox!.y-firstBox!.y)<20?"ArrowRight":"ArrowDown");
    await expect(page.locator("[role=status]")).toContainText("droppable area qa-postit-8");
    await page.keyboard.press("Space");
    await expect.poll(()=>state.mutations.filter(m=>m.suffix==="/queue-position").length).toBe(1);
    expect(state.mutations.find(m=>m.suffix==="/queue-position")).toMatchObject({id:"qa-postit-3",body:{afterCardId:"qa-postit-8",expectedVersion:1}});
    await expect(page.getByTestId("card-detail")).toHaveCount(0);
    }
  }
  if(width<760){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
  else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
  const folder=page.getByTestId("folder-card-section");await expect(folder).toBeVisible();await folder.scrollIntoViewIfNeeded();
  if(folderOnly)expect(state.mutations).toHaveLength(0);
  await capture(page,`folder-${width}`);
  if(phase!=="before") {
    const metrics=await geometry(page);metrics.forEach(card=>{expect(card.width).toBe(320);expect(card.height).toBe(280);expect(card.footerTrack).toBe(226);});
    writeFileSync(path.join(output,`metrics-${width}.json`),JSON.stringify(metrics,null,2));
  }
});

test("components samples and light paper readability",async({page})=>{
  test.skip(phase==="before"||finishOnly||folderOnly);
  const state=await prepare(page,1440,"light");await page.goto("/components");
  const samples=page.locator('[data-component="PostItCardView / PostItGrid"]');await samples.scrollIntoViewIfNeeded();
  await expect(samples.locator(".v3-postit-card")).toHaveCount(7);await capture(page,"components-light-1440");
  await samples.getByRole("button",{name:"완료",exact:true}).click();
  await expect(page.locator("p[role=status]")).toContainText("포스트잇 완료");
  expect(state.detailReads).toEqual([]);
});

for(const width of [390,1920]) test(`keyboard drag diagnosis at ${width}`,async({page})=>{
  test.skip(process.env.POSTIT_DRAG_DIAG!=="1");
  const state=await prepare(page,width,"dark");
  const trace:Array<Record<string,unknown>>=[];
  await page.addInitScript(()=>{
    const events:Array<Record<string,unknown>>=[];
    (window as unknown as {postitEvents:typeof events}).postitEvents=events;
    document.addEventListener("keydown",event=>events.push({type:"key",key:event.code,time:performance.now()}),true);
    document.addEventListener("scroll",event=>{const node=event.target as HTMLElement;events.push({type:"scroll",top:node.scrollTop,left:node.scrollLeft,time:performance.now()});},true);
    new MutationObserver(()=>{
      const status=[...document.querySelectorAll('[role="status"]')].map(node=>node.textContent).filter(Boolean);
      if(status.length)events.push({type:"announcement",status,time:performance.now()});
    }).observe(document,{subtree:true,childList:true,characterData:true});
  });
  const snapshot=async(step:string)=>{
    trace.push({step,...await page.evaluate(()=>{
      const nodes=["qa-postit-3","qa-postit-8"].map(id=>document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!);
      return {rects:nodes.map(node=>({id:node.dataset.cardId,...node.getBoundingClientRect().toJSON()})),
        ancestors:nodes.map(node=>{const result=[];for(let p=node.parentElement;p;p=p.parentElement)if(p.scrollHeight>p.clientHeight)result.push({className:p.className,top:p.scrollTop,height:p.clientHeight});return result;}),
        status:[...document.querySelectorAll('[role="status"]')].map(node=>node.textContent)};
    })});
  };
  try {
    await page.goto("/");
    const first=page.locator('[data-card-id="qa-postit-3"]'),second=page.locator('[data-card-id="qa-postit-8"]');
    await expect(second).toBeVisible();
    await first.evaluate(node=>{
      for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight&&/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
        parent.scrollTo({top:parent.scrollTop+node.getBoundingClientRect().top-parent.getBoundingClientRect().top-8,behavior:"instant"});break;
      }
    });
    await expect.poll(()=>first.evaluate(node=>{
      const other=document.querySelector('[data-card-id="qa-postit-8"]')!;
      for(let p=node.parentElement;p;p=p.parentElement)if(p.scrollHeight>p.clientHeight&&/(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
        const viewport=p.getBoundingClientRect(),a=node.getBoundingClientRect(),b=other.getBoundingClientRect();return Math.min(a.top,b.top)>=viewport.top&&Math.max(a.bottom,b.bottom)<=viewport.bottom;
      }
      return false;
    })).toBe(true);
    await snapshot("visible-before-start");
    const handle=first.getByRole("button",{name:/순서 변경$/});await handle.focus();await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed","true");
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await snapshot("active-measured");
    const a=await first.boundingBox(),b=await second.boundingBox();
    const key=Math.abs(a!.y-b!.y)<20?(b!.x>a!.x?"ArrowRight":"ArrowLeft"):(b!.y>a!.y?"ArrowDown":"ArrowUp");
    trace.push({step:"selected-key",key});await page.keyboard.press(key);
    await expect(page.locator('[role="status"]').filter({hasText:"droppable area qa-postit-8"})).toHaveCount(1);
    // Observe settled scroll coordinates across animation frames, rather than sleeping before drop.
    await page.evaluate(()=>new Promise<void>(resolve=>{
      let previous="",stable=0;
      const frame=()=>{const current=[...document.querySelectorAll("*")].filter(n=>n.scrollHeight>n.clientHeight).map(n=>[n.scrollTop,n.scrollLeft]).toString();stable=current===previous?stable+1:0;previous=current;if(stable>=3)resolve();else requestAnimationFrame(frame);};requestAnimationFrame(frame);
    }));
    await snapshot("over-target-scroll-settled");await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed","false");
    await expect.poll(()=>state.mutations.length).toBe(1);
    expect(state.mutations[0]).toMatchObject({id:"qa-postit-3",suffix:"/queue-position",body:{afterCardId:"qa-postit-8",expectedVersion:1}});
    await expect.poll(()=>page.locator('[data-card-group="queued"] .v3-postit-card').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.cardId))).toEqual(["qa-postit-8","qa-postit-3"]);
    await snapshot("end-ui-reordered");
  } finally {
    writeFileSync(path.join(output,`drag-diagnosis-${width}.json`),JSON.stringify({trace,mutations:state.mutations,
      browserEvents:await page.evaluate(()=>(window as unknown as {postitEvents:unknown}).postitEvents)},null,2));
  }
});
