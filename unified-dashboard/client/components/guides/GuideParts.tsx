// 구성 보기, 「스킬과 카탈로그」 탭, 한눈에 표가 함께 쓰는 작은 표시들.
import { ArrowRight } from "lucide-react";
import { Badge } from "@seosoyoung/soul-ui";

import { worstFinding, type GuideFinding, type LoadedHow, type SkillGuide, type SkillLink } from "../../lib/skill-guides";

const LEVEL_LABEL = { error: "오류", warning: "경고", info: "정보" } as const;
const LEVEL_VARIANT = { error: "error", warning: "warning", info: "outline" } as const;
const HOW_LABEL: Record<LoadedHow, string> = { body: "본문까지", entry: "이름과 설명만", title: "제목만" };

/** 가장 무거운 진단 하나를 배지로 보인다. 진단이 없으면 아무것도 그리지 않는다. */
export function FindingBadge({ findings }: { findings: readonly GuideFinding[] }) {
  const worst = worstFinding(findings);
  if (!worst) return null;
  return <Badge variant={LEVEL_VARIANT[worst.level]} size="sm">{LEVEL_LABEL[worst.level]} {worst.count}</Badge>;
}

/** 스킬의 진단 배지. 보고는 있는데 이 스킬만 빠졌으면 「보고에 없음」을 보인다. */
export function SkillLintBadge({ skill, reportExists }: { skill: SkillGuide; reportExists: boolean }) {
  if (skill.lint) return <FindingBadge findings={skill.lint.findings} />;
  return reportExists ? <Badge variant="outline" size="sm">보고에 없음</Badge> : null;
}

export function FindingCodeBadge({ finding }: { finding: GuideFinding }) {
  return <Badge variant={LEVEL_VARIANT[finding.level]} size="sm">{finding.code}</Badge>;
}

export function howLabel(how: LoadedHow): string {
  return HOW_LABEL[how];
}

/** 나가는 연결을 이름 칩으로 보인다. limit를 넘는 것은 개수로 접는다. */
export function LinkChips({ links, limit = 3 }: { links: readonly SkillLink[]; limit?: number }) {
  if (links.length === 0) return null;
  const shown = links.slice(0, limit);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map(link => (
        <Badge key={`${link.kind}:${link.target}`} variant="outline" size="sm" title={link.kind ? `${link.kind} ${link.target}` : link.target}>
          <ArrowRight aria-hidden="true" />{link.target}
        </Badge>
      ))}
      {links.length > shown.length && <Badge variant="outline" size="sm">+{links.length - shown.length}</Badge>}
    </span>
  );
}

/** 초상이 없는 프로필의 머리글자 자리. 프로필 목록의 자리표시와 같은 모양이다. */
export function ProfileInitial({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      title={name}
      className={`flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ${small ? "size-5" : "size-8"}`}
    >
      <span aria-hidden="true">{name.charAt(0)}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
