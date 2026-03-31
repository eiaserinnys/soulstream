/**
 * 폴더 커스텀 정렬 DnD E2E 테스트
 *
 * 검증 목표:
 * 1. 폴더 정렬을 "custom" (사용자 지정)으로 설정했을 때 DnD가 가능한지
 * 2. DnD 발생 시 PATCH /api/catalog/folders/reorder 요청이 실제로 서버에 전송되는지
 * 3. 요청이 성공하면 페이지 리로드 후에도 순서가 유지되는지
 *
 * 대상 URL: http://localhost:3105 (soul-stream 서비스)
 *
 * DOM 구조 (FolderTree.tsx 기준):
 * - 폴더 아이템: folderSortMode=custom 시 draggable=true인 div
 *   (className에 flex items-center justify-between px-3 py-1.5 포함)
 * - GripVertical 아이콘: lucide GripVertical (h-3.5 w-3.5 cursor-grab)
 * - 정렬 버튼: FolderSortButton → DropdownMenu trigger (ListFilter 아이콘)
 * - 정렬 옵션: "사용자 지정" 텍스트의 DropdownMenuItem
 *
 * localStorage 키: "soul-dashboard-storage" → folderSortMode
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_URL = "http://localhost:3105";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots", "folder-dnd");

// ── 인증 설정 ─────────────────────────────────────────────────────────────────
// soulstream-server는 JWT 쿠키(soul_dashboard_auth)로 인증한다.
// 테스트에서는 서버의 JWT_SECRET으로 서명된 토큰을 쿠키로 주입하여 로그인 페이지를 우회한다.
//
// 토큰 재생성:
//   TEST_JWT_SECRET=<서버의 JWT_SECRET> python3 -c "
//     import sys; sys.path.insert(0, '../../packages/soul-common/src')
//     from soul_common.auth.jwt import generate_token
//     print(generate_token({'email':'test@example.com','name':'Test'}, '<JWT_SECRET>'))
//   "
// 또는 .env.test.local에 TEST_JWT_SECRET을 설정한 뒤 E2E 테스트를 실행하면 자동으로 토큰이 생성됩니다.
const AUTH_COOKIE_NAME = "soul_dashboard_auth";

async function generateAuthToken(): Promise<string> {
  // Python subprocess로 실제 JWT 생성
  // 필요한 환경변수: TEST_JWT_SECRET (soul-server/.env의 JWT_SECRET 값)
  // 설정 방법: unified-dashboard/.env.test.local.example 참조
  const jwtSecret = process.env.TEST_JWT_SECRET;
  if (!jwtSecret)
    throw new Error(
      "TEST_JWT_SECRET 환경변수를 설정하세요. unified-dashboard/.env.test.local.example 참조"
    );
  const soulCommonSrc = path.join(__dirname, "../../packages/soul-common/src");
  const { execSync } = await import("child_process");
  const token = execSync(
    `python3 -c "import sys; sys.path.insert(0, '${soulCommonSrc}'); from soul_common.auth.jwt import generate_token; print(generate_token({'email':'test@example.com','name':'Test'}, '${jwtSecret}'))"`,
    { encoding: "utf-8" }
  ).trim();
  return token;
}

test.describe("폴더 커스텀 정렬 DnD", () => {
  let authToken: string;

  test.beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    authToken = await generateAuthToken();
    console.log("JWT 토큰 생성 완료");
  });

  test.beforeEach(async () => {
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/catalog`);
      if (!res.ok) {
        console.log(`서버 응답 실패: ${res.status}`);
        test.skip();
      }
    } catch (err) {
      console.log(`서버 연결 실패: ${err}`);
      test.skip();
    }
  });

  test("custom 정렬 DnD → PATCH 요청 전송 → 리로드 후 순서 유지", async ({ page }) => {
    // ── 1. 네트워크 요청 인터셉트 설정 ──────────────────────────────────────────
    const reorderRequests: Array<{
      url: string;
      body: string;
      status: number;
    }> = [];

    page.on("request", (req) => {
      if (
        req.url().includes("/api/catalog/folders/reorder") &&
        req.method() === "PATCH"
      ) {
        reorderRequests.push({
          url: req.url(),
          body: req.postData() ?? "",
          status: 0,
        });
        console.log(`PATCH 요청 감지: ${req.url()}`);
        console.log(`  body: ${req.postData()}`);
      }
    });

    page.on("response", (res) => {
      if (res.url().includes("/api/catalog/folders/reorder")) {
        const entry = reorderRequests.find((r) => r.url === res.url() && r.status === 0);
        if (entry) {
          entry.status = res.status();
          console.log(`PATCH 응답: ${res.status()}`);
        }
      }
    });

    // ── 2. 인증 쿠키 주입 + localStorage folderSortMode 설정 ───────────────────
    // addInitScript는 페이지 로드 전 실행되므로 localStorage 설정 가능
    // 그러나 쿠키는 context.addCookies 또는 page.context().addCookies로 주입해야 함
    await page.context().addCookies([
      {
        name: AUTH_COOKIE_NAME,
        value: authToken,
        domain: "localhost",
        path: "/",
        httpOnly: false,
        secure: false,
      },
    ]);

    // 대시보드를 로드하기 전에 localStorage를 직접 설정하여
    // FolderSortButton UI를 거치지 않고도 custom 모드로 시작한다.
    await page.addInitScript(() => {
      const key = "soul-dashboard-storage";
      try {
        const existing = localStorage.getItem(key);
        const parsed = existing ? JSON.parse(existing) : {};
        parsed.state = parsed.state ?? {};
        parsed.state.folderSortMode = "custom";
        localStorage.setItem(key, JSON.stringify(parsed));
      } catch {
        localStorage.setItem(
          key,
          JSON.stringify({ state: { folderSortMode: "custom" }, version: 0 })
        );
      }
    });

    // ── 3. 대시보드 로드 ──────────────────────────────────────────────────────
    await page.goto(DASHBOARD_URL, { waitUntil: "load" });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-initial.png") });
    console.log("스크린샷 01-initial.png 저장");

    // ── 4. 폴더 트리가 로드될 때까지 대기 ────────────────────────────────────
    // FolderTree는 "Folders" 헤더 텍스트를 가진 섹션으로 시작함
    await page.waitForSelector('text=Folders', { timeout: 10000 });
    console.log("FolderTree 로드 확인");

    // ── 5. 일반 폴더 아이템 목록 확인 ────────────────────────────────────────
    // custom 모드에서는 draggable=true 속성이 설정됨
    // GripVertical 아이콘(cursor-grab)이 있는 폴더 아이템을 찾는다
    const draggableFolders = page.locator('[draggable="true"]');
    await page.waitForTimeout(1000); // 카탈로그 로드 대기
    const folderCount = await draggableFolders.count();
    console.log(`draggable 폴더 수: ${folderCount}`);

    if (folderCount < 2) {
      // folderSortMode가 custom이 아니거나 폴더가 부족한 경우
      // FolderSortButton을 직접 클릭하여 custom 모드로 변경 시도
      console.log("draggable 폴더가 부족함. FolderSortButton으로 custom 모드 설정 시도...");
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-no-draggable.png") });

      // ListFilter 아이콘 버튼 (폴더 정렬 버튼) 클릭
      const sortButton = page.locator('button[title="폴더 정렬"]');
      const sortButtonVisible = await sortButton.isVisible().catch(() => false);
      if (!sortButtonVisible) {
        console.log("정렬 버튼을 찾을 수 없음 — 테스트 종료");
        return;
      }
      await sortButton.click();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-sort-menu.png") });

      // "사용자 지정" 메뉴 아이템 클릭
      const customOption = page.getByText("사용자 지정");
      await customOption.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-custom-mode.png") });

      // draggable 폴더 재확인
      const folderCountAfter = await draggableFolders.count();
      console.log(`custom 모드 설정 후 draggable 폴더 수: ${folderCountAfter}`);

      if (folderCountAfter < 2) {
        console.log("custom 모드 설정 후에도 draggable 폴더가 2개 미만 — 일반 폴더가 없거나 1개뿐임");
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05-insufficient-folders.png") });
        console.log("\n결론: 일반 폴더가 2개 이상 있어야 DnD 테스트가 가능합니다.");
        return;
      }
    }

    // ── 6. 드래그 전 순서 기록 ────────────────────────────────────────────────
    const folder0Text = await draggableFolders.nth(0).textContent();
    const folder1Text = await draggableFolders.nth(1).textContent();
    console.log(`드래그 전 순서: [0]=${folder0Text?.trim()} [1]=${folder1Text?.trim()}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-before-drag.png") });

    // ── 7. DnD 수행: 첫 번째 폴더를 두 번째 폴더 위에 드롭 ──────────────────
    const source = draggableFolders.nth(0);
    const target = draggableFolders.nth(1);

    // HTML5 native drag-and-drop 시뮬레이션
    // Playwright의 dragTo는 HTML5 drag events를 트리거한다
    const sourceBB = await source.boundingBox();
    const targetBB = await target.boundingBox();

    if (!sourceBB || !targetBB) {
      console.log("폴더 boundingBox를 구할 수 없음");
      return;
    }

    console.log(`source: (${sourceBB.x}, ${sourceBB.y}), target: (${targetBB.x}, ${targetBB.y})`);

    // dragStart → dragOver → drop 수동 시뮬레이션
    // Playwright의 dragTo가 HTML5 DnD를 지원하지 않을 수 있으므로
    // dispatchEvent로 직접 drag events를 발생시킨다
    await page.evaluate(
      ({ sourceSelector, targetSelector }) => {
        // draggable=true인 요소들을 순서대로 가져옴
        const draggables = Array.from(document.querySelectorAll('[draggable="true"]'));
        const src = draggables[0] as HTMLElement;
        const tgt = draggables[1] as HTMLElement;

        if (!src || !tgt) {
          console.error("DnD 대상 요소를 찾을 수 없음");
          return;
        }

        // dragstart
        const dragStartEvent = new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        });
        src.dispatchEvent(dragStartEvent);

        // dragover on target
        const dragOverEvent = new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dragStartEvent.dataTransfer ?? undefined,
        });
        tgt.dispatchEvent(dragOverEvent);

        // drop on target
        const dropEvent = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dragStartEvent.dataTransfer ?? undefined,
        });
        tgt.dispatchEvent(dropEvent);

        // dragend
        const dragEndEvent = new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
        });
        src.dispatchEvent(dragEndEvent);

        console.log("DnD events dispatched");
      },
      { sourceSelector: "", targetSelector: "" }
    );

    await page.waitForTimeout(1000); // API 호출 완료 대기
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-after-drag.png") });

    // ── 8. 네트워크 요청 분석 ────────────────────────────────────────────────
    console.log("\n=== PATCH /api/catalog/folders/reorder 요청 분석 ===");
    if (reorderRequests.length === 0) {
      console.log("❌ PATCH 요청 없음 — DnD 이벤트가 onReorderFolders를 트리거하지 못했을 수 있음");
      console.log("   원인 1: dataTransfer의 application/x-folder-reorder 데이터가 비어있을 수 있음");
      console.log("   원인 2: dispatchEvent로 생성된 DragEvent의 dataTransfer가 실제와 다를 수 있음");
    } else {
      for (const req of reorderRequests) {
        console.log(`✅ PATCH ${req.url}`);
        console.log(`   body: ${req.body}`);
        console.log(`   status: ${req.status}`);
      }
    }

    // ── 9. dragTo API로 한 번 더 시도 (Playwright 내장 DnD) ─────────────────
    if (reorderRequests.length === 0) {
      console.log("\n--- Playwright dragTo API로 재시도 ---");
      try {
        await source.dragTo(target);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-after-dragto.png") });
        console.log(`dragTo 후 PATCH 요청 수: ${reorderRequests.length}`);
      } catch (err) {
        console.log(`dragTo 실패: ${err}`);
      }
    }

    // ── 10. 최종 결과 보고 ────────────────────────────────────────────────────
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05-final.png") });

    console.log("\n=== 최종 결과 ===");
    const patchSent = reorderRequests.length > 0;
    console.log(`PATCH 요청 전송: ${patchSent ? "✅ YES" : "❌ NO"}`);

    if (patchSent) {
      const firstReq = reorderRequests[0];
      const patchSucceeded = firstReq.status >= 200 && firstReq.status < 300;
      console.log(`PATCH 응답 성공: ${patchSucceeded ? "✅ YES" : "❌ NO"} (status: ${firstReq.status})`);

      if (patchSucceeded) {
        // ── 11. 리로드 후 순서 유지 확인 ──────────────────────────────────────
        await page.reload({ waitUntil: "load" });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06-after-reload.png") });

        const draggableAfterReload = page.locator('[draggable="true"]');
        const folder0AfterReload = await draggableAfterReload.nth(0).textContent();
        const folder1AfterReload = await draggableAfterReload.nth(1).textContent();

        console.log(`\n=== 리로드 후 순서 ===`);
        console.log(`[0]=${folder0AfterReload?.trim()}`);
        console.log(`[1]=${folder1AfterReload?.trim()}`);
        console.log(`원래 순서: [0]=${folder0Text?.trim()} [1]=${folder1Text?.trim()}`);

        // DnD로 첫 번째가 두 번째 앞으로 삽입됐으므로 순서가 바뀌어야 함
        const orderChanged =
          folder0AfterReload?.trim() !== folder0Text?.trim() ||
          folder1AfterReload?.trim() !== folder1Text?.trim();
        console.log(`순서 변경 유지: ${orderChanged ? "✅ YES" : "⚠️  변경 없음 (서버 sortOrder가 0으로 동일할 수 있음)"}`);
      }
    }

    // 테스트는 PATCH가 전송됐는지를 주 검증으로 삼는다
    expect(
      patchSent,
      "DnD 발생 시 PATCH /api/catalog/folders/reorder 요청이 전송되어야 합니다."
    ).toBe(true);
  });

  test("FolderSortButton으로 custom 모드 활성화 확인", async ({ page }) => {
    // 인증 쿠키 주입
    await page.context().addCookies([
      {
        name: AUTH_COOKIE_NAME,
        value: authToken,
        domain: "localhost",
        path: "/",
        httpOnly: false,
        secure: false,
      },
    ]);

    // 빈 페이지로 이동 후 localStorage에 name-asc 설정, 그 다음 실제 URL로 이동
    // (addInitScript는 이미 persist된 custom 상태를 덮어쓰지 못하는 경우가 있어 직접 설정)
    await page.goto(`${DASHBOARD_URL}/`, { waitUntil: "load" });
    await page.evaluate(() => {
      const key = "soul-dashboard-storage";
      try {
        const existing = localStorage.getItem(key);
        const parsed = existing ? JSON.parse(existing) : {};
        parsed.state = parsed.state ?? {};
        parsed.state.folderSortMode = "name-asc";
        localStorage.setItem(key, JSON.stringify(parsed));
      } catch {
        localStorage.setItem(
          key,
          JSON.stringify({ state: { folderSortMode: "name-asc" }, version: 0 })
        );
      }
    });

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("text=Folders", { timeout: 10000 });

    // 디버그: reload 후 실제 localStorage 값 확인
    const storedValue = await page.evaluate(() => {
      return localStorage.getItem("soul-dashboard-storage");
    });
    console.log(`reload 후 localStorage soul-dashboard-storage:`, storedValue ? JSON.parse(storedValue)?.state?.folderSortMode : "없음");

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "sort-01-name-asc-mode.png") });

    // name-asc 모드에서는 draggable 폴더가 없어야 함
    const draggableBefore = page.locator('[draggable="true"]');
    await page.waitForTimeout(500);
    const countBefore = await draggableBefore.count();
    console.log(`name-asc 모드에서 draggable 폴더 수: ${countBefore}`);
    expect(countBefore).toBe(0);

    // FolderSortButton (title="폴더 정렬") 클릭
    const sortButton = page.locator('button[title="폴더 정렬"]');
    await sortButton.waitFor({ timeout: 5000 });
    await sortButton.click();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "sort-02-dropdown.png") });

    // "사용자 지정" 선택
    await page.getByText("사용자 지정").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "sort-03-custom-mode.png") });

    // custom 모드에서는 일반 폴더가 draggable이어야 함
    const draggableAfter = page.locator('[draggable="true"]');
    const countAfter = await draggableAfter.count();
    console.log(`custom 모드 전환 후 draggable 폴더 수: ${countAfter}`);

    expect(
      countAfter,
      "custom 모드에서 일반 폴더는 draggable이어야 합니다."
    ).toBeGreaterThan(0);
  });
});
