import {
  CHAT_FONT_SIZE_STEPS,
  Slider,
  useDashboardStore,
  type ChatFontSize,
} from "@seosoyoung/soul-ui";

const STEP_LABELS = ["기본", "+1", "+2", "+3", "+4"] as const;

export function ChatTypographyTab() {
  const chatFontSize = useDashboardStore((state) => state.chatFontSize);
  const setChatFontSize = useDashboardStore((state) => state.setChatFontSize);

  return (
    <section className="space-y-4 rounded-[14px] border border-[var(--lg-line)] bg-muted/20 px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">채팅 글자 크기</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            본문과 입력창의 크기를 계정에 저장합니다.
          </div>
        </div>
        <output className="shrink-0 font-mono text-sm font-semibold text-foreground">
          {chatFontSize}px
        </output>
      </div>

      <Slider
        data-testid="chat-font-size-slider"
        aria-label="채팅 글자 크기"
        value={chatFontSize}
        min={CHAT_FONT_SIZE_STEPS[0]}
        max={CHAT_FONT_SIZE_STEPS[CHAT_FONT_SIZE_STEPS.length - 1]}
        step={1}
        getAriaLabel={() => "채팅 글자 크기"}
        getAriaValueText={(_formatted, value) => `${value}px`}
        onValueChange={(next) => {
          const value = Array.isArray(next) ? next[0] : next;
          setChatFontSize(value as ChatFontSize);
        }}
      />

      <div className="grid grid-cols-5 text-center text-xs text-muted-foreground">
        {STEP_LABELS.map((label, index) => (
          <span key={label} className={index === chatFontSize - 14 ? "font-semibold text-foreground" : undefined}>
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
