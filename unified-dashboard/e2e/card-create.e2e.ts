import {test,expect,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {reviewCard} from "../client/v3/components-review-fixtures";
const output=path.resolve('../../../.local/artifacts/20261002-card-create-web');
const phase=process.env.CARD_CREATE_PHASE??'after';
async function fixture(page:Page){
 let fail=false;const creates:any[]=[],uploads:string[]=[];
 await page.addInitScript(()=>{localStorage.setItem('ls.webglGlass','0');Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:[],successionPickerRuns:true});
 await page.route('**/api/attachments/sessions?*',async route=>{
  const nodeId=new URL(route.request().url()).searchParams.get('nodeId')!;uploads.push(nodeId);
  await new Promise(done=>setTimeout(done,300));
  return route.fulfill({status:201,json:{path:`/incoming/upload/${uploads.length}.png`,filename:'첨부.png',size:100,content_type:'image/png'}});
 });
 await page.route('**/api/cards',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{cards:[]}});
  const body=route.request().postDataJSON();creates.push(body);
  return fail?route.fulfill({status:409,json:{message:'fixture create conflict'}}):route.fulfill({status:201,json:{card:{...reviewCard,...body,id:'created',status:'todo'}}});
 });
 await page.goto('/');await expect(page.getByTestId('card-home')).toBeVisible();
 return {creates,uploads,setFail:(v:boolean)=>fail=v};
}
async function imageLoaded(page:Page,alt:string){
 await expect.poll(()=>page.locator(`img[alt="${alt}"]`).first().evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
}
const capture=async(page:Page,name:string)=>{mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${phase}-${name}.png`),animations:'disabled'});};
for(const width of [1280,390])test(`new card ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===1280?720:1000});await page.emulateMedia({reducedMotion:'reduce'});const state=await fixture(page);
 await page.getByTestId('card-home').getByRole('button',{name:'새 카드',exact:true}).click();const dialog=page.getByRole('dialog').first();await expect(dialog).toBeVisible();await capture(page,`create-${width}`);
 if(phase==='before')return;
 await expect(dialog.getByRole('heading',{name:'새 카드',exact:true})).toBeVisible();
 await dialog.getByRole('textbox',{name:'카드 제목'}).fill('첨부와 실행 대상을 보존하는 카드');
 await dialog.getByRole('button',{name:'폴더 선택',exact:true}).click();await page.locator('.v3-card-folder-picker').getByRole('tab',{name:'전체',exact:true}).click();await page.locator('.v3-card-folder-picker').getByRole('button',{name:'소울스트림',exact:true}).click();
 await expect(dialog.getByRole('combobox',{name:'노드 선택'})).not.toHaveValue('');
 await dialog.getByRole('combobox',{name:'노드 선택'}).click();await capture(page,`node-open-${width}`);await page.keyboard.press('Escape');
 await dialog.getByRole('combobox',{name:'에이전트 선택'}).click();await expect(page.getByRole('listbox')).toBeVisible();await capture(page,`agent-open-${width}`);await page.keyboard.press('Escape');
 await dialog.getByRole('combobox',{name:'모델 선택'}).click();await expect(page.getByRole('listbox')).toBeVisible();await capture(page,`model-open-${width}`);await page.keyboard.press('Escape');
 const fileInput=dialog.locator('input[type="file"]');
 await fileInput.setInputFiles({name:'첨부.png',mimeType:'image/png',buffer:readFileSync('public/icon-192.png')});
 await expect(dialog.getByRole('button',{name:'카드 저장'})).toBeDisabled();await expect(dialog.getByRole('button',{name:'카드 저장'})).toBeEnabled();
 await imageLoaded(page,'첨부.png');await capture(page,`attachment-${width}`);await dialog.locator('img[alt="첨부.png"]').click();await expect(page.getByRole('dialog',{name:'첨부.png',exact:true})).toBeVisible();await expect.poll(()=>page.getByRole('dialog',{name:'첨부.png',exact:true}).locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);await capture(page,`attachment-zoom-${width}`);await page.keyboard.press('Escape');
 await dialog.getByRole('button',{name:'Remove file'}).click();await expect(dialog.locator('img[alt="첨부.png"]')).toHaveCount(0);
 const encoded=readFileSync('public/icon-192.png').toString('base64');
 await dialog.getByRole('textbox',{name:'요청 원문'}).evaluate((element,encoded)=>{const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'붙여넣기.png',{type:'image/png'}));element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},encoded);
 await expect(dialog.getByRole('button',{name:'카드 저장'})).toBeEnabled();await imageLoaded(page,'붙여넣기.png');
 await dialog.getByRole('combobox',{name:'노드 선택'}).selectOption('qa-node');await expect(dialog.getByRole('button',{name:'카드 저장'})).toBeDisabled();await expect(dialog.getByRole('button',{name:'카드 저장'})).toBeEnabled();
 expect(state.uploads.at(-1)).toBe('qa-node');await capture(page,`node-switch-${width}`);
 const metrics=await dialog.evaluate(el=>{const r=el.getBoundingClientRect(),header=el.querySelector('[data-slot="dialog-header"]')!.getBoundingClientRect(),footer=el.querySelector('[data-slot="dialog-footer"]')!.getBoundingClientRect(),title=el.querySelector('[aria-label="카드 제목"]')!.getBoundingClientRect(),request=el.querySelector('[aria-label="요청 원문"]')!.getBoundingClientRect(),body=el.querySelector('[data-slot="dialog-panel-scroll"]')!,fields=[...el.querySelectorAll('.v3-succession-assignment > div')].map(field=>{const box=field.getBoundingClientRect();return {left:box.x,top:box.y,right:box.right};});return {popup:{x:r.x,y:r.y,width:r.width,height:r.height},headerInset:header.x-r.x,footerInset:footer.x-r.x,inputInset:title.x-r.x,inputRightInset:r.right-title.right,inputRequestAlignment:Math.abs(title.x-request.x),fields,tokens:getComputedStyle(el).getPropertyValue('--v3-space-3'),bodyScroll:body.scrollHeight>body.clientHeight};});
 expect(metrics.popup.x).toBeGreaterThanOrEqual(0);expect(metrics.popup.x+metrics.popup.width).toBeLessThanOrEqual(width);expect(metrics.tokens.trim()).toBe('12px');
 expect(metrics.inputRequestAlignment).toBeLessThanOrEqual(1);expect(Math.abs(metrics.inputInset-metrics.inputRightInset)).toBeLessThanOrEqual(1);
 if(width>760)expect(Math.max(...metrics.fields.map(f=>f.top))-Math.min(...metrics.fields.map(f=>f.top))).toBeLessThanOrEqual(1);
 writeFileSync(path.join(output,`metrics-${width}.json`),JSON.stringify(metrics,null,2));
 await dialog.getByRole('textbox',{name:'요청 원문'}).fill('원문을 그대로 보존합니다.\n'.repeat(45));expect(await dialog.getByRole('textbox',{name:'요청 원문'}).evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);await capture(page,`long-request-${width}`);
 state.setFail(true);await dialog.getByRole('button',{name:'카드 저장'}).click();await expect(dialog.getByRole('alert')).toContainText('fixture create conflict');await expect(dialog.getByRole('textbox',{name:'카드 제목'})).toHaveValue('첨부와 실행 대상을 보존하는 카드');await capture(page,`save-failed-${width}`);
 state.setFail(false);await dialog.getByRole('button',{name:'카드 저장'}).click();await expect(dialog).toHaveCount(0);
 expect(state.creates.at(-1)).toMatchObject({queue:false,nodeId:'qa-node',assignee:{kind:'agent',agentId:'qa-agent'},attachments:[{nodeId:'qa-node',name:'붙여넣기.png',mimeType:'image/png'}]});
 writeFileSync(path.join(output,`create-contract-${width}.json`),JSON.stringify(state.creates,null,2));
});

