import { useTranslation } from "react-i18next";
import { Button, Input } from "@seosoyoung/soul-ui";
import { inputControlClassName, inputFieldClassName } from "@seosoyoung/soul-ui/components/ui/input";

import type { RecurringScheduleDraft, RecurringScheduleMode } from "../lib/recurring-schedule";
import { SettingsField } from "./config/SettingsListDetail";

const modes: readonly RecurringScheduleMode[] = ["once", "daily", "weekdays", "weekly", "monthly", "advanced"];
/** 한 줄 select가 soul-ui Input 기본형과 같은 표면 높이와 글자 시작선을 갖게 하는 클래스.
 *  inputFieldClassName에는 높이·줄 간격이 없고(Input이 따로 붙인다) Input이 쓰는 값
 *  (h-8.5 leading-8.5 sm:h-7.5 sm:leading-7.5)을 그대로 쓴다. 네이티브 select는 글자 앞에
 *  브라우저 몫 4px을 더 넣으므로(실측: 같은 값·같은 안쪽 여백에서 글자 시작이 4px 오른쪽)
 *  Input과 같은 안쪽 여백(calc(--spacing(3)-1px))에서 그 4px을 빼 시작선을 맞춘다. */
const oneLineSelectClassName = `${inputFieldClassName} h-8.5 leading-8.5 sm:h-7.5 sm:leading-7.5 ps-[calc(--spacing(3)-1px-4px)]`;
/** 네이티브 select의 비활성 모양을 soul-ui Input과 같게 한다(control-surface의 비활성 글자색과 커서). */
const disabledSelectClassName = "disabled:text-muted-foreground disabled:cursor-default";

export function RecurringScheduleEditor({
  value,
  onChange,
  scheduleKind,
}: {
  value: RecurringScheduleDraft;
  onChange(value: RecurringScheduleDraft): void;
  scheduleKind?: "recurring" | "once";
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const weekdays = Array.from({ length: 7 }, (_, day) => weekdayFormat.format(Date.UTC(2026, 0, 4 + day)));
  const set = (patch: Partial<RecurringScheduleDraft>) => onChange({ ...value, ...patch });
  return <div className="grid gap-3 rounded-floor border border-border p-3" data-testid="recurring-schedule-editor">
    <SettingsField label={t("jobs.schedule.repeat")}><span className={inputControlClassName} data-slot="input-control"><select aria-label={t("jobs.schedule.frequency")} className={`${oneLineSelectClassName} ${disabledSelectClassName}`} disabled={scheduleKind === "once"} value={value.mode} onChange={(event) => set({ mode: event.target.value as RecurringScheduleMode })}>{modes.map((mode) => <option key={mode} value={mode} disabled={mode === "once" && scheduleKind === "recurring"}>{t(`jobs.schedule.${mode}`)}</option>)}</select></span></SettingsField>
    {value.mode === "once" ? <SettingsField label={t("jobs.schedule.runAt")}><Input className="min-w-0 dark:scheme-dark" aria-label={t("jobs.schedule.runAt")} lang={locale} type="datetime-local" value={value.runAtLocal} onChange={(event) => set({ runAtLocal: event.target.value })} /></SettingsField> : value.mode !== "advanced" ? <>
      <div className="grid gap-1"><span className="text-sm text-muted-foreground">{t("jobs.schedule.runTime")}</span><div className="flex flex-wrap items-center gap-2">{value.times.map((time, index) => <div key={`${time}-${index}`} className="flex items-center gap-1"><Input size="sm" className="w-auto dark:scheme-dark" aria-label={t("jobs.schedule.numberedRunTime", { number: index + 1 })} lang={locale} type="time" value={time} onChange={(event) => set({ times: value.times.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} />{value.times.length > 1 ? <Button type="button" size="sm" variant="outline" onClick={() => set({ times: value.times.filter((_, itemIndex) => itemIndex !== index) })}>{t("jobs.common.delete")}</Button> : null}</div>)}<Button type="button" size="sm" variant="outline" onClick={() => set({ times: [...value.times, "12:00"] })}>{t("jobs.schedule.addTime")}</Button></div></div>
      {value.mode === "weekly" ? <div className="grid gap-1"><span className="text-sm text-muted-foreground">{t("jobs.schedule.daysOfWeek")}</span><div className="flex flex-wrap gap-1">{weekdays.map((label, day) => <Button key={label} type="button" size="sm" aria-pressed={value.weekdays.includes(day)} variant={value.weekdays.includes(day) ? "default" : "outline"} onClick={() => set({ weekdays: value.weekdays.includes(day) ? value.weekdays.filter((item) => item !== day) : [...value.weekdays, day] })}>{label}</Button>)}</div></div> : null}
      {value.mode === "monthly" ? <div className="grid gap-1"><span className="text-sm text-muted-foreground">{t("jobs.schedule.daysOfMonth")}</span><div role="group" aria-label={t("jobs.schedule.monthlyDates")} className="grid w-fit grid-cols-7 gap-1">{Array.from({ length: 31 }, (_, index) => index + 1).map(day => <Button key={day} type="button" size="sm" className="tabular-nums" aria-pressed={value.monthDays.includes(day)} variant={value.monthDays.includes(day) ? "default" : "outline"} onClick={() => set({ monthDays: value.monthDays.includes(day) ? value.monthDays.filter(item => item !== day).sort((a, b) => a - b) : [...value.monthDays, day].sort((a, b) => a - b) })}>{day}</Button>)}</div></div> : null}
    </> : <details open><summary className="cursor-pointer text-sm text-muted-foreground">{t("jobs.schedule.editCron")}</summary><span className={`${inputControlClassName} mt-2`} data-slot="input-control"><textarea aria-label={t("jobs.schedule.advanced")} className={`${inputFieldClassName} resize-none py-2`} rows={3} value={value.advancedExpressions} onChange={(event) => set({ advancedExpressions: event.target.value })} placeholder="0 9 * * 1-5" /></span><p className="mt-1 text-xs text-muted-foreground">{t("jobs.schedule.cronHelp")}</p></details>}
  </div>;
}
