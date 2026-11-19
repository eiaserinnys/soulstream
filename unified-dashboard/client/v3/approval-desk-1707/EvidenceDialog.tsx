import { useEffect, useRef } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { X } from "lucide-react";
import { EvidenceArt } from "./EvidenceArt";
import type { EvidenceSpec } from "./approval-desk-data";

/** 증거 그림 확대 창. Esc와 닫기 단추로 닫히고 초점은 연 자리로 돌아간다. */
export function EvidenceDialog({ evidence, onClose }: { evidence: EvidenceSpec | null; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (evidence && !dialog.open) dialog.showModal();
    if (!evidence && dialog.open) dialog.close();
  }, [evidence]);
  return <dialog ref={ref} className="ad1707-evidence-dialog glass-strong glass-chrome lg-rim"
    aria-label={evidence ? `${evidence.caption} 확대` : "증거 확대"}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    {evidence ? <div className="ad1707-evidence-dialog-body">
      <header className="ad1707-dialog-head">
        <div>
          <h2>{evidence.caption}</h2>
          <p>{evidence.note}</p>
        </div>
        <DashboardIconCap label="증거 닫기" onClick={onClose}><X className="size-5" strokeWidth={1.4} absoluteStrokeWidth /></DashboardIconCap>
      </header>
      <div className="ad1707-evidence-large"><EvidenceArt id={evidence.id} /></div>
    </div> : null}
  </dialog>;
}
