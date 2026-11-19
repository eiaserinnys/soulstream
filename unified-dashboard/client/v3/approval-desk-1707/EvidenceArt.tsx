import type { EvidenceId } from "./approval-desk-data";

/** 시안용 증거 그림. 실제 첨부 대신 결정에 쓰인 수치와 구조를 도식으로 보여 준다. */
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
      <rect className="ad1707-art-accent-fill" x="24" y="24" width="82" height="24" rx="12" />
      <text className="ad1707-art-text" x="65" y="40" textAnchor="middle">최근 7일</text>
      <rect className="ad1707-art-line" x="114" y="24" width="64" height="24" rx="12" />
      <text className="ad1707-art-muted" x="146" y="40" textAnchor="middle">오늘만</text>
      <rect className="ad1707-art-line" x="186" y="24" width="76" height="24" rx="12" />
      <text className="ad1707-art-muted" x="224" y="40" textAnchor="middle">전체 표시</text>
    </g>
    <g>
      <text className="ad1707-art-value" x="24" y="92">18</text>
      <text className="ad1707-art-unit" x="56" y="92">건</text>
      <text className="ad1707-art-label" x="24" y="108">최근 7일</text>
      <text className="ad1707-art-value" x="118" y="92">412</text>
      <text className="ad1707-art-unit" x="158" y="92">건</text>
      <text className="ad1707-art-label" x="118" y="108">전체</text>
      <text className="ad1707-art-value ad1707-art-accent-text" x="222" y="92">62%</text>
      <text className="ad1707-art-label" x="222" y="108">최근 7일 선택</text>
    </g>
    <rect className="ad1707-art-line" x="24" y="124" width="272" height="10" rx="5" />
    <rect className="ad1707-art-accent-fill" x="24" y="124" width="62" height="10" rx="5" opacity={0.55} />
    <text className="ad1707-art-muted" x="24" y="152">18건을 고르면 목록이 짧고, 412건은 첫 화면을 넘깁니다.</text>
  </>;
}

function ArchitectureArt() {
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <rect className="ad1707-art-line" x="24" y="30" width="72" height="40" rx="8" />
    <text className="ad1707-art-text" x="60" y="54" textAnchor="middle">대화 턴</text>
    <rect className="ad1707-art-accent-fill" x="124" y="30" width="72" height="40" rx="8" opacity={0.24} />
    <rect className="ad1707-art-accent" x="124" y="30" width="72" height="40" rx="8" />
    <text className="ad1707-art-text" x="160" y="54" textAnchor="middle">입력 큐</text>
    <rect className="ad1707-art-line" x="224" y="30" width="72" height="40" rx="8" />
    <text className="ad1707-art-text" x="260" y="54" textAnchor="middle">세션 스트림</text>
    <path className="ad1707-art-arrow" d="M96 50 H118" />
    <path className="ad1707-art-arrow" d="M196 50 H218" />
    <rect className="ad1707-art-line" x="24" y="88" width="128" height="40" rx="8" />
    <text className="ad1707-art-value" x="40" y="114">0</text>
    <text className="ad1707-art-unit" x="56" y="114">건</text>
    <text className="ad1707-art-label" x="78" y="114">차단 MCP</text>
    <rect className="ad1707-art-line" x="164" y="88" width="132" height="40" rx="8" />
    <text className="ad1707-art-value" x="180" y="114">0</text>
    <text className="ad1707-art-unit" x="196" y="114">달러</text>
    <text className="ad1707-art-label" x="226" y="114">추가 요금</text>
    <text className="ad1707-art-muted" x="24" y="152">입력 큐 삽입은 기존 MCP 호출을 막지 않습니다.</text>
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
        <rect className={index === 0 ? "ad1707-art-accent-fill" : "ad1707-art-line"} x={x} y="34" width="80" height="64" rx="8" opacity={index === 0 ? 0.24 : 1} />
        <text className="ad1707-art-text" x={x + 40} y="60" textAnchor="middle">{stage.title}</text>
        <text className="ad1707-art-muted" x={x + 40} y="80" textAnchor="middle">{stage.note}</text>
        {index < 2 ? <path className="ad1707-art-arrow" d={`M${x + 84} 66 H${x + 90}`} /> : null}
      </g>;
    })}
    <rect className="ad1707-art-line" x="24" y="116" width="272" height="18" rx="9" />
    <rect className="ad1707-art-accent-fill" x="24" y="116" width="90" height="18" rx="9" opacity={0.5} />
    <text className="ad1707-art-muted" x="24" y="152">1단계 배포 뒤 일주일 동안 입력 큐가 비는 시간을 잽니다.</text>
  </>;
}

function SlideArt({ after }: { after: boolean }) {
  const lines = after ? [76, 98, 120] : [82, 96, 110];
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <rect className="ad1707-art-line" x="24" y="24" width="272" height="112" rx="6" />
    <rect className="ad1707-art-accent-fill" x="40" y="38" width="120" height="14" rx="4" opacity={0.32} />
    {lines.map((y, index) => <rect key={y} className="ad1707-art-line" x="40" y={y} width={[176, 142, 198][index]} height="7" rx="3.5" />)}
    {after ? <>
      <rect className="ad1707-art-accent" x="212" y="38" width="22" height="16" rx="4" />
      <rect className="ad1707-art-line" x="240" y="38" width="22" height="16" rx="4" />
      <text className="ad1707-art-value ad1707-art-accent-text" x="212" y="92">1.55</text>
      <text className="ad1707-art-label" x="212" y="108">줄간격</text>
      <text className="ad1707-art-muted" x="212" y="124">순서 단추 보임</text>
    </> : <>
      <text className="ad1707-art-value" x="212" y="92">1.32</text>
      <text className="ad1707-art-label" x="212" y="108">줄간격</text>
      <text className="ad1707-art-muted" x="212" y="124">순서 단추 없음</text>
    </>}
    <text className="ad1707-art-muted" x="24" y="152">{after ? "보정 뒤" : "보정 전"} 본문 줄간격과 장 조작 단추</text>
  </>;
}

function TreeArt() {
  const days = ["월", "화", "수", "목", "금", "토", "일"];
  return <>
    <rect className="ad1707-art-surface" x="12" y="12" width="296" height="156" rx="10" />
    <rect className="ad1707-art-line" x="24" y="72" width="70" height="30" rx="8" />
    <text className="ad1707-art-text" x="59" y="91" textAnchor="middle">할 일</text>
    <path className="ad1707-art-arrow" d="M94 87 H124 V46 H152" />
    <path className="ad1707-art-arrow" d="M94 87 H124 V122 H152" />
    <rect className="ad1707-art-accent-fill" x="152" y="30" width="144" height="32" rx="8" opacity={0.24} />
    <rect className="ad1707-art-accent" x="152" y="30" width="144" height="32" rx="8" />
    <text className="ad1707-art-text" x="224" y="50" textAnchor="middle">평일 08:30 예약</text>
    <rect className="ad1707-art-line" x="152" y="106" width="144" height="32" rx="8" />
    <text className="ad1707-art-text" x="224" y="126" textAnchor="middle">주말 제외</text>
    {days.map((day, index) => {
      const weekend = index >= 5;
      return <g key={day}>
        <rect className={weekend ? "ad1707-art-line" : "ad1707-art-accent-fill"} x={24 + index * 38} y="146" width="30" height="16" rx="4" opacity={weekend ? 1 : 0.28} />
        <text className={weekend ? "ad1707-art-muted" : "ad1707-art-text"} x={39 + index * 38} y="158" textAnchor="middle">{day}</text>
      </g>;
    })}
  </>;
}
