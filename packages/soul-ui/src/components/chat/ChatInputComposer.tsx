import { useRef, type ReactNode } from "react";
import { useGlassSurface } from "../LiquidGlassProvider";

/** The existing chat composer frame, shared without sizing overrides. */
export function ChatInputComposer({children}:{children:ReactNode}) {
 const ref=useRef<HTMLDivElement>(null);
 const webglActive=useGlassSurface(ref,{enabled:true});
 return <div ref={ref} data-slot="chat-input-composer"
  className="relative flex items-end gap-2 rounded-[25px] border border-glass-border glass-strong glass-shadow-md px-2 py-2 ring-ring/50 transition-shadow has-focus-visible:ring-[3px]"
  data-liquid-glass-webgl={webglActive?"true":undefined}>{children}</div>;
}
