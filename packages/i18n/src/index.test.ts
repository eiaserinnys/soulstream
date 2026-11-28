import { describe, expect, it } from "vitest";
import { createI18n, dictionaries, resolveLanguage } from "./index";

describe("language selection", () => {
  it("prefers account language and otherwise selects the first supported browser language", () => {
    expect(resolveLanguage("en", ["ko-KR"])).toBe("en");
    expect(resolveLanguage(undefined, ["ko-KR"])).toBe("ko");
    expect(resolveLanguage(undefined, ["fr-FR"])).toBe("en");
    expect(resolveLanguage("fr", ["ko-KR"])).toBe("ko");
  });
});

describe("dictionaries", () => {
  it("has English for every Korean key", () => {
    function keys(value: Record<string, unknown>, prefix = ""): string[] {
      return Object.entries(value).flatMap(([key, item]) => typeof item === "string" ? [prefix + key] : keys(item as Record<string, unknown>, prefix + key + "."));
    }
    expect(keys(dictionaries.ko).sort()).toEqual(keys(dictionaries.en).sort());
  });
  it("falls back to Korean when English is missing a key", async () => {
    const instance = await createI18n("en");
    instance.addResource("ko", "translation", "test.koreanFallback", "한국어 문구");
    expect(instance.t("test.koreanFallback")).toBe("한국어 문구");
  });
});
