import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { reviewCard } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4323";
const output = path.resolve("../.local/artifacts/20261012-internal-link-web-reader-v2");
const sessionId = "run-alpha-2";
const messageMarkdown = [
  "[문서 링크](/api/markdown-documents/doc-1)",
  "[문서 쿼리 링크](/?document=doc-1)",
  "[긴 문서](/api/markdown-documents/long-doc)",
  "[분류 없는 문서](/api/markdown-documents/orphan-doc)",
  "[없는 문서](/api/markdown-documents/missing-doc)",
  "[이미지 링크](/api/attachments/files?nodeId=eiaserinnys&path=%2Fcapture.png)",
  "[세션 링크](/?session=run-alpha-2&event=1)",
  "[카드 링크](/?card=link-card)",
  "[폴더 링크](/?folder=rb-alpha)",
  "[페이지 링크](/?page=project-amber)",
  "[미연결 페이지](/?page=missing-page)",
].join("\n\n");
const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_model: null,
  show_generation_separator: true,
  show_character: false,
  animate_character: false,
  show_jev_candidates: true,
  turn_usage_mode: "collapsed" as const,
  show_turn_usage: true,
};
const persistentSession = {
  session_id: sessionId,
  display_name: "내부 링크 검수",
  node_id: "eiaserinnys",
  folder_id: "rb-alpha",
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};
const card = {
  ...reviewCard,
  id: "link-card",
  folderId: "rb-alpha",
  title: "내부 링크 카드 상세",
  request: "채팅에서 연결된 카드입니다.",
  assigneeKind: null,
  assigneeSessionId: null,
  assigneeAgentId: null,
  nodeId: null,
};
const cardDetail = { card, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] };
const png = await readFile(path.resolve("public/icon-192.png"));

async function prepare(page: Page, width: number, contentByEventId: Record<number, string> = { 1: messageMarkdown }) {
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("soulstream-pas-device:qa@example.com", JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }));
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  });
  await installV3VisualQaRoutes(page, {
    timelineEventCount: 1,
    timelineContentByEventId: contentByEventId,
    liveEventText: "내부 링크 검수 메시지",
  });
  await page.route("**/api/auth/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }),
  }));
  await page.route("**/api/auth/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ authenticated: true, user: { email: "qa@example.com", name: "QA" } }),
  }));
  await page.route((url) => new URL(url).pathname === "/api/markdown-documents/doc-1"
    || new URL(url).pathname === "/api/markdown-documents/orphan-doc"
    || new URL(url).pathname === "/api/markdown-documents/missing-doc"
    || new URL(url).pathname === "/api/markdown-documents/long-doc", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("missing-doc")) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "missing" }) });
    }
    const id = url.pathname.split("/").at(-1)!;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        title: id === "doc-1" || id === "long-doc" ? "내부 링크 문서" : "분류 없는 내부 문서",
        body: id === "long-doc" ? "# 내부 링크 문서\n\n" + Array.from({length: 80}, (_, i) => `문단 ${i+1}. 화면보다 긴 본문을 다이얼로그 안에서 읽습니다. 긴 문서의 각 문단을 끝까지 읽을 수 있어야 합니다.`).join("\n\n") + "\n\n마지막 줄 확인"
          : id === "doc-1"
          ? "# 내부 링크 문서\n\n본문 확인\n\n문서 링크를 눌러 겹쳐 보았습니다.\n\n[같은 문서](/api/markdown-documents/doc-1)\n\n[다른 문서](/api/markdown-documents/orphan-doc)\n\n[본문 이미지](/api/attachments/files?nodeId=eiaserinnys&path=%2Fcapture.png)\n\n[본문 카드](/?card=link-card)"
          : "# 본문 확인\n\n폴더 경로가 없는 문서입니다.",
        version: 1,
        folderId: id === "doc-1" ? "rb-alpha" : "missing-folder",
      }),
    });
  });
  await page.route((url) => new URL(url).pathname === "/api/attachments/files", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: png,
  }));
  await page.route("**/api/persistent-sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/persistent-sessions" && request.method() === "GET") {
      return route.fulfill({ json: { sessions: [persistentSession], total: 1, create_defaults: null } });
    }
    if (url.pathname === `/api/persistent-sessions/${sessionId}` && request.method() === "GET") {
      return route.fulfill({ json: { session: persistentSession } });
    }
    return route.fallback();
  });
  await page.route("**/api/cards/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id !== card.id) return route.fallback();
    return route.fulfill({ json: cardDetail });
  });
}

