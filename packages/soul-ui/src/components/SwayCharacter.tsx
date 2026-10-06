import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type SwayCharacterProps = {
  width: number;
  height: number;
  shown: boolean;
  motionEnabled: boolean;
  active: boolean;
  assetBaseUrl: string;
};

type HostMessage = { type: "sway-character:ready" | "sway-character:error" };

function getReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function assetUrl(baseUrl: string, filename: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${filename}`;
}

export function SwayCharacter({
  width,
  height,
  shown,
  motionEnabled,
  active,
  assetBaseUrl,
}: SwayCharacterProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [reducedMotion, setReducedMotion] = useState(getReducedMotion);
  const [ready, setReady] = useState(false);
  const [hostFailed, setHostFailed] = useState(false);
  const [stillFailed, setStillFailed] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const motionAllowed = motionEnabled && !reducedMotion;
  const postState = useCallback(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return;
    frameWindow.postMessage({
      type: "sway-character:state",
      shown,
      motionEnabled: motionAllowed,
      active,
    }, window.location.origin);
  }, [active, motionAllowed, shown]);

  useEffect(() => {
    postState();
  }, [postState]);

  useLayoutEffect(() => {
    setReady(false);
    setHostFailed(false);
    setStillFailed(false);
  }, [assetBaseUrl, motionAllowed, shown]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin
        || event.source !== frameRef.current?.contentWindow
        || !event.data || typeof event.data !== "object") return;
      const message = event.data as HostMessage;
      if (message.type === "sway-character:ready") setReady(true);
      if (message.type === "sway-character:error") {
        setReady(false);
        setHostFailed(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!shown || stillFailed) return null;

  const frameEnabled = motionAllowed && !hostFailed;
  const canvasVisible = frameEnabled && ready;
  const frameSrc = assetUrl(assetBaseUrl, "index.html");
  const stillSrc = assetUrl(assetBaseUrl, "still.png");

  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width,
        height,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <img
        alt=""
        draggable={false}
        hidden={canvasVisible}
        onError={() => setStillFailed(true)}
        src={stillSrc}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "bottom",
        }}
      />
      {frameEnabled && (
        <iframe
          ref={frameRef}
          aria-hidden="true"
          frameBorder={0}
          loading="eager"
          onLoad={postState}
          onError={() => setHostFailed(true)}
          src={frameSrc}
          tabIndex={-1}
          title=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            overflow: "hidden",
            pointerEvents: "none",
            opacity: canvasVisible ? 1 : 0,
          }}
        />
      )}
    </div>
  );
}