test('all and folder board/list share the production form',async({page})=>{
 test.skip(phase==='before');await fixture(page);
 const home=page.getByTestId('card-home');await home.getByRole('button',{name:'일반 보기',exact:true}).click();
 await home.getByRole('button',{name:'카드 추가',exact:true}).click();await expect(page.getByRole('dialog',{name:'새 카드'})).toBeVisible();await capture(page,'all-list');await page.getByRole('button',{name:'취소',exact:true}).click();
 await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
 const section=page.getByTestId('folder-card-section');await expect(section).toBeVisible();
 for(const mode of ['board','list']){
  if(mode==='list')await section.getByRole('button',{name:'일반 보기',exact:true}).click();
  await section.getByRole('button',{name:mode==='board'?'새 카드':'카드 추가',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'새 카드'});await expect(dialog.getByRole('button',{name:'폴더 선택'})).toHaveText('소울스트림');await expect(dialog.getByRole('combobox',{name:'모델 선택'})).toBeVisible();await expect(dialog.locator('input[type="file"]')).toHaveCount(1);await capture(page,`folder-${mode}`);await dialog.getByRole('button',{name:'취소',exact:true}).click();
 }
});

test('component review opens the actual form with live assignment choices',async({page})=>{
 test.skip(phase==='before');await fixture(page);await page.goto('/components');
 await page.getByRole('button',{name:'새 카드 작성 검수',exact:true}).click();const dialog=page.getByRole('dialog',{name:'새 카드'});
 await expect(dialog.getByRole('combobox',{name:'노드 선택'})).not.toHaveValue('');await expect(dialog.getByRole('combobox',{name:'모델 선택'})).toBeEnabled();
 await dialog.locator('input[type="file"]').setInputFiles({name:'검수.png',mimeType:'image/png',buffer:readFileSync('public/icon-192.png')});await imageLoaded(page,'검수.png');await capture(page,'review-form');
});

test('existing new session frame comparison',async({page})=>{
 await fixture(page);await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
 await page.getByRole('button',{name:'새 세션',exact:true}).click();const dialog=page.getByRole('dialog',{name:'새 세션',exact:true});await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('button',{name:'파일 첨부',exact:true})).toBeVisible();await expect(dialog.getByRole('combobox',{name:'모델 선택'})).toBeEnabled();await capture(page,'session-frame');
 const dimensions=await dialog.evaluate(el=>({width:el.getBoundingClientRect().width,headerHeight:el.querySelector('[data-slot="dialog-header"]')!.getBoundingClientRect().height,footerHeight:el.querySelector('[data-slot="dialog-footer"]')!.getBoundingClientRect().height,attachmentButton:(el.querySelector('input[type="file"]')!.previousElementSibling as HTMLElement).getBoundingClientRect().height}));
 writeFileSync(path.join(output,`${phase}-session-metrics.json`),JSON.stringify(dimensions,null,2));
});
