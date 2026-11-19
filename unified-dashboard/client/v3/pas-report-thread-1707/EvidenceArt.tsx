import type { CSSProperties } from "react";
import type { Evidence } from "./pas-report-thread-1707-data";

/** 확인 항목에 붙는 대표 증거. 색과 글자 크기는 전용 CSS의 토큰만 쓴다. */
export function EvidenceArt({ evidence, large = false }: { evidence: Evidence; large?: boolean }) {
  return <div className="pas-rt1707-evidence-art" data-kind={evidence.kind} data-large={large || undefined}>
    {evidence.kind === "range" ? <RangeArt /> : null}
    {evidence.kind === "version" ? <VersionArt /> : null}
    {evidence.kind === "flow" ? <FlowArt /> : null}
    {evidence.kind === "slide" ? <SlideArt /> : null}
    {evidence.kind === "days" ? <DaysArt /> : null}
    <span className="pas-rt1707-evidence-label">{evidence.label}</span>
  </div>;
}

function RangeArt() {
  return <div className="pas-rt1707-chart" role="img" aria-label="최근 30일 완료 142건의 기간별 분포">
    <Bar label="7일" value={62} count="88건" />
    <Bar label="14일" value={89} count="126건" />
    <Bar label="30일" value={100} count="142건" />
  </div>;
}

function Bar({ label, value, count }: { label: string; value: number; count: string }) {
  return <div className="pas-rt1707-bar-row">
    <span className="pas-rt1707-bar-name">{label}</span>
    <span className="pas-rt1707-bar-track"><i style={{ "--pas-rt-bar": `${value}%` } as CSSProperties} /></span>
    <strong className="pas-rt1707-bar-value">{value}%</strong>
    <span className="pas-rt1707-bar-count">{count}</span>
  </div>;
}

function VersionArt() {
  const rows = [
    { label: "앱 버전", before: "0.9.4", after: "0.9.7", changed: true },
    { label: "설치 파일", before: "없음", after: "준비됨", changed: true },
    { label: "사용량 동기화", before: "정상", after: "정상", changed: false },
    { label: "아침 보고", before: "정상", after: "정상", changed: false },
  ];
  return <div className="pas-rt1707-compare" role="img" aria-label="kaleidoscope 앱 0.9.4와 0.9.7 비교">
    <div className="pas-rt1707-compare-head" aria-hidden="true"><span /><span>0.9.4</span><span>0.9.7</span></div>
    {rows.map(row => <div key={row.label} className="pas-rt1707-compare-row" data-changed={row.changed || undefined}>
      <span className="pas-rt1707-compare-label">{row.label}</span>
      <span>{row.before}</span>
      <span>{row.after}</span>
    </div>)}
  </div>;
}

function FlowArt() {
  return <div className="pas-rt1707-flow" role="img" aria-label="접수, 분류, 실행 세 단계 흐름">
    <div className="pas-rt1707-flow-step"><span className="pas-rt1707-flow-number">1</span><strong>접수</strong><small>요청을 카드 한 장으로</small></div>
    <span className="pas-rt1707-flow-arrow" aria-hidden="true">→</span>
    <div className="pas-rt1707-flow-step"><span className="pas-rt1707-flow-number">2</span><strong>분류</strong><small>담당과 검수 방식</small></div>
    <span className="pas-rt1707-flow-arrow" aria-hidden="true">→</span>
    <div className="pas-rt1707-flow-step"><span className="pas-rt1707-flow-number">3</span><strong>실행</strong><small>작업 세션과 결과</small></div>
  </div>;
}

function SlideArt() {
  return <div className="pas-rt1707-slide" role="img" aria-label="장 순서 변경 전과 뒤 비교">
    <div className="pas-rt1707-slide-column">
      <span className="pas-rt1707-slide-caption">바꾸기 전</span>
      <ol className="pas-rt1707-slide-list">
        <li>표지</li><li>본문 1</li><li>본문 2</li><li>마무리</li>
      </ol>
    </div>
    <div className="pas-rt1707-slide-column" data-after>
      <span className="pas-rt1707-slide-caption">바꾼 뒤</span>
      <ol className="pas-rt1707-slide-list">
        <li>표지</li><li>본문 2</li><li>본문 1</li><li>마무리</li>
      </ol>
    </div>
    <p className="pas-rt1707-slide-note">장 사이 여백을 발행 화면과 같은 값으로 올렸습니다.</p>
  </div>;
}

function DaysArt() {
  const rows = [
    { date: "11월 17일", due: "07:00", arrived: "07:00", ok: true },
    { date: "11월 18일", due: "07:00", arrived: "07:01", ok: true },
    { date: "11월 19일", due: "07:00", arrived: "07:00", ok: true },
  ];
  return <div className="pas-rt1707-days" role="img" aria-label="사흘 아침 예약 알림 도착 기록">
    <div className="pas-rt1707-days-head" aria-hidden="true"><span>날짜</span><span>예약</span><span>도착</span><span>상태</span></div>
    {rows.map(row => <div key={row.date} className="pas-rt1707-days-row">
      <span>{row.date}</span><span>{row.due}</span><span>{row.arrived}</span><span data-ok={row.ok || undefined}>{row.ok ? "도착" : "누락"}</span>
    </div>)}
  </div>;
}
