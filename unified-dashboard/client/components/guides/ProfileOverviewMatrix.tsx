// 한눈에: 줄은 소스(지침 묶음과 스킬 목록), 칸은 프로필, 값은 항상 · 조건부 · 없음. 쓰이는 곳 표를 돌린 것이다.
import { useMemo, type CSSProperties } from "react";
import { Circle, TriangleAlert } from "lucide-react";
import { Button, FrameNotice } from "@seosoyoung/soul-ui";

import { buildMatrix, profileLabel, useContextOverview, useSkillGuides, type MatrixCell, type OverviewProfile } from "../../lib/skill-guides";
import "../../v3/v3-run-history.css";
import "./guides.css";

const SKELETON_ROWS = 6;

function MatrixSkeleton() {
  return (
    <div className="guides-matrix-frame" data-testid="agent-context-overview" role="status" aria-label="프로필을 모으는 중">
      <div className="space-y-3 p-3">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <span key={index} className="flex items-center gap-3"><span className="v3-run-skeleton v3-run-skeleton--title" /><span className="v3-run-skeleton v3-run-skeleton--badge" /></span>
        ))}
      </div>
    </div>
  );
}

const cellLabel = (cell: MatrixCell | undefined): string => !cell ? "없음" : cell.state === "always" ? "항상" : `조건부: ${cell.condition}`;

export function ProfileOverviewMatrix({ nodeId, request = fetch }: { nodeId: string; request?: typeof fetch }) {
  const overview = useContextOverview(nodeId, request);
  const guides = useSkillGuides(request);
  const matrix = useMemo(
    () => overview.state.status === "ready" && guides.state.status === "ready" ? buildMatrix(overview.state.data, guides.state.data.skills) : null,
    [overview.state, guides.state],
  );

  if (overview.state.status === "error" || guides.state.status === "error") {
    return (
      <FrameNotice>
        <div className="flex flex-col items-center gap-3">
          <p role="alert" className="text-sm text-destructive-foreground">프로필을 모으지 못했습니다.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => { if (overview.state.status === "error") overview.reload(); if (guides.state.status === "error") guides.reload(); }}>다시 시도</Button>
        </div>
      </FrameNotice>
    );
  }
  if (!matrix) return <MatrixSkeleton />;
  if (matrix.profiles.length === 0) return <FrameNotice>이 노드에는 프로필이 없습니다.</FrameNotice>;

  const { profiles, rows, ownGuides, ownSkills } = matrix;
  const firstNode = profiles.find(profile => profile.source === "yaml")?.agent_id ?? null;
  const columnProps = (profile: OverviewProfile) => ({
    "data-first-node": profile.agent_id === firstNode ? "true" : undefined,
    "data-error": profile.status === "error" ? "true" : undefined,
  });
  const cells = (values: Record<string, MatrixCell>, label: string) => profiles.map(profile => {
    const cell = values[profile.agent_id];
    return (
      <td key={profile.agent_id} {...columnProps(profile)} title={cell ? `${profileLabel(profile)} · ${label} · ${cellLabel(cell)}` : undefined}>
        {cell && <Circle className={`size-3 ${cell.state === "always" ? "fill-current" : ""}`} aria-label={cellLabel(cell)} />}
      </td>
    );
  });
  return (
    <div className="guides-matrix-frame" data-testid="agent-context-overview">
      <table className="guides-matrix" style={{ "--guides-columns": profiles.length } as CSSProperties}>
        <thead>
          <tr>
            <th scope="col" className="guides-matrix-corner">
              <span className="guides-matrix-legend">
                <span><Circle className="size-3 fill-current text-foreground" aria-hidden="true" />항상</span>
                <span><Circle className="size-3 text-foreground" aria-hidden="true" />조건부</span>
              </span>
            </th>
            {profiles.map(profile => (
              <th key={profile.agent_id} scope="col" className="guides-matrix-profile" {...columnProps(profile)} title={profile.status === "error" ? `${profileLabel(profile)} · ${profile.error ?? "읽지 못했습니다"}` : profileLabel(profile)}>
                {profile.status === "error" && <TriangleAlert className="guides-matrix-error size-3" aria-label="읽지 못함" />}
                <span>{profileLabel(profile)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const label = row.parent ? `${row.parent} / ${row.title}` : row.title ?? row.node_id.slice(0, 8);
            // 조건부 칸이 있으면 무엇이 조건인지 줄 이름 아래에 적는다.
            const conditions = Array.from(new Set(Object.values(row.cells).flatMap(cell => cell.state === "conditional" ? [cell.condition] : [])));
            return (
              <tr key={row.node_id}>
                <th scope="row" title={label} data-v3-selectable-content="true">
                  <span>{row.parent && <span className="text-muted-foreground">{row.parent} / </span>}{row.title ?? row.node_id.slice(0, 8)}</span>
                  {conditions.length > 0 && <span className="guides-matrix-condition">{conditions.join(" · ")}</span>}
                </th>
                {cells(row.cells, label)}
              </tr>
            );
          })}
          <tr data-group-start={rows.length > 0 ? "true" : undefined}>
            <th scope="row"><span>프로필마다 따로 둔 지침</span></th>
            {cells(ownGuides, "프로필마다 따로 둔 지침")}
          </tr>
          <tr>
            <th scope="row"><span>스킬 목록</span></th>
            {cells(ownSkills, "스킬 목록")}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
