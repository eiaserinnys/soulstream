"""soul-desktop 첫 설정과 설정 화면 캡처 (카드 #1901 단위 7).

vite로 soul-desktop 화면을 띄우고 tauri API(`window.__TAURI_INTERNALS__.invoke`)를 대역으로 바꿔
Playwright로 찍는다. 장면마다 기대 문구와 가로 넘침 결과를 json으로 남긴다.

사용: python3 capture_setup.py --root <soul-desktop 폴더> --out <출력 폴더> --label before|after
"""

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

SERVER = "http://127.0.0.1:4105"
HINT = "http:// 나 https:// 를 붙여 적습니다. 빼면 https:// 로 연결합니다."
WIDTHS = [(1280, 800), (800, 600)]

STUB = """
(() => {
  const scene = window.__SCENE__ || {};
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (cmd, args) => {
      window.__calls.push(cmd);
      switch (cmd) {
        case 'plugin:store|load': return 1;
        case 'plugin:store|get': return [scene.saved ?? null, scene.saved != null];
        case 'plugin:updater|check': return null;
        case 'plugin:app|version': return '0.2.5';
        case 'check_server': return scene.check ?? { kind: 'ok' };
        default: return null;
      }
    },
  };
})();
"""

SCENES = [
    {"id": "a", "title": "빈 Setup", "path": "/", "expect_after": [HINT, "서버 URL"]},
    {"id": "b", "title": "http 주소 입력", "path": "/", "type": SERVER, "expect_after": [HINT]},
    {
        "id": "c",
        "title": "http_status 404 문구",
        "path": "/",
        "type": SERVER,
        "check": {"kind": "http_status", "status": 404},
        "submit": True,
        "expect_after": [f"{SERVER} 가 404 로 응답했습니다. 소울스트림 서버 주소인지 확인하세요."],
    },
    {
        "id": "d",
        "title": "not_soulstream 문구",
        "path": "/",
        "type": SERVER,
        "check": {"kind": "not_soulstream"},
        "submit": True,
        "expect_after": [f"{SERVER} 는 소울스트림 서버가 아닙니다. 주소를 확인하세요."],
    },
    {
        "id": "e",
        "title": "view=settings 로 연 Settings",
        "path": "/?view=settings",
        "saved": SERVER,
        "expect_after": ["설정", "연결", SERVER, "0.2.5"],
        "stay_on_bundled": True,
    },
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_http(url: str, timeout: float = 30) -> None:
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"vite did not start: {url}")


def run_scene(browser, base: str, scene: dict, width: int, height: int, out: Path, label: str) -> dict:
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    scene_config = {k: scene[k] for k in ("saved", "check") if k in scene}
    page.add_init_script(f"window.__SCENE__ = {json.dumps(scene_config)};\n{STUB}")
    # 전 화면(no-cors fetch)과 이동 대상 서버 대역: 404 응답
    page.route(f"{SERVER}/**", lambda route: route.fulfill(status=404, content_type="text/html", body="<h1>server stand-in</h1>"))
    page.goto(base + scene["path"])
    page.wait_for_selector("body *")
    page.wait_for_timeout(500)
    if "type" in scene:
        page.fill("#server-url", scene["type"])
        if scene.get("submit"):
            page.click("button[type=submit]")
            page.wait_for_timeout(1200)
    page.wait_for_timeout(800)
    text = page.inner_text("body")
    html = page.content()
    metrics = page.evaluate(
        "() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})"
    )
    still_bundled = page.url.startswith(base)
    placeholder = page.get_attribute("#server-url", "placeholder") if page.query_selector("#server-url") else None
    file = out / f"{label}-{scene['id']}-{width}.png"
    page.screenshot(path=str(file))
    expectations = {phrase: phrase in text for phrase in scene["expect_after"]}
    result = {
        "scene": scene["id"],
        "title": scene["title"],
        "width": width,
        "height": height,
        "screenshot": file.name,
        "expected_text": expectations,
        "all_expected_found": all(expectations.values()),
        "overflow_x": metrics["scrollWidth"] > metrics["clientWidth"],
        "scrollWidth": metrics["scrollWidth"],
        "clientWidth": metrics["clientWidth"],
        "stayed_on_bundled_page": still_bundled,
        "placeholder": placeholder,
        "has_https_badge": ">https://</span>" in html,
        "tauri_calls": page.evaluate("() => window.__calls") if still_bundled else None,
        "final_url": page.url,
    }
    context.close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--label", required=True, choices=["before", "after"])
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    port = free_port()
    vite = args.root / "node_modules" / ".bin" / "vite"
    proc = subprocess.Popen(
        [str(vite), "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=args.root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    results = []
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for_http(base)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for scene in SCENES:
                for width, height in WIDTHS:
                    results.append(run_scene(browser, base, scene, width, height, args.out, args.label))
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    (args.out / f"{args.label}-scenes.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for r in results:
        print(r["scene"], r["width"], "found" if r["all_expected_found"] else "MISSING", "overflow" if r["overflow_x"] else "no-overflow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
