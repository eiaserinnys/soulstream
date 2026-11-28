import { useTranslation } from "react-i18next";
import {
  CHAT_FONT_SIZE_STEPS,
  Slider,
  useDashboardStore,
  type ChatFontSize,
} from "@seosoyoung/soul-ui";



export function ChatTypographyTab({ preference }: { preference?: { value: ChatFontSize; set(value: ChatFontSize): void } } = {}) {
  const { t } = useTranslation();
  const stepLabels = [t("settings.default"), "+1", "+2", "+3", "+4"];
  const storedChatFontSize = useDashboardStore((state) => state.chatFontSize);
  const storedSetChatFontSize = useDashboardStore((state) => state.setChatFontSize);

  const chatFontSize = preference?.value ?? storedChatFontSize;
  const setChatFontSize = preference?.set ?? storedSetChatFontSize;
  return (
    <section className="space-y-4 rounded-floor border border-[var(--lg-line)] bg-muted/20 px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{t("settings.fontSize")}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t("settings.fontHelp")}
          </div>
        </div>
        <output className="shrink-0 font-mono text-sm font-semibold text-foreground">
          {chatFontSize}px
        </output>
      </div>

      <Slider
        data-testid="chat-font-size-slider"
        aria-label={t("settings.fontSize")}
        value={chatFontSize}
        min={CHAT_FONT_SIZE_STEPS[0]}
        max={CHAT_FONT_SIZE_STEPS[CHAT_FONT_SIZE_STEPS.length - 1]}
        step={1}
        getAriaLabel={() => t("settings.fontSize")}
        getAriaValueText={(_formatted, value) => `${value}px`}
        onValueChange={(next) => {
          const value = Array.isArray(next) ? next[0] : next;
          setChatFontSize(value as ChatFontSize);
        }}
      />

      <div className="grid grid-cols-5 text-center text-xs text-muted-foreground">
        {stepLabels.map((label, index) => (
          <span key={label} className={index === chatFontSize - 14 ? "font-semibold text-foreground" : undefined}>
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
