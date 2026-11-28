import { describe, expect, it } from "vitest";
import { createI18n, dictionaries, resolveLanguage } from "./index";

describe("language selection", () => {
  it.each([
    ["en", ["ko-KR"], "en"],
    [undefined, ["ko-KR"], "ko"],
    [undefined, ["fr-FR"], "en"],
    ["fr", ["ko-KR"], "ko"],
    [undefined, ["ja-JP"], "ja"],
    [undefined, ["zh-CN"], "zh-Hans"],
    [undefined, ["ZH-hANS-CN"], "zh-Hans"],
    [undefined, ["zh-SG"], "zh-Hans"],
    [undefined, ["zh"], "zh-Hans"],
    [undefined, ["zh-TW"], "en"],
    [undefined, ["zh-HK", "zh-MO", "zh-Hant-CN", "en-GB", "ja-JP"], "en"],
    [undefined, ["zh-TW", "ja-JP"], "ja"],
    ["ja", ["en-US"], "ja"],
    ["zh-Hans", ["ja-JP"], "zh-Hans"],
  ] as const)("resolves account %s and browser %j to %s", (account, browser, expected) => {
    expect(resolveLanguage(account, browser)).toBe(expected);
  });
});

function flatten(value: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" ? [[prefix + key, item]] : flatten(item as Record<string, unknown>, prefix + key + "."));
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{[^{}]+}}|\$t\([^)]*\)|<\/?(?:[a-zA-Z][\w-]*|\d+)(?:\s+[^<>]*?)?\/?>/g)]
    .map(([token]) => token)
    .sort();
}

describe("dictionaries", () => {
  const korean = flatten(dictionaries.ko);
  const translatedLanguages = ["en", "ja", "zh-Hans"] as const;

  it.each(translatedLanguages)("has the same keys in Korean and %s", language => {
    expect(flatten(dictionaries[language]).map(([key]) => key).sort()).toEqual(korean.map(([key]) => key).sort());
  });

  it.each(translatedLanguages)("preserves Korean placeholders in %s", language => {
    const translated = new Map(flatten(dictionaries[language]));
    const differences = korean.flatMap(([key, source]) => {
      const value = translated.get(key);
      return value !== undefined && JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(value))
        ? [{ language, key, ko: source, value }]
        : [];
    });
    expect(differences).toEqual([]);
  });

  it.each([["en", "ko"], ["ko", "en"], ["ja", "en"], ["zh-Hans", "en"]] as const)(
    "falls back from %s to %s when a key is missing",
    (language, fallback) => {
      const instance = createI18n(language);
      const key = `test.fallback.${language}`;
      instance.addResource(fallback, "translation", key, "fallback text");
      expect(instance.t(key)).toBe("fallback text");
    },
  );
});
