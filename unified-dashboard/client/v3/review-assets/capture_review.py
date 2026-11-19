"""Capture the bundled review samples from a local dashboard build."""
from pathlib import Path
import subprocess
import time
import urllib.request

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[4]
OUTPUT = ROOT / ".local/card1703-review-samples"
BASE = "http://127.0.0.1:4198"


def api(route):
    path = route.request.url.split("?", 1)[0]
    if path.endswith("/api/health"):
        route.fulfill(json={"healthy": True, "ready": True, "draining": False, "build_id": "dev"})
    elif path.endswith("/api/auth/config"):
        route.fulfill(json={"authEnabled": True, "devModeEnabled": False})
    elif path.endswith("/api/auth/status"):
        route.fulfill(json={"authenticated": True, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True}})
    else:
        route.fulfill(status=404, json={"error": "review fixture"})


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen([
        "node", str(ROOT / "unified-dashboard/node_modules/vite/bin/vite.js"),
        "preview", "--host", "127.0.0.1", "--port", "4198", "--strictPort",
    ], cwd=ROOT / "unified-dashboard", stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(BASE, timeout=1):
                    break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("로컬 서버 시작 실패")
                time.sleep(.1)
        else:
            raise RuntimeError("로컬 서버 대기 시간 초과")

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(args=["--disable-gpu"])
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
            page.add_init_script("localStorage.setItem('ls.webglGlass', '0')")
            page.route("**/api/**", api)
            page.goto(BASE + "/components", wait_until="domcontentloaded")
            page.get_by_test_id("components-review").wait_for(timeout=30000)
            sample = page.get_by_test_id("manuscript-review-column")
            images = sample.locator('img[src*="pas-settings-"]')
            images.first.wait_for(state="attached", timeout=30000)
            sample.scroll_into_view_if_needed()
            page.wait_for_timeout(1000)
            box = sample.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 300)
            page.mouse.wheel(0, -1500)
            page.wait_for_timeout(1000)
            page.wait_for_function("""() => [...document.querySelectorAll('img[src*="pas-settings-"]')]
                .some(image => image.complete && image.naturalWidth > 0 && new URL(image.src).origin === location.origin)""", timeout=15000)
            page.screenshot(path=str(OUTPUT / "web-manuscript.png"), animations="disabled")
            pool = page.get_by_test_id("claude-account-review-sample").last.locator('[data-review-state="pool"]')
            pool.scroll_into_view_if_needed()
            pool.get_by_text("sample-provider-pool", exact=True).click()
            pool.get_by_role("button", name="계정 펼치기", exact=True).first.click()
            pool.get_by_text("director@example.com", exact=True).wait_for(state="visible")
            pool.get_by_text("director@example.com", exact=True).scroll_into_view_if_needed()
            page.screenshot(path=str(OUTPUT / "web-pool.png"), animations="disabled")
            print("웹 원고 이미지와 계정 풀 캡처 완료")
            app = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
            app.route("**/api/**", api)
            try:
                app.goto(BASE + "/assets/ios-components/?section=chat&sample=pas-images", wait_until="domcontentloaded")
                app.get_by_test_id("review-pas-event8309").wait_for(timeout=30000)
                app.wait_for_timeout(2000)
                app.screenshot(path=str(OUTPUT / "app-pas-images.png"), animations="disabled")
                print("앱 Expo 웹 캡처 완료")
            except Exception as error:
                print("앱 캡처 실패:", error)
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    main()
