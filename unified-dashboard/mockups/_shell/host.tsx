import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@seosoyoung/soul-ui";
import "./mockup.css";
import "../../client/v3/v3-card-board.css";
import "./host.css";

const WIDTHS = [
  { id: "fit", label: "맞춤", width: 0 },
  { id: "phone", label: "휴대폰", width: 390 },
  { id: "tablet", label: "태블릿", width: 820 },
  { id: "desktop", label: "데스크톱", width: 1440 },
] as const;
type WidthId = typeof WIDTHS[number]["id"];
type Theme = "light" | "dark";

function ToggleGroup<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="v3-completed-periods" role="group" aria-label={label}>
      {items.map(item => (
        <Button
          key={item.id}
          size="sm"
          variant="ghost"
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

function MockupHost() {
  const [theme, setTheme] = useState<Theme>(() => {
    const requested = new URLSearchParams(window.location.search).get("theme");
    return requested === "light" || requested === "dark"
      ? requested
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [widthId, setWidthId] = useState<WidthId>(() => {
    const requested = new URLSearchParams(window.location.search).get("w");
    return WIDTHS.find(item => item.id === requested)?.id ?? "fit";
  });
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const glass = new URLSearchParams(window.location.search).get("glass");
  const [frameSrc] = useState(() => {
    const params = new URLSearchParams({ theme });
    if (glass) params.set("glass", glass);
    return "./frame.html?" + params.toString();
  });

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    frameRef.current?.contentWindow?.postMessage(
      { type: "mockup:theme", theme },
      window.location.origin,
    );
  }, [theme]);

  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const frame = frameRef.current!;
    const target = WIDTHS.find(item => item.id === widthId)!.width;
    const layout = () => {
      const available = { width: stage.clientWidth, height: stage.clientHeight };
      const width = target || available.width;
      const scale = Math.min(1, available.width / width);
      frame.style.width = String(width) + "px";
      frame.style.height = String(available.height / scale) + "px";
      frame.style.transform = scale < 1 ? "scale(" + scale + ")" : "";
    };
    const observer = new ResizeObserver(layout);
    observer.observe(stage);
    layout();
    return () => observer.disconnect();
  }, [widthId]);

  const remember = (nextTheme: Theme, nextWidth: WidthId) => {
    const next = new URLSearchParams(window.location.search);
    next.set("theme", nextTheme);
    next.set("w", nextWidth);
    window.history.replaceState(null, "", "?" + next.toString());
  };

  const syncFrameTheme = () => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "mockup:theme", theme },
      window.location.origin,
    );
  };

  return (
    <div className="v3-shell mockup-host text-foreground">
      <header className="v3-detail-section-head mockup-host-header">
        <h2 className="mockup-host-title">{document.title}</h2>
        <ToggleGroup
          label="테마"
          items={[{ id: "light", label: "밝게" }, { id: "dark", label: "어둡게" }]}
          value={theme}
          onChange={next => {
            setTheme(next);
            remember(next, widthId);
          }}
        />
        <ToggleGroup
          label="화면 폭"
          items={WIDTHS}
          value={widthId}
          onChange={next => {
            setWidthId(next);
            remember(theme, next);
          }}
        />
      </header>
      <div className="mockup-host-stage" ref={stageRef}>
        <iframe
          ref={frameRef}
          className="mockup-host-frame"
          title={document.title}
          src={frameSrc}
          onLoad={syncFrameTheme}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<MockupHost />);
