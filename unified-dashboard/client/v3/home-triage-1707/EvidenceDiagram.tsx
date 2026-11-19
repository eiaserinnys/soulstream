// 근거 그림. 추상 막대 대신 실제 검수 대상(기간 칩, 앱 업데이트 목록, 3단계 흐름,
// 줄간격 전후, 아침 알림 기록)을 인라인 SVG 로 그린다. 색은 currentColor 와 v3 토큰만 쓴다.
import type { ReactElement } from "react";

import type { EvidenceDiagramKind } from "./triage-data";

const LABEL: Record<EvidenceDiagramKind, string> = {
  "period-chips": "기간 칩 비교 도식",
  "app-updates": "앱 업데이트 목록 도식",
  "interaction-steps": "3단계 도입 표 도식",
  "interaction-flow": "개입 시점 흐름 도식",
  "line-height": "줄간격 보정 전후 도식",
  "narrow-width": "좁은 폭 줄간격 도식",
  "morning-alerts": "아침 예약 알림 도식",
};

function PeriodChips() {
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">기간 칩</text>
      <rect className="v3-ht-diagram-box" x="16" y="36" width="88" height="30" rx="15" />
      <rect className="v3-ht-diagram-box--accent" x="116" y="36" width="88" height="30" rx="15" />
      <rect className="v3-ht-diagram-box" x="216" y="36" width="88" height="30" rx="15" />
      <text x="60" y="51" textAnchor="middle" dominantBaseline="central">오늘</text>
      <text className="v3-ht-diagram-accent-text" x="160" y="51" textAnchor="middle" dominantBaseline="central">최근 7일</text>
      <text x="260" y="51" textAnchor="middle" dominantBaseline="central">최근 30일</text>
      <circle className="v3-ht-diagram-stroke--accent" cx="160" cy="82" r="7" />
      <path className="v3-ht-diagram-stroke--accent" d="M156 82 l3 3 l6 -6" />
      <text className="v3-ht-diagram-accent-text" x="160" y="105" textAnchor="middle">기본 선택</text>
      <rect className="v3-ht-diagram-fill" x="16" y="120" width="288" height="10" rx="5" />
      <rect className="v3-ht-diagram-fill" x="16" y="138" width="240" height="10" rx="5" />
      <rect className="v3-ht-diagram-fill" x="16" y="156" width="200" height="10" rx="5" />
    </g>
  );
}

function AppUpdates() {
  const rows: readonly [string, string][] = [
    ["사용량", "1.8"],
    ["문서 편집", "2.4"],
    ["알림 설정", "0.9"],
  ];
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">앱스토어 목록</text>
      <text className="v3-ht-diagram-muted" x="304" y="22" textAnchor="end">3개</text>
      {rows.map(([name, version], index) => {
        const y = 34 + index * 42;
        return (
          <g key={name}>
            <rect className="v3-ht-diagram-box" x="16" y={y} width="288" height="34" rx="8" />
            <text x="28" y={y + 17} dominantBaseline="central">{name}</text>
            <text className="v3-ht-diagram-muted" x="150" y={y + 17} dominantBaseline="central">버전 {version}</text>
            <rect className="v3-ht-diagram-box--accent" x="236" y={y + 8} width="60" height="18" rx="9" />
            <text className="v3-ht-diagram-accent-text" x="266" y={y + 17} textAnchor="middle" dominantBaseline="central">업데이트</text>
          </g>
        );
      })}
    </g>
  );
}

function InteractionSteps() {
  const columns: readonly [string, string][] = [
    ["입력 잠금", "해제"],
    ["도구 실행 중", "개입"],
    ["재시작", "복구"],
  ];
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">3단계 도입</text>
      {columns.map(([first, second], index) => {
        const x = 16 + index * 100;
        return (
          <g key={first}>
            <rect className="v3-ht-diagram-box" x={x} y="34" width="88" height="100" rx="8" />
            <circle className="v3-ht-diagram-box--accent" cx={x + 44} cy="54" r="9" />
            <text className="v3-ht-diagram-accent-text" x={x + 44} y="54" textAnchor="middle" dominantBaseline="central">{index + 1}</text>
            <text x={x + 44} y="88" textAnchor="middle">{first}</text>
            <text x={x + 44} y="106" textAnchor="middle">{second}</text>
          </g>
        );
      })}
      <path className="v3-ht-diagram-stroke" d="M106 80 l6 4 l-6 4" />
      <path className="v3-ht-diagram-stroke" d="M206 80 l6 4 l-6 4" />
      <text className="v3-ht-diagram-muted" x="160" y="158" textAnchor="middle">경계는 입력 큐 적재 시점</text>
    </g>
  );
}

