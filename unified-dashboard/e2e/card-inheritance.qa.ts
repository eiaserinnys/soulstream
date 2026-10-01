import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {installV3VisualQaRoutes} from './v3-visual-fixtures';
const phase=process.env.CARD_INHERIT_PHASE??'after';
const output=path.resolve('../../../.local/artifacts/20261001-components-feedback/operational');
const now='2026-10-01T00:00:00Z';
for(const width of [1440,390])test(`existing components ${width} ${phase}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
 await page.clock.install({time:new Date(now)});
 await page.addInitScript(()=>{
  localStorage.setItem('soul-dashboard-theme','dark');localStorage.setItem('ls.webglGlass','0');localStorage.setItem('soul-user-preferences:qa@example.test',JSON.stringify({chatFontSize:17}));
  localStorage.setItem('cards-p1-handoff',JSON.stringify({folderId:'folder-amber',nodeId:'eiaserinnys',agentId:'roselin_codex',modelPreset:'qa-standard'}));
  Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
  Object.defineProperty(navigator.serviceWorker,'controller',{configurable:true,get:()=>null});
 });
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,timelineEventCount:1,liveEventText:'채팅 말풍선의 기준 본문입니다.'});
 const card={id:'inherit',folderId:'other',title:'기존 요소를 상속하는 긴 카드 제목을 말줄임으로 확인합니다',request:'지시 첫 줄\n둘째 줄\n셋째 줄\n넷째 줄',brief:'접힌 내부 정보',status:'running',blockedKind:null,positionKey:'a',queuePositionKey:null,assigneeKind:'session',assigneeSessionId:'run-alpha-1',nodeId:'eiaserinnys',assigneeAgentId:'roselin_codex',modelPreset:'qa-standard',version:1,archived:false,createdAt:now,updatedAt:now};
 const sessions=Array.from({length:4},(_,i)=>({sessionId:`run-alpha-${i+1}`,agentSessionId:`run-alpha-${i+1}`,callerSessionId:i?'run-alpha-1':null,folderId:'folder-amber',displayName:`세션 ${i+1}`,status:'completed',agentName:'로젤린',agentId:'roselin_codex',nodeId:'eiaserinnys',modelLabel:'Sol',eventCount:1,prompt:'세션의 기존 미리보기',createdAt:now,updatedAt:now}));
 const reports=[{id:'report',title:'최신 보고 제목',body:'보고 첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n\n![보고 캡처](https://example.test/capture.svg)',format:'markdown',createdAt:now,sessionId:'run-alpha-1'}];
 const comments:any[]=[],writes:any[]=[];let showFolderCards=false;
 const folderCards=Array.from({length:6},(_,i)=>({...card,id:i?`folder-card-${i}`:card.id,folderId:"folder-amber",positionKey:String(i)}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  const json=(v:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(v)});
  if(p==='/api/user/preferences')return json({preferences:{chatFontSize:17},hasBackground:false});
  if(p==='/api/auth/config')return json({authEnabled:true,devModeEnabled:false});
  if(p==='/api/auth/status')return json({authenticated:true,user:{email:'qa@example.test',name:'QA',isAdmin:true}});
  if(p==='/api/planner/today')return json({daily:{page:{id:'daily',title:'오늘',version:1,metadata:{},archived:false},blocks:[],state_vector:''},folders:[],memoBlocks:[],reviewSessionIds:[],attention:[],running:[card],queued:[]});
  if(p==='/api/cards')return json({cards:url.searchParams.has('folderId')?(showFolderCards?folderCards:[]):[card]});
  if(p.startsWith('/api/cards/folder-card-'))return json({card:folderCards.find(card=>card.id===p.split('/').at(-1)),sessions,reports,comments,questions:[]});
  if(p==='/api/cards/inherit')return json({card:showFolderCards?folderCards[0]:card,sessions,reports,comments,questions:[]});
  if(p==='/api/cards/inherit/comments'){const payload=req.postDataJSON();writes.push(payload);const comment={id:'comment',cardId:card.id,authorKind:'user',body:payload.body,kind:'comment',createdAt:now};comments.push(comment);return json(comment);}
  if(p==='/api/attachments/sessions'){expect(req.postData()).toContain('run-alpha-1');return json({path:'/uploads/run-alpha-1/evidence.png'});}
  if(p==='/api/attachments/files')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#4373aa"/></svg>'});
  if(p==='/api/sessions'&&url.searchParams.has('session_id'))return json({sessions:sessions.filter(s=>url.searchParams.getAll('session_id').includes(s.agentSessionId)),total:sessions.length});
  if(p==='/api/planner/folders/folder-amber/sessions')return json({items:sessions,nextCursor:null});
  if(p==='/api/planner/folders/folder-amber')return json({cards:[],folder:{id:'folder-amber',name:'소울스트림',projectPageId:'project-amber',parentFolderId:null,sortOrder:0,settings:{},status:'open',version:1,archived:false},page:{id:'project-amber',title:'소울스트림',version:1,metadata:{},archived:false},blocks:[],subfolders:{items:[],nextCursor:null},sessions:{items:sessions,nextCursor:null}});
  return route.fallback();
 });
 await page.route('https://example.test/capture.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#4373aa"/></svg>'}));
 mkdirSync(output,{recursive:true});
 const workspaceGeometry=async()=>page.locator('.v3-workspace').evaluate(el=>{
  const rect=(e:Element|null)=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right};};
  const pane=el.querySelector('.v3-detail-pane')!,head=pane.querySelector('.v3-folder-header')!;
  const style=getComputedStyle(head);
  return {headerPaddingLeft:parseFloat(style.paddingLeft),headerPaddingRight:parseFloat(style.paddingRight),pane:rect(pane),chat:rect(el.querySelector('.v3-chat-pane')),header:rect(head),firstCap:rect(head.querySelector('.dashboard-icon-cap')),lastCap:rect(head.querySelector('.v3-folder-header-actions .dashboard-icon-cap:last-child')),scroll:rect(pane.querySelector('.v3-detail-scroll'))};
 });
 const capture=async(name:string)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${phase}-${width}-${name}.png`),animations:'disabled'});};
 const measure=async(selector:string)=>page.locator(selector).first().evaluate(el=>{
  const box=(node:Element|null)=>{if(!node)return null;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,w:r.width,h:r.height,padding:s.padding,gap:s.gap,fontSize:s.fontSize,lineHeight:s.lineHeight,borderRadius:s.borderRadius,marginLeft:s.marginLeft,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom,borderTop:s.borderTopWidth,borderBottom:s.borderBottomWidth,outline:s.outlineStyle,alignItems:s.alignItems};};
  return {self:box(el),open:box(el.querySelector('.v3-run-open')),avatar:box(el.querySelector('.v3-run-avatar')),title:box(el.querySelector('.v3-run-title-line strong')),agent:box(el.querySelector('.v3-run-agent-line')),preview:box(el.querySelector('.v3-run-copy > small')),copy:box(el.querySelector('.v3-run-copy')),trailing:box(el.querySelector('.v3-run-trailing')),cap:box(el.querySelector('.dashboard-icon-cap')),titleLine:box(el.querySelector('.v3-run-title-line')),body:box(el.querySelector('[data-slot="chat-input-body"]')),send:box(el.querySelector('[data-testid="send-button"]'))};
 });
 await page.goto('/v3');await expect(page.locator('[data-card-id=inherit]')).toBeVisible();
 await capture('today');const cardRow=await measure('[data-card-id=inherit]');const handoff=await measure('.v3-card-handoff');
 await page.getByRole('button',{name:`카드 ${card.title} 열기`,exact:true}).click();
 const detail=page.getByTestId('card-detail');await expect(detail).toBeVisible();
 await expect(detail.locator('[data-card-section=sessions] .v3-run-row')).toHaveCount(3);
 await detail.locator('.v3-card-panel-scroll').evaluate(el=>{el.scrollTop=0;});
 await expect(page.getByTestId('v3-card-workspace')).toHaveAttribute('data-placement','overlay');await detail.getByPlaceholder('커멘트',{exact:true}).focus();await capture('card');const cardGeometry=await workspaceGeometry();const smallRow=await measure('[data-card-section=sessions] .v3-run-row');const commentInput=await measure('[data-testid=card-detail] [data-slot=chat-input-composer],.v3-card-comment-input');
 const smallIndent=await detail.locator('.v3-run-children').first().evaluate(el=>({marginLeft:getComputedStyle(el).marginLeft,paddingLeft:getComputedStyle(el).paddingLeft}));
 await detail.locator('[data-card-entry=보고]').scrollIntoViewIfNeeded();await capture('report');
 const cardBubble=await detail.locator('[data-card-entry=보고] [data-slot=chat-message-bubble]').evaluate(el=>{const s=getComputedStyle(el);return {padding:s.padding,radius:s.borderRadius,font:getComputedStyle(el.querySelector('[data-slot=chat-body]')!).fontSize};});
 if(phase==='after'){
  const bubble=detail.locator('[data-card-entry=보고] [data-slot=chat-message-bubble]');await expect(bubble).toHaveAttribute('aria-expanded','false');
  await expect(detail.locator('[data-card-entry] details,[data-card-entry] button.v3-card-more')).toHaveCount(0);
  await detail.getByAltText('보고 캡처').click();await expect(page.getByRole('dialog').getByAltText('보고 캡처')).toBeVisible();await capture('viewer');await page.keyboard.press('Escape');await expect(bubble).toHaveAttribute('aria-expanded','false');
  await bubble.click({position:{x:20,y:20}});await expect(bubble).toHaveAttribute('aria-expanded','true');await capture('expanded-report');
  await bubble.click({position:{x:20,y:20}});await expect(bubble).toHaveAttribute('aria-expanded','false');
  await detail.locator('input[type=file]').setInputFiles({name:'evidence.png',mimeType:'image/png',buffer:Buffer.from('fixture')});
  await expect(detail.locator('[title="evidence.png"]')).toBeVisible();
  await detail.getByPlaceholder('커멘트',{exact:true}).fill('추가 지시');await detail.getByPlaceholder('커멘트',{exact:true}).press('Enter');await expect(detail.getByPlaceholder('커멘트',{exact:true})).toHaveValue('추가 지시\n');expect(writes).toHaveLength(0);await detail.getByPlaceholder('커멘트',{exact:true}).press('Control+Enter');
  await expect.poll(()=>writes.length).toBe(1);expect(writes[0].body).toContain('![evidence.png](/api/attachments/files?nodeId=eiaserinnys&path=%2Fuploads%2Frun-alpha-1%2Fevidence.png)');
 }
 let selectedGeometry=cardGeometry;
 if(phase==='after'){
  await detail.locator('.v3-card-panel-scroll').evaluate(el=>{el.scrollTop=0;});
  await detail.locator('.v3-run-open').first().click();await expect(page.getByTestId('v3-card-session-chat').locator('[data-slot=chat-input-composer]')).toBeVisible();await capture('card-session');if(width>=760)selectedGeometry=await workspaceGeometry();

 }
 if(width<760&&phase==='after')await page.keyboard.press('Escape');
 else await page.getByRole('button',{name:'카드 닫기',exact:true}).click();
 await expect(page.getByTestId('v3-card-workspace')).toHaveCount(0);
 if(width<760){await page.getByTestId('v3-mobile-tab-projects').click();await page.getByTestId('v3-mobile-project-list').getByRole('button',{name:'소울스트림',exact:true}).click();}
 else await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
 const folder=page.locator('[data-task-section=sessions]');await expect(folder.locator('.v3-run-row')).toHaveCount(4);
 await folder.scrollIntoViewIfNeeded();await capture('folder');const folderRow=await measure('[data-task-section=sessions] .v3-run-row');
 const folderIndent=await folder.locator('.v3-run-children').first().evaluate(el=>({marginLeft:getComputedStyle(el).marginLeft,paddingLeft:getComputedStyle(el).paddingLeft}));
 await folder.locator('.v3-run-open').first().click();const chat=page.locator('.v3-chat-pane[aria-label="세션 채팅"]');await expect(chat).toBeVisible();await expect(chat.locator('[data-slot=chat-input-composer]')).toBeVisible();await capture('chat');const folderGeometry=await workspaceGeometry();
 const chatInput=await measure('.v3-chat-pane [data-slot=chat-input-composer]');
 const chatBubble=await chat.locator('[data-slot=chat-message-bubble]').filter({has:page.locator('[data-slot=chat-body]')}).first().evaluate(el=>{const s=getComputedStyle(el);return {padding:s.padding,radius:s.borderRadius,font:getComputedStyle(el.querySelector('[data-slot=chat-body]')!).fontSize};});
 writeFileSync(path.join(output,`${phase}-${width}-metrics.json`),JSON.stringify({cardRow,handoff,smallRow,commentInput,cardBubble,folderRow,folderIndent,smallIndent,chatInput,chatBubble,cardGeometry,selectedGeometry,folderGeometry,writes},null,2));
 if(phase==='after'){
  for(const key of ['padding','gap'] as const)expect(cardRow.open![key]).toBe(folderRow.open![key]);
  for(const row of [cardRow,folderRow,smallRow]){const sum=parseFloat(row.self!.borderTop)+parseFloat(row.self!.borderBottom)+parseFloat(row.open!.paddingTop)+parseFloat(row.open!.paddingBottom)+Math.max(row.avatar!.h,row.copy!.h,row.trailing!.h);expect(Math.abs(row.self!.h-sum)).toBeLessThanOrEqual(1);}
  expect(cardRow.cap!.h).toBe(32);expect(cardRow.cap!.w).toBe(32);expect(cardRow.avatar!.y).toBe(cardRow.titleLine!.y);expect(cardRow.avatar!.y+cardRow.avatar!.h).toBe(cardRow.agent!.y+cardRow.agent!.h);expect(cardRow.title!.fontSize).toBe(folderRow.title!.fontSize);
  expect(smallRow.preview).toBeNull();expect(smallRow.avatar!.y).toBeCloseTo(smallRow.titleLine!.y,0);expect(smallRow.avatar!.y+smallRow.avatar!.h).toBeCloseTo(smallRow.agent!.y+smallRow.agent!.h,0);expect(smallRow.avatar!.h).toBe(folderRow.avatar!.h);expect(smallRow.open!.padding).toBe(folderRow.open!.padding);expect(smallIndent).toEqual(folderIndent);
  for(const row of [cardRow,smallRow]){
   expect(Math.abs((row.avatar!.x-row.self!.x)-(folderRow.avatar!.x-folderRow.self!.x))).toBeLessThanOrEqual(1);
   expect(Math.abs((row.self!.x+row.self!.w-row.trailing!.x-row.trailing!.w)-(folderRow.self!.x+folderRow.self!.w-folderRow.trailing!.x-folderRow.trailing!.w))).toBeLessThanOrEqual(1);
   expect(Math.abs((row.title!.y-row.self!.y)-(folderRow.title!.y-folderRow.self!.y))).toBeLessThanOrEqual(1);
  }
  if(width>=760){for(const key of ['firstCap','lastCap'] as const)expect(Math.abs((cardGeometry[key]!.x-cardGeometry.pane!.x)-(folderGeometry[key]!.x-folderGeometry.pane!.x))).toBeLessThanOrEqual(1);}
  else {expect(cardGeometry.firstCap!.x-cardGeometry.pane!.x).toBe(folderGeometry.headerPaddingLeft);expect(cardGeometry.pane!.right-cardGeometry.lastCap!.right).toBe(folderGeometry.headerPaddingRight);}
  if(width>=760){expect(Math.abs(cardGeometry.pane!.y-cardGeometry.chat!.y)).toBeLessThanOrEqual(1);expect(selectedGeometry.pane).toEqual(cardGeometry.pane);}
  expect(cardBubble).toEqual(chatBubble);
  for(const input of [handoff,commentInput]){expect(input.body!.h).toBeCloseTo(chatInput.body!.h,0);expect(input.body!.fontSize).toBe(chatInput.body!.fontSize);expect(input.body!.padding).toBe(chatInput.body!.padding);expect(input.body!.outline).toBe('none');expect(input.send!.h).toBe(chatInput.send!.h);}
  await page.keyboard.press('Escape');showFolderCards=true;
  await page.reload();
  if(width<760){await page.getByTestId('v3-mobile-tab-projects').click();await page.getByTestId('v3-mobile-project-list').getByRole('button',{name:'소울스트림',exact:true}).click();}
  else await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
  const cards=page.getByTestId('folder-card-section');await expect(cards.locator('[data-card-id]')).toHaveCount(6);
  await cards.evaluate(el=>el.scrollIntoView({block:'start'}));await capture('folder-cards');
  const overlap=await page.evaluate(()=>{
   const cards=document.querySelector('[data-testid=folder-card-section]')!,board=document.querySelector('[data-testid=v3-inline-board]')!;
   const a=cards.getBoundingClientRect(),b=board.getBoundingClientRect();return {cardsBottom:a.bottom,boardTop:b.top};
  });expect(overlap.boardTop).toBeGreaterThanOrEqual(overlap.cardsBottom);
  const head=cards.locator('.v3-detail-section-head');
  expect(await head.locator('button:not(.dashboard-icon-cap)').count()).toBe(0);
  const alignment=await head.evaluate(el=>{const title=el.querySelector('h3')!.getBoundingClientRect(),cap=el.querySelector('.dashboard-icon-cap')!.getBoundingClientRect();return {titleCenter:title.y+title.height/2,capCenter:cap.y+cap.height/2};});expect(alignment.titleCenter).toBe(alignment.capCenter);
  writeFileSync(path.join(output,`${phase}-${width}-folder-metrics.json`),JSON.stringify({overlap,alignment},null,2));
 }
});
