// 카드 #1735 화면 검수 반려(세라피엘 1차) 재현·판정.
// - 390 /dialogues?sample=session-sheet|v3-sheet 와 1440·390 폴더 완료 알림에서
//   틀과 .glass, 테두리 빛의 네 모서리 계산 곡률이 같은지 단언한다.
// - 1440 폴더 화면에서 세션 카드와 하위 폴더 행 왼쪽 위 모서리를 WebGL 켬/끔으로 찍어
//   처음 채워지는 화소까지 거리가 1px 안으로 같은지 본다.
// 실행: corepack pnpm --dir unified-dashboard exec playwright test --config e2e/radius-glass.config.ts
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import { prepare } from "./glass-review-helpers";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.RADIUS_REVIEW_OUT ?? path.resolve(REPO_ROOT, ".local/card1735/after2");
mkdirSync(OUT, { recursive: true });

type Corners = number[];
interface RadiusReport {
  rect: number[];
  frame: Corners;
  glass: Corners | null;
  rims: Corners[];
}

async function readRadii(locator: Locator): Promise<RadiusReport> {
  return locator.evaluate((el) => {
    const corners = (node: Element) => {
      const s = getComputedStyle(node);
      return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]
        .map((value) => Math.round(Number.parseFloat(value) * 100) / 100);
    };
    const glass = el.querySelector(".liquid-glass-card__layer .glass");
    const rims = [...el.querySelectorAll(".liquid-glass-card__layer > span")];
    const rect = el.getBoundingClientRect();
    return {
      rect: [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 100) / 100),
      frame: corners(el),
      glass: glass ? corners(glass) : null,
      rims: rims.map(corners),
    };
  });
}

function expectSameCorners(name: string, report: RadiusReport) {
  expect(report.glass, `${name}: 유리층(.glass)이 없습니다`).not.toBeNull();
  expect(report.rims.length, `${name}: 테두리 빛 span이 없습니다`).toBeGreaterThanOrEqual(2);
  for (const [index, target] of [report.glass!, ...report.rims].entries()) {
    for (let corner = 0; corner < 4; corner++) {
      expect(
        Math.abs(target[corner] - report.frame[corner]),
        `${name}: ${index === 0 ? ".glass" : `테두리 빛 ${index}`} ${["TL", "TR", "BR", "BL"][corner]} 곡률 ${target[corner]} ≠ 틀 ${report.frame[corner]}`,
      ).toBeLessThanOrEqual(0.5);
    }
  }
}

async function mountAlertSample(page: Page) {
  const sourcePath = path.join(REPO_ROOT, "packages/soul-ui/src/folder-status/FolderCompletionAction.tsx");
  await page.evaluate(async (source) => {
    const main = await (await fetch("/client/main.tsx")).text();
    const reactPath = main.match(/"(\/.vite-cache\/deps\/react\.js\?[^"]+)"/)?.[1];
    const domPath = main.match(/"(\/.vite-cache\/deps\/react-dom_client\.js\?[^"]+)"/)?.[1];
    if (!reactPath || !domPath) throw new Error("React 검수 모듈을 찾지 못했습니다.");
    const React = (await import(/* @vite-ignore */ reactPath)).default;
    const dom = await import(/* @vite-ignore */ domPath);
    const { FolderCompletionAction } = await import(/* @vite-ignore */ `/@fs${source}`);
    const host = document.createElement("div");
    document.body.appendChild(host);
    dom.default.createRoot(host).render(React.createElement(FolderCompletionAction, {
      task: { id: "qa-folder", title: "운영 점검 폴더", status: "open", version: 1 },
    }));
  }, sourcePath);
}

