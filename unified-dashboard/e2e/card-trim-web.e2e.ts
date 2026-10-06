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
  return route.fulfill({json:{sessions:ids.map(id=>({agentSessionId:id,nodeId:'eiaserinnys',agentId:'roselin',displayName:id.startsWith("trim-session-")?`검수 세션 ${Number(id.split('-').at(-1))+1}`:"담당 세션",status:'completed',eventCount:1,prompt:'검수 대화',createdAt:new Date(Date.parse('2026-10-01T00:00:00Z')+(id.startsWith('trim-session-')?Number(id.split('-').at(-1)):0)*60000).toISOString(),updatedAt:'2026-10-05T08:00:00Z'})),total:ids.length}});
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
 await expect(detail).toBeVisible();await workspace.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
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
 await expect.poll(()=>page.getByRole('dialog').evaluate(el=>Number(getComputedStyle(el).opacity))).toBe(1);
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
 await expect(detail.locator('[data-session-id]').first()).toHaveAttribute('data-session-id','trim-session-074');
 await page.screenshot({path:path.join(output,'r7-sessions-first.png')});
 for(let i=0;i<5&&!batches.some(batch=>batch.length===25);i++){await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(400);}
 expect(batches.map(ids=>ids.length)).toEqual([50,25]);expect(batches[0][0]).toBe('trim-session-074');expect(batches[1].at(-1)).toBe('components-session');
 for(let i=0;i<3;i++){await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(250);}
 const end=await scroll.evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,viewport:el.clientHeight}));
 expect(Math.abs(end.height-end.viewport-end.top)).toBeLessThanOrEqual(1);
 const last=detail.locator('[data-session-id]').last();await expect(last).toHaveAttribute('data-session-id','components-session');await expect(last).toBeVisible();const id=await last.getAttribute('data-session-id');await last.click();
 await expect(page.getByTestId('v3-card-session-chat')).toContainText(/담당 세션|세션 행 기본/);
 const before=await scroll.evaluate(el=>el.scrollTop);await detail.getByRole('tab',{name:/노트/}).click();await detail.getByRole('tab',{name:/세션/}).click();
 expect(await scroll.evaluate(el=>el.scrollTop)).toBeCloseTo(before,0);
 await page.screenshot({path:path.join(output,'r7-sessions-end.png')});
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

for(const width of [1440,1920,2560])test(`trim expanded caption evidence ${width}`,async({page})=>{
 const {board,errors,writes}=await prepare(page,width);
 await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
 const detail=page.getByTestId('card-detail'),image=detail.locator('.v3-card-evidence-image').first();
 await image.click();const dialog=page.getByRole('dialog');
 await expect(dialog.locator('figcaption')).toHaveText(await image.getAttribute('alt')??'');
 await expect.poll(()=>dialog.evaluate(el=>Number(getComputedStyle(el).opacity))).toBe(1);
 await page.screenshot({path:path.join(output,`${width}-image-caption.png`)});
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(detail).toBeVisible();
 expect(errors).toEqual([]);expect(writes).toEqual([]);
});

