import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type HTMLAttributes,
} from "react";

import { cn } from "../lib/cn";
import { useGlassSurface } from "./LiquidGlassProvider";

const SHARED_GLASS_FILTER_ID = "liquid-glass-card-shared-filter-standard";
const SHARED_GLASS_RESOURCE_SELECTOR = '[data-liquid-glass-shared-resource="true"]';
const SHARED_GLASS_DISPLACEMENT_SCALE = 28;
const SHARED_GLASS_BLUR_AMOUNT = 0.02;
const SHARED_GLASS_SATURATION = 125;
const SHARED_GLASS_ABERRATION_INTENSITY = 0.8;
const SHARED_GLASS_ELASTICITY = 0.03;
const SHARED_GLASS_BACKDROP_FILTER = `blur(${4 + SHARED_GLASS_BLUR_AMOUNT * 32}px) saturate(${SHARED_GLASS_SATURATION}%)`;
const SHARED_GLASS_FILTER_URL = `url(#${SHARED_GLASS_FILTER_ID})`;
const SVG_NS = "http://www.w3.org/2000/svg";
const SHARED_DISPLACEMENT_MAP =
  "data:image/jpeg;base64,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cUAUAkEkziomgGgkoxZGgxZFQFQlYnQHRdPfj/10KCSCKESCNiVkViPSLpD0h6I0Q0I0A2IoBWBIJIBKBIJoJIJ2R2J0JWBUJ0JUB0XTv479dFZDYiglYigkhEgjZFQjRFQjRFQjQigFYigHYigmgEgmglYlYnQlQlYlQHQlQnQ9P/kf1yVkNiNCNkNiVENiNiViNEViNkVCVgKCViViViSCViSCVgdCViVCViVCdgVCVCdD1D+U/XBWQ2I0I2Q2JUQ2I0JWQ0I2JUQ2JUI2JUI2J0JWJWJWA2R0BWJ0I2JUJ2BUJUJ0P//EABkQAQEBAQEBAAAAAAAAAAAAAAECABEDEP/aAAgBAQABAgB1atWrVq1atWrVq1atWrVq1atWrVq1atWrVq+OrVq1atWrVq1atWrVq1atWrVq1atWrVq1atXxVppppppdWrVq1atWrVq1NNNNNNNNNNNPVWmmmmms6tWrVq1atWpppppppppppppp6q0000uc51atWrVq1ammmmmmmmmmmmmt1Vpppc5znVq1atWrVqaaaaaaaaaaaaaeqtNLnOc51atWrVq1ammmmmmmmmmmmmnqrS5znOc6tWrVq16222mmmmmmlVppp6tKuc5znOrVq1a9TbbbbTTTTTSq000qtLnOc5zq1atWrW0222200000qqqtKqrnOc5zq1atTbbbbbbbbTTTSqqqqqq5znOc6tTTTbbbbbbbbTTTSqqqqrlVznOctNNNtttttttttNNNNKqqqrqznKqrTTTTbbbbbbbbbTTTSqqqqrqznOc5aaaabbbbbbbbbaaaaVVVVVdWc5znVq1NNttttttttttNNKqqqqudWc5znVq16tbbbbbbbbbbTTSqqqq5XVnOc6tWrVrb1tttttttttNNKqqqqrWrK5VWmmm2230bbbbbbaaaXOc5zlVa1KuVVppptttt9G22222mmlzlVznK6tWVVWmmmm2222222222mlznOc5znLWppVVWmmm22222229bTWrOc5znOcq1qaaVpWmm222222229erVqznOc5znKtatStK0rTbTTbbbberXr1as5znOc5aVpppppWlabaabbbb1ta9WrVnOc5znU0rTTTTTTTTTbTTbbbTWvVq1as5znOdTTStNNNNNNNNNtNNtttN6tWvVq1ZznOrU00rTTTTTTTTTTTTTbTWvVq1atWrOc6tTTTStNNNNNNNNNNtNNtNa9WrVq1Z1Z1NNNNNK1q1NNNNNNNNNNNtNatWrVq1atWrU00000rWrVq1atWrVq1alaaa1atWrVq1NNNammmmla1atWrVq1aterVq16tWrVnVqa1NK1qaaaVX/xAAWEAADAAAAAAAAAAAAAAAAAAAhgJD/2gAIAQEAAz8AaExf/8QAGhEBAQEBAQEBAAAAAAAAAAAAAQISEQADEP/aAAgBAgEBAgDx48ePHjx48ePHjx48ePHjx48ePHjx48ePHj86IiIiIiInjx48ePHjx48IiIiIj0oooooooooRERER73ve60UUUUUUVrWiiiiiihERERER73ve97ooooorRWiiiiihKERERER73ve973RRRRWtFFFFFFCIiIiIiPe973ve60UUVrRRRRRRQiIlCIiI973ve973pRRWiiiiiiiiiiiiiiihEe973ve973RRWtFFFFFFFFFFFFFFFFFFa13ve973WitaKKKKKKKKKKKKKKKKKK1rWtd1rutFa1oooooooooooosssooorWta1rWta1rRRRRRRRRRRZZZZZZZZZWta1rWta1rRRRRRRRRZZZZZZZZZZZZe9a1rWta1rWitaKLLLLLLLLLLLLLLLLL3rWta1rWtFbLLLLLLLLLLLLLLLLLLLL3vWta1rWita1ssssssss+hZZZZZZZZe961rWta0Vre97LLLLLLLLLLLPoWWWWWXrWta1oorWta3ssss+hZZZZ9Cyyyyyyyyiita1orWta1ve9llllllllllllllllFFa0VorWta1ve9llllllllllllllllllFFFaK1rWta1rWiyyyyyyyyyyyyiiiiiiitFFa1rWta1oosoosssssoooosoooorRRRWta1rWta0UUUUUWUUUUUUUUUUUVoooorWta1rWtaKKKKKKmiiiiiiiiiiiiiiitd73ve61oSiiipoqaKKKKKKKKKK0UUUVrve973vREREZoSihEooooorRRRRWtd73ve9EREREREoSiiiiitFllllla73ve9ERERERESiiiiiitH0PoWWWWVrXe96IiIiMoiJRRRRRRWjwlFFllllFFd6IiIiIlCUUUUUUUUUePHjx48ePCIiIiIiIiUUUUUUUUUUUePHjx48ePHjx48ePHjx48IiUUUUUUJRRRX//xAAWEQADAAAAAAAAAAAAAAAAAAABYJD/2gAIAQIBAz8AtEV7/8QAFxEBAQEBAAAAAAAAAAAAAAAAAAECEP/aAAgBAwEBAgCtNNNNNNNNNNNNNNNNNNNNNNNNNNNNNcrTTTTTTTTTTTTTTTTTTTTTTTTTTTTTXKrTTTTTTTU000000000000000000001FVpppppqampqaaaaaaaaaaaaaaaaaaaa5Vaaaaampqampqammmmmmmmmmmlaaaaaaiq0001NTU1NTU1NTTTTTTTTTTSqqtNNNcqtNNSyzU1LNTU1NTTTTTTTTTSqqq001ytNLLLLNTU1NTU1NTbbbTTTTTSqqq001ytNLLLLLNTU1NTU3NttttNNNNNKqq001KrSyyyyyzU1NTU3Nzc02220000qqqqrSqqyyyyyzU1NTU3Nzc3NttttNNNKqqqqqqssssss1NTU3Nzc3NzbbbbTTTSqqqqqqrLLLLLNTU1Nzc3Nzc22220000qqqqqqqqssss1NTU3Nzc3NzbbbbbTTSqqqqqqqqqqzU1NTc3Nzc3Nzbc22000qqqqqqqqqqqtTU3Nzc3Nzc3NtzbTTSqqqqrKqqqqqtNNzc23Nzc3Nzc3NTU1KqqqrKqqqqqtNNNNttzc3Nzc3NzU1NLLLLLKqqqqqqqq0022223Nzc3NzU1NSyyyyyyqqqqqqqrTTbbbbc3Nzc3NTU1LLLLLLKsqqqqqqrTTTTbbbc3Nzc1NTUsssssssqqqqqqrTTTTTbbbTc3NTU1NTUsssssqqqqqqqq0000222023NTU1NTUsssssqqqqqqqq000000003NTU1NTU1LLLLLNKrTSqqqqtNNNNNNtNNTU1NSzUssss00qq0qqqqrTTTTTTTTTU1NTUs1LLLNNNKrTTTSqqq00000000001NTU1LNTU0000qtNNNKqqqtNNNNNNNNTU1NTUs1NNNNNKss1NNNK00qtK0000001NNTU0s000000qq000001NKrStNNNNK1NNNNStNNNNNKqtNNNNNNNK0000000rU0000rTTTTTSq00000rTTTTTTTTTTTTTTTTStNNNNKr/xAAUEQEAAAAAAAAAAAAAAAAAAACg/9oACAEDAQM/AAAf/9k=";

