import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import {
  BookOpen,
  Layers,
  Database,
  Search,
  GitBranch,
  Presentation,
  Sparkles,
  LayoutGrid,
  Terminal,
  Globe,
  Wrench,
  Plug,
  Users,
  MessageSquare,
  FileText,
  Cloud,
  Shield,
  Cpu,
  Bot,
  Code2,
  Folder,
  Calendar,
  Mail,
  Lock,
} from "lucide-react";
import type { McpIcon, McpServer } from "../../lib/mcp-api";
import "./mcp.css";

export const SYMBOLS = {
  "book-open": BookOpen,
  layers: Layers,
  database: Database,
  search: Search,
  "git-branch": GitBranch,
  presentation: Presentation,
  sparkles: Sparkles,
  "layout-grid": LayoutGrid,
  terminal: Terminal,
  globe: Globe,
  wrench: Wrench,
  plug: Plug,
  users: Users,
  "message-square": MessageSquare,
  "file-text": FileText,
  cloud: Cloud,
  shield: Shield,
  cpu: Cpu,
  bot: Bot,
  "code-2": Code2,
  folder: Folder,
  calendar: Calendar,
  mail: Mail,
  lock: Lock,
};
export const COLORS = [
  "node-user",
  "node-response",
  "node-thinking",
  "node-plan",
  "node-tool",
  "node-intervention",
  "node-input-request",
  "node-system",
];
type Brand = { slug: string; title: string; hex: string };

