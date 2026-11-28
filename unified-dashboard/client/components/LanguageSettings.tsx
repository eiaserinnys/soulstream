import { useTranslation } from "react-i18next";
import { resolveLanguage, supportedLanguages, isLanguage } from "@soulstream/i18n";
import { CatalogSelectionField } from "./CatalogSelectionField";

export function LanguageSettings() {
  const { t, i18n } = useTranslation();
  const language = resolveLanguage(i18n.resolvedLanguage, []);
  return <section className="space-y-4 rounded-floor border border-[var(--lg-line)] bg-muted/20 px-4 py-4">
    <CatalogSelectionField
      label={t("settings.language")}
      ariaLabel={t("settings.language")}
      labelClassName="block text-sm font-semibold text-foreground"
      description={<div className="mt-0.5 text-xs text-muted-foreground">{t("settings.languageHelp")}</div>}
      value={language}
      selectedLabel={supportedLanguages.find(item => item.code === language)?.name}
      options={supportedLanguages.map(item => ({ value: item.code, label: item.name }))}
      onValueChange={value => { if (isLanguage(value)) void i18n.changeLanguage(value); }}
    />
  </section>;
}
