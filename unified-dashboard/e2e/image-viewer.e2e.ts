import { expect, test, type Locator, type Page } from "./test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const phase = process.env.IMAGE_VIEWER_PHASE ?? "after";
// 카드 #429 보완: 단색 사각형 대신 글자와 아이콘이 있는 화면 꼴 표본(하나 500KB 안).
const tallScreenSvg = readFileSync(path.resolve("e2e/fixtures/tall-screen.svg"), "utf8");
const wideTimelineSvg = readFileSync(path.resolve("e2e/fixtures/wide-timeline.svg"), "utf8");
const output = path.resolve("../.local/card429/web", phase);
mkdirSync(output, {recursive:true});
const headroomOutput = path.resolve("../.local/card429/web/headroom");
const previewPhase = process.env.IMAGE_VIEWER_PREVIEW_PHASE ?? "after";
const cases = [[1920,1080,800,600],[1920,1080,2560,1440],[1920,1080,1200,2800],[1920,1080,64,64],[390,844,800,600]];
async function open(page: Page, viewer: string, vw:number, vh:number, w:number, h:number, caption="", options: {theme?: "light"|"dark"; gallery?:string; sample?:string} = {}) {
  await page.setViewportSize({width:vw,height:vh});
  const theme=options.theme ?? "light";
  await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
  await page.addInitScript(theme=>{
    localStorage.setItem("ls.webglGlass","0");
    localStorage.setItem("soul-dashboard-theme",theme);
  },theme);
  await page.route(/\/(fixture|next|third|last|tall|wide)\.svg/,route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/tall.svg"||url.pathname==="/wide.svg") {
      return route.fulfill({contentType:"image/svg+xml",body:url.pathname==="/tall.svg"?tallScreenSvg:wideTimelineSvg});
    }
    const width=url.pathname==="/next.svg"?64:Number(url.searchParams.get("width"));
    const height=url.pathname==="/next.svg"?64:Number(url.searchParams.get("height"));
    return route.fulfill({contentType:"image/svg+xml",body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="steelblue"/><text x="12" y="40" fill="white" font-size="24">${width} × ${height}</text></svg>`});
  });
  await page.goto(`/e2e/image-viewer.fixture.html?viewer=${viewer}&width=${w}&height=${h}&caption=${caption}&theme=${theme}&gallery=${options.gallery ?? ""}&sample=${options.sample ?? ""}`);
  if(viewer==="chat") await page.locator("img[role=button]").first().click();
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
  await page.evaluate(()=>document.fonts.ready);
  return popup;
}
async function metrics(popup: Locator) {
  return popup.evaluate(el=>{
    const rect=(node:Element)=>node.getBoundingClientRect().toJSON();
    const image=el.querySelector("img")!;
    const style=getComputedStyle(el);
    const caption=el.querySelector("figcaption");
    const figure=el.querySelector("figure");
    const header=el.querySelector('[data-slot="dialog-header"]');
    const footer=el.querySelector('[data-slot="dialog-footer"]');
    const panel=el.querySelector('[data-slot="dialog-panel"]');
    const panelStyle=panel ? getComputedStyle(panel) : null;
    const frameStyle=getComputedStyle(figure ?? el);
    const framePadding=["paddingLeft","paddingTop","paddingRight","paddingBottom"].map(key=>parseFloat(frameStyle[key as keyof CSSStyleDeclaration] as string));
    const imageRect=image.getBoundingClientRect(),popupRect=el.getBoundingClientRect();
    let textStart:number|null=null;
    if(caption?.firstChild) {
      const range=document.createRange();
      range.setStart(caption.firstChild,0);range.setEnd(caption.firstChild,1);
      textStart=range.getBoundingClientRect().left;
    }
    const occupied=(caption ? caption.getBoundingClientRect().height+parseFloat(getComputedStyle(figure!).rowGap) : 0)
      +(header?.getBoundingClientRect().height ?? 0)+(footer?.getBoundingClientRect().height ?? 0)
      +(panelStyle ? parseFloat(panelStyle.paddingTop)+parseFloat(panelStyle.paddingBottom) : 0)
      +(figure || !header ? framePadding[1]+framePadding[3] : 0);
    const reserve=document.createElement("span");
    reserve.style.height="var(--image-viewer-block-reserve)";
    reserve.style.position="absolute";
    image.parentElement!.append(reserve);
    const reserved=reserve.getBoundingClientRect().height;
    reserve.remove();
    return {
      popup:rect(el),image:rect(image),natural:[image.naturalWidth,image.naturalHeight],
      reserved,nonImage:occupied,freeSpace:el.clientHeight-image.getBoundingClientRect().height-occupied,
      inlineInset:el.clientWidth-image.getBoundingClientRect().width,
      edges:[...el.querySelectorAll("figcaption,[data-slot=dialog-header],[data-slot=dialog-footer]")].map(node=>({rect:rect(node),scroll:node.scrollHeight,client:node.clientHeight})),
      border:parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth),
      close:rect(el.querySelector('[aria-label="닫기"]')!),
      insets:[imageRect.left-popupRect.left,imageRect.top-popupRect.top,popupRect.right-imageRect.right,popupRect.bottom-imageRect.bottom],
      textStart,alignment:textStart===null?null:imageRect.left-textStart,framePadding,
      caption:caption ? rect(caption) : null,
      captionInset:caption ? caption.getBoundingClientRect().left-popupRect.left-parseFloat(style.borderLeftWidth) : null,
      captionLines:caption ? caption.getBoundingClientRect().height/parseFloat(getComputedStyle(caption).lineHeight) : 0,
      computed:{minWidth:style.minWidth,minHeight:style.minHeight,
        containerXs:style.getPropertyValue("--container-xs"),container3xs:style.getPropertyValue("--container-3xs")},
    };
  });
}
for(const viewer of ["card","file","chat"]) for(const [vw,vh,w,h] of cases) {
  test(`${viewer} ${vw}x${vh} ${w}x${h}`, async({page})=>{
    const popup=await open(page,viewer,vw,vh,w,h);
    const data=await metrics(popup);
    const name=`${viewer}-${vw}x${vh}-${w}x${h}`;
    writeFileSync(path.join(output,name+".json"),JSON.stringify(data,null,2));
    await page.screenshot({path:path.join(output,name+".png"),animations:"disabled",timeout:15000});
    expect(data.natural).toEqual([w,h]);
    expect.soft(data.popup.x).toBeGreaterThanOrEqual(15);
    expect.soft(data.popup.y).toBeGreaterThanOrEqual(15);
    expect.soft(data.popup.right).toBeLessThanOrEqual(vw-15);
    expect.soft(data.popup.bottom).toBeLessThanOrEqual(vh-15);
    expect.soft(data.image.width).toBeLessThanOrEqual(w+1);
    expect.soft(data.image.height).toBeLessThanOrEqual(h+1);
    expect.soft(Math.abs(data.image.width/data.image.height-w/h)/(w/h)).toBeLessThan(.01);
    if(w===800 && vw===1920 || w===64) {
      expect.soft(data.image.width).toBeCloseTo(w,0);
      expect.soft(data.image.height).toBeCloseTo(h,0);
    } else {
      expect.soft(data.image.width<w || data.image.height<h).toBe(true);
    }
    const padding=viewer==="chat"?48:24;
    const expectedScale=Math.min(1,(vw-32-data.border-padding)/w,(vh-2*(vw<=640?24:32)-data.border-data.reserved)/h);
    expect.soft(Math.abs(data.image.width-w*expectedScale)).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(data.image.height-h*expectedScale)).toBeLessThanOrEqual(1);
    if(viewer!=="card" || data.captionLines<=3) expect.soft(data.nonImage).toBeLessThanOrEqual(data.reserved+1);
    for(const edge of data.edges) {
      expect.soft(edge.rect.bottom).toBeLessThanOrEqual(data.popup.bottom+1);
      expect.soft(edge.scroll).toBeLessThanOrEqual(edge.client+1);
    }
    if(w===64) {
      expect.soft(data.popup.width).toBeCloseTo(viewer==="chat" ? vw-32 : 320,0);
      expect.soft((data.image.left+data.image.right)/2).toBeCloseTo((data.popup.left+data.popup.right)/2,0);
      expect.soft(data.image.right).toBeLessThan(data.close.left);
    } else {
      expect.soft(data.popup.width).toBeCloseTo(viewer==="chat" ? vw-32 : Math.max(320,data.image.width+padding+data.border),0);
    }
    if(viewer==="chat") {
      await expect(popup.locator(".chat-image-viewer-title")).toBeVisible();
      await page.getByRole("button",{name:"다음 이미지"}).click();
      await expect(popup.locator("img")).toHaveAttribute("alt","next.svg");
      await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
      await expect.poll(async()=> (await metrics(popup)).popup.width).toBe(vw-32);
    }
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
  });
}
test("long caption stays inside the card image popup",async({page})=>{
  const popup=await open(page,"card",390,844,1200,2800,"long");
  const data=await metrics(popup);
  writeFileSync(path.join(output,"card-long-caption.json"),JSON.stringify(data,null,2));
  await page.screenshot({path:path.join(output,"card-long-caption.png"),animations:"disabled",timeout:15000});
  expect(data.popup.bottom).toBeLessThanOrEqual(828);
  expect(data.edges[0].rect.bottom).toBeLessThanOrEqual(data.popup.bottom);
  expect(data.edges[0].scroll).toBe(data.edges[0].client);
});
test("ordinary popup preserves its original frame",async({page})=>{
  await page.setViewportSize({width:1920,height:1080});
  await page.addInitScript(()=>localStorage.setItem("ls.webglGlass","0"));
  await page.goto("/e2e/image-viewer.fixture.html?viewer=ordinary");
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await page.screenshot({path:path.join(output,"ordinary.png"),animations:"disabled",timeout:15000});
  expect((await popup.boundingBox())!.width).toBe(512);
});

test("supplement: three-line caption and outside dismissal",async({page})=>{
  const popup=await open(page,"card",1920,1080,1200,2800,"three");
  const data=await metrics(popup);
  const lines=await popup.locator("figcaption").evaluate(el=>{
    const style=getComputedStyle(el);
    return (el.clientHeight-parseFloat(style.paddingBottom))/parseFloat(style.lineHeight);
  });
  expect(lines).toBeGreaterThanOrEqual(2);
  expect(lines).toBeLessThanOrEqual(3);
  expect(data.nonImage).toBeLessThanOrEqual(data.reserved+1);
  expect(data.edges[0].rect.bottom).toBeLessThan(data.popup.bottom);
  writeFileSync(path.join(output,"card-three-lines.json"),JSON.stringify({...data,lines},null,2));
  await page.screenshot({path:path.join(output,"card-three-lines.png"),animations:"disabled",timeout:15000});
  await page.mouse.click(20,20);
  await expect(popup).toHaveCount(0);
});

test("supplement: geometry recorder detects a seeded sizing violation",async({page})=>{
  const popup=await open(page,"card",1920,1080,800,600);
  await popup.locator("img").evaluate(el=>el.style.transform="scale(2)");
  expect((await metrics(popup)).image.width).toBeGreaterThan(800);
  await popup.evaluate(el=>el.style.minWidth="200vw");
  expect((await metrics(popup)).popup.right).toBeGreaterThan(1920);
});

test("supplement: small file image remains painted",async({page})=>{
  const popup=await open(page,"file",1920,1080,64,64);
  await page.screenshot({path:path.join(output,"file-small-painted.png"),animations:"disabled",timeout:15000});
  const data=await popup.locator("img").evaluate((image:HTMLImageElement)=>{
    const canvas=document.createElement("canvas");
    canvas.width=64;canvas.height=64;
    const context=canvas.getContext("2d")!;
    context.drawImage(image,0,0);
    return {pixel:[...context.getImageData(2,2,1,1).data],style:getComputedStyle(image).cssText};
  });
  expect(data.pixel).toEqual([70,130,180,255]);
  writeFileSync(path.join(output,"file-small-painted.json"),JSON.stringify(data,null,2));
});

for(const sample of ["card-image","file-image","card-image-screen"]) test(`supplement: actual dialogue sample ${sample}`,async({page})=>{
  await page.setViewportSize({width:1920,height:1080});
  await page.addInitScript(()=>localStorage.setItem("ls.webglGlass","0"));
  await installV3VisualQaRoutes(page);
  await page.goto(`/dialogues?sample=${sample}`);
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible({timeout:20000});
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
  const data=await metrics(popup);
  if(sample!=="card-image-screen") {
    expect(data.image.width).toBe(data.natural[0]);
    expect(data.image.height).toBe(data.natural[1]);
    expect(data.popup.width).toBe(320);
  } else {
    expect(data.natural).toEqual([1920,1080]);
    expect(data.popup.right).toBeLessThanOrEqual(1904);
  }
  await page.screenshot({path:path.join(output,sample+"-dialogues.png"),animations:"disabled",timeout:15000});
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

async function capture(page:Page,popup:Locator,name:string,extra:Record<string,unknown>={}) {
  const data={...await metrics(popup),...extra};
  await page.screenshot({path:path.join(output,name+".png"),animations:"disabled",timeout:15000});
  writeFileSync(path.join(output,name+".json"),JSON.stringify(data,null,2));
  return data;
}

for(const viewer of ["card","file"]) for(const theme of ["light","dark"] as const)
for(const [vw,vh] of [[1920,1080],[390,844]]) for(const [w,h] of [[64,64],[192,192],[240,80],[200,120],[800,600],[2560,1440],[1200,2800],...(vw===390?[[390,900]]:[])]) {
  test(`repair inset ${viewer} ${theme} ${vw}x${vh} ${w}x${h}`,async({page})=>{
    const popup=await open(page,viewer,vw,vh,w,h,viewer==="card" && w===192?"forty-three":"",{theme});
    const data=await capture(page,popup,`inset-${viewer}-${theme}-${vw}x${vh}-${w}x${h}`);
    const reserved=viewer==="card"?102:24;
    const margin=vw<=640?24:32;
    const scale=Math.min(1,(vw-58)/w,(vh-2*margin-2-reserved)/h);
    expect(Math.abs(data.image.width-w*scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(data.image.height-h*scale)).toBeLessThanOrEqual(1);
    expect(data.popup.height).toBeGreaterThanOrEqual(256);
    expect(data.computed.minWidth).toContain("320px");
    expect(data.computed.minHeight).toContain("256px");
    expect(data.computed.containerXs.trim()).toBe("20rem");
    expect(data.computed.container3xs.trim()).toBe("16rem");
    expect(data.framePadding).toEqual([12,12,12,12]);
    for(const inset of data.insets) expect(inset).toBeGreaterThanOrEqual(12);
    expect(data.popup.left).toBeGreaterThanOrEqual(16);expect(data.popup.right).toBeLessThanOrEqual(vw-16);
    expect(data.popup.top).toBeGreaterThanOrEqual(margin);expect(data.popup.bottom).toBeLessThanOrEqual(vh-margin);
    expect(Math.abs(data.popup.top-(vh-data.popup.bottom))).toBeLessThanOrEqual(1);
    expect(Math.abs(data.image.width/data.image.height-w/h)/(w/h)).toBeLessThan(.01);
    expect(data.image.width).toBeLessThanOrEqual(w);expect(data.image.height).toBeLessThanOrEqual(h);
    if(viewer==="card") {
      expect(data.captionInset).toBeCloseTo(12,0);
      expect(data.caption!.width).toBeCloseTo(data.popup.width-26,0);
      if(data.image.width>=data.caption!.width-1) expect(Math.abs(data.alignment!)).toBeLessThanOrEqual(1);
      if(w===192) expect(data.captionLines).toBe(2);
    }
    if(w===240) expect(data.close.bottom<=data.image.top || data.close.left>=data.image.right).toBe(true);
  });
}

for(const theme of ["light","dark"] as const) for(const [vw,vh] of [[1920,1080],[390,844]])
test(`repair no caption ${theme} ${vw}`,async({page})=>{
  const popup=await open(page,"card",vw,vh,64,64,"none",{theme});
  const data=await capture(page,popup,`no-caption-${theme}-${vw}`);
  expect(data.popup.height).toBe(256);
  expect(data.image.width).toBe(64);expect(data.image.height).toBe(64);
  expect((data.image.top+data.image.bottom)/2).toBe((data.popup.top+data.popup.bottom)/2);
});

for(const [vw,vh] of [[1920,1080],[1440,900],[390,844]]) {
  test(`repair gallery pointer stays on next ${vw}x${vh}`,async({page})=>{
    const popup=await open(page,"chat",vw,vh,2560,1440,"",{gallery:"mixed"});
    const next=popup.getByRole("button",{name:"다음 이미지"});
    const prev=popup.getByRole("button",{name:"이전 이미지"});
    const nextBox=(await next.boundingBox())!,prevBox=(await prev.boundingBox())!;
    const x=nextBox.x+nextBox.width/2,y=nextBox.y+nextBox.height/2;
    await page.mouse.move(x,y);
    const steps=[];
    for(const [index,alt] of ["fixture.svg","next.svg","third.svg","last.svg"].entries()) {
      if(index) await page.mouse.down().then(()=>page.mouse.up());
      await expect(popup.locator("img")).toHaveAttribute("alt",alt);
      await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
      await expect(popup).toBeVisible();
      const actualNext=(await next.boundingBox())!,actualPrev=(await prev.boundingBox())!;
      for(const [actual,initial] of [[actualNext,nextBox],[actualPrev,prevBox]]) {
        expect(Math.abs(actual.x-initial.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(actual.y-initial.y)).toBeLessThanOrEqual(2);
      }
      const data=await capture(page,popup,`gallery-${vw}x${vh}-${index}`,{next:actualNext,prev:actualPrev});
      const margin=vw<=640?24:32;
      expect(data.popup.width).toBe(vw-32);expect(data.popup.height).toBe(vh-2*margin);
      expect(data.popup.top).toBe(margin);expect(data.popup.bottom).toBe(vh-margin);
      const frame=await popup.locator(".chat-image-frame").boundingBox();
      expect((data.image.top+data.image.bottom)/2).toBeCloseTo(frame!.y+frame!.height/2,0);
      steps.push({index,image:data.image,popup:data.popup,next:actualNext,prev:actualPrev});
    }
    await expect(popup.locator(".chat-image-viewer-count")).toHaveText("4/4");
    writeFileSync(path.join(output,`gallery-${vw}x${vh}-steps.json`),JSON.stringify(steps,null,2));
  });
}

for(const viewer of ["card","file"]) for(const theme of ["light","dark"] as const)
test(`repair close contrast ${viewer} ${theme}`,async({page})=>{
  const popup=await open(page,viewer,1920,1080,1920,1080,"",{theme,sample:theme==="light"?"dark":"bright"});
  const data=await metrics(popup);
  const name=`close-${viewer}-${theme}`;
  const screenshot=await page.screenshot({path:path.join(output,name+".png"),animations:"disabled",timeout:15000});
  const contrast=await page.evaluate(async({png,theme,box})=>{
    const bitmap=await createImageBitmap(await (await fetch("data:image/png;base64,"+png)).blob());
    const canvas=document.createElement("canvas");
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext("2d")!;
    context.drawImage(bitmap,0,0);
    const rgb=(x:number,y:number)=>[...context.getImageData(Math.round(x),Math.round(y),1,1).data].slice(0,3);
    const luminance=(rgb:number[])=>rgb.map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;})
      .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const icon=document.querySelector('[aria-label="닫기"] svg')!.getBoundingClientRect();
    const pixels:number[][]=[];
    for(let x=Math.ceil(icon.left+3);x<icon.right-3;x++) for(let y=Math.ceil(icon.top+3);y<icon.bottom-3;y++) pixels.push(rgb(x,y));
    pixels.sort((a,b)=>luminance(a)-luminance(b));
    const foreground=theme==="light"?pixels[0]:pixels[pixels.length-1];
    const background=rgb(box.x+5,box.y+box.height/2);
    const image=rgb(box.x-3,box.y+box.height/2);
    const a=luminance(foreground),b=luminance(background);
    return {foreground,background,image,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  },{png:screenshot.toString("base64"),theme,box:data.close});
  expect(contrast.ratio).toBeGreaterThanOrEqual(3);
  expect(contrast.background).not.toEqual(contrast.image);
  writeFileSync(path.join(output,name+".json"),JSON.stringify({...data,contrast},null,2));
});

test("repair actual screen capture sample",async({page})=>{
  await page.setViewportSize({width:1920,height:1080});
  await installV3VisualQaRoutes(page);
  await page.goto("/dialogues?sample=card-image-screen");
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
  const data=await capture(page,popup,"card-screen-dialogues");
  expect(data.natural).toEqual([1920,1080]);
  expect(data.image.width).toBeGreaterThan(512);
});

for(const [viewer,vw,vh,w,h,caption,gallery,sample,name] of [
  ["card",1920,1080,1920,1080,"one","","dark","card-screen-desktop"],
  ["file",1920,1080,1920,1080,"","","dark","file-screen-desktop"],
  ["chat",1920,1080,2560,1440,"","mixed","","gallery-desktop"],
  ["card",390,844,1920,1080,"one","","dark","card-screen-mobile"],
  ...(previewPhase==="after" ? [
    ["card",1920,1080,64,64,"small-long","","","card-small-long"],
    ["card",1920,1080,192,192,"forty-three","","","card-two-lines"],
    ["chat",1920,1080,64,64,"","single","","chat-small-single"],
  ] : []),
] as [string,number,number,number,number,string,string,string,string][]) {
  test(`headroom preview ${name}`,async({page})=>{
    const popup=await open(page,viewer,vw,vh,w,h,caption,{gallery,sample});
    const data=await metrics(popup);
    mkdirSync(headroomOutput,{recursive:true});
    const stem=`${previewPhase}-${name}`;
    await page.screenshot({path:path.join(headroomOutput,stem+".png"),animations:"disabled",timeout:15000});
    writeFileSync(path.join(headroomOutput,stem+".json"),JSON.stringify({viewport:[vw,vh],...data},null,2));
    if(previewPhase==="after") {
      const margin=vw<=640?24:32;
      expect(data.popup.top).toBeGreaterThanOrEqual(margin-.1);
      expect(vh-data.popup.bottom).toBeGreaterThanOrEqual(margin-.1);
      expect(Math.abs(data.popup.top-(vh-data.popup.bottom))).toBeLessThanOrEqual(1);
    }
  });
}

for(const [vw,vh] of [[1920,1080],[390,844]]) for(const caption of ["small-long","forty-three"]) {
  test(`headroom caption ${vw} ${caption}`,async({page})=>{
    const w=caption==="small-long"?64:192;
    const popup=await open(page,"card",vw,vh,w,w,caption);
    const data=await capture(page,popup,`caption-${vw}-${caption}`);
    expect(data.captionInset).toBeCloseTo(12,0);
    expect(data.caption!.width).toBeCloseTo(data.popup.width-26,0);
    expect(data.edges[0].scroll).toBe(data.edges[0].client);
    expect(data.image.width).toBe(w);expect(data.image.height).toBe(w);
    if(caption==="forty-three") expect(data.captionLines).toBe(2);
  });
}
for(const [vw,vh] of [[1920,1080],[390,844]]) for(const [w,h] of [[64,64],[240,80],[720,450]]) {
  test(`headroom single chat ${vw} ${w}x${h}`,async({page})=>{
    const popup=await open(page,"chat",vw,vh,w,h,"",{gallery:"single"});
    const data=await capture(page,popup,`single-chat-${vw}-${w}x${h}`);
    if(vw===1920) expect(data.insets[3]).toBeCloseTo(25,0);
    expect(data.popup.top).toBeGreaterThanOrEqual(vw<=640?24:32);
    expect(Math.abs(data.popup.top-(vh-data.popup.bottom))).toBeLessThanOrEqual(1);
    if(vw===1920) {expect(data.image.width).toBe(w);expect(data.image.height).toBe(h);}
  });
}

// 카드 #1289: 보기 창은 내용 종류에 맞춰 크기를 잡는다. 이미지는 원본 크기(작은 이미지는
// 늘리지 않음), 문서는 읽기 폭, 긴 문서는 화면 높이 한도에서 본문 스크롤. 질문 장의 첨부
// 링크는 새 탭이 아니라 이 보기 창으로 열린다.
const attachmentViewports = [[2560,1392],[1440,900],[360,780]] as const;
async function openAttachment(page:Page, kind:string, vw:number, vh:number, w=800, h=600, theme:"light"|"dark"="light", options:{name?:string;sample?:string}={}) {
  await page.setViewportSize({width:vw,height:vh});
  await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
  await page.addInitScript((nextTheme:string)=>{
    localStorage.setItem("ls.webglGlass","0");
    localStorage.setItem("soul-dashboard-theme",nextTheme);
  },theme);
  await page.goto(`/e2e/image-viewer.fixture.html?viewer=attachment&attachment=${kind}&width=${w}&height=${h}&theme=${theme}${options.name?`&name=${encodeURIComponent(options.name)}`:""}${options.sample?`&sample=${options.sample}`:""}`);
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await page.evaluate(()=>document.fonts.ready);
  return popup;
}
async function attachmentMetrics(popup: Locator) {
  return popup.evaluate(el=>{
    const rect=(node:Element)=>node.getBoundingClientRect().toJSON();
    const scroll=el.querySelector('[data-slot="dialog-panel-scroll"]');
    const panel=el.querySelector('[data-slot="dialog-panel"]');
    const markdown=el.querySelector(".chat-attachment-markdown");
    const table=el.querySelector("table");
    const tableBox=table?.parentElement ?? null;
    const pre=el.querySelector("pre");
    const image=el.querySelector("img") as HTMLImageElement | null;
    const footer=el.querySelector('[data-slot="dialog-footer"]');
    return {
      popup:rect(el),
      kind:el.getAttribute("data-attachment-kind"),
      image:image ? rect(image) : null,
      natural:image ? [image.naturalWidth,image.naturalHeight] : null,
      markdown:markdown ? rect(markdown) : null,
      pre:pre ? rect(pre) : null,
      textBody:(()=>{const body=markdown ?? pre; return body?rect(body):null;})(),
      navigation:!!el.querySelector(".chat-image-viewer-navigation"),
      count:el.querySelector(".chat-image-viewer-count")?.textContent ?? null,
      media:(()=>{
        const video=el.querySelector("video") as HTMLVideoElement | null;
        const frame=el.querySelector(".chat-attachment-media-frame");
        const panel=el.querySelector('[data-slot="dialog-panel"]');
        return {video:video?rect(video):null,frame:frame?rect(frame):null,panel:panel?rect(panel):null,natural:video?[video.videoWidth,video.videoHeight]:null};
      })(),
      // 이미지처럼 가운데에 서는 기준은 테두리 상자가 아니라 안쪽 여백을 뺀 내용 상자의 중심이다.
      panelContentCenter:(()=>{
        const panel=el.querySelector('[data-slot="dialog-panel"]');
        if(!panel) return null;
        const style=getComputedStyle(panel);
        const box=panel.getBoundingClientRect();
        const left=parseFloat(style.paddingLeft),right=parseFloat(style.paddingRight);
        const top=parseFloat(style.paddingTop),bottom=parseFloat(style.paddingBottom);
        return {x:box.x+left+(box.width-left-right)/2,y:box.y+top+(box.height-top-bottom)/2};
      })(),
      nextButton:(()=>{
        const button=el.querySelector('.chat-image-viewer-navigation [aria-label="다음 첨부"], .chat-image-viewer-navigation [aria-label="다음 이미지"]');
        return button?rect(button):null;
      })(),
      footer:footer ? rect(footer) : null,
      scroll:scroll ? {scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,scrollWidth:scroll.scrollWidth,clientWidth:scroll.clientWidth} : null,
      panel:panel ? {scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth} : null,
      popupScroll:{scrollWidth:el.scrollWidth,clientWidth:el.clientWidth},
      table:table && tableBox ? {rect:rect(tableBox),scrollWidth:tableBox.scrollWidth,clientWidth:tableBox.clientWidth} : null,
      tableHeaders:[...el.querySelectorAll("table th")].map(th=>{
        const range=document.createRange();
        range.selectNodeContents(th);
        return {text:(th.textContent??"").trim(),lines:range.getClientRects().length};
      }),
      active:el.contains(document.activeElement),
      pageScrollWidth:document.documentElement.scrollWidth,
    };
  });
}
async function captureAttachment(page:Page, popup:Locator, name:string, vw:number, vh:number) {
  const data={viewport:[vw,vh],...await attachmentMetrics(popup)};
  await page.screenshot({path:path.join(output,name+".png"),animations:"disabled",timeout:15000});
  writeFileSync(path.join(output,name+".json"),JSON.stringify(data,null,2));
  return data;
}
function documentCap(vw:number) { return Math.min(768, vw-32); }
function viewportMargin(vw:number) { return vw<=640 ? 24 : 32; }
async function nextButtonBox(popup:Locator) {
  const box=await popup.locator('.chat-image-viewer-navigation [aria-label="다음 첨부"], .chat-image-viewer-navigation [aria-label="다음 이미지"]').first().boundingBox();
  expect(box).not.toBeNull();
  return box!;
}
async function waitVideoMetadata(popup:Locator) {
  await popup.locator("video").evaluate((el:HTMLVideoElement)=>el.readyState>=1?null:new Promise<void>(resolve=>{
    el.addEventListener("loadedmetadata",()=>resolve(),{once:true});
  }));
}
async function openDialogueSample(page:Page,sample:string,vw:number,vh:number) {
  await page.setViewportSize({width:vw,height:vh});
  await page.emulateMedia({colorScheme:"light",reducedMotion:"reduce"});
  await page.addInitScript(()=>{
    localStorage.setItem("ls.webglGlass","0");
    Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
    Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});
  });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/auth/config",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({authEnabled:true,devModeEnabled:false})}));
  await page.route("**/api/auth/status",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}})}));
  await page.goto(`/dialogues?sample=${sample}`);
  await page.evaluate(()=>document.fonts.ready);
}

for(const [vw,vh] of attachmentViewports) {
  test(`attachment long document ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,"doc-long",vw,vh);
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    await expect(popup.locator("table")).toBeVisible();
    const data=await captureAttachment(page,popup,`attachment-doc-long-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(data.kind).toBe("document");
    if(vw>=1440) for(const header of data.tableHeaders) expect(header.lines,header.text).toBe(1);
    expect(Math.abs(data.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    expect(data.popup.right).toBeLessThanOrEqual(vw-15);
    expect(data.popup.bottom).toBeLessThanOrEqual(vh-15);
    expect(data.popup.height).toBeLessThanOrEqual(vh-2*viewportMargin(vw)+1);
    expect(data.scroll!.scrollHeight).toBeGreaterThan(data.scroll!.clientHeight);
    expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
    expect(data.panel!.scrollWidth).toBeLessThanOrEqual(data.panel!.clientWidth+1);
    expect(data.table!.scrollWidth).toBeGreaterThan(data.table!.clientWidth);
    expect(data.markdown!.width).toBeLessThanOrEqual(data.panel!.clientWidth+1);
    expect(data.pageScrollWidth).toBeLessThanOrEqual(vw);
  });
  test(`attachment short document ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,"doc-short",vw,vh);
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    const data=await captureAttachment(page,popup,`attachment-doc-short-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(data.kind).toBe("document");
    expect(Math.abs(data.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    expect(Math.abs(data.scroll!.scrollHeight-data.scroll!.clientHeight)).toBeLessThanOrEqual(1);
    expect(data.popup.height).toBeLessThan(vh-2*viewportMargin(vw)-100);
    expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
  });
  test(`attachment plain text ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,"text",vw,vh);
    await expect(popup.locator("pre")).toBeVisible();
    const data=await captureAttachment(page,popup,`attachment-text-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(data.kind).toBe("document");
    expect(Math.abs(data.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
    expect(data.pre!.width).toBeLessThanOrEqual(data.panel!.clientWidth+1);
  });
}

for(const [kind,w,h] of [["image-small",64,64],["image-large",2560,1440]] as const) for(const [vw,vh] of attachmentViewports) {
  test(`attachment ${kind} ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,kind,vw,vh,w,h);
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
    const data=await captureAttachment(page,popup,`attachment-${kind}-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(data.kind).toBe("image");
    expect(data.natural).toEqual([w,h]);
    expect(data.footer).not.toBeNull();
    expect(data.popup.right).toBeLessThanOrEqual(vw-15);
    expect(data.popup.bottom).toBeLessThanOrEqual(vh-15);
    if(kind==="image-small") {
      expect(data.image!.width).toBe(64);
      expect(data.image!.height).toBe(64);
      expect(data.popup.width).toBe(320);
      expect(data.popup.height).toBeLessThan(256+1);
    } else {
      expect(data.image!.width).toBeLessThanOrEqual(w);
      expect(data.image!.height).toBeLessThanOrEqual(h);
      expect(data.image!.width).toBeLessThan(w);
      expect(data.popup.width).toBeLessThanOrEqual(vw-32+1);
      expect(data.popup.height).toBeLessThanOrEqual(vh-2*viewportMargin(vw)+1);
    }
    expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
  });
}

for(const [vw,vh] of attachmentViewports) {
  test(`attachment document loading ${vw}x${vh}`,async({page})=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route("**/api/attachments/slow-doc/content*",async route=>{
      await gate;
      const body="가".repeat(1365)+"a";
      return route.fulfill({status:206,headers:{
        "Content-Type":"text/markdown; charset=utf-8","Content-Length":"4096","Content-Range":"bytes 0-4095/4096",
      },body});
    });
    const popup=await openAttachment(page,"slow-doc",vw,vh);
    await expect(popup.locator(".chat-attachment-state")).toContainText("미리보기를 불러오는 중…");
    const loading=await captureAttachment(page,popup,`attachment-loading-${vw}x${vh}`,vw,vh);
    if(phase==="after") {
      expect(loading.kind).toBe("document");
      expect(Math.abs(loading.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    }
    release();
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    const loaded=await captureAttachment(page,popup,`attachment-loaded-${vw}x${vh}`,vw,vh);
    if(phase==="after") {
      expect(loaded.kind).toBe("document");
      expect(Math.abs(loaded.popup.width-loading.popup.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(loaded.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    }
  });
}

for(const [vw,vh] of attachmentViewports) {
  test(`attachment html loading keeps the full frame ${vw}x${vh}`,async({page})=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route("**/api/attachments/slow-html/content*",async route=>{
      await gate;
      const html="<!doctype html><html><body><h1>Sample</h1></body></html>";
      const body=html+"<!--"+" ".repeat(4096-html.length-7)+"-->";
      return route.fulfill({status:206,headers:{
        "Content-Type":"text/html; charset=utf-8","Content-Length":"4096","Content-Range":"bytes 0-4095/4096",
      },body});
    });
    const popup=await openAttachment(page,"html-slow",vw,vh);
    await expect(popup.locator(".chat-attachment-state")).toContainText("미리보기를 불러오는 중…");
    const loading=await captureAttachment(page,popup,`attachment-html-loading-${vw}x${vh}`,vw,vh);
    release();
    await expect(popup.locator(".chat-attachment-html-frame")).toBeVisible();
    const loaded=await captureAttachment(page,popup,`attachment-html-loaded-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(loading.kind).toBe("html");
    expect(Math.abs(loading.popup.width-(vw-32))).toBeLessThanOrEqual(1);
    expect(Math.abs(loading.popup.height-(vh-2*viewportMargin(vw)))).toBeLessThanOrEqual(1);
    expect(Math.abs(loaded.popup.width-loading.popup.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(loaded.popup.height-loading.popup.height)).toBeLessThanOrEqual(1);
    expect(loaded.popupScroll.scrollWidth).toBeLessThanOrEqual(loaded.popupScroll.clientWidth+1);
  });
}

test("attachment unavailable keeps the existing error",async({page})=>{
  const popup=await openAttachment(page,"missing",1440,900);
  await expect(popup.locator(".chat-attachment-state")).toContainText("첨부를 찾을 수 없습니다.");
  const data=await captureAttachment(page,popup,"attachment-missing-1440x900",1440,900);
  if(phase==="after") {
    expect(data.kind).toBe("document");
    expect(Math.abs(data.popup.width-documentCap(1440))).toBeLessThanOrEqual(1);
  }
});

test("attachment document resizes while open",async({page})=>{
  const popup=await openAttachment(page,"doc-long",2560,1392);
  await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
  for(const [vw,vh] of [[1440,900],[360,780],[2560,1392]] as const) {
    await page.setViewportSize({width:vw,height:vh});
    if(phase==="after") await expect.poll(async()=>Math.abs((await attachmentMetrics(popup)).popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    const data=await captureAttachment(page,popup,`attachment-resize-${vw}x${vh}`,vw,vh);
    if(phase!=="after") continue;
    expect(Math.abs(data.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
    expect(data.popup.right).toBeLessThanOrEqual(vw-15);
    expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
  }
});

// 카드 #1289 검수 반려: 넘기기 창은 묶음 단위로 틀을 정하고, 문서 본문과 동영상은
// 틀 가운데에 선다. 문서만 든 묶음은 문서 창 크기로 고정한다.
for(const [vw,vh] of attachmentViewports) {
  test(`gallery document-only bundle ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,"gallery-docs",vw,vh);
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    const first=await captureAttachment(page,popup,`gallery-docs-${vw}x${vh}`,vw,vh);
    const nextFirst=await nextButtonBox(popup);
    await popup.getByRole("button",{name:"다음 첨부"}).click();
    await expect(popup.locator("pre")).toBeVisible();
    const second=await captureAttachment(page,popup,`gallery-docs-second-${vw}x${vh}`,vw,vh);
    const nextSecond=await nextButtonBox(popup);
    if(phase!=="after") return;
    for(const data of [first,second]) {
      expect(data.navigation).toBe(true);
      expect(data.kind).toBe("document");
      expect(Math.abs(data.popup.width-documentCap(vw))).toBeLessThanOrEqual(1);
      expect(Math.abs(data.popup.height-(vh-2*viewportMargin(vw)))).toBeLessThanOrEqual(1);
      expect(data.textBody!.width).toBeLessThanOrEqual(documentCap(vw)+1);
      expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
    }
    expect(Math.abs(second.popup.width-first.popup.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(second.popup.height-first.popup.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(nextSecond.x-nextFirst.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(nextSecond.y-nextFirst.y)).toBeLessThanOrEqual(2);
  });
  test(`gallery mixed bundle steps ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,"gallery-mixed",vw,vh,64,64);
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
    const image=await captureAttachment(page,popup,`gallery-mixed-image-${vw}x${vh}`,vw,vh);
    const nextImage=await nextButtonBox(popup);
    await popup.getByRole("button",{name:"다음 첨부"}).click();
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    const doc=await captureAttachment(page,popup,`gallery-mixed-document-${vw}x${vh}`,vw,vh);
    const nextDoc=await nextButtonBox(popup);
    await popup.getByRole("button",{name:"다음 첨부"}).click();
    await expect(popup.locator("video")).toBeVisible();
    await waitVideoMetadata(popup);
    const video=await captureAttachment(page,popup,`gallery-mixed-video-${vw}x${vh}`,vw,vh);
    const nextVideo=await nextButtonBox(popup);
    if(phase!=="after") return;
    for(const data of [image,doc,video]) {
      expect(data.navigation).toBe(true);
      expect(Math.abs(data.popup.width-(vw-32))).toBeLessThanOrEqual(1);
      expect(Math.abs(data.popup.height-(vh-2*viewportMargin(vw)))).toBeLessThanOrEqual(1);
      expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
    }
    expect(doc.kind).toBe("document");
    expect(doc.textBody!.width).toBeLessThanOrEqual(768+1);
    expect(Math.abs(doc.textBody!.left+doc.textBody!.width/2-(doc.media.panel!.x+doc.media.panel!.width/2))).toBeLessThanOrEqual(1);
    expect(video.media.natural).toEqual([16,16]);
    expect(Math.abs(video.media.video!.x+video.media.video!.width/2-(video.media.frame!.x+video.media.frame!.width/2))).toBeLessThanOrEqual(1);
    expect(Math.abs(video.media.video!.y+video.media.video!.height/2-(video.media.frame!.y+video.media.frame!.height/2))).toBeLessThanOrEqual(1);
    expect(image.image).not.toBeNull();
    expect(Math.abs(video.media.frame!.x+video.media.frame!.width/2-(image.image!.x+image.image!.width/2))).toBeLessThanOrEqual(1);
    expect(Math.abs(video.media.frame!.y+video.media.frame!.height/2-(image.image!.y+image.image!.height/2))).toBeLessThanOrEqual(1);
    for(const next of [nextDoc,nextVideo]) {
      expect(Math.abs(next.x-nextImage.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(next.y-nextImage.y)).toBeLessThanOrEqual(2);
    }
  });
}
for(const [vw,vh] of [[2560,1392],[1440,900]] as const) {
  test(`single narrow video stays centered ${vw}x${vh}`,async({page})=>{
    const popup=await openAttachment(page,"video-narrow",vw,vh);
    await expect(popup.locator("video")).toBeVisible();
    await waitVideoMetadata(popup);
    const data=await captureAttachment(page,popup,`attachment-video-narrow-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(data.kind).toBe("video");
    expect(data.media.natural).toEqual([16,16]);
    expect(Math.abs(data.media.video!.x+data.media.video!.width/2-(data.media.frame!.x+data.media.frame!.width/2))).toBeLessThanOrEqual(1);
    expect(Math.abs(data.media.video!.y+data.media.video!.height/2-(data.media.frame!.y+data.media.frame!.height/2))).toBeLessThanOrEqual(1);
    expect(Math.abs(data.media.frame!.x+data.media.frame!.width/2-(data.panelContentCenter!.x))).toBeLessThanOrEqual(1);
    expect(data.popupScroll.scrollWidth).toBeLessThanOrEqual(data.popupScroll.clientWidth+1);
  });
}

// 세라피엘 보충 검수(review.py)의 두 시나리오를 그대로 옮긴다.
for(const [vw,vh] of attachmentViewports) {
  test(`review supplement: card attachment document gallery ${vw}x${vh}`,async({page})=>{
    await openDialogueSample(page,"card-attachments",vw,vh);
    const link=page.getByRole("link",{name:"보고.txt"}).first();
    await expect(link).toBeVisible({timeout:30000});
    await link.click();
    const popup=page.locator('[data-slot="dialog-popup"]');
    await expect(popup).toBeVisible();
    await expect(popup.locator("pre, .chat-attachment-markdown").first()).toBeVisible();
    const doc=await captureAttachment(page,popup,`review-card-attachment-document-${vw}x${vh}`,vw,vh);
    const nextDoc=await nextButtonBox(popup);
    await popup.getByRole("button",{name:"이전 첨부"}).click();
    await expect(popup.locator("img")).toBeVisible();
    const image=await captureAttachment(page,popup,`review-card-attachment-image-${vw}x${vh}`,vw,vh);
    const nextImage=await nextButtonBox(popup);
    if(phase!=="after") return;
    expect(doc.count).toBe("3/7");
    expect(doc.textBody!.width).toBeLessThanOrEqual(768+1);
    expect(doc.popupScroll.scrollWidth).toBeLessThanOrEqual(doc.popupScroll.clientWidth+1);
    expect(image.kind).toBe("image");
    expect(Math.abs(nextImage.x-nextDoc.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(nextImage.y-nextDoc.y)).toBeLessThanOrEqual(2);
    await popup.getByRole("button",{name:"다음 첨부"}).click();
    await expect(popup.locator("pre, .chat-attachment-markdown").first()).toBeVisible();
    const back=await nextButtonBox(popup);
    expect(Math.abs(back.x-nextDoc.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(back.y-nextDoc.y)).toBeLessThanOrEqual(2);
  });
  test(`review supplement: chat attachment document and video steps ${vw}x${vh}`,async({page})=>{
    await openDialogueSample(page,"chat-attachments",vw,vh);
    const docTarget=page.getByText("톤 제안 원문.md",{exact:true}).first();
    await expect(docTarget).toBeVisible({timeout:30000});
    await docTarget.click();
    let popup=page.locator('[data-slot="dialog-popup"]');
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    const doc=await captureAttachment(page,popup,`review-chat-attachment-document-${vw}x${vh}`,vw,vh);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    const videoTarget=page.getByText("sample-video.mp4",{exact:true}).first();
    await expect(videoTarget).toBeVisible({timeout:20000});
    await videoTarget.click();
    popup=page.locator('[data-slot="dialog-popup"]');
    await expect(popup.locator("video")).toBeVisible();
    await waitVideoMetadata(popup);
    const video=await captureAttachment(page,popup,`review-chat-attachment-video-${vw}x${vh}`,vw,vh);
    if(phase!=="after") return;
    expect(doc.count).toBe("9/17");
    expect(doc.textBody!.width).toBeLessThanOrEqual(768+1);
    expect(Math.abs(doc.textBody!.left+doc.textBody!.width/2-(doc.media.panel!.x+doc.media.panel!.width/2))).toBeLessThanOrEqual(1);
    expect(doc.popupScroll.scrollWidth).toBeLessThanOrEqual(doc.popupScroll.clientWidth+1);
    expect(video.count).toBe("3/17");
    expect(video.media.natural).toEqual([16,16]);
    expect(Math.abs(video.media.video!.x+video.media.video!.width/2-(video.media.frame!.x+video.media.frame!.width/2))).toBeLessThanOrEqual(1);
    expect(Math.abs(video.media.video!.y+video.media.video!.height/2-(video.media.frame!.y+video.media.frame!.height/2))).toBeLessThanOrEqual(1);
    expect(Math.abs(video.media.frame!.x+video.media.frame!.width/2-(video.panelContentCenter!.x))).toBeLessThanOrEqual(1);
    expect(Math.abs(video.media.frame!.y+video.media.frame!.height/2-(video.panelContentCenter!.y))).toBeLessThanOrEqual(1);
    expect(video.popupScroll.scrollWidth).toBeLessThanOrEqual(video.popupScroll.clientWidth+1);
  });
}

for(const surface of ["card","pas"] as const) {
  test(`question document link opens the viewer ${surface}`,async({page,context})=>{
    await page.setViewportSize({width:1440,height:900});
    await page.emulateMedia({colorScheme:"light",reducedMotion:"reduce"});
    await page.addInitScript(()=>{
      localStorage.setItem("ls.webglGlass","0");
      Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
      Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});
    });
    await installV3VisualQaRoutes(page);
    await page.route("**/api/auth/config",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({authEnabled:true,devModeEnabled:false})}));
    await page.route("**/api/auth/status",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}})}));
    await page.goto(`/components?sample=card-question&scene=ga&surface=${surface}`);
    const link=page.getByRole("link",{name:"미리 해 둘 정리 작업 모음"});
    await expect(link).toBeVisible({timeout:20000});
    const url=page.url();
    const pagesBefore=context.pages().length;
    const newPagePromise=context.waitForEvent("page",{timeout:3000}).catch(()=>null);
    await link.click();
    const newPage=await newPagePromise;
    if(newPage) {
      await newPage.waitForLoadState("domcontentloaded").catch(()=>undefined);
      await newPage.screenshot({path:path.join(output,`question-${surface}-new-tab.png`),animations:"disabled",timeout:15000});
      writeFileSync(path.join(output,`question-${surface}-new-tab.json`),JSON.stringify({newTabUrl:newPage.url(),pagesBefore,pagesAfter:context.pages().length},null,2));
      await newPage.close();
    }
    if(phase!=="after") {
      expect(newPage).not.toBeNull();
      return;
    }
    expect(newPage).toBeNull();
    const popup=page.locator(".chat-image-viewer-popup");
    await expect(popup).toBeVisible();
    await expect(popup.locator(".chat-attachment-markdown")).toBeVisible();
    expect(page.url()).toBe(url);
    expect(context.pages().length).toBe(pagesBefore);
    const data=await captureAttachment(page,popup,`question-document-${surface}`,1440,900);
    expect(data.kind).toBe("document");
    expect(Math.abs(data.popup.width-documentCap(1440))).toBeLessThanOrEqual(1);
    expect(data.active).toBe(true);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(link).toBeFocused();
  });
}

for(const [vw,vh] of [[1920,1080],[390,844]] as const) {
  test(`attachment caller chat image unchanged ${vw}x${vh}`,async({page})=>{
    const popup=await open(page,"chat",vw,vh,800,600,"",{gallery:"single"});
    const data=await metrics(popup);
    await page.screenshot({path:path.join(output,`caller-chat-${vw}x${vh}.png`),animations:"disabled",timeout:15000});
    writeFileSync(path.join(output,`caller-chat-${vw}x${vh}.json`),JSON.stringify({viewport:[vw,vh],...data},null,2));
    const scale=Math.min(1,(vw-32-data.border-48)/800);
    expect(data.image.width).toBeCloseTo(800*scale,0);
    expect(data.image.height).toBeCloseTo(600*scale,0);
    expect(data.popup.width).toBeCloseTo(Math.max(320,data.image.width+48+data.border),0);
    expect(data.popup.right).toBeLessThanOrEqual(vw-15);
  });
}

// 카드 #429: 긴 캡처는 통째로 맞추지 않고 읽기 크기(폭 상한 448)로 열고 창 안에서 스크롤한다.
// 두 창(AttachmentViewer, CardImageViewer)이 같은 틀을 쓴다. 장면은 시안 visual_check.py를 옮긴 것이다.
const tallSvg=(w=1170,h=7200)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f4f1ea"/><rect x="24" y="24" width="${w-48}" height="${h-48}" fill="none" stroke="#3b6ea5" stroke-width="8"/><text x="48" y="96" fill="#1f2933" font-size="48">${w} × ${h}</text></svg>`;
async function readingMetrics(popup:Locator) {
  return popup.evaluate(el=>{
    const rect=(node:Element)=>node.getBoundingClientRect().toJSON();
    const image=el.querySelector("img") as HTMLImageElement|null;
    const viewport=el.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const status=el.querySelector<HTMLElement>(".attachment-viewer-state");
    const panel=el.querySelector<HTMLElement>('[data-slot="dialog-panel"]');
    const toggle=el.querySelector<HTMLElement>(".attachment-viewer-actions button");
    const center=(box:{left:number;top:number;width:number;height:number})=>({x:box.left+box.width/2,y:box.top+box.height/2});
    const contentCenter=(()=>{
      if(!panel) return null;
      const style=getComputedStyle(panel);
      const box=panel.getBoundingClientRect();
      const left=parseFloat(style.paddingLeft),right=parseFloat(style.paddingRight);
      const top=parseFloat(style.paddingTop),bottom=parseFloat(style.paddingBottom);
      return {x:box.x+left+(box.width-left-right)/2,y:box.y+top+(box.height-top-bottom)/2};
    })();
    const scrollMax=(axis:"y"|"x",node:HTMLElement)=>axis==="y"?node.scrollHeight-node.clientHeight:node.scrollWidth-node.clientWidth;
    return {
      state:el.getAttribute("data-image-state"),
      frame:el.getAttribute("data-image-frame"),
      fit:el.getAttribute("data-image-fit"),
      popup:rect(el),
      image:image?rect(image):null,
      natural:image?[image.naturalWidth,image.naturalHeight]:null,
      imageSrc:image?.getAttribute("src") ?? null,
      imageBackground:image?getComputedStyle(image).backgroundColor:null,
      colorScheme:image?getComputedStyle(image).colorScheme:null,
      viewport:viewport?{
        rect:rect(viewport),scrollTop:viewport.scrollTop,scrollLeft:viewport.scrollLeft,
        scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight,
        scrollWidth:viewport.scrollWidth,clientWidth:viewport.clientWidth,
        maxY:scrollMax("y",viewport),maxX:scrollMax("x",viewport),
        tabIndex:viewport.tabIndex,role:viewport.getAttribute("role"),
        label:viewport.getAttribute("aria-label"),focused:document.activeElement===viewport,
      }:null,
      status:status?{rect:rect(status),center:center(status.getBoundingClientRect())}:null,
      contentCenter,
      toggle:toggle?{rect:rect(toggle),label:toggle.getAttribute("aria-label"),title:toggle.getAttribute("title")}:null,
      close:(()=>{const node=el.querySelector<HTMLElement>('[aria-label="닫기"]');return node?rect(node):null;})(),
      title:(()=>{const node=el.querySelector<HTMLElement>(".chat-image-viewer-title");return node?{...rect(node),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}:null;})(),
      body:(()=>{const node=el.querySelector<HTMLElement>(".attachment-viewer-image-body");return node?rect(node):null;})(),
      figure:(()=>{const figure=el.querySelector("figure");return figure?rect(figure):null;})(),
      caption:el.querySelector("figcaption")?.textContent ?? null,
      pageScrollWidth:document.documentElement.scrollWidth,
      innerWidth:window.innerWidth,
    };
  });
}
async function captureReading(page:Page,popup:Locator,name:string,vw:number,vh:number) {
  const data={viewport:[vw,vh],...await readingMetrics(popup)};
  await page.screenshot({path:path.join(output,name+".png"),animations:"disabled",timeout:15000});
  writeFileSync(path.join(output,name+".json"),JSON.stringify(data,null,2));
  return data;
}
function expectCentered(data:{status:{center:{x:number;y:number}}|null;contentCenter:{x:number;y:number}|null}) {
  expect(data.status).not.toBeNull();
  expect(data.contentCenter).not.toBeNull();
  expect(Math.abs(data.status!.center.x-data.contentCenter!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(data.status!.center.y-data.contentCenter!.y)).toBeLessThanOrEqual(2);
}
function expectReadingFrame(data:{popup:{width:number;height:number;left:number;right:number};image:{width:number;height:number}|null;viewport:any;frame:string|null},vw:number,vh:number,axis:"y"|"x") {
  const margin=vw<=640?24:32;
  expect(data.frame).toBe(axis==="y"?"column":"full");
  expect(Math.abs(data.popup.height-(vh-2*margin))).toBeLessThanOrEqual(1);
  expect(data.popup.width).toBeLessThanOrEqual(axis==="y"?448+1:vw-32+1);
  expect(data.popup.width).toBeGreaterThanOrEqual(axis==="y"?Math.min(448,vw-32)-1:1);
  expect(data.viewport).not.toBeNull();
  expect(data.viewport.tabIndex).toBe(0);
  expect(data.viewport.role).toBe("region");
  expect(data.viewport.focused).toBe(true);
  expect(axis==="y"?data.viewport.maxY:data.viewport.maxX).toBeGreaterThan(0);
  if(axis==="y") expect(data.image!.width).toBeLessThanOrEqual(data.popup.width);
  else expect(data.image!.width).toBeGreaterThan(data.viewport.clientWidth);
  expect(data.pageScrollWidth).toBeLessThanOrEqual(data.innerWidth);
}

test("card429 tall capture reads at the 448 fit width (wide and narrow)",async({page})=>{
  for(const [vw,vh] of [[1920,1080],[360,780]] as const) {
    const popup=await openAttachment(page,"image-tall",vw,vh,1170,7200);
    await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000}).catch(()=>{});
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
    await page.waitForTimeout(350);
    const data=await captureReading(page,popup,`card429-tall-${vw}x${vh}`,vw,vh);
    if(phase!=="after") continue;
    expectReadingFrame(data,vw,vh,"y");
    expect(data.natural).toEqual([1170,7200]);
    expect(data.toggle).not.toBeNull();
    expect(data.toggle!.label).toBe("전체 보기");
    expect(data.toggle!.title).toBe("전체 보기");
    const contentWidth=data.popup.width-48; // 패널 좌우 안쪽 여백
    expect(Math.abs(data.image!.width-contentWidth)).toBeLessThanOrEqual(2);
    expect(data.image!.width/data.image!.height).toBeCloseTo(1170/7200,3);
  }
});

test("card429 wide capture reads at the full width and scrolls sideways",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await openAttachment(page,"image-wide",vw,vh,7200,600);
  await expect(popup).toHaveAttribute("data-image-frame","full",{timeout:5000}).catch(()=>{});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await page.waitForTimeout(350);
  const data=await captureReading(page,popup,`card429-wide-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  expectReadingFrame(data,vw,vh,"x");
  expect(data.natural).toEqual([7200,600]);
  expect(data.toggle!.label).toBe("전체 보기");
  const toggle=popup.locator(".attachment-viewer-actions button");
  await toggle.click();
  await expect(popup).toHaveAttribute("data-image-fit","whole");
  await expect(toggle).toHaveAttribute("aria-label","높이에 맞춤");
  await toggle.click();
  await expect(popup).toHaveAttribute("data-image-fit","read");
  await popup.locator('[data-slot="scroll-area-viewport"]').focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async()=>(await readingMetrics(popup)).viewport!.scrollLeft).toBeGreaterThan(0);
});

test("card429 fit toggle twice keeps the window and the scroll ratio",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await openAttachment(page,"image-tall",vw,vh,1170,7200);
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000}).catch(()=>{});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await page.waitForTimeout(350);
  await captureReading(page,popup,`card429-toggle-before-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  const viewport=popup.locator('[data-slot="scroll-area-viewport"]');
  await viewport.evaluate((el:HTMLElement)=>{
    el.scrollTop=(el.scrollHeight-el.clientHeight)*0.4;
    el.dispatchEvent(new Event("scroll"));
  });
  const beforeData=await readingMetrics(popup);
  const before=beforeData.viewport!;
  const toggle=popup.locator(".attachment-viewer-actions button");
  await toggle.dblclick();
  await page.waitForTimeout(120);
  await expect(popup).toHaveCount(1);
  const afterTwice=await captureReading(page,popup,`card429-toggle-twice-${vw}x${vh}`,vw,vh);
  expect(afterTwice.fit).toBe("read");
  expect(afterTwice.frame).toBe("column");
  expect(afterTwice.popup.width).toBeCloseTo(beforeData.popup.width,0);
  const ratio=(await readingMetrics(popup)).viewport!;
  expect(ratio.maxY).toBeGreaterThan(0);
  expect(ratio.scrollTop/ratio.maxY).toBeCloseTo(before.scrollTop/before.maxY,1);
  // 한 번씩 눌러 전체 보기로 갔다가 돌아와도 같은 비율이다.
  await toggle.click();
  await expect(popup).toHaveAttribute("data-image-fit","whole");
  const whole=await captureReading(page,popup,`card429-whole-${vw}x${vh}`,vw,vh);
  expect(whole.image!.height).toBeLessThanOrEqual(whole.viewport!.rect.height+1);
  await toggle.click();
  await expect(popup).toHaveAttribute("data-image-fit","read");
  await page.waitForTimeout(150);
  const restored=(await readingMetrics(popup)).viewport!;
  expect(restored.scrollTop/restored.maxY).toBeCloseTo(before.scrollTop/before.maxY,1);
});

test("card429 keyboard scrolls the reading frame",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await openAttachment(page,"image-tall",vw,vh,1170,7200);
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await page.waitForTimeout(400);
  await captureReading(page,popup,`card429-keyboard-before-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  const viewport=popup.locator('[data-slot="scroll-area-viewport"]');
  await expect(viewport).toBeVisible();
  await expect(viewport).toBeFocused();
  const start=(await readingMetrics(popup)).viewport!;
  for(const key of ["ArrowDown","PageDown","Space"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    const next=(await readingMetrics(popup)).viewport!;
    expect(next.scrollTop).toBeGreaterThan(start.scrollTop);
  }
  const data=await captureReading(page,popup,`card429-keyboard-${vw}x${vh}`,vw,vh);
  expect(data.viewport!.focused).toBe(true);
  expect(data.viewport!.tabIndex).toBe(0);
});

test("card429 loading shows the centred operational state",async({page})=>{
  const [vw,vh]=[1920,1080];
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/attachments/image-slow/content*",async route=>{
    await gate;
    return route.fulfill({contentType:"image/svg+xml",body:tallSvg()});
  });
  const popup=await openAttachment(page,"image-slow",vw,vh);
  await page.waitForTimeout(300);
  const loading=await captureReading(page,popup,`card429-loading-${vw}x${vh}`,vw,vh);
  if(phase==="after") {
    expect(loading.state).toBe("loading");
    expectCentered(loading);
    expect(loading.toggle).toBeNull();
    expect(loading.popup.height).toBeGreaterThanOrEqual(256);
    expect(loading.viewport).toBeNull();
  }
  release();
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000}).catch(()=>{});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await page.waitForTimeout(200);
  const loaded=await captureReading(page,popup,`card429-loading-loaded-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  expect(loaded.state).toBe("ready");
  expect(loaded.popup.width).toBeLessThanOrEqual(448+1);
});

test("card429 failure shows the centred state and retries in the same place",async({page})=>{
  const [vw,vh]=[1920,1080];
  let gets=0;
  await page.route("**/api/attachments/image-fail/content*",route=>{
    if(route.request().method()==="HEAD") return route.fulfill({status:500});
    gets+=1;
    if(gets===1) return route.fulfill({status:500,body:"failed"});
    return route.fulfill({contentType:"image/svg+xml",body:tallSvg()});
  });
  const popup=await openAttachment(page,"image-fail",vw,vh);
  await expect(popup.locator("[data-slot=dialog-error-message]")).toContainText("이미지를 불러오지 못했습니다",{timeout:8000});
  if(phase==="after") await expect(popup.getByRole("button",{name:"다시 시도"})).toBeVisible({timeout:5000});
  const failed=await captureReading(page,popup,`card429-failure-${vw}x${vh}`,vw,vh);
  if(phase==="after") {
    expect(failed.state).toBe("failed");
    expectCentered(failed);
    expect(failed.toggle).toBeNull();
    expect(failed.viewport).toBeNull();
  } else return;
  await popup.getByRole("button",{name:"다시 시도"}).click();
  await page.waitForTimeout(500);
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await page.waitForTimeout(150);
  const retried=await captureReading(page,popup,`card429-failure-retried-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  expect(retried.state).toBe("ready");
  expect(retried.frame).toBe("column");
  expect(retried.toggle).not.toBeNull();
});

test("card429 SVG draws on the light picture background in the dark theme",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await openAttachment(page,"image-svg",vw,vh,240,160,"dark");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
  const data=await captureReading(page,popup,`card429-svg-dark-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  expect(data.colorScheme).toBe("light");
  expect(data.imageBackground).toBe("rgb(255, 255, 255)");
  expect(data.natural).toEqual([240,160]);
});

test("card429 HEIC decodes in chromium",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await openAttachment(page,"image-heic",vw,vh,320,240);
  await page.waitForTimeout(400);
  if(phase==="after") {
    await expect.poll(async()=>(await readingMetrics(popup)).imageSrc?.startsWith("blob:") ?? false,{timeout:15000}).toBe(true);
    await expect.poll(async()=>(await readingMetrics(popup)).natural,{timeout:15000}).toEqual([320,240]);
  }
  const data=await captureReading(page,popup,`card429-heic-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  expect(data.state).toBe("ready");
  expect(data.imageSrc.startsWith("blob:")).toBe(true);
});

test("card429 Escape inside the HTML preview closes the window",async({page})=>{
  const [vw,vh]=[1920,1080];
  await page.route("**/api/attachments/slow-html/content*",route=>{
    const html="<!doctype html><html><body><h1>Esc relay</h1></body></html>";
    const body=html+"<!--"+" ".repeat(4096-html.length-7)+"-->";
    return route.fulfill({status:206,headers:{
      "Content-Type":"text/html; charset=utf-8","Content-Length":"4096","Content-Range":"bytes 0-4095/4096",
    },body});
  });
  const popup=await openAttachment(page,"html-slow",vw,vh);
  const frame=popup.locator("iframe.chat-attachment-html-frame");
  await expect(frame).toBeVisible();
  await captureReading(page,popup,`card429-html-${vw}x${vh}`,vw,vh);
  await page.frameLocator("iframe.chat-attachment-html-frame").locator("h1").click();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0,{timeout:5000});
});

test("card429 resized window keeps the reading frame and the scroll ratio",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await openAttachment(page,"image-tall",vw,vh,1170,7200);
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000}).catch(()=>{});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await page.waitForTimeout(350);
  await captureReading(page,popup,`card429-resize-before-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  const viewport=popup.locator('[data-slot="scroll-area-viewport"]');
  await viewport.evaluate((el:HTMLElement)=>{
    el.scrollTop=(el.scrollHeight-el.clientHeight)*0.35;
    el.dispatchEvent(new Event("scroll"));
  });
  const before=(await readingMetrics(popup)).viewport!;
  await page.setViewportSize({width:1280,height:800});
  const data=await captureReading(page,popup,"card429-resize-after-1280x800",1280,800);
  expect(data.frame).toBe("column");
  expect(data.fit).toBe("read");
  expect(Math.abs(data.popup.height-(800-64))).toBeLessThanOrEqual(1);
  // The restored ratio lands on the first frame after the new layout settles.
  await expect.poll(async()=>{
    const viewport=(await readingMetrics(popup)).viewport!;
    return viewport.maxY>0?viewport.scrollTop/viewport.maxY:0;
  },{timeout:3000}).toBeCloseTo(before.scrollTop/before.maxY,1);
});

/* 카드 #429 화면 검수 반려 보완(R1~R7). 항목마다 장면과 단언을 두고, 캡처 이름에 R 번호를 남긴다. */
function centerOf(rect:{left:number;top:number;width:number;height:number}) {
  return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
}
async function actionStyles(popup:Locator) {
  return popup.evaluate(el=>{
    const read=(node:HTMLElement)=>{
      const style=getComputedStyle(node);
      return {background:style.backgroundColor,borderColor:style.borderTopColor,borderWidth:style.borderTopWidth};
    };
    const close=el.querySelector<HTMLElement>('[aria-label="닫기"]');
    const toggle=el.querySelector<HTMLElement>(".attachment-viewer-actions button");
    return {close:close?read(close):null,toggle:toggle?read(toggle):null};
  });
}
async function openCardImage(page:Page,vw:number,vh:number,options:{theme?:"light"|"dark";sample?:string;caption?:string}={}) {
  await page.setViewportSize({width:vw,height:vh});
  const theme=options.theme ?? "light";
  await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
  await page.addInitScript((nextTheme:string)=>{
    localStorage.setItem("ls.webglGlass","0");
    localStorage.setItem("soul-dashboard-theme",nextTheme);
  },theme);
  await page.goto(`/e2e/image-viewer.fixture.html?viewer=card&width=1170&height=7200&caption=${options.caption ?? "one"}&theme=${theme}&sample=${options.sample ?? ""}`);
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  return popup;
}
async function openFailingCard(page:Page,status:number,vw:number,vh:number) {
  await page.route("**/image-viewer-screen-fail.png*",route=>{
    if(route.request().method()==="HEAD") return route.fulfill({status});
    return route.fulfill({status,body:"failed"});
  });
  return openCardImage(page,vw,vh,{sample:"fail"});
}

test("card429 R1 arrow keys step a vertical gallery and scroll a horizontal frame",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await open(page,"chat",vw,vh,1170,7200,"",{gallery:"reading"});
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  const viewport=popup.locator('[data-slot="scroll-area-viewport"]');
  await expect(viewport).toBeFocused({timeout:3000});
  const start=await captureReading(page,popup,`card429-R1-vertical-start-${vw}x${vh}`,vw,vh);
  expect(start.imageSrc).toContain("/tall.svg");
  // 세로 읽기 틀에서는 세로 키가 스크롤하고 그림은 그대로다.
  const positions:number[]=[];
  for(const key of ["ArrowDown","PageDown","Space","End"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
    const next=await readingMetrics(popup);
    expect(next.imageSrc).toContain("/tall.svg");
    positions.push(next.viewport!.scrollTop);
  }
  expect(positions[0]).toBeGreaterThan(0);
  expect(positions[1]).toBeGreaterThan(positions[0]);
  expect(positions[2]).toBeGreaterThanOrEqual(positions[1]);
  expect(positions[3]).toBe((await readingMetrics(popup)).viewport!.maxY);
  expect(positions[3]).toBeGreaterThanOrEqual(positions[2]);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(120);
  const up=(await readingMetrics(popup)).viewport!.scrollTop;
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(120);
  const pageUp=(await readingMetrics(popup)).viewport!.scrollTop;
  expect(up).toBeLessThan(positions[3]);
  expect(pageUp).toBeLessThan(up);
  await page.keyboard.press("Home");
  await expect.poll(async()=>(await readingMetrics(popup)).viewport!.scrollTop,{timeout:2000}).toBe(0);
  await captureReading(page,popup,`card429-R1-vertical-scrolled-${vw}x${vh}`,vw,vh);
  // 세로 틀에서 →는 다음 그림으로 넘긴다(주 동작).
  await page.keyboard.press("ArrowRight");
  await expect.poll(async()=>(await readingMetrics(popup)).imageSrc,{timeout:5000}).toContain("/wide.svg");
  await expect(popup.locator(".chat-image-viewer-count")).toHaveText("2/2");
  await expect(popup).toHaveAttribute("data-image-frame","full",{timeout:5000});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  const stepped=await captureReading(page,popup,`card429-R1-vertical-next-${vw}x${vh}`,vw,vh);
  expect(stepped.imageSrc).toContain("/wide.svg");
  // 가로 읽기 틀에 초점이 있으면 ←/→는 스크롤한다.
  await expect(viewport).toBeFocused({timeout:3000});
  await page.keyboard.press("ArrowRight");
  await expect.poll(async()=>(await readingMetrics(popup)).viewport!.scrollLeft,{timeout:2000}).toBeGreaterThan(0);
  await expect(popup.locator(".chat-image-viewer-count")).toHaveText("2/2");
  const right=(await readingMetrics(popup)).viewport!.scrollLeft;
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async()=>(await readingMetrics(popup)).viewport!.scrollLeft,{timeout:2000}).toBeLessThan(right);
  await expect(popup.locator(".chat-image-viewer-count")).toHaveText("2/2");
  await captureReading(page,popup,`card429-R1-horizontal-scroll-${vw}x${vh}`,vw,vh);
});

test("card429 R1 ArrowLeft steps back while the frame is vertical",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await open(page,"chat",vw,vh,7200,600,"",{gallery:"reading-wide"});
  await expect(popup).toHaveAttribute("data-image-frame","full",{timeout:5000});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await popup.getByRole("button",{name:"다음 이미지"}).click();
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  await expect(popup.locator(".chat-image-viewer-count")).toHaveText("2/2");
  await page.waitForTimeout(300);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async()=>(await readingMetrics(popup)).imageSrc,{timeout:5000}).toContain("/wide.svg");
  await expect(popup.locator(".chat-image-viewer-count")).toHaveText("1/2");
  await captureReading(page,popup,`card429-R1-horizontal-back-${vw}x${vh}`,vw,vh);
});

test("card429 R2 one gallery frame holds tall and wide pictures (wide and narrow)",async({page})=>{
  for(const [vw,vh] of [[1920,1080],[390,844]] as const) {
    const margin=viewportMargin(vw);
    const popup=await open(page,"chat",vw,vh,1170,7200,"",{gallery:"reading"});
    await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000});
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
    await page.waitForTimeout(200);
    const tall=await captureReading(page,popup,`card429-R2-gallery-tall-${vw}x${vh}`,vw,vh);
    expect(tall.popup.width).toBeCloseTo(vw-32,0);
    expect(tall.popup.height).toBeCloseTo(vh-2*margin,0);
    expect(tall.image!.width).toBeCloseTo(Math.min(398,tall.viewport!.clientWidth),0);
    const viewportCenter=centerOf(tall.viewport!.rect);
    expect(Math.abs(centerOf(tall.image!).x-viewportCenter.x)).toBeLessThanOrEqual(2);
    expect(tall.viewport!.maxY).toBeGreaterThan(0);
    expect(tall.close).not.toBeNull();
    await popup.getByRole("button",{name:"다음 이미지"}).click();
    await expect(popup).toHaveAttribute("data-image-frame","full",{timeout:5000});
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
    await page.waitForTimeout(200);
    const wide=await captureReading(page,popup,`card429-R2-gallery-wide-${vw}x${vh}`,vw,vh);
    expect(wide.imageSrc).toContain("/wide.svg");
    // 창 틀과 닫기 단추 자리는 장마다 같다.
    expect(wide.popup.width).toBeCloseTo(tall.popup.width,0);
    expect(wide.popup.height).toBeCloseTo(tall.popup.height,0);
    expect(wide.popup.left).toBeCloseTo(tall.popup.left,0);
    expect(wide.popup.top).toBeCloseTo(tall.popup.top,0);
    expect(wide.close!.left).toBeCloseTo(tall.close!.left,0);
    expect(wide.close!.top).toBeCloseTo(tall.close!.top,0);
    expect(wide.image!.height).toBeCloseTo(Math.min(wide.natural![1],wide.viewport!.clientHeight),0);
    expect(wide.viewport!.maxX).toBeGreaterThan(0);
    expect(wide.pageScrollWidth).toBeLessThanOrEqual(wide.innerWidth);
    // 한 장만 여는 창의 448 읽기 틀은 그대로다.
    if(vw===1920) {
      const single=await openAttachment(page,"image-tall",vw,vh,1170,7200);
      await expect(single).toHaveAttribute("data-image-frame","column",{timeout:5000}).catch(()=>{});
      await single.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
      await page.waitForTimeout(200);
      const shot=await captureReading(page,single,`card429-R2-single-tall-${vw}x${vh}`,vw,vh);
      expect(shot.popup.width).toBeCloseTo(448,0);
      expect(shot.image!.width).toBeCloseTo(shot.viewport!.clientWidth,0);
    }
  }
});

test("card429 R3 fit toggle matches the close button on light, dark and bright pictures",async({page})=>{
  const [vw,vh]=[1920,1080];
  const scenes=[
    {name:"light-bright",theme:"light" as const,sample:"tall-screen"},
    {name:"dark-bright",theme:"dark" as const,sample:"tall-screen"},
    {name:"light-dark-picture",theme:"light" as const,sample:"tall-screen-dark"},
  ];
  for(const scene of scenes) {
    const popup=await open(page,"card",vw,vh,1170,7200,"one",{theme:scene.theme,sample:scene.sample});
    const toggle=popup.locator(".attachment-viewer-actions button");
    await expect(toggle).toBeVisible({timeout:5000});
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
    const data=await captureReading(page,popup,`card429-R3-${scene.name}-${vw}x${vh}`,vw,vh);
    const styles=await actionStyles(popup);
    expect(data.close).not.toBeNull();
    expect(Math.abs(data.toggle!.rect.width-data.close!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(data.toggle!.rect.height-data.close!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(data.toggle!.rect.top-data.close!.top)).toBeLessThanOrEqual(1);
    const gap=data.close!.left-data.toggle!.rect.right;
    expect(gap).toBeGreaterThanOrEqual(3);
    expect(gap).toBeLessThanOrEqual(5);
    expect(styles.close).not.toBeNull();
    expect(styles.toggle!.background).toBe(styles.close!.background);
    expect(styles.toggle!.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.toggle!.borderColor).toBe(styles.close!.borderColor);
    expect(styles.toggle!.borderWidth).toBe(styles.close!.borderWidth);
  }
});

test("card429 R4 card image window focuses the scroll area and PageDown and Space scroll it",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await open(page,"card",vw,vh,1170,7200,"one",{sample:"tall-screen"});
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  const viewport=popup.locator('[data-slot="scroll-area-viewport"]');
  await expect(viewport).toBeFocused({timeout:3000});
  const start=await captureReading(page,popup,`card429-R4-card-first-focus-${vw}x${vh}`,vw,vh);
  expect(start.viewport!.focused).toBe(true);
  for(const key of ["PageDown","Space"]) {
    const before=(await readingMetrics(popup)).viewport!.scrollTop;
    await page.keyboard.press(key);
    await expect.poll(async()=>(await readingMetrics(popup)).viewport!.scrollTop,{timeout:2000}).toBeGreaterThan(before);
    await expect(popup).toHaveCount(1);
  }
  const data=await captureReading(page,popup,`card429-R4-card-scrolled-${vw}x${vh}`,vw,vh);
  expect(data.viewport!.focused).toBe(true);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("card429 R5 card failure keeps one centred group and the original caption",async({page})=>{
  for(const [vw,vh] of [[1920,1080],[390,844]] as const) for(const status of [500,404]) {
    const popup=await openFailingCard(page,status,vw,vh);
    await expect(popup).toHaveAttribute("data-image-state","failed",{timeout:8000});
    const state=popup.locator(".attachment-viewer-state");
    await expect(state).toContainText("파일을 불러오지 못했습니다");
    await page.waitForTimeout(300);
    const retry=popup.getByRole("button",{name:"다시 시도"});
    const data=await captureReading(page,popup,`card429-R5-fail-${status}-${vw}x${vh}`,vw,vh);
    expect(data.caption).toBe("화면 캡처");
    await expect(popup.locator("figcaption")).not.toContainText("불러오지");
    expect(data.body).not.toBeNull();
    const bodyCenter=centerOf(data.body!);
    expect(Math.abs(data.status!.center.x-bodyCenter.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(data.status!.center.y-bodyCenter.y)).toBeLessThanOrEqual(2);
    const message=popup.locator('[data-slot="dialog-error-message"]');
    await expect(message).toBeVisible();
    if(status===500) {
      await expect(retry).toBeVisible({timeout:3000});
      const messageBox=(await message.boundingBox())!;
      const retryBox=(await retry.boundingBox())!;
      expect(retryBox.y).toBeGreaterThan(messageBox.y+messageBox.height-1);
      expect(Math.abs((messageBox.x+messageBox.width/2)-(retryBox.x+retryBox.width/2))).toBeLessThanOrEqual(2);
    } else {
      await expect(retry).toHaveCount(0);
    }
  }
});

test("card429 R6 query and path parameter SVG keep the light picture background",async({page})=>{
  const [vw,vh]=[1920,1080];
  await page.setViewportSize({width:vw,height:vh});
  await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  await page.addInitScript(()=>{
    localStorage.setItem("ls.webglGlass","0");
    localStorage.setItem("soul-dashboard-theme","dark");
  });
  const diagram=`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><path d="M40 260 L240 60 L440 260" fill="none" stroke="#2f3a4a" stroke-width="10"/><circle cx="240" cy="60" r="24" fill="#c85028"/><text x="40" y="300" font-family="sans-serif" font-size="22" fill="#222">attachment flow</text></svg>`;
  await page.route(/\/fixture\.svg\?/,route=>route.fulfill({contentType:"image/svg+xml",body:diagram}));
  await page.route(/\/api\/attachments\/files\?/,route=>{
    if(route.request().method()==="HEAD") return route.fulfill({status:200,headers:{"Content-Type":"application/octet-stream"}});
    return route.fulfill({contentType:"image/svg+xml",body:diagram});
  });
  await page.goto("/e2e/image-viewer.fixture.html?viewer=chat&width=480&height=320&gallery=svgurls&theme=dark");
  const tiles=page.locator(".chat-image-grid img");
  await expect(tiles).toHaveCount(2,{timeout:8000});
  const tileStyles=await tiles.evaluateAll(images=>images.map(image=>({
    format:image.getAttribute("data-image-format"),
    background:getComputedStyle(image).backgroundColor,
    scheme:getComputedStyle(image).colorScheme,
  })));
  for(const tile of tileStyles) {
    expect(tile.format).toBe("svg");
    expect(tile.background).toBe("rgb(255, 255, 255)");
    expect(tile.scheme).toBe("light");
  }
  await page.screenshot({path:path.join(output,`card429-R6-tiles-${vw}x${vh}.png`),animations:"disabled",timeout:15000});
  writeFileSync(path.join(output,`card429-R6-tiles-${vw}x${vh}.json`),JSON.stringify(tileStyles,null,2));
  await page.locator(".chat-image-grid img[role=button]").first().click();
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  const first=await captureReading(page,popup,`card429-R6-viewer-query-${vw}x${vh}`,vw,vh);
  expect(first.imageBackground).toBe("rgb(255, 255, 255)");
  expect(first.colorScheme).toBe("light");
  await popup.getByRole("button",{name:"다음 이미지"}).click();
  await expect.poll(async()=>(await readingMetrics(popup)).imageSrc,{timeout:5000}).toContain("path=chart.svg");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  const second=await captureReading(page,popup,`card429-R6-viewer-path-${vw}x${vh}`,vw,vh);
  expect(second.imageBackground).toBe("rgb(255, 255, 255)");
  expect(second.colorScheme).toBe("light");
});

test("card429 R7 toggle sits one token from close and the title truncates before it",async({page})=>{
  const longName="카드 #429 첨부 보기 창 머리줄 긴 이름 확인용 화면 캡처 원본 파일 이름입니다 ".repeat(4)+"final-capture-name.png";
  // 700px 폭은 닫기 단추가 36px로 남는 구간이다. Tailwind sm 경계(--breakpoint-sm=48rem)와
  // 같은 자리에서 변수가 바뀌지 않으면 「전체 보기」가 닫기 단추 쪽으로 밀린다.
  for(const [vw,vh] of [[1920,1080],[390,844],[700,900]] as const) {
    const popup=await openAttachment(page,"image-tall",vw,vh,1170,7200,"light",{name:longName,sample:"tall-screen"});
    await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000});
    await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
    const toggle=popup.locator(".attachment-viewer-actions button");
    await expect(toggle).toBeVisible({timeout:5000});
    const data=await captureReading(page,popup,`card429-R7-header-${vw}x${vh}`,vw,vh);
    expect(data.title).not.toBeNull();
    expect(data.close).not.toBeNull();
    expect(data.toggle).not.toBeNull();
    expect(Math.abs(data.toggle!.rect.top-data.close!.top)).toBeLessThanOrEqual(1);
    const gap=data.close!.left-data.toggle!.rect.right;
    expect(gap).toBeGreaterThanOrEqual(3);
    expect(gap).toBeLessThanOrEqual(5);
    expect(data.title!.right).toBeLessThanOrEqual(data.toggle!.rect.left+1);
    expect(data.title!.scrollWidth).toBeGreaterThan(data.title!.clientWidth);
  }
});

test("card429 card image window uses the same reading layout",async({page})=>{
  const [vw,vh]=[1920,1080];
  const popup=await open(page,"card",vw,vh,1170,7200,"one");
  await expect(popup).toHaveAttribute("data-image-frame","column",{timeout:5000}).catch(()=>{});
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode()).catch(()=>{});
  const data=await captureReading(page,popup,`card429-card-tall-${vw}x${vh}`,vw,vh);
  if(phase!=="after") return;
  expect(data.frame).toBe("column");
  expect(Math.abs(data.popup.height-(vh-64))).toBeLessThanOrEqual(1);
  expect(data.popup.width).toBeLessThanOrEqual(448+1);
  expect(data.viewport!.tabIndex).toBe(0);
  expect(data.viewport!.maxY).toBeGreaterThan(0);
  expect(data.toggle!.label).toBe("전체 보기");
  expect(data.caption).toBe("화면 캡처");
});
