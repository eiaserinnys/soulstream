import { ArrowRight, Check } from "lucide-react";

import type { EvidenceKind } from "./pas-report-overview-1707-data";

const RANGE_ROWS = [
  { label: "최근 7일", value: 62, count: 88 },
  { label: "최근 14일", value: 27, count: 38 },
  { label: "전체 기간", value: 11, count: 16 },
];

/** 대표 시각 증거. 도형과 글자 크기는 전용 CSS의 토큰만 쓴다. */
export function OverviewEvidenceArt({ kind }: { kind: EvidenceKind }) {
  if (kind === "range") {
    return <div className="pas-ro1707-art" data-kind="range">
      <p className="pas-ro1707-art-total">최근 30일 완료 <strong>142건</strong></p>
      {RANGE_ROWS.map(row => <div className="pas-ro1707-range-row" key={row.label}>
        <span className="pas-ro1707-range-label">{row.label}</span>
        <span className="pas-ro1707-range-track"><i style={{ inlineSize: `${row.value}%` }} /></span>
        <span className="pas-ro1707-range-value">{row.count}건, {row.value}%</span>
      </div>)}
    </div>;
  }
  if (kind === "version") {
    return <div className="pas-ro1707-art" data-kind="version">
      <div className="pas-ro1707-version-row">
        <span>설치본</span><strong>0.9.4</strong><em>업데이트 필요</em>
      </div>
      <div className="pas-ro1707-version-row">
        <span>최신</span><strong>0.9.7</strong><em>설치 파일 준비됨</em>
      </div>
      <div className="pas-ro1707-version-track" aria-hidden="true"><i /><i className="is-target" /></div>
    </div>;
  }
  if (kind === "flow") {
    return <div className="pas-ro1707-art" data-kind="flow">
      {["접수", "분류", "실행"].map((step, index) => <div className="pas-ro1707-flow-step" key={step}>
        <span className="pas-ro1707-flow-number">{index + 1}</span>
        <strong>{step}</strong>
        {index < 2 ? <ArrowRight className="pas-ro1707-flow-arrow" aria-hidden="true" /> : null}
      </div>)}
    </div>;
  }
  if (kind === "slide") {
    return <div className="pas-ro1707-art" data-kind="slide">
      <div className="pas-ro1707-slide-pair">
        <figure>
          <figcaption>변경 전</figcaption>
          <div className="pas-ro1707-slide-sheet">
            {[1, 2, 3].map(number => <span className="pas-ro1707-slide-line" key={number}><b>{number}</b><i /></span>)}
          </div>
        </figure>
        <figure>
          <figcaption>변경 후</figcaption>
          <div className="pas-ro1707-slide-sheet">
            {[1, 3, 2].map(number => <span className="pas-ro1707-slide-line" data-moved={number === 3 || undefined} key={number}><b>{number}</b><i /></span>)}
          </div>
        </figure>
      </div>
      <p className="pas-ro1707-art-note">줄간격 1.6, 발행 미리보기와 같습니다.</p>
    </div>;
  }
  return <div className="pas-ro1707-art" data-kind="days">
    {[
      { day: "11월 17일", time: "오전 7:00" },
      { day: "11월 18일", time: "오전 7:00" },
      { day: "11월 19일", time: "오전 7:00" },
    ].map(row => <div className="pas-ro1707-days-row" key={row.day}>
      <span>{row.day}</span><strong>{row.time}</strong><Check className="pas-ro1707-days-check" aria-hidden="true" /><span>도착</span>
    </div>)}
  </div>;
}
