import { useTranslation } from "react-i18next";
import { supportedLanguages, type Language } from "@soulstream/i18n";
import { CatalogSelectionField } from "./CatalogSelectionField";

export function LanguageSettings() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage === "ko" ? "ko" : "en";
  return <section className="space-y-4 rounded-floor border border-[var(--lg-line)] bg-muted/20 px-4 py-4">
    <CatalogSelectionField
      label={t("settings.language")}
      ariaLabel={t("settings.language")}
      value={language}
      selectedLabel={supportedLanguages.find(item => item.code === language)?.name}
      options={supportedLanguages.map(item => ({ value: item.code, label: item.name }))}
      onValueChange={value => { void i18n.changeLanguage(value as Language); }}
    />
  </section>;
}