async function openFolderView(page: Page) {
  // /v3 CardHome → 전체 프로젝트의 소울스트림(folder-amber) 행 → 폴더 화면.
  // 루트(/) 첫 화면은 카탈로그 로딩이 느린 날 폴더 목록이 비어 진입하지 못하므로
  // 다른 v3 시각 QA와 같은 /v3 진입을 쓴다. 공유 호스트 부하로 첫 카탈로그 요청이
  // 끊기면 다시 열어 본다.
  await page.route("**/api/cards?**", (r) => r.fulfill({ json: { cards: [] } }));
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto("/v3", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("card-home")).toBeVisible({ timeout: 90_000 });
    const projectRow = page.getByTestId("v3-project-row-folder-amber");
    try {
      // 공유 호스트 부하가 크면 카탈로그 응답 뒤 첫 렌더가 30초를 넘긴다(261120 실측).
      await expect(projectRow).toBeAttached({ timeout: 90_000 });
    } catch (error) {
      if (attempt === 2) throw error;
      continue;
    }
    await projectRow.locator(".v3-project-nav-link").click();
    await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("[data-task-section=sessions] .v3-run-row").first()).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(1000);
    return;
  }
}

interface PngImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function decodePng(buffer: Buffer): PngImage {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`지원하지 않는 PNG 형식: depth=${bitDepth} color=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value = (value + a) & 255;
      else if (filter === 2) value = (value + b) & 255;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) {
        throw new Error(`지원하지 않는 PNG 필터: ${filter}`);
      }
      cur[x] = value;
    }
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      out[offset] = cur[x * channels];
      out[offset + 1] = cur[x * channels + 1];
      out[offset + 2] = cur[x * channels + 2];
      out[offset + 3] = channels === 4 ? cur[x * channels + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/**
 * 왼쪽 위 모서리에서 45도 대각선으로 내려가며 연속 화소 변화가 가장 큰 지점의 절반을
 * 넘는 첫 변화를 "유리가 처음 채워지는 곳"으로 본다. 모서리에서 멀어질수록 값이 커지므로
 * 같은 요소의 켬/끔 거리를 비교하면 유리 곡률이 틀 곡률을 따르는지 판정할 수 있다.
 */
function firstFilledDiagonal(
  image: PngImage,
  x: number,
  y: number,
  step = 1,
): { distance: number; deltas: number[]; threshold: number; max: number } {
  const deltas: number[] = [];
  let previous: [number, number, number] | null = null;
  for (let distance = 0; distance <= 40; distance++) {
    const px = Math.round(x + distance * step);
    const py = Math.round(y + distance * step);
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) break;
    const offset = (py * image.width + px) * 4;
    const rgb: [number, number, number] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    if (previous) {
      const delta = Math.abs(rgb[0] - previous[0]) + Math.abs(rgb[1] - previous[1]) + Math.abs(rgb[2] - previous[2]);
      deltas.push(delta);
    }
    previous = rgb;
  }
  const max = deltas.length > 0 ? Math.max(...deltas) : 0;
  if (max < 6) return { distance: -1, deltas, threshold: 0, max };
  const threshold = Math.max(4, max * 0.5);
  const index = deltas.findIndex((delta) => delta >= threshold);
  return { distance: index < 0 ? -1 : index + 1, deltas, threshold, max };
}

async function measureCorner(page: Page, locator: Locator, tag: string) {
  // 화면 밖 요소를 찍으면 클립이 빈 그림이 되므로 먼저 화면 안으로 스크롤한다.
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await locator.boundingBox();
  expect(box, `${tag}: 요소 상자가 없습니다`).not.toBeNull();
  expect(box!.y + box!.height, `${tag}: 요소가 화면 아래로 벗어났습니다`).toBeLessThanOrEqual(page.viewportSize()!.height);
  const clip = {
    x: Math.max(0, Math.floor(box!.x) - 10),
    y: Math.max(0, Math.floor(box!.y) - 10),
    width: 80,
    height: 80,
  };
  const shot = await page.screenshot({ clip });
  writeFileSync(path.join(OUT, `${tag}.png`), shot);
  const png = decodePng(shot);
  const result = firstFilledDiagonal(png, box!.x - clip.x, box!.y - clip.y);
  writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify({ box, clip, ...result }, null, 1));
  return result.distance;
}

/**
 * WebGL 캔버스에서 카드 왼쪽 위 모서리 화소를 직접 읽는다. 화면 캡처는 위에 겹친 DOM
 * 반투명 배경이 유리 가장자리를 흐리지만, 캔버스 화소에는 유리가 그린 곡선이 그대로 남는다.
 * 캔버스는 preserveDrawingBuffer 없이 매 프레임 다시 그리므로, 렌더러의 다음 rAF 뒤에 읽는다.
 */
async function measureCanvasCorner(page: Page, locator: Locator, tag: string) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const region = await locator.evaluate(async (element) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.liquid-glass-webgl-canvas");
    if (!canvas) throw new Error("WebGL 유리 캔버스가 없습니다");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 컨텍스트를 얻지 못했습니다");
    const rect = element.getBoundingClientRect();
    const dpr = canvas.width / window.innerWidth;
    const cssSize = 64;
    const left = rect.x * dpr;
    const top = rect.y * dpr;
    const x0 = Math.floor(left);
    const y0 = Math.floor(top);
    const width = Math.ceil(cssSize * dpr) + 2;
    const height = width;
    const glY = canvas.height - y0 - height;
    const buffer = new Uint8Array(width * height * 4);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      gl.readPixels(x0, glY, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      resolve();
    }));
    return {
      dpr,
      offsetX: left - x0,
      offsetY: top - y0,
      width,
      height,
      rgba: Array.from(buffer),
    };
  });
  // readPixels는 아래에서 위로 읽으므로 위아래를 뒤집어 PNG로 남긴다.
  const rgba = new Uint8Array(region.rgba);
  const rowBytes = region.width * 4;
  const flipped = new Uint8Array(rgba.length);
  for (let row = 0; row < region.height; row++) {
    flipped.set(rgba.subarray((region.height - 1 - row) * rowBytes, (region.height - row) * rowBytes), row * rowBytes);
  }
  writeFileSync(path.join(OUT, `${tag}.png`), encodePng(region.width, region.height, flipped));
  const image: PngImage = { width: region.width, height: region.height, data: flipped };
  const result = firstFilledDiagonal(image, region.offsetX, region.offsetY, region.dpr);
  writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify({ dpr: region.dpr, ...result }, null, 1));
  return result.distance;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * width * 4, width * 4).copy(raw, row * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const width of [1440, 390]) {
  for (const webgl of [false, true]) {
    test(`폴더 완료 알림 ${width} webgl=${webgl ? 1 : 0}`, async ({ page }) => {
      test.setTimeout(120_000);
      await prepare(page, width, webgl, { unifiedFolderView: true });
      await page.goto("/components");
      await expect(page.getByTestId("components-review")).toBeVisible({ timeout: 30_000 });
      await mountAlertSample(page);
      await page.getByRole("button", { name: "폴더 완료", exact: true }).last().click();
      const alert = page.locator('[data-slot="alert-dialog-popup"]:visible');
      await expect(alert).toBeVisible();
      await page.waitForTimeout(800);
      const report = await readRadii(alert);
      writeFileSync(path.join(OUT, `alert-${width}-webgl${webgl ? 1 : 0}-radii.json`), JSON.stringify(report, null, 1));
      expectSameCorners(`알림 대화상자 ${width}`, report);
      await page.screenshot({ path: path.join(OUT, `alert-${width}-webgl${webgl ? 1 : 0}.png`), animations: "disabled" });
    });
  }
}

for (const id of ["session-sheet", "v3-sheet"]) {
  for (const webgl of [false, true]) {
    test(`시트 ${id} 390 webgl=${webgl ? 1 : 0}`, async ({ page }) => {
      test.setTimeout(120_000);
      await prepare(page, 390, webgl);
      await page.route("**/api/ui-events/config", (r) => r.fulfill({ json: { enabled: false, flushIntervalMs: 1000, maxBatchSize: 1, maxQueueSize: 500, schemaVersion: "soulstream.ui_event.v1" } }));
      await page.goto(`/dialogues?sample=${id}`);
      await page.waitForTimeout(1800);
      const sheet = page.locator('[data-slot="dialog-popup"]:visible');
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      const report = await readRadii(sheet);
      writeFileSync(path.join(OUT, `sheet-${id}-390-webgl${webgl ? 1 : 0}-radii.json`), JSON.stringify(report, null, 1));
      expectSameCorners(`시트 ${id} 390`, report);
      if (id !== "v3-sheet") {
        await page.screenshot({ path: path.join(OUT, `${id}-390-webgl${webgl ? 1 : 0}.png`), animations: "disabled" });
      }
    });
  }
}

test("WebGL 유리 곡률이 틀 곡률을 따른다 (1440 폴더 화면)", async ({ page }) => {
  test.setTimeout(540_000);
  const distances: Record<string, number> = {};
  await prepare(page, 1440, false, { unifiedFolderView: true, timelineEventCount: 1 });
  await openFolderView(page);
  // 오른쪽 세션 패널의 세션 카드와 가운데 아래 하위 폴더 행. 둘 다 12px 틀이다.
  const sessionCard = page.locator('[data-testid^="v3-session-row-"] .v3-run-row').first();
  const subfolderRow = page.locator('[data-testid^="v3-child-folder-"] .v3-run-row').first();
  await expect(sessionCard).toBeVisible({ timeout: 90_000 });
  const sessionRadius = await sessionCard.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  // 하위 폴더 행은 폴더별 페이지를 늦게 불러와 첫 화면에 없을 수 있다(공유 호스트 부하에서 실측).
  await expect(subfolderRow).toBeVisible({ timeout: 120_000 });
  const subfolderRadius = await subfolderRow.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  writeFileSync(path.join(OUT, "folder-1440-targets.json"), JSON.stringify({ sessionRadius, subfolderRadius }, null, 1));

  // 끔: 틀의 1px 테두리만 남겨 "틀 곡선"을 잰다. CSS 유리층과 카드 배경은 숨긴다.
  const isolation = `
      .liquid-glass-card { background: transparent !important; box-shadow: none !important; }
      .liquid-glass-card::before, .liquid-glass-card::after { display: none !important; }
      .liquid-glass-card__layer { display: none !important; }
      .liquid-glass-card > :not(.liquid-glass-card__layer) { visibility: hidden !important; }
    `;
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "folder-1440-webgl0.png"), animations: "disabled" });
  const style = await page.addStyleTag({ content: isolation });
  await page.waitForTimeout(400);
  distances["session-off"] = await measureCorner(page, sessionCard, "corner-session-off");
  distances["subfolder-off"] = await measureCorner(page, subfolderRow, "corner-subfolder-off");
  await style.evaluate((node) => node.parentNode?.removeChild(node));

  // 켬: 같은 화면에서 WebGL만 켜고, 캔버스가 그린 유리 곡선을 화소로 직접 읽는다.
  await page.evaluate(() => {
    localStorage.setItem("ls.webglGlass", "1");
    window.dispatchEvent(new Event("ls.webglGlass:change"));
  });
  await expect(page.locator("[data-liquid-glass-webgl-provider=true]")).toHaveCount(1, { timeout: 60_000 });
  await page.waitForTimeout(2000);
  distances["session-on"] = await measureCanvasCorner(page, sessionCard, "canvas-session-on");
  distances["subfolder-on"] = await measureCanvasCorner(page, subfolderRow, "canvas-subfolder-on");
  await page.screenshot({ path: path.join(OUT, "folder-1440-webgl1.png"), animations: "disabled" });
  writeFileSync(path.join(OUT, "corner-distances.json"), JSON.stringify(distances, null, 1));
  for (const target of ["session", "subfolder"]) {
    const off = distances[`${target}-off`];
    const on = distances[`${target}-on`];
    expect(off, `${target}: WebGL 끔에서 처음 채워지는 화소를 찾지 못했습니다`).toBeGreaterThanOrEqual(0);
    expect(on, `${target}: WebGL 켬에서 처음 채워지는 화소를 찾지 못했습니다`).toBeGreaterThanOrEqual(0);
    expect(Math.abs(on - off), `${target}: WebGL 켬 ${on}px vs 끔 ${off}px`).toBeLessThanOrEqual(1);
  }
});
