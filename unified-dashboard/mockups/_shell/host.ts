// 시안을 감싸는 바깥 틀. 테마와 화면 폭을 바꿔 본다.
// 미디어 쿼리는 창 폭을 따르므로 시안은 iframe(frame.html) 안에서 그린다.
// 실제 기기에서 볼 때는 frame.html을 바로 열면 된다.
const WIDTHS = [
  { id: "fit", label: "맞춤", width: 0 },
  { id: "phone", label: "휴대폰", width: 390 },
  { id: "tablet", label: "태블릿", width: 820 },
  { id: "desktop", label: "데스크톱", width: 1440 },
] as const;
type WidthId = typeof WIDTHS[number]["id"];
type Theme = "light" | "dark";

const params = new URLSearchParams(window.location.search);
let theme: Theme = params.get("theme") === "light" || params.get("theme") === "dark"
  ? params.get("theme") as Theme
  : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
let widthId: WidthId = WIDTHS.some(item => item.id === params.get("w")) ? params.get("w") as WidthId : "fit";

const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: light dark; --bar: 48px; --ink: #1d1d1f; --muted: #6e6e73; --line: rgba(0,0,0,.12); --chip: rgba(0,0,0,.06); --on: #fff; --page: #e9e9ee; }
  :root[data-theme=dark] { --ink: #f5f5f7; --muted: #a1a1a6; --line: rgba(255,255,255,.16); --chip: rgba(255,255,255,.1); --on: #3a3a3c; --page: #111113; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--page); color: var(--ink); font: 500 14px/20px "Pretendard Variable", -apple-system, BlinkMacSystemFont, system-ui, sans-serif; overflow: hidden; }
  .host-bar { height: var(--bar); display: flex; align-items: center; gap: 16px; padding: 0 16px; box-sizing: border-box; border-bottom: 1px solid var(--line); }
  .host-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .host-seg { display: flex; padding: 2px; border-radius: 10px; background: var(--chip); }
  .host-seg button { appearance: none; border: 0; background: none; color: var(--muted); font: inherit; height: 28px; padding: 0 12px; border-radius: 8px; cursor: pointer; }
  .host-seg button[aria-pressed=true] { background: var(--on); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.18); }
  .host-seg button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 1px; }
  .host-stage { height: calc(100% - var(--bar)); overflow: hidden; display: flex; justify-content: center; }
  .host-stage iframe { border: 0; background: transparent; transform-origin: top center; flex: none; }
  /* 코멘트는 시안 본문(frame.html) 안에서 단다. 바깥 틀의 버튼은 겹치므로 숨긴다. */
  #pages-review { display: none !important; }
  @media (max-width: 560px) { .host-title { display: none; } .host-bar { justify-content: space-between; gap: 8px; padding: 0 8px; } .host-seg button { padding: 0 8px; } }
`;
document.head.append(style);

const bar = document.createElement("header");
bar.className = "host-bar";
const title = document.createElement("div");
title.className = "host-title";
title.textContent = document.title;
const stage = document.createElement("div");
stage.className = "host-stage";
const frame = document.createElement("iframe");
frame.title = document.title;
frame.src = `./frame.html?theme=${theme}${params.get("glass") ? `&glass=${params.get("glass")}` : ""}`;
stage.append(frame);

function segment<T extends string>(label: string, items: readonly { id: T; label: string }[], current: () => T, pick: (id: T) => void) {
  const group = document.createElement("div");
  group.className = "host-seg";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const buttons = items.map(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.addEventListener("click", () => { pick(item.id); sync(); });
    group.append(button);
    return { button, id: item.id };
  });
  const sync = () => buttons.forEach(({ button, id }) => button.setAttribute("aria-pressed", String(id === current())));
  sync();
  return group;
}

function layout() {
  const target = WIDTHS.find(item => item.id === widthId)!.width;
  const available = { width: stage.clientWidth, height: stage.clientHeight };
  const width = target || available.width;
  // 창보다 넓은 화면은 줄여서 보여 준다. 안쪽의 미디어 쿼리는 원래 폭 그대로다.
  const scale = Math.min(1, available.width / width);
  frame.style.width = `${width}px`;
  frame.style.height = `${available.height / scale}px`;
  frame.style.transform = scale < 1 ? `scale(${scale})` : "";
}

function remember() {
  const next = new URLSearchParams(window.location.search);
  next.set("theme", theme); next.set("w", widthId);
  window.history.replaceState(null, "", `?${next}`);
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  frame.contentWindow?.postMessage({ type: "mockup:theme", theme }, window.location.origin);
}

bar.append(
  title,
  segment("테마", [{ id: "light", label: "밝게" }, { id: "dark", label: "어둡게" }] as const,
    () => theme, id => { theme = id; applyTheme(); remember(); }),
  segment("화면 폭", WIDTHS, () => widthId, id => { widthId = id; layout(); remember(); }),
);
document.body.append(bar, stage);
document.documentElement.dataset.theme = theme;
frame.addEventListener("load", applyTheme);
new ResizeObserver(layout).observe(stage);
layout();
