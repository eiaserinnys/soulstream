// 컴포넌트 검수 창(/components)의 지침과 스킬 보기 표본. 운영과 같은 부품을 같은 props로 올린다.
import { ExternalLink } from "lucide-react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";

import { FindingBadge, LinkChips, ProfileInitial, SkillLintBadge, howLabel } from "../components/guides/GuideParts";
import { ProfileOverviewMatrix } from "../components/guides/ProfileOverviewMatrix";
import { SettingsDetailHeader, SettingsListDetailFrame, SettingsListHeader, SettingsListRow, SettingsListSection } from "../components/config/SettingsListDetail";
import { buildOverview, guideReport, guideSkills, LONGEST_DESCRIPTION, LONGEST_SKILL_NAME } from "./guides-fixture";
import type { GuideFinding } from "../lib/skill-guides";

const finding = (level: GuideFinding["level"]): GuideFinding => ({ code: "W103", level, message: "견본" });

/** GuideParts: 진단 배지(오류, 경고, 정보), 보고에 없음 배지, 연결 칩(말줄임과 +N), 초상 없는 프로필 자리, 실린 방식 글. */
export function GuideBadgesReviewSample() {
  const skill = guideSkills[1]!;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FindingBadge findings={[finding("error"), finding("warning")]} />
        <FindingBadge findings={[finding("warning"), finding("warning")]} />
        <FindingBadge findings={[finding("info")]} />
        <SkillLintBadge skill={{ ...skill, lint: null }} reportExists />
        <SkillLintBadge skill={skill} reportExists />
        <ProfileInitial name="한울" />
        <ProfileInitial name="보람" small />
        {(["body", "entry", "title"] as const).map(how => <span key={how} className="text-xs text-muted-foreground">{howLabel(how)}</span>)}
      </div>
      <LinkChips links={[
        { kind: "call", target: guideSkills[2]!.name, target_kind: "skill" },
        { kind: "include", target: LONGEST_SKILL_NAME, target_kind: "skill" },
        { kind: null, target: guideSkills[4]!.name, target_kind: "skill" },
        { kind: "uses", target: "lantern-axis-catalog", target_kind: "catalog" },
        { kind: "pick", target: guideSkills[6]!.name, target_kind: "skill" },
      ]} />
    </div>
  );
}

const overviewRequest = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === "/api/skill-guides") return Response.json({ skills: guideSkills, catalogs: [], report: guideReport });
  return Response.json(buildOverview("review-node"));
}) as typeof fetch;

/** 한눈에 표: 운영과 같은 ProfileOverviewMatrix. 프로필 18칸, 조건부 줄, 오류 열, 긴 이름의 눕힌 열 머리. */
export function GuideMatrixReviewSample() {
  return (
    <div className="flex h-[var(--container-sm)] min-h-0 flex-col" data-review-sample="guide-matrix">
      <ProfileOverviewMatrix nodeId="review-node" request={overviewRequest} />
    </div>
  );
}

/** SettingsListDetail 변형: fill(두 칸이 남는 높이를 채우고 따로 스크롤), titleBadge, inlineActions. */
export function SettingsListDetailVariantsReviewSample() {
  const skills = [guideSkills[0]!, guideSkills[6]!, guideSkills[11]!, guideSkills[22]!];
  return (
    <div className="flex h-[var(--container-sm)] min-h-0 flex-col" data-review-sample="list-detail-fill">
      <SettingsListDetailFrame
        testId="review-list-detail-fill"
        fill
        list={(
          <>
            <SettingsListHeader title="스킬" description="" actions={null} />
            <SettingsListSection isEmpty={false}>
              {skills.map((skill, index) => (
                <SettingsListRow key={skill.name} title={skill.name} meta={index === 1 ? LONGEST_DESCRIPTION : skill.description} selected={index === 1} onSelect={() => undefined}
                  titleBadge={<SkillLintBadge skill={skill} reportExists />} footer={<span className="text-xs text-muted-foreground">프로필 {index + 1}</span>} />
              ))}
            </SettingsListSection>
          </>
        )}
      >
        <SettingsDetailHeader title={LONGEST_SKILL_NAME} selectableTitle inlineActions subtitle={LONGEST_DESCRIPTION}
          actions={<DashboardIconCap size="small" label="atom에서 열기" onClick={() => undefined}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap>} />
      </SettingsListDetailFrame>
    </div>
  );
}