export interface LiquidGlassCardProps extends HTMLAttributes<HTMLDivElement> {
  cornerRadius?: number;
  webglSurface?: boolean;
  [dataAttribute: `data-${string}`]: string | undefined;
}

export function liquidGlassStyle(
  cornerRadius: number,
  style?: CSSProperties,
): CSSProperties {
  return {
    "--liquid-glass-radius": `${cornerRadius}px`,
    ...style,
  } as CSSProperties;
}

function isFirefoxOrSafari(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const isFirefox = ua.includes("firefox");
  const isSafari =
    ua.includes("safari") &&
    !ua.includes("chrome") &&
    !ua.includes("chromium") &&
    !ua.includes("android") &&
    !ua.includes("edg/");
  return isFirefox || isSafari;
}

export function supportsLiquidGlassEnhancement(): boolean {
  if (typeof navigator === "undefined" || isFirefoxOrSafari(navigator.userAgent)) {
    return false;
  }
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  return (
    CSS.supports("backdrop-filter", "blur(1px)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(1px)")
  );
}

function setSvgAttrs(element: SVGElement, attrs: Record<string, string>) {
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
}

function appendSvgElement<T extends SVGElement>(
  parent: SVGElement,
  tagName: string,
  attrs: Record<string, string> = {},
): T {
  const element = document.createElementNS(SVG_NS, tagName) as T;
  setSvgAttrs(element, attrs);
  parent.appendChild(element);
  return element;
}

