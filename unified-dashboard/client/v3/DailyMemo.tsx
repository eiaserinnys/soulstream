import type { BlockDto } from "@seosoyoung/soul-ui/page";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";

import { TaskDescriptionPanel } from "./TaskDescriptionPanel";

export function DailyMemo({
  blocks,
  onSave,
}: {
  blocks: readonly BlockDto[];
  onSave(blockId: string | null, text: string): Promise<void>;
}) {
  const editable = blocks.length > 0 ? blocks : [null];
  return (
    <LiquidGlassCard
      webglSurface
      cornerRadius={18}
      className="v3-daily-memo rounded-[18px] border border-white/8 shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)]"
    >
      <span className="v3-memo-label">오늘 메모</span>
      {editable.map((block, index) => (
        <TaskDescriptionPanel
          key={block?.id ?? "empty-memo"}
          markdown={block?.text ?? ""}
          ariaLabel={index === 0 ? "오늘 메모" : `오늘 메모 ${index + 1}`}
          emptyText={index === 0 ? "오늘 기억해 둘 내용을 적으세요." : "메모를 작성하세요."}
          variant="compact"
          onSave={(text) => onSave(block?.id ?? null, text)}
        />
      ))}
    </LiquidGlassCard>
  );
}
