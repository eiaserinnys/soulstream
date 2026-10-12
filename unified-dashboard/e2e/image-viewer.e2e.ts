import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const phase = process.env.IMAGE_VIEWER_PHASE ?? "after";
const output = path.resolve("../../../.local/artifacts/20261012-image-viewer", phase);
mkdirSync(output, {recursive:true});
const cases = [[1920,1080,800,600],[1920,1080,2560,1440],[1920,1080,1200,2800],[1920,1080,64,64],[390,844,800,600]];
async function open(page: Page, viewer: string, vw:number, vh:number, w:number, h:number, caption="", options: {theme?: "light"|"dark"; gallery?:string; sample?:string} = {}) {
  await page.setViewportSize({width:vw,height:vh});
  const theme=options.theme ?? "light";
  await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
  await page.addInitScript(theme=>{
    localStorage.setItem("ls.webglGlass","0");
    localStorage.setItem("soul-dashboard-theme",theme);
  },theme);
  await page.route(/\/(fixture|next|third|last)\.svg/,route=>{
    const url=new URL(route.request().url());
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
      close:rect(el.querySelector('[aria-label="Close"]')!),
      insets:[imageRect.left-popupRect.left,imageRect.top-popupRect.top,popupRect.right-imageRect.right,popupRect.bottom-imageRect.bottom],
      textStart,alignment:textStart===null?null:imageRect.left-textStart,framePadding,
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
    await page.screenshot({path:path.join(output,name+".png"),animations:"disabled"});
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
    const expectedScale=Math.min(1,(vw-32-data.border-padding)/w,(vh-32-data.border-data.reserved)/h);
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
  await page.screenshot({path:path.join(output,"card-long-caption.png"),animations:"disabled"});
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
  await page.screenshot({path:path.join(output,"ordinary.png"),animations:"disabled"});
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
  await page.screenshot({path:path.join(output,"card-three-lines.png"),animations:"disabled"});
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
  await page.screenshot({path:path.join(output,"file-small-painted.png"),animations:"disabled"});
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
  await expect(popup).toBeVisible();
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
  await page.screenshot({path:path.join(output,sample+"-dialogues.png"),animations:"disabled"});
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

async function capture(page:Page,popup:Locator,name:string,extra:Record<string,unknown>={}) {
  const data={...await metrics(popup),...extra};
  await page.screenshot({path:path.join(output,name+".png"),animations:"disabled"});
  writeFileSync(path.join(output,name+".json"),JSON.stringify(data,null,2));
  return data;
}

for(const viewer of ["card","file"]) for(const theme of ["light","dark"] as const)
for(const [vw,vh] of [[1920,1080],[390,844]]) for(const [w,h] of [[64,64],[192,192],[240,80],[200,120],[800,600],[2560,1440],[1200,2800],...(vw===390?[[390,900]]:[])]) {
  test(`repair inset ${viewer} ${theme} ${vw}x${vh} ${w}x${h}`,async({page})=>{
    const popup=await open(page,viewer,vw,vh,w,h,viewer==="card" && w===192?"two":"",{theme});
    const data=await capture(page,popup,`inset-${viewer}-${theme}-${vw}x${vh}-${w}x${h}`);
    const reserved=viewer==="card"?102:24;
    const scale=Math.min(1,(vw-58)/w,(vh-34-reserved)/h);
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
    expect(data.popup.top).toBeGreaterThanOrEqual(16);expect(data.popup.bottom).toBeLessThanOrEqual(vh-16);
    expect(Math.abs(data.image.width/data.image.height-w/h)/(w/h)).toBeLessThan(.01);
    expect(data.image.width).toBeLessThanOrEqual(w);expect(data.image.height).toBeLessThanOrEqual(h);
    if(viewer==="card") {
      expect(Math.abs(data.alignment!)).toBeLessThanOrEqual(1);
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
      expect(data.popup.width).toBe(vw-32);expect(data.popup.height).toBe(vh-32);
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
  const screenshot=await page.screenshot({path:path.join(output,name+".png"),animations:"disabled"});
  const contrast=await page.evaluate(async({png,theme,box})=>{
    const bitmap=await createImageBitmap(await (await fetch("data:image/png;base64,"+png)).blob());
    const canvas=document.createElement("canvas");
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext("2d")!;
    context.drawImage(bitmap,0,0);
    const rgb=(x:number,y:number)=>[...context.getImageData(Math.round(x),Math.round(y),1,1).data].slice(0,3);
    const luminance=(rgb:number[])=>rgb.map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;})
      .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const icon=document.querySelector('[aria-label="Close"] svg')!.getBoundingClientRect();
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
