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
with itself. Settings keeps the content-height check: the gap from the box
border to the cluster above and below and the horizontal centre.

The daily sample uses the empty area between the date row bottom and the
composer dock top as its frame: the loader must fill that area and its centre
must sit on the area midpoint. The starred sample fails if the empty glass
sheet (`starred-task-sheet`) is drawn during the first load. Folder cards
compares only the horizontal centre against the `folder-cards` section and
records the header-to-loader top gap as a value: the inline loader is the
whole visible body below the header, so there is no separate bordered box to
balance against vertically. Captures are taken at iPad landscape (1180x820)
and narrow (390x844).

The completed lane checks (card #1692) use the auto refresh review page:
?completedError fails the first completed read once, ?completedError=refresh
fails the first refresh after a load once. At the 1180 inline board (sized to
the three-pane card pane), the 1180 expanded board and the 390 inline board the
first failure must show the error and a content-width 「다시 시도」 button inside
the done lane (button height at least the chip hit target, i.e. hitTarget.min);
pressing it (keyboard Enter) must remove both and draw a card. While a read is
held the button stays, is aria-busy and keeps keyboard focus. A start date after the end date
shows the range notice without the button. A failed refresh keeps the lane count
and first card. The four period chips must form one row of four or two rows of
two with equal widths per row (1px), matching row edges, unclipped labels and
the chip group inside the lane, at those boards plus the wide 1180 inline lane
and the 951x669 duo expanded board. test_frame_loading_completed.py plants
violations against these judges.

Over 500 lines on purpose: the script runs as `python3 -P <path>`, which keeps
its folder off sys.path, so it cannot import sibling modules. The pure judges
(failures_for, check_*_metrics, check_period_chips, check_completed_error, ...)
are covered by test_frame_loading_*.py.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


VIEWPORTS = [(1180, 820), (390, 844), (360, 800)]
CENTRE_TOLERANCE_PX = 1.0

SAMPLES = [
    {"mode": "frame", "name": "frame", "loader": "frame-loading-sample-loader", "frame": "frame-loading-sample", "kind": "center", "text": "불러오는 중…"},
    {"mode": "frameBare", "name": "frame-bare", "loader": "frame-loading-sample-loader", "frame": "frame-loading-sample", "kind": "center", "text": ""},
    {"mode": "settings", "name": "settings", "loader": "frame-loading-settings-loader", "kind": "inline", "box": "parent", "text": "불러오는 중…"},
    {"mode": "board", "name": "board", "loader": "card-board-loading", "frame": "card-board-frame", "kind": "center"},
    {"mode": "boardExpanded", "name": "board-expanded", "loader": "card-board-loading", "scope": "card-board-expanded", "frame": "card-board-frame", "kind": "center"},
    {"mode": "daily", "name": "daily", "loader": "daily-loading", "frame": "phone-daily-body",
     "kind": "dailyArea", "start": "daily-date-row", "end": "daily-composer-dock"},
    {"mode": "starred", "name": "starred", "loader": "starred-loading", "frame": "starred-refresh-frame",
     "kind": "center", "absent": ["starred-task-sheet"]},
    {"mode": "folderCards", "name": "folder-cards", "loader": "folder-cards-loading",
     "kind": "sectionCenter", "section": "folder-cards"},
    {"mode": "feed", "name": "feed", "loader": "session-feed-loading", "frame": None, "kind": "center", "text": "세션을 불러오는 중입니다."},
    {"mode": "cardDetail", "name": "card-detail", "loader": "card-detail-loading", "frame": "card-detail-scroll", "kind": "center"},
]

METRICS_SCRIPT = r"""
({ loaderId, frameId, scopeId, boxId, startId, endId, sectionId, absentIds }) => {
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
  const findLastVisible = (id) => {
    const matches = [...document.querySelectorAll(`[data-testid="${id}"]`)].filter(visible);
    return matches.length ? matches[matches.length - 1] : null;
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

  const start = startId ? findLastVisible(startId) : null;
  const end = endId ? findLastVisible(endId) : null;
  const section = sectionId ? findLastVisible(sectionId) : null;
  // The header row is the section's first element (title row with the add button).
  const header = section ? section.firstElementChild : null;

  const style = getComputedStyle(loader);
  return {
    role: loader.getAttribute('role'),
    text: loader.innerText || '',
    loader: rect(loader),
    cluster: union,
    box: box ? rect(box) : null,
    frame: frame ? rect(frame) : null,
    frameTestId: frame ? frame.getAttribute('data-testid') : null,
    start: start ? rect(start) : null,
    end: end ? rect(end) : null,
    section: section ? rect(section) : null,
    header: header ? rect(header) : null,
    headerGap: header ? round(union.top - header.getBoundingClientRect().bottom) : null,
    absent: Object.fromEntries((absentIds || []).map((id) => [
      id, [...document.querySelectorAll(`[data-testid="${id}"]`)].filter(visible).length,
    ])),
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
    for absent_id in sample.get("absent", []):
        count = metrics.get("absent", {}).get(absent_id, 0)
        if count:
            failures.append({"check": "element must be absent during first load", "label": label,
                             "testID": absent_id, "visibleCount": count})
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
    if sample["kind"] == "dailyArea":
        frame, start, end = metrics.get("frame"), metrics.get("start"), metrics.get("end")
        if not frame or not start or not end:
            failures.append({"check": "missing daily area", "label": label,
                             "frame": sample.get("frame"), "start": sample.get("start"),
                             "end": sample.get("end")})
            return failures
        if start["bottom"] > end["top"]:
            failures.append({"check": "daily area is inverted", "label": label,
                             "dateRowBottom": start["bottom"], "composerTop": end["top"]})
            return failures
        area_center_y = round((start["bottom"] + end["top"]) / 2, 2)
        for name in ("loader", "cluster"):
            delta = abs(metrics[name]["centerY"] - area_center_y)
            if delta > CENTRE_TOLERANCE_PX:
                failures.append({"check": f"{name} centreY vs empty area", "label": label,
                                 "delta": round(delta, 2), name: metrics[name]["centerY"],
                                 "areaCenterY": area_center_y})
        for name in ("loader", "cluster"):
            delta = abs(metrics[name]["centerX"] - frame["centerX"])
            if delta > CENTRE_TOLERANCE_PX:
                failures.append({"check": f"{name} centerX vs body", "label": label,
                                 "delta": round(delta, 2), name: metrics[name]["centerX"],
                                 "frame": frame["centerX"]})
        return failures
    if sample["kind"] == "sectionCenter":
        section, cluster = metrics.get("section"), metrics["cluster"]
        if not section:
            failures.append({"check": "missing section", "label": label,
                             "section": sample.get("section")})
            return failures
        # The inline loader is the only visible body below the header row, so there is no
        # separate bordered box underneath to balance against vertically. Judge only the
        # horizontal centre against the section; headerGap stays a recorded value.
        delta = abs(cluster["centerX"] - section["centerX"])
        if delta > CENTRE_TOLERANCE_PX:
            failures.append({"check": "section horizontal centre", "label": label,
                             "delta": round(delta, 2), "cluster": cluster["centerX"],
                             "section": section["centerX"]})
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


def section_url(base: str, section: str) -> str:
    parts = urllib.parse.urlsplit(build_url(base))
    query = urllib.parse.parse_qs(parts.query)
    query['section'] = [section]
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path,
                                    urllib.parse.urlencode(query, doseq=True), parts.fragment))


def check_board_states(page: Page, base: str, output: Path, width: int, failures: list) -> list:
    results = []
    for mode in ('boardExpanded', 'completedLane', 'completedFirst', 'cardDetail'):
        label = f'{mode}-{width}'
        try:
            page.goto(build_url(base), wait_until='networkidle')
            page.get_by_test_id(f'settings-segment-frame-loading-mode-{mode}').click(force=True)
            if mode != 'cardDetail':
                page.get_by_test_id('card-board-expanded').wait_for(state='visible')
            else:
                page.get_by_test_id('card-detail-loading').wait_for(state='visible')
            page.wait_for_timeout(500)
            metrics = page.evaluate('''mode => {
              const scope = mode === 'cardDetail' ? document : document.querySelector('[data-testid="card-board-expanded"]');
              const selector = mode === 'cardDetail' ? '[data-testid^="settings-segment-card-detail-"][data-testid$="-count"]' : '[data-testid^="card-board-count-"]';
              const counts = [...scope.querySelectorAll(selector)].map(e => e.dataset.testid);
              const pending = counts.filter(id => mode === 'completedLane' ? id.endsWith('-done') :
                mode === 'completedFirst' ? !id.endsWith('-done') : true);
              const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom}; };
              const done = scope.querySelector('[data-testid="card-board-column-done"]');
              const period = scope.querySelector('[data-testid^="settings-segment-completed-period-"]');
              const frame = scope.querySelector('[data-testid="card-board-frame"]');
              return {counts, pending, done:done && rect(done), period:period && rect(period.parentElement), frame:frame && rect(frame)};
            }''', mode)
            if metrics['pending']:
                failures.append({'check': 'pending counts', 'label': label, 'actual': metrics['pending']})
            if width == 1180 and mode in ('completedLane', 'completedFirst'):
                if not all(metrics.get(k) for k in ('done', 'period', 'frame')):
                    failures.append({'check': 'completed geometry missing', 'label': label, 'metrics': metrics})
                elif max(metrics['done']['right'], metrics['period']['right']) > metrics['frame']['right'] + 1:
                    failures.append({'check': 'completed geometry overflow', 'label': label, 'metrics': metrics})
            page.screenshot(path=str(output / f'board-state-{label}.png'))
            results.append({'mode': mode, 'metrics': metrics})
        except Exception as error:
            failures.append({'check': 'board state', 'label': label, 'error': str(error).splitlines()[0]})
    return results


def check_refresh_states(page: Page, base: str, output: Path, width: int, failures: list) -> list:
    results = []
    geometry_script = '''mode => {
      const modal = mode === 'boardExpanded' ? document.querySelector('[data-testid="card-board-expanded"]') : null;
      const scope = modal || document;
      const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      const visible = e => { const r=rect(e), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
      const labels = ['드래프트 카드 추가','완료·취소 숨김','보드 확대','보드 확대 닫기','이전 날짜','다음 날짜'];
      const controls = [...scope.querySelectorAll('[role="button"],button')].filter(e=>visible(e) && labels.includes(e.getAttribute('aria-label')));
      const frames = [...scope.querySelectorAll('[data-testid="card-board-frame"]')].filter(visible);
      const items = [...controls,...frames];
      const positions = Object.fromEntries(items.map((e,i)=>[(e.getAttribute('data-testid') || e.getAttribute('aria-label')) + ':' + i,rect(e)]));
      const workspace = document.querySelector('[data-testid="card-board-workspace"]');
      return {positions, paddingTop:workspace && parseFloat(getComputedStyle(workspace).paddingTop)};
    }'''
    for mode in ('boardInternal', 'boardExternal', 'starred', 'sidebar', 'picker', 'daily', 'boardExpanded'):
        label = f'{mode}-{width}'
        try:
            page.goto(section_url(base, 'autoRefresh'), wait_until='networkidle')
            page.get_by_test_id('review-auto-refresh').wait_for(state='visible')
            selected = 'boardInternal' if mode == 'boardExpanded' else mode
            page.get_by_test_id(f'settings-segment-refresh-owner-{selected}').click(force=True)
            page.wait_for_timeout(500)
            if mode == 'boardExpanded':
                page.get_by_test_id('refresh-expand').click(force=True)
                page.get_by_test_id('card-board-expanded').wait_for(state='visible')
                page.wait_for_timeout(700)
            before = page.evaluate(geometry_script, mode)
            page.screenshot(path=str(output / f'auto-refresh-{label}-before.png'))
            if mode == 'boardExpanded':
                page.get_by_test_id('refresh-begin').evaluate('(e) => e.click()')
            else:
                page.get_by_test_id('refresh-begin').click(force=True)
            if mode == 'picker':
                page.get_by_test_id('refresh-picker-open').click(force=True)
            page.wait_for_timeout(700)
            during = page.evaluate(geometry_script, mode)
            metrics = page.evaluate('''mode => {
              const ids = {boardInternal:'card-board-auto-progress', boardExternal:'card-board-auto-progress',
                boardExpanded:'card-board-expanded-auto-progress', starred:'starred-auto-progress', daily:'daily-auto-progress'};
              const elements = [...document.querySelectorAll('[data-testid="card-board-auto-progress"],[data-testid="card-board-expanded-auto-progress"],[data-testid="starred-auto-progress"],[data-testid="daily-auto-progress"]')];
              const element = elements[0];
              const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
              const marker = element && rect(element);
              const expectedId = ids[mode];
              const frameId = mode === 'boardExpanded' ? 'card-board-expanded' : mode.startsWith('board') ? 'card-board-workspace' : mode === 'starred' ? 'starred-refresh-frame' : 'phone-daily-body';
              const frameElement = element && (mode === 'boardExternal'
                ? element.closest('[data-testid="review-phone-card-header"],[data-testid="review-tablet-card-header"]')
                : element.closest(`[data-testid="${frameId}"]`));
              const frame = frameElement && rect(frameElement);
              let rounded = null;
              for (let p = element && element.parentElement; p; p = p.parentElement) {
                const radius = parseFloat(getComputedStyle(p).borderTopRightRadius) || 0;
                if (radius) { rounded = {rect:rect(p), radius}; break; }
              }
              const scope = mode === 'boardExpanded' ? document.querySelector('[data-testid="card-board-expanded"]') : document;
              const candidates = scope.querySelectorAll('button,[role="button"],[data-testid^="card-board-lane-heading-"],[data-testid^="postit-card-"],[data-testid="card-board-heading-title"],[data-testid="review-external-title"],[data-testid="daily-centered-date"]');
              const overlaps = element ? [...candidates].filter(e => {
                const r=rect(e), s=getComputedStyle(e); return r.width && r.height && s.display!=='none' && s.visibility!=='hidden' && marker.left < r.right && marker.right > r.left && marker.top < r.bottom && marker.bottom > r.top;
              }).map(e=>e.getAttribute('data-testid') || e.getAttribute('aria-label')) : [];
              const phase = document.querySelector('[data-testid="refresh-phase"]');
              return {scrollWidth:document.documentElement.scrollWidth, viewport:innerWidth, marker, markerCount:elements.length, markerId:element && element.dataset.testid, expectedId, frame, rounded, overlaps,
                phase:phase && phase.textContent,
                overflow:element && getComputedStyle(element).overflow};
            }''', mode)
            if not metrics['phase'] or not metrics['phase'].startswith('pending'):
                failures.append({'check': 'refresh did not start', 'label': label, 'metrics': metrics})
            metrics['before'] = before
            metrics['during'] = during
            expected = {'boardInternal': 4 if width >= 768 else 3,
                        'boardExternal': 4 if width >= 768 else 3,
                        'boardExpanded': 4 if width >= 768 else 3,
                        'daily': 2}.get(mode, 0)
            if len(before['positions']) != expected or len(during['positions']) != expected:
                failures.append({'check': 'expected control count', 'label': label, 'expected': expected, 'before': before, 'during': during})
            if before['positions'].keys() != during['positions'].keys():
                failures.append({'check': 'controls changed during refresh', 'label': label, 'before': before, 'during': during})
            else:
                for key, rect in before['positions'].items():
                    after = during['positions'][key]
                    if any(abs(rect[edge] - after[edge]) > 1 for edge in ('left', 'right', 'top', 'bottom')):
                        failures.append({'check': 'control moved during refresh', 'label': label, 'element': key, 'before': rect, 'during': after})
            if mode == 'boardExternal' and before['paddingTop'] != 8:
                failures.append({'check': 'external board top padding', 'label': label, 'actual': before['paddingTop']})
            if metrics['scrollWidth'] != metrics['viewport']:
                failures.append({'check': 'document overflow', 'label': label, 'metrics': metrics})
            expected_marker = mode in ('boardInternal', 'boardExpanded', 'starred', 'daily') or (mode == 'boardExternal' and width >= 768)
            if metrics['markerCount'] != (1 if expected_marker else 0):
                failures.append({'check': 'refresh marker count', 'label': label, 'actual': metrics['markerCount'], 'expected': 1 if expected_marker else 0})
            if expected_marker and metrics['markerId'] != metrics['expectedId']:
                failures.append({'check': 'refresh marker owner', 'label': label, 'actual': metrics['markerId'], 'expected': metrics['expectedId']})
            if mode == 'boardExternal' and width < 768:
                header = page.get_by_test_id('review-phone-card-header')
                if header.locator('[role="button"]').count() != 2 or page.locator('[data-testid="card-board-auto-progress"],[data-testid="review-external-refresh-slot"]').count() != 0:
                    failures.append({'check': 'phone header buttons and no marker', 'label': label})
            if expected_marker and (not metrics['marker'] or not metrics['frame']):
                failures.append({'check': 'refresh marker missing', 'label': label, 'metrics': metrics})
            if metrics['marker'] and metrics['frame']:
                m, f = metrics['marker'], metrics['frame']
                if m['left'] < f['left'] - 1 or m['right'] > f['right'] + 1 or m['top'] < f['top'] - 1 or m['bottom'] > f['bottom'] + 1:
                    failures.append({'check': 'marker outside frame', 'label': label, 'metrics': metrics})
                if metrics['overlaps']:
                    failures.append({'check': 'marker overlaps content', 'label': label, 'metrics': metrics})
                if metrics['overflow'] != 'hidden':
                    failures.append({'check': 'marker overflow not clipped', 'label': label, 'metrics': metrics})
                rounded = metrics['rounded']
                if rounded:
                    r, radius = rounded['rect'], rounded['radius']
                    # The marker's upper-right corner is farthest toward the arc.
                    x, y = m['right'], m['top']
                    if m['right'] > r['right'] - radius and m['top'] < r['top'] + radius and (x - (r['right'] - radius)) ** 2 + (y - (r['top'] + radius)) ** 2 > radius ** 2:
                        failures.append({'check': 'marker intersects rounded corner', 'label': label, 'metrics': metrics})
            page.screenshot(path=str(output / f'auto-refresh-{label}.png'))
            results.append({'mode': mode, 'metrics': metrics})
        except Exception as error:
            failures.append({'check': 'refresh state', 'label': label, 'error': str(error).splitlines()[0]})
    return results


def check_duo(browser, base: str, output: Path, failures: list) -> list:
    results = []
    for name, width, height in (('outer-portrait', 466, 678), ('inner-landscape', 951, 669)):
        context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1)
        page = context.new_page()
        netloc = urllib.parse.urlsplit(base).netloc
        def route_request(route):
            url = urllib.parse.urlsplit(route.request.url)
            if url.path == '/api/auth/status':
                route.fulfill(status=200, content_type='application/json', body='{"authenticated":true}')
            elif url.netloc == netloc or route.request.url.startswith(('data:', 'blob:')):
                route.continue_()
            else:
                route.abort()
        context.route('**/*', route_request)
        try:
            page.goto(section_url(base, 'autoRefresh') + '&duoFrame=' + name, wait_until='networkidle')
            page.get_by_test_id('review-duo-refresh').wait_for(state='visible')
            page.wait_for_timeout(700)
            page.get_by_test_id('duo-refresh-begin').click(force=True)
            page.wait_for_timeout(500)
            if page.get_by_test_id('duo-refresh-phase').inner_text() != 'pending':
                failures.append({'check': 'duo refresh did not start', 'label': name})
            if page.get_by_test_id('card-board-frame').count() != 1 or page.locator('[data-testid="duo-rail-override-host"] [data-testid^="duo-rail-action-"]').count() != 2:
                failures.append({'check': 'duo inline board and rail count', 'label': name})
            if page.locator('[data-testid="card-board-auto-progress"],[data-testid="card-board-refresh-slot"]').count() != 0:
                failures.append({'check': 'duo inline marker must be absent', 'label': name})
            page.screenshot(path=str(output / f'duo-inline-{name}.png'))
            page.get_by_test_id('duo-refresh-finish').click(force=True)
            page.wait_for_timeout(500)
            page.get_by_test_id('duo-refresh-expand').click(force=True)
            page.get_by_test_id('card-board-expanded').wait_for(state='visible')
            page.wait_for_timeout(700)
            rail = page.locator('[data-testid="app-modal-viewport"] [data-testid^="duo-rail-action-"]')
            before = [item.bounding_box() for item in rail.all()]
            page.get_by_test_id('duo-refresh-begin').evaluate('(e) => e.click()')
            page.wait_for_timeout(700)
            after = [item.bounding_box() for item in rail.all()]
            metrics = page.evaluate('''() => {
              const modal=document.querySelector('[data-testid="card-board-expanded"]');
              const marker=modal.querySelectorAll('[data-testid="card-board-expanded-auto-progress"]');
              const title=modal.querySelectorAll('[data-testid="card-board-heading-title"]');
              const slots=modal.querySelectorAll('[data-testid="card-board-expanded-refresh-slot"]');
              const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,centerY:r.top+r.height/2}};
              let rounded=null;
              for(let p=marker[0]?.parentElement;p;p=p.parentElement){const radius=parseFloat(getComputedStyle(p).borderTopRightRadius)||0;if(radius){rounded={rect:rect(p),radius};break;}}
              return {markerCount:marker.length,titleCount:title.length,slotCount:slots.length,marker:marker[0]&&rect(marker[0]),title:title[0]&&rect(title[0]),frame:rect(modal),rounded,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth};
            }''')
            if len(before) != 3 or len(after) != 3 or any(not a or not b or any(abs(a[k]-b[k])>1 for k in ('x','y','width','height')) for a,b in zip(before,after)):
                failures.append({'check':'duo rail count or movement','label':name,'before':before,'after':after})
            if any(metrics[k] != 1 for k in ('markerCount','titleCount','slotCount')):
                failures.append({'check':'duo marker/title/slot count','label':name,'metrics':metrics})
            else:
                m,f=metrics['marker'],metrics['frame']
                if abs(m['centerY']-metrics['title']['centerY'])>1 or m['left']<f['left'] or m['right']>f['right'] or m['top']<f['top'] or m['bottom']>f['bottom']:
                    failures.append({'check':'duo marker alignment or frame','label':name,'metrics':metrics})
                rounded=metrics['rounded']
                if name == 'inner-landscape' and not rounded:
                    failures.append({'check':'duo rounded frame missing','label':name,'metrics':metrics})
                if rounded:
                    r,rad=rounded['rect'],rounded['radius']
                    if m['right']>r['right']-rad and m['top']<r['top']+rad and (m['right']-(r['right']-rad))**2+(m['top']-(r['top']+rad))**2>rad**2:
                        failures.append({'check':'duo rounded corner','label':name,'metrics':metrics})
            if metrics['scrollWidth'] != width:
                failures.append({'check':'duo document overflow','label':name,'metrics':metrics})
            page.screenshot(path=str(output / f'duo-expanded-{name}.png'))
            results.append({'frame':name,'metrics':metrics,'railBefore':before,'railAfter':after})
        except Exception as error:
            failures.append({'check':'duo sample','label':name,'error':str(error).splitlines()[0]})
        finally:
            context.close()
    return results


def check_resize(page: Page, base: str, output: Path, failures: list) -> list:
    results = []
    try:
        page.goto(build_url(base), wait_until='networkidle')
        page.get_by_test_id('settings-segment-frame-loading-mode-completedFirst').click(force=True)
        page.get_by_test_id('card-board-expanded').wait_for(state='visible')
        search = page.get_by_placeholder('제목 또는 요청 검색').last
        search.fill('갱신')
        for width, height in ((1180, 820), (1366, 820), (390, 844), (1180, 820)):
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(500)
            metrics = page.evaluate('''() => {
              const board = document.querySelector('[data-testid="card-board-expanded"]');
              const done = board && board.querySelector('[data-testid="card-board-column-done"]');
              return {viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth,
                boardWidth:board && board.getBoundingClientRect().width,
                doneWidth:done && done.getBoundingClientRect().width};
            }''')
            metrics['searchValue'] = search.input_value()
            if metrics['scrollWidth'] != width or not metrics['doneWidth'] or metrics['searchValue'] != '갱신':
                failures.append({'check': 'resize', 'label': str(width), 'metrics': metrics})
            results.append(metrics)
            page.screenshot(path=str(output / f'resize-{width}.png'))
        page.goto(section_url(base, 'autoRefresh'), wait_until='networkidle')
        lane = page.get_by_test_id('card-board-scroll-review').first
        lane.wait_for(state='visible')
        lane.evaluate('(e) => { e.scrollTop = 160; }')
        page.wait_for_timeout(200)
        before_scroll = lane.evaluate('(e) => e.scrollTop')
        page.set_viewport_size({'width': 390, 'height': 820})
        page.wait_for_timeout(500)
        after_scroll = lane.evaluate('(e) => e.scrollTop')
        results.append({'scrollBefore': before_scroll, 'scrollAfter': after_scroll})
        if before_scroll < 1 or abs(after_scroll - before_scroll) > 1:
            failures.append({'check': 'resize scroll position', 'before': before_scroll, 'after': after_scroll})
    except Exception as error:
        failures.append({'check': 'resize', 'error': str(error).splitlines()[0]})
    return results


ALIGNMENT_SCRIPT = r'''({expanded, external, requireCard, fullLanes}) => {
  const scope = expanded ? document.querySelector('[data-testid="card-board-expanded"]') : document.querySelector('[data-testid="card-board-workspace"]');
  if (!scope) throw Error('board scope missing');
  const board = scope.querySelector('[data-testid="card-board"]');
  const title = external ? document.querySelector('[data-testid="review-external-title"]') : scope.querySelector('[data-testid="card-board-heading-title"]');
  if (!board || !title) throw Error('board or title missing');
  const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; };
  const bounds=rect(board);
  const lanes=[...board.querySelectorAll('[data-testid^="card-board-column-"]')].map(e=>({element:e,rect:rect(e),id:e.dataset.testid}));
  const visible=lanes.filter(l=>l.rect.right>bounds.left+1 && l.rect.left<bounds.right-1);
  if (!visible.length) throw Error('no visible lanes');
  // Lanes are transparent. Inline boards may expose an empty bit of the
  // preceding lane's padding; choose the first visible heading or paper.
  const first=fullLanes ? visible[0] : visible.find(l => {
    const content=l.element.querySelector('[data-testid^="card-board-lane-heading-"], [data-testid^="postit-card-"]');
    if (!content) return false;
    const r=rect(content); return r.right>bounds.left+1 && r.left<bounds.right-1;
  });
  if (!first) throw Error('no visible lane content');
  const heading=first.element.querySelector('[data-testid^="card-board-lane-heading-"]');
  const card=first.element.querySelector('[data-testid^="postit-card-"]');
  if (!heading || (requireCard && !card)) throw Error('first lane heading or card missing: '+first.id);
  const review=lanes.find(l=>l.id==='card-board-column-review');
  return {title:rect(title),board:bounds,heading:rect(heading),card:card&&rect(card),scroll:board.scrollLeft,max:board.scrollWidth-board.clientWidth,
    visible:visible.map(({id,rect})=>({id,...rect})),review:review&&review.rect,fullLanes};
}'''


def check_alignment_metrics(metrics: dict, label: str, failures: list, require_card: bool, full_lanes: bool, require_review: bool = False) -> None:
    for item in ('heading', 'card') if require_card else ('heading',):
        if not metrics.get(item) or abs(metrics[item]['left'] - metrics['title']['left']) > 1:
            failures.append({'check': 'board start alignment', 'label': label, 'item': item, 'metrics': metrics})
    if full_lanes:
        for lane in metrics['visible']:
            if lane['left'] < metrics['board']['left'] - 1 or lane['right'] > metrics['board']['right'] + 1:
                failures.append({'check': 'partial board lane', 'label': label, 'lane': lane, 'metrics': metrics})
    if require_review and (not metrics['review'] or metrics['review']['left'] < metrics['board']['left'] - 1 or metrics['review']['right'] > metrics['board']['right'] + 1):
        failures.append({'check': 'review lane not fully visible', 'label': label, 'metrics': metrics})


def check_board_alignment(page: Page, base: str, output: Path, width: int, failures: list) -> list:
    results = []
    for mode in ('boardInternal', 'boardExternal'):
        label=f'alignment-inline-{mode}-{width}'
        try:
            page.goto(section_url(base, 'autoRefresh'), wait_until='networkidle')
            page.get_by_test_id('settings-segment-refresh-owner-'+mode).click(force=True)
            board=page.get_by_test_id('card-board').first
            board.wait_for(state='visible')
            page.wait_for_timeout(500)
            board.evaluate('(e) => { e.scrollLeft = 0; }')
            page.wait_for_timeout(300)
            metrics=page.evaluate(ALIGNMENT_SCRIPT, {'expanded':False,'external':mode=='boardExternal','requireCard':True,'fullLanes':False})
            check_alignment_metrics(metrics,label,failures,True,False)
            if width == 390 and any(abs(metrics[k]['left']-16)>1 for k in ('title','heading','card')):
                failures.append({'check':'phone inline baseline','label':label,'metrics':metrics})
            page.screenshot(path=str(output / (label+'.png')))
            results.append({'label':label,'metrics':metrics})
            if width == 1180:
                workspace=page.get_by_test_id('card-board-workspace').first
                workspace.evaluate("(e) => { e.style.width='400px'; e.style.alignSelf='flex-start'; }")
                page.wait_for_timeout(500)
                board.evaluate('(e) => { e.scrollLeft=e.scrollWidth; }')
                page.wait_for_timeout(400)
                metrics=page.evaluate(ALIGNMENT_SCRIPT, {'expanded':False,'external':mode=='boardExternal','requireCard':True,'fullLanes':False})
                check_alignment_metrics(metrics,label+'-end',failures,True,False)
                results.append({'label':label+'-end','metrics':metrics})
        except Exception as error:
            failures.append({'check':'inline alignment','label':label,'error':str(error).splitlines()[0]})
    if width != 1180:
        return results
    for duo in (False, True):
        label='alignment-expanded-duo' if duo else 'alignment-expanded-1180'
        try:
            if duo:
                page.set_viewport_size({'width':951,'height':669})
            url=section_url(base,'autoRefresh') + ('&duoFrame=inner-landscape' if duo else '&boardAlignment=1')
            page.goto(url,wait_until='networkidle')
            page.get_by_test_id('duo-refresh-expand' if duo else 'refresh-expand').click(force=True)
            modal=page.get_by_test_id('card-board-expanded')
            modal.wait_for(state='visible')
            page.wait_for_timeout(700)
            if duo and modal.get_by_test_id('card-board-column-blocked').locator('[data-testid^="postit-card-"]').count() == 0:
                raise RuntimeError('duo preceding blocked lane has no card')
            board=modal.get_by_test_id('card-board')
            for position in ('initial','end'):
                if position == 'end':
                    board.evaluate('(e) => { e.scrollLeft = e.scrollWidth; }')
                    page.wait_for_timeout(300)
                metrics=page.evaluate(ALIGNMENT_SCRIPT, {'expanded':True,'external':False,'requireCard':True,'fullLanes':True})
                check_alignment_metrics(metrics,label+'-'+position,failures,True,True,position=='initial')
                page.screenshot(path=str(output / (label+'-'+position+'.png')))
                results.append({'label':label+'-'+position,'metrics':metrics})
        except Exception as error:
            failures.append({'check':'expanded alignment','label':label,'error':str(error).splitlines()[0]})
        finally:
            if duo: page.set_viewport_size({'width':1180,'height':820})
    try:
        page.goto(build_url(base),wait_until='networkidle')
        page.get_by_test_id('settings-segment-frame-loading-mode-completedFirst').click(force=True)
        page.get_by_test_id('card-board-expanded').wait_for(state='visible')
        page.wait_for_timeout(500)
        metrics=page.evaluate(ALIGNMENT_SCRIPT, {'expanded':True,'external':False,'requireCard':False,'fullLanes':False})
        check_alignment_metrics(metrics,'alignment-completed-visible',failures,False,False)
        results.append({'label':'alignment-completed-visible','metrics':metrics})
    except Exception as error:
        failures.append({'check':'completed visible alignment','error':str(error).splitlines()[0]})
    return results


def check_completed_refresh(page: Page, base: str, output: Path, failures: list) -> dict:
    try:
        page.goto(section_url(base,'autoRefresh')+'&manyCompleted=1',wait_until='networkidle')
        page.get_by_test_id('refresh-expand').click(force=True)
        modal=page.get_by_test_id('card-board-expanded')
        modal.wait_for(state='visible')
        board=modal.get_by_test_id('card-board')
        board.evaluate('(e) => { e.scrollLeft=e.scrollWidth; }')
        lane=modal.get_by_test_id('card-board-scroll-done')
        lane.wait_for(state='visible')
        page.wait_for_timeout(700)
        count=modal.get_by_test_id('card-board-count-done')
        for _ in range(12):
            lane.evaluate('(e) => { e.scrollTop=e.scrollHeight; }')
            page.wait_for_timeout(500)
            if int(count.inner_text().split('개')[0]) > 60:
                break
        page.wait_for_function('''() => {const e=document.querySelector('[data-testid="card-board-expanded"] [data-testid="card-board-count-done"]');return e && parseInt(e.textContent)>60;}''')
        before={'scroll':lane.evaluate('(e) => e.scrollTop'),'count':int(count.inner_text().split('개')[0])}
        page.get_by_test_id('refresh-begin').evaluate('(e) => e.click()')
        page.wait_for_timeout(300)
        page.get_by_test_id('refresh-finish').evaluate('(e) => e.click()')
        page.wait_for_timeout(1000)
        after={'scroll':lane.evaluate('(e) => e.scrollTop'),'count':int(count.inner_text().split('개')[0])}
        if before['scroll']<1 or abs(before['scroll']-after['scroll'])>1 or after['count']<before['count']:
            failures.append({'check':'completed refresh preservation','before':before,'after':after})
        page.screenshot(path=str(output / 'completed-refresh-after.png'))
        return {'before':before,'after':after}
    except Exception as error:
        failures.append({'check':'completed refresh','error':str(error).splitlines()[0]})
        return {}


COMPLETED_FILTER_SCRIPT = r'''({expanded}) => {
  const scope = expanded ? document.querySelector('[data-testid="card-board-expanded"]') : document.querySelector('[data-testid="card-board-workspace"]');
  if (!scope) return {missing: 'board scope'};
  const lane = scope.querySelector('[data-testid="card-board-column-done"]');
  if (!lane) return {missing: 'done lane'};
  const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
  const visible = e => { const r=e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // The chip hit target's min-height is t.hitTarget.min for the active device tokens.
  const chips = ['7','30','all','custom'].map(value => {
    const chip = lane.querySelector(`[data-testid="settings-segment-completed-period-${value}"]`);
    if (!chip) return null;
    const label = lane.querySelector(`[data-testid="settings-segment-completed-period-${value}-label"]`);
    return {value, ...rect(chip), minHeight: parseFloat(getComputedStyle(chip).minHeight) || 0,
      label: label && {scrollWidth: label.scrollWidth, clientWidth: label.clientWidth, text: label.innerText}};
  });
  const first = lane.querySelector('[data-testid="settings-segment-completed-period-7"]');
  const error = [...lane.querySelectorAll('[data-testid="completed-error"]')].filter(visible)[0];
  const retry = [...lane.querySelectorAll('[aria-label="완료 카드 다시 조회"]')].filter(visible)[0];
  const count = lane.querySelector('[data-testid="card-board-count-done"]');
  const firstCard = lane.querySelector('[data-testid^="postit-card-"]');
  return {lane: rect(lane), viewportWidth: innerWidth, chips, track: first && rect(first.parentElement),
    error: error ? {...rect(error), text: error.innerText} : null,
    retry: retry ? {...rect(retry), text: retry.innerText} : null,
    cards: lane.querySelectorAll('[data-testid^="postit-card-"]').length,
    firstCard: firstCard ? firstCard.dataset.testid : null,
    count: count ? parseInt(count.innerText, 10) : null};
}'''


def inside(item: dict, frame: dict) -> bool:
    return item['left'] >= frame['left'] - 1 and item['right'] <= frame['right'] + 1


def check_period_chips(metrics: dict, label: str, failures: list) -> None:
    """Four period chips: one row of four or two rows of two, equal widths per row, inside the lane."""
    if metrics.get('missing') or not metrics.get('chips') or not all(metrics['chips']) or not metrics.get('track'):
        failures.append({'check': 'period chips missing', 'label': label, 'metrics': metrics})
        return
    chips = metrics['chips']
    rows: list[list[dict]] = []
    for chip in sorted(chips, key=lambda item: (item['top'], item['left'])):
        if rows and abs(rows[-1][0]['top'] - chip['top']) <= 1:
            rows[-1].append(chip)
        else:
            rows.append([chip])
    shape = [len(row) for row in rows]
    if shape not in ([4], [2, 2]):
        failures.append({'check': 'period chip rows', 'label': label, 'shape': shape,
                         'rows': [[chip['value'] for chip in row] for row in rows]})
    for row in rows:
        widths = [chip['width'] for chip in row]
        if max(widths) - min(widths) > 1:
            failures.append({'check': 'period chip width', 'label': label, 'widths': widths})
    if shape == [2, 2]:
        edges = [(min(c['left'] for c in row), max(c['right'] for c in row)) for row in rows]
        if abs(edges[0][0] - edges[1][0]) > 1 or abs(edges[0][1] - edges[1][1]) > 1:
            failures.append({'check': 'period chip row edges', 'label': label, 'edges': edges})
    for chip in chips:
        text = chip.get('label')
        if not text:
            failures.append({'check': 'period chip label missing', 'label': label, 'value': chip['value']})
        elif text['scrollWidth'] > text['clientWidth'] + 1:
            failures.append({'check': 'period chip label clipped', 'label': label, 'value': chip['value'], 'text': text})
        if not chip['minHeight'] or chip['height'] < chip['minHeight'] - 0.5:
            failures.append({'check': 'period chip hit height', 'label': label, 'value': chip['value'],
                             'height': chip['height'], 'minHeight': chip['minHeight']})
    if not inside(metrics['track'], metrics['lane']):
        failures.append({'check': 'period chips outside lane', 'label': label,
                         'track': metrics['track'], 'lane': metrics['lane']})


def check_completed_error(metrics: dict, label: str, failures: list, retry_expected: bool, text: str | None = None) -> None:
    """Error text inside the done lane; the retry button only for fetch failures."""
    if metrics.get('missing'):
        failures.append({'check': 'completed lane missing', 'label': label, 'metrics': metrics})
        return
    error, retry, lane = metrics.get('error'), metrics.get('retry'), metrics['lane']
    if not error:
        failures.append({'check': 'completed error missing', 'label': label})
    elif text and text not in error['text']:
        failures.append({'check': 'completed error text', 'label': label, 'expected': text, 'actual': error['text']})
    if not retry_expected:
        if retry:
            failures.append({'check': 'retry must be absent', 'label': label, 'retry': retry})
        return
    if not retry:
        failures.append({'check': 'retry button missing', 'label': label})
        return
    if retry['text'].strip() != '다시 시도':
        failures.append({'check': 'retry text', 'label': label, 'actual': retry['text']})
    if metrics.get('track') and retry['width'] >= metrics['track']['width'] - 1:
        failures.append({'check': 'retry stretched to the lane width', 'label': label, 'retry': retry, 'track': metrics['track']})
    for name, item in (('error', error), ('retry', retry)):
        if item and (not inside(item, lane) or item['left'] < -1 or item['right'] > metrics['viewportWidth'] + 1):
            failures.append({'check': f'{name} outside lane', 'label': label, name: item, 'lane': lane})
    hit_min = max((chip['minHeight'] for chip in metrics.get('chips') or [] if chip), default=0)
    if not hit_min or retry['height'] < hit_min - 0.5:
        failures.append({'check': 'retry hit height', 'label': label, 'height': retry['height'], 'minHeight': hit_min})


def check_completed_recovered(metrics: dict, label: str, failures: list, minimum_count: int = 1) -> None:
    """Error and retry gone, at least one card drawn and the lane count not below minimum_count."""
    if metrics.get('missing') or metrics.get('error') or metrics.get('retry') or metrics.get('cards', 0) < 1 \
            or (metrics.get('count') or 0) < minimum_count:
        failures.append({'check': 'completed not recovered', 'label': label, 'metrics': metrics})


def check_refresh_kept_cards(before: dict, after: dict, label: str, failures: list) -> None:
    """A failed refresh keeps the loaded cards: same lane count, same first card, cards still drawn.

    The DOM card count is not compared: the done lane is a virtualized list, so the error block
    above it shortens the render window without dropping any loaded card.
    """
    if not before.get('cards') or not before.get('count') or (after.get('count') or 0) < before['count'] \
            or after.get('cards', 0) < 1 or after.get('firstCard') != before.get('firstCard'):
        failures.append({'check': 'completed refresh failure dropped cards', 'label': label,
                         'before': {k: before.get(k) for k in ('cards', 'count', 'firstCard')},
                         'after': {k: after.get(k) for k in ('cards', 'count', 'firstCard')}})


# The 1180 iPad runs three panes; the inline board sits in the card pane (paneWidths.ts
# PANE_SPECS.card.default 480). The review page gives the board the whole window instead.
TABLET_CARD_PANE_PX = 480


def open_completed_board(page: Page, base: str, query: str, expanded: bool, duo: bool = False, pane: int | None = None):
    page.goto(section_url(base, 'autoRefresh') + query, wait_until='networkidle')
    if expanded:
        page.get_by_test_id('duo-refresh-expand' if duo else 'refresh-expand').click(force=True)
        page.get_by_test_id('card-board-expanded').wait_for(state='visible')
    scope = page.get_by_test_id('card-board-expanded') if expanded else page.get_by_test_id('card-board-workspace').first
    if pane:
        scope.evaluate("(e, width) => { e.style.width = width + 'px'; e.style.alignSelf = 'flex-start'; }", pane)
    board = scope.get_by_test_id('card-board')
    board.wait_for(state='visible')
    page.wait_for_timeout(500)
    board.evaluate('(e) => { e.scrollLeft = e.scrollWidth; }')
    scope.get_by_test_id('card-board-column-done').wait_for(state='visible')
    page.wait_for_timeout(500)
    return scope


def completed_contexts(width: int) -> list[tuple[str, bool, str, int | None]]:
    # (name, expanded, query, inline pane width). boardAlignment fills six active lanes like an operating folder.
    return [('tablet-inline', False, '&boardAlignment=1', TABLET_CARD_PANE_PX), ('tablet-expanded', True, '&boardAlignment=1', None)] \
        if width == 1180 else [('phone-inline', False, '', None)]


def check_completed_retry(page: Page, base: str, output: Path, width: int, failures: list) -> list:
    """First fetch failure → retry → recovery, range error without retry, refresh failure keeping cards."""
    results = []
    for name, expanded, lanes, pane in completed_contexts(width):
        label = f'completed-retry-{name}-{width}'
        try:
            scope = open_completed_board(page, base, lanes + '&completedError', expanded, pane=pane)
            lane = scope.get_by_test_id('card-board-column-done')
            lane.get_by_test_id('completed-error').wait_for(state='visible', timeout=5000)
            failed = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            check_completed_error(failed, label, failures, True)
            page.screenshot(path=str(output / f'{label}-failed.png'))
            lane.screenshot(path=str(output / f'{label}-failed-lane.png'))
            lane.get_by_label('완료 카드 다시 조회').focus()
            page.keyboard.press('Enter')
            page.wait_for_timeout(700)
            recovered = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            check_completed_recovered(recovered, label, failures)
            focus_after = page.evaluate("() => { const e = document.activeElement; return e ? (e.dataset.testid || e.getAttribute('aria-label') || e.tagName) : null; }")
            page.screenshot(path=str(output / f'{label}-recovered.png'))
            lane.screenshot(path=str(output / f'{label}-recovered-lane.png'))
            lane.get_by_test_id('settings-segment-completed-period-custom').click()
            lane.get_by_label('완료 시작일').fill('2026-12-31')
            lane.get_by_label('완료 종료일').fill('2026-01-01')
            page.wait_for_timeout(500)
            ranged = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            check_completed_error(ranged, label + '-range', failures, False, '시작일과 종료일을 확인해 주세요.')
            lane.screenshot(path=str(output / f'{label}-range-lane.png'))
            results.append({'label': label, 'failed': failed, 'recovered': recovered, 'focusAfterRecovery': focus_after, 'range': ranged})
        except Exception as error:
            failures.append({'check': 'completed retry', 'label': label, 'error': str(error).splitlines()[0]})
            page.screenshot(path=str(output / f'{label}-error.png'))
        label = f'completed-refresh-failure-{name}-{width}'
        try:
            scope = open_completed_board(page, base, lanes + '&manyCompleted=1&completedError=refresh', expanded, pane=pane)
            lane = scope.get_by_test_id('card-board-column-done')
            lane.locator('[data-testid^="postit-card-"]').first.wait_for(state='visible')
            before = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            page.get_by_test_id('refresh-begin').evaluate('(e) => e.click()')
            page.wait_for_timeout(300)
            page.get_by_test_id('refresh-finish').evaluate('(e) => e.click()')
            lane.get_by_test_id('completed-error').wait_for(state='visible', timeout=5000)
            page.wait_for_timeout(300)
            after = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            check_completed_error(after, label, failures, True)
            check_refresh_kept_cards(before, after, label, failures)
            lane.screenshot(path=str(output / f'{label}-lane.png'))
            # Hold the next read: the notice and button stay, the button is busy, a keyboard
            # press sends nothing and keeps focus on it (ui-design §0 14).
            page.get_by_test_id('refresh-begin').evaluate('(e) => e.click()')
            page.wait_for_timeout(300)
            retry = lane.get_by_label('완료 카드 다시 조회')
            retry.focus()
            page.keyboard.press('Enter')
            page.wait_for_timeout(300)
            held = retry.evaluate("(e) => ({busy: e.getAttribute('aria-busy'), focused: document.activeElement === e})")
            held['metrics'] = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            if held['busy'] != 'true' or not held['focused'] or not held['metrics'].get('error') or not held['metrics'].get('retry'):
                failures.append({'check': 'retry not busy or lost focus during a read', 'label': label,
                                 'busy': held['busy'], 'focused': held['focused']})
            lane.screenshot(path=str(output / f'{label}-busy-lane.png'))
            page.get_by_test_id('refresh-finish').evaluate('(e) => e.click()')
            page.wait_for_timeout(700)
            recovered = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            check_completed_recovered(recovered, label, failures, before.get('count') or 1)
            focus_after = page.evaluate("() => { const e = document.activeElement; return e ? (e.dataset.testid || e.getAttribute('aria-label') || e.tagName) : null; }")
            results.append({'label': label, 'before': before, 'after': after, 'held': {'busy': held['busy'], 'focused': held['focused']},
                            'recovered': recovered, 'focusAfterRecovery': focus_after})
        except Exception as error:
            failures.append({'check': 'completed refresh failure', 'label': label, 'error': str(error).splitlines()[0]})
            page.screenshot(path=str(output / f'{label}-error.png'))
    return results


def check_completed_period_chips(page: Page, base: str, output: Path, width: int, failures: list) -> list:
    results = []
    # tablet-inline-wide keeps three lanes, so the done lane widens to several columns (one row of four).
    contexts = [*completed_contexts(width), ('tablet-inline-wide', False, '', None), ('duo-expanded', True, '&duoFrame=inner-landscape', None)] \
        if width == 1180 else completed_contexts(width)
    for name, expanded, lanes, pane in contexts:
        label = f'completed-period-{name}'
        duo = 'duoFrame' in lanes
        try:
            if duo:
                page.set_viewport_size({'width': 951, 'height': 669})
            scope = open_completed_board(page, base, lanes + '&manyCompleted=1', expanded, duo, pane)
            metrics = page.evaluate(COMPLETED_FILTER_SCRIPT, {'expanded': expanded})
            check_period_chips(metrics, label, failures)
            page.screenshot(path=str(output / f'{label}.png'))
            scope.get_by_test_id('card-board-column-done').screenshot(path=str(output / f'{label}-lane.png'))
            results.append({'label': label, 'chips': metrics.get('chips'), 'track': metrics.get('track'), 'lane': metrics.get('lane')})
        except Exception as error:
            failures.append({'check': 'completed period chips', 'label': label, 'error': str(error).splitlines()[0]})
        finally:
            if duo:
                page.set_viewport_size({'width': 1180, 'height': 820})
    return results


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
                        "startId": sample.get("start"),
                        "endId": sample.get("end"),
                        "sectionId": sample.get("section"),
                        "absentIds": sample.get("absent", []),
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
                viewport_result['alignment'] = check_board_alignment(page, args.base_url, output, width, failures) if width in (1180, 390) else []
                if width == 1180:
                    viewport_result['completedRefresh'] = check_completed_refresh(page, args.base_url, output, failures)
                if width in (1180, 390):
                    viewport_result['completedRetry'] = check_completed_retry(page, args.base_url, output, width, failures)
                    viewport_result['completedPeriodChips'] = check_completed_period_chips(page, args.base_url, output, width, failures)
                viewport_result['boardStates'] = check_board_states(page, args.base_url, output, width, failures)
                viewport_result['refreshStates'] = check_refresh_states(page, args.base_url, output, width, failures)
                if width == 1180:
                    viewport_result['resize'] = check_resize(page, args.base_url, output, failures)
                result["viewports"].append(viewport_result)
                context.close()
            result['duo'] = check_duo(browser, args.base_url, output, failures)
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