function appendColorMatrix(parent: SVGElement, attrs: Record<string, string>, values: string) {
  appendSvgElement(parent, "feColorMatrix", {
    ...attrs,
    type: "matrix",
    values,
  });
}

function ensureSharedLiquidGlassResource() {
  if (typeof document === "undefined") return;
  if (document.querySelector(SHARED_GLASS_RESOURCE_SELECTOR)) return;

  const svg = document.createElementNS(SVG_NS, "svg");
  setSvgAttrs(svg, {
    "data-liquid-glass-shared-resource": "true",
    "aria-hidden": "true",
    focusable: "false",
    width: "0",
    height: "0",
  });
  Object.assign(svg.style, {
    position: "absolute",
    width: "0",
    height: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });

  const defs = appendSvgElement(svg, "defs");
  const gradient = appendSvgElement(defs, "radialGradient", {
    id: `${SHARED_GLASS_FILTER_ID}-edge-mask`,
    cx: "50%",
    cy: "50%",
    r: "50%",
  });
  appendSvgElement(gradient, "stop", { offset: "0%", stopColor: "black", stopOpacity: "0" });
  appendSvgElement(gradient, "stop", {
    offset: `${Math.max(30, 80 - SHARED_GLASS_ABERRATION_INTENSITY * 2)}%`,
    stopColor: "black",
    stopOpacity: "0",
  });
  appendSvgElement(gradient, "stop", { offset: "100%", stopColor: "white", stopOpacity: "1" });

  const filter = appendSvgElement(defs, "filter", {
    id: SHARED_GLASS_FILTER_ID,
    x: "-35%",
    y: "-35%",
    width: "170%",
    height: "170%",
    colorInterpolationFilters: "sRGB",
  });
  appendSvgElement(filter, "feImage", {
    x: "0",
    y: "0",
    width: "100%",
    height: "100%",
    result: "DISPLACEMENT_MAP",
    href: SHARED_DISPLACEMENT_MAP,
    preserveAspectRatio: "xMidYMid slice",
  });
  appendColorMatrix(
    filter,
    { in: "DISPLACEMENT_MAP", result: "EDGE_INTENSITY" },
    "0.3 0.3 0.3 0 0 0.3 0.3 0.3 0 0 0.3 0.3 0.3 0 0 0 0 0 1 0",
  );
  const edgeTransfer = appendSvgElement(filter, "feComponentTransfer", {
    in: "EDGE_INTENSITY",
    result: "EDGE_MASK",
  });
  appendSvgElement(edgeTransfer, "feFuncA", {
    type: "discrete",
    tableValues: `0 ${SHARED_GLASS_ABERRATION_INTENSITY * 0.05} 1`,
  });
  appendSvgElement(filter, "feOffset", {
    in: "SourceGraphic",
    dx: "0",
    dy: "0",
    result: "CENTER_ORIGINAL",
  });
  appendSvgElement(filter, "feDisplacementMap", {
    in: "SourceGraphic",
    in2: "DISPLACEMENT_MAP",
    scale: String(SHARED_GLASS_DISPLACEMENT_SCALE * -1),
    xChannelSelector: "R",
    yChannelSelector: "B",
    result: "RED_DISPLACED",
  });
  appendColorMatrix(
    filter,
    { in: "RED_DISPLACED", result: "RED_CHANNEL" },
    "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0",
  );
  appendSvgElement(filter, "feDisplacementMap", {
    in: "SourceGraphic",
    in2: "DISPLACEMENT_MAP",
    scale: String(SHARED_GLASS_DISPLACEMENT_SCALE * (-1 - SHARED_GLASS_ABERRATION_INTENSITY * 0.05)),
    xChannelSelector: "R",
    yChannelSelector: "B",
    result: "GREEN_DISPLACED",
  });
  appendColorMatrix(
    filter,
    { in: "GREEN_DISPLACED", result: "GREEN_CHANNEL" },
    "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0",
  );
  appendSvgElement(filter, "feDisplacementMap", {
    in: "SourceGraphic",
    in2: "DISPLACEMENT_MAP",
    scale: String(SHARED_GLASS_DISPLACEMENT_SCALE * (-1 - SHARED_GLASS_ABERRATION_INTENSITY * 0.1)),
    xChannelSelector: "R",
    yChannelSelector: "B",
    result: "BLUE_DISPLACED",
  });
  appendColorMatrix(
    filter,
    { in: "BLUE_DISPLACED", result: "BLUE_CHANNEL" },
    "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0",
  );
  appendSvgElement(filter, "feBlend", {
    in: "GREEN_CHANNEL",
    in2: "BLUE_CHANNEL",
    mode: "screen",
    result: "GB_COMBINED",
  });
  appendSvgElement(filter, "feBlend", {
    in: "RED_CHANNEL",
    in2: "GB_COMBINED",
    mode: "screen",
    result: "RGB_COMBINED",
  });
  appendSvgElement(filter, "feGaussianBlur", {
    in: "RGB_COMBINED",
    stdDeviation: String(Math.max(0.1, 0.5 - SHARED_GLASS_ABERRATION_INTENSITY * 0.1)),
    result: "ABERRATED_BLURRED",
  });
  appendSvgElement(filter, "feComposite", {
    in: "ABERRATED_BLURRED",
    in2: "EDGE_MASK",
    operator: "in",
    result: "EDGE_ABERRATION",
  });
  const invertedTransfer = appendSvgElement(filter, "feComponentTransfer", {
    in: "EDGE_MASK",
    result: "INVERTED_MASK",
  });
  appendSvgElement(invertedTransfer, "feFuncA", {
    type: "table",
    tableValues: "1 0",
  });
  appendSvgElement(filter, "feComposite", {
    in: "CENTER_ORIGINAL",
    in2: "INVERTED_MASK",
    operator: "in",
    result: "CENTER_CLEAN",
  });
  appendSvgElement(filter, "feComposite", {
    in: "EDGE_ABERRATION",
    in2: "CENTER_CLEAN",
    operator: "over",
  });

  document.body.appendChild(svg);
}

