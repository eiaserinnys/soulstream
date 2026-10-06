import {expect,test,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
const output=path.resolve("../../../.local/artifacts/card-checkitems-261005/trim-web");
const base=process.env.CARD_CHECK_ITEMS_BASE_URL;
if(!base)throw new Error("CARD_CHECK_ITEMS_BASE_URL is required");
mkdirSync(output,{recursive:true});
async function prepare(page:Page,width:number) {
 const errors:string[]=[],writes:string[]=[],batches:string[][]=[];
 page.on("pageerror",error=>errors.push(error.message));
 page.on("request",request=>{const u=new URL(request.url());if(u.pathname.startsWith('/api/')&&!['GET','HEAD'].includes(request.method())&&!u.pathname.includes('ui-events'))writes.push(u.pathname);});
 await page.setViewportSize({width,height:1080});
 await page.emulateMedia({colorScheme:"dark",reducedMotion:"no-preference"});
 await page.addInitScript(()=>{localStorage.setItem("soul-dashboard-theme","dark");localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,timelineEventCount:1});
 await page.route('**/api/auth/config',route=>route.fulfill({json:{authEnabled:true,devModeEnabled:false}}));
 await page.route('**/api/auth/status',route=>route.fulfill({json:{authenticated:true,user:{email:'qa@example.test',name:'QA',isAdmin:true}}}));
 await page.route('**/api/sessions?**',route=>{
  const ids=new URL(route.request().url()).searchParams.getAll('session_id');
  if(!ids.some(id=>id.startsWith('trim-session-')))return route.fallback();
  batches.push(ids);
  return route.fulfill({json:{sessions:ids.map(id=>({agentSessionId:id,nodeId:'eiaserinnys',agentId:'roselin',displayName:id.startsWith("trim-session-")?`검수 세션 ${Number(id.split('-').at(-1))+1}`:"담당 세션",status:'completed',eventCount:1,prompt:'검수 대화',createdAt:'2026-10-05T08:00:00Z',updatedAt:'2026-10-05T08:00:00Z'})),total:ids.length}});
 });
 await page.goto(new URL('/components',base).href);
 await expect(page.getByTestId('components-review')).toBeVisible();
 await page.locator('.v3-shell.v3-components-page').evaluate(el=>(el as HTMLElement).style.setProperty('--v3-navigation-width','336px'));
 await page.evaluate(()=>document.fonts.ready);
 return {board:page.getByTestId('card-board-sample'),errors,writes,batches};
}
async function drag(page:Page,id:string,delta:number) {
 const handle=page.getByTestId(id).locator('.cursor-col-resize');
 await handle.evaluate(el=>Promise.all(el.closest('.v3-workspace')!.getAnimations().map(a=>a.finished)));
 const box=(await handle.boundingBox())!;
 await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.mouse.move(box.x+box.width/2+delta,box.y+80,{steps:5});await page.mouse.up();
}
async function geometry(page:Page) {
 return page.getByTestId('v3-card-workspace').evaluate(el=>{
  const card=el.querySelector('[data-testid="card-detail"]')!.getBoundingClientRect(),chat=el.querySelector('[data-testid="v3-card-session-chat"]')!.getBoundingClientRect();
  return {work:el.getBoundingClientRect().width,card:card.width,chat:chat.width,total:chat.right-card.left,left:card.left,right:chat.right,ratio:card.width/(card.width+chat.width)};
 });
}
for(const width of [1440,1920,2560])test(`trim web ${width}`,async({page})=>{
 const {board,errors,writes}=await prepare(page,width);
 await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
 const detail=page.getByTestId('card-detail'),workspace=page.getByTestId('v3-card-workspace');
 await expect(detail).toBeVisible();await page.waitForTimeout(300);
 const frame=await detail.boundingBox();expect(frame!.y+frame!.height).toBeLessThanOrEqual(1064);
 const initial=await geometry(page),expectedTotal=Math.min(initial.work,1666),expectedCard=Math.round((expectedTotal-16)*750/1650);
 expect(initial.card).toBeCloseTo(expectedCard,0);expect(initial.chat).toBeCloseTo(expectedTotal-16-expectedCard,0);expect(initial.right).toBe(width-16);
 await page.screenshot({path:path.join(output,`${width}-initial.png`)});
 const turn=detail.getByTestId('card-now-panel').locator('.v3-card-now-turn--user');await expect(turn).toHaveAttribute('aria-label','내 차례');await expect(turn).not.toContainText('내 차례');
 await expect(detail.locator('.v3-card-check-item-state')).toHaveCount(0);
 await expect(detail.locator('[data-item-id="3"] [role="checkbox"]')).toHaveAttribute('aria-label',/됐다고 보고/);
 await drag(page,'v3-card-workspace-left-divider',120);
 const narrow=await geometry(page);expect(narrow.total).toBeLessThan(initial.total);expect(Math.abs(narrow.ratio-initial.ratio)).toBeLessThan(.002);
 await page.screenshot({path:path.join(output,`${width}-left-narrow.png`)});
 await detail.getByRole('button',{name:'카드 닫기'}).click();await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').last().click();
 expect((await geometry(page)).total).toBeCloseTo(narrow.total,0);
 if(width===2560){
  await page.reload();await expect(page.getByTestId('components-review')).toBeVisible();
  await page.locator('.v3-shell.v3-components-page').evaluate(el=>(el as HTMLElement).style.setProperty('--v3-navigation-width','336px'));
  await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
  expect((await geometry(page)).total).toBeCloseTo(narrow.total,0);
 }

 await drag(page,'v3-card-workspace-left-divider',-2000);
 const wide=await geometry(page);expect(wide.total).toBeCloseTo(initial.work,0);
 await page.screenshot({path:path.join(output,`${width}-left-wide.png`)});
 await drag(page,'v3-card-workspace-divider',-4000);expect((await geometry(page)).card).toBeCloseTo(initial.work*.25,0);
 await page.screenshot({path:path.join(output,`${width}-middle-left.png`)});
 await drag(page,'v3-card-workspace-divider',4000);expect((await geometry(page)).chat).toBeCloseTo(initial.work*.25,0);
 await page.screenshot({path:path.join(output,`${width}-middle-right.png`)});
 await page.getByTestId('v3-card-workspace-left-divider').focus();await page.keyboard.press('Home');
 expect((await geometry(page)).card).toBeCloseTo(initial.card,0);expect(await page.evaluate(()=>localStorage.getItem('soulstream-v3-card-workspace-layout'))).toBeNull();
 const panel=detail.getByTestId('card-now-panel'),current=await panel.boundingBox();
 const itemY=(await detail.getByTestId('card-check-items').boundingBox())!.y;
 await panel.getByRole('button',{name:'이전 상황'}).click();await page.waitForTimeout(1000);
 expect((await panel.boundingBox())!.height).toBeCloseTo(current!.height,0);expect((await detail.getByTestId('card-check-items').boundingBox())!.y).toBeCloseTo(itemY,0);
 await expect(panel).not.toContainText('아래 확인 항목은 지금 상태입니다');await expect(panel.getByRole('button',{name:'최신으로'})).toBeVisible();
 await page.screenshot({path:path.join(output,`${width}-past.png`)});await panel.getByRole('button',{name:'최신으로'}).click();
 await page.screenshot({path:path.join(output,`${width}-user-turn.png`)});
 const caveat=detail.locator('[data-item-id="5"] .v3-card-check-item-caveat');await caveat.scrollIntoViewIfNeeded();
 expect(await caveat.evaluate(el=>el.nextElementSibling?.className)).toBe('v3-card-check-item-evidence');
 await expect(detail.locator('[data-item-id="5"] .v3-card-check-item-foot .v3-card-check-item-meta')).toBeVisible();
 await page.screenshot({path:path.join(output,`${width}-caveat.png`)});
 const image=detail.locator('.v3-card-evidence-image').first();await image.scrollIntoViewIfNeeded();await image.hover();
 await expect(image.locator('..')).toHaveAttribute('title',await image.getAttribute('alt')??'');await expect(detail.locator('figure figcaption')).toHaveCount(0);
 await page.screenshot({path:path.join(output,`${width}-image-hover.png`)});await image.click();
 await expect(page.getByRole('dialog').locator('figcaption')).toHaveText(await image.getAttribute('alt')??'');
 await page.screenshot({path:path.join(output,`${width}-image-caption.png`)});await page.keyboard.press('Escape');await expect(detail).toBeVisible();
 await detail.getByRole('tab',{name:/노트/}).click();
 const fonts=await detail.evaluate(el=>[...el.querySelectorAll('.v3-card-note-frame p')].map(e=>getComputedStyle(e).font));expect(fonts.length).toBeGreaterThan(0);expect(new Set(fonts).size).toBe(1);expect(fonts[0]).toContain("14px / 22px");
 await expect(detail.locator('.v3-card-note-frame')).toHaveCount(6);await page.screenshot({path:path.join(output,`${width}-notes.png`)});
 writeFileSync(path.join(output,`${width}-metrics.json`),JSON.stringify({initial,narrow,wide,fonts,errors,writes},null,2));expect(errors).toEqual([]);expect(writes).toEqual([]);
});
test('trim session pagination and question-only strip',async({page})=>{
 const {board,errors,writes,batches}=await prepare(page,1920);
 await board.getByRole('button',{name:'많은 세션',exact:true}).click();await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
 const detail=page.getByTestId('card-detail');await detail.getByRole('tab',{name:/세션/}).click();
 const scroll=detail.locator('[data-testid=card-session-virtual] [data-virtuoso-scroller]');
 await expect(detail.locator('[data-session-id^="trim-session-"]').first()).toBeVisible();
 expect(await detail.locator('[data-session-id^="trim-session-"]').count()).toBeLessThan(75);
 await page.screenshot({path:path.join(output,'1920-sessions-first.png')});
 for(let i=0;i<5&&!batches.some(batch=>batch.length===25);i++){await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(400);}
 expect(batches.map(ids=>ids.length)).toEqual([50,25]);
 for(let i=0;i<3;i++){await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(250);}
 const end=await scroll.evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,viewport:el.clientHeight}));
 expect(Math.abs(end.height-end.viewport-end.top)).toBeLessThanOrEqual(1);
 const last=detail.locator('[data-session-id^="trim-session-"]').last();await expect(last).toBeVisible();const id=await last.getAttribute('data-session-id');await last.click();
 await expect(page.getByTestId('v3-card-session-chat')).toContainText(/검수 세션/);
 const before=await scroll.evaluate(el=>el.scrollTop);await detail.getByRole('tab',{name:/노트/}).click();await detail.getByRole('tab',{name:/세션/}).click();
 expect(await scroll.evaluate(el=>el.scrollTop)).toBeCloseTo(before,0);
 await page.screenshot({path:path.join(output,'1920-sessions-end.png')});
 await detail.getByRole('button',{name:'카드 닫기'}).click();await board.getByRole('button',{name:'질문만 있는 카드',exact:true}).click();
 const post=board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first();await expect(post).not.toContainText('볼 것 0');await expect(post).toContainText('질문에 답해 주세요');
 await page.screenshot({path:path.join(output,'1920-question-only.png')});
 writeFileSync(path.join(output,'sessions-metrics.json'),JSON.stringify({batches:batches.map(x=>x.length),lastSession:id,scrollTop:before,end,errors,writes},null,2));expect(errors).toEqual([]);expect(writes).toEqual([]);
});

