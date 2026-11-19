import type { EvidenceId } from "./approval-desk-data";

/** 시안용 증거 그림. 실제 첨부 대신 같은 정보를 도식으로 보여 준다. */
export function EvidenceArt({ id }: { id: EvidenceId }) {
  return <svg className="ad1707-art" viewBox="0 0 320 180" role="img" aria-hidden="true">
    {id === "chips" ? <ChipsArt /> : null}
    {id === "architecture" ? <ArchitectureArt /> : null}
    {id === "stages" ? <StagesArt /> : null}
    {id === "slide-before" ? <SlideArt after={false} /> : null}
    {id === "slide-after" ? <SlideArt after /> : null}
    {id === "tree" ? <TreeArt /> : null}
  </svg>;
}

function ChipsArt() {
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <g>
      <rect className="ad1707-art-accent-fill" x="28" y="28" width="84" height="26" rx="13" />
      <text className="ad1707-art-text" x="70" y="45" textAnchor="middle">최근 7일</text>
      <rect className="ad1707-art-line" x="120" y="28" width="68" height="26" rx="13" />
      <text className="ad1707-art-muted" x="154" y="45" textAnchor="middle">오늘만</text>
      <rect className="ad1707-art-line" x="196" y="28" width="80" height="26" rx="13" />
      <text className="ad1707-art-muted" x="236" y="45" textAnchor="middle">전체 표시</text>
    </g>
    {[0, 1, 2, 3].map(index => <g key={index}>
      <rect className="ad1707-art-line" x="28" y={70 + index * 22} width="264" height="16" rx="4" />
      <rect className="ad1707-art-accent-fill" x="28" y={70 + index * 22} width={[188, 224, 148, 204][index]} height="16" rx="4" opacity={0.28} />
      <circle className="ad1707-art-accent-fill" cx="42" cy={78 + index * 22} r="4" />
    </g>)}
  </>;
}

function ArchitectureArt() {
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <rect className="ad1707-art-line" x="24" y="56" width="72" height="44" rx="8" />
    <text className="ad1707-art-text" x="60" y="82" textAnchor="middle">대화 턴</text>
    <rect className="ad1707-art-accent-fill" x="124" y="56" width="72" height="44" rx="8" opacity={0.24} />
    <rect className="ad1707-art-accent" x="124" y="56" width="72" height="44" rx="8" />
    <text className="ad1707-art-text" x="160" y="82" textAnchor="middle">입력 큐</text>
    <rect className="ad1707-art-line" x="224" y="56" width="72" height="44" rx="8" />
    <text className="ad1707-art-text" x="260" y="82" textAnchor="middle">세션 스트림</text>
    <path className="ad1707-art-arrow" d="M96 78 H118" />
    <path className="ad1707-art-arrow" d="M196 78 H218" />
    <rect className="ad1707-art-line" x="60" y="124" width="200" height="20" rx="10" />
    <text className="ad1707-art-muted" x="160" y="138" textAnchor="middle">턴 잠금은 세션 스트림에서 풀린다</text>
  </>;
}

function StagesArt() {
  const stages = [
    { title: "1 입력 큐", note: "변경 작음" },
    { title: "2 실행 중단", note: "검증 필요" },
    { title: "3 재개 저장", note: "범위 큼" },
  ];
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    {stages.map((stage, index) => {
      const x = 24 + index * 94;
      return <g key={stage.title}>
        <rect className={index === 0 ? "ad1707-art-accent-fill" : "ad1707-art-line"} x={x} y="40" width="80" height="64" rx="8" opacity={index === 0 ? 0.24 : 1} />
        <text className="ad1707-art-text" x={x + 40} y="66" textAnchor="middle">{stage.title}</text>
        <text className="ad1707-art-muted" x={x + 40} y="86" textAnchor="middle">{stage.note}</text>
        {index < 2 ? <path className="ad1707-art-arrow" d={`M${x + 84} 72 H${x + 90}`} /> : null}
      </g>;
    })}
    <rect className="ad1707-art-line" x="24" y="122" width="272" height="18" rx="9" />
    <rect className="ad1707-art-accent-fill" x="24" y="122" width="96" height="18" rx="9" opacity={0.5} />
    <text className="ad1707-art-muted" x="160" y="136" textAnchor="middle">첫 단계부터 검증한다</text>
  </>;
}

function SlideArt({ after }: { after: boolean }) {
  const lines = after ? [86, 106, 126] : [84, 98, 112];
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <rect className="ad1707-art-line" x="24" y="24" width="272" height="132" rx="6" />
    <rect className="ad1707-art-accent-fill" x="40" y="40" width="132" height="16" rx="4" opacity={0.32} />
    {lines.map((y, index) => <rect key={y} className="ad1707-art-line" x="40" y={y} width={[180, 148, 204][index]} height="8" rx="4" />)}
    {after ? <>
      <rect className="ad1707-art-accent" x="212" y="40" width="24" height="18" rx="4" />
      <rect className="ad1707-art-line" x="242" y="40" width="24" height="18" rx="4" />
      <rect className="ad1707-art-line" x="212" y="132" width="54" height="14" rx="7" />
      <text className="ad1707-art-muted" x="239" y="142" textAnchor="middle">순서</text>
    </> : <text className="ad1707-art-muted" x="240" y="48" textAnchor="middle">조작 없음</text>}
  </>;
}

function TreeArt() {
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <rect className="ad1707-art-line" x="24" y="72" width="78" height="34" rx="8" />
    <text className="ad1707-art-text" x="63" y="93" textAnchor="middle">할 일</text>
    <path className="ad1707-art-arrow" d="M102 89 H140 V52 H176" />
    <path className="ad1707-art-arrow" d="M102 89 H140 V126 H176" />
    <rect className="ad1707-art-accent-fill" x="176" y="36" width="112" height="32" rx="8" opacity={0.24} />
    <rect className="ad1707-art-accent" x="176" y="36" width="112" height="32" rx="8" />
    <text className="ad1707-art-text" x="232" y="56" textAnchor="middle">아침 예약</text>
    <rect className="ad1707-art-line" x="176" y="110" width="112" height="32" rx="8" />
    <text className="ad1707-art-text" x="232" y="130" textAnchor="middle">알림</text>
  </>;
}
