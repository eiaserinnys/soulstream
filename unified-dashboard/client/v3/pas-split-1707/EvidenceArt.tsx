import { ArrowRight, Check } from "lucide-react";

import type { EvidenceKind } from "./pas-split-1707-data";

const RANGE_ROWS = [
  { label: "7일", value: 62 },
  { label: "14일", value: 27 },
  { label: "30일", value: 11 },
];

export function EvidenceArt({ kind }: { kind: EvidenceKind }) {
  if (kind === "range") {
    return <div className="pas-evidence-html" data-kind="range">
      {RANGE_ROWS.map(row => <div className="pas-range-row" key={row.label}>
        <span className="pas-range-label">{row.label}</span>
        <span className="pas-range-track"><i style={{ inlineSize: `${row.value}%` }}/></span>
        <span className="pas-range-value">{row.value}%</span>
      </div>)}
    </div>;
  }
  if (kind === "version") {
    return <div className="pas-evidence-html" data-kind="version">
      <div className="pas-version-row"><span>설치본</span><strong>0.9.4</strong><em>업데이트 필요</em></div>
      <div className="pas-version-row"><span>최신</span><strong>0.9.7</strong><em>설치 파일 준비됨</em></div>
      <div className="pas-version-track"><i/><i className="is-target"/></div>
    </div>;
  }
  if (kind === "flow") {
    return <div className="pas-evidence-html" data-kind="flow">
      {["접수", "분류", "실행"].map((step, index) => <div className="pas-flow-step" key={step}>
        <span className="pas-flow-number">{index + 1}</span>
        <strong>{step}</strong>
        {index < 2 ? <ArrowRight className="pas-flow-arrow" aria-hidden="true"/> : null}
      </div>)}
    </div>;
  }
  if (kind === "slide") {
    const rows = (order: number[]) => order.map(number => <span className="pas-slide-line" data-moved={number !== 1 || undefined} key={number}>
      <b>{number}</b><i/>
    </span>);
    return <div className="pas-evidence-html" data-kind="slide">
      <div className="pas-slide-pair">
        <figure><figcaption>변경 전</figcaption><div className="pas-slide-sheet">{rows([1, 2, 3])}</div></figure>
        <figure><figcaption>변경 후</figcaption><div className="pas-slide-sheet">{rows([1, 3, 2])}</div></figure>
      </div>
    </div>;
  }
  return <div className="pas-evidence-html" data-kind="days">
    {["월요일", "화요일", "수요일"].map(day => <div className="pas-days-row" key={day}>
      <span>{day}</span><strong>오전 7:00</strong><Check className="pas-days-check" aria-hidden="true"/>
    </div>)}
  </div>;
}
