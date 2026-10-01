import type { PlannerFolderStatus } from '../api/plannerTypes';
import type { DesignTokens } from './tokens';

export interface PlannerVisualRoles {
  pageInset: number;
  projectIndent: number;
  contentIconFrame: number;
  disclosureVisual: number;
  actionColumn: number;
  statusColumn: number;
  minHeight: {
    context: number;
    row: number;
    folder: number;
    memo: number;
  };
  typography: DesignTokens['foundation']['typography'];
  grouped: {
    dividerColor: string;
    pressedColor: string;
  };
  sectionRhythm: {
    before: number;
    after: number;
  };
  sidebar: {
    contentInset: number;
    sectionGap: number;
    firstItemPullUp: number;
  };
  statusTone: Record<PlannerFolderStatus, string>;
}

/**
 * Daily·Project·Task·Board·Document 표면이 공유하는 iOS v0.1 시각 정본.
 * 기기별 값은 foundation에서 받고, 플래너 고유 계층만 여기서 이름을 붙인다.
 */
export function createPlannerVisualRoles(t: DesignTokens): PlannerVisualRoles {
  return {
    pageInset: t.foundation.pageInset,
    projectIndent: 24,
    // 콘텐츠 이모지·상태 glyph는 버튼용 32/40pt 프레임과 별개인 24pt 시각 프레임이다.
    contentIconFrame: 24,
    disclosureVisual: 16,
    actionColumn: t.foundation.hitTarget,
    statusColumn: t.foundation.minHeight.row,
    minHeight: {
      context: t.foundation.minHeight.context,
      row: t.foundation.minHeight.row,
      folder: t.foundation.minHeight.folder,
      memo: t.foundation.minHeight.memo,
    },
    typography: t.foundation.typography,
    grouped: {
      dividerColor: t.mode === 'dark'
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.08)',
      pressedColor: t.mode === 'dark'
        ? 'rgba(255, 255, 255, 0.06)'
        : 'rgba(0, 0, 0, 0.06)',
    },
    sectionRhythm: {
      before: t.spacing.md,
      after: t.spacing.sm,
    },
    sidebar: {
      contentInset: t.foundation.pageInset,
      sectionGap: t.uiSpacing.lg,
      firstItemPullUp: t.uiSpacing.sm,
    },
    statusTone: {
      open: t.colors.textTertiary,
      in_progress: t.colors.accent,
      review: t.colors.warning,
      completed: t.colors.success,
    },
  };
}
