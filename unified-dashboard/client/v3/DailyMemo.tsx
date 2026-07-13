import type { BlockDto } from "@seosoyoung/soul-ui/page";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";

export function DailyMemo({
  blocks,
  onSave,
}: {
  blocks: readonly BlockDto[];
  onSave(blockId: string | null, text: string): void;
}) {
  const editable = blocks.length > 0 ? blocks : [null];
  return (
    <LiquidGlassCard cornerRadius={12} className="v3-daily-memo">
      <span className="v3-memo-label">오늘 메모</span>
      {editable.map((block, index) => (
        <textarea
          key={block?.id ?? "empty-memo"}
          defaultValue={block?.text ?? ""}
          rows={block?.text ? Math.max(2, block.text.split("\n").length) : 3}
          aria-label={index === 0 ? "오늘 메모" : `오늘 메모 ${index + 1}`}
          placeholder={index === 0 ? "오늘 기억해 둘 내용을 적으세요." : undefined}
          onBlur={(event) => onSave(block?.id ?? null, event.currentTarget.value)}
        />
      ))}
    </LiquidGlassCard>
  );
}
