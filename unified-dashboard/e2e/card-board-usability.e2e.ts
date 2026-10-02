import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './card-board-usability.fixture';

const output=path.resolve('../../../.local/artifacts/20261002-card-board-usability');
const phase=process.env.USABILITY_PHASE??'after';
async function capture(page:Page,name:string) { mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${phase}-${name}.png`),animations:'disabled'}); }
async function pan(page:Page,board:Locator,area:'header'|'paper'|'empty'='header') {
  const rect=await board.boundingBox();
  const target=area==='paper'?board.locator('.v3-postit-open').first():area==='empty'?board.locator('[data-board-column="queued"] .v3-card-board-lane'):board.locator('[data-board-column="todo"] .v3-detail-section-head');
  const box=await target.boundingBox();
  const x=Math.min(rect!.x+rect!.width-20,box!.x+box!.width/2),y=box!.y+(area==='empty'?box!.height-40:area==='paper'?box!.height/2:Math.min(40,box!.height/2));
  const before=await board.evaluate(el=>el.scrollLeft);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-100,y+2,{steps:10});await page.mouse.up();
  const after=await board.evaluate(el=>el.scrollLeft);
  return {before,after};
}
test('mouse pan main inline and narrow fullscreen preserves tap menu vertical scroll and grip DnD',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const s=await fixture(page),board=s.board;
  await capture(page,'main-1440');const first=await pan(page,board);
  expect(first.after-first.before).toBeGreaterThan(80);expect(s.writes).toHaveLength(0);
  await expect(page.getByTestId('card-detail')).toHaveCount(0);
  await board.evaluate(el=>el.scrollLeft=0);const paper=await pan(page,board,'paper');expect(paper.after).toBeGreaterThan(80);
  await expect(page.getByTestId('card-detail')).toHaveCount(0);await board.evaluate(el=>el.scrollLeft=0);
  const empty=await pan(page,board,'empty');expect(empty.after).toBeGreaterThan(80);
  const lane=board.locator('[data-board-column="todo"] .v3-card-board-lane');const box=await lane.boundingBox();
  await page.mouse.move(box!.x+100,box!.y+100);await page.mouse.wheel(0,320);
  await expect.poll(()=>lane.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await board.evaluate(el=>el.scrollLeft=0);await lane.evaluate(el=>el.scrollTop=0);
  const card=board.locator('[data-card-id="home-0-0"]');await card.click({button:'right'});
  const menu=page.locator('[data-card-status-picker]');await expect(menu).toBeVisible();
  expect(await menu.innerText()).not.toContain('대기:');expect(await menu.innerText()).not.toContain('보고가 필요합니다');
  await capture(page,'menu-1440');await page.keyboard.press('Escape');
  const grip=card.locator('.v3-card-board-grip'),source=await grip.boundingBox(),dest=await board.locator('[data-board-column="queued"]').boundingBox();
  await page.mouse.move(source!.x+source!.width/2,source!.y+source!.height/2);await page.mouse.down();await page.mouse.move(dest!.x+dest!.width/2,dest!.y+100,{steps:14});await page.mouse.up();
  await expect(board.locator('[data-board-column="queued"] [data-card-id="home-0-0"]')).toHaveCount(1);
  expect(s.writes).toHaveLength(1);await expect(page.getByTestId('card-detail')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'보드 확대',exact:true}).click();
  const expanded=page.getByRole('dialog',{name:'전체 카드 보드'}).locator('.v3-card-board');await expanded.evaluate(el=>el.scrollLeft=0);
  const narrow=await pan(page,expanded);expect(narrow.after).toBeGreaterThan(80);await capture(page,'expanded-390');
  writeFileSync(path.join(output,'web-pointer-metrics.json'),JSON.stringify({first,paper,empty,narrow,fixtureWrites:s.writes,productionCardWrites:0},null,2));
});
test('session trailing keeps gallery right placement at operating width',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});await fixture(page);
  const panel=page.getByTestId('v3-session-panel');await expect(panel).toBeVisible();
  const row=panel.locator('.v3-run-row[data-session-id]').first();await expect(row).toBeVisible();
  await capture(page,'session-panel-1440');
  const metrics=await row.evaluate(el=>{const r=(s:string)=>{const a=el.querySelector(s)!.getBoundingClientRect();return {x:a.x,y:a.y,width:a.width,height:a.height,right:a.right,bottom:a.bottom};};return {row:el.getBoundingClientRect().width,title:r('.v3-run-title-line'),copy:r('.v3-run-copy'),trailing:r('.v3-run-trailing')};});
  writeFileSync(path.join(output,`${phase}-session-metrics.json`),JSON.stringify(metrics,null,2));
  expect(metrics.trailing.x).toBeGreaterThanOrEqual(metrics.copy.right);
  expect(metrics.trailing.y).toBeLessThan(metrics.copy.bottom);
});
test('real touch swipes browse main folder and fullscreen while taps and menus remain explicit',async({page,context})=>{
  await page.setViewportSize({width:1210,height:834});const s=await fixture(page);const cdp=await context.newCDPSession(page);
  async function swipe(board:Locator) {
    const box=await board.boundingBox(),x=box!.x+Math.min(box!.width-40,150),y=box!.y+24,before=await board.evaluate(el=>el.scrollLeft);
    const target=await page.evaluate(({x,y})=>{let e=document.elementFromPoint(x,y);const rows=[];while(e){const s=getComputedStyle(e);rows.push({tag:e.tagName,class:e.className,touch:s.touchAction,overflow:s.overflow});e=e.parentElement;}return rows;},{x,y});
    writeFileSync(path.join(output,'touch-target.json'),JSON.stringify({x,y,box,target},null,2));
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-i*15,y}]});await page.waitForTimeout(20);}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(150);
    const after=await board.evaluate(el=>el.scrollLeft);expect(after).toBeGreaterThan(before+40);return {before,after};
  }
  const main=await swipe(s.board);await capture(page,'touch-main-1210');await expect(page.getByTestId('card-detail')).toHaveCount(0);expect(s.writes).toHaveLength(0);
  await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
  const folder=page.getByTestId('folder-card-section');await folder.scrollIntoViewIfNeeded();const inline=folder.locator('.v3-card-board');
  const folderMouse=await pan(page,inline);expect(folderMouse.after).toBeGreaterThan(40);
  await inline.evaluate(el=>el.scrollLeft=0);const folderTouch=await swipe(inline);await capture(page,'folder-1210');
  await folder.getByRole('button',{name:'보드 확대',exact:true}).click();const expanded=page.getByRole('dialog',{name:'현재 폴더 카드 보드'}).locator('.v3-card-board');
  const fullscreen=await swipe(expanded);await capture(page,'folder-expanded-1210');
  expect(s.writes).toHaveLength(0);writeFileSync(path.join(output,'web-touch-metrics.json'),JSON.stringify({main,folderMouse,folderTouch,fullscreen,productionCardWrites:0},null,2));
});
test('wide board without overflow never claims pointer browsing',async({page})=>{
  await page.setViewportSize({width:2600,height:1100});await fixture(page);await page.getByRole('button',{name:'보드 확대',exact:true}).click();
  const board=page.getByRole('dialog',{name:'전체 카드 보드'}).locator('.v3-card-board');
  expect(await board.evaluate(el=>el.scrollWidth-el.clientWidth)).toBe(0);
  const result=await pan(page,board);expect(result).toEqual({before:0,after:0});await expect(board).not.toHaveClass(/is-panning/);await capture(page,'no-overflow-2600');
});

for (const [width,scope] of [[390,'main'],[1440,'main'],[1210,'folder']] as const) test(`expanded detail ${scope} ${width} owns the top layer and Escape returns to the same board`,async({page})=>{
  await page.setViewportSize({width,height:width===390?844:1000});const s=await fixture(page);
  if(scope==='folder')await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
  await page.getByRole('button',{name:'보드 확대',exact:true}).click();
  const expanded=page.getByRole('dialog',{name:scope==='folder'?'현재 폴더 카드 보드':'전체 카드 보드'}),board=expanded.locator('.v3-card-board');
  await board.evaluate(el=>el.scrollLeft=150);
  const card=board.locator('[data-card-id="home-0-0"] .v3-postit-open');
  await card.click();const detail=page.getByTestId('card-detail');await expect(detail).toBeVisible();
  // Browser focus/Playwright reveal can scroll a partly clipped card before it opens.
  const selectedOffset=await board.evaluate(el=>el.scrollLeft);
  const close=detail.getByRole('button',{name:'카드 닫기',exact:true});
  expect(await close.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  await capture(page,`detail-over-expanded-${scope}-${width}`);await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);await expect(expanded).toBeVisible();
  expect(await board.evaluate(el=>el.scrollLeft)).toBe(selectedOffset);
  expect(await card.evaluate(el=>el===document.activeElement)).toBe(true);
  await page.keyboard.press('Escape');await expect(expanded).toHaveCount(0);expect(s.writes).toHaveLength(0);
});

test('long session uses the same reviewed arrangement and props in the real panel and gallery',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const s=await fixture(page,17,true);
 const row=page.getByTestId('v3-session-panel').locator('[data-session-id="components-session"]');await expect(row).toBeVisible();
 const measure=(el:Element)=>{const box=(name:string)=>{const r=el.querySelector(name)!.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return {width:el.getBoundingClientRect().width,text:el.textContent,copy:box('.v3-run-copy'),trailing:box('.v3-run-trailing'),font:getComputedStyle(el.querySelector('.v3-run-title-line strong')!).fontSize};};
 const operating=await row.evaluate(measure);expect(operating.trailing.x).toBeGreaterThan(operating.copy.right);await capture(page,'session-long-operating-1440');
 await page.goto('/components');const sample=page.getByTestId('session-row-operating-sample');await sample.evaluate((el,w)=>{el.style.width=`${w}px`;},operating.width);
 await sample.scrollIntoViewIfNeeded();const gallery=await sample.locator('.v3-run-row').evaluate(measure);await capture(page,'session-long-gallery-same-width');
 expect(gallery.text).toBe(operating.text);expect(gallery.font).toBe(operating.font);expect(gallery.copy.width).toBe(operating.copy.width);expect(gallery.trailing.height).toBe(operating.trailing.height);
 const boardSample=page.getByTestId('card-board-sample');await boardSample.getByRole('button',{name:'보드 확대',exact:true}).click();
 const expanded=page.getByRole('dialog',{name:'현재 폴더 카드 보드'});await expanded.locator('.v3-postit-open').first().click();
 const detail=page.getByTestId('card-detail');await expect(detail).toBeVisible();await detail.getByRole('button',{name:'카드 닫기',exact:true}).click();await expect(expanded).toBeVisible();
 expect(s.writes).toHaveLength(0);expect(s.reads.filter(id=>id.startsWith('board-'))).toHaveLength(0);
 writeFileSync(path.join(output,'session-gallery-metrics.json'),JSON.stringify({operating,gallery,productionCardWrites:0},null,2));
});

test('touch paper body browses lanes without opening detail or starting card movement',async({page,context})=>{
 await page.setViewportSize({width:1210,height:834});const s=await fixture(page),body=s.board.locator('.v3-postit-open').first(),r=await body.boundingBox(),x=r!.x+r!.width/2,y=r!.y+r!.height/2;
 const cdp=await context.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-15*i,y}]});await page.waitForTimeout(20);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(120);
 const after=await s.board.evaluate(el=>el.scrollLeft);expect(after).toBeGreaterThan(40);await expect(page.getByTestId('card-detail')).toHaveCount(0);expect(s.writes).toHaveLength(0);
 writeFileSync(path.join(output,'web-paper-touch.json'),JSON.stringify({before:0,after,productionCardWrites:0}));
});