function luminance(rgb: number[]) {
  return rgb
    .map((c) => {
      const n = c / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
export function brandColors(hex: string) {
  const rgb = (hex.replace("#", "").match(/.{2}/g) ?? ["80", "80", "80"]).map(
    (c) => parseInt(c, 16),
  );
  const l = luminance(rgb);
  if (l < 0.08)
    return {
      bg: "#18181b",
      fg: "#ffffff",
      darkBg: "#f4f4f5",
      darkFg: "#18181b",
    };
  if (l > 0.72)
    return {
      bg: "#18181b",
      fg: `#${hex.replace("#", "")}`,
      darkBg: "#18181b",
      darkFg: `#${hex.replace("#", "")}`,
    };
  const background = rgb.map((c) => c * 0.14 + 24 * 0.86);
  let corrected = rgb;
  for (let step = 0; step <= 100; step += 1) {
    corrected = rgb.map((c) => Math.round(c + ((255 - c) * step) / 100));
    if ((luminance(corrected) + 0.05) / (luminance(background) + 0.05) >= 4.5)
      break;
  }
  return {
    bg: `color-mix(in srgb, #${hex.replace("#", "")} 14%, transparent)`,
    fg: `#${hex.replace("#", "")}`,
    darkBg: `color-mix(in srgb, #${hex.replace("#", "")} 14%, transparent)`,
    darkFg: `rgb(${corrected.join(" ")})`,
  };
}

export function McpIconTile({
  id,
  icon,
}: {
  id: string;
  icon: McpIcon | null;
}) {
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const tile = useRef<HTMLSpanElement>(null);
  const url =
    icon?.kind === "brand"
      ? `/brand-icons/icons/${encodeURIComponent(icon.slug)}.svg`
      : icon?.kind === "upload"
        ? (icon.url ??
          `/api/mcp/server-icons/${encodeURIComponent(icon.ref)}?v=${encodeURIComponent(icon.content_hash)}`)
        : "";
  useEffect(() => {
    if (!tile.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(tile.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setReady(false);
    if (!url || !visible) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (active) setReady(true);
    };
    image.onerror = () => {
      if (active) setReady(false);
    };
    image.src = url;
    return () => {
      active = false;
    };
  }, [url, visible]);
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = COLORS[hash % COLORS.length];
  const SymbolIcon =
    icon?.kind === "symbol" ? SYMBOLS[icon.name as keyof typeof SYMBOLS] : null;
  const brand = icon?.kind === "brand" && ready ? brandColors(icon.hex) : null;
  const style = brand
    ? ({
        "--mcp-bg": brand.bg,
        "--mcp-fg": brand.fg,
        "--mcp-dark-bg": brand.darkBg,
        "--mcp-dark-fg": brand.darkFg,
      } as CSSProperties)
    : ({
        "--mcp-color": `var(--${icon?.kind === "symbol" ? icon.color : color})`,
      } as CSSProperties);
  return (
    <span
      ref={tile}
      className={`mcp-icon${brand ? " mcp-icon-brand" : ""}`}
      style={style}
      aria-hidden="true"
    >
      {brand ? (
        <span
          className="mcp-icon-mask"
          style={{
            maskImage: `url("${url}")`,
            WebkitMaskImage: `url("${url}")`,
          }}
        />
      ) : icon?.kind === "upload" && ready ? (
        <img src={url} alt="" />
      ) : SymbolIcon ? (
        <SymbolIcon size={16} />
      ) : (
        id.slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

export function McpServerIcons({
  ids,
  servers,
  limit = 4,
}: {
  ids: string[];
  servers: McpServer[];
  limit?: number;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {ids.slice(0, limit).map((id) => (
        <McpIconTile
          key={id}
          id={id}
          icon={servers.find((server) => server.id === id)?.icon ?? null}
        />
      ))}
      {ids.length > limit ? (
        <span className="text-xs text-muted-foreground">
          +{ids.length - limit}
        </span>
      ) : null}
    </span>
  );
}

export function McpIconPicker({
  id,
  name,
  url,
  value,
  onChange,
  upload,
}: {
  id: string;
  name: string;
  url: string;
  value: McpIcon | null;
  onChange(icon: McpIcon | null): void;
  upload(file: File): Promise<McpIcon>;
}) {
  const [mode, setMode] = useState<"brand" | "symbol" | "upload" | "initial">(
    "brand",
  );
  const [brands, setBrands] = useState<Brand[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/brand-icons/index.json", { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<Brand[]>;
      })
      .then((items) => {
        if (active) setBrands(items);
      })
      .catch(() => {
        if (active) setError("브랜드 목록을 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, []);
  const suggestions = useMemo(() => {
    let host = "";
    try {
      host = new URL(url).hostname.split(".")[0];
    } catch {
      /* 입력 중인 주소 */
    }
    const terms = [id, name, host]
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(Boolean);
    return brands.filter((item) => terms.includes(item.slug)).slice(0, 3);
  }, [brands, id, name, url]);
  const found = search.trim()
    ? brands
        .filter((item) =>
          `${item.title} ${item.slug}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .slice(0, 18)
    : suggestions;
  return (
    <div className="space-y-3 rounded-floor bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <McpIconTile id={id || "M"} icon={value} />
        {(
          [
            ["brand", "브랜드 검색"],
            ["symbol", "기호 고르기"],
            ["upload", "이미지 올리기"],
            ["initial", "머리글자로 두기"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            type="button"
            variant={mode === key ? "secondary" : "ghost"}
            onClick={() => {
              setMode(key);
              setError("");
              if (key === "initial") onChange(null);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {mode === "brand" ? (
        <div className="space-y-2">
          <Input
            autoFocus
            aria-label="브랜드 이름 검색"
            placeholder="브랜드 이름 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {!search && suggestions.length ? (
            <p className="text-sm text-muted-foreground">자동 제안</p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {found.map((item) => (
              <Button
                key={item.slug}
                type="button"
                variant="outline"
                onClick={() =>
                  onChange({
                    kind: "brand",
                    slug: item.slug,
                    hex: `#${item.hex}`,
                  })
                }
              >
                <McpIconTile
                  id={item.slug}
                  icon={{ kind: "brand", slug: item.slug, hex: `#${item.hex}` }}
                />
                {item.title}
              </Button>
            ))}
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
      {mode === "symbol" ? (
        <div className="space-y-2">
          <div className="grid grid-cols-6 gap-1 lg:grid-cols-12">
            {Object.entries(SYMBOLS).map(([key, Icon]) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                aria-label={key}
                aria-pressed={value?.kind === "symbol" && value.name === key}
                onClick={() =>
                  onChange({
                    kind: "symbol",
                    name: key,
                    color: value?.kind === "symbol" ? value.color : COLORS[0],
                  })
                }
              >
                <Icon size={16} />
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((color) => (
              <button
                className="mcp-color"
                style={{ background: `var(--${color})` }}
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={value?.kind === "symbol" && value.color === color}
                onClick={() =>
                  onChange({
                    kind: "symbol",
                    name: value?.kind === "symbol" ? value.name : "plug",
                    color,
                  })
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      {mode === "upload" ? (
        <label className="block text-sm">
          PNG, JPEG, WebP · 최대 256 KiB, 512 × 512
          <Input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                setError("");
                void upload(file)
                  .then(onChange)
                  .catch(() =>
                    setError(
                      "이미지를 올리지 못했습니다. 크기와 형식을 확인하세요.",
                    ),
                  );
              }
            }}
          />
          {error ? <span role="alert">{error}</span> : null}
        </label>
      ) : null}
    </div>
  );
}