test('trim WebGL titles caveats and reduced motion',async({page})=>{
 test.setTimeout(120000);
 const {board,errors,writes}=await prepare(page,1920);
 await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
 const detail=page.getByTestId('card-detail');
 await page.evaluate(()=>{localStorage.setItem('ls.webglGlass','1');window.dispatchEvent(new Event('ls.webglGlass:change'));});
 await expect(detail).toHaveAttribute('data-liquid-glass-webgl','true');
 writeFileSync(path.join(output,'1920-webgl-geometry.json'),JSON.stringify(await detail.evaluate(el=>{
  const sels=['.v3-workspace','.v3-card-workspace-pair','.v3-card-detail','.v3-card-panel-scroll','.v3-card-composer-slot'];
  return sels.map(selector=>{const node=document.querySelector(selector)!;const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return {selector,top:rect.top,height:rect.height,client:(node as HTMLElement).clientHeight,scroll:(node as HTMLElement).scrollHeight,position:style.position,display:style.display,overflow:style.overflow,rows:style.gridTemplateRows};});
 }),null,2));
 const frame=await detail.boundingBox();expect(frame!.y+frame!.height).toBeLessThanOrEqual(1064);
 // Contrast fixtures use keyboard activation to avoid Playwright's unrelated auto-scroll retry.
 await detail.getByRole('button',{name:/확인함 3개 펼치기/}).evaluate(el=>(el as HTMLElement).focus({preventScroll:true}));await page.keyboard.press('Enter');
 const selectors=['.v3-card-check-item-title','.v3-card-check-item-caveat span'];
 const scroll=detail.locator('.v3-card-panel-scroll');
 for(const [name,y] of [['top',0],['mid',330],['bottom',-1]] as const){
  await scroll.evaluate((el,value)=>{el.scrollTop=value<0?el.scrollHeight:value;},y);await page.waitForTimeout(250);
  const text=await detail.evaluate((el,sels)=>{
   const viewport=el.querySelector('.v3-card-panel-scroll')!.getBoundingClientRect(),dock=el.querySelector('.v3-card-composer-slot')!.getBoundingClientRect();
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d')!;
   return sels.flatMap(selector=>[...el.querySelectorAll<HTMLElement>(selector)].flatMap(node=>{
    const range=document.createRange();range.selectNodeContents(node);const style=getComputedStyle(node);ctx.clearRect(0,0,1,1);ctx.fillStyle=style.color;ctx.fillRect(0,0,1,1);
    return [...range.getClientRects()].filter(r=>r.width>0&&r.height>0&&r.top>=viewport.top&&r.bottom<Math.min(dock.top-26,window.innerHeight)).map(r=>({selector,text:node.textContent,item:node.closest('[data-item-id]')?.getAttribute('data-item-id'),display:node.closest('[data-item-display]')?.getAttribute('data-item-display'),rgba:[...ctx.getImageData(0,0,1,1).data],box:[r.left,r.top,r.right,r.bottom],font:style.font,color:style.color}));
   }));
  },selectors);
  expect(text.length).toBeGreaterThan(0);
  await page.screenshot({path:path.join(output,`1920-webgl-${name}.png`),timeout:20000});
  const hide=await page.addStyleTag({content:selectors.join(',')+' {color:transparent!important;text-shadow:none!important}'});
  await page.screenshot({path:path.join(output,`1920-webgl-${name}-background.png`),timeout:20000});await hide.evaluate(el=>el.remove());
  writeFileSync(path.join(output,`1920-webgl-${name}.json`),JSON.stringify(text,null,2));
 }
 await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
 await detail.getByRole('tab',{name:/확인 항목/}).click();
 const motion=await detail.locator('[data-item-display="doing"]').first().evaluate(el=>({row:getComputedStyle(el).animationName,before:getComputedStyle(el,'::before').animationName,shell:getComputedStyle(el.parentElement!,'::before').animationName}));
 expect(motion).toEqual({row:'none',before:'none',shell:'none'});
 writeFileSync(path.join(output,'1920-webgl-surface.json'),JSON.stringify(await detail.evaluate(el=>({webgl:el.getAttribute('data-liquid-glass-webgl'),tint:getComputedStyle(el).getPropertyValue('--glass-chrome-surface-strong'),opacity:getComputedStyle(el,'::before').opacity})),null,2));
 expect(errors).toEqual([]);expect(writes).toEqual([]);
});