test('review r7 session alignment and concise headings',async({page})=>{
 const {board,errors,writes}=await prepare(page,1440);
 await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
 const detail=page.getByTestId('card-detail');await detail.getByRole('tab',{name:/세션/}).click();
 const list=detail.getByRole('region',{name:'카드 세션 목록'});
 await expect(list.locator('[data-session-id]')).toHaveCount(1);
 const metrics=await list.evaluate(el=>{
  const scroller=el.querySelector<HTMLElement>('[data-virtuoso-scroller]')!,row=el.querySelector('.v3-run-row')!,frame=el.getBoundingClientRect(),box=row.getBoundingClientRect();
  return {left:frame.left,right:frame.right,rowLeft:box.left,rowRight:box.right,clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth};
 });
 expect(Math.abs(metrics.left-metrics.rowLeft)).toBeLessThanOrEqual(1);expect(Math.abs(metrics.right-metrics.rowRight)).toBeLessThanOrEqual(1);expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
 await expect(detail.locator('h3').filter({hasText:/세션.*회/})).toHaveCount(0);
 await page.screenshot({path:path.join(output,'r7-session-one.png')});
 await detail.getByRole('tab',{name:/노트/}).click();await expect(detail.locator('h3').filter({hasText:/^노트$/})).toHaveCount(1);await expect(detail.locator('h3').filter({hasText:/노트.*건/})).toHaveCount(0);
 await page.screenshot({path:path.join(output,'r7-note-heading.png')});
 await detail.getByRole('button',{name:'카드 닫기'}).click();await board.getByRole('button',{name:'캡처 없는 보고',exact:true}).click();await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
 await detail.locator('[data-item-id="1"] .v3-card-check-item-title-button').click();
 await expect(detail.locator('[data-item-id="1"] .v3-card-check-item-no-image')).toHaveCount(0);await expect(detail.locator('[data-item-id="2"] .v3-card-check-item-no-image')).toHaveCount(0);await expect(detail.locator('[data-item-id="3"] .v3-card-check-item-no-image')).toBeVisible();
 await page.screenshot({path:path.join(output,'r7-capture-absence.png')});
 writeFileSync(path.join(output,'r7-session-alignment.json'),JSON.stringify({metrics,errors,writes},null,2));expect(errors).toEqual([]);expect(writes).toEqual([]);
});

test('review r7 captions have resolved body typography and padding',async({page})=>{
 const {board,errors,writes}=await prepare(page,1440);
 const measures=[];
 for(const scenario of ['일곱 상태','긴 이미지 설명']){
  await board.getByRole('button',{name:scenario,exact:true}).click();await board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();
  const detail=page.getByTestId('card-detail'),image=detail.locator('.v3-card-evidence-image').first();await image.click();const dialog=page.getByRole('dialog');
  await expect.poll(()=>dialog.evaluate(el=>Number(getComputedStyle(el).opacity))).toBe(1);
  if(scenario==='긴 이미지 설명')await page.setViewportSize({width:430,height:1080});
  const measure=await dialog.evaluate(el=>{
   const caption=el.querySelector('figcaption')!,image=el.querySelector('figure img')!,box=caption.getBoundingClientRect(),img=image.getBoundingClientRect(),popup=el.getBoundingClientRect(),style=getComputedStyle(caption),range=document.createRange();range.selectNodeContents(caption);
   return {text:caption.textContent,font:style.font,lineHeight:parseFloat(style.lineHeight),paddingLeft:parseFloat(style.paddingLeft),paddingBottom:parseFloat(style.paddingBottom),gap:box.top-img.bottom,left:box.left-popup.left,right:popup.right-box.right,bottom:popup.bottom-box.bottom,height:box.height,lines:[...range.getClientRects()].map(r=>({top:r.top,bottom:r.bottom,left:r.left,right:r.right})),captionBottom:box.bottom,captionLeft:box.left,captionRight:box.right};
  });
  expect(measure.font).toContain('14px / 22px');expect(measure.gap).toBeGreaterThan(0);expect(measure.paddingLeft).toBe(12);expect(measure.paddingBottom).toBe(12);expect(measure.bottom).toBeGreaterThanOrEqual(0);
  if(scenario==='긴 이미지 설명'){expect(measure.text!.length).toBe(40);expect(measure.lines).toHaveLength(2);expect(measure.lines[1].bottom).toBeLessThanOrEqual(measure.captionBottom-measure.paddingBottom+1);}
  measures.push(measure);await page.screenshot({path:path.join(output,scenario==='일곱 상태'?'r7-caption-short.png':'r7-caption-40.png')});await page.keyboard.press('Escape');await expect(detail).toBeVisible();await detail.getByRole('button',{name:'카드 닫기'}).click();
 }
 writeFileSync(path.join(output,'r7-caption-metrics.json'),JSON.stringify({measures,errors,writes},null,2));expect(errors).toEqual([]);expect(writes).toEqual([]);
});