async function openV3Chat(page: Page) {
  await page.goto(`${baseUrl}/?session=${sessionId}&event=1`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
}

async function openDocumentFromChat(page: Page, name = "문서 링크") {
  await page.getByRole("link", { name, exact: true }).click();
  const dialog = page.getByTestId("internal-document-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="dialog-title"]')).toHaveText("내부 링크 문서");
  await expect(dialog.locator('.v3-folder-board-document-copy')).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  return dialog;
}

async function captureDocument(page: Page, name: string, screenshot = true) {
  await expect(page.getByTestId("internal-document-dialog")).not.toHaveAttribute("data-starting-style");
  await expect(page.getByTestId("internal-document-dialog")).not.toHaveAttribute("data-ending-style");
  await expect(page.getByTestId("internal-document-dialog")).toHaveCSS("opacity", "1");
  if (screenshot) await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
  const geometry = await page.getByTestId("internal-document-dialog").evaluate((element) => {
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    const title = element.querySelector('[data-slot="dialog-title"]')!;
    const status = element.querySelector('.v3-board-load-state p');
    const reader = element.querySelector('.v3-folder-board-document-copy');
    const titleRange = document.createRange(); titleRange.selectNodeContents(title);
    return { dialog: rect(element), panel: rect(element.querySelector('[data-slot="dialog-panel-scroll"]')!),
      header: rect(element.querySelector('[data-slot="dialog-header"]')!), title: rect(title),
      titleLines: Array.from(titleRange.getClientRects()).map(line => line.toJSON()),
      close: rect(element.querySelector('button[aria-label="문서 닫기"]')!),
      status: status ? rect(status) : null,
      statusStyle: status ? {fontSize: getComputedStyle(status).fontSize, lineHeight: getComputedStyle(status).lineHeight, color: getComputedStyle(status).color} : null,
      first: reader?.firstElementChild ? rect(reader.firstElementChild) : null,
      last: reader?.lastElementChild ? rect(reader.lastElementChild) : null,
      scroll: {top: element.querySelector('[data-slot="dialog-panel-scroll"]')!.scrollTop, height: element.querySelector('[data-slot="dialog-panel-scroll"]')!.scrollHeight},
      tokens: {height: getComputedStyle(element).height, cap: getComputedStyle(element).getPropertyValue('--container-5xl'), inset: getComputedStyle(element).getPropertyValue('--v3-space-8')},
      surface: getComputedStyle(element).backgroundColor,
      readerFont: element.querySelector('.v3-folder-board-document-copy') ? getComputedStyle(element.querySelector('.v3-folder-board-document-copy')!).fontSize : null,
      backdrop: getComputedStyle(document.querySelector('[data-slot="dialog-backdrop"]')!).backgroundColor };
  });
  await writeFile(path.join(output, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  return geometry;
}

test("document reader keeps its frame across states and captures the proposed layout", async ({page}) => {
  // One bounded capture pass covers the requested screens, states and viewport sizes.
  test.setTimeout(240_000);
  const short = "# 문서 읽기 개선 보고서\n\n채팅에 인용한 문서를 현재 화면에서 읽도록 정리했습니다. 닫으면 보고 있던 대화로 돌아갑니다.\n\n짧은 보고도 불러오는 중과 같은 틀을 유지해 내용이 도착할 때 화면이 움직이지 않습니다.\n\n- 문서 읽기 전용 보기\n- 화면 안에서 본문 스크롤\n- 닫은 뒤 대화로 복귀";
  const normal = short + "\n\n## 확인 결과\n\n대시보드와 영구 세션 화면에서 같은 문서 보기와 상태 표시를 사용합니다. 넓은 화면에서는 읽기에 적당한 폭을 유지하고 높이를 확보했습니다.\n\n본문은 제목 아래에서 시작합니다. 문서가 길어지면 다이얼로그 안에서 끝까지 내려 읽을 수 있습니다.\n\n| 화면 | 확인 항목 | 결과 |\n| --- | --- | --- |\n| 대시보드 | 문서 읽기 | 확인 |\n| 영구 세션 | 대화 복귀 | 확인 |\n| 좁은 화면 | 본문 스크롤 | 확인 |\n\n```ts\nconst documentId = 'report-314';\nopenDocument(documentId);\n```";
  const long = normal + "\n\n" + Array.from({length:40}, (_, i) => `### 확인 기록 ${i+1}\n\n실제 채팅의 문서 링크를 눌러 본문을 읽었습니다. 긴 내용을 끝까지 내려도 닫기 버튼은 머리에 남고 뒤의 대화는 그대로 유지됩니다. 같은 문서 보기의 폭과 높이를 각 화면에서 비교했습니다.`).join("\n\n") + "\n\n마지막 줄 확인";
  const names = ['short', 'normal', 'long', 'title', 'loading', 'missing', 'failure'] as const;
  const links = names.map(name => `[시안 ${name}](/api/markdown-documents/proposal-${name})`).join('\n\n');
  await prepare(page,1440,{1:messageMarkdown+'\n\n'+links});
  let release: (() => void) | undefined;
  await page.route('**/api/markdown-documents/proposal-*', async route => {
    const name = route.request().url().split('proposal-').at(-1)!;
    if (name === 'loading') await new Promise<void>(resolve => {release=resolve;});
    if (name === 'missing' || name === 'failure') return route.fulfill({status:name==='missing'?404:500,json:{error:'fixture'}});
    const title = name === 'title' ? (page.viewportSize()!.width<500 ? '문서읽기화면의긴제목과상태배치를확인하는최종검수보고서' : '채팅 내부 문서 읽기 화면의 크기와 상태 배치, 제목 줄바꿈을 확인한 최종 검수 보고서와 영구 세션 및 대시보드의 긴 문서 스크롤 결과') : '문서 읽기 개선 보고서';
    await route.fulfill({json:{id:'proposal-'+name,title,body:name==='long'?long:name==='short'?short:name==='title'?normal.replace(/^# 문서 읽기 개선 보고서\n\n/, ''):normal,version:1}});
  });
  const dialog = page.getByTestId('internal-document-dialog');
  const measurements: Awaited<ReturnType<typeof captureDocument>>[] = [];
  const scenarios = [
    {screen:'pas',width:1920,height:1080,theme:'dark',states:names,captures:['short','normal','long','loading','missing','title']},
    {screen:'v3',width:1920,height:1080,theme:'dark',states:names,captures:['normal']},
    {screen:'pas',width:1440,height:900,theme:'dark',states:names,captures:['normal','loading','missing']},
    {screen:'v3',width:1440,height:900,theme:'dark',states:names,captures:[]},
    {screen:'pas',width:1440,height:900,theme:'light',states:['normal'],captures:['normal']},
    {screen:'pas',width:390,height:844,theme:'dark',states:names,captures:['long','title','loading']},
    {screen:'v3',width:390,height:844,theme:'dark',states:names,captures:[]},
    {screen:'pas',width:720,height:1000,theme:'dark',states:['title'],captures:[]},
    {screen:'pas',width:2560,height:1440,theme:'dark',states:['normal'],captures:[]},
  ];
  for (const scenario of scenarios) {
    await page.setViewportSize({width:scenario.screen==='v3'&&scenario.width<500?1440:scenario.width,height:scenario.height});
    await page.emulateMedia({colorScheme:scenario.theme as 'dark'|'light'});
    await page.addInitScript(theme=>localStorage.setItem('soul-dashboard-theme',theme),scenario.theme);
    if (scenario.screen==='v3') { await openV3Chat(page); if(scenario.width<500) { await page.setViewportSize({width:scenario.width,height:scenario.height}); await page.getByTestId('v3-mobile-tab-chat').click(); } }
    else await page.goto(`${baseUrl}/persistent/${sessionId}`,{waitUntil:'domcontentloaded'});
    let frame: unknown;
    for (const state of scenario.states) {
      await page.getByRole('link',{name:'시안 '+state,exact:true}).click();
      await expect(dialog.locator(state==='loading'||state==='missing'||state==='failure'?'.v3-board-load-state':'.v3-folder-board-document-copy')).toBeVisible();
      const name = `${scenario.screen}-${scenario.width}-${scenario.theme}-${state}`;
      const geometry = await captureDocument(page,name,scenario.captures.includes(state));
      measurements.push(geometry);
      if(state!=='title') { if(frame) expect(geometry.dialog).toEqual(frame); else frame=geometry.dialog; }
      const expectedHeight = scenario.width<640?scenario.height-32:Math.min(1024,scenario.height-64);
      expect({width:geometry.dialog.width,height:geometry.dialog.height}).toEqual({width:Math.min(768,scenario.width-32),height:expectedHeight});
      if(geometry.status) {
        expect(Math.abs(geometry.status.x+geometry.status.width/2-geometry.panel.x-geometry.panel.width/2)).toBeLessThanOrEqual(2);
        expect(Math.abs(geometry.status.y+geometry.status.height/2-geometry.panel.y-geometry.panel.height/2)).toBeLessThanOrEqual(2);
        expect(geometry.statusStyle!.fontSize).toBe('14px'); expect(geometry.statusStyle!.lineHeight).toBe('22px');
      }
      if(state==='title') for(const line of geometry.titleLines) expect(geometry.close.x-line.right).toBeGreaterThanOrEqual(8);
      if(state==='short') expect(geometry.first!.y-geometry.panel.y).toBe(20);
      if(state==='long') {
        const panel=dialog.locator('[data-slot="dialog-panel-scroll"]'); await panel.hover(); await page.mouse.wheel(0,30000);
        await expect(dialog.getByText('마지막 줄 확인',{exact:true})).toBeInViewport();
        const end=await captureDocument(page,name+'-end',scenario.width===390&&scenario.screen==='pas');
        expect(end.panel.bottom-end.last!.bottom).toBe(40);
      }
      release?.(); release=undefined;
      await dialog.getByRole('button',{name:'문서 닫기',exact:true}).click(); await expect(dialog).toBeHidden();
    }
  }
  const states=measurements.filter(item=>item.statusStyle);
  for(const geometry of states) expect(geometry.statusStyle).toEqual(states[0].statusStyle);
});

for (const screen of ["v3", "pas"] as const) for (const width of [1440, 1024]) {
  test(`document reader preserves ${screen} chat and focus at ${width}`, async ({ page }) => {
    await prepare(page, width);
    if (screen === "v3") await openV3Chat(page);
    else await page.goto(`${baseUrl}/persistent/${sessionId}`, { waitUntil: "domcontentloaded" });
    const chat = screen === "v3" ? page.locator('.v3-chat-pane:visible') : page.locator('[data-slot="chat-root"]');
    await expect(chat).toContainText("문서 링크");
    const chatElement = await chat.elementHandle();
    const scroller = chat.locator('[data-virtuoso-scroller="true"]');
    const position = await scroller.evaluate(element => element.scrollTop);
    const address = page.url();
    const link = page.getByRole("link", { name: "문서 링크", exact: true });
    await link.focus();
    await link.press("Enter");
    const dialog = page.getByTestId("internal-document-dialog");
    await expect(dialog.locator('[data-slot="dialog-title"]')).toHaveText("내부 링크 문서");
    await expect(dialog).toContainText("본문 확인");
    await expect(dialog.locator('h1')).toHaveCount(0);
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await captureDocument(page, `${screen}-${width}-document`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(link).toBeFocused();
    expect(page.url()).toBe(address);
    expect(await chatElement!.evaluate(element => element.isConnected)).toBe(true);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(position);
    await page.getByRole("link", { name: "이미지 링크", exact: true }).click();
    const image = page.getByRole("dialog", { name: "이미지", exact: true });
    await expect(image).toBeVisible();
    await expect(image).not.toHaveAttribute("data-starting-style");
    await page.screenshot({ path: path.join(output, `${screen}-${width}-image-reference.png`), animations: "disabled" });
  });
}

for (const screen of ["pas", "v3"] as const) {
  test(`document reader scrolls long ${screen} content at 390`, async ({ page }) => {
    await prepare(page, 1440);
    if (screen === "v3") await openV3Chat(page);
    else { await page.goto(`${baseUrl}/persistent/${sessionId}`, { waitUntil: "domcontentloaded" }); await expect(page.locator('[data-slot="chat-root"]')).toContainText("긴 문서"); }
    await page.setViewportSize({width:390,height:844});
    if (screen === "v3") await page.getByTestId("v3-mobile-tab-chat").click();
    const dialog = await openDocumentFromChat(page, "긴 문서");
    await captureDocument(page, `${screen}-390-long-top`);
    const panel = dialog.locator('[data-slot="dialog-panel-scroll"]');
    await panel.hover(); await page.mouse.wheel(0, 20000);
    await expect(dialog.getByText("마지막 줄 확인", {exact:true})).toBeInViewport();
    const rect = await dialog.boundingBox(); expect(rect!.y + rect!.height).toBeLessThanOrEqual(844);
    await captureDocument(page, `${screen}-390-long-end`);
    const last = dialog.getByText("마지막 줄 확인", {exact:true});
    await expect.poll(() => last.evaluate(element => {
      const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    })).toBe(true);
  });
}

test("document reader opens loading and missing-document states immediately", async ({page}) => {
  await prepare(page,1440); await openV3Chat(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/markdown-documents/doc-1', async route => { await gate; await route.fulfill({json:{id:'doc-1',title:'내부 링크 문서',body:'본문 확인',version:1}}); });
  await page.getByRole('link',{name:'문서 링크',exact:true}).click();
  const dialog=page.getByTestId('internal-document-dialog');
  await expect(dialog).toContainText('본문을 불러오는 중…');
  await captureDocument(page,'loading'); release();
  await expect(dialog).toContainText('본문 확인'); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await page.getByRole('link',{name:'없는 문서',exact:true}).click();
  await expect(dialog).toContainText('문서를 찾을 수 없습니다');
  await expect(page.locator('.v3-toast.is-visible')).toHaveCount(0);
  await captureDocument(page,'missing-document');
});

test("document reader switches documents, layers images and closes before cards", async ({page}) => {
  await prepare(page,1440); await openV3Chat(page);
  let reads=0; page.on('request', request => { if(new URL(request.url()).pathname==='/api/markdown-documents/doc-1') reads++; });
  const dialog=await openDocumentFromChat(page);
  await dialog.getByRole('link',{name:'같은 문서',exact:true}).click(); expect(reads).toBe(1);
  await dialog.getByRole('link',{name:'본문 이미지',exact:true}).click();
  const image=page.getByRole('dialog',{name:'이미지',exact:true}); await expect(image).toBeVisible();
  await page.keyboard.press('Escape'); await expect(image).toBeHidden(); await expect(dialog).toBeVisible();
  await dialog.getByRole('link',{name:'다른 문서',exact:true}).click();
  await expect(dialog).toContainText('분류 없는 내부 문서');
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await openDocumentFromChat(page);
  await dialog.getByRole('link',{name:'본문 카드',exact:true}).click();
  await expect(dialog).toBeHidden(); await expect(page.getByTestId('card-detail')).toContainText('내부 링크 카드 상세');
});

test("document reader is read-only, consumes direct intent and registers the actual sample", async ({page}) => {
  await prepare(page,1440);
  const writes:string[]=[]; page.on('request', request => {if(request.url().includes('/api/markdown-documents/') && request.method()!=='GET') writes.push(request.method());});
  await page.goto(`${baseUrl}/?document=doc-1`,{waitUntil:'domcontentloaded'});
  const dialog=page.getByTestId('internal-document-dialog'); await expect(dialog).toContainText('본문 확인');
  await expect.poll(()=>`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe('/');
  const line=dialog.getByText('문서 링크를 눌러 겹쳐 보았습니다.',{exact:true}); const rect=await line.boundingBox();
  await page.mouse.move(rect!.x+2,rect!.y+rect!.height/2); await page.mouse.down(); await page.mouse.move(rect!.x+rect!.width-2,rect!.y+rect!.height/2,{steps:10}); await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString().length??0)).toBeGreaterThan(0);
  await page.keyboard.type('q'); await expect(dialog.locator('input,textarea,[contenteditable="true"]')).toHaveCount(0); expect(writes).toEqual([]);
  await page.goto(`${baseUrl}/dialogues?sample=document-reader`,{waitUntil:'domcontentloaded'});
  await expect(dialog.locator('[data-slot="dialog-title"]')).toHaveText('링크 문서 읽기'); await expect(dialog.locator('h1')).toHaveCount(0);
  await captureDocument(page,'dialogues-document-reader');
});

test("opens an image attachment in the existing image viewer and closes it with Escape", async ({ page }) => {
  await prepare(page, 1440);
  await openV3Chat(page);
  await page.getByRole("link", { name: "이미지 링크", exact: true }).click();
  const image = page.locator(".v3-card-image-expanded img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "이미지", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: path.join(output, "image-attachment-viewer.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(image).toHaveCount(0);
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("이미지 링크");
});

test("opens V3 card, folder, page and session targets through actual chat links", async ({ page }) => {
  await prepare(page, 1440);
  await openV3Chat(page);

  await page.getByRole("link", { name: "카드 링크", exact: true }).click();
  const cardWorkspace = page.getByTestId("v3-card-workspace");
  await expect(cardWorkspace.getByTestId("card-detail")).toContainText("내부 링크 카드 상세");
  await cardWorkspace.getByRole("button", { name: "카드 닫기" }).click();
  await expect(cardWorkspace).toHaveCount(0);
  await expect(page.locator(".v3-chat-pane:visible")).toHaveCount(0);
  await expect(page.getByTestId("v3-session-panel")).toBeVisible();
  await openV3Chat(page);

  await page.getByRole("link", { name: "폴더 링크", exact: true }).click();
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "폴더 제목 편집", exact: true })).toHaveText("카드 밀도와 계층 최종 QA");
  await openV3Chat(page);
  await page.getByRole("link", { name: "페이지 링크", exact: true }).click();
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "폴더 제목 편집", exact: true })).toHaveText("소울스트림");
  await openV3Chat(page);
  await page.getByRole("link", { name: "세션 링크", exact: true }).click();
  // 이벤트 강조는 기존 session-search-intent.e2e.ts가 맡으며 그 시나리오는 이 변경 전부터 실패한다.
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await openV3Chat(page);
  await page.getByRole("link", { name: "미연결 페이지", exact: true }).click();
  await expect(page.locator(".v3-toast.is-visible")).toContainText("페이지와 연결된 폴더를 찾을 수 없습니다.");
});

test("consumes direct card, folder and page intents before automatic PAS startup", async ({ page }) => {
  await prepare(page, 1440);
  await page.goto(`${baseUrl}/?card=link-card`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-card-workspace").getByTestId("card-detail")).toContainText("내부 링크 카드 상세");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await page.getByRole("button", { name: "카드 닫기" }).click();
  await page.goto(`${baseUrl}/?folder=rb-alpha`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await page.goto(`${baseUrl}/?page=project-amber`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "폴더 제목 편집", exact: true })).toHaveText("소울스트림");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
});

test("opens PAS card details and follows a PAS session link to its V3 chat", async ({ page }) => {
  await prepare(page, 1440);
  await page.goto(`${baseUrl}/persistent/${sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("persistent-session-screen").locator('[data-slot="chat-root"]')).toContainText("세션 링크");
  await page.getByRole("link", { name: "카드 링크", exact: true }).click();
  const pasCard = page.getByTestId("v3-card-workspace");
  await expect(pasCard.getByTestId("card-detail")).toContainText("내부 링크 카드 상세");
  await page.screenshot({ path: path.join(output, "pas-card-detail.png"), animations: "disabled" });
  await pasCard.getByRole("button", { name: "카드 닫기" }).click();
  await page.getByRole("link", { name: "세션 링크", exact: true }).click();
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
});

test("preserves Ctrl-click browser behavior", async ({page}) => {
  await prepare(page,1440); await openV3Chat(page);
  await page.evaluate(()=>window.addEventListener('click', event=>{document.documentElement.dataset.modifiedClick=JSON.stringify({ctrlKey:event.ctrlKey,defaultPrevented:event.defaultPrevented});},{once:true}));
  await page.getByRole('link',{name:'문서 링크',exact:true}).click({modifiers:['Control']});
  await expect(page.locator('html')).toHaveAttribute('data-modified-click',JSON.stringify({ctrlKey:true,defaultPrevented:false}));
  await expect(page.getByTestId('internal-document-dialog')).toHaveCount(0);
});