export function LiquidGlassLayer({
  cornerRadius = 18,
  enhanced = supportsLiquidGlassEnhancement(),
}: {
  cornerRadius?: number;
  enhanced?: boolean;
}) {
  useLayoutEffect(() => {
    if (enhanced) ensureSharedLiquidGlassResource();
  }, [enhanced]);

  if (!enhanced) return null;

  const effectStyle = {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "100%",
    height: "100%",
    transform: "translate(calc(-50% + 0px), calc(-50% + 0px)) scale(1)",
    transition: "all ease-out 0.2s",
  } as CSSProperties;
  const glassStyle = {
    borderRadius: `${cornerRadius}px`,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: "24px",
    padding: "0",
    overflow: "hidden",
    transition: "all 0.2s ease-in-out",
    boxShadow: "0px 12px 40px rgba(0, 0, 0, 0.25)",
  } as CSSProperties;
  const warpStyle = {
    filter: SHARED_GLASS_FILTER_URL,
    backdropFilter: SHARED_GLASS_BACKDROP_FILTER,
    WebkitBackdropFilter: SHARED_GLASS_BACKDROP_FILTER,
    position: "absolute",
    inset: "0",
  } as CSSProperties;
  const contentStyle = {
    position: "relative",
    zIndex: 1,
    font: "500 20px/1 system-ui",
    textShadow: "0px 2px 12px rgba(0, 0, 0, 0.4)",
  } as CSSProperties;
  const rimStyle = {
    ...effectStyle,
    borderRadius: `${cornerRadius}px`,
    pointerEvents: "none",
    padding: "1.5px",
    WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    maskComposite: "exclude",
    boxShadow:
      "0 0 0 0.5px rgba(255, 255, 255, 0.5) inset, 0 1px 3px rgba(255, 255, 255, 0.25) inset, 0 1px 4px rgba(0, 0, 0, 0.35)",
  } as CSSProperties;

  return (
    <div className="liquid-glass-card__layer" aria-hidden="true">
      <div className="liquid-glass-card__effect" style={effectStyle}>
        <div className="glass" style={glassStyle}>
          <span className="glass__warp" style={warpStyle} />
          <div className="transition-all duration-150 ease-in-out text-white" style={contentStyle}>
            <span className="liquid-glass-card__fill" />
          </div>
        </div>
      </div>
      <span
        style={{
          ...rimStyle,
          mixBlendMode: "screen",
          opacity: 0.2,
          background:
            "linear-gradient(135deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.12) 33%, rgba(255, 255, 255, 0.4) 66%, rgba(255, 255, 255, 0) 100%)",
        }}
      />
      <span
        style={{
          ...rimStyle,
          mixBlendMode: "overlay",
          background:
            "linear-gradient(135deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.32) 33%, rgba(255, 255, 255, 0.6) 66%, rgba(255, 255, 255, 0) 100%)",
        }}
      />
    </div>
  );
}

export const LiquidGlassCard = forwardRef<HTMLDivElement, LiquidGlassCardProps>(
  function LiquidGlassCard(
    { children, className, cornerRadius = 18, style, webglSurface = false, ...props },
    ref,
  ) {
    const enhanced = supportsLiquidGlassEnhancement();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const setRefs = useCallback((node: HTMLDivElement | null) => {
      rootRef.current = node;
      assignForwardedRef(ref, node);
    }, [ref]);
    const webglActive = useGlassSurface(rootRef, { enabled: webglSurface });

    return (
      <div
        ref={setRefs}
        {...props}
        data-liquid-glass-enhanced={enhanced ? "true" : "false"}
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
        className={cn("liquid-glass-card", className)}
        style={liquidGlassStyle(cornerRadius, style)}
      >
        <LiquidGlassLayer cornerRadius={cornerRadius} enhanced={enhanced && !webglActive} />
        {children}
      </div>
    );
  },
);

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}
