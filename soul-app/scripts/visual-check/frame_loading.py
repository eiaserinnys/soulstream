#!/usr/bin/env python3
"""Frame loading placement check (RN web component review bundle).

1. Export the review bundle once from the soul-app directory:
       npm run export:components
   The bundle is written to unified-dashboard/dist/assets/ios-components.
2. Serve the dist root (not the bundle directory) with any static server:
       python3 -m http.server 4173 --directory unified-dashboard/dist
3. Run this script with the bundle URL and an output directory:
       python3 -P soul-app/scripts/visual-check/frame_loading.py \
           http://127.0.0.1:4173/assets/ios-components/index.html ./evidence/frame-loading

The script opens the public-fixture review page (?section=frameLoading) and
walks every first-loading sample. For frame-filling samples it checks that the
loader box centre and the spinner/text cluster centre both sit on the owning
frame centre within 1px on both axes, and that no corner auto-refresh marker
shows. A sample whose frame cannot be found fails instead of being compared
with itself. For content-height boxes (settings section, folder cards list
body) it measures the gap from the box border to the cluster above and below
and the horizontal centre of the box against the cluster. Captures are taken
at iPad landscape (1180x820) and narrow (390x844).
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


VIEWPORTS = [(1180, 820), (390, 844)]
CENTRE_TOLERANCE_PX = 1.0

SAMPLES = [
    {"mode": "frame", "name": "frame", "loader": "frame-loading-sample-loader", "frame": "frame-loading-sample", "kind": "center", "text": "불러오는 중…"},
    {"mode": "frameBare", "name": "frame-bare", "loader": "frame-loading-sample-loader", "frame": "frame-loading-sample", "kind": "center", "text": ""},
    {"mode": "settings", "name": "settings", "loader": "frame-loading-settings-loader", "kind": "inline", "box": "parent", "text": "불러오는 중…"},
    {"mode": "board", "name": "board", "loader": "card-board-loading", "frame": "card-board-frame", "kind": "center"},
    {"mode": "boardExpanded", "name": "board-expanded", "loader": "card-board-loading", "scope": "card-board-expanded", "frame": "card-board-frame", "kind": "center"},
    {"mode": "daily", "name": "daily", "loader": "daily-loading", "frame": "daily-keyboard-frame", "kind": "center"},
    {"mode": "starred", "name": "starred", "loader": "starred-loading", "frame": "starred-refresh-frame", "kind": "center"},
    {"mode": "folderCards", "name": "folder-cards", "loader": "folder-cards-loading", "kind": "inline", "box": "folder-cards-list-box"},
    {"mode": "feed", "name": "feed", "loader": "session-feed-loading", "frame": None, "kind": "center", "text": "세션을 불러오는 중입니다."},
    {"mode": "cardDetail", "name": "card-detail", "loader": "card-detail-loading", "frame": "card-detail-scroll", "kind": "center"},
]

METRICS_SCRIPT = r"""
({ loaderId, frameId, scopeId, boxId }) => {
  const round = (value) => Math.round(value * 100) / 100;
  const rect = (element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: round(bounds.left), top: round(bounds.top),
      right: round(bounds.right), bottom: round(bounds.bottom),
      width: round(bounds.width), height: round(bounds.height),
      centerX: round(bounds.left + bounds.width / 2),
      centerY: round(bounds.top + bounds.height / 2),
    };
  };
  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const find = (selector, from) => {
    try { return (from || document).querySelector(selector); } catch { return null; }
  };
  const scope = scopeId ? document.querySelector(`[data-testid="${scopeId}"]`) : document;
  let loaders = [...(scope || document).querySelectorAll(`[data-testid="${loaderId}"]`)].filter(visible);
  if (loaders.length === 0) loaders = [...document.querySelectorAll(`[data-testid="${loaderId}"]`)].filter(visible);
  const loader = loaders[loaders.length - 1];
  if (!loader) return { missing: true };
  const clusterChildren = [...loader.children].filter(visible).map(rect);
  const union = clusterChildren.length === 0 ? rect(loader) : {
    left: Math.min(...clusterChildren.map((item) => item.left)),
    top: Math.min(...clusterChildren.map((item) => item.top)),
    right: Math.max(...clusterChildren.map((item) => item.right)),
    bottom: Math.max(...clusterChildren.map((item) => item.bottom)),
  };
  union.centerX = round((union.left + union.right) / 2);
  union.centerY = round((union.top + union.bottom) / 2);
  union.width = round(union.right - union.left);
  union.height = round(union.bottom - union.top);

  let box = null;
  if (boxId === 'parent') {
    box = loader.parentElement;
  } else if (boxId) {
    box = find(`[data-testid="${boxId}"]`, scope) || find(`[data-testid="${boxId}"]`);
  }

  let frame = null;
  if (frameId) {
    frame = loader.closest(`[data-testid="${frameId}"]`)
      || find(`[data-testid="${frameId}"]`, scope)
      || find(`[data-testid="${frameId}"]`);
  } else if (frameId === null) {
    let parent = loader.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.clientHeight > 0) {
        frame = parent;
        break;
      }
      parent = parent.parentElement;
    }
  }

  const style = getComputedStyle(loader);
  return {
    role: loader.getAttribute('role'),
    text: loader.innerText || '',
    loader: rect(loader),
    cluster: union,
    box: box ? rect(box) : null,
    frame: frame ? rect(frame) : null,
    frameTestId: frame ? frame.getAttribute('data-testid') : null,
    paddingTop: parseFloat(style.paddingTop) || 0,
    paddingBottom: parseFloat(style.paddingBottom) || 0,
    cornerMarkers: document.querySelectorAll('[aria-label="자동 갱신 중"]').length,
  };
}
"""


def build_url(base: str) -> str:
    parts = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["section"] = ["frameLoading"]
    query["theme"] = ["light"]
    return urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, parts.path,
        urllib.parse.urlencode(query, doseq=True), parts.fragment,
    ))


def failures_for(sample: dict, metrics: dict, label: str) -> list[dict]:
    failures: list[dict] = []
    if metrics.get("missing"):
        return [{"check": "missing loader", "label": label, "testID": sample["loader"]}]
    if metrics.get("role") != "progressbar":
        failures.append({"check": "role", "label": label, "actual": metrics.get("role")})
    if metrics.get("cornerMarkers"):
        failures.append({"check": "corner marker during first load", "label": label,
                         "actual": metrics["cornerMarkers"]})
    expected_text = sample.get("text")
    if expected_text is not None:
        actual_text = metrics.get("text", "").strip()
        if expected_text and expected_text not in actual_text:
            failures.append({"check": "text", "label": label, "expected": expected_text,
                             "actual": metrics.get("text")})
        if expected_text == "" and actual_text:
            failures.append({"check": "text should be empty", "label": label,
                             "actual": metrics.get("text")})
    if sample["kind"] == "inline":
        box, cluster = metrics.get("box"), metrics["cluster"]
        if not box:
            failures.append({"check": "missing box", "label": label,
                             "box": sample.get("box")})
            return failures
        top_gap = round(cluster["top"] - box["top"], 2)
        bottom_gap = round(box["bottom"] - cluster["bottom"], 2)
        if abs(top_gap - bottom_gap) > CENTRE_TOLERANCE_PX:
            failures.append({"check": "inline vertical balance", "label": label,
                             "topGap": top_gap, "bottomGap": bottom_gap})
        delta = abs(cluster["centerX"] - box["centerX"])
        if delta > CENTRE_TOLERANCE_PX:
            failures.append({"check": "inline horizontal centre", "label": label, "delta": round(delta, 2)})
        return failures
    if not metrics.get("frame"):
        failures.append({"check": "missing frame", "label": label, "frame": sample.get("frame")})
        return failures
    for axis in ("centerX", "centerY"):
        delta = abs(metrics["loader"][axis] - metrics["frame"][axis])
        if delta > CENTRE_TOLERANCE_PX:
            failures.append({"check": f"loader {axis} vs frame", "label": label,
                             "delta": round(delta, 2), "loader": metrics["loader"][axis],
                             "frame": metrics["frame"][axis]})
    for axis in ("centerX", "centerY"):
        delta = abs(metrics["cluster"][axis] - metrics["frame"][axis])
        if delta > CENTRE_TOLERANCE_PX:
            failures.append({"check": f"cluster {axis} vs frame", "label": label,
                             "delta": round(delta, 2), "cluster": metrics["cluster"][axis],
                             "frame": metrics["frame"][axis]})
    return failures


def open_sample(page: Page, sample: dict) -> None:
    page.get_by_test_id(f"settings-segment-frame-loading-mode-{sample['mode']}").click(force=True)
    if sample.get("scope"):
        try:
            page.get_by_test_id(sample["scope"]).wait_for(state="visible", timeout=3000)
        except Exception:
            expand = page.get_by_label("보드 확대")
            if expand.count():
                expand.first.click(force=True)
            page.get_by_test_id(sample["scope"]).wait_for(state="visible")
    page.get_by_test_id(sample["loader"]).first.wait_for(state="visible")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(350)


def main() -> int:
    parser = argparse.ArgumentParser(description="Frame loading placement check")
    parser.add_argument("base_url", help="review bundle URL, e.g. http://127.0.0.1:4173/assets/ios-components/index.html")
    parser.add_argument("output", help="directory for captures and metrics JSON")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "baseUrl": args.base_url,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": False,
        "tolerancePx": CENTRE_TOLERANCE_PX,
        "viewports": [],
        "failures": [],
        "pageErrors": [],
    }
    failures: list[dict] = result["failures"]
    base_netloc = urllib.parse.urlsplit(args.base_url).netloc

    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        if request_url.path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
        elif request_url.netloc == base_netloc or route.request.url.startswith(("data:", "blob:")):
            route.continue_()
        else:
            route.abort()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    color_scheme="light",
                    device_scale_factor=1,
                )
                page = context.new_page()
                page.set_default_timeout(20000)
                page.on("pageerror", lambda error, label=f"{width}": result["pageErrors"].append(f"{label}: {error}"))
                context.route("**/*", route_request)
                page.goto(build_url(args.base_url), wait_until="networkidle")
                page.get_by_test_id("review-frame-loading").wait_for(state="visible")
                viewport_result = {"width": width, "height": height, "samples": []}
                for sample in SAMPLES:
                    label = f"{sample['name']}-{width}"
                    print(f"sample {label}", flush=True)
                    try:
                        # A fresh page per sample keeps the expanded board modal from
                        # intercepting the mode control and isolates store priming.
                        page.goto(build_url(args.base_url), wait_until="networkidle")
                        page.get_by_test_id("review-frame-loading").wait_for(state="visible")
                        open_sample(page, sample)
                    except Exception as error:  # keep capturing the remaining samples
                        failures.append({"check": "open sample", "label": label, "error": str(error).splitlines()[0]})
                        page.screenshot(path=str(output / f"frame-loading-{sample['name']}-{width}-error.png"))
                        continue
                    metrics = page.evaluate(METRICS_SCRIPT, {
                        "loaderId": sample["loader"],
                        "frameId": sample.get("frame"),
                        "scopeId": sample.get("scope"),
                        "boxId": sample.get("box"),
                    })
                    sample_failures = failures_for(sample, metrics, label)
                    failures.extend(sample_failures)
                    page.screenshot(path=str(output / f"frame-loading-{sample['name']}-{width}.png"))
                    frame_id = metrics.get("frameTestId")
                    if frame_id:
                        frame = page.get_by_test_id(frame_id).last
                        if frame.count():
                            frame.screenshot(path=str(output / f"frame-loading-{sample['name']}-{width}-frame.png"))
                    viewport_result["samples"].append({
                        "mode": sample["mode"],
                        "name": sample["name"],
                        "kind": sample["kind"],
                        "metrics": metrics,
                        "failures": sample_failures,
                    })
                result["viewports"].append(viewport_result)
                context.close()
        finally:
            browser.close()

    result["passed"] = not failures and not result["pageErrors"]
    (output / "frame-loading.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    for failure in failures:
        print(json.dumps(failure, ensure_ascii=False))
    print(f"frame loading check: {'PASS' if result['passed'] else 'FAIL'} "
          f"({len(failures)} failures, {len(result['pageErrors'])} page errors)")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
