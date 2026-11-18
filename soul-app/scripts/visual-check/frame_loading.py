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
              const element = ids[mode] && document.querySelector(`[data-testid="${ids[mode]}"]`);
              const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
              const marker = element && rect(element);
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
              return {scrollWidth:document.documentElement.scrollWidth, viewport:innerWidth, marker, frame, rounded, overlaps,
                phase:phase && phase.textContent,
                overflow:element && getComputedStyle(element).overflow};
            }''', mode)
            if not metrics['phase'] or not metrics['phase'].startswith('pending'):
                failures.append({'check': 'refresh did not start', 'label': label, 'metrics': metrics})
            metrics['before'] = before
            metrics['during'] = during
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
            expected_marker = mode in ('boardInternal', 'boardExternal', 'boardExpanded', 'starred', 'daily')
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
                viewport_result['boardStates'] = check_board_states(page, args.base_url, output, width, failures)
                viewport_result['refreshStates'] = check_refresh_states(page, args.base_url, output, width, failures)
                if width == 1180:
                    viewport_result['resize'] = check_resize(page, args.base_url, output, failures)
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