function InteractionFlow() {
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">개입 시점</text>
      <rect className="v3-ht-diagram-box" x="16" y="44" width="80" height="32" rx="8" />
      <rect className="v3-ht-diagram-box--accent" x="120" y="44" width="80" height="32" rx="8" />
      <rect className="v3-ht-diagram-box" x="224" y="44" width="80" height="32" rx="8" />
      <text x="56" y="60" textAnchor="middle" dominantBaseline="central">사용자 입력</text>
      <text className="v3-ht-diagram-accent-text" x="160" y="60" textAnchor="middle" dominantBaseline="central">큐 적재</text>
      <text x="264" y="60" textAnchor="middle" dominantBaseline="central">도구 실행</text>
      <path className="v3-ht-diagram-stroke" d="M96 56 l6 4 l-6 4" />
      <path className="v3-ht-diagram-stroke" d="M200 56 l6 4 l-6 4" />
      <path className="v3-ht-diagram-stroke--accent" d="M160 76 v18" />
      <path className="v3-ht-diagram-stroke--accent" d="M155 90 l5 6 l5 -6" />
      <rect className="v3-ht-diagram-box--accent" x="120" y="100" width="80" height="32" rx="8" />
      <text className="v3-ht-diagram-accent-text" x="160" y="116" textAnchor="middle" dominantBaseline="central">개입</text>
      <text className="v3-ht-diagram-muted" x="160" y="158" textAnchor="middle">큐에 쌓이는 순간 개입</text>
    </g>
  );
}

function LineHeight() {
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">줄간격</text>
      <rect className="v3-ht-diagram-box" x="16" y="34" width="136" height="104" rx="8" />
      <rect className="v3-ht-diagram-box" x="168" y="34" width="136" height="104" rx="8" />
      <text className="v3-ht-diagram-muted" x="84" y="52" textAnchor="middle">이전</text>
      <text className="v3-ht-diagram-muted" x="236" y="52" textAnchor="middle">이후</text>
      <rect className="v3-ht-diagram-fill--strong" x="30" y="66" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="30" y="76" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="30" y="86" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="30" y="96" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="182" y="66" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="182" y="82" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="182" y="98" width="108" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="182" y="114" width="108" height="4" rx="2" />
      <text className="v3-ht-diagram-muted" x="160" y="158" textAnchor="middle">390px 에서도 같은 간격</text>
    </g>
  );
}

function NarrowWidth() {
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">좁은 폭</text>
      <rect className="v3-ht-diagram-box" x="32" y="34" width="96" height="116" rx="12" />
      <rect className="v3-ht-diagram-fill--strong" x="68" y="44" width="24" height="3" rx="1.5" />
      <rect className="v3-ht-diagram-fill--strong" x="44" y="64" width="72" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="44" y="78" width="72" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="44" y="92" width="72" height="4" rx="2" />
      <rect className="v3-ht-diagram-fill--strong" x="44" y="106" width="72" height="4" rx="2" />
      <text className="v3-ht-diagram-strong" x="176" y="64">390px</text>
      <text className="v3-ht-diagram-muted" x="176" y="86">줄간격 유지</text>
      <circle className="v3-ht-diagram-stroke--complete" cx="184" cy="118" r="12" />
      <path className="v3-ht-diagram-stroke--complete" d="M178 118 l4 4 l8 -9" />
    </g>
  );
}

function MorningAlerts() {
  const weekdays = ["월", "화", "수", "목", "금"] as const;
  const weekends = ["토", "일"] as const;
  return (
    <g>
      <text className="v3-ht-diagram-strong" x="16" y="22">아침 알림</text>
      <rect className="v3-ht-diagram-box--accent" x="112" y="32" width="96" height="28" rx="8" />
      <text className="v3-ht-diagram-accent-text" x="160" y="46" textAnchor="middle" dominantBaseline="central">8시 30분</text>
      <path className="v3-ht-diagram-stroke" d="M160 60 v12 M80 72 h160 M80 72 v12 M240 72 v12" />
      <rect className="v3-ht-diagram-box" x="24" y="84" width="112" height="28" rx="8" />
      <rect className="v3-ht-diagram-box" x="184" y="84" width="112" height="28" rx="8" />
      <text x="80" y="98" textAnchor="middle" dominantBaseline="central">평일</text>
      <text x="240" y="98" textAnchor="middle" dominantBaseline="central">주말</text>
      {weekdays.map((day, index) => (
        <g key={day}>
          <rect className="v3-ht-diagram-box--accent" x={28 + index * 22} y="120" width="18" height="20" rx="6" />
          <text className="v3-ht-diagram-accent-text" x={37 + index * 22} y="130" textAnchor="middle" dominantBaseline="central">{day}</text>
        </g>
      ))}
      {weekends.map((day, index) => (
        <g key={day}>
          <rect className="v3-ht-diagram-dash" x={196 + index * 26} y="120" width="20" height="20" rx="6" />
          <text className="v3-ht-diagram-muted" x={206 + index * 26} y="130" textAnchor="middle" dominantBaseline="central">{day}</text>
        </g>
      ))}
      <text className="v3-ht-diagram-muted" x="160" y="162" textAnchor="middle">놓친 알림 0건</text>
    </g>
  );
}

const DIAGRAMS: Record<EvidenceDiagramKind, () => ReactElement> = {
  "period-chips": PeriodChips,
  "app-updates": AppUpdates,
  "interaction-steps": InteractionSteps,
  "interaction-flow": InteractionFlow,
  "line-height": LineHeight,
  "narrow-width": NarrowWidth,
  "morning-alerts": MorningAlerts,
};

export function EvidenceDiagram({ diagram }: { diagram: EvidenceDiagramKind }) {
  const Diagram = DIAGRAMS[diagram];
  return (
    <svg
      className="v3-ht-diagram"
      viewBox="0 0 320 180"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={LABEL[diagram]}
    >
      <Diagram />
    </svg>
  );
}