test('review r7 independent resize preferences focus and pointer cleanup',async({page})=>{
 const {board,errors,writes}=await prepare(page,1440);
 const open=()=>board.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();await open();
 const detail=page.getByTestId('card-detail'),workspace=page.getByTestId('v3-card-workspace'),left=page.getByTestId('v3-card-workspace-left-divider'),middle=page.getByTestId('v3-card-workspace-divider');
 const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('soulstream-v3-card-workspace-layout')??'null'));
 await workspace.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
 const initial=await geometry(page);await drag(page,'v3-card-workspace-left-divider',-400);expect((await geometry(page)).total).toBe(initial.total);expect(await stored()).toBeNull();
 await page.setViewportSize({width:2560,height:1080});await expect.poll(async()=>(await geometry(page)).card).toBe(750);expect((await geometry(page)).chat).toBe(900);
 const defaultWide=await geometry(page),area=(await workspace.boundingBox())!;await page.mouse.click((area.x+defaultWide.left)/2,area.y+100);await expect(detail).toHaveCount(0);await page.screenshot({path:path.join(output,'r7-free-area-closed.png')});await open();
 await drag(page,'v3-card-workspace-divider',100);const selected=await geometry(page),preference=await stored();expect(preference.totalWidth).toBeNull();
 await drag(page,'v3-card-workspace-left-divider',4000);const minimum=await geometry(page);expect(minimum.card).toBeCloseTo(minimum.chat,0);expect((await stored()).ratio).toBe(preference.ratio);await page.screenshot({path:path.join(output,'r7-resize-minimum.png')});
 await drag(page,'v3-card-workspace-left-divider',-(selected.total-minimum.total));const restored=await geometry(page);expect(Math.abs(restored.ratio-selected.ratio)).toBeLessThan(.002);await page.screenshot({path:path.join(output,'r7-resize-restored.png')});
 const aria=[];for(const [separator,name] of [[left,'left'],[middle,'middle']] as const){
  await separator.focus();await page.keyboard.press('ArrowLeft');const value=Number(await separator.getAttribute('aria-valuenow')),min=Number(await separator.getAttribute('aria-valuemin')),max=Number(await separator.getAttribute('aria-valuemax'));expect(value).toBeGreaterThanOrEqual(min);expect(value).toBeLessThanOrEqual(max);await expect(separator).toHaveAttribute('aria-orientation','vertical');
  const focus=await separator.evaluate(el=>({shadow:getComputedStyle(el).boxShadow,outline:getComputedStyle(el).outlineStyle}));expect(focus.shadow).toContain('0px 0px 0px 2px');expect(focus.outline).toBe('none');aria.push({name,value,min,max,focus});await page.screenshot({path:path.join(output,`r7-${name}-focus.png`)});
 }
 const original=await page.evaluate(()=>({cursor:document.body.style.cursor,select:document.body.style.userSelect}));
 const handle=left.locator('.cursor-col-resize');await handle.evaluate(el=>Promise.all(el.closest('.v3-workspace')!.getAnimations().map(a=>a.finished)));let box=(await handle.boundingBox())!;
 // A real child browsing context exercises pointer capture across the iframe boundary.
 await page.getByTestId('v3-card-session-chat').evaluate(el=>{const frame=document.createElement('iframe');frame.src='about:blank';frame.style.width='100%';frame.style.height='100%';frame.style.position='absolute';frame.style.inset='0';frame.dataset.testid='release-frame';el.append(frame);});
 const frameBox=(await page.getByTestId('release-frame').boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.mouse.move(frameBox.x+frameBox.width/2,frameBox.y+80,{steps:5});await page.mouse.up();expect(await page.evaluate(()=>({cursor:document.body.style.cursor,select:document.body.style.userSelect}))).toEqual(original);
 await page.getByTestId('release-frame').evaluate(el=>el.remove());box=(await handle.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.keyboard.press('Escape');await expect(detail).toHaveCount(0);expect(await page.evaluate(()=>({cursor:document.body.style.cursor,select:document.body.style.userSelect}))).toEqual(original);await page.mouse.up();
 writeFileSync(path.join(output,'r7-resize-metrics.json'),JSON.stringify({initial,defaultWide,selected,minimum,restored,aria,original,errors,writes},null,2));expect(errors).toEqual([]);expect(writes).toEqual([]);
});
